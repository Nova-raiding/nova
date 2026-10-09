import { describe, expect, it } from 'vitest'
import { PostgresCommercialRefundRepository } from './commercial-refund-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

const rows = Array.from({ length: 3 }, (_, index) => ({
  id: `event-${3 - index}`, workspaceId: 'ws-refund', orderId: 'order-1', requestId: `request-${3 - index}`,
  revision: 1, eventType: 'requested', refundKind: 'monthly_unused_points', amountFen: 100,
  pointsToRevoke: 0, reason: 'reason', actorId: 'finance', evidence: { supplement_agreement_ref: 'SA-1' },
  externalRefundId: null, createdAt: new Date(Date.UTC(2026, 0, 3 - index)).toISOString(),
}))

class ListClient implements SqlClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = []
  async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values })
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('set_config')) return { rows: [] as Row[] }
    if (sql.includes('count(*)')) return { rows: [{ total: rows.length }] as Row[] }
    const [, timestamp, id, take] = values
    const filtered = timestamp ? rows.filter(row => row.createdAt < String(timestamp) || row.createdAt === timestamp && row.id < String(id)) : rows
    return { rows: filtered.slice(0, Number(take)) as Row[] }
  }
}

class ListPool implements SqlPool {
  readonly client = new ListClient()
  async connect() { return this.client }
}

describe('commercial refund event cursor pagination regression', () => {
  it('returns stable descending cursor pages with total count and workspace-bound cursors', async () => {
    const pool = new ListPool()
    const repository = new PostgresCommercialRefundRepository(pool)
    const first = await repository.list('ws-refund', { limit: 2 })
    expect(first).toMatchObject({ total: 3, truncated: true, items: [{ id: 'event-3' }, { id: 'event-2' }] })
    expect(first.nextCursor).toBeTruthy()
    const second = await repository.list('ws-refund', { limit: 2, cursor: first.nextCursor! })
    expect(second).toMatchObject({ total: 3, truncated: false, nextCursor: null, items: [{ id: 'event-1' }] })
    await expect(repository.list('ws-other', { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_INPUT_INVALID' })
    expect(pool.client.calls.some(call => call.sql.includes('count(*)'))).toBe(true)
  })
})
