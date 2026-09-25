import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { enableCommercialFixtureHarnessForTests, server, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'

type Envelope = { data: { result: { status?: string; items?: Array<{ method: string; role_access: Record<string, string> }> } } | null; error: { code: string; details?: Record<string, unknown> } | null }

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

async function call(base: string, token: string, workspaceId: string, workbench: 'workspace' | 'platform', method: 'workspace.activate' | 'workspace.deactivate' | 'ops.authorization.matrix.get') {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-ops-workbench': workbench, 'x-test-commercial-fixture': 'server-e2e' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: { workspace_id: workspaceId, ...(method === 'ops.authorization.matrix.get' ? {} : { reason: '验证工作区启停权限' }) } }),
  })
  return { status: response.status, body: await response.json() as Envelope }
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'workspace-status-authz-test-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  enableCommercialFixtureHarnessForTests()
  setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('workspace lifecycle authorization', () => {
  it('permits only the workspace owner to activate or deactivate, including in shadow mode', async () => {
    const workspaceId = `ws_status_authz_${randomUUID().slice(0, 8)}`
    const actors = { owner: `owner-${workspaceId}`, admin: `admin-${workspaceId}`, ops: `ops-${workspaceId}`, merchant: `merchant-${workspaceId}` }
    await Promise.all([
      workspaceMembers.upsert({ workspaceId, externalSubject: actors.owner, displayName: '工作区所有者', role: 'workspace_owner', status: 'active', invitedBy: 'authz-test' }),
      workspaceMembers.upsert({ workspaceId, externalSubject: actors.admin, displayName: '平台超级管理员', role: 'platform_ops', status: 'active', invitedBy: 'authz-test' }),
      workspaceMembers.upsert({ workspaceId, externalSubject: actors.ops, displayName: '旧平台运营', role: 'platform_ops', status: 'active', invitedBy: 'authz-test' }),
      workspaceMembers.upsert({ workspaceId, externalSubject: actors.merchant, displayName: '商家管理员', role: 'merchant_admin', status: 'active', invitedBy: 'authz-test' }),
    ])
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      owner: { workspaces: [workspaceId], actor_id: actors.owner, roles: ['workspace_owner'], workbenches: ['workspace'] },
      admin: { workspaces: [workspaceId], actor_id: actors.admin, roles: ['platform_admin'], workbenches: ['platform', 'workspace'] },
      ops: { workspaces: [workspaceId], actor_id: actors.ops, roles: ['platform_ops'], workbenches: ['platform', 'workspace'] },
      merchant: { workspaces: [workspaceId], actor_id: actors.merchant, roles: ['merchant_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()
    const disabled = await call(base, 'owner', workspaceId, 'workspace', 'workspace.deactivate')
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200)
    expect(disabled.body.data?.result.status).toBe('disabled')

    for (const [token, workbench, reasonCode] of [
      ['ops', 'platform', 'AUTHZ_WORKBENCH_MISMATCH'],
      ['ops', 'workspace', 'AUTHZ_CAPABILITY_MISSING'],
      ['merchant', 'workspace', 'AUTHZ_CAPABILITY_MISSING'],
      ['admin', 'platform', 'AUTHZ_WORKBENCH_MISMATCH'],
      ['admin', 'workspace', 'AUTHZ_CAPABILITY_MISSING'],
    ] as const) {
      const denied = await call(base, token, workspaceId, workbench, 'workspace.activate')
      expect(denied.status, JSON.stringify(denied.body)).toBe(403)
      expect(denied.body.error?.code).toBe('FORBIDDEN')
      expect(denied.body.error?.details?.reason_code).toBe(reasonCode)
    }

    const restored = await call(base, 'owner', workspaceId, 'workspace', 'workspace.activate')
    expect(restored.status, JSON.stringify(restored.body)).toBe(200)
    expect(restored.body.data?.result.status).toBe('active')

    vi.stubEnv('MCP_AUTHZ_MODE', 'shadow')
    for (const token of ['ops', 'merchant']) {
      const denied = await call(base, token, workspaceId, 'workspace', 'workspace.deactivate')
      expect(denied.status, JSON.stringify(denied.body)).toBe(403)
    }
    const shadowOwner = await call(base, 'owner', workspaceId, 'workspace', 'workspace.deactivate')
    expect(shadowOwner.status, JSON.stringify(shadowOwner.body)).toBe(200)
  })

  it('does not advertise tenant lifecycle mutation to platform roles in the authorization matrix', async () => {
    const workspaceId = `ws_status_matrix_${randomUUID().slice(0, 8)}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      admin: { workspaces: [workspaceId], actor_id: `admin-${workspaceId}`, roles: ['platform_admin'], workbenches: ['platform'] },
    }))
    const base = await start()
    const matrix = await call(base, 'admin', workspaceId, 'platform', 'ops.authorization.matrix.get')
    expect(matrix.status, JSON.stringify(matrix.body)).toBe(200)
    for (const method of ['workspace.activate', 'workspace.deactivate']) {
      const item = matrix.body.data?.result.items?.find(candidate => candidate.method === method)
      expect(item).toBeDefined()
      expect(item?.role_access).toMatchObject({ workspace_owner: 'govern', platform_admin: 'hidden', ops_admin: 'hidden', workspace_admin: 'hidden' })
    }
  })
})
