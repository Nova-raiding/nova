import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'
import { AUTHZ_POLICY_VERSION, CANONICAL_ROLES, MCP_METHOD_POLICIES } from '../../../packages/contracts/src/authz.js'
import { MCP_METHODS } from '../../../packages/contracts/src/mcp.js'

type RpcBody<T = unknown> = {
  request_id?: string
  trace_id?: string
  data: { result: T } | null
  error: { code: string; details?: Record<string, unknown> } | null
}

type Session = {
  schema_version: number
  identity_id: string
  session_id: string
  workbench: 'platform' | 'workspace'
  available_workbenches: Array<'platform' | 'workspace'>
  roles: string[]
  canonical_roles: string[]
  capabilities: string[]
  scopes: Array<{ type: string; ids: string[] }>
  policy_version: string
}

type Matrix = {
  schema_version: number
  policy_version: string
  generated_from: string
  method_count: number
  role_count: number
  roles: string[]
  items: Array<{
    method: string
    capability: string
    workbench: string
    scope: string
    data_class: string
    effect: string
    audit: string
    obligations: string[]
    role_access: Record<string, string>
  }>
}

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

async function call<T>(base: string, token: string, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${Date.now()}`, method, params }),
  })
  return { response, body: await response.json() as RpcBody<T> }
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'ops-rbac-acceptance-session-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('Ops RBAC backend API acceptance contracts', () => {
  it('returns a closed, current authorization matrix contract for every registered MCP method', async () => {
    const workspaceId = `ws_ops_matrix_contract_${Date.now()}`
    const actorId = `ops-matrix-actor-${Date.now()}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'ops-matrix-token': { workspaces: [], actor_id: actorId, roles: ['platform_ops'], workbenches: ['platform'] },
    }))
    const base = await start()
    const { response, body } = await call<Matrix>(base, 'ops-matrix-token', 'ops.authorization.matrix.get', {}, { 'x-ops-workbench': 'platform' })

    expect(response.status).toBe(200)
    expect(body.error).toBeNull()
    const matrix = body.data!.result
    expect(matrix).toMatchObject({
      schema_version: 1,
      policy_version: AUTHZ_POLICY_VERSION,
      generated_from: 'MCP_METHOD_POLICIES',
      method_count: MCP_METHODS.length,
      role_count: CANONICAL_ROLES.length,
      roles: CANONICAL_ROLES,
    })
    expect(matrix.items.map(item => item.method).sort()).toEqual(Object.keys(MCP_METHOD_POLICIES).sort())
    for (const item of matrix.items) {
      expect(item.capability).toEqual(expect.any(String))
      expect(item.workbench).toEqual(expect.any(String))
      expect(item.scope).toEqual(expect.any(String))
      expect(item.data_class).toEqual(expect.any(String))
      expect(['read', 'write', 'allow_and_deny']).toContain(item.effect)
      expect(item.audit).toEqual(expect.any(String))
      expect(Array.isArray(item.obligations)).toBe(true)
      expect(Object.keys(item.role_access)).toEqual(CANONICAL_ROLES)
      expect(Object.values(item.role_access).every(value => ['hidden', 'read', 'operate', 'govern'].includes(String(value)))).toBe(true)
    }
  })

  it('protects the matrix endpoint with the same platform authorization boundary as its data', async () => {
    const workspaceId = `ws_ops_matrix_boundary_${Date.now()}`
    const actorId = `ops-matrix-boundary-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: 'Ops support', role: 'support', status: 'active', invitedBy: 'acceptance-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'ops-support-token': { workspaces: [workspaceId], actor_id: actorId, roles: ['support'], workbenches: ['workspace'] },
    }))
    const base = await start()
    const denied = await call(base, 'ops-support-token', 'ops.authorization.matrix.get', {}, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' })

    expect(denied.response.status).toBe(403)
    expect(denied.body.data).toBeNull()
    expect(denied.body.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: expect.any(String), decision_id: expect.any(String), policy_version: AUTHZ_POLICY_VERSION } })
    expect(denied.body.request_id).toMatch(/^req_/)
    expect(denied.body.trace_id).toBe(denied.body.request_id)
  })

  it('projects one selected workbench in session and keeps rejection evidence stable', async () => {
    const workspaceId = `ws_ops_session_contract_${Date.now()}`
    const actorId = `ops-session-actor-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: 'Dual workbench operator', role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'ops-dual-token': { workspaces: [workspaceId], actor_id: actorId, roles: ['platform_ops', 'merchant_admin'], workbenches: ['platform', 'workspace'] },
    }))
    const base = await start()

    const platform = await call<Session>(base, 'ops-dual-token', 'ops.session', {}, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'platform' })
    expect(platform.response.status).toBe(200)
    expect(platform.body.error).toBeNull()
    expect(platform.body.data!.result).toMatchObject({
      schema_version: 2,
      workbench: 'platform',
      available_workbenches: ['platform', 'workspace'],
      roles: ['platform_ops'],
      canonical_roles: ['ops_admin'],
      policy_version: AUTHZ_POLICY_VERSION,
      scopes: expect.arrayContaining([{ type: 'platform', ids: ['*'] }]),
    })
    expect(platform.body.data!.result.scopes).not.toEqual(expect.arrayContaining([{ type: 'workspace', ids: [workspaceId] }]))

    const workspace = await call<Session>(base, 'ops-dual-token', 'ops.session', {}, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' })
    expect(workspace.response.status).toBe(200)
    expect(workspace.body.data!.result).toMatchObject({ workbench: 'workspace', roles: ['merchant_admin'], canonical_roles: ['workspace_admin'], policy_version: AUTHZ_POLICY_VERSION, scopes: expect.arrayContaining([{ type: 'workspace', ids: [workspaceId] }]) })
    expect(workspace.body.data!.result.scopes).not.toEqual(expect.arrayContaining([{ type: 'platform', ids: ['*'] }]))

    const mismatch = await call(base, 'ops-dual-token', 'platform.settings.get', { workspace_id: workspaceId }, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' })
    expect(mismatch.response.status).toBe(403)
    expect(mismatch.body.data).toBeNull()
    expect(mismatch.body.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH', decision_id: expect.any(String), policy_version: AUTHZ_POLICY_VERSION } })
    expect(mismatch.body.request_id).toMatch(/^req_/)
    expect(mismatch.body.trace_id).toBe(mismatch.body.request_id)
  })
})
