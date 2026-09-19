import { describe, expect, it, vi } from 'vitest'
import { compareMembersByRecency, DEFAULT_MEMBER_ENTERPRISE_NAME, MemoryMembersRepository, PostgresMembersRepository, type MemberStatus, type WorkspaceMember } from './members-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

describe('PostgresMembersRepository', () => {
  it('upserts a member and its audit atomically with an optimistic revision', async () => {
    const now = '2026-08-28T00:00:00.000Z'
    const current = { id: 'member_1', workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'operator', status: 'active', invitedBy: 'admin', revision: 2, createdAt: now, updatedAt: now }
    const calls: string[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql.split(' ')[0]!)
      if (sql.startsWith('SELECT id')) return { rows: [current] }
      if (sql.startsWith('INSERT INTO workspace_members')) return { rows: [{ ...current, role: 'support', revision: 3 }] }
      if (sql.startsWith('INSERT INTO workspace_operation_audit')) {
        expect(params?.[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
        return { rows: [{ id: params?.[0], workspaceId: 'ws_1', actorId: 'admin', action: 'member.upsert', resourceType: 'workspace_member', resourceId: 'user_1', before: current, after: { ...current, role: 'support', revision: 3 }, reason: '角色调整', createdAt: now }] }
      }
      return { rows: [] }
    })
    const client: SqlClient = { query: query as unknown as SqlClient['query'], release: vi.fn() }
    const result = await new PostgresMembersRepository({ connect: async () => client }).upsertWithAudit({ workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'support', status: 'active', expectedRevision: 2, actorId: 'admin', action: 'member.upsert', reason: '角色调整' })

    expect(result.member).toMatchObject({ role: 'support', status: 'active', revision: 3 })
    expect(result.audit).toMatchObject({ before: { role: 'operator' }, after: { role: 'support' } })
    expect(calls).toEqual(['BEGIN', 'SELECT', 'SELECT', 'INSERT', 'INSERT', 'COMMIT'])
  })

  it('changes member status and writes the audit in one transaction', async () => {
    const now = '2026-08-28T00:00:00.000Z'
    const current = { id: 'member_1', workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'operator', status: 'active', invitedBy: 'admin', revision: 2, createdAt: now, updatedAt: now }
    const calls: string[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql.split(' ')[0]!)
      if (sql.startsWith('SELECT id')) return { rows: [current] }
      if (sql.startsWith('UPDATE workspace_members')) return { rows: [{ ...current, status: 'suspended', revision: 3 }] }
      if (sql.startsWith('INSERT INTO workspace_operation_audit')) {
        expect(params?.[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
        return { rows: [{ id: params?.[0], workspaceId: 'ws_1', actorId: 'admin', action: 'user.suspend', resourceType: 'workspace_member', resourceId: 'user_1', before: current, after: { ...current, status: 'suspended', revision: 3 }, reason: '风险工单', createdAt: now }] }
      }
      return { rows: [] }
    })
    const client: SqlClient = { query: query as unknown as SqlClient['query'], release: vi.fn() }
    const result = await new PostgresMembersRepository({ connect: async () => client }).changeStatusWithAudit({ workspaceId: 'ws_1', externalSubject: 'user_1', targetStatus: 'suspended', expectedRevision: 2, actorId: 'admin', action: 'user.suspend', reason: '风险工单' })

    expect(result.member).toMatchObject({ status: 'suspended', revision: 3 })
    expect(result.audit).toMatchObject({ action: 'user.suspend', reason: '风险工单' })
    expect(calls).toEqual(['BEGIN', 'SELECT', 'SELECT', 'UPDATE', 'INSERT', 'COMMIT'])
  })

  it('rolls back the member update when the audit insert fails', async () => {
    const now = '2026-08-28T00:00:00.000Z'
    const current = { id: 'member_1', workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'operator', status: 'active', invitedBy: 'admin', revision: 2, createdAt: now, updatedAt: now }
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT id')) return { rows: [current] }
      if (sql.startsWith('UPDATE workspace_members')) return { rows: [{ ...current, status: 'suspended', revision: 3 }] }
      if (sql.startsWith('INSERT INTO workspace_operation_audit')) throw new Error('audit unavailable')
      return { rows: [] }
    })
    const client: SqlClient = { query: query as unknown as SqlClient['query'], release: vi.fn() }
    const repository = new PostgresMembersRepository({ connect: async () => client })

    await expect(repository.changeStatusWithAudit({ workspaceId: 'ws_1', externalSubject: 'user_1', targetStatus: 'suspended', expectedRevision: 2, actorId: 'admin', action: 'user.suspend', reason: '风险工单' })).rejects.toThrow('audit unavailable')
    expect(query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('normalizes pg timestamp Date values to the string contract', async () => {
    const createdAt = new Date('2026-08-01T00:00:00.000Z')
    const updatedAt = new Date('2026-08-02T00:00:00.000Z')
    const query = vi.fn(async (sql: string) => sql.includes('FROM workspace_members')
      ? { rows: [{ id: 'member_1', workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'operator', status: 'active', invitedBy: 'admin', revision: 1, createdAt, updatedAt }] }
      : { rows: [] })
    const client: SqlClient = { query: query as unknown as SqlClient['query'], release: vi.fn() }
    const pool: SqlPool = { connect: async () => client }

    const rows = await new PostgresMembersRepository(pool).list('ws_1')

    expect(rows[0]).toMatchObject({ createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() })
    expect(query).toHaveBeenCalledWith("SELECT set_config('app.workspace_id', $1, true)", ['ws_1'])
  })

  it('scopes each listMany workspace in its own transaction', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      if (sql.includes('FROM workspace_members')) return { rows: [{ id: 'member_1', workspaceId: params?.[0], externalSubject: 'user_1', displayName: '用户一', role: 'operator', status: 'active', invitedBy: 'admin', revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }] }
      return { rows: [] }
    })
    const client: SqlClient = { query: query as unknown as SqlClient['query'], release: vi.fn() }
    const rows = await new PostgresMembersRepository({ connect: async () => client }).listMany(['ws_a', 'ws_a', 'ws_b'])

    expect(rows.map(row => row.workspaceId)).toEqual(['ws_a', 'ws_b'])
    expect(calls.filter(call => call.sql === 'BEGIN')).toHaveLength(2)
    const scopes = calls.filter(call => call.sql.includes("set_config('app.workspace_id'"))
    expect(scopes.map(call => call.params)).toEqual([['ws_a'], ['ws_b']])
    expect(calls.filter(call => call.sql === 'COMMIT')).toHaveLength(2)
  })
})

describe('MemoryMembersRepository', () => {
  it('preserves status during an audited role-only update', async () => {
    const repository = new MemoryMembersRepository()
    const current = await repository.upsert({ workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'operator', status: 'active', invitedBy: 'admin' })
    const changed = await repository.upsertWithAudit({ workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'support', status: current.status, expectedRevision: current.revision, actorId: 'admin', action: 'member.upsert', reason: '角色调整' })
    expect(changed).toMatchObject({ member: { role: 'support', status: 'active', revision: current.revision + 1 }, audit: { before: { role: 'operator' }, after: { role: 'support' } } })
  })

  it('uses optimistic revision checks for audited status changes', async () => {
    const repository = new MemoryMembersRepository()
    const current = await repository.upsert({ workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'operator', status: 'active', invitedBy: 'admin' })
    const changed = await repository.changeStatusWithAudit({ workspaceId: 'ws_1', externalSubject: 'user_1', targetStatus: 'suspended', expectedRevision: current.revision, actorId: 'admin', action: 'user.suspend', reason: '风险工单' })
    expect(changed).toMatchObject({ member: { status: 'suspended', revision: current.revision + 1 }, audit: { action: 'user.suspend', before: { status: 'active' }, after: { status: 'suspended' } } })
    await expect(repository.changeStatusWithAudit({ workspaceId: 'ws_1', externalSubject: 'user_1', targetStatus: 'active', expectedRevision: current.revision, actorId: 'admin', action: 'user.activate', reason: '过期版本' })).rejects.toThrow('MEMBER_REVISION_CONFLICT')
  })
})

/**
 * The platform user directory window.
 *
 * `searchWindow` replaced a read that loaded every member of every workspace
 * and then filtered, sorted and sliced in JavaScript, so the two properties
 * that made that read safe to move are pinned here: the window is bounded (the
 * caller derives its page from it, not from the whole directory) and the
 * reported totals count every matched row.
 */
describe('MembersRepository.searchWindow', () => {
  const names = new Map([['ws_a', '星河科技'], ['ws_b', 'Acme Retail']])
  const scope = ['ws_a', 'ws_b']
  const pause = () => new Promise(resolve => setTimeout(resolve, 3))

  /** Newest first, like the directory, with distinct timestamps so the order is the data's. */
  async function seeded() {
    const repository = new MemoryMembersRepository()
    for (const [workspaceId, externalSubject, status, role] of [
      ['ws_a', 'owner', 'active', 'workspace_owner'],
      ['ws_a', 'bulk-1', 'active', 'operator'],
      ['ws_b', 'bulk-2', 'invited', 'operator'],
      ['ws_b', 'bulk-3', 'suspended', 'operator'],
      ['ws_b', 'older', 'active', 'operator'],
    ] as const) {
      await repository.upsert({ workspaceId, externalSubject, displayName: externalSubject, role, status, invitedBy: 'seed' })
      await pause()
    }
    return repository
  }

  /** The pre-change pipeline: read the directory, then filter/sort/slice in JavaScript. */
  const wholeDirectoryPage = (rows: readonly WorkspaceMember[], input: { offset: number; limit: number; status?: MemberStatus; query?: string; workspaceIds: string[] }) => rows
    .filter(row => input.workspaceIds.includes(row.workspaceId))
    .map(row => ({ ...row, enterpriseName: names.get(row.workspaceId) ?? '未命名企业主体' }))
    .filter(row => (!input.status || row.status === input.status) && (!input.query || [row.externalSubject, row.displayName, row.enterpriseName, row.workspaceId, row.role].some(value => value.toLocaleLowerCase().includes(input.query!))))
    .sort(compareMembersByRecency)
    .slice(input.offset, input.offset + input.limit)

  it('returns the page the whole directory would, for filters, windows and one workspace', async () => {
    const repository = await seeded()
    const rows = await repository.listMany!(scope)
    for (const input of [
      { offset: 0, limit: 2, workspaceIds: scope },
      { offset: 2, limit: 2, workspaceIds: scope },
      { offset: 0, limit: 100, workspaceIds: scope },
      { offset: 4, limit: 5, workspaceIds: scope },
      { offset: 0, limit: 3, workspaceIds: scope, status: 'active' as MemberStatus },
      { offset: 0, limit: 3, workspaceIds: scope, query: 'acme' },
      { offset: 0, limit: 3, workspaceIds: scope, query: 'bulk' },
      { offset: 0, limit: 3, workspaceIds: scope, query: '星河' },
      { offset: 1, limit: 2, workspaceIds: ['ws_a'] },
      { offset: 0, limit: 5, workspaceIds: [] },
    ]) {
      const found = await repository.searchWindow({ enterpriseNames: names, ...input })
      const start = input.offset - found.itemsFrom
      const page = found.items
        .sort(compareMembersByRecency)
        .slice(start, start + input.limit)
        .map(row => ({ ...row, enterpriseName: names.get(row.workspaceId) ?? DEFAULT_MEMBER_ENTERPRISE_NAME }))
      expect(page).toEqual(wholeDirectoryPage(rows, input))
    }
  })

  it('counts every matched member, never the page', async () => {
    const repository = await seeded()
    const found = await repository.searchWindow({ workspaceIds: scope, offset: 0, limit: 1, enterpriseNames: names })
    expect(found).toMatchObject({ total: 5, workspaceCount: 2, identityCount: 5 })
    expect(found.items.length).toBeLessThan(found.total)
    const filtered = await repository.searchWindow({ workspaceIds: scope, status: 'active', offset: 0, limit: 1, enterpriseNames: names })
    expect(filtered).toMatchObject({ total: 3, workspaceCount: 2, identityCount: 3 })
    expect(await repository.searchWindow({ workspaceIds: scope, query: 'no-such-subject', offset: 0, limit: 10, enterpriseNames: names })).toMatchObject({ total: 0, identityCount: 0, workspaceCount: 0, items: [] })
  })

  it('folds the identity keys a caller holds from another relation into the identity total', async () => {
    const repository = await seeded()
    const withAccounts = await repository.searchWindow({ workspaceIds: scope, offset: 0, limit: 10, enterpriseNames: names, identityKeys: ['subject:platform-ops', 'subject:owner'] })
    expect(withAccounts.identityCount).toBe(6)
  })

  it('reports where the window starts, so a caller merging other relations can still slice its page', async () => {
    const repository = await seeded()
    const window = await repository.searchWindow({ workspaceIds: scope, offset: 3, limit: 2, mergeMargin: 4, enterpriseNames: names })
    expect(window.itemsFrom).toBe(0)
    const deep = await repository.searchWindow({ workspaceIds: ['ws_b'], offset: 2, limit: 1, enterpriseNames: names })
    expect(deep.itemsFrom).toBe(2)
    expect(await repository.searchWindow({ workspaceIds: scope, offset: 99, limit: 1, enterpriseNames: names })).toMatchObject({ items: [] })
  })

  it('drops a caller-supplied non-UUID identity instead of failing the lookup', async () => {
    const repository = await seeded()
    await expect(repository.findBySubject({ workspaceIds: scope, identityId: 'not-a-uuid', externalSubject: 'older' })).resolves.toHaveLength(1)
    await expect(repository.findBySubject({ workspaceIds: scope, identityId: 'not-a-uuid' })).resolves.toHaveLength(0)
  })
})

describe('PostgresMembersRepository platform reads', () => {
  const mock = (handler: (sql: string, params?: unknown[]) => { rows: unknown[] }) => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const queryFn = vi.fn(async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return handler(sql, params) })
    const client = { query: queryFn as unknown as SqlClient['query'], release: vi.fn() }
    const pool = { connect: async () => client } as SqlPool
    return { pool, calls, find: (fragment: string) => calls.find(call => call.sql.includes(fragment))! }
  }
  const memberRow = { id: 'member_1', workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'operator', status: 'active', invitedBy: 'seed', revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }

  it('reads the window and the totals in one platform-scoped transaction', async () => {
    const { pool, calls, find } = mock(sql => sql.includes('count(DISTINCT')
      ? { rows: [{ total: '7', workspaceCount: '2', identityCount: '6' }] }
      : sql.includes('bounds') ? { rows: [{ ...memberRow, __itemsFrom: '4' }] } : { rows: [] })
    const repository = new PostgresMembersRepository(pool, pool)
    const found = await repository.searchWindow!({ workspaceIds: ['ws_1', 'ws_2'], status: 'active', query: '用户', offset: 9, limit: 20, mergeMargin: 3, identityKeys: ['subject:platform'], enterpriseNames: new Map([['ws_1', '星河科技']]) })

    expect(found).toMatchObject({ total: 7, workspaceCount: 2, identityCount: 6, itemsFrom: 4 })
    expect(found.items[0]).not.toHaveProperty('__itemsFrom')
    expect(calls.map(call => call.sql)).toEqual([
      'BEGIN READ ONLY',
      "SELECT set_config('app.platform_scope', 'platform_ops', true)",
      expect.stringContaining('count(DISTINCT'),
      expect.stringContaining('bounds'),
      'COMMIT',
    ])
    // workspace scope, status, query, the caller's enterprise projection, the identity keys.
    expect(find('count(DISTINCT').params).toEqual([['ws_1', 'ws_2'], 'active', '用户', ['ws_1'], ['星河科技'], ['subject:platform']])
    // The window starts `mergeMargin` rows before the page and ends at its last row.
    expect(find('bounds').params!.slice(-2)).toEqual([6, 28])
    expect(find('bounds').sql).toContain('SELECT filtered.*')
  })

  it('searches the caller enterprise-name projection instead of joining enterprises', async () => {
    const { pool, find } = mock(() => ({ rows: [] }))
    const repository = new PostgresMembersRepository(pool, pool)
    await repository.searchWindow!({ workspaceIds: ['ws_1'], query: 'acme', offset: 0, limit: 5 })
    const window = find('bounds')
    expect(window.sql).toContain('unnest($3::text[], $4::text[])')
    expect(window.sql).not.toContain('enterprises')
    expect(window.params![2]).toEqual([])
  })

  it('looks a subject up across every workspace in scope without a directory scan', async () => {
    const { pool, calls, find } = mock(sql => sql.includes('workspace_members') ? { rows: [memberRow] } : { rows: [] })
    const repository = new PostgresMembersRepository(pool, pool)
    const rows = await repository.findBySubject!({ workspaceIds: ['ws_1', 'ws_2'], identityId: '50000000-0000-4000-8000-000000000001', externalSubject: 'user_1' })
    expect(rows).toHaveLength(1)
    const lookup = find('workspace_members')
    expect(lookup.sql).toContain('m.identity_id = $2 OR m.external_subject = $3')
    expect(lookup.params).toEqual([['ws_1', 'ws_2'], '50000000-0000-4000-8000-000000000001', 'user_1'])
    await repository.findBySubject!({ workspaceIds: ['ws_1'], identityId: 'not-a-uuid', externalSubject: 'user_1' })
    expect(calls.at(-2)!.params).toEqual([['ws_1'], null, 'user_1'])
    await expect(repository.findBySubject!({ workspaceIds: [''], externalSubject: 'user_1' })).rejects.toThrow('workspace scope is required')
  })

  it('exposes no platform read without a pool that can hold the operations role', () => {
    const repository = new PostgresMembersRepository(mock(() => ({ rows: [] })).pool)
    expect(repository.searchWindow).toBeUndefined()
    expect(repository.findBySubject).toBeUndefined()
  })
})
