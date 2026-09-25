import { describe, expect, it, vi } from 'vitest'
import { MemoryCreativePointRepository } from '../../../packages/persistence/src/creative-point-repository.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import { CreativePointRelaySettlement, deliverGenerationResultWithPointSettlement, relayProviderIdentity, requiresCreativePointSettlement } from './creative-point-relay-settlement.js'

const at = '2026-09-02T00:00:00.000Z'

async function fixture(operation: 'generation.execute' | 'image_generation.execute' = 'generation.execute') {
  const points = new MemoryCreativePointRepository()
  await points.grant({ workspaceId: 'ws_a', idempotencyKey: 'grant_1', sourceType: 'test', sourceId: 'grant_1', points: 10, at })
  const reserved = await points.reserve({ workspaceId: 'ws_a', idempotencyKey: 'reserve_1', actionKey: operation, points: 3, rateCardVersion: 'rate_1', at })
  const receiptRows = new Map<string, { operationId: string; provider: string; providerRequestId: string; outcome: 'succeeded' | 'failed' | 'unknown'; usage: Record<string, unknown> | null; cost: Record<string, unknown> | null; verifiedAt: string | null }>()
  const receipts = {
    recordProviderReceipt: vi.fn(async (input: { operationId: string; provider: string; providerRequestId: string; outcome: 'succeeded' | 'failed' | 'unknown'; usage?: Record<string, unknown>; cost?: Record<string, unknown>; verifiedAt?: string }) => {
      receiptRows.set(input.providerRequestId, { operationId: input.operationId, provider: input.provider, providerRequestId: input.providerRequestId, outcome: input.outcome, usage: input.usage ?? null, cost: input.cost ?? null, verifiedAt: input.verifiedAt ?? null })
    }),
    getProviderReceipt: vi.fn(async (input: { operationId: string; provider: string; providerRequestId: string }) => {
      const row = receiptRows.get(input.providerRequestId)
      return row?.operationId === input.operationId && row.provider === input.provider ? row : null
    }),
    verifyModelUsageDeliverySettlement: vi.fn(async () => false),
  }
  const event: DurableOutboxEvent = {
    id: 'evt_generation_1', workspaceId: 'ws_a', aggregateId: 'job_1', eventType: operation === 'image_generation.execute' ? 'image.generation.requested' : 'generation.requested', sequence: 1, createdAt: at,
    payload: {
      action_id: operation,
      commercial_access_snapshot: {
        schema_version: 1, decision_id: 'decision_1', workspace_id: 'ws_a', operation,
        access_mode: 'POINT_CHARGED', access_revision: 'revision_1', balance_state: 'known',
        entitlement_snapshot_id: 'entitlement_1', entitlement_snapshot_checksum: 'a'.repeat(64),
        rate_version: 'rate_1', quoted_points: 3, reservation_id: reserved.value.id, decided_at: at,
      },
    },
  }
  return { points, receipts, event, reservationId: reserved.value.id, settlement: new CreativePointRelaySettlement(points, receipts, 'relay.example') }
}

describe('creative point relay settlement', () => {
  it('verifies API-owned settlement before delivery without settling points a second time', async () => {
    const { points, receipts, event, reservationId, settlement } = await fixture()
    const requestId = await settlement.recordSucceeded(event, { modality: 'text', model: 'model-1', providerRequestId: 'provider_req_1', inputTokens: 10, outputTokens: 5, totalTokens: 15, costCny: 0.12, observedAt: at })
    expect(requestId).toBe('provider_req_1')
    expect(receipts.recordProviderReceipt).toHaveBeenCalledWith(expect.objectContaining({ operationId: expect.stringMatching(/^cpo_/), outcome: 'succeeded', providerRequestId: 'provider_req_1', usage: expect.objectContaining({ total_tokens: 15 }), cost: { currency: 'CNY', actual: 0.12 }, verifiedAt: at }))
    await points.settle({ workspaceId: 'ws_a', reservationId, actualPoints: 3, idempotencyKey: 'commercial.settle:generation.execute', metadata: { provider_request_id: requestId }, at })
    receipts.verifyModelUsageDeliverySettlement.mockResolvedValue(true)
    const settle = vi.spyOn(points, 'settle')
    await settlement.settleForDelivery(event, [requestId!])
    expect(settle).not.toHaveBeenCalled()
    expect(receipts.verifyModelUsageDeliverySettlement).toHaveBeenCalledWith({ workspaceId: 'ws_a', reservationId, actionId: 'generation.execute', providerRequestId: 'provider_req_1', relayProvider: 'relay.example' })
    await expect(points.getReservation('ws_a', reservationId)).resolves.toMatchObject({ status: 'settled', settledPoints: 3 })
  })

  it('does not settle on a failed callback and settles once after callback acceptance', async () => {
    const order: string[] = []
    const settle = vi.fn(async () => { order.push('settle') })
    await expect(deliverGenerationResultWithPointSettlement(true, async () => { order.push('callback'); throw new Error('callback failed') }, settle)).rejects.toThrow('callback failed')
    expect(settle).not.toHaveBeenCalled()
    await deliverGenerationResultWithPointSettlement(true, async () => { order.push('accepted') }, settle)
    expect(order).toEqual(['callback', 'accepted', 'settle'])
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('records and verifies the image receipt after API settlement without a second point settlement', async () => {
    const { points, receipts, event, reservationId, settlement } = await fixture('image_generation.execute')
    const requestId = await settlement.recordSucceeded(event, { modality: 'image', model: 'image-model', providerRequestId: 'image_req_1', costCny: 0.2, observedAt: at, metadata: { usage_observed: true, billing_units: 2 } }, 'image_generation.execute')
    expect(requestId).toBe('image_req_1')
    expect(receipts.recordProviderReceipt).toHaveBeenCalledWith(expect.objectContaining({ provider: 'relay.example', providerRequestId: 'image_req_1', outcome: 'succeeded', cost: { currency: 'CNY', actual: 0.2, cost_source: 'relay_reported_cny', billing_units: 2 } }))
    await points.settle({ workspaceId: 'ws_a', reservationId, actualPoints: 3, idempotencyKey: 'commercial.settle:image_generation.execute', metadata: { provider_request_id: requestId }, at })
    receipts.verifyModelUsageDeliverySettlement.mockResolvedValue(true)
    const settle = vi.spyOn(points, 'settle')
    await settlement.settleForDelivery(event, [requestId!], 'image_generation.execute')
    expect(receipts.getProviderReceipt).toHaveBeenCalledWith(expect.objectContaining({ provider: 'relay.example', providerRequestId: 'image_req_1' }))
    expect(receipts.verifyModelUsageDeliverySettlement).toHaveBeenCalledWith({ workspaceId: 'ws_a', reservationId, actionId: 'image_generation.execute', providerRequestId: 'image_req_1', relayProvider: 'relay.example' })
    expect(settle).not.toHaveBeenCalled()
    await expect(points.getReservation('ws_a', reservationId)).resolves.toMatchObject({ status: 'settled', settledPoints: 3 })
  })

  it.each([
    { metadata: { billing_units: 1 }, providerRequestId: 'image_req_1' },
    { metadata: { usage_observed: true, billing_units: 0 }, providerRequestId: 'image_req_1' },
    { metadata: { usage_observed: true, billing_units: 1 }, providerRequestId: undefined, providerAttemptId: 'attempt_only' },
    { metadata: { usage_observed: true, billing_units: 1, cost_source: 'relay_pricing_snapshot' }, providerRequestId: 'image_req_1' },
  ])('rejects incomplete image usage, cost provenance, or provider identity: %j', async invalid => {
    const { receipts, event, settlement } = await fixture('image_generation.execute')
    await expect(settlement.recordSucceeded(event, {
      modality: 'image', model: 'image-model', ...invalid,
      costCny: 0.2, observedAt: at,
    }, 'image_generation.execute')).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', providerSucceeded: true })
    expect(receipts.recordProviderReceipt).not.toHaveBeenCalled()
  })

  it('requires complete pricing provenance on a derived image cost', async () => {
    const { receipts, event, settlement } = await fixture('image_generation.execute')
    await expect(settlement.recordSucceeded(event, {
      modality: 'image', model: 'image-model', providerRequestId: 'image_priced_1', costCny: 0.2, observedAt: at,
      metadata: { usage_observed: true, billing_units: 2, cost_source: 'relay_pricing_snapshot', pricing_version: 'pricing-v1', pricing_group: 'image', formula_version: 'formula-v1' },
    }, 'image_generation.execute')).resolves.toBe('image_priced_1')
    expect(receipts.recordProviderReceipt).toHaveBeenCalledWith(expect.objectContaining({ cost: { currency: 'CNY', actual: 0.2, cost_source: 'relay_pricing_snapshot', billing_units: 2, pricing_version: 'pricing-v1', pricing_group: 'image', formula_version: 'formula-v1' } }))
  })

  it('rejects persisted image receipts with missing billing or cost provenance before settlement verification', async () => {
    const { receipts, event, settlement } = await fixture('image_generation.execute')
    receipts.getProviderReceipt.mockResolvedValue({
      operationId: 'cpo_test', provider: 'relay.example', providerRequestId: 'image_unproven_1', outcome: 'succeeded',
      usage: { modality: 'image', model: 'image-model' }, cost: { currency: 'CNY', actual: 0.2 }, verifiedAt: at,
    })
    await expect(settlement.settleForDelivery(event, ['image_unproven_1'], 'image_generation.execute')).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', providerRequestId: 'image_unproven_1' })
    expect(receipts.verifyModelUsageDeliverySettlement).not.toHaveBeenCalled()
  })

  it('fails closed when durable API settlement evidence does not match', async () => {
    const { points, receipts, event, reservationId, settlement } = await fixture()
    const requestId = await settlement.recordSucceeded(event, { modality: 'text', model: 'model-1', providerRequestId: 'provider_req_mismatch', costCny: 0.12, observedAt: at })
    await points.settle({ workspaceId: 'ws_a', reservationId, actualPoints: 3, idempotencyKey: 'other-owner', at })
    receipts.verifyModelUsageDeliverySettlement.mockResolvedValue(false)
    const settle = vi.spyOn(points, 'settle')
    await expect(settlement.settleForDelivery(event, [requestId!])).rejects.toMatchObject({ code: 'MODEL_USAGE_SETTLEMENT_EVIDENCE_MISMATCH', providerSucceeded: true, reconciliationRequired: true })
    expect(receipts.verifyModelUsageDeliverySettlement).toHaveBeenCalledOnce()
    expect(settle).not.toHaveBeenCalled()
  })

  it('keeps delivery blocked when a successful result has lost its provider execution context', async () => {
    const settle = vi.fn(async () => {})
    const deliver = vi.fn(async () => {})
    await expect(deliverGenerationResultWithPointSettlement(true, deliver, async () => {
      throw Object.assign(new Error('verified relay receipt is required before creative point settlement'), { code: 'MODEL_USAGE_EVIDENCE_MISSING' })
    })).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING' })
    expect(deliver).toHaveBeenCalledOnce()
    expect(settle).not.toHaveBeenCalled()
  })

  it('detects point charged snapshots that require settlement recovery', async () => {
    const { event } = await fixture()
    expect(requiresCreativePointSettlement(event)).toBe(true)
    event.payload.commercial_access_snapshot = { access_mode: 'POINT_REQUIRED_NO_CHARGE', reservation_id: null }
    expect(requiresCreativePointSettlement(event)).toBe(false)
    event.payload.commercial_access_snapshot = null
    expect(requiresCreativePointSettlement(event)).toBe(false)
  })

  it('rejects delivery when the provider request has no current-operation receipt', async () => {
    const { event, settlement } = await fixture()
    await expect(settlement.settleForDelivery(event, ['provider_missing'])).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', providerRequestId: 'provider_missing' })
  })

  it('rejects ambiguous provider request identities and mismatched action bindings', async () => {
    const { event, settlement, receipts } = await fixture()
    await expect(settlement.settleForDelivery(event, ['provider_a', 'provider_b'])).rejects.toMatchObject({ code: 'MODEL_USAGE_SETTLEMENT_EVIDENCE_MISMATCH' })
    event.payload.action_id = 'other-action'
    await expect(settlement.settleForDelivery(event, ['provider_a'])).rejects.toMatchObject({ code: 'MODEL_USAGE_SETTLEMENT_EVIDENCE_MISMATCH' })
    expect(receipts.verifyModelUsageDeliverySettlement).not.toHaveBeenCalled()
  })

  it('rejects a worker relay identity that collides with the API receipt owner', async () => {
    const { points, receipts, event, reservationId } = await fixture()
    const settlement = new CreativePointRelaySettlement(points, receipts, 'model-relay')
    await expect(settlement.settleForDelivery(event, ['provider_req_1'])).rejects.toMatchObject({ code: 'MODEL_USAGE_SETTLEMENT_EVIDENCE_MISMATCH' })
    expect(receipts.verifyModelUsageDeliverySettlement).not.toHaveBeenCalled()
    await expect(points.getReservation('ws_a', reservationId)).resolves.toMatchObject({ status: 'active' })
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
