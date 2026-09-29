import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import { PostgresCreativePointLifecycleRepository } from './creative-point-lifecycle-repository.js'
import type { SqlClient, SqlPool, SqlQueryResult } from './repository.js'

class Client implements SqlClient {
  readonly sql: string[] = []
  readonly values: Array<readonly unknown[] | undefined> = []
  constructor(private readonly respond: (sql: string, values?: readonly unknown[]) => SqlQueryResult | undefined = () => ({ rows: [] })) {}
  async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>> { this.sql.push(sql); this.values.push(values); return (this.respond(sql, values) ?? { rows: [] }) as SqlQueryResult<Row> }
}

/** One completed operation row. Before the replay guard compares payloads the
 * stored request is simply assumed to match, which is exactly the defect. */
const completedOperation = (stored: Record<string, unknown>, balance: Record<string, unknown>) =>
  (sql: string, values?: readonly unknown[]) => {
    if (!sql.includes('FROM creative_point_operations')) return undefined
    const comparesPayload = sql.includes('requestMatches')
    const requested = comparesPayload ? (JSON.parse(String(values?.[3] ?? 'null')) as Record<string, unknown>) : stored
    // Mirrors the SQL: the optimistic-concurrency token is compared by neither side.
    const comparable = (value: Record<string, unknown>) => JSON.parse(JSON.stringify({ ...value, expected_access_revision: undefined })) as Record<string, unknown>
    return { rows: [{ result: { balance }, requestMatches: isDeepStrictEqual(comparable(stored), comparable(requested)) }] }
  }
const pool = (client: SqlClient): SqlPool => ({ connect: async () => client })

describe('PostgresCreativePointLifecycleRepository', () => {
  it('returns the stored provider receipt hash and original cost without recomputing either', async () => {
    const receipt = { operationId: 'operation-1', provider: 'model-relay', providerRequestId: 'provider-1', outcome: 'succeeded', usage: { modality: 'text', model: 'model-1' }, cost: { currency: 'CNY', actual: 0.00090156 }, receiptHash: 'b'.repeat(64), verifiedAt: new Date('2026-09-29T08:00:00Z') }
    const client = new Client(sql => sql.includes('receipt_hash AS "receiptHash"') ? { rows: [receipt] } : { rows: [] })
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.getProviderReceipt({ workspaceId: 'ws-1', operationId: 'operation-1', provider: 'model-relay', providerRequestId: 'provider-1' })).resolves.toEqual({ ...receipt, verifiedAt: '2026-09-29T08:00:00.000Z' })
    const query = client.sql.find(sql => sql.includes('receipt_hash AS "receiptHash"'))!
    expect(query).toContain('WHERE workspace_id=$1 AND operation_id=$2 AND provider=$3 AND provider_request_id=$4')
    expect(client.values[client.sql.indexOf(query)]).toEqual(['ws-1', 'operation-1', 'model-relay', 'provider-1'])
    expect(client.sql.some(sql => /\b(INSERT|UPDATE|DELETE)\b/iu.test(sql))).toBe(false)
  })

  it('verifies API-owned delivery settlement evidence in a workspace-scoped read transaction', async () => {
    const client = new Client(sql => sql.includes('SELECT count(*)::int AS matched') ? { rows: [{ matched: 1 }] } : { rows: [] })
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.verifyModelUsageDeliverySettlement({ workspaceId: 'ws-1', reservationId: 'reservation-1', actionId: 'action-1', providerRequestId: 'provider-1', relayProvider: 'relay.example' })).resolves.toBe(true)
    const query = client.sql.find(sql => sql.includes('SELECT count(*)::int AS matched'))!
    expect(query).toContain('JOIN model_usage_ledger')
    expect(query).toContain('JOIN creative_point_provider_receipts_v2 api_receipt')
    expect(query).toContain('JOIN creative_point_provider_receipts_v2 worker_receipt')
    expect(query).toContain('worker_receipt.id<>api_receipt.id')
    expect(query).toContain("m.modality='text'")
    expect(query).toContain("settlement.idempotency_key='commercial.settle:' || r.action_key")
    expect(query).toContain('NOT EXISTS (SELECT 1 FROM creative_point_reversals_v2')
    expect(client.values[client.sql.indexOf(query)]).toEqual(['ws-1', 'reservation-1', 'action-1', 'provider-1', 'relay.example', false, false])
    expect(client.sql).toContain('COMMIT')
    expect(client.sql.some(sql => /\b(INSERT|UPDATE|DELETE)\b/iu.test(sql))).toBe(false)
  })

  it('returns false when the original API usage and point settlement evidence is incomplete', async () => {
    const client = new Client(sql => sql.includes('SELECT count(*)::int AS matched') ? { rows: [{ matched: 0 }] } : { rows: [] })
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.verifyModelUsageDeliverySettlement({ workspaceId: 'ws-1', reservationId: 'reservation-1', actionId: 'action-1', providerRequestId: 'provider-1', relayProvider: 'relay.example' })).resolves.toBe(false)
  })

  it('permits zero-point delivery only for the verified non-OCR free-cost policy while preserving paid checks', async () => {
    const client = new Client(sql => sql.includes('SELECT count(*)::int AS matched') ? { rows: [{ matched: 1 }] } : { rows: [] })
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.verifyModelUsageDeliverySettlement({ workspaceId: 'ws-1', reservationId: 'reservation-1', actionId: 'action-1', providerRequestId: 'provider-1', relayProvider: 'relay.example' })).resolves.toBe(true)
    const query = client.sql.find(sql => sql.includes('SELECT count(*)::int AS matched'))!
    const compact = query.replace(/\s+/gu, ' ')
    // Pin the complete OR branch: neither allowPartialPoints nor a bare zero
    // may bypass the cost threshold, supported modality, or both policy stamps.
    expect(compact).toContain("AND ( (r.settled_points>0 AND (r.settled_points=r.points OR $6::boolean)) OR ( r.settled_points=0 AND r.points>0 AND m.modality IN ('text','image','image_edit','video') AND verified_cost.actual_cost_cny>=0 AND verified_cost.actual_cost_cny<0.1 AND ledger.metadata->>'point_policy_version'='model.cost_cny_free_lt_0_1.v1' AND settlement.request->'metadata'->>'point_policy_version'='model.cost_cny_free_lt_0_1.v1' ) ) AND a.state='settled'")
    // These conditions remain outside both branches and apply equally to free
    // and paid delivery. A policy stamp alone is never sufficient evidence.
    for (const guard of [
      "api_receipt.outcome='succeeded' AND api_receipt.verified_at IS NOT NULL",
      "worker_receipt.outcome='succeeded' AND worker_receipt.verified_at IS NOT NULL",
      "jsonb_typeof(api_receipt.cost->'actual')='number'",
      "THEN (api_receipt.cost->>'actual')::numeric ELSE NULL END",
      "round(verified_cost.actual_cost_cny,6)=m.cost_cny",
      "worker_receipt.cost->'actual'=api_receipt.cost->'actual'",
      "ledger.metadata->'cost_cny'=api_receipt.cost->'actual'",
      "settlement.request->'metadata'->'cost_cny'=api_receipt.cost->'actual'",
      "settlement.request->'actual_points'=to_jsonb(r.settled_points)",
      "ledger.metadata->>'receipt_hash'=api_receipt.receipt_hash",
      "settlement.request->'metadata'->>'receipt_hash'=api_receipt.receipt_hash",
    ]) expect(query).toContain(guard)
  })

  it('requires text usage only for the charged text no-delivery resolution', async () => {
    const client = new Client(sql => sql.includes('SELECT count(*)::int AS matched') ? { rows: [{ matched: 0 }] } : { rows: [] })
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.verifyModelUsageDeliverySettlement({ workspaceId: 'ws-1', reservationId: 'reservation-1', actionId: 'action-1', providerRequestId: 'provider-1', relayProvider: 'relay.example', allowPartialPoints: true, requireText: true })).resolves.toBe(false)
    const query = client.sql.find(sql => sql.includes('SELECT count(*)::int AS matched'))!
    expect(query).toContain("NOT $7::boolean OR m.modality='text'")
    expect(client.values[client.sql.indexOf(query)]).toEqual(['ws-1', 'reservation-1', 'action-1', 'provider-1', 'relay.example', true, true])
  })

  it('rejects missing delivery settlement identities before querying', async () => {
    const client = new Client()
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.verifyModelUsageDeliverySettlement({ workspaceId: 'ws-1', reservationId: 'reservation-1', actionId: 'action-1', providerRequestId: 'provider-1', relayProvider: ' ' })).rejects.toThrow('relayProvider is required')
    expect(client.sql).toEqual([])
  })

  it('never treats the reserved API provider identity as an independent relay receipt', async () => {
    const client = new Client()
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.verifyModelUsageDeliverySettlement({ workspaceId: 'ws-1', reservationId: 'reservation-1', actionId: 'action-1', providerRequestId: 'provider-1', relayProvider: 'model-relay' })).resolves.toBe(false)
    await expect(repository.verifyModelUsageDeliverySettlementInTransaction(client, { workspaceId: 'ws-1', reservationId: 'reservation-1', actionId: 'action-1', providerRequestId: 'provider-1', relayProvider: 'model-relay' })).resolves.toBe(false)
    expect(client.sql).not.toContain(expect.stringContaining('SELECT count(*)::int AS matched'))
  })

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
    const client = new Client(sql => sql.includes('SELECT id,kind FROM creative_point_operations') ? { rows: [{ id: 'operation-1', kind: 'reserve' }] } : sql.includes('SELECT status FROM creative_point_reservations') ? { rows: [{ status: 'active' }] } : sql.includes('FROM creative_point_provider_receipts_v2') ? { rows: [] } : sql.includes('INSERT INTO creative_point_provider_receipts_v2') ? { rows: [{ operation_id: 'operation-1' }], rowCount: 1 } : { rows: [] })
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await repository.recordProviderReceipt({ workspaceId: 'ws-1', operationId: 'operation-1', provider: 'relay', providerRequestId: 'request-1', outcome: 'unknown', receiptHash: 'a'.repeat(64), at: '2026-09-02T00:00:00Z' })
    const sql = client.sql.join('\n')
    expect(sql).toContain('INSERT INTO creative_point_provider_receipts_v2')
    expect(sql).not.toContain("status='settled'")
    expect(sql).not.toContain("status='released'")
    expect(sql).toContain('COMMIT')
  })

  it('persists a successful provider receipt only after locking its unique active reserve binding', async () => {
    const client = new Client(sql => sql.includes('SELECT id,kind FROM creative_point_operations')
      ? { rows: [{ id: 'operation-1', kind: 'reserve' }] }
      : sql.includes('SELECT status FROM creative_point_reservations')
        ? { rows: [{ status: 'active' }] }
        : sql.includes('FROM creative_point_provider_receipts_v2')
          ? { rows: [] }
          : sql.includes('INSERT INTO creative_point_provider_receipts_v2')
            ? { rows: [{ operation_id: 'operation-1' }], rowCount: 1 }
        : { rows: [] })
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.recordProviderReceipt({ workspaceId: 'ws-1', operationId: 'operation-1', provider: 'relay', providerRequestId: 'request-success', outcome: 'succeeded', usage: { modality: 'text', model: 'model-1', total_tokens: 1 }, cost: { currency: 'CNY', actual: 0.01 }, verifiedAt: '2026-09-02T00:00:00Z', receiptHash: 'c'.repeat(64), at: '2026-09-02T00:00:00Z' })).resolves.toBeUndefined()
    expect(client.sql.findIndex(sql => sql.includes('SELECT id,kind FROM creative_point_operations'))).toBeLessThan(client.sql.findIndex(sql => sql.includes('SELECT status FROM creative_point_reservations')))
    expect(client.sql.find(sql => sql.includes('SELECT status FROM creative_point_reservations'))).toContain('FOR UPDATE')
    expect(client.sql.findIndex(sql => sql.includes('SELECT status FROM creative_point_reservations'))).toBeLessThan(client.sql.findIndex(sql => sql.includes('INSERT INTO creative_point_provider_receipts_v2')))
    expect(client.sql.find(sql => sql.includes('FROM creative_point_provider_receipts_v2'))).not.toContain('FOR SHARE')
  })

  it('rejects a provider receipt request id already bound to another operation', async () => {
    const client = new Client(sql => {
      if (sql.includes('SELECT id,kind FROM creative_point_operations')) return { rows: [{ id: 'operation-1', kind: 'reserve' }] }
      if (sql.includes('SELECT status FROM creative_point_reservations')) return { rows: [{ status: 'active' }] }
      if (sql.includes('FROM creative_point_provider_receipts_v2')) return { rows: [{ operation_id: 'operation-other', workspace_id: 'ws-other', provider: 'relay', provider_request_id: 'request-1', outcome: 'succeeded', usage: { modality: 'text', model: 'model-1', total_tokens: 1 }, cost: { currency: 'CNY', actual: 0.01 }, receipt_hash: 'b'.repeat(64), verified_at: new Date('2026-09-02T00:00:00Z') }] }
      return { rows: [] }
    })
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.recordProviderReceipt({ workspaceId: 'ws-1', operationId: 'operation-1', provider: 'relay', providerRequestId: 'request-1', outcome: 'succeeded', usage: { modality: 'text', model: 'model-1', total_tokens: 1 }, cost: { currency: 'CNY', actual: 0.01 }, verifiedAt: '2026-09-02T00:00:00Z', receiptHash: 'a'.repeat(64), at: '2026-09-02T00:00:00Z' })).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
  })

  it('serializes on the commercial operation and rejects success after reservation release', async () => {
    const client = new Client(sql => sql.includes('SELECT id,kind FROM creative_point_operations') ? { rows: [{ id: 'operation-1', kind: 'reserve' }] } : sql.includes('SELECT status FROM creative_point_reservations') ? { rows: [{ status: 'released' }] } : { rows: [] })
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.recordProviderReceipt({ workspaceId: 'ws-1', operationId: 'operation-1', provider: 'relay', providerRequestId: 'request-late-success', outcome: 'succeeded', usage: { modality: 'image', model: 'model-1' }, cost: { currency: 'CNY', actual: 0.01 }, verifiedAt: '2026-09-02T00:00:00Z', receiptHash: 'a'.repeat(64), at: '2026-09-02T00:00:00Z' })).rejects.toMatchObject({ code: 'CREATIVE_POINT_RESERVATION_FINALIZED' })
    expect(client.sql.find(sql => sql.includes('SELECT id,kind FROM creative_point_operations'))).toContain('FOR SHARE')
    expect(client.sql.find(sql => sql.includes('SELECT status FROM creative_point_reservations'))).toContain('FOR UPDATE')
    expect(client.sql.some(sql => sql.includes('INSERT INTO creative_point_provider_receipts_v2'))).toBe(false)
    expect(client.sql.at(-1)).toBe('ROLLBACK')
  })

  it('rejects new settled receipts but permits exact successful receipt replay', async () => {
    const input = { workspaceId: 'ws-1', operationId: 'operation-1', provider: 'relay', providerRequestId: 'request-settled', outcome: 'succeeded' as const, usage: { modality: 'text', model: 'model-1', total_tokens: 1 }, cost: { currency: 'CNY', actual: 0.01 }, verifiedAt: '2026-09-02T00:00:00.000Z', receiptHash: 'd'.repeat(64), at: '2026-09-02T00:00:00Z' }
    const newReceipt = new Client(sql => sql.includes('SELECT id,kind FROM creative_point_operations') ? { rows: [{ id: 'operation-1', kind: 'reserve' }] } : sql.includes('SELECT status FROM creative_point_reservations') ? { rows: [{ status: 'settled' }] } : { rows: [] })
    await expect(new PostgresCreativePointLifecycleRepository(pool(newReceipt)).recordProviderReceipt(input)).rejects.toMatchObject({ code: 'CREATIVE_POINT_RESERVATION_FINALIZED' })
    expect(newReceipt.sql.some(sql => sql.includes('INSERT INTO creative_point_provider_receipts_v2'))).toBe(false)

    const replayReceipt = new Client(sql => sql.includes('SELECT id,kind FROM creative_point_operations')
      ? { rows: [{ id: 'operation-1', kind: 'reserve' }] }
      : sql.includes('SELECT status FROM creative_point_reservations')
        ? { rows: [{ status: 'settled' }] }
        : sql.includes('FROM creative_point_provider_receipts_v2')
          ? { rows: [{ operation_id: 'operation-1', workspace_id: 'ws-1', provider: 'relay', provider_request_id: 'request-settled', outcome: 'succeeded', usage: input.usage, cost: input.cost, receipt_hash: input.receiptHash, verified_at: new Date(input.verifiedAt) }] }
          : { rows: [] })
    await expect(new PostgresCreativePointLifecycleRepository(pool(replayReceipt)).recordProviderReceipt(input)).resolves.toBeUndefined()
    expect(replayReceipt.sql.some(sql => sql.includes('INSERT INTO creative_point_provider_receipts_v2'))).toBe(false)
  })

  it('rejects provider receipts detached from a reserve operation or its unique reservation', async () => {
    const input = { workspaceId: 'ws-1', operationId: 'operation-1', provider: 'relay', providerRequestId: 'request-detached', outcome: 'succeeded' as const, usage: { modality: 'text', model: 'model-1', total_tokens: 1 }, cost: { currency: 'CNY', actual: 0.01 }, verifiedAt: '2026-09-02T00:00:00Z', receiptHash: 'a'.repeat(64), at: '2026-09-02T00:00:00Z' }
    const nonReserve = new Client(sql => sql.includes('SELECT id,kind FROM creative_point_operations') ? { rows: [{ id: 'operation-1', kind: 'grant' }] } : { rows: [] })
    await expect(new PostgresCreativePointLifecycleRepository(pool(nonReserve)).recordProviderReceipt(input)).rejects.toMatchObject({ code: 'CREATIVE_POINT_BALANCE_UNKNOWN' })
    expect(nonReserve.sql.some(sql => sql.includes('INSERT INTO creative_point_provider_receipts_v2'))).toBe(false)
    for (const reservations of [[], [{ status: 'active' }, { status: 'active' }]]) {
      const client = new Client(sql => sql.includes('SELECT id,kind FROM creative_point_operations') ? { rows: [{ id: 'operation-1', kind: 'reserve' }] } : sql.includes('SELECT status FROM creative_point_reservations') ? { rows: reservations } : { rows: [] })
      await expect(new PostgresCreativePointLifecycleRepository(pool(client)).recordProviderReceipt(input)).rejects.toMatchObject({ code: 'CREATIVE_POINT_BALANCE_UNKNOWN' })
      expect(client.sql.some(sql => sql.includes('INSERT INTO creative_point_provider_receipts_v2'))).toBe(false)
    }
  })
})

const replayedBalance = { workspaceId: 'ws-1', availablePoints: 90, reservedPoints: 0, settledPoints: 100, revision: 3 }

describe('PostgresCreativePointLifecycleRepository idempotent replay payloads', () => {
  it('replays a reversal only when the recorded request matches', async () => {
    const stored = { reservation_id: 'R1', points: 100, reason: 'provider refund', actor_id: 'ops-1', evidence: { ticket: 'T-1' } }
    const client = new Client(completedOperation(stored, replayedBalance))
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    const replay = { workspaceId: 'ws-1', idempotencyKey: 'k1', reservationId: 'R1', points: 100, kind: 'refund' as const, actorId: 'ops-1', reason: 'provider refund', evidence: { ticket: 'T-1' }, at: '2026-09-02T00:00:00Z' }
    await expect(repository.reverseSettlement(replay)).resolves.toMatchObject({ availablePoints: 90 })
    expect(client.sql.some(sql => sql.includes('INSERT INTO creative_point_operations'))).toBe(false)
  })

  it('rejects a replay key reused for a different reservation or point amount', async () => {
    const stored = { reservation_id: 'R1', points: 100, reason: 'provider refund', actor_id: 'ops-1', evidence: { ticket: 'T-1' } }
    const client = new Client(completedOperation(stored, replayedBalance))
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    const otherReservation = { workspaceId: 'ws-1', idempotencyKey: 'k1', reservationId: 'R2', points: 100, kind: 'refund' as const, actorId: 'ops-1', reason: 'provider refund', evidence: { ticket: 'T-1' }, at: '2026-09-02T00:00:00Z' }
    const otherPoints = { ...otherReservation, reservationId: 'R1', points: 50 }
    await expect(repository.reverseSettlement(otherReservation)).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
    await expect(repository.reverseSettlement(otherPoints)).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
    expect(client.sql.some(sql => sql.includes('INSERT INTO creative_point_reservations'))).toBe(false)
    expect(client.sql.some(sql => sql.includes('UPDATE creative_point_access_state'))).toBe(false)
  })

  it('rejects an expiry replay key reused for a different grant', async () => {
    const stored = { grant_id: 'grant-1', points: 20 }
    const client = new Client((sql, values) => {
      if (sql.includes('SELECT g.points-COALESCE')) return { rows: [{ remaining: 20 }] }
      return completedOperation(stored, replayedBalance)(sql, values)
    })
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    await expect(repository.expireGrant({ workspaceId: 'ws-1', grantId: 'grant-1', idempotencyKey: 'expire-1', at: '2026-09-02T00:00:00Z' })).resolves.toMatchObject({ availablePoints: 90 })
    await expect(repository.expireGrant({ workspaceId: 'ws-1', grantId: 'grant-2', idempotencyKey: 'expire-1', at: '2026-09-02T00:00:00Z' })).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
    expect(client.sql.some(sql => sql.includes('WITH active AS'))).toBe(false)
  })

  it('rejects an adjustment replay key reused for a different approval', async () => {
    const stored = { approval_id: 'approval-1', points_delta: 10, expected_access_revision: 1, actor_id: 'actor-1', approved_by_actor_id: 'actor-2', reason: 'support correction', evidence: { ticket: 'T-1' } }
    const client = new Client(completedOperation(stored, replayedBalance))
    const repository = new PostgresCreativePointLifecycleRepository(pool(client))
    const input = { workspaceId: 'ws-1', approvalId: 'approval-1', pointsDelta: 10, expectedAccessRevision: 1, actorId: 'actor-1', approvedByActorId: 'actor-2', reason: 'support correction', evidence: { ticket: 'T-1' }, idempotencyKey: 'adjust-1', at: '2026-09-02T00:00:00Z' }
    await expect(repository.adjust(input)).resolves.toMatchObject({ availablePoints: 90 })
    // The revision is read from live state at call time: a retry that observes
    // an advanced revision still replays, it does not become a conflict.
    await expect(repository.adjust({ ...input, expectedAccessRevision: 99 })).resolves.toMatchObject({ availablePoints: 90 })
    await expect(repository.adjust({ ...input, approvalId: 'approval-2' })).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
    await expect(repository.adjust({ ...input, pointsDelta: 11 })).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
    await expect(repository.adjust({ ...input, evidence: { ticket: 'T-2' } })).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
    expect(client.sql.some(sql => sql.includes('INSERT INTO creative_point_adjustments_v2'))).toBe(false)
  })
})
