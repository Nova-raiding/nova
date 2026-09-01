import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'
import { server, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'

type RpcBody<T = unknown> = {
  request_id?: string
  trace_id?: string
  data: { result: T } | null
  error: { code: string; details?: Record<string, unknown> } | null
}

type Session = {
  actor_id: string
  identity_id: string
  session_id: string
  workbench: 'platform' | 'workspace'
  available_workbenches: Array<'platform' | 'workspace'>
  roles: string[]
  scopes: Array<{ type: string; ids: string[] }>
  temporary_grants: Array<{ id: string; expires_at: string; revision: number }>
  authorization_revision: number
}

type Grant = {
  id: string
  subjectIdentityId: string
  workspaceId: string
  expiresAt: string
  revision: number
  authorizationRevision: number
  revokedAt?: string
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
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${Date.now()}-${Math.random()}`, method, params }),
  })
  return { response, body: await response.json() as RpcBody<T> }
}

function configureToken(token: string, actorId: string, workspaceId: string) {
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
    [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['platform_ops', 'merchant_admin'], workbenches: ['platform', 'workspace'] },
  }))
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'ops-session-grant-contract-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('Ops session and grant API local contracts', () => {
  it('clips the selected session to one workbench and one workspace scope', async () => {
    const workspaceId = `ws_session_scope_${Date.now()}`
    const actorId = `session-scope-actor-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: 'Scope operator', role: 'merchant_admin', status: 'active', invitedBy: 'contract-test' })
    configureToken('session-scope-token', actorId, workspaceId)
    const base = await start()

    const platform = await call<Session>(base, 'session-scope-token', 'ops.session', {}, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'platform' })
    expect(platform.response.status).toBe(200)
    expect(platform.body.data?.result).toMatchObject({ workbench: 'platform', available_workbenches: ['platform', 'workspace'] })
    expect(platform.body.data!.result.scopes).toEqual(expect.arrayContaining([{ type: 'platform', ids: ['*'] }]))
    expect(platform.body.data!.result.scopes).not.toEqual(expect.arrayContaining([{ type: 'workspace', ids: [workspaceId] }]))

    const workspace = await call<Session>(base, 'session-scope-token', 'ops.session', {}, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' })
    expect(workspace.response.status).toBe(200)
    expect(workspace.body.data?.result).toMatchObject({ workbench: 'workspace' })
    expect(workspace.body.data!.result.scopes).toEqual(expect.arrayContaining([{ type: 'workspace', ids: [workspaceId] }]))
    expect(workspace.body.data!.result.scopes).not.toEqual(expect.arrayContaining([{ type: 'platform', ids: ['*'] }]))
  })

  it('issues an exact-scope grant, exposes it in the workspace session, and revokes it', async () => {
    const workspaceId = `ws_grant_lifecycle_${Date.now()}`
    const actorId = `grant-lifecycle-actor-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: 'Grant operator', role: 'merchant_admin', status: 'active', invitedBy: 'contract-test' })
    configureToken('grant-lifecycle-token', actorId, workspaceId)
    const base = await start()
    const session = await call<Session>(base, 'grant-lifecycle-token', 'ops.session', {}, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' })
    expect(session.response.status).toBe(200)
    const identityId = session.body.data!.result.identity_id
    const authorizationRevision = session.body.data!.result.authorization_revision
    const expiresAt = new Date(Date.now() + 60_000).toISOString()

    const issued = await call<Grant>(base, 'grant-lifecycle-token', 'ops.authorization.grant.issue', {
      subject_identity_id: identityId,
      target_workspace_id: workspaceId,
      grant_kind: 'support',
      access_mode: 'read',
      capabilities_json: JSON.stringify(['customer.content.read']),
      resource_scope_json: JSON.stringify({ type: 'workspace', ids: [workspaceId] }),
      ticket_ref: 'OPS-SESSION-GRANT-1',
      approved_by: 'security-approver',
      approved_at: new Date().toISOString(),
      expires_at: expiresAt,
      max_uses: '1',
      expected_authorization_revision: String(authorizationRevision),
      reason: '验证受控支持访问',
    }, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'platform' })
    expect(issued.response.status).toBe(200)
    expect(issued.body.error).toBeNull()
    const grant = issued.body.data!.result
    expect(grant).toMatchObject({ subjectIdentityId: identityId, workspaceId, revision: 1, authorizationRevision: authorizationRevision + 1, expiresAt })

    const projected = await call<Session>(base, 'grant-lifecycle-token', 'ops.session', {}, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' })
    expect(projected.body.data?.result.temporary_grants).toEqual(expect.arrayContaining([expect.objectContaining({ id: grant.id, expires_at: expiresAt, revision: 1 })]))

    const revoked = await call<Grant>(base, 'grant-lifecycle-token', 'ops.authorization.grant.revoke', {
      grant_id: grant.id,
      subject_identity_id: identityId,
      expected_revision: '1',
      expected_authorization_revision: String(grant.authorizationRevision),
      reason: '支持访问已完成，立即撤销',
    }, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'platform' })
    expect(revoked.response.status).toBe(200)
    expect(revoked.body.data?.result).toMatchObject({ id: grant.id, revokedAt: expect.any(String), revision: 2 })

    const afterRevoke = await call<Session>(base, 'grant-lifecycle-token', 'ops.session', {}, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' })
    expect(afterRevoke.body.data?.result.temporary_grants).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: grant.id })]))
  })

  it('removes an expired grant from the workspace session projection', async () => {
    const workspaceId = `ws_grant_expiry_${Date.now()}`
    const actorId = `grant-expiry-actor-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: 'Expiry operator', role: 'merchant_admin', status: 'active', invitedBy: 'contract-test' })
    configureToken('grant-expiry-token', actorId, workspaceId)
    const base = await start()
    const session = await call<Session>(base, 'grant-expiry-token', 'ops.session', {}, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' })
    const result = await call<Grant>(base, 'grant-expiry-token', 'ops.authorization.grant.issue', {
      subject_identity_id: session.body.data!.result.identity_id,
      target_workspace_id: workspaceId,
      grant_kind: 'temporary',
      access_mode: 'read',
      capabilities_json: JSON.stringify(['customer.content.read']),
      resource_scope_json: JSON.stringify({ type: 'workspace', ids: [workspaceId] }),
      ticket_ref: 'OPS-SESSION-GRANT-EXPIRY',
      approved_by: 'security-approver',
      approved_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 100).toISOString(),
      max_uses: '1',
      expected_authorization_revision: String(session.body.data!.result.authorization_revision),
      reason: '过期 grant 应被拒绝',
    }, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'platform' })
    expect(result.response.status).toBe(200)
    expect(result.body.data?.result).toMatchObject({ id: expect.any(String), expiresAt: expect.any(String) })
    await new Promise(resolve => setTimeout(resolve, 150))
    const expired = await call<Session>(base, 'grant-expiry-token', 'ops.session', {}, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' })
    expect(expired.response.status).toBe(200)
    expect(expired.body.data?.result.temporary_grants).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: result.body.data!.result.id })]))
  })

  it('returns stable 403 decision evidence for a workbench or capability denial', async () => {
    const workspaceId = `ws_session_grant_denied_${Date.now()}`
    const actorId = `session-grant-denied-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: 'Denied operator', role: 'support', status: 'active', invitedBy: 'contract-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'session-grant-denied-token': { workspaces: [workspaceId], actor_id: actorId, roles: ['support'], workbenches: ['workspace'] },
    }))
    const base = await start()
    const denied = await call(base, 'session-grant-denied-token', 'ops.authorization.grants.list', {
      subject_identity_id: 'identity-not-readable',
      target_workspace_id: workspaceId,
    }, { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' })
    expect(denied.response.status).toBe(403)
    expect(denied.body.data).toBeNull()
    expect(JSON.stringify(denied.body)).not.toContain('identity-not-readable')
    expect(denied.body.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: expect.any(String), decision_id: expect.any(String), policy_version: AUTHZ_POLICY_VERSION } })
    expect(denied.body.request_id).toMatch(/^req_/)
    expect(denied.body.trace_id).toBe(denied.body.request_id)
  })
})
