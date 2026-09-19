/**
 * The platform user directory contract.
 *
 * `ops.users.list`/`export`/`user.detail` used to read every member of every
 * workspace and then filter, sort and slice in JavaScript. They now read a
 * bounded window from `MembersRepository.searchWindow`, so what has to stay
 * true is what these assertions pin: `total`/`identityCount`/`workspaceCount`
 * count the whole filtered directory (never the page), the pages are still the
 * pages the whole directory would produce, a `workspace_id` request still
 * converges on that workspace alone, and `scan_truncated` still says whether the
 * answer is a partial view of the platform.
 *
 * The in-memory directory is shared by the whole file (the server module owns
 * it), so every fixture carries its own run id in the subject it searches for
 * and asserts on that run's rows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { server, setPasswordAuthRepositoryForTests, workspaceMembers } from './server.js'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'

type Envelope<T = Record<string, any>> = { workspace_id: string; data: T | null; error: { code: string; message: string } | null }

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

const runId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

/** Three workspaces x two members, plus a platform account and a merchant account that names `workspaces[0]`. */
async function seedDirectory() {
  const id = runId()
  const workspaces = [`ws_dir_${id}_a`, `ws_dir_${id}_b`, `ws_dir_${id}_c`]
  const auth = new MemoryPasswordAuthRepository()
  await auth.ensurePlatformAccount({ login: `directory-platform-${id}@example.com`, passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2VlZA$c2VlZA', roles: ['platform_admin', 'platform_ops'] })
  await auth.createMerchantAccount({
    login: `directory-merchant-${id}@example.com`,
    password: 'MerchantPassword123',
    enterpriseName: '星河科技',
    contactName: '星河商家',
    workspaceIds: [workspaces[0]!],
    actorId: 'directory-test',
    reason: '平台用户目录验收夹具',
  })
  setPasswordAuthRepositoryForTests(auth)
  for (const [index, workspaceId] of workspaces.entries()) {
    for (const [memberIndex, role] of (['workspace_owner', 'operator'] as const).entries()) {
      await workspaceMembers.upsert({
        workspaceId,
        externalSubject: `directory-user-${id}-${index}-${memberIndex}`,
        displayName: `目录用户 ${id} ${index}-${memberIndex}`,
        role,
        status: memberIndex === 0 ? 'active' : 'invited',
        invitedBy: 'directory-test',
      })
      await new Promise(resolve => setTimeout(resolve, 3))
    }
  }
  return { id, workspaces }
}

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setPasswordAuthRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('ops.users.list platform directory', () => {
  it('reports totals over the whole filtered directory while paging a bounded window', async () => {
    const { id, workspaces } = await seedDirectory()
    const base = await start()
    const call = (params: Record<string, string>, workspaceId = workspaces[0]!) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer directory-test', 'x-role': 'platform_admin', 'x-ops-workbench': 'platform', 'x-workspace-id': workspaceId, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ops.users.list', params }),
    }).then(async response => await response.json() as Envelope<{ result: any }>)
    // Every workspace in the fixture is part of the platform directory as soon as a request names it.
    for (const workspaceId of workspaces) await call({ limit: '1', query: id }, workspaceId)

    const page = await call({ limit: '2', query: id })
    const result = page.data?.result
    expect(page.error).toBeNull()
    expect(result.items).toHaveLength(2)
    expect(result.limit).toBe(2)
    expect(result.offset).toBe(0)
    expect(result.truncated).toBe(true)
    // Six members across three workspaces plus the platform account, counted
    // even though the page holds two rows.
    expect(result.total).toBe(7)
    expect(result.workspaceCount).toBe(3)
    expect(result.identityCount).toBe(7)
    expect(result.scanned_workspace_count).toBeGreaterThanOrEqual(3)
    expect(result.scan_truncated).toBe(false)

    const next = await call({ limit: '2', offset: '2', query: id })
    expect(next.data?.result.items.map((item: any) => item.externalSubject)).not.toEqual(result.items.map((item: any) => item.externalSubject))
    expect(next.data?.result.total).toBe(7)
    expect(new Set([...result.items, ...next.data!.result.items].map((item: any) => item.externalSubject)).size).toBe(4)

    const beyond = await call({ limit: '2', offset: '99', query: id })
    expect(beyond.data?.result).toMatchObject({ items: [], truncated: false, total: 7 })
  })

  it('filters on status, subject, display name, role, workspace and the enterprise name it renders', async () => {
    const { id, workspaces } = await seedDirectory()
    const base = await start()
    const call = (params: Record<string, string>, workspaceId = workspaces[0]!) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer directory-test', 'x-role': 'platform_admin', 'x-ops-workbench': 'platform', 'x-workspace-id': workspaceId, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ops.users.list', params }),
    }).then(async response => await response.json() as Envelope<{ result: any }>)
    for (const workspaceId of workspaces) await call({ limit: '1', query: id }, workspaceId)

    expect((await call({ query: id, status: 'invited' })).data?.result).toMatchObject({ total: 3 })
    // Three active owners plus the platform account, which is active too.
    expect((await call({ query: id, status: 'active' })).data?.result).toMatchObject({ total: 4 })
    expect((await call({ query: `DIRECTORY-USER-${id.toUpperCase()}-1-1` })).data?.result).toMatchObject({ total: 1 })
    expect((await call({ query: `目录用户 ${id} 2-0` })).data?.result).toMatchObject({ total: 1 })
    // `workspace_id` is what scopes the directory; the header alone does not.
    expect((await call({ query: 'workspace_owner' }, workspaces[2]!)).data?.result.total).toBeGreaterThanOrEqual(3)
    const scopedOwner = await call({ workspace_id: workspaces[2]!, query: 'workspace_owner' })
    expect(scopedOwner.data?.result).toMatchObject({ total: 1, workspaceCount: 1 })
    expect(scopedOwner.data?.result.items[0]).toMatchObject({ role: 'workspace_owner', workspaceId: workspaces[2] })
    expect((await call({ query: workspaces[2]! })).data?.result).toMatchObject({ total: 2, workspaceCount: 1 })
    expect((await call({ query: `${workspaces[2]!}_suffix` })).data?.result).toMatchObject({ total: 0, items: [] })
    // The enterprise name is the merchant account's projection: this workspace is
    // matched through the name the console renders for it.
    expect((await call({ workspace_id: workspaces[0]!, query: '星河科技' })).data?.result).toMatchObject({ total: 2, workspaceCount: 1 })
    expect((await call({ workspace_id: workspaces[0]!, query: '星河' })).data?.result).toMatchObject({ total: 2 })
    expect((await call({ query: 'no-such-member' })).data?.result).toMatchObject({ total: 0, items: [], truncated: false })
    expect((await call({ status: 'deleted' })).error?.code).toBe('INVALID_REQUEST')
    expect((await call({ limit: '101' })).error?.code).toBe('INVALID_REQUEST')
  })

  it('converges on one workspace and leaves platform accounts out of a scoped request', async () => {
    const { workspace: _workspace, workspaces } = { workspace: undefined, workspaces: (await seedDirectory()).workspaces }
    const base = await start()
    const call = (params: Record<string, string>, workspaceId = workspaces[0]!) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer directory-test', 'x-role': 'platform_admin', 'x-ops-workbench': 'platform', 'x-workspace-id': workspaceId, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ops.users.list', params }),
    }).then(async response => await response.json() as Envelope<{ result: any }>)
    for (const workspaceId of workspaces) await call({ limit: '1' }, workspaceId)

    const scoped = await call({ workspace_id: workspaces[1]!, limit: '20' })
    expect(scoped.data?.result).toMatchObject({ total: 2, workspaceCount: 1, identityCount: 2, scanned_workspace_count: 1, scan_truncated: false })
    expect(scoped.data?.result.items.map((item: any) => item.workspaceId)).toEqual([workspaces[1], workspaces[1]])
    expect(scoped.data?.result.items.some((item: any) => item.accountType === 'platform')).toBe(false)
    expect((await call({ workspace_id: 'ws_dir_missing', limit: '20' })).data?.result).toMatchObject({ total: 0, items: [], scan_truncated: false })
  })

  it('exports the same directory and resolves a subject detail across its workspaces', async () => {
    const { id, workspaces } = await seedDirectory()
    const base = await start()
    const call = (method: string, params: Record<string, string>, workspaceId = workspaces[0]!) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer directory-test', 'x-role': 'platform_admin', 'x-ops-workbench': 'platform', 'x-workspace-id': workspaceId, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).then(async response => await response.json() as Envelope<{ result: any }>)
    for (const workspaceId of workspaces) await call('ops.users.list', { limit: '1', query: id }, workspaceId)

    const exported = await call('ops.users.export', { format: 'json', query: id })
    const rows = JSON.parse(exported.data?.result.content as string) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(6)
    expect(exported.data?.result).toMatchObject({ count: 6, truncated: false })
    expect(rows.map(row => row.external_subject)).toEqual(expect.arrayContaining([`directory-user-${id}-0-0`, `directory-user-${id}-2-1`]))
    expect(rows.find(row => row.external_subject === `directory-user-${id}-0-0`)).toMatchObject({ enterprise_name: '星河科技', workspace_id: workspaces[0], status: 'active' })
    const limited = await call('ops.users.export', { format: 'json', query: id, limit: '2' })
    expect(limited.data?.result).toMatchObject({ count: 2, truncated: true })
    const csv = await call('ops.users.export', { format: 'csv', query: `directory-user-${id}-1-1` })
    expect(csv.data?.result).toMatchObject({ count: 1, truncated: false })
    expect(csv.data?.result.content).toContain(`directory-user-${id}-1-1`)

    const subject = `directory-user-${id}-1-0`
    const detail = await call('ops.user.detail', { external_subject: subject })
    expect(detail.data?.result).toMatchObject({
      identity: { externalSubject: subject, membershipCount: 1, activeMembershipCount: 1 },
      memberships: [expect.objectContaining({ workspaceId: workspaces[1], status: 'active' })],
    })
    expect((await call('ops.user.detail', { external_subject: 'no-such-member' })).error?.code).toBe('USER_IDENTITY_NOT_FOUND')
  })
})
