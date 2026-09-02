import { describe, expect, it } from 'vitest'
import { recheckWorkerAuthorizationSnapshot, setAuthorizationRepositoryForTests } from './server.js'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/index.js'

describe('worker authorization recheck API', () => {
  it('rejects an exhausted grant from the authoritative Memory repository', async () => {
    const repository = new MemoryAuthorizationRepository()
    const now = new Date()
    const grant = await repository.issueGrant({
      grantKind: 'temporary', accessMode: 'write', subjectIdentityId: 'identity_authz_api', workspaceId: 'ws_authz_api',
      capabilities: ['customer.content.update'], resourceScope: { task_ids: ['task_authz_api'] },
      reason: 'execute approved task', ticketRef: 'AUTHZ-API-1', issuedBy: 'operator_a', approvedBy: 'security_a',
      approvedAt: now.toISOString(), expectedAuthorizationRevision: 0,
      expiresAt: new Date(now.getTime() + 60_000).toISOString(), maxUses: 1,
    })
    const snapshot = (revision: number, authorizationRevision: number) => ({
      schemaVersion: 1 as const, decisionId: `decision_${revision}`, actorId: 'operator_a', workspaceId: 'ws_authz_api',
      identityId: 'identity_authz_api',
      contextId: 'workspace:ws_authz_api', contextVersion: 'policy_context', policyVersion: 'policy_1',
      grantRevision: `grant:${grant.id}:${revision}:identity_authz_api:${authorizationRevision}`, scopeHash: grant.scopeHash,
      grantIds: [grant.id],
      capability: 'generation.execute' as const, resourceId: 'task_authz_api', authorized: true as const, decidedAt: now.toISOString(),
    })

    setAuthorizationRepositoryForTests(repository)
    try {
      await expect(recheckWorkerAuthorizationSnapshot(snapshot(1, 1), 'ws_authz_api', 'task_authz_api')).resolves.toMatchObject({ authorized: true })
      const consumed = await repository.consumeGrant({ id: grant.id, subjectIdentityId: 'identity_authz_api', workspaceId: 'ws_authz_api', capability: 'customer.content.update', scopeHash: grant.scopeHash, expectedRevision: 1, actorId: 'operator_a', reason: 'execute approved task' })
      expect(consumed).toMatchObject({ revision: 2, authorizationRevision: 2, useCount: 1, maxUses: 1 })
      const reserved = await recheckWorkerAuthorizationSnapshot(snapshot(2, 2), 'ws_authz_api', 'task_authz_api', { eventId: 'evt_authz_api' })
      expect(reserved).toMatchObject({ authorized: true, reservation_id: 'worker-execution:evt_authz_api:generation.execute', event_id: 'evt_authz_api' })
      await expect(recheckWorkerAuthorizationSnapshot(snapshot(2, 2), 'ws_authz_api', 'task_authz_api', { eventId: 'evt_authz_api' })).resolves.toMatchObject({ reservation_id: (reserved as { reservation_id: string }).reservation_id })
      await expect(recheckWorkerAuthorizationSnapshot({ ...snapshot(2, 2), decisionId: 'decision_conflict' }, 'ws_authz_api', 'task_authz_api', { eventId: 'evt_authz_api' })).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID', details: { event_id: 'evt_authz_api', reservation_id: 'worker-execution:evt_authz_api:generation.execute' } })
      await expect(recheckWorkerAuthorizationSnapshot({ ...snapshot(2, 2), grantIds: ['forged-grant'] }, 'ws_authz_api', 'task_authz_api')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_REVOKED' })
      await repository.revokeGrant({
        id: grant.id,
        subjectIdentityId: 'identity_authz_api',
        actorId: 'operator_a',
        reason: '撤销已入队的临时授权',
        expectedRevision: 2,
        expectedAuthorizationRevision: 2,
      })
      await expect(recheckWorkerAuthorizationSnapshot(snapshot(2, 2), 'ws_authz_api', 'task_authz_api')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_REVOKED' })
      await expect(recheckWorkerAuthorizationSnapshot({ ...snapshot(2, 2), identityId: 'other-identity' }, 'ws_authz_api', 'task_authz_api')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID' })
      await expect(recheckWorkerAuthorizationSnapshot(snapshot(2, 2), 'ws-other', 'task_authz_api')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID' })
      await expect(recheckWorkerAuthorizationSnapshot(snapshot(2, 2), 'ws_authz_api', 'task-other')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID' })
    } finally {
      setAuthorizationRepositoryForTests()
    }
  })
})
