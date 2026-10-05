import { describe, expect, it } from 'vitest'
import { PostgresCreativePointRepository } from './creative-point-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

const reservation = { id: 'reservation_failed_image', workspaceId: 'ws_failed_image', operationId: 'operation_original', actionKey: 'image:job_1', rateCardVersion: 'image-v1', points: 3, status: 'active', settledPoints: null, createdAt: '2026-09-29T00:00:00.000Z', finalizedAt: null }
const input = { workspaceId: reservation.workspaceId, reservationId: reservation.id, actionKey: reservation.actionKey, providerRequestId: 'provider_failed_1', idempotencyKey: 'reconcile-release-1', at: '2026-09-29T01:00:00.000Z' }

function adapter(receiptRows: Array<{ outcome: string }>, successful: boolean) {
  const queries: Array<{ sql: string; params: readonly unknown[] }> = []
  const client: SqlClient = { query: async <Row>(sql: string, params: readonly unknown[] = []) => {
    queries.push({ sql, params })
    const rows = sql.includes('SELECT operation_id AS "operationId"') ? [{ operationId: reservation.operationId }]
      : sql.startsWith('SELECT result, request=') ? []
        : sql.includes('FROM creative_point_reservations') && sql.includes('FOR UPDATE') ? [reservation]
        : sql.startsWith('SELECT id FROM creative_point_operations') ? [{ id: reservation.operationId }]
        : sql.startsWith('SELECT outcome FROM creative_point_provider_receipts_v2') ? receiptRows
          : sql.startsWith('SELECT EXISTS (SELECT 1 FROM creative_point_provider_receipts_v2') ? [{ matched: successful }]
            : []
    return { rows: rows as Row[] }
  }, release: () => undefined }
  const pool: SqlPool = { connect: async () => client }
  return { repository: new PostgresCreativePointRepository(pool), queries }
}

describe('atomic failed-provider reservation release', () => {
  it('replays a completed release for the same source event after the reservation is already released', async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = []
    const released = { ...reservation, status: 'released', finalizedAt: input.at }
    const client: SqlClient = { query: async <Row>(sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      const rows = sql.includes('SELECT operation_id AS "operationId"') ? [{ operationId: reservation.operationId }]
        : sql.startsWith('SELECT id FROM creative_point_operations') ? [{ id: reservation.operationId }]
          : sql.startsWith('SELECT result, request=') ? [{ result: { entity_id: reservation.id }, requestMatches: JSON.parse(String(params[3])).source_event_id === 'event_preprovider_1' }]
            : sql.includes('FROM creative_point_reservations WHERE workspace_id=$1 AND id=$2') ? [released]
              : sql.startsWith('SELECT EXISTS(SELECT 1 FROM creative_point_grants') ? [{ known: true, available: '10', reserved: '0', settled: '0' }]
                : sql.startsWith('SELECT revision, updated_at') ? [{ revision: 2, updatedAt: input.at }]
                  : sql.startsWith('SELECT pg_catalog.to_regclass') ? [{ present: true }]
                  : []
      return { rows: rows as Row[] }
    }, release: () => undefined }
    const repository = new PostgresCreativePointRepository({ connect: async () => client })

    await expect(repository.releaseFailedProviderReservation({ ...input, providerRequestId: undefined, preProvider: true, sourceEventId: 'event_preprovider_1' }))
      .resolves.toMatchObject({ value: { id: reservation.id, status: 'released' }, balance: { availablePoints: 10, reservedPoints: 0 } })
    expect(queries.some(query => query.sql.includes('creative_point_provider_receipts_v2'))).toBe(false)
    expect(queries.some(query => query.sql.includes('FROM creative_point_reservations') && query.sql.includes('FOR UPDATE'))).toBe(false)
    expect(queries.at(-1)?.sql).toBe('COMMIT')
  })

  it('rejects replay when the same idempotency key is presented with a different source event', async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = []
    const client: SqlClient = { query: async <Row>(sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      const rows = sql.includes('SELECT operation_id AS "operationId"') ? [{ operationId: reservation.operationId }]
        : sql.startsWith('SELECT id FROM creative_point_operations') ? [{ id: reservation.operationId }]
          : sql.startsWith('SELECT result, request=') ? [{ result: { entity_id: reservation.id }, requestMatches: false }]
            : []
      return { rows: rows as Row[] }
    }, release: () => undefined }
    const repository = new PostgresCreativePointRepository({ connect: async () => client })

    await expect(repository.releaseFailedProviderReservation({ ...input, providerRequestId: undefined, preProvider: true, sourceEventId: 'different_event' }))
      .rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
    expect(queries.some(query => query.sql.includes('FROM creative_point_reservations') && query.sql.includes('FOR UPDATE'))).toBe(false)
    expect(queries.at(-1)?.sql).toBe('ROLLBACK')
  })

  it('rolls back a pre-provider release when any receipt already exists for the locked operation', async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = []
    const client: SqlClient = { query: async <Row>(sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      const rows = sql.includes('SELECT operation_id AS "operationId"') ? [{ operationId: reservation.operationId }]
        : sql.startsWith('SELECT id FROM creative_point_operations') ? [{ id: reservation.operationId }]
          : sql.startsWith('SELECT result, request=') ? []
            : sql.includes('FROM creative_point_reservations') && sql.includes('FOR UPDATE') ? [reservation]
              : sql.startsWith('SELECT count(*) AS count FROM creative_point_provider_receipts_v2') ? [{ count: '1' }]
                : []
      return { rows: rows as Row[] }
    }, release: () => undefined }
    const repository = new PostgresCreativePointRepository({ connect: async () => client })
    await expect(repository.releaseFailedProviderReservation({ ...input, providerRequestId: undefined, preProvider: true })).rejects.toMatchObject({ code: 'CREATIVE_POINT_BALANCE_UNKNOWN' })
    expect(queries.find(query => query.sql.startsWith('SELECT id FROM creative_point_operations'))?.sql).toContain('FOR UPDATE')
    expect(queries.some(query => query.sql.startsWith("UPDATE creative_point_reservations SET status='released'"))).toBe(false)
    expect(queries.at(-1)?.sql).toBe('ROLLBACK')
  })

  it('locks failed receipt and reservation, then releases them in the same workspace transaction', async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = []
    let balanceReads = 0
    const client: SqlClient = { query: async <Row>(sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      let rows: unknown[] = []
      if (sql.includes('SELECT operation_id AS "operationId"')) rows = [{ operationId: reservation.operationId }]
      else if (sql.startsWith('SELECT result, request=')) rows = []
      else if (sql.includes('FROM creative_point_reservations') && sql.includes('FOR UPDATE')) rows = [reservation]
      else if (sql.startsWith('SELECT id FROM creative_point_operations')) rows = [{ id: reservation.operationId }]
      else if (sql.startsWith('SELECT outcome FROM creative_point_provider_receipts_v2')) rows = [{ outcome: 'failed' }]
      else if (sql.startsWith('SELECT EXISTS (SELECT 1 FROM creative_point_provider_receipts_v2')) rows = [{ matched: false }]
      else if (sql.startsWith('SELECT pg_catalog.to_regclass')) rows = [{ present: true }]
      else if (sql.startsWith('SELECT EXISTS(SELECT 1 FROM creative_point_grants')) rows = [++balanceReads === 1 ? { known: true, available: '7', reserved: '3', settled: '0' } : { known: true, available: '10', reserved: '0', settled: '0' }]
      else if (sql.startsWith('SELECT revision,')) rows = [{ revision: 1, updatedAt: input.at }]
      else if (sql.includes('FROM creative_point_allocations a') && sql.includes('HAVING sum(a.points_delta)>0')) rows = [{ grantId: 'grant_original', allocated: '3' }]
      else if (sql.startsWith("UPDATE creative_point_reservations SET status='released'")) rows = [{ ...reservation, status: 'released', finalizedAt: input.at }]
      else if (sql.startsWith('UPDATE creative_point_access_state SET available_points=')) rows = [{ workspaceId: input.workspaceId, availablePoints: '10', reservedPoints: '0', settledPoints: '0', revision: 2, updatedAt: input.at }]
      return { rows: rows as Row[] }
    }, release: () => undefined }
    const repository = new PostgresCreativePointRepository({ connect: async () => client })
    await expect(repository.releaseFailedProviderReservation(input)).resolves.toMatchObject({ value: { id: reservation.id, status: 'released', operationId: reservation.operationId }, balance: { availablePoints: 10, reservedPoints: 0, settledPoints: 0 } })
    const receiptIndex = queries.findIndex(query => query.sql.startsWith('SELECT outcome FROM creative_point_provider_receipts_v2'))
    const releaseIndex = queries.findIndex(query => query.sql.startsWith("UPDATE creative_point_reservations SET status='released'"))
    expect(receiptIndex).toBeGreaterThan(0)
    expect(releaseIndex).toBeGreaterThan(receiptIndex)
    expect(queries.at(-1)?.sql).toBe('COMMIT')
  })

  it.each([
    { label: 'missing failed receipt', receipts: [], successful: false },
    { label: 'ambiguous duplicate failed receipts', receipts: [{ outcome: 'failed' }, { outcome: 'failed' }], successful: false },
    { label: 'successful receipt for the operation', receipts: [{ outcome: 'failed' }], successful: true },
  ])('rolls back without a release write for $label', async ({ receipts, successful }) => {
    const { repository, queries } = adapter(receipts, successful)
    await expect(repository.releaseFailedProviderReservation(input)).rejects.toMatchObject({ code: 'CREATIVE_POINT_BALANCE_UNKNOWN' })
    const reservationLock = queries.find(query => query.sql.includes('FROM creative_point_reservations') && query.sql.includes('FOR UPDATE'))!
    expect(reservationLock.params).toEqual([input.workspaceId, input.reservationId, reservation.operationId, input.actionKey])
    const receiptLock = queries.find(query => query.sql.startsWith('SELECT outcome FROM creative_point_provider_receipts_v2'))
    if (receipts.length !== 0 || successful) {
      expect(receiptLock?.params).toEqual([input.workspaceId, reservation.operationId, input.providerRequestId])
    }
    expect(queries.some(query => query.sql.startsWith('UPDATE creative_point_reservations'))).toBe(false)
    expect(queries.at(-1)?.sql).toBe('ROLLBACK')
  })
})
