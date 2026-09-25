import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MemoryModelUsageRepository } from '../../../packages/persistence/src/model-usage-repository.js'
import type { ApiPersistence } from './server.js'
import { createModelUsageReconciliation } from './model-usage-reconciliation.js'

describe('model usage reconciliation creative point recovery', () => {
  it('replays the API provider receipt and settles an active point hold before finalizing usage', async () => {
    const workspaceId = `ws_usage_point_recovery_${Date.now()}`
    const actionId = `model:generation:point-recovery-${Date.now()}`
    const providerRequestId = `relay-point-recovery-${Date.now()}`
    const observedAt = new Date().toISOString()
    const modelUsage = new MemoryModelUsageRepository()
    const usage = await modelUsage.record({
      workspaceId,
      actionId,
      modality: 'text',
      model: 'relay-text',
      providerRequestId,
      inputTokens: 5,
      outputTokens: 3,
      totalTokens: 8,
      costCny: 0.04,
      customerChargeCny: 0,
      markupMultiplier: 1,
      pricingPolicyRevision: 1,
      settlementStatus: 'pending_wallet',
      observedAt,
    })

    const reservation = {
      id: `cpr_${Date.now()}`,
      workspaceId,
      operationId: `cpo_${Date.now()}`,
      actionKey: actionId,
      rateCardVersion: 'test-v1',
      points: 3,
      status: 'active' as const,
      settledPoints: null as number | null,
      createdAt: observedAt,
      finalizedAt: null,
    }
    const receiptByRequestId = new Map<string, Record<string, unknown>>()
    const recordProviderReceipt = vi.fn(async (input: Record<string, unknown>) => {
      const existing = receiptByRequestId.get(String(input.providerRequestId))
      if (existing && JSON.stringify(existing) !== JSON.stringify(input)) throw Object.assign(new Error('receipt evidence conflict'), { code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
      receiptByRequestId.set(String(input.providerRequestId), input)
    })
    // Model the partial API failure: its immutable provider receipt committed,
    // then the first point settlement attempt failed and left the hold active.
    const initialUsageEvidence = { modality: 'text', model: 'relay-text', input_tokens: 5, output_tokens: 3, total_tokens: 8 }
    const initialCostEvidence = { currency: 'CNY', actual: 0.04 }
    const receiptHash = createHash('sha256').update(JSON.stringify({ providerRequestId, usage: initialUsageEvidence, cost: initialCostEvidence, observedAt })).digest('hex')
    await recordProviderReceipt({
      workspaceId,
      operationId: reservation.operationId,
      provider: 'model-relay',
      providerRequestId,
      outcome: 'succeeded',
      usage: initialUsageEvidence,
      cost: initialCostEvidence,
      receiptHash,
      verifiedAt: observedAt,
      at: observedAt,
    })

    const settlePoints = vi.fn(async (input: { reservationId: string; actualPoints: number }) => {
      expect(input).toMatchObject({ reservationId: reservation.id, actualPoints: 3 })
      reservation.status = 'settled' as never
      reservation.settledPoints = input.actualPoints
      return { value: reservation, balance: { workspaceId, availablePoints: 0, reservedPoints: 0, settledPoints: 3, revision: 2 } }
    })
    const settleAction = vi.fn(async () => { expect(reservation.status).toBe('settled') })
    const action = {
      actionKey: actionId,
      settlement: 'included_quota',
      settlementStatus: 'pending_receipt',
      state: 'settled',
      actorId: 'merchant:test',
    }
    const persistence = {
      modelUsage,
      creativePoints: {
        getReservationByActionKey: vi.fn(async () => reservation),
        settle: settlePoints,
      },
      creativePointLifecycle: { recordProviderReceipt },
      actionLedger: {
        transitionSettlementStatus: vi.fn(async () => undefined),
        settleProviderUsage: settleAction,
      },
    } as unknown as ApiPersistence

    const reconciliation = createModelUsageReconciliation({
      persistence: () => persistence,
      getActionLedgerWithHistoricalImageCompat: vi.fn(async () => ({ action } as never)),
      settlePluginWalletDebit: vi.fn(async () => undefined),
    })

    const result = await reconciliation.runModelUsageReconciliation({ workspaceId, actorId: 'worker:reconcile', limit: 10 })

    expect(result).toMatchObject({ state: 'completed', checked: 1, settled: [usage.id], pending: [] })
    expect(recordProviderReceipt).toHaveBeenCalledTimes(2)
    expect(recordProviderReceipt.mock.calls[1]?.[0]).toMatchObject({
      workspaceId,
      operationId: reservation.operationId,
      provider: 'model-relay',
      providerRequestId,
      outcome: 'succeeded',
      cost: { currency: 'CNY', actual: 0.04 },
    })
    expect(settlePoints).toHaveBeenCalledTimes(1)
    expect(settlePoints.mock.calls[0]?.[0]).toMatchObject({
      workspaceId,
      reservationId: reservation.id,
      idempotencyKey: `commercial.settle:${actionId}`,
      actualPoints: 3,
    })
    expect(settleAction).toHaveBeenCalledTimes(1)
    await expect(modelUsage.list(workspaceId, 10)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: usage.id, settlementStatus: 'settled' }),
    ]))
  })

  it('keeps usage pending when creative point settlement cannot be recovered', async () => {
    const workspaceId = `ws_usage_point_pending_${Date.now()}`
    const actionId = `model:generation:point-pending-${Date.now()}`
    const modelUsage = new MemoryModelUsageRepository()
    const usage = await modelUsage.record({
      workspaceId,
      actionId,
      modality: 'text',
      model: 'relay-text',
      providerRequestId: 'relay-request-pending',
      costCny: 0.04,
      customerChargeCny: 0,
      markupMultiplier: 1,
      pricingPolicyRevision: 1,
      settlementStatus: 'pending_wallet',
    })
    const reservation = {
      id: 'cpr_pending', workspaceId, operationId: 'cpo_pending', actionKey: actionId,
      rateCardVersion: 'test-v1', points: 3, status: 'active' as const,
      settledPoints: null as number | null, createdAt: new Date().toISOString(), finalizedAt: null as string | null,
    }
    const persistence = {
      modelUsage,
      creativePoints: {
        getReservationByActionKey: vi.fn(async () => reservation),
        settle: vi.fn(async () => { throw Object.assign(new Error('point database unavailable'), { code: 'CREATIVE_POINT_BALANCE_UNKNOWN' }) }),
      },
      creativePointLifecycle: { recordProviderReceipt: vi.fn(async () => undefined) },
      actionLedger: { transitionSettlementStatus: vi.fn(async () => undefined), settleProviderUsage: vi.fn(async () => undefined) },
    } as unknown as ApiPersistence
    const action = { actionKey: actionId, settlement: 'included_quota', settlementStatus: 'pending_receipt', state: 'settled', actorId: 'merchant:test' }
    const reconciliation = createModelUsageReconciliation({
      persistence: () => persistence,
      getActionLedgerWithHistoricalImageCompat: vi.fn(async () => ({ action } as never)),
      settlePluginWalletDebit: vi.fn(async () => undefined),
    })

    const result = await reconciliation.runModelUsageReconciliation({ workspaceId, actorId: 'worker:reconcile', limit: 10 })

    expect(result).toMatchObject({ state: 'attention_required', checked: 1, settled: [], pending: [{ usage_id: usage.id, status: 'pending_wallet', code: 'CREATIVE_POINT_BALANCE_UNKNOWN' }] })
    expect(persistence.actionLedger?.settleProviderUsage).not.toHaveBeenCalled()
    await expect(modelUsage.list(workspaceId, 10)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: usage.id, settlementStatus: 'pending_wallet' }),
    ]))
  })

  it('finds already-settled usage whose legacy reconciliation left its point reservation active', async () => {
    const workspaceId = `ws_legacy_point_recovery_${Date.now()}`
    const actionId = `model:generation:legacy-point-recovery-${Date.now()}`
    const providerRequestId = `relay-legacy-point-recovery-${Date.now()}`
    const observedAt = new Date().toISOString()
    const modelUsage = new MemoryModelUsageRepository()
    const usage = await modelUsage.record({
      workspaceId,
      actionId,
      modality: 'text',
      model: 'relay-text',
      providerRequestId,
      inputTokens: 5,
      outputTokens: 3,
      totalTokens: 8,
      costCny: 0.04,
      customerChargeCny: 0,
      markupMultiplier: 1,
      pricingPolicyRevision: 1,
      settlementStatus: 'settled',
      observedAt,
    })
    const reservation = {
      id: 'cpr_legacy_active', workspaceId, operationId: 'cpo_legacy_active', actionKey: actionId,
      rateCardVersion: 'test-v1', points: 3, status: 'active' as const,
      settledPoints: null as number | null, createdAt: observedAt, finalizedAt: null as string | null,
    }
    const recordProviderReceipt = vi.fn(async () => undefined)
    const settle = vi.fn(async () => {
      reservation.status = 'settled' as never
      reservation.settledPoints = 3
      return { value: reservation, balance: { workspaceId, availablePoints: 0, reservedPoints: 0, settledPoints: 3, revision: 2 } }
    })
    const persistence = {
      modelUsage,
      creativePoints: { getReservationByActionKey: vi.fn(async () => reservation), settle },
      creativePointLifecycle: { recordProviderReceipt },
    } as unknown as ApiPersistence
    const reconciliation = createModelUsageReconciliation({
      persistence: () => persistence,
      getActionLedgerWithHistoricalImageCompat: vi.fn(async () => ({ action: undefined, actionKey: actionId })),
      settlePluginWalletDebit: vi.fn(async () => undefined),
    })

    const result = await reconciliation.runModelUsageReconciliation({ workspaceId, actorId: 'worker:reconcile', limit: 10 })

    expect(result).toMatchObject({
      state: 'completed',
      checked: 0,
      settled: [],
      repaired_creative_point_settlements: [usage.id],
      pending: [],
    })
    expect(settle).toHaveBeenCalledTimes(1)
    expect(await modelUsage.list(workspaceId, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: usage.id, settlementStatus: 'settled' }),
    ]))
  })
})
