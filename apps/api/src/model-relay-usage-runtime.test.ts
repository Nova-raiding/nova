import { describe, expect, it, vi } from 'vitest'
import { MemoryCreativePointRepository } from '../../../packages/persistence/src/creative-point-repository.js'
import type { RelayUsageRecord } from '../../../packages/ai/src/relay-usage.js'
import { createRelayUsageRuntime, type RelayUsageRuntimeDependencies } from './model-relay-usage-runtime.js'

async function harness() {
  const creativePoints = new MemoryCreativePointRepository()
  await creativePoints.grant({ workspaceId: 'ws_policy', idempotencyKey: 'grant', sourceType: 'test', sourceId: 'grant', points: 10 })
  const reservation = await creativePoints.reserve({ workspaceId: 'ws_policy', actionKey: 'action', idempotencyKey: 'reserve', points: 3, rateCardVersion: 'approved-v1' })
  const recordProviderReceipt = vi.fn()
  const recordUsageAndSettleBudget = vi.fn(async (input: Record<string, unknown>) => ({ usage: { ...input, id: 'usage', revision: 1, settlementStatus: 'settled' } }))
  const alerts = { upsert: vi.fn(async () => ({})) }
  const persistence = { creativePoints, creativePointLifecycle: { recordProviderReceipt }, modelUsage: { recordUsageAndSettleBudget, record: vi.fn(async () => ({ id: 'pending' })) }, alerts }
  const deps = {
    isProduction: () => true, persistenceReady: async () => undefined, persistence: () => persistence,
    memoryCommercialExtensions: () => ({ getModelMarkupPolicy: async () => ({ multiplier: 1, revision: 1 }) }),
    memoryAlerts: () => alerts, relayPricing: undefined,
    getActionLedgerWithHistoricalImageCompat: async () => ({ action: { settlement: 'included_quota' }, actionKey: 'action' }),
    modelBillingReservations: () => new Map(), persistOperationalAlertNotification: vi.fn(),
  } as unknown as RelayUsageRuntimeDependencies
  return { ...createRelayUsageRuntime(deps), creativePoints, reservation, recordProviderReceipt, recordUsageAndSettleBudget }
}

const usage = (costCny: number | undefined): RelayUsageRecord => ({ workspaceId: 'ws_policy', actionId: 'action', runKey: 'action', modality: 'text', model: 'qwen', providerRequestId: 'request', providerAttemptId: 'attempt-1', inputTokens: 10, outputTokens: 5, totalTokens: 15, costCny, observedAt: new Date().toISOString() })

describe('normal relay point finalization', () => {
  it('replays the first durable observation after receipt commit but before point settlement succeeds', async () => {
    const h = await harness()
    const firstObservedAt = '2026-10-05T01:00:00.000Z'
    h.recordUsageAndSettleBudget.mockImplementation(async input => ({ usage: { ...input, id: 'usage', revision: 1, settlementStatus: 'settled', observedAt: firstObservedAt } }))
    const realSettle = h.creativePoints.settle.bind(h.creativePoints)
    vi.spyOn(h.creativePoints, 'settle').mockRejectedValueOnce(new Error('injected point commit failure')).mockImplementation(realSettle)
    // Simulate the durable receipt's strict immutable replay check.
    let receipt: unknown
    h.recordProviderReceipt.mockImplementation(async input => { if (receipt) expect(input).toEqual(receipt); else receipt = structuredClone(input) })
    const initial = { ...usage(0.25), modality: 'video' as const, observedAt: firstObservedAt }
    await expect(h.recordRelayUsage(initial)).rejects.toThrow('injected point commit failure')
    expect(await h.creativePoints.getReservation('ws_policy', h.reservation.value.id)).toMatchObject({ status: 'active' })
    await h.recordRelayUsage({ ...initial, observedAt: '2026-10-05T01:00:05.000Z' })
    expect(h.recordProviderReceipt).toHaveBeenCalledTimes(2)
    expect(h.recordProviderReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ verifiedAt: firstObservedAt, at: firstObservedAt }))
    expect(await h.creativePoints.getReservation('ws_policy', h.reservation.value.id)).toMatchObject({ status: 'settled', settledPoints: 3 })
  })

  it.each([0, 0.00090156, 0.099999, 0.1])('settles verified %s cost without dropping budget or receipt evidence', async cost => {
    const h = await harness()
    await h.recordRelayUsage(usage(cost))
    const actualPoints = cost < 0.1 ? 0 : 3
    expect(await h.creativePoints.getReservation('ws_policy', h.reservation.value.id)).toMatchObject({ status: 'settled', settledPoints: actualPoints })
    expect(await h.creativePoints.getBalance('ws_policy')).toMatchObject({ availablePoints: 10 - actualPoints, reservedPoints: 0, settledPoints: actualPoints })
    expect(h.recordUsageAndSettleBudget).toHaveBeenCalledWith(expect.objectContaining({ costCny: cost, totalTokens: 15, providerRequestId: 'request', budgetReservationKey: 'action', metadata: { provider_attempt_id: 'attempt-1', run_key: 'action' } }))
    expect(h.recordProviderReceipt).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'succeeded', cost: { currency: 'CNY', actual: cost } }))
    const settledEvent = (await h.creativePoints.listStatement('ws_policy')).items.find(event => event.eventType === 'settled')
    expect(settledEvent?.intent).toMatchObject({ reservation_id: h.reservation.value.id, actual_points: actualPoints, metadata: {
      point_policy_version: 'model.cost_cny_free_lt_0_1.v1', provider_request_id: 'request', cost_cny: cost, modality: 'text',
    } })
    await h.recordRelayUsage(usage(cost))
    expect(h.recordProviderReceipt).toHaveBeenCalledTimes(1)
    expect(await h.creativePoints.getBalance('ws_policy')).toMatchObject({ availablePoints: 10 - actualPoints, reservedPoints: 0 })
  })
  it('retains the reservation for missing cost', async () => {
    const h = await harness()
    await expect(h.recordRelayUsage(usage(undefined))).rejects.toMatchObject({ code: 'MODEL_USAGE_COST_MISSING' })
    expect(await h.creativePoints.getReservation('ws_policy', h.reservation.value.id)).toMatchObject({ status: 'active' })
    expect(h.recordProviderReceipt).not.toHaveBeenCalled()
  })
  it.each([NaN, Infinity, -0.01])('does not settle invalid cost %s as free', async cost => {
    const h = await harness()
    await expect(h.recordRelayUsage(usage(cost))).rejects.toMatchObject({ code: 'MODEL_USAGE_SETTLEMENT_PENDING' })
    expect(await h.creativePoints.getReservation('ws_policy', h.reservation.value.id)).toMatchObject({ status: 'active' })
    expect(h.recordProviderReceipt).not.toHaveBeenCalled()
  })
})
