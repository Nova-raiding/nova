import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operationAudits, server, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'

type Envelope = {
  request_id?: string
  trace_id?: string
  data: { result: unknown } | null
  error: { code: string; details?: Record<string, unknown> } | null
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

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'ops-rbac-http-brand-profile-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('Ops RBAC real HTTP brand profile route', () => {
  it('allows the registered route and denies explicit customer-data access without leaking profile identity', async () => {
    const workspaceId = `ws_ops_http_brand_profile_${Date.now()}`
    const allowedActorId = `ops-http-brand-profile-allowed-${Date.now()}`
    const deniedActorId = `ops-http-brand-profile-denied-${Date.now()}`
    const secretProfileMarker = 'brand-profile-marker-must-not-leak'
    await workspaceMembers.upsert({ workspaceId, externalSubject: allowedActorId, displayName: 'HTTP brand profile operator', role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: deniedActorId, displayName: 'HTTP brand profile denied operator', role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'ops-http-brand-profile-allowed-token': { workspaces: [workspaceId], actor_id: allowedActorId, roles: ['merchant_admin'], workbenches: ['workspace'] },
      'ops-http-brand-profile-denied-token': { workspaces: [workspaceId], actor_id: deniedActorId, roles: ['merchant_admin'], denied_capabilities: ['customer.content.read'], workbenches: ['workspace'] },
    }))
    const base = await start()
    const path = `${base}/v1/brand-profile`
    const headers = { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' }

    const allowed = await fetch(path, { headers: { ...headers, authorization: 'Bearer ops-http-brand-profile-allowed-token' } })
    const allowedBody = await allowed.json() as Envelope
    // The request passed the shared HTTP policy and active-member gate, then
    // reached the route's local onboarding prerequisite.
    expect(allowed.status).toBe(428)
    expect(allowedBody.data).toBeNull()
    expect(allowedBody.error).toMatchObject({ code: 'STORE_ONBOARDING_REQUIRED' })
    expect(allowedBody.request_id).toMatch(/^req_/)
    expect(allowedBody.trace_id).toBe(allowedBody.request_id)

    const denied = await fetch(path, { headers: { ...headers, authorization: 'Bearer ops-http-brand-profile-denied-token' } })
    const deniedBody = await denied.json() as Envelope
    expect(denied.status).toBe(403)
    expect(deniedBody.data).toBeNull()
    expect(deniedBody.error).toMatchObject({
      code: 'FORBIDDEN',
      details: {
        capability: 'customer.content.read',
        reason_code: 'AUTHZ_EXPLICIT_DENY',
        decision_id: expect.any(String),
        policy_version: AUTHZ_POLICY_VERSION,
      },
    })
    expect(deniedBody.error?.details).not.toHaveProperty('workspace_id')
    expect(deniedBody.error?.details).not.toHaveProperty('profile_id')
    expect(JSON.stringify(deniedBody)).not.toContain(secretProfileMarker)
    expect(deniedBody.request_id).toMatch(/^req_/)
    expect(deniedBody.trace_id).toBe(deniedBody.request_id)

    const audits = await operationAudits.list(workspaceId)
    const denialAudit = audits.find(audit => audit.action === 'authz.decision' && audit.actorId === deniedActorId)
    expect(denialAudit?.after).toMatchObject({
      capability: 'customer.content.read',
      result: 'deny',
      reason_code: 'AUTHZ_EXPLICIT_DENY',
      policy_version: AUTHZ_POLICY_VERSION,
      decision_id: expect.any(String),
      request_id: deniedBody.request_id,
      trace_id: deniedBody.trace_id,
    })
    expect(denialAudit?.after).not.toHaveProperty('workspace_id')
    expect(denialAudit?.after).not.toHaveProperty('profile_id')
    expect(JSON.stringify(denialAudit?.after)).not.toContain(secretProfileMarker)
  })
})
