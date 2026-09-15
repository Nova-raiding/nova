import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Rpc = { data: { result: Record<string, any> } | null; error: { code: string; details?: Record<string, unknown> } | null }
type Grant = { actor_id: string; roles: string[]; workbenches: string[]; workspaces: string[]; denied_capabilities?: string[] }
const allowedRoles = ['platform_admin', 'security_admin', 'ops_admin'] as const
const mutations = ['ops.user.suspend', 'ops.user.activate', 'ops.user.risk.transition', 'ops.user.session.revoke'] as const
let api: typeof import('./server.js'); let base = ''; let workspaceId = ''
let grants: Record<string, Grant> = {}; let target: { identityId: string; sessionId: string };

async function call(token: string, method: string, params: Record<string, unknown> = {}) {
  const grant = grants[token]
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
    ...(grant?.workbenches.includes('workspace') ? { 'x-workspace-id': workspaceId } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) })
  return { status: response.status, body: await response.json() as Rpc }
}
function success(value: Awaited<ReturnType<typeof call>>) {
  expect(value.status, JSON.stringify(value.body)).toBe(200)
  expect(value.body.error).toBeNull()
  return value.body.data!.result
}
async function detail(identityId = target.identityId) {
  return success(await call('platform_admin', 'ops.user.detail', { identity_id: identityId }))
}
function params(method: typeof mutations[number], revision = 1): Record<string, unknown> {
  return { identity_id: target.identityId, expected_revision: String(revision), idempotency_key: randomUUID(),
    reason: '账号权限契约隔离测试',
    ...(method === 'ops.user.suspend' || method === 'ops.user.activate' ? { scope: 'identity' } : {}),
    ...(method === 'ops.user.risk.transition' ? { risk_level: 'high', risk_decision: 'block', evidence_json: '{"test":"role-contract"}' } : {}),
    ...(method === 'ops.user.session.revoke' ? { session_id: target.sessionId } : {}),
  }
}

// Strict auth + actual loopback HTTP/registry/handler/Memory repository flow.
// This is not PostgreSQL/RLS evidence and does not change real user accounts.
describe('identity mutation roles match the registered platform capability contract', () => {
  beforeAll(async () => {
    for (const key of ['DATABASE_URL', 'OPS_DATABASE_URL', 'REDIS_URL', 'PGHOST'])
      if (process.env[key]) throw new Error(`Run safe-tests: inherited ${key} is forbidden`)
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AUTH_ENFORCEMENT', 'strict'); vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'identity-role-contract-isolated-secret')
    api = await import('./server.js')
    await new Promise<void>((resolve, reject) => {
      api.server.once('error', reject)
      api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', reject); resolve() })
    })
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('loopback binding unavailable')
    base = `http://127.0.0.1:${address.port}`
  })
  beforeEach(async () => {
    workspaceId = `ws_identity_roles_${randomUUID()}`
    grants = {}
    for (const role of [...allowedRoles, 'support_agent', 'auditor', 'viewer']) {
      grants[role] = { actor_id: `${role}-${randomUUID()}`, roles: [role], workbenches: ['platform'], workspaces: [] }
    }
    grants.explicit_deny = { actor_id: `denied-${randomUUID()}`, roles: ['platform_admin'], workbenches: ['platform'], workspaces: [],
      denied_capabilities: ['identity.update', 'identity.session.revoke'] }
    for (const [token, role] of [['target', 'operator'], ['workspace_owner', 'workspace_owner'], ['merchant_admin', 'merchant_admin'], ['operator', 'operator'], ['workspace_support', 'support']] as const) {
      const actorId = `${token}-${randomUUID()}`
      grants[token] = { actor_id: actorId, roles: [role], workbenches: ['workspace'], workspaces: [workspaceId] }
      await api.workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role,
        status: 'active', invitedBy: 'identity-role-contract' })
    }
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify(grants))
    const session = success(await call('target', 'ops.session'))
    target = { identityId: session.identity_id, sessionId: session.session_id }
    expect(target.identityId).toMatch(/^[a-f0-9-]{36}$/u)
    expect(target.sessionId).toMatch(/^[a-f0-9-]{36}$/u)
  })
  afterAll(async () => {
    try { if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve())) }
    finally { vi.unstubAllEnvs() }
  })

  it.each(allowedRoles)('allows %s to revoke, suspend, activate and change risk with immutable lifecycle events', async role => {
    let current = await detail()
    const session = current.sessions.find((value: { id: string }) => value.id === target.sessionId)
    const revoked = success(await call(role, 'ops.user.session.revoke', params('ops.user.session.revoke', session.revision)))
    expect(revoked.session).toMatchObject({ id: target.sessionId, status: 'revoked', revision: session.revision + 1 })
    expect(revoked.event).toMatchObject({ actorId: grants[role]!.actor_id, reason: '账号权限契约隔离测试' })
    const suspended = success(await call(role, 'ops.user.suspend', params('ops.user.suspend', current.identity.revision)))
    expect(suspended.identity).toMatchObject({ id: target.identityId, accessStatus: 'suspended', revision: current.identity.revision + 1 })
    const activated = success(await call(role, 'ops.user.activate', params('ops.user.activate', suspended.identity.revision)))
    expect(activated.identity).toMatchObject({ accessStatus: 'active', revision: suspended.identity.revision + 1 })
    const risk = success(await call(role, 'ops.user.risk.transition', params('ops.user.risk.transition', activated.identity.revision)))
    expect(risk.identity).toMatchObject({ riskLevel: 'high', riskDecision: 'block', revision: activated.identity.revision + 1 })
    current = await detail()
    expect(current.sessions.find((value: { id: string }) => value.id === target.sessionId).status).toBe('revoked')
    expect(current.lifecycleEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: revoked.event.id }), expect.objectContaining({ id: suspended.event.id }),
      expect.objectContaining({ id: activated.event.id }), expect.objectContaining({ id: risk.event.id }),
    ]))
  })

  it.each(['support_agent', 'auditor', 'viewer', 'workspace_owner', 'merchant_admin', 'operator', 'workspace_support', 'explicit_deny'])
   ('denies %s for all four mutations without changing target identity/session/lifecycle data', async role => {
      const before = await detail()
      for (const method of mutations) {
        const response = await call(role, method, params(method, before.identity.revision))
        expect(response.status, `${role} ${method}: ${JSON.stringify(response.body)}`).toBe(403)
        expect(response.body.error?.code).toBe(role === 'viewer' ? 'AUTHZ_WORKBENCH_FORBIDDEN' : 'FORBIDDEN')
        expect(await detail()).toEqual(before)
      }
    })

  it.each(mutations)('preserves required reason and revision validation for %s', async method => {
    const before = await detail()
    const missingReason = params(method, before.identity.revision); delete missingReason.reason
    const reasonResponse = await call('security_admin', method, missingReason)
    expect(reasonResponse.status).toBe(400); expect(reasonResponse.body.error?.code).toBe('INVALID_REQUEST')
    expect(await detail()).toEqual(before)
    const invalidRevision = await call('security_admin', method, { ...params(method), expected_revision: '0' })
    // Preserve the existing lifecycle mapper: all revision errors, including
    // an invalid positive revision, are returned as conflict (409).
    expect(invalidRevision.status).toBe(409)
    expect(invalidRevision.body.error?.code).toBe('IDENTITY_REVISION_INVALID')
    expect(await detail()).toEqual(before)
    const stale = await call('security_admin', method, params(method, 999))
    expect(stale.status, JSON.stringify(stale.body)).toBe(409)
    expect(stale.body.error?.code).toBe(method === 'ops.user.session.revoke' ? 'SESSION_REVISION_CONFLICT' : 'IDENTITY_REVISION_CONFLICT')
    expect(await detail()).toEqual(before)
  })

  it.each(allowedRoles)('retains self-suspension protection for %s', async role => {
    const own = success(await call(role, 'ops.session'))
    const before = await detail(own.identity_id)
    const denied = await call(role, 'ops.user.suspend', { ...params('ops.user.suspend', before.identity.revision), identity_id: own.identity_id })
    expect(denied.status).toBe(409); expect(denied.body.error?.code).toBe('SELF_SUSPENSION_DENIED')
    const after = await detail(own.identity_id)
    expect(after.identity).toMatchObject({ accessStatus: 'active', revision: before.identity.revision, authEpoch: before.identity.authEpoch })
    expect(after.lifecycleEvents.filter((event: { eventType: string }) => event.eventType === 'identity.suspended')).toEqual([])
  })
})
