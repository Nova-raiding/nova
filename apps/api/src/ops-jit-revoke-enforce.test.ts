import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import argon2 from 'argon2'
import { AUTHZ_POLICY_VERSION, evaluateAuthorizationDecision, evaluatePermissionAtoms, getMcpMethodPolicy, type AuthorizationObligation, type PermissionAtom } from '../../../packages/contracts/src/authz.js'
import { MemoryAuthorizationRepository, type AuthorizationGrant, type IssueAuthorizationGrantInput, type RevokeAuthorizationGrantInput, type PlatformAssignedRole } from '../../../packages/persistence/src/authorization-repository.js'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import { MemoryPlatformAuthorizationAuditRepository } from '../../../packages/persistence/src/platform-authorization-audit-repository.js'

// Deliberate security-contract change. These tests used to reach the `approval`
// obligation on `ops.authorization.grant.issue` by sending only the
// caller-supplied `approved_by` + `approved_at` fields, i.e. they exercised the
// forgeable contract. The obligation is now satisfied solely by server-issued
// evidence: `verifiedApprovalActor` resolves the approver from the
// `x-authorization-approval-token` header against the `AUTHORIZATION_APPROVAL_TOKENS`
// token registry, so every call that needs `approval` must carry that token.
//
// The token is stubbed per test because its grant is bound to the workspace the
// grant request targets, and the workspace is regenerated in `beforeEach`. The
// grant's `actor_id` is `approverActorId`, which must differ from the acting
// principal (separation of duties) and must match any claimed `approved_by`
// (the claim may only confirm the token, never establish it).
const approvalToken = 'jit-revoke-http-fixture-approval-token'
// A second token for the same approver but a different tenant, used to prove the
// approval cannot be replayed across workspaces.
const otherWorkspaceApprovalToken = 'jit-revoke-http-fixture-approval-token-other-workspace'
const approverActorId = 'independent-security-approver'

const issueMethod = 'ops.authorization.grant.issue'
const revokeMethod = 'ops.authorization.grant.revoke'
type Envelope<T = unknown> = { request_id: string; trace_id: string; data: { result: T } | null; error: { code: string; details?: Record<string, unknown> } | null }
type Actor = { subject: string; sessionId: string; identityId: string; roles: string[]; cookie: string }
type Session = { identity_id: string; roles: string[]; capabilities: string[]; authorization_revision: number; temporary_grants: Array<{ id: string; revision: number }> }

// E1: real password-cookie loopback HTTP, real policy/route/Memory repository methods.
// This observer records successful mutations only; it is NOT the PostgreSQL
// ops_access_grant_events table or evidence of PostgreSQL/RLS.
class ObservedAuthorizationRepository extends MemoryAuthorizationRepository {
  readonly successfulMutations: Array<{ type: 'issued' | 'revoked'; grant: AuthorizationGrant }> = []
  readonly revokeFailures: string[] = []
  override async issueGrant(input: IssueAuthorizationGrantInput) {
    const grant = await super.issueGrant(input)
    this.successfulMutations.push({ type: 'issued', grant: structuredClone(grant) })
    return grant
  }
  override async revokeGrant(input: RevokeAuthorizationGrantInput) {
    try {
      const grant = await super.revokeGrant(input)
      this.successfulMutations.push({ type: 'revoked', grant: structuredClone(grant) })
      return grant
    } catch (error) {
      this.revokeFailures.push(error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown')
      throw error
    }
  }
}

describe('E1 password-session JIT revoke under enforced durable authorization', () => {
  let api: typeof import('./server.js')
  let persistence: Awaited<typeof import('./server.js').persistenceReady>
  let originals: Pick<typeof persistence, 'authorization' | 'platformAuthorizationAudit'>
  let repository: ObservedAuthorizationRepository
  let passwordAuth: MemoryPasswordAuthRepository
  let audits: MemoryPlatformAuthorizationAuditRepository
  let base: string
  let issuer: string
  let workspaceId: string
  let subject: Actor
  let admin: Actor

  beforeAll(async () => {
    // Do this before importing the composition root. The safe npm test entry
    // also removes ambient configuration; this file never needs external I/O.
    for (const key of ['DATABASE_URL', 'OPS_DATABASE_URL', 'REDIS_URL', 'MERCHANT_BEARER_HOSTNAME', 'API_AUTH_TOKENS', 'MODEL_RELAY_API_KEY', 'VIDEO_MODEL_RELAY_API_KEY']) vi.stubEnv(key, undefined)
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('OPS_AUTH_MODE', 'password')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED', 'true')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    api = await import('./server.js')
    persistence = await api.persistenceReady
    expect(persistence.mode).toBe('memory')
    originals = { authorization: persistence.authorization, platformAuthorizationAudit: persistence.platformAuthorizationAudit }
  })

  beforeEach(async () => {
    repository = new ObservedAuthorizationRepository()
    passwordAuth = new MemoryPasswordAuthRepository()
    audits = new MemoryPlatformAuthorizationAuditRepository()
    persistence.authorization = repository
    persistence.platformAuthorizationAudit = audits
    api.setPasswordAuthRepositoryForTests(passwordAuth)
    api.setAuthorizationRepositoryForTests(repository)
    const runId = randomUUID()
    issuer = `https://jit-fixture.invalid/${runId}`
    workspaceId = `ws_jit_revoke_${runId.replaceAll('-', '')}`
    vi.stubEnv('AUTHORIZATION_APPROVAL_TOKENS', JSON.stringify({
      [approvalToken]: { actor_id: approverActorId, workspaces: [workspaceId] },
      [otherWorkspaceApprovalToken]: { actor_id: approverActorId, workspaces: [`ws_other_${runId.replaceAll('-', '')}`] },
    }))
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      api.server.once('error', onError)
      api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', onError); resolve() })
    })
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('isolated HTTP server did not bind')
    base = `http://127.0.0.1:${address.port}`
    subject = await actor('support_agent')
    admin = await actor('platform_admin')
  })

  afterEach(async () => {
    try {
      if (api?.server.listening) await new Promise<void>((resolve, reject) => {
        api.server.close(error => error ? reject(error) : resolve())
        api.server.closeAllConnections()
      })
    } finally {
      if (persistence && originals) Object.assign(persistence, originals)
      api?.setAuthorizationRepositoryForTests()
      api?.setPasswordAuthRepositoryForTests()
      vi.restoreAllMocks()
    }
  })
  afterAll(() => { vi.unstubAllEnvs() })

  async function actor(role: PlatformAssignedRole, assigned = true, _gatewayRoles: string[] = [role]): Promise<Actor> {
    const login = `${role}-${randomUUID()}@example.test`
    const password = 'JitFixturePassword123!'
    await passwordAuth.ensurePlatformAccount({ login, passwordHash: await argon2.hash(password), roles: [] })
    const account = (await passwordAuth.listAccounts()).find(value => value.login === login)!
    if (assigned) await repository.assignPlatformRole({ subjectIdentityId: account.identityId, role, assignedBy: 'isolated-test-bootstrap', reason: 'Seed a canonical durable role for this fixture only', expectedAuthorizationRevision: 0 })
    const loginResponse = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password, account_type: 'platform' }) })
    expect(loginResponse.status).toBe(200)
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toBeTruthy()
    return { subject: account.identityId, sessionId: '', identityId: account.identityId, roles: assigned ? [role] : [], cookie: cookie! }
  }

  // `approvalTokenHeader` defaults to the valid server-issued token; pass `null`
  // to send no approval evidence at all, or another value to present a token the
  // registry does not bind to this operation.
  async function call<T = unknown>(who: Actor, method: string, params: Record<string, unknown> = {}, workbench: 'platform' | 'workspace' = 'platform', tamperSignature = false, approvalTokenHeader: string | null = approvalToken, includeCookie = true, workspaceHeader?: string) {
    const selectedWorkspace = workspaceHeader ?? (workbench === 'workspace' ? workspaceId : '')
    const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params })
    const response = await fetch(`${base}/mcp`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), body,
      headers: { 'content-type': 'application/json', ...(includeCookie ? { cookie: who.cookie } : {}), origin: base, 'x-ops-workbench': workbench, ...(tamperSignature ? { 'x-oidc-signature': '0'.repeat(64), 'x-oidc-sub': 'forged', 'x-oidc-roles': 'platform_admin' } : {}), ...(approvalTokenHeader ? { 'x-authorization-approval-token': approvalTokenHeader } : {}), ...(selectedWorkspace ? { 'x-workspace-id': selectedWorkspace } : {}) },
    })
    return { status: response.status, body: await response.json() as Envelope<T> }
  }

  async function issueParams() {
    // `approved_by` only confirms the approver the server-issued token
    // establishes; it must equal the token grant's `actor_id` or the claim is
    // rejected as a contradiction.
    return { subject_identity_id: subject.identityId, target_workspace_id: workspaceId, grant_kind: 'support', access_mode: 'read', capabilities_json: JSON.stringify(['customer.content.read']), resource_scope_json: JSON.stringify({ workspace_ids: [workspaceId] }), ticket_ref: `JIT-${randomUUID()}`, approved_by: approverActorId, approved_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(), max_uses: '3', expected_authorization_revision: String(await repository.getAuthorizationRevision(subject.identityId)), reason: 'Grant isolated support access after independent approval' }
  }

  async function issue(who = admin) {
    const response = await call<AuthorizationGrant>(who, issueMethod, await issueParams())
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body.error).toBeNull()
    expect(response.body.data?.result).toMatchObject({ subjectIdentityId: subject.identityId, workspaceId, resourceScope: { workspace_ids: [workspaceId] }, revision: 1 })
    return response.body.data!.result
  }
  const revokeParams = (grant: AuthorizationGrant): Record<string, unknown> => ({ grant_id: grant.id, subject_identity_id: subject.identityId, expected_revision: String(grant.revision), expected_authorization_revision: String(grant.authorizationRevision), reason: 'Support finished; immediately withdraw the existing access' })
  async function state(grant: AuthorizationGrant) {
    return { grant: await repository.getGrant(grant.id, subject.identityId), revision: await repository.getAuthorizationRevision(subject.identityId), active: await repository.listActiveGrants(subject.identityId, workspaceId), mutations: structuredClone(repository.successfulMutations) }
  }

  it.each(['platform_admin', 'security_admin'] as const)('%s revokes without approval over password-session HTTP, increments revisions, audits, and invalidates old access', async role => {
    const who = role === 'platform_admin' ? admin : await actor(role)
    const session = await call<Session>(who, 'ops.session')
    expect(session.status, JSON.stringify(session.body)).toBe(200)
    expect(session.body.data?.result).toMatchObject({ identity_id: who.identityId, roles: [role], authorization_revision: 1 })
    expect(session.body.data?.result.capabilities).toContain('authorization.grant.manage')
    expect(who.identityId).not.toBe(subject.identityId)
    const beforeGrantAccess = await call<Session>(subject, 'ops.session', {}, 'workspace', false, approvalToken, true, workspaceId)
    expect(beforeGrantAccess.status, JSON.stringify(beforeGrantAccess.body)).toBe(200)
    expect(beforeGrantAccess.body.data?.result.temporary_grants).toEqual([])
    const grant = await issue(who)
    expect(await repository.listActiveGrants(subject.identityId, workspaceId)).toContainEqual(expect.objectContaining({ id: grant.id, revision: 1 }))
    const before = await state(grant)
    expect(await repository.consumeGrant({ id: grant.id, subjectIdentityId: subject.identityId, workspaceId, capability: 'customer.content.read', scopeHash: grant.scopeHash, expectedRevision: grant.revision, actorId: subject.subject, reason: 'Simulate an authorized resource access before revocation' })).toMatchObject({ id: grant.id, useCount: 1 })
    const consumed = await state(grant)
    const grantedAccess = await call<Session>(subject, 'ops.session', {}, 'workspace', false, approvalToken, true, workspaceId)
    expect(grantedAccess.status, JSON.stringify(grantedAccess.body)).toBe(200)
    expect(grantedAccess.body.data?.result.temporary_grants).toEqual([])
    const params = { ...revokeParams(grant), expected_revision: String(consumed.grant!.revision), expected_authorization_revision: String(consumed.revision) }
    expect(params).not.toHaveProperty('approved_by')
    expect(params).not.toHaveProperty('approved_at')
    const revoked = await call<AuthorizationGrant>(who, revokeMethod, params)
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200)
    expect(revoked.body.error).toBeNull()
    expect(revoked.body.data?.result).toMatchObject({ id: grant.id, revokedBy: who.subject, revokedAt: expect.any(String), revision: consumed.grant!.revision + 1, authorizationRevision: consumed.revision + 1 })
    expect(await repository.getAuthorizationRevision(subject.identityId)).toBe(consumed.revision + 1)
    expect(await repository.listActiveGrants(subject.identityId, workspaceId)).toEqual([])
    expect(repository.successfulMutations.map(event => event.type)).toEqual(['issued', 'revoked'])
    const audit = (await audits.list({ actorId: who.subject, method: revokeMethod })).find(row => row.requestId === revoked.body.request_id)
    expect(audit).toMatchObject({ result: 'allow', capability: 'authorization.grant.manage', workbench: 'platform', policyVersion: AUTHZ_POLICY_VERSION, traceId: revoked.body.trace_id, evidence: { obligations: { required: ['reason', 'revision'], missing: [] } } })
    const afterAccess = await call(subject, 'ops.session', {}, 'workspace', false, approvalToken, true, workspaceId)
    expect(afterAccess.status).toBe(200)
    expect(afterAccess.body.data?.result.temporary_grants).toEqual([])
    const after = await state(grant)
    expect(await repository.consumeGrant({ id: grant.id, subjectIdentityId: subject.identityId, workspaceId, capability: 'customer.content.read', scopeHash: grant.scopeHash, expectedRevision: consumed.grant!.revision, actorId: subject.subject, reason: 'Attempt to reuse the revoked grant snapshot' })).toBeUndefined()
    expect(await state(grant)).toEqual(after)
  })

  it('issue still rejects missing independent approval without adding a grant or advancing the subject revision', async () => {
    const params: Record<string, unknown> = await issueParams()
    delete params.approved_by
    delete params.approved_at
    const revision = await repository.getAuthorizationRevision(subject.identityId)
    const response = await call(admin, issueMethod, params)
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('INVALID_REQUEST')
    expect(await repository.getAuthorizationRevision(subject.identityId)).toBe(revision)
    expect(await repository.listActiveGrants(subject.identityId, workspaceId)).toEqual([])
    expect(repository.successfulMutations).toEqual([])
  })

  // The forgery that motivated the change: `approved_by` + `approved_at` alone
  // proved nothing, so a caller could mint their own maker-checker approval.
  // Under `MCP_AUTHZ_MODE=enforce` the obligation must now be missing and the
  // issue must be denied before it reaches the repository.
  it('issue rejects a claimed approved_by/approved_at presented without a server-issued token', async () => {
    const revision = await repository.getAuthorizationRevision(subject.identityId)
    const response = await call(admin, issueMethod, await issueParams(), 'platform', false, null)
    expect(response.status, JSON.stringify(response.body)).toBe(403)
    expect(response.body.error?.code).toBe('FORBIDDEN')
    expect(response.body.error?.details).toMatchObject({ reason_code: 'AUTHZ_OBLIGATION_REQUIRED', obligations_missing: ['approval'] })
    expect(await repository.getAuthorizationRevision(subject.identityId)).toBe(revision)
    expect(await repository.listActiveGrants(subject.identityId, workspaceId)).toEqual([])
    expect(repository.successfulMutations).toEqual([])
  })

  // A claimed approver that disagrees with the token grant is a contradiction,
  // not an approval: the claim may only confirm the identity the server
  // established, never substitute for it.
  it('issue rejects a valid approval token whose grant actor contradicts the claimed approved_by', async () => {
    const revision = await repository.getAuthorizationRevision(subject.identityId)
    const response = await call(admin, issueMethod, { ...await issueParams(), approved_by: 'claimed-approver-that-contradicts-the-grant' })
    expect(response.status, JSON.stringify(response.body)).toBe(403)
    expect(response.body.error?.code).toBe('FORBIDDEN')
    expect(response.body.error?.details).toMatchObject({ reason_code: 'AUTHZ_OBLIGATION_REQUIRED', obligations_missing: ['approval'] })
    expect(await repository.getAuthorizationRevision(subject.identityId)).toBe(revision)
    expect(await repository.listActiveGrants(subject.identityId, workspaceId)).toEqual([])
    expect(repository.successfulMutations).toEqual([])
  })

  // The token is bound to the workspace the grant request targets, so a token
  // issued for another tenant cannot approve this tenant's privilege grant.
  it('issue rejects a valid approval token that is not bound to the target workspace', async () => {
    const revision = await repository.getAuthorizationRevision(subject.identityId)
    const response = await call(admin, issueMethod, await issueParams(), 'platform', false, otherWorkspaceApprovalToken)
    expect(response.status, JSON.stringify(response.body)).toBe(403)
    expect(response.body.error?.code).toBe('FORBIDDEN')
    expect(response.body.error?.details).toMatchObject({ reason_code: 'AUTHZ_OBLIGATION_REQUIRED', obligations_missing: ['approval'] })
    expect(await repository.getAuthorizationRevision(subject.identityId)).toBe(revision)
    expect(await repository.listActiveGrants(subject.identityId, workspaceId)).toEqual([])
    expect(repository.successfulMutations).toEqual([])
  })

  it.each(['reason', 'expected_revision', 'expected_authorization_revision'])('revoke schema rejects missing %s with no grant mutation', async field => {
    const grant = await issue()
    const before = await state(grant)
    const params = revokeParams(grant)
    delete params[field]
    const response = await call(admin, revokeMethod, params)
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('INVALID_REQUEST')
    expect(await state(grant)).toEqual(before)
    expect(repository.revokeFailures).toEqual([])
  })

  it.each([
    ['unaccepted approval identity', 'approved_by', 'unrequested-second-approver'],
    ['unaccepted approval timestamp', 'approved_at', '2026-09-07T00:00:00.000Z'],
    ['non-numeric grant revision', 'expected_revision', 'not-a-revision'],
    ['non-numeric subject revision', 'expected_authorization_revision', 'not-a-revision'],
    ['blank reason', 'reason', '   '],
  ])('revoke schema rejects %s before any repository mutation', async (_label, field, value) => {
    const grant = await issue()
    const before = await state(grant)
    const denied = await call(admin, revokeMethod, { ...revokeParams(grant), [field!]: value })
    expect(denied.status).toBe(400)
    expect(denied.body.error?.code).toBe('INVALID_REQUEST')
    expect(await state(grant)).toEqual(before)
    expect(repository.revokeFailures).toEqual([])
  })

  it('rejects a freshly signed duplicate of the old revoke intent without a second mutation or revision increment', async () => {
    const grant = await issue()
    const params = revokeParams(grant)
    const revoked = await call<AuthorizationGrant>(admin, revokeMethod, params)
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200)
    expect(revoked.body.data?.result).toMatchObject({ id: grant.id, revision: grant.revision + 1, authorizationRevision: grant.authorizationRevision + 1 })
    const after = await state(grant)
    // A fresh password-cookie request must reach the repository's revoked-state check.
    const replay = await call(admin, revokeMethod, params)
    expect(replay.status).toBe(404)
    expect(replay.body.error?.code).toBe('AUTHORIZATION_GRANT_NOT_FOUND')
    expect(replay.body.data).toBeNull()
    expect(repository.revokeFailures).toEqual(['AUTHORIZATION_GRANT_NOT_FOUND'])
    expect(await state(grant)).toEqual(after)
    expect(repository.successfulMutations.map(event => event.type)).toEqual(['issued', 'revoked'])
  })

  it.each([
    ['stale grant revision', 'expected_revision', '2', 'AUTHORIZATION_GRANT_REVISION_CONFLICT', 409],
    ['stale subject revision', 'expected_authorization_revision', '0', 'AUTHORIZATION_REVISION_CONFLICT', 409],
    ['wrong subject', 'subject_identity_id', 'another-independent-identity', 'AUTHORIZATION_GRANT_NOT_FOUND', 404],
  ])('revoke rejects %s in the real repository without changing grant, revisions, or successful mutations', async (_label, field, value, repositoryCode, expectedStatus) => {
    const grant = await issue()
    const before = await state(grant)
    const response = await call(admin, revokeMethod, { ...revokeParams(grant), [field!]: value })
    expect(response.status).toBe(expectedStatus)
    expect(response.body.error?.code).toBe(repositoryCode)
    expect(response.body.data).toBeNull()
    expect(repository.revokeFailures).toEqual([repositoryCode])
    expect(await state(grant)).toEqual(before)
  })

  it.each(['auditor', 'unassigned'] as const)('signed gateway admin claims cannot replace %s durable grant-manage permission', async variant => {
    const grant = await issue()
    const who = await actor('auditor', variant !== 'unassigned', ['platform_admin'])
    const before = await state(grant)
    const denied = await call(who, revokeMethod, revokeParams(grant))
    expect(denied.status).toBe(403)
    expect(denied.body.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_CAPABILITY_MISSING' } })
    expect(await state(grant)).toEqual(before)
    expect(repository.revokeFailures).toEqual([])
    const audit = await audits.getByDecisionId(String(denied.body.error?.details?.decision_id))
    expect(audit).toMatchObject({ actorId: who.subject, method: revokeMethod, result: 'deny', reasonCode: 'AUTHZ_CAPABILITY_MISSING', requestId: denied.body.request_id, policyVersion: AUTHZ_POLICY_VERSION })
  })

  it('rejects a password account with no platform role before grant mutation', async () => {
    const grant = await issue()
    const before = await state(grant)
    const unassigned = await actor('auditor', false)
    const denied = await call(unassigned, revokeMethod, revokeParams(grant))
    expect(denied.status).toBe(403)
    expect(denied.body.error).toMatchObject({ code: 'FORBIDDEN', details: { reason_code: 'AUTHZ_CAPABILITY_MISSING' } })
    expect(await state(grant)).toEqual(before)
    expect(repository.revokeFailures).toEqual([])
  })

  it('does not accept legacy OIDC identity headers without a password session', async () => {
    const grant = await issue()
    const before = await state(grant)
    const denied = await call(admin, revokeMethod, revokeParams(grant), 'platform', true, approvalToken, false)
    expect(denied.status).toBe(401)
    expect(denied.body.error?.code).toBe('UNAUTHENTICATED')
    expect(await state(grant)).toEqual(before)
    expect(repository.revokeFailures).toEqual([])
  })
})

describe('E0 JIT issue/revoke policy obligation boundary', () => {
  it.each([
    [issueMethod, ['reason', 'revision', 'approval']],
    [revokeMethod, ['reason', 'revision']],
  ] as const)('%s retains the exact declared obligations and platform audit policy', (method, obligations) => {
    expect(getMcpMethodPolicy(method)).toMatchObject({ method, capability: 'authorization.grant.manage', scope: 'platform', effect: 'write', audit: 'allow_and_deny', obligations: [...obligations] })
  })

  const cases: Array<{ label: string; method: string; satisfied: AuthorizationObligation[]; allowed: boolean; reason: string; missing?: AuthorizationObligation[]; noCapability?: boolean; deny?: boolean; workbench?: 'workspace'; wrongScope?: boolean }> = [
    { label: 'revoke has reason/revision without approval', method: revokeMethod, satisfied: ['reason', 'revision'], allowed: true, reason: 'AUTHZ_ALLOWED', missing: [] },
    { label: 'revoke still requires reason', method: revokeMethod, satisfied: ['revision'], allowed: false, reason: 'AUTHZ_OBLIGATION_REQUIRED', missing: ['reason'] },
    { label: 'revoke still requires revision', method: revokeMethod, satisfied: ['reason'], allowed: false, reason: 'AUTHZ_OBLIGATION_REQUIRED', missing: ['revision'] },
    { label: 'issue still requires approval', method: issueMethod, satisfied: ['reason', 'revision'], allowed: false, reason: 'AUTHZ_OBLIGATION_REQUIRED', missing: ['approval'] },
    { label: 'approved issue retains allow', method: issueMethod, satisfied: ['reason', 'revision', 'approval'], allowed: true, reason: 'AUTHZ_ALLOWED', missing: [] },
    { label: 'revoke still requires capability', method: revokeMethod, satisfied: ['reason', 'revision'], noCapability: true, allowed: false, reason: 'AUTHZ_CAPABILITY_MISSING' },
    { label: 'revoke retains explicit deny', method: revokeMethod, satisfied: ['reason', 'revision'], deny: true, allowed: false, reason: 'AUTHZ_EXPLICIT_DENY' },
    { label: 'revoke retains platform workbench', method: revokeMethod, satisfied: ['reason', 'revision'], workbench: 'workspace', allowed: false, reason: 'AUTHZ_WORKBENCH_MISMATCH' },
    { label: 'revoke retains platform scope', method: revokeMethod, satisfied: ['reason', 'revision'], wrongScope: true, allowed: false, reason: 'AUTHZ_SCOPE_MISMATCH' },
  ]
  for (const evaluator of ['decision', 'atoms'] as const) {
    it.each(cases)(`${evaluator}: $label`, row => {
      const policy = getMcpMethodPolicy(row.method)!
      const scope = row.wrongScope ? { type: 'workspace' as const, ids: ['ws_other'] } : { type: 'platform' as const, ids: ['*'] }
      const common = { decisionId: `jit-policy-${randomUUID()}`, policy, satisfiedObligations: row.satisfied, resourceScope: { type: 'platform' as const, id: '*' }, workbench: row.workbench ?? 'platform' as const, mode: 'enforce' as const }
      const atom: PermissionAtom = { capability: policy.capability, effect: 'allow', scope, source: 'platform_assignment', sourceId: 'isolated-admin-assignment', obligations: [], revision: '1' }
      const decision = evaluator === 'decision'
        ? evaluateAuthorizationDecision({ ...common, capabilities: row.noCapability ? [] : [policy.capability], scopes: [scope], explicitDenies: row.deny ? [policy.capability] : [] })
        : evaluatePermissionAtoms({ ...common, atoms: row.noCapability ? [] : [atom, ...(row.deny ? [{ ...atom, effect: 'deny' as const, source: 'explicit_deny' as const }] : [])] })
      expect(decision).toMatchObject({ allowed: row.allowed, authorized: row.allowed, enforced: true, reason_code: row.reason, policy_version: AUTHZ_POLICY_VERSION })
      if (row.missing) expect(decision.obligations.missing).toEqual(row.missing)
    })
  }
})
