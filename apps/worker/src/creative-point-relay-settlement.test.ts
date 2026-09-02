import { describe, expect, it, vi } from 'vitest'
import { MemoryCreativePointRepository } from '../../../packages/persistence/src/creative-point-repository.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import { CreativePointRelaySettlement, relayProviderIdentity } from './creative-point-relay-settlement.js'

const at = '2026-09-02T00:00:00.000Z'

async function fixture() {
  const points = new MemoryCreativePointRepository()
  await points.grant({ workspaceId: 'ws_a', idempotencyKey: 'grant_1', sourceType: 'test', sourceId: 'grant_1', points: 10, at })
  const reserved = await points.reserve({ workspaceId: 'ws_a', idempotencyKey: 'reserve_1', actionKey: 'generation.execute', points: 3, rateCardVersion: 'rate_1', at })
  const receipts = { recordProviderReceipt: vi.fn(async () => undefined) }
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
