import { beforeEach, describe, expect, it } from 'vitest'
import { authorizationScopeHash, AuthorizationRepositoryError, MemoryAuthorizationRepository } from './authorization-repository.js'

const subject = '00000000-0000-0000-0000-000000000105'
const start = Date.parse('2026-08-31T10:00:00.000Z')
const clock = { now: start }
const repository = () => new MemoryAuthorizationRepository(() => new Date(clock.now))

describe('durable authorization repository', () => {
  beforeEach(() => { clock.now = start })
  it('keeps platform roles separate and increments the subject revision on assignment and revoke', async () => {
    const repo = repository()
    const assignment = await repo.assignPlatformRole({ subjectIdentityId: subject, role: 'support_agent', assignedBy: 'security-admin', reason: 'approved support duty', expectedAuthorizationRevision: 0 })
    expect(assignment).toMatchObject({ role: 'support_agent', revision: 1, authorizationRevision: 1 })
    expect(await repo.listActivePlatformRoles(subject)).toHaveLength(1)
    await expect(repo.assignPlatformRole({ subjectIdentityId: subject, role: 'ops_admin', assignedBy: 'security-admin', reason: 'stale operator view', expectedAuthorizationRevision: 0 })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVISION_CONFLICT' })

    const revoked = await repo.revokePlatformRole({ id: assignment.id, subjectIdentityId: subject, actorId: 'security-admin', reason: 'support rotation ended', expectedRevision: 1, expectedAuthorizationRevision: 1 })
    expect(revoked).toMatchObject({ revision: 2, authorizationRevision: 2, revokedBy: 'security-admin' })
    expect(await repo.listActivePlatformRoles(subject)).toEqual([])
    expect(await repo.getAuthorizationRevision(subject)).toBe(2)
  })

  it('issues an exact-scope grant, atomically consumes its use budget, and rejects replay', async () => {
    const repo = repository()
    const resourceScope = { resource_type: 'support_ticket', resource_ids: ['ticket-7'] }
    const grant = await repo.issueGrant({ grantKind: 'support', accessMode: 'read', subjectIdentityId: subject, workspaceId: 'ws-a', capabilities: ['customer.content.read'], resourceScope, reason: 'investigate customer ticket', ticketRef: 'SUP-7', issuedBy: 'support-lead', approvedBy: 'security-admin', approvedAt: new Date(start).toISOString(), expectedAuthorizationRevision: 0, expiresAt: new Date(start + 15 * 60_000).toISOString(), maxUses: 1 })
    expect(grant).toMatchObject({ scopeHash: authorizationScopeHash(resourceScope), revision: 1, authorizationRevision: 1, useCount: 0 })
    expect(await repo.listActiveGrants(subject, 'ws-a')).toHaveLength(1)

    const consumed = await repo.consumeGrant({ id: grant.id, subjectIdentityId: subject, workspaceId: 'ws-a', capability: 'customer.content.read', scopeHash: grant.scopeHash, expectedRevision: 1, actorId: 'support-user', reason: 'open approved ticket' })
    expect(consumed).toMatchObject({ useCount: 1, revision: 2, authorizationRevision: 2 })
    await expect(repo.getGrant(grant.id, subject)).resolves.toMatchObject({ id: grant.id, useCount: 1, revision: 2 })
    await expect(repo.getGrant(grant.id, 'different-subject')).resolves.toBeUndefined()
    await expect(repo.consumeGrant({ id: grant.id, subjectIdentityId: subject, workspaceId: 'ws-a', capability: 'customer.content.read', scopeHash: grant.scopeHash, expectedRevision: 1, actorId: 'support-user', reason: 'replay approved ticket' })).resolves.toBeUndefined()
    expect(await repo.listActiveGrants(subject, 'ws-a')).toEqual([])
  })

  it('fails closed for workspace, capability, scope, expiry, and stale grant revision mismatches', async () => {
    const repo = repository()
    const grant = await repo.issueGrant({ grantKind: 'temporary', accessMode: 'read', subjectIdentityId: subject, workspaceId: 'ws-a', capabilities: ['customer.content.read'], resourceScope: { product_ids: ['p-1'] }, reason: 'investigate product issue', ticketRef: 'OPS-8', issuedBy: 'ops-lead', approvedBy: 'security-admin', approvedAt: new Date(start).toISOString(), expectedAuthorizationRevision: 0, expiresAt: new Date(start + 60_000).toISOString(), maxUses: 3 })
    const base = { id: grant.id, subjectIdentityId: subject, workspaceId: 'ws-a', capability: 'customer.content.read', scopeHash: grant.scopeHash, expectedRevision: 1, actorId: 'ops-user', reason: 'inspect approved resource' }
    await expect(repo.consumeGrant({ ...base, workspaceId: 'ws-b' })).resolves.toBeUndefined()
    await expect(repo.consumeGrant({ ...base, capability: 'customer.content.update' })).resolves.toBeUndefined()
    await expect(repo.consumeGrant({ ...base, scopeHash: '0'.repeat(64) })).resolves.toBeUndefined()
    await expect(repo.consumeGrant({ ...base, expectedRevision: 2 })).resolves.toBeUndefined()
    clock.now = start + 60_000
    await expect(repo.consumeGrant(base)).resolves.toBeUndefined()
  })

  it('enforces TTL, bounded use count, and two-person approval before persistence', async () => {
    const repo = repository()
    const issue = (patch: Record<string, unknown> = {}) => repo.issueGrant({ grantKind: 'temporary', accessMode: 'write', subjectIdentityId: subject, workspaceId: 'ws-a', capabilities: ['customer.content.update'], resourceScope: { product_ids: ['p-1'] }, reason: 'repair customer content', ticketRef: 'OPS-9', issuedBy: 'ops-lead', approvedBy: 'security-admin', approvedAt: new Date(start).toISOString(), expectedAuthorizationRevision: 0, expiresAt: new Date(start + 5 * 60_000).toISOString(), maxUses: 1, ...patch })
    await expect(issue({ approvedBy: 'ops-lead' })).rejects.toBeInstanceOf(AuthorizationRepositoryError)
    await expect(issue({ expiresAt: new Date(start + 5 * 60_000 + 1).toISOString() })).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' })
    await expect(issue({ maxUses: 101 })).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' })
    expect(await repo.getAuthorizationRevision(subject)).toBe(0)
  })

  it('rejects capabilities with whitespace or control characters before advancing authorization state', async () => {
    const repo = repository()
    const issue = (capability: string) => repo.issueGrant({ grantKind: 'temporary', accessMode: 'read', subjectIdentityId: subject, workspaceId: 'ws-a', capabilities: [capability], resourceScope: { product_ids: ['p-capability'] }, reason: 'inspect capability boundary', ticketRef: `CAP-${capability.length}-${Date.now()}`, issuedBy: 'ops-lead', approvedBy: 'security-admin', approvedAt: new Date(start).toISOString(), expectedAuthorizationRevision: 0, expiresAt: new Date(start + 60_000).toISOString(), maxUses: 1 })

    await expect(issue(' customer.content.read')).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' })
    await expect(issue('customer.content.read\n')).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' })
    expect(await repo.getAuthorizationRevision(subject)).toBe(0)
  })

  it('fails closed on malformed read identities and timestamps', async () => {
    const repo = repository()
    await expect(repo.getGrant(' ', subject)).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' })
    await expect(repo.getGrant('grant-id', 'subject\nunsafe')).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' })
    await expect(repo.listActivePlatformRoles(subject, 'not-a-timestamp')).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' })
    await expect(repo.listActiveGrants(subject, ' ', new Date(start).toISOString())).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' })
  })

  it('rejects ambiguous or unsafe resource scopes before advancing authorization state', async () => {
    const repo = repository()
    const issue = (resourceScope: Record<string, unknown>, ticketRef: string) => repo.issueGrant({
      ...{
        grantKind: 'temporary' as const,
        accessMode: 'read' as const,
        subjectIdentityId: subject,
        workspaceId: 'ws-a',
        capabilities: ['customer.content.read'],
        resourceScope,
        reason: 'inspect a scoped resource',
        ticketRef,
        issuedBy: 'ops-lead',
        approvedBy: 'security-admin',
        approvedAt: new Date(start).toISOString(),
        expectedAuthorizationRevision: 0,
        expiresAt: new Date(start + 60_000).toISOString(),
        maxUses: 1,
      },
    })

    await expect(issue({ product_ids: ['product-a'], task_ids: ['task-a'] }, 'SCOPE-AMBIGUOUS')).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' })
    await expect(issue({ product_ids: ['*'] }, 'SCOPE-WILDCARD')).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' })
    await expect(issue({ product_ids: ['product-a'], metadata: { sensitive: true } }, 'SCOPE-NESTED')).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' })
    await expect(issue({ product_ids: ['product-\nunsafe'] }, 'SCOPE-CONTROL')).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' })
    expect(await repo.getAuthorizationRevision(subject)).toBe(0)
  })

  it('revokes immediately and invalidates the observed authorization revision', async () => {
    const repo = repository()
    const grant = await repo.issueGrant({ grantKind: 'temporary', accessMode: 'read', subjectIdentityId: subject, workspaceId: 'ws-a', capabilities: ['customer.content.read'], resourceScope: { task_ids: ['t-1'] }, reason: 'inspect failed generation', ticketRef: 'OPS-10', issuedBy: 'ops-lead', approvedBy: 'security-admin', approvedAt: new Date(start).toISOString(), expectedAuthorizationRevision: 0, expiresAt: new Date(start + 60_000).toISOString(), maxUses: 2 })
    const revoked = await repo.revokeGrant({ id: grant.id, subjectIdentityId: subject, actorId: 'security-admin', reason: 'customer withdrew consent', expectedRevision: 1, expectedAuthorizationRevision: 1 })
    expect(revoked).toMatchObject({ revokedBy: 'security-admin', revision: 2, authorizationRevision: 2 })
    expect(await repo.listActiveGrants(subject, 'ws-a')).toEqual([])
    await expect(repo.getGrant(grant.id, subject)).resolves.toMatchObject({ id: grant.id, revokedBy: 'security-admin', revision: 2, authorizationRevision: 2 })
    await expect(repo.revokeGrant({ id: grant.id, subjectIdentityId: subject, actorId: 'security-admin', reason: 'repeat revoke rejected', expectedRevision: 2, expectedAuthorizationRevision: 2 })).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_NOT_FOUND' })
  })

  it('rejects a stale grant revoke without partially changing the grant lifecycle', async () => {
    const repo = repository()
    const grant = await repo.issueGrant({ grantKind: 'temporary', accessMode: 'read', subjectIdentityId: subject, workspaceId: 'ws-a', capabilities: ['customer.content.read'], resourceScope: { task_ids: ['t-stale-revoke'] }, reason: 'inspect a failed task', ticketRef: 'OPS-STALE-REVOKE', issuedBy: 'ops-lead', approvedBy: 'security-admin', approvedAt: new Date(start).toISOString(), expectedAuthorizationRevision: 0, expiresAt: new Date(start + 60_000).toISOString(), maxUses: 1 })

    await expect(repo.revokeGrant({ id: grant.id, subjectIdentityId: subject, actorId: 'security-admin', reason: 'stale revoke attempt', expectedRevision: grant.revision, expectedAuthorizationRevision: 99 })).rejects.toMatchObject({ code: 'AUTHORIZATION_REVISION_CONFLICT' })

    await expect(repo.getGrant(grant.id, subject)).resolves.toMatchObject({ id: grant.id, revision: 1, authorizationRevision: 1 })
    await expect(repo.listActiveGrants(subject, 'ws-a')).resolves.toHaveLength(1)
    await expect(repo.revokeGrant({ id: grant.id, subjectIdentityId: subject, actorId: 'security-admin', reason: 'current revoke', expectedRevision: grant.revision, expectedAuthorizationRevision: 1 })).resolves.toMatchObject({ revokedBy: 'security-admin', revision: 2, authorizationRevision: 2 })
  })

  it('atomically reserves a grant execution and rejects a reservation after revoke', async () => {
    const repo = repository()
    const grant = await repo.issueGrant({ grantKind: 'temporary', accessMode: 'write', subjectIdentityId: subject, workspaceId: 'ws-a', capabilities: ['customer.content.update'], resourceScope: { task_ids: ['task-cas'] }, reason: 'execute approved task', ticketRef: 'CAS-1', issuedBy: 'ops-lead', approvedBy: 'security-admin', approvedAt: new Date(start).toISOString(), expectedAuthorizationRevision: 0, expiresAt: new Date(start + 60_000).toISOString(), maxUses: 1 })
    const consumed = await repo.consumeGrant({ id: grant.id, subjectIdentityId: subject, workspaceId: 'ws-a', capability: 'customer.content.update', scopeHash: grant.scopeHash, expectedRevision: grant.revision, actorId: 'ops-lead', reason: 'admit approved task' })
    const input = { reservationId: 'reservation-cas-1', eventId: 'event-cas-1', decisionId: 'decision-cas-1', subjectIdentityId: subject, workspaceId: 'ws-a', capability: 'customer.content.update', resourceId: 'task-cas', scopeHash: grant.scopeHash, expectedAuthorizationRevision: consumed!.authorizationRevision, grantId: grant.id, expectedGrantRevision: consumed!.revision }
    await expect(repo.reserveExecution(input)).resolves.toMatchObject({ reservationId: input.reservationId, grantRevision: consumed!.revision, authorizationRevision: consumed!.authorizationRevision })
    await expect(repo.reserveExecution(input)).resolves.toMatchObject({ reservationId: input.reservationId })
    await repo.revokeGrant({ id: grant.id, subjectIdentityId: subject, actorId: 'security-admin', reason: 'revoke after reservation', expectedRevision: consumed!.revision, expectedAuthorizationRevision: consumed!.authorizationRevision })
    await expect(repo.reserveExecution({ ...input, reservationId: 'reservation-cas-2', eventId: 'event-cas-2' })).resolves.toBeUndefined()
  })

  it.each([
    ['workspace', { workspace_ids: ['ws-a'] }, 'ws-b'],
    ['brand', { brand_ids: ['brand-a'] }, 'brand-b'],
    ['account', { account_ids: ['account-a'] }, 'account-b'],
  ] as const)('rejects a consumed grant reservation for a different %s resource ID', async (_scopeKind, resourceScope, foreignResourceId) => {
    const repo = repository()
    const grant = await repo.issueGrant({ grantKind: 'temporary', accessMode: 'write', subjectIdentityId: subject, workspaceId: 'ws-a', capabilities: ['customer.content.update'], resourceScope, reason: 'execute scoped operation', ticketRef: `SCOPE-${_scopeKind}`, issuedBy: 'ops-lead', approvedBy: 'security-admin', approvedAt: new Date(start).toISOString(), expectedAuthorizationRevision: 0, expiresAt: new Date(start + 60_000).toISOString(), maxUses: 1 })
    const consumed = await repo.consumeGrant({ id: grant.id, subjectIdentityId: subject, workspaceId: 'ws-a', capability: 'customer.content.update', scopeHash: grant.scopeHash, expectedRevision: grant.revision, actorId: 'ops-lead', reason: 'admit scoped operation' })
    const input = { reservationId: `reservation-${_scopeKind}-foreign`, eventId: `event-${_scopeKind}-foreign`, decisionId: `decision-${_scopeKind}-foreign`, subjectIdentityId: subject, workspaceId: 'ws-a', capability: 'customer.content.update', resourceId: foreignResourceId, scopeHash: grant.scopeHash, expectedAuthorizationRevision: consumed!.authorizationRevision, grantId: grant.id, expectedGrantRevision: consumed!.revision }

    await expect(repo.reserveExecution(input)).resolves.toBeUndefined()
    const validResourceId = (Object.values(resourceScope)[0] as readonly string[])[0]!
    await expect(repo.reserveExecution({ ...input, reservationId: `reservation-${_scopeKind}-valid`, eventId: `event-${_scopeKind}-valid`, resourceId: validResourceId })).resolves.toMatchObject({ grantRevision: consumed!.revision })
  })

  it('makes revoke win when it advances the authorization revision before reservation', async () => {
    const repo = repository()
    const grant = await repo.issueGrant({ grantKind: 'temporary', accessMode: 'write', subjectIdentityId: subject, workspaceId: 'ws-a', capabilities: ['customer.content.update'], resourceScope: { task_ids: ['task-cas-2'] }, reason: 'execute approved task', ticketRef: 'CAS-2', issuedBy: 'ops-lead', approvedBy: 'security-admin', approvedAt: new Date(start).toISOString(), expectedAuthorizationRevision: 0, expiresAt: new Date(start + 60_000).toISOString(), maxUses: 1 })
    await repo.revokeGrant({ id: grant.id, subjectIdentityId: subject, actorId: 'security-admin', reason: 'revoke before reservation', expectedRevision: grant.revision, expectedAuthorizationRevision: grant.authorizationRevision })
    await expect(repo.reserveExecution({ reservationId: 'reservation-cas-3', eventId: 'event-cas-3', decisionId: 'decision-cas-3', subjectIdentityId: subject, workspaceId: 'ws-a', capability: 'customer.content.update', resourceId: 'task-cas-2', scopeHash: grant.scopeHash, expectedAuthorizationRevision: 1, grantId: grant.id, expectedGrantRevision: 1 })).resolves.toBeUndefined()
  })
})
