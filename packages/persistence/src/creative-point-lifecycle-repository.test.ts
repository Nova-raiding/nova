import { describe, expect, it } from 'vitest'
import { PostgresCreativePointLifecycleRepository } from './creative-point-lifecycle-repository.js'
import type { SqlClient, SqlPool, SqlQueryResult } from './repository.js'

class Client implements SqlClient {
  readonly sql: string[] = []
  constructor(private readonly respond: (sql: string) => SqlQueryResult | undefined = () => ({ rows: [] })) {}
  async query<Row>(sql: string): Promise<SqlQueryResult<Row>> { this.sql.push(sql); return (this.respond(sql) ?? { rows: [] }) as SqlQueryResult<Row> }
}
const pool = (client: SqlClient): SqlPool => ({ connect: async () => client })

describe('PostgresCreativePointLifecycleRepository', () => {
  it('expires a due grant by appending an expiry operation/event and advancing revision', async () => {
    const client = new Client(sql => {
      if (sql.includes('SELECT g.points-COALESCE')) return { rows: [{ remaining: 20 }] }
      if (sql.includes('WITH active AS')) return { rows: [{ available: 80, reserved: 0, settled: 0, revision: 4 }] }
      return { rows: [] }
    })
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.expireGrant({ workspaceId: 'ws-1', grantId: 'grant-1', idempotencyKey: 'expire-1', at: '2026-09-02T00:00:00Z' })).resolves.toMatchObject({ availablePoints: 80, revision: 4 })
    const sql = client.sql.join('\n')
    expect(sql).toContain('INSERT INTO creative_point_operations')
    expect(sql).toContain('INSERT INTO creative_point_ledger_events')
    expect(sql).toContain('COMMIT')
  })

  it('requires a distinct approver and evidence before an Ops adjustment touches PostgreSQL', async () => {
    const client = new Client()
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.adjust({ workspaceId: 'ws-1', approvalId: 'approval-1', pointsDelta: 10, expectedAccessRevision: 1, actorId: 'actor-1', approvedByActorId: 'actor-1', reason: 'support correction', evidence: { ticket: 'T-1' }, idempotencyKey: 'adjust-1', at: '2026-09-02T00:00:00Z' })).rejects.toMatchObject({ code: 'COMMERCIAL_ADJUSTMENT_APPROVAL_INVALID' })
    expect(client.sql).toEqual([])
  })

  it('rejects a successful provider receipt without verified usage and cost', async () => {
    const client = new Client()
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.recordProviderReceipt({ workspaceId: 'ws-1', operationId: 'operation-1', provider: 'relay', providerRequestId: 'request-1', outcome: 'succeeded', receiptHash: 'a'.repeat(64), at: '2026-09-02T00:00:00Z' })).rejects.toMatchObject({ code: 'CREATIVE_POINT_BALANCE_UNKNOWN' })
    expect(client.sql).toEqual([])
  })

  it.each([
    { usage: { modality: 'text', model: 'model-1', input_tokens: -1 }, cost: { currency: 'CNY', actual: 0.01 } },
    { usage: { modality: 'text', model: 'model-1', input_tokens: 1 }, cost: { currency: 'CNY', actual: Number.NaN } },
    { usage: [], cost: { currency: 'CNY', actual: 0.01 } },
  ])('rejects invalid provider usage or cost evidence at persistence boundary: %j', async evidence => {
    const client = new Client()
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.recordProviderReceipt({ workspaceId: 'ws-1', operationId: 'operation-1', provider: 'relay', providerRequestId: 'request-invalid', outcome: 'succeeded', usage: evidence.usage as Record<string, unknown>, cost: evidence.cost, verifiedAt: '2026-09-02T00:00:00Z', receiptHash: 'a'.repeat(64), at: '2026-09-02T00:00:00Z' })).rejects.toMatchObject({ code: 'CREATIVE_POINT_INPUT_INVALID' })
    expect(client.sql).toEqual([])
  })

  it('persists unknown provider outcome without settling or releasing the reservation', async () => {
    const client = new Client(sql => sql.includes('INSERT INTO creative_point_provider_receipts_v2') ? { rows: [{ operation_id: 'operation-1', provider: 'relay', outcome: 'unknown', receipt_hash: 'a'.repeat(64) }], rowCount: 1 } : { rows: [] })
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await repository.recordProviderReceipt({ workspaceId: 'ws-1', operationId: 'operation-1', provider: 'relay', providerRequestId: 'request-1', outcome: 'unknown', receiptHash: 'a'.repeat(64), at: '2026-09-02T00:00:00Z' })
    const sql = client.sql.join('\n')
    expect(sql).toContain('INSERT INTO creative_point_provider_receipts_v2')
    expect(sql).not.toContain("status='settled'")
    expect(sql).not.toContain("status='released'")
    expect(sql).toContain('COMMIT')
  })

  it('rejects a provider receipt request id already bound to another operation', async () => {
    const client = new Client(sql => {
      if (sql.includes('INSERT INTO creative_point_provider_receipts_v2')) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT operation_id,provider,outcome,receipt_hash')) return { rows: [{ operation_id: 'operation-other', provider: 'relay', outcome: 'succeeded', receipt_hash: 'b'.repeat(64) }] }
      return { rows: [] }
    })
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.recordProviderReceipt({ workspaceId: 'ws-1', operationId: 'operation-1', provider: 'relay', providerRequestId: 'request-1', outcome: 'succeeded', usage: { modality: 'text', model: 'model-1', total_tokens: 1 }, cost: { currency: 'CNY', actual: 0.01 }, verifiedAt: '2026-09-02T00:00:00Z', receiptHash: 'a'.repeat(64), at: '2026-09-02T00:00:00Z' })).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
  })
})
