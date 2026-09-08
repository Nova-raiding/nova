import { describe, expect, it } from 'vitest'
import { PostgresServiceFulfillmentRepository, ServiceFulfillmentRepositoryError, assertServiceFulfillmentPeriod } from './service-fulfillment-repository.js'
import type { SqlClient, SqlPool, SqlQueryResult } from './repository.js'

class Client implements SqlClient {
  async query<Row>(sql: string): Promise<SqlQueryResult<Row>> {
    if (sql.includes('SELECT id,workspace_id,onboarding_order_id')) return { rows: [{ id: 'schedule-1', workspace_id: 'ws-1', onboarding_order_id: 'order-1', entitlement_snapshot_id: 'snapshot-1', sequence: 1, points: 500, due_at: '2026-01-31T23:00:00.000Z', expires_at: '2026-02-28T23:00:00.000Z', status: 'granted', blockers: [], source_checksum: 'a'.repeat(64), created_by_actor_id: 'actor-1', creation_reason: 'verified payment', creation_evidence: { payment: 'event-1' }, created_at: '2026-01-31T23:00:00.000Z' }] } as SqlQueryResult<Row>
    return { rows: [] } as SqlQueryResult<Row>
  }
  release() {}
}

describe('PostgresServiceFulfillmentRepository activated schedule projection', () => {
  it('returns due/expiry and activated status instead of converting it back to unresolved', async () => {
    const repository = new PostgresServiceFulfillmentRepository({ connect: async () => new Client() } satisfies SqlPool)
    await expect(repository.listOnboardingGrantSchedule('ws-1', 'order-1')).resolves.toMatchObject([{
      sequence: 1, points: 500, dueAt: '2026-01-31T23:00:00.000Z', expiresAt: '2026-02-28T23:00:00.000Z', status: 'granted', blockers: [],
    }])
  })
})

describe('service fulfillment entitlement period boundary', () => {
  const base = {
    type: 'scheduled' as const,
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-10-01T00:00:00.000Z',
    nowMs: Date.parse('2026-09-08T00:00:00.000Z'),
  }

  it('accepts an appointment inside the active period', () => {
    expect(() => assertServiceFulfillmentPeriod({ ...base, scheduleAt: '2026-09-30T23:59:59.999Z' })).not.toThrow()
  })

  it('rejects the exclusive period end and an already expired period', () => {
    expect(() => assertServiceFulfillmentPeriod({ ...base, scheduleAt: '2026-10-01T00:00:00.000Z' })).toThrowError(ServiceFulfillmentRepositoryError)
    expect(() => assertServiceFulfillmentPeriod({ ...base, scheduleAt: '2026-09-08T01:00:00.000Z', nowMs: Date.parse('2026-10-01T00:00:00.000Z') })).toThrowError(ServiceFulfillmentRepositoryError)
  })
})
