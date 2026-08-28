import { describe, expect, it } from 'vitest'
import { MemoryIdentityLifecycleRepository } from './identity-lifecycle-repository.js'

const hash = 'a'.repeat(64)
const observed = { issuer: 'https://issuer.test', externalSubject: 'user-1', sessionHash: hash, kind: 'oidc' as const, issuedAt: '2026-08-28T00:00:00.000Z', expiresAt: '2026-08-29T00:00:00.000Z', observedAt: '2026-08-28T01:00:00.000Z', mfaVerified: false }

describe('MemoryIdentityLifecycleRepository', () => {
  it('resolves identities and never reactivates an explicitly revoked session', async () => {
    const repository = new MemoryIdentityLifecycleRepository()
    const first = await repository.observeAuthenticatedSession(observed)
    expect(await repository.resolve(observed)).toMatchObject({ id: first.identity.id, accessStatus: 'active' })
    const revoked = await repository.revokeSession({ identityId: first.identity.id, sessionId: first.session.id, expectedRevision: 1, actorId: 'ops-1', reason: 'lost device', idempotencyKey: 'revoke-1' })
    expect(revoked.session.status).toBe('revoked')
    expect((await repository.revokeSession({ identityId: first.identity.id, sessionId: first.session.id, expectedRevision: 1, actorId: 'ops-1', reason: 'lost device', idempotencyKey: 'revoke-1' })).replayed).toBe(true)
    const observedAgain = await repository.observeAuthenticatedSession({ ...observed, observedAt: '2026-08-28T02:00:00.000Z', mfaVerified: true })
    expect(observedAgain).toMatchObject({ allowed: false, denialReason: 'SESSION_REVOKED', session: { status: 'revoked', mfaVerified: true } })
  })

  it('atomically changes access and risk state, revokes sessions, and replays idempotently', async () => {
    const repository = new MemoryIdentityLifecycleRepository()
    const first = await repository.observeAuthenticatedSession(observed)
    const suspended = await repository.transitionAccess({ identityId: first.identity.id, target: 'suspended', expectedRevision: 1, actorId: 'ops-1', reason: 'security case', idempotencyKey: 'suspend-1' })
    expect(suspended).toMatchObject({ replayed: false, identity: { accessStatus: 'suspended', authEpoch: 2, revision: 2 }, revokedSessionIds: [first.session.id] })
    expect((await repository.transitionAccess({ identityId: first.identity.id, target: 'suspended', expectedRevision: 1, actorId: 'ops-1', reason: 'security case', idempotencyKey: 'suspend-1' })).replayed).toBe(true)
    const active = await repository.transitionAccess({ identityId: first.identity.id, target: 'active', expectedRevision: 2, actorId: 'ops-1', reason: 'case cleared', idempotencyKey: 'activate-1' })
    const risk = await repository.transitionRisk({ identityId: first.identity.id, level: 'critical', decision: 'block', expectedRevision: active.identity.revision, actorId: 'risk-engine', reason: 'credential abuse', evidence: { signal: 'impossible_travel' }, idempotencyKey: 'risk-1' })
    expect(risk.identity).toMatchObject({ riskLevel: 'critical', riskDecision: 'block', authEpoch: 3 })
    expect((await repository.detailForOperations(first.identity.id)).events.map(event => event.eventType)).toEqual(expect.arrayContaining(['identity.risk.transition', 'identity.active', 'identity.suspended']))
  })

  it('rejects stale revisions and idempotency key reuse with a different intent', async () => {
    const repository = new MemoryIdentityLifecycleRepository()
    const first = await repository.observeAuthenticatedSession(observed)
    await repository.transitionAccess({ identityId: first.identity.id, target: 'suspended', expectedRevision: 1, actorId: 'ops-1', reason: 'security case', idempotencyKey: 'same-key' })
    await expect(repository.transitionAccess({ identityId: first.identity.id, target: 'active', expectedRevision: 2, actorId: 'ops-1', reason: 'different intent', idempotencyKey: 'same-key' })).rejects.toMatchObject({ code: 'IDENTITY_IDEMPOTENCY_CONFLICT' })
    await expect(repository.transitionAccess({ identityId: first.identity.id, target: 'active', expectedRevision: 1, actorId: 'ops-1', reason: 'stale', idempotencyKey: 'stale-key' })).rejects.toMatchObject({ code: 'IDENTITY_REVISION_CONFLICT' })
  })
})
