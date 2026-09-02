import { describe, expect, it } from 'vitest'
import type { SqlClient, SqlPool } from './repository.js'
import { authorizationScopeHash, AuthorizationRepositoryError, PostgresAuthorizationRepository } from './authorization-repository.js'

const subject = '00000000-0000-0000-0000-000000000120'
const grantId = '00000000-0000-0000-0000-000000000121'
const scopeHash = authorizationScopeHash({ task_ids: ['task-120'] })
const now = '2026-09-01T10:00:00.000Z'

class ReservationClient implements SqlClient {
  readonly queries: string[] = []
  private insertCount = 0
  private reservationExists = false
  private readonly grantScopeHash: string
  constructor(private readonly revision = 2, private readonly resourceScope: Record<string, unknown> = { task_ids: ['task-120'] }) {
    this.grantScopeHash = authorizationScopeHash(resourceScope)
  }
  private get row() {
    return {
      reservationId: 'reservation-120', eventId: 'event-120', decisionId: 'decision-120', subjectIdentityId: subject,
      workspaceId: 'ws-a', capability: 'customer.content.update', resourceId: 'task-120',
      scopeHash: this.grantScopeHash, grantId, authorizationRevision: 2, grantRevision: 2, reservedAt: now,
    }
  }

  async query<Row = Record<string, unknown>>(text: string): Promise<{ rows: Row[] }> {
    this.queries.push(text)
    if (text === 'SELECT set_config(\'app.platform_scope\', \'platform_ops\', true)' || /^(BEGIN|COMMIT|ROLLBACK)/u.test(text)) return { rows: [] as Row[] }
    if (text.includes('FROM ops_access_grants') && text.includes('FOR UPDATE')) return {
      rows: [{ id: grantId, grantKind: 'temporary', accessMode: 'write', subjectIdentityId: subject, workspaceId: 'ws-a', capabilities: ['customer.content.update'], resourceScope: this.resourceScope, scopeHash: this.grantScopeHash, reason: 'execute task', ticketRef: 'CAS-120', issuedBy: 'ops', approvedBy: 'security', approvedAt: now, issuedAt: now, expiresAt: '2026-09-01T10:05:00.000Z', revokedAt: null, revokedBy: null, revocationReason: null, maxUses: 1, useCount: 1, revision: 2, authorizationRevision: 2, createdAt: now, updatedAt: now }] as Row[],
    }
    if (text.includes('FROM authorization_revisions')) return { rows: [{ revision: this.revision }] as Row[] }
    if (text.startsWith('INSERT INTO authorization_execution_reservations')) {
      this.insertCount += 1
      if (this.insertCount === 1) this.reservationExists = true
      return { rows: (this.insertCount === 1 ? [this.row] : []) as Row[] }
    }
    if (text.includes('FROM authorization_execution_reservations')) return { rows: (this.reservationExists ? [this.row] : []) as Row[] }
    throw new Error(`unexpected SQL: ${text}`)
  }
}

describe('PostgresAuthorizationRepository.reserveExecution', () => {
  it('persists an authorization-bound reservation and replays it idempotently', async () => {
    const client = new ReservationClient()
    const pool: SqlPool = { connect: async () => client }
    const repository = new PostgresAuthorizationRepository(pool, () => new Date(now))
    const input = { reservationId: 'reservation-120', eventId: 'event-120', decisionId: 'decision-120', subjectIdentityId: subject, workspaceId: 'ws-a', capability: 'customer.content.update', resourceId: 'task-120', scopeHash, expectedAuthorizationRevision: 2, grantId, expectedGrantRevision: 2, at: now }

    await expect(repository.reserveExecution(input)).resolves.toMatchObject({ reservationId: input.reservationId, eventId: input.eventId, grantRevision: 2, authorizationRevision: 2, reservedAt: now })
    await expect(repository.reserveExecution(input)).resolves.toMatchObject({ reservationId: input.reservationId, eventId: input.eventId })
    expect(client.queries.findIndex(query => query.includes('FROM ops_access_grants') && query.includes('FOR UPDATE'))).toBeLessThan(client.queries.findIndex(query => query.includes('FROM authorization_revisions') && query.includes('FOR UPDATE')))
    expect(client.queries.filter(query => query.startsWith('INSERT INTO authorization_execution_reservations')).length).toBe(1)
  })

  it('fails closed when the subject revision is stale and never inserts', async () => {
    const client = new ReservationClient(2)
    const repository = new PostgresAuthorizationRepository({ connect: async () => client }, () => new Date(now))
    await expect(repository.reserveExecution({ reservationId: 'reservation-stale', eventId: 'event-stale', decisionId: 'decision-stale', subjectIdentityId: subject, workspaceId: 'ws-a', capability: 'customer.content.update', resourceId: 'task-120', scopeHash, expectedAuthorizationRevision: 1, grantId, expectedGrantRevision: 1, at: now })).resolves.toBeUndefined()
    expect(client.queries.some(query => query.startsWith('INSERT INTO authorization_execution_reservations'))).toBe(false)
  })

  it('fails closed when a persisted grant contains a union resource scope', async () => {
    const client = new ReservationClient(2, { task_ids: ['task-120'], workspace_ids: ['ws-a'] })
    const repository = new PostgresAuthorizationRepository({ connect: async () => client }, () => new Date(now))
    await expect(repository.reserveExecution({ reservationId: 'reservation-union', eventId: 'event-union', decisionId: 'decision-union', subjectIdentityId: subject, workspaceId: 'ws-a', capability: 'customer.content.update', resourceId: 'task-120', scopeHash, expectedAuthorizationRevision: 2, grantId, expectedGrantRevision: 2, at: now })).resolves.toBeUndefined()
    expect(client.queries.some(query => query.startsWith('INSERT INTO authorization_execution_reservations'))).toBe(false)
  })

  it.each([
    ['workspace', { task_ids: ['task-120'] }, 'ws-b', 'task-120'],
    ['brand', { brand_ids: ['brand-a'] }, 'ws-a', 'brand-b'],
    ['account', { account_ids: ['account-a'] }, 'ws-a', 'account-b'],
  ] as const)('rejects a cross-tenant %s resource before inserting a reservation', (_scopeType, resourceScope, workspaceId, resourceId) => {
    const client = new ReservationClient(2, resourceScope)
    const repository = new PostgresAuthorizationRepository({ connect: async () => client }, () => new Date(now))
    const inputScopeHash = authorizationScopeHash(resourceScope)

    return expect(repository.reserveExecution({
      reservationId: `reservation-cross-${_scopeType}`,
      eventId: `event-cross-${_scopeType}`,
      decisionId: `decision-cross-${_scopeType}`,
      subjectIdentityId: subject,
      workspaceId,
      capability: 'customer.content.update',
      resourceId,
      scopeHash: inputScopeHash,
      expectedAuthorizationRevision: 2,
      grantId,
      expectedGrantRevision: 2,
      at: now,
    })).resolves.toBeUndefined().then(() => {
      expect(client.queries.some(query => query.startsWith('INSERT INTO authorization_execution_reservations'))).toBe(false)
    })
  })

  it('rejects invalid reservation identity before opening a transaction', async () => {
    const connect = async () => { throw new Error('must not connect') }
    const repository = new PostgresAuthorizationRepository({ connect }, () => new Date(now))
    await expect(repository.reserveExecution({ reservationId: ' ', eventId: 'event', decisionId: 'decision', subjectIdentityId: subject, workspaceId: 'ws-a', capability: 'cap', resourceId: 'task', scopeHash, expectedAuthorizationRevision: 0 })).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' } satisfies Partial<AuthorizationRepositoryError>)
  })

  it('rejects an invalid decision identity before opening a transaction', async () => {
    const connect = async () => { throw new Error('must not connect') }
    const repository = new PostgresAuthorizationRepository({ connect }, () => new Date(now))
    await expect(repository.reserveExecution({ reservationId: 'reservation', eventId: 'event', decisionId: 'decision\ninvalid', subjectIdentityId: subject, workspaceId: 'ws-a', capability: 'cap', resourceId: 'task', scopeHash, expectedAuthorizationRevision: 0 })).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' } satisfies Partial<AuthorizationRepositoryError>)
  })

  it('rejects malformed read identities before opening a transaction', async () => {
    const connect = async () => { throw new Error('must not connect') }
    const repository = new PostgresAuthorizationRepository({ connect }, () => new Date(now))
    await expect(repository.getGrant(' ', subject)).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' } satisfies Partial<AuthorizationRepositoryError>)
    await expect(repository.listActivePlatformRoles(subject, 'invalid-time')).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' } satisfies Partial<AuthorizationRepositoryError>)
    await expect(repository.listActiveGrants(subject, ' ', now)).rejects.toMatchObject({ code: 'AUTHORIZATION_GRANT_INVALID' } satisfies Partial<AuthorizationRepositoryError>)
  })
})
