import { describe, expect, it } from 'vitest'
import type { SqlClient, SqlPool } from './repository.js'
import { authorizationScopeHash, MemoryAuthorizationRepository, PostgresAuthorizationRepository } from './authorization-repository.js'

const subjectIdentityId = 'subject-consumed-grant'
const workspaceId = 'workspace-consumed-grant'
const capability = 'customer.content.update'
const scope = { task_ids: ['task-consumed-grant'] }
const at = '2026-09-01T10:00:00.000Z'

const issueInput = {
  grantKind: 'temporary' as const,
  accessMode: 'write' as const,
  subjectIdentityId,
  workspaceId,
  capabilities: [capability],
  resourceScope: scope,
  reason: 'execute an approved task',
  ticketRef: 'CONSUMED-GRANT-1',
  issuedBy: 'ops-lead',
  approvedBy: 'security-admin',
  approvedAt: at,
  expectedAuthorizationRevision: 0,
  expiresAt: '2026-09-01T10:05:00.000Z',
  maxUses: 1,
}

const reservationInput = (grant: { id: string; scopeHash: string; revision: number; authorizationRevision: number }) => ({
  reservationId: 'reservation-consumed-grant',
  eventId: 'event-consumed-grant',
  decisionId: 'decision-consumed-grant',
  subjectIdentityId,
  workspaceId,
  capability,
  resourceId: 'task-consumed-grant',
  scopeHash: grant.scopeHash,
  expectedAuthorizationRevision: grant.authorizationRevision,
  grantId: grant.id,
  expectedGrantRevision: grant.revision,
  at,
})

describe('authorization execution reservation and consumed grants', () => {
  it('rejects an issued but unconsumed grant', async () => {
    const repository = new MemoryAuthorizationRepository(() => new Date(at))
    const issued = await repository.issueGrant(issueInput)

    await expect(repository.reserveExecution(reservationInput(issued))).resolves.toBeUndefined()
  })

  it('accepts the enqueue-consumed maxUses=1 grant and replays idempotently', async () => {
    const repository = new MemoryAuthorizationRepository(() => new Date(at))
    const issued = await repository.issueGrant(issueInput)
    const consumed = await repository.consumeGrant({
      id: issued.id,
      subjectIdentityId,
      workspaceId,
      capability,
      scopeHash: authorizationScopeHash(scope),
      expectedRevision: issued.revision,
      actorId: 'worker-admission',
      reason: 'admit approved task to durable queue',
      at,
    })

    expect(consumed).toMatchObject({ useCount: 1, maxUses: 1, revision: 2 })
    const input = reservationInput(consumed!)
    await expect(repository.reserveExecution(input)).resolves.toMatchObject({
      reservationId: input.reservationId,
      eventId: input.eventId,
      grantRevision: consumed!.revision,
      authorizationRevision: consumed!.authorizationRevision,
    })
    await expect(repository.reserveExecution(input)).resolves.toMatchObject({ reservationId: input.reservationId })
  })

  it('accepts a consumed maxUses=1 grant in the PostgreSQL repository', async () => {
    const grantId = '00000000-0000-0000-0000-000000000901'
    const scopeHash = authorizationScopeHash(scope)
    const client: SqlClient = {
      async query<Row = Record<string, unknown>>(text: string): Promise<{ rows: Row[] }> {
        if (/^(BEGIN|COMMIT|ROLLBACK)/u.test(text) || text.includes("set_config('app.platform_scope'")) return { rows: [] as Row[] }
        if (text.includes('FROM authorization_execution_reservations')) return { rows: [] as Row[] }
        if (text.includes('FROM ops_access_grants') && text.includes('FOR UPDATE')) return {
          rows: [{ id: grantId, subjectIdentityId, workspaceId, capabilities: [capability], scopeHash, revokedAt: null, revision: 2, authorizationRevision: 2, useCount: 1, maxUses: 1, issuedAt: at, expiresAt: '2026-09-01T10:05:00.000Z' }] as Row[],
        }
        if (text.includes('FROM authorization_revisions')) return { rows: [{ revision: 2 }] as Row[] }
        if (text.startsWith('INSERT INTO authorization_execution_reservations')) return {
          rows: [{ reservationId: 'reservation-pg-consumed', eventId: 'event-pg-consumed', decisionId: 'decision-pg-consumed', subjectIdentityId, workspaceId, capability, resourceId: 'task-consumed-grant', scopeHash, grantId, authorizationRevision: 2, grantRevision: 2, reservedAt: at }] as Row[],
        }
        throw new Error(`unexpected SQL: ${text}`)
      },
      release() {},
    }
    const pool: SqlPool = { connect: async () => client }
    const repository = new PostgresAuthorizationRepository(pool, () => new Date(at))

    await expect(repository.reserveExecution({
      reservationId: 'reservation-pg-consumed',
      eventId: 'event-pg-consumed',
      decisionId: 'decision-pg-consumed',
      subjectIdentityId,
      workspaceId,
      capability,
      resourceId: 'task-consumed-grant',
      scopeHash,
      expectedAuthorizationRevision: 2,
      grantId,
      expectedGrantRevision: 2,
      at,
    })).resolves.toMatchObject({ grantRevision: 2, authorizationRevision: 2 })
  })
})
