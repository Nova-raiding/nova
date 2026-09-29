import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MemoryModelUsageRepository } from '../../../packages/persistence/src/model-usage-repository.js'
import type { ApiPersistence } from './server.js'
import { OCR_COST_POINT_POLICY_VERSION, OCR_FREE_THRESHOLD_POINT_POLICY_VERSION } from '../../../packages/application/src/ocr-point-lifecycle.js'
import { createModelUsageReconciliation, roundModelUsageCostForLedger } from './model-usage-reconciliation.js'

function verifiedReceipt(usage: { providerRequestId?: string; modality: string; model: string; inputTokens?: number; outputTokens?: number; totalTokens?: number; costCny?: number; observedAt: string }, operationId: string) {
  return { operationId, provider: 'model-relay', providerRequestId: usage.providerRequestId, outcome: 'succeeded',
    usage: { modality: usage.modality, model: usage.model,
      ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}),
      ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}) },
    cost: { currency: 'CNY', actual: usage.costCny }, verifiedAt: usage.observedAt, receiptHash: 'a'.repeat(64) }
}

describe('model usage reconciliation creative point recovery', () => {
  it.each([
    [0.0000005, 0.000001], [0.0009025, 0.000903], [0.0009015, 0.000902],
    [0.0999995, 0.1], [0.09999949, 0.099999], [0.09999999, 0.1],
    [0.00090156, 0.000902], [0.1, 0.1], [0, 0], [5e-8, 0],
    [Number.MIN_VALUE, 0], [999999.9999994, 999999.999999],
  ])('matches PostgreSQL decimal half rounding for %s', (cost, expected) => {
    expect(roundModelUsageCostForLedger(cost)).toBe(expected)
  })

  it.each([undefined, null, '0.01', NaN, Infinity, -Infinity, -0.000001, 999999.9999995, 1e6, Number.MAX_VALUE])('rejects invalid or overflowing ledger cost %s', cost => {
    expect(roundModelUsageCostForLedger(cost)).toBeNull()
  })

  it('dead-letters an aged pending action with an active points hold and no usage row without releasing the hold', async () => {
    const workspaceId = `ws_usage_orphan_${Date.now()}`
    const actionId = `content-draft:${Date.now()}`
    const createdAt = '2026-09-28T00:00:00.000Z'
    const modelUsage = new MemoryModelUsageRepository()
    const reservation = {
      id: 'cpr_orphan', workspaceId, operationId: 'cpo_orphan', actionKey: actionId,
      rateCardVersion: 'test-v1', points: 3, status: 'active' as const,
      settledPoints: null as number | null, createdAt, finalizedAt: null as string | null,
    }
    const action = {
      id: 'action_orphan', workspaceId, actionKey: actionId, actionKind: 'model_text' as const,
      settlement: 'included_quota' as const, state: 'settled' as const, units: 1, amountFen: 0,
      actorId: 'merchant:test', description: 'draft', createdAt, settlementStatus: 'pending_receipt' as const,
    }
    const markPendingReceiptOrphanForAttention = vi.fn(async () => ({ ...action, settlementStatus: 'manual_attention' as const }))
    const pointSettle = vi.fn()
    const persistence = {
      modelUsage,
      actionLedger: { listPendingReceiptActions: vi.fn(async ({ before }: { before: string }) => Date.parse(action.createdAt) < Date.parse(before) ? [action] : []), markPendingReceiptOrphanForAttention },
      creativePoints: { getReservationByActionKey: vi.fn(async () => reservation), settle: pointSettle },
      creativePointLifecycle: { recordProviderReceipt: vi.fn() },
    } as unknown as ApiPersistence
    const reconciliation = createModelUsageReconciliation({
      persistence: () => persistence,
      getActionLedgerWithHistoricalImageCompat: vi.fn(),
      settlePluginWalletDebit: vi.fn(),
      now: () => '2026-09-29T00:00:00.000Z',
    })

    const result = await reconciliation.runModelUsageReconciliation({ workspaceId, actorId: 'worker:reconcile', limit: 10 })

    expect(result).toMatchObject({
      state: 'attention_required',
      orphaned_actions: [{ action_id: actionId, status: 'manual_attention', code: 'MODEL_USAGE_RECEIPT_ROW_MISSING' }],
    })
    expect(markPendingReceiptOrphanForAttention).toHaveBeenCalledWith({ workspaceId, actionKey: actionId, before: '2026-09-28T23:55:00.000Z' })
    expect(pointSettle).not.toHaveBeenCalled()
    expect(reservation.status).toBe('active')
    await expect(modelUsage.listByAction(workspaceId, actionId)).resolves.toEqual([])
  })

  it('does not dead-letter a pending action during the grace period', async () => {
    const workspaceId = `ws_usage_orphan_grace_${Date.now()}`
    const actionId = `content-draft:${Date.now()}`
    const now = '2026-09-29T00:00:00.000Z'
    const modelUsage = new MemoryModelUsageRepository()
    const action = {
      id: 'action_orphan_grace', workspaceId, actionKey: actionId, actionKind: 'model_text' as const,
      settlement: 'included_quota' as const, state: 'settled' as const, units: 1, amountFen: 0,
      actorId: 'merchant:test', description: 'draft', createdAt: now, settlementStatus: 'pending_receipt' as const,
    }
    const transitionSettlementStatus = vi.fn()
    const reservation = { id: 'cpr_grace', workspaceId, operationId: 'cpo_grace', actionKey: actionId, rateCardVersion: 'test-v1', points: 3, status: 'active' as const, settledPoints: null, createdAt: now, finalizedAt: null }
    const persistence = {
      modelUsage,
      actionLedger: { listPendingReceiptActions: vi.fn(async ({ before }: { before: string }) => Date.parse(action.createdAt) < Date.parse(before) ? [action] : []), transitionSettlementStatus },
      creativePoints: { getReservationByActionKey: vi.fn(async () => reservation) },
      creativePointLifecycle: {},
    } as unknown as ApiPersistence
    const reconciliation = createModelUsageReconciliation({
      persistence: () => persistence,
      getActionLedgerWithHistoricalImageCompat: vi.fn(),
      settlePluginWalletDebit: vi.fn(),
      now: () => now,
    })

    const result = await reconciliation.runModelUsageReconciliation({ workspaceId, actorId: 'worker:reconcile', limit: 10 })

    expect(result).toMatchObject({ state: 'completed', orphaned_actions: [] })
    expect(transitionSettlementStatus).not.toHaveBeenCalled()
  })

  it('does not classify an action as orphaned when an action-linked usage row exists', async () => {
    const workspaceId = `ws_usage_orphan_has_usage_${Date.now()}`
    const actionId = `content-draft:${Date.now()}`
    const createdAt = '2026-09-28T00:00:00.000Z'
    const modelUsage = new MemoryModelUsageRepository()
    await modelUsage.record({ workspaceId, actionId, modality: 'text', model: 'relay-text', settlementStatus: 'manual_attention', observedAt: createdAt })
    const action = {
      id: 'action_orphan_has_usage', workspaceId, actionKey: actionId, actionKind: 'model_text' as const,
      settlement: 'included_quota' as const, state: 'settled' as const, units: 1, amountFen: 0,
      actorId: 'merchant:test', description: 'draft', createdAt, settlementStatus: 'pending_receipt' as const,
    }
    const transitionSettlementStatus = vi.fn()
    const reservation = { id: 'cpr_has_usage', workspaceId, operationId: 'cpo_has_usage', actionKey: actionId, rateCardVersion: 'test-v1', points: 3, status: 'active' as const, settledPoints: null, createdAt, finalizedAt: null }
    const persistence = {
      modelUsage,
      actionLedger: { listPendingReceiptActions: vi.fn(async () => [action]), transitionSettlementStatus },
      creativePoints: { getReservationByActionKey: vi.fn(async () => reservation) },
      creativePointLifecycle: {},
    } as unknown as ApiPersistence
    const reconciliation = createModelUsageReconciliation({
      persistence: () => persistence,
      getActionLedgerWithHistoricalImageCompat: vi.fn(),
      settlePluginWalletDebit: vi.fn(),
      now: () => '2026-09-29T00:00:00.000Z',
    })

    const result = await reconciliation.runModelUsageReconciliation({ workspaceId, actorId: 'worker:reconcile', limit: 10 })

    expect(result).toMatchObject({ orphaned_actions: [] })
    expect(transitionSettlementStatus).not.toHaveBeenCalled()
  })

  it.each([[0, 0], [0.099999, 0], [0.1, 3], [0.11, 3]])('replays the API receipt at cost %s and settles %s points before finalizing usage', async (costCny, actualPoints) => {
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
      costCny,
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
    const initialCostEvidence = { currency: 'CNY', actual: costCny }
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
      expect(input).toMatchObject({ reservationId: reservation.id, actualPoints })
      reservation.status = 'settled' as never
      reservation.settledPoints = input.actualPoints
      return { value: reservation, balance: { workspaceId, availablePoints: 0, reservedPoints: 0, settledPoints: actualPoints, revision: 2 } }
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
      creativePointLifecycle: { recordProviderReceipt, getProviderReceipt: vi.fn(async () => receiptByRequestId.get(providerRequestId)) },
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
    expect(recordProviderReceipt).toHaveBeenCalledTimes(1)
    expect(recordProviderReceipt.mock.calls[0]?.[0]).toMatchObject({
      workspaceId,
      operationId: reservation.operationId,
      provider: 'model-relay',
      providerRequestId,
      outcome: 'succeeded',
      cost: { currency: 'CNY', actual: costCny },
    })
    expect(settlePoints).toHaveBeenCalledTimes(1)
    expect(settlePoints.mock.calls[0]?.[0]).toMatchObject({
      workspaceId,
      reservationId: reservation.id,
      idempotencyKey: `commercial.settle:${actionId}`,
      actualPoints,
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
      creativePointLifecycle: { recordProviderReceipt: vi.fn(async () => undefined), getProviderReceipt: vi.fn(async () => verifiedReceipt(usage, reservation.operationId)) },
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

  it.each([[0, 0], [0.099999, 0], [0.1, 3], [0.11, 3]])('repairs settled usage at cost %s with %s points using the same threshold', async (costCny, actualPoints) => {
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
      costCny,
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
      reservation.settledPoints = actualPoints
      return { value: reservation, balance: { workspaceId, availablePoints: 0, reservedPoints: 0, settledPoints: actualPoints, revision: 2 } }
    })
    const persistence = {
      modelUsage,
      creativePoints: { getReservationByActionKey: vi.fn(async () => reservation), settle },
      creativePointLifecycle: { recordProviderReceipt, getProviderReceipt: vi.fn(async () => verifiedReceipt(usage, reservation.operationId)) },
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
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ actualPoints }))
    expect(recordProviderReceipt).not.toHaveBeenCalled()
    expect(await modelUsage.list(workspaceId, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: usage.id, settlementStatus: 'settled' }),
    ]))
  })

  it.each([undefined, null, NaN, Infinity, -0.01, '0.01'])('keeps invalid cost %s from settling points, wallet, budget or usage', async costCny => {
    const usage = { id: 'usage_invalid', workspaceId: 'ws_invalid', actionId: 'model:invalid', revision: 1,
      costCny, customerChargeCny: 0, providerRequestId: 'provider-invalid', budgetReservationKey: 'budget', budgetRunKey: 'run' }
    const settle = vi.fn(), resolve = vi.fn(), recordProviderReceipt = vi.fn(), recordUsageAndSettleBudget = vi.fn()
    const settlePluginWalletDebit = vi.fn()
    const persistence = {
      modelUsage: { list: vi.fn(async () => [usage]), resolve, recordUsageAndSettleBudget },
      creativePoints: { getReservationByActionKey: vi.fn(async () => ({ status: 'active', points: 3 })), settle },
      creativePointLifecycle: { recordProviderReceipt, getProviderReceipt: vi.fn() },
    } as unknown as ApiPersistence
    const reconciliation = createModelUsageReconciliation({ persistence: () => persistence,
      getActionLedgerWithHistoricalImageCompat: vi.fn(), settlePluginWalletDebit })
    await expect(reconciliation.settlePendingModelUsage({ workspaceId: 'ws_invalid', usageId: usage.id,
      actorId: 'worker', expectedRevision: 1 })).rejects.toMatchObject({ code: 'MODEL_USAGE_COST_MISSING' })
    for (const mutation of [settle, resolve, recordProviderReceipt, recordUsageAndSettleBudget, settlePluginWalletDebit]) {
      expect(mutation).not.toHaveBeenCalled()
    }
  })

  it.each([
    [OCR_FREE_THRESHOLD_POINT_POLICY_VERSION, 0.1, 0],
    [OCR_FREE_THRESHOLD_POINT_POLICY_VERSION, 0.3, 0],
    [OCR_FREE_THRESHOLD_POINT_POLICY_VERSION, 0.300001, 1],
    [OCR_COST_POINT_POLICY_VERSION, 0.04, 1],
  ])('preserves OCR policy %s at cost %s with %s points', async (policyVersion, costCny, actualPoints) => {
    vi.stubEnv('MODEL_MAX_TASK_COST_CNY', '2')
    try {
      const modelUsage = new MemoryModelUsageRepository()
      const usage = await modelUsage.record({ workspaceId: 'ws_ocr_recovery', actionId: 'ocr:recovery',
        modality: 'ocr', model: 'relay-ocr', providerRequestId: 'provider-ocr', costCny,
        customerChargeCny: 0, settlementStatus: 'settled' })
      const settle = vi.fn(), recordProviderReceipt = vi.fn()
      const persistence = { modelUsage,
        creativePoints: { getReservationByActionKey: vi.fn(async () => ({ id: 'ocr_reservation',
          operationId: 'ocr_operation', workspaceId: usage.workspaceId, actionKey: usage.actionId, status: 'active', points: 4, rateCardVersion: `${policyVersion}:test` })), settle },
        creativePointLifecycle: { recordProviderReceipt, getProviderReceipt: vi.fn(async () => verifiedReceipt(usage, 'ocr_operation')) },
      } as unknown as ApiPersistence
      const reconciliation = createModelUsageReconciliation({ persistence: () => persistence,
        getActionLedgerWithHistoricalImageCompat: vi.fn(), settlePluginWalletDebit: vi.fn() })
      const result = await reconciliation.runModelUsageReconciliation({ workspaceId: usage.workspaceId, actorId: 'worker', limit: 10 })
      expect(result).toMatchObject({ state: 'completed', repaired_creative_point_settlements: [usage.id] })
      expect(settle).toHaveBeenCalledWith(expect.objectContaining({ actualPoints }))
      expect(recordProviderReceipt).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs() }
  })


  it.each(['pending_wallet', 'settled'] as const)('uses original precision for %s recovery and rejects mismatched receipts', async settlementStatus => {
    for (const [originalCost, storedCost] of [[0.00090156, 0.000902], [0.09999999, 0.1], [0.1, 0.1],
      [0.0000005, 0.000001], [0.0009025, 0.000903], [0.0009015, 0.000902], [0.0999995, 0.1]] as const) {
      const modelUsage = new MemoryModelUsageRepository()
      const usage = await modelUsage.record({ workspaceId: 'ws_precision', actionId: 'text:precision', modality: 'text',
        model: 'relay-text', providerRequestId: 'request-precision', inputTokens: 7, costCny: storedCost,
        customerChargeCny: 0, settlementStatus })
      const reservation = { workspaceId: usage.workspaceId, actionKey: usage.actionId, operationId: 'operation-precision',
        id: 'reservation-precision', status: 'active', points: 3, rateCardVersion: 'test-v1' }
      const originalReceipt = verifiedReceipt({ ...usage, costCny: originalCost }, reservation.operationId)
      let receipt: unknown = originalReceipt
      const settle = vi.fn(async () => { reservation.status = 'settled' })
      const recordProviderReceipt = vi.fn()
      const persistence = { modelUsage, creativePoints: { getReservationByActionKey: vi.fn(async () => reservation), settle },
        creativePointLifecycle: { getProviderReceipt: vi.fn(async () => receipt), recordProviderReceipt },
        actionLedger: { settleProviderUsage: vi.fn() },
      } as unknown as ApiPersistence
      const reconciliation = createModelUsageReconciliation({ persistence: () => persistence,
        getActionLedgerWithHistoricalImageCompat: vi.fn(async () => ({ action: { settlement: 'included_quota', settlementStatus: 'pending_receipt' } } as never)),
        settlePluginWalletDebit: vi.fn() })
      for (const invalid of [null, { ...originalReceipt, operationId: 'other' }, { ...originalReceipt, provider: 'other' },
        { ...originalReceipt, providerRequestId: 'other' }, { ...originalReceipt, outcome: 'unknown' },
        { ...originalReceipt, verifiedAt: null }, { ...originalReceipt, receiptHash: '' },
        { ...originalReceipt, usage: { ...originalReceipt.usage, model: 'other' } },
        { ...originalReceipt, usage: { ...originalReceipt.usage, input_tokens: 8 } },
        { ...originalReceipt, cost: { currency: 'CNY', actual: 0.2 } }]) {
        receipt = invalid
        const result = await reconciliation.runModelUsageReconciliation({ workspaceId: usage.workspaceId, actorId: 'worker', limit: 10 })
        expect(result.state).toBe('attention_required')
        expect(settle).not.toHaveBeenCalled()
        // Allow the pending branch to be retried without waiting for backoff.
        if (settlementStatus === 'pending_wallet') await modelUsage.resolve({ workspaceId: usage.workspaceId, id: usage.id,
          expectedRevision: (await modelUsage.list(usage.workspaceId, 10))[0]!.revision, status: 'pending_wallet', actorId: 'worker', reason: 'test retry', nextAttemptAt: '2020-01-01T00:00:00Z' })
      }
      receipt = originalReceipt
      const result = await reconciliation.runModelUsageReconciliation({ workspaceId: usage.workspaceId, actorId: 'worker', limit: 10 })
      expect(result.state).toBe('completed')
      expect(settle).toHaveBeenCalledWith(expect.objectContaining({ actualPoints: originalCost < 0.1 ? 0 : 3,
        metadata: expect.objectContaining({ cost_cny: originalCost, receipt_hash: originalReceipt.receiptHash }) }))
      expect(recordProviderReceipt).not.toHaveBeenCalled()
    }
  })

})
