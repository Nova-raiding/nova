import { describe, expect, it, vi } from 'vitest'
import { MemoryCreativePointRepository } from '../../../packages/persistence/src/creative-point-repository.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import { CreativePointRelaySettlement, relayProviderIdentity } from './creative-point-relay-settlement.js'

const at = '2026-09-02T00:00:00.000Z'

async function fixture() {
  const points = new MemoryCreativePointRepository()
  await points.grant({ workspaceId: 'ws_a', idempotencyKey: 'grant_1', sourceType: 'test', sourceId: 'grant_1', points: 10, at })
  const reserved = await points.reserve({ workspaceId: 'ws_a', idempotencyKey: 'reserve_1', actionKey: 'generation.execute', points: 3, rateCardVersion: 'rate_1', at })
  const receiptRows = new Map<string, { operationId: string; provider: string; providerRequestId: string; outcome: 'succeeded' | 'failed' | 'unknown'; usage: Record<string, unknown> | null; cost: Record<string, unknown> | null; verifiedAt: string | null }>()
  const receipts = {
    recordProviderReceipt: vi.fn(async (input: { operationId: string; provider: string; providerRequestId: string; outcome: 'succeeded' | 'failed' | 'unknown'; usage?: Record<string, unknown>; cost?: Record<string, unknown>; verifiedAt?: string }) => {
      receiptRows.set(input.providerRequestId, { operationId: input.operationId, provider: input.provider, providerRequestId: input.providerRequestId, outcome: input.outcome, usage: input.usage ?? null, cost: input.cost ?? null, verifiedAt: input.verifiedAt ?? null })
    }),
    getProviderReceipt: vi.fn(async (input: { operationId: string; provider: string; providerRequestId: string }) => {
      const row = receiptRows.get(input.providerRequestId)
      return row?.operationId === input.operationId && row.provider === input.provider ? row : null
    }),
  }
  const event: DurableOutboxEvent = {
    id: 'evt_generation_1', workspaceId: 'ws_a', aggregateId: 'job_1', eventType: 'generation.requested', sequence: 1, createdAt: at,
    payload: {
      commercial_access_snapshot: {
        schema_version: 1, decision_id: 'decision_1', workspace_id: 'ws_a', operation: 'generation.execute',
        access_mode: 'POINT_CHARGED', access_revision: 'revision_1', balance_state: 'known',
        entitlement_snapshot_id: 'entitlement_1', entitlement_snapshot_checksum: 'a'.repeat(64),
        rate_version: 'rate_1', quoted_points: 3, reservation_id: reserved.value.id, decided_at: at,
      },
    },
  }
  return { points, receipts, event, reservationId: reserved.value.id, settlement: new CreativePointRelaySettlement(points, receipts, 'relay.example') }
}

describe('creative point relay settlement', () => {
  it('records verified provider evidence and settles before delivery', async () => {
    const { points, receipts, event, reservationId, settlement } = await fixture()
    const requestId = await settlement.recordSucceeded(event, { modality: 'text', model: 'model-1', providerRequestId: 'provider_req_1', inputTokens: 10, outputTokens: 5, totalTokens: 15, costCny: 0.12, observedAt: at })
    expect(requestId).toBe('provider_req_1')
    expect(receipts.recordProviderReceipt).toHaveBeenCalledWith(expect.objectContaining({ operationId: expect.stringMatching(/^cpo_/), outcome: 'succeeded', providerRequestId: 'provider_req_1', usage: expect.objectContaining({ total_tokens: 15 }), cost: { currency: 'CNY', actual: 0.12 }, verifiedAt: at }))
    await settlement.settleForDelivery(event, [requestId!])
    await expect(points.getReservation('ws_a', reservationId)).resolves.toMatchObject({ status: 'settled', settledPoints: 3 })
  })

  it('rejects delivery when the provider request has no current-operation receipt', async () => {
    const { event, settlement } = await fixture()
    await expect(settlement.settleForDelivery(event, ['provider_missing'])).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', providerRequestId: 'provider_missing' })
  })

  it('rejects delivery when the current-operation receipt is not succeeded with complete evidence', async () => {
    const { event, settlement, receipts } = await fixture()
    const operationId = 'cpo_test'
    receipts.getProviderReceipt.mockResolvedValue({ operationId, provider: 'relay.example', providerRequestId: 'provider_failed', outcome: 'failed', usage: null, cost: null, verifiedAt: null })
    await expect(settlement.settleForDelivery(event, ['provider_failed'])).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING' })
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects non-finite or negative cost before recording provider evidence: %s', async costCny => {
    const { event, settlement, receipts } = await fixture()
    await expect(settlement.recordSucceeded(event, { modality: 'text', model: 'model-1', providerRequestId: `provider_invalid_${String(costCny)}`, inputTokens: 1, outputTokens: 1, totalTokens: 2, costCny, observedAt: at })).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING' })
    expect(receipts.recordProviderReceipt).not.toHaveBeenCalled()
  })

  it.each([
    { usage: { modality: 'text', model: 'model-1', input_tokens: -1 }, cost: { currency: 'CNY', actual: 0.1 } },
    { usage: { modality: 'text', model: 'model-1', input_tokens: 1 }, cost: { currency: 'CNY', actual: Number.NaN } },
    { usage: [], cost: { currency: 'CNY', actual: 0.1 } },
  ])('rejects malformed persisted receipt evidence before settling: %j', async evidence => {
    const { event, settlement, receipts } = await fixture()
    receipts.getProviderReceipt.mockResolvedValue({ operationId: 'cpo_test', provider: 'relay.example', providerRequestId: 'provider_malformed', outcome: 'succeeded', usage: evidence.usage as Record<string, unknown>, cost: evidence.cost, verifiedAt: at })
    await expect(settlement.settleForDelivery(event, ['provider_malformed'])).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING' })
  })

  it('persists an unknown receipt without settling, releasing, or initiating another provider call', async () => {
    const { points, receipts, event, reservationId, settlement } = await fixture()
    await settlement.recordProviderOutcome(event, { providerOutcome: 'unknown', providerRequestId: 'provider_req_unknown', code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' })
    expect(receipts.recordProviderReceipt).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unknown', providerRequestId: 'provider_req_unknown' }))
    await expect(points.getReservation('ws_a', reservationId)).resolves.toMatchObject({ status: 'active' })
  })

  it('records a definitive failure and releases the reservation', async () => {
    const { points, receipts, event, reservationId, settlement } = await fixture()
    await settlement.recordProviderOutcome(event, { providerOutcome: 'failed', providerRequestId: 'provider_req_failed', code: 'PROVIDER_REJECTED' })
    expect(receipts.recordProviderReceipt).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', providerRequestId: 'provider_req_failed' }))
    await expect(points.getReservation('ws_a', reservationId)).resolves.toMatchObject({ status: 'released' })
  })

  it('fails closed when a successful provider call lacks cost or request identity', async () => {
    const { points, receipts, event, reservationId, settlement } = await fixture()
    await expect(settlement.recordSucceeded(event, { modality: 'text', model: 'model-1', providerRequestId: 'provider_req_1', observedAt: at })).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', providerSucceeded: true })
    expect(receipts.recordProviderReceipt).not.toHaveBeenCalled()
    await expect(points.getReservation('ws_a', reservationId)).resolves.toMatchObject({ status: 'active' })
  })

  it('does not mutate points for a no-charge access snapshot', async () => {
    const { points, receipts, event, settlement } = await fixture()
    event.payload.commercial_access_snapshot = { ...(event.payload.commercial_access_snapshot as object), access_mode: 'POINT_REQUIRED_NO_CHARGE', quoted_points: 0, rate_version: null, reservation_id: null }
    await expect(settlement.recordSucceeded(event, { modality: 'text', model: 'model-1', providerRequestId: 'provider_req_free', costCny: 0, observedAt: at })).resolves.toBeUndefined()
    await expect(settlement.settleForDelivery(event, [])).resolves.toBeUndefined()
    expect(receipts.recordProviderReceipt).not.toHaveBeenCalled()
    await expect(points.getBalance('ws_a')).resolves.toMatchObject({ availablePoints: 7, reservedPoints: 3, settledPoints: 0 })
  })

  it('derives a stable non-secret provider identity', () => {
    expect(relayProviderIdentity({ MODEL_RELAY_PROVIDER: 'managed-relay' })).toBe('managed-relay')
    expect(relayProviderIdentity({ MODEL_RELAY_BASE_URL: 'https://relay.example/v1' })).toBe('relay.example')
    expect(relayProviderIdentity({ MODEL_RELAY_BASE_URL: 'not a url' })).toBe('configured-relay')
  })
})
