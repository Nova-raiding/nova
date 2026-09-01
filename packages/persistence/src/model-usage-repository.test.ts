import { describe, expect, it } from 'vitest'
import { allowedModelUsageSettlementDecisions, MemoryModelUsageRepository, ModelCostBudgetActualExceededError, ModelCostBudgetExceededError, ModelRunCostBudgetActualExceededError, ModelRunCostBudgetExceededError, PostgresModelUsageRepository } from './model-usage-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

type Row = Record<string, unknown>

class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly responses: Array<{ rows: Row[]; rowCount?: number }> = []
  enqueue(rows: Row[] = [], rowCount?: number) { this.responses.push({ rows, ...(rowCount === undefined ? {} : { rowCount }) }) }
  async query<RowType = Row>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return (this.responses.shift() ?? { rows: [] }) as { rows: RowType[]; rowCount?: number }
  }
  release() {}
}

class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

const postgresUsageRow = (overrides: Row = {}) => ({
  id: 'usage_1', workspace_id: 'ws_usage', receipt_key: 'receipt_1', receipt_hash: 'a'.repeat(64), action_id: 'action_1', context_link_id: null, context_hash: null,
  modality: 'image', model: 'relay-image', provider_request_id: 'provider_1', input_tokens: null, output_tokens: null, total_tokens: null, cost_cny: null,
  markup_multiplier: null, customer_charge_cny: null, pricing_policy_revision: null, settlement_status: 'pending_cost', attempt_count: 0, last_error: null,
  next_attempt_at: null, claim_owner: null, claim_expires_at: null, revision: 1, resolved_by: null, resolution_reason: null, resolution_evidence_ref: null,
  resolved_at: null, observed_at: '2026-08-31T00:00:00.000Z', metadata: null, ...overrides,
})

describe('MemoryModelUsageRepository', () => {
  it('defines the authoritative operations decisions for each settlement state', () => {
    expect(allowedModelUsageSettlementDecisions({ settlementStatus: 'pending_cost' })).toEqual(['waive', 'manual_attention'])
    expect(allowedModelUsageSettlementDecisions({ settlementStatus: 'pending_wallet', costCny: 0.02, customerChargeCny: 0.05 })).toEqual(['retry', 'manual_attention'])
    expect(allowedModelUsageSettlementDecisions({ settlementStatus: 'pending_wallet', costCny: 0.02 })).toEqual(['manual_attention'])
    expect(allowedModelUsageSettlementDecisions({ settlementStatus: 'manual_attention' })).toEqual(['waive'])
    expect(allowedModelUsageSettlementDecisions({ settlementStatus: 'manual_attention', costCny: 0.02, customerChargeCny: 0.05 })).toEqual(['retry'])
    expect(allowedModelUsageSettlementDecisions({ settlementStatus: 'settled', costCny: 0.02, customerChargeCny: 0.05 })).toEqual([])
    expect(allowedModelUsageSettlementDecisions({ settlementStatus: 'waived' })).toEqual([])
  })

  it('deduplicates exact callbacks, rejects conflicting receipts, and scopes records by workspace', async () => {
    const repository = new MemoryModelUsageRepository()
    const first = await repository.record({ workspaceId: 'ws_usage', actionId: 'task_1', modality: 'text', model: 'relay-text', providerRequestId: 'req_1', inputTokens: 10, outputTokens: 5, totalTokens: 15, costCny: 0.01, markupMultiplier: 2.5, customerChargeCny: 0.025, pricingPolicyRevision: 1 })
    const replay = await repository.record({ workspaceId: 'ws_usage', actionId: 'task_1', modality: 'text', model: 'relay-text', providerRequestId: 'req_1', inputTokens: 10, outputTokens: 5, totalTokens: 15, costCny: 0.01 })
    expect(replay).toEqual(first)
    await expect(repository.record({ workspaceId: 'ws_usage', actionId: 'other_task', modality: 'text', model: 'relay-text', providerRequestId: 'req_1', totalTokens: 198, costCny: 9 })).rejects.toThrow('MODEL_USAGE_IDEMPOTENCY_CONFLICT')
    expect(first.customerChargeCny).toBe(0.025)
    expect(await repository.list('ws_usage')).toHaveLength(1)
    expect(await repository.list('ws_other')).toHaveLength(0)
  })

  it('stores context linkage as first-class fields and rejects partial or conflicting linkage', async () => {
    const repository = new MemoryModelUsageRepository()
    const context = { contextLinkId: 'context_link_1', contextHash: 'a'.repeat(64) }
    const first = await repository.record({ workspaceId: 'ws_context', actionId: 'action_1', ...context, modality: 'text', model: 'relay-text', providerRequestId: 'req_context', costCny: 0.01 })
    expect(first).toMatchObject(context)
    await expect(repository.record({ workspaceId: 'ws_context', actionId: 'action_1', contextLinkId: 'context_link_1', modality: 'text', model: 'relay-text', providerRequestId: 'req_partial', costCny: 0.01 })).rejects.toThrow('MODEL_USAGE_CONTEXT_PAIR_REQUIRED')
    await expect(repository.record({ workspaceId: 'ws_context', actionId: 'action_1', contextLinkId: 'context_link_2', contextHash: context.contextHash, modality: 'text', model: 'relay-text', providerRequestId: 'req_context', costCny: 0.01 })).rejects.toThrow('MODEL_USAGE_CONTEXT_CONFLICT')
  })

  it('binds usage to an existing budget reservation and rejects linkage drift', async () => {
    const repository = new MemoryModelUsageRepository()
    await repository.reserveDailyBudget({ workspaceId: 'ws_budget_link', reservationKey: 'reservation_1', runKey: 'run_1', modality: 'text', model: 'relay-text', estimateCny: 0.1, estimateVersion: 'pricing-v1', dailyLimitCny: 1, runLimitCny: 0.5 })
    const linked = await repository.record({ workspaceId: 'ws_budget_link', actionId: 'action_1', budgetReservationKey: 'reservation_1', budgetRunKey: 'run_1', modality: 'text', model: 'relay-text', providerRequestId: 'provider_linked', costCny: 0.08 })
    expect(linked).toMatchObject({ budgetReservationKey: 'reservation_1', budgetRunKey: 'run_1' })
    await expect(repository.record({ workspaceId: 'ws_budget_link', actionId: 'action_1', budgetReservationKey: 'reservation_1', budgetRunKey: 'wrong_run', modality: 'text', model: 'relay-text', providerRequestId: 'provider_linked', costCny: 0.08 })).rejects.toThrow('MODEL_USAGE_BUDGET_LINK_CONFLICT')
    await expect(repository.record({ workspaceId: 'ws_budget_link', actionId: 'action_2', budgetReservationKey: 'missing', budgetRunKey: 'run_1', modality: 'text', model: 'relay-text', providerRequestId: 'provider_missing', costCny: 0.01 })).rejects.toThrow('MODEL_USAGE_BUDGET_LINK_CONFLICT')
  })

  it('records and settles one exact provider receipt atomically without advancing either revision on replay', async () => {
    const repository = new MemoryModelUsageRepository()
    await repository.reserveDailyBudget({ workspaceId: 'ws_atomic_replay', reservationKey: 'reservation_1', runKey: 'run_1', modality: 'text', model: 'relay-text', estimateCny: 0.4, estimateVersion: 'pricing-v4', dailyLimitCny: 5, runLimitCny: 1, at: '2026-08-29T01:00:00.000Z' })
    const receipt = { workspaceId: 'ws_atomic_replay', actionId: 'action_1', budgetReservationKey: 'reservation_1', budgetRunKey: 'run_1', modality: 'text' as const, model: 'relay-text', providerRequestId: 'provider_exact', inputTokens: 10, outputTokens: 5, totalTokens: 15, costCny: 0.3, settlementStatus: 'pending_wallet' as const, observedAt: '2026-08-29T01:01:00.000Z' }

    const first = await repository.recordUsageAndSettleBudget(receipt)
    const replay = await repository.recordUsageAndSettleBudget(receipt)

    expect(first).toMatchObject({ usage: { providerRequestId: 'provider_exact', costCny: 0.3, budgetReservationKey: 'reservation_1' }, reservation: { status: 'settled', actualCostCny: 0.3 }, snapshot: { requestCny: 0.3 }, runSnapshot: { requestCny: 0.3 } })
    expect(replay.usage.id).toBe(first.usage.id)
    expect(replay.usage.revision).toBe(first.usage.revision)
    expect(replay.reservation.revision).toBe(first.reservation.revision)
    expect(await repository.list('ws_atomic_replay')).toHaveLength(1)
  })

  it('rejects cost or budget-link drift for the same atomic receipt', async () => {
    const repository = new MemoryModelUsageRepository()
    const budget = { workspaceId: 'ws_atomic_conflict', runKey: 'run_1', modality: 'text' as const, model: 'relay-text', estimateCny: 0.4, estimateVersion: 'pricing-v4', dailyLimitCny: 5, runLimitCny: 2, at: '2026-08-29T01:00:00.000Z' }
    await repository.reserveDailyBudget({ ...budget, reservationKey: 'reservation_1' })
    await repository.reserveDailyBudget({ ...budget, reservationKey: 'reservation_2' })
    const receipt = { workspaceId: budget.workspaceId, actionId: 'action_1', budgetReservationKey: 'reservation_1', budgetRunKey: budget.runKey, modality: budget.modality, model: budget.model, providerRequestId: 'provider_conflict', totalTokens: 10, costCny: 0.2, settlementStatus: 'pending_wallet' as const, observedAt: '2026-08-29T01:01:00.000Z' }
    await repository.recordUsageAndSettleBudget(receipt)

    await expect(repository.recordUsageAndSettleBudget({ ...receipt, costCny: 0.21 })).rejects.toThrow('MODEL_USAGE_COST_CONFLICT')
    await expect(repository.recordUsageAndSettleBudget({ ...receipt, budgetReservationKey: 'reservation_2' })).rejects.toThrow('MODEL_USAGE_BUDGET_LINK_CONFLICT')
    expect(await repository.list(budget.workspaceId)).toHaveLength(1)
  })

  it('sums multiple immutable receipts linked to one reservation', async () => {
    const repository = new MemoryModelUsageRepository()
    const workspaceId = 'ws_atomic_cumulative'
    await repository.reserveDailyBudget({ workspaceId, reservationKey: 'reservation_1', runKey: 'run_1', modality: 'image', model: 'relay-image', estimateCny: 0.8, estimateVersion: 'pricing-v4', dailyLimitCny: 5, runLimitCny: 2, at: '2026-08-29T01:00:00.000Z' })
    const common = { workspaceId, actionId: 'action_1', budgetReservationKey: 'reservation_1', budgetRunKey: 'run_1', modality: 'image' as const, model: 'relay-image', settlementStatus: 'pending_wallet' as const }
    const first = await repository.recordUsageAndSettleBudget({ ...common, providerRequestId: 'provider_part_1', costCny: 0.25, observedAt: '2026-08-29T01:01:00.000Z' })
    const firstReservationRevision = first.reservation.revision
    const firstActualCostCny = first.reservation.actualCostCny
    const second = await repository.recordUsageAndSettleBudget({ ...common, providerRequestId: 'provider_part_2', costCny: 0.35, observedAt: '2026-08-29T01:02:00.000Z' })

    expect(firstActualCostCny).toBe(0.25)
    expect(second.reservation).toMatchObject({ actualCostCny: 0.6, status: 'settled' })
    expect(second.reservation.revision).toBe(firstReservationRevision + 1)
    expect(await repository.list(workspaceId)).toHaveLength(2)
  })

  it('keeps an atomic actual overrun and its receipt durable after throwing', async () => {
    const repository = new MemoryModelUsageRepository()
    const reservation = { workspaceId: 'ws_atomic_overrun', reservationKey: 'reservation_1', runKey: 'run_1', modality: 'video' as const, model: 'relay-video', estimateCny: 0.5, estimateVersion: 'pricing-v4', dailyLimitCny: 10, runLimitCny: 1, at: '2026-08-29T01:00:00.000Z' }
    await repository.reserveDailyBudget(reservation)

    await expect(repository.recordUsageAndSettleBudget({ workspaceId: reservation.workspaceId, actionId: 'action_1', budgetReservationKey: reservation.reservationKey, budgetRunKey: reservation.runKey, modality: reservation.modality, model: reservation.model, providerRequestId: 'provider_overrun', costCny: 1.2, settlementStatus: 'pending_wallet', observedAt: '2026-08-29T01:01:00.000Z' })).rejects.toBeInstanceOf(ModelRunCostBudgetActualExceededError)

    expect(await repository.list(reservation.workspaceId)).toEqual([expect.objectContaining({ providerRequestId: 'provider_overrun', costCny: 1.2 })])
    await expect(repository.reserveDailyBudget(reservation)).resolves.toMatchObject({ reused: true, reservation: { status: 'over_budget', overBudgetReason: 'run', actualCostCny: 1.2 } })
  })

  it('does not release an active reservation after a linked provider receipt is durable', async () => {
    const repository = new MemoryModelUsageRepository()
    const workspaceId = 'ws_atomic_release_guard'
    await repository.reserveDailyBudget({ workspaceId, reservationKey: 'reservation_1', runKey: 'run_1', modality: 'ocr', model: 'relay-ocr', estimateCny: 0.2, estimateVersion: 'pricing-v4', dailyLimitCny: 5, runLimitCny: 1 })
    await repository.record({ workspaceId, actionId: 'action_1', budgetReservationKey: 'reservation_1', budgetRunKey: 'run_1', modality: 'ocr', model: 'relay-ocr', providerRequestId: 'provider_recorded_before_crash', costCny: 0.1, settlementStatus: 'pending_wallet' })

    await expect(repository.releaseDailyBudget({ workspaceId, reservationKey: 'reservation_1' })).resolves.toMatchObject({ status: 'active' })
    await expect(repository.recordUsageAndSettleBudget({ workspaceId, actionId: 'action_1', budgetReservationKey: 'reservation_1', budgetRunKey: 'run_1', modality: 'ocr', model: 'relay-ocr', providerRequestId: 'provider_recorded_before_crash', costCny: 0.1, settlementStatus: 'pending_wallet' })).resolves.toMatchObject({ reservation: { status: 'settled', actualCostCny: 0.1 } })
  })

  it('keeps one shared run cap across UTC days when daily and run limits are equal during atomic settlement', async () => {
    const repository = new MemoryModelUsageRepository()
    const base = { workspaceId: 'ws_atomic_cross_day', runKey: 'run_cross_day', modality: 'video' as const, model: 'relay-video', estimateVersion: 'pricing-v4', dailyLimitCny: 1, runLimitCny: 1 }
    await repository.reserveDailyBudget({ ...base, reservationKey: 'day_one', estimateCny: 0.4, at: '2026-08-29T23:59:00.000Z' })
    await repository.recordUsageAndSettleBudget({ workspaceId: base.workspaceId, actionId: 'action_day_one', budgetReservationKey: 'day_one', budgetRunKey: base.runKey, modality: base.modality, model: base.model, providerRequestId: 'provider_day_one_atomic', costCny: 0.4, settlementStatus: 'pending_wallet', observedAt: '2026-08-29T23:59:30.000Z' })
    await repository.reserveDailyBudget({ ...base, reservationKey: 'day_two', estimateCny: 0.5, at: '2026-08-30T00:01:00.000Z' })
    await repository.recordUsageAndSettleBudget({ workspaceId: base.workspaceId, actionId: 'action_day_two', budgetReservationKey: 'day_two', budgetRunKey: base.runKey, modality: base.modality, model: base.model, providerRequestId: 'provider_day_two_atomic', costCny: 0.5, settlementStatus: 'pending_wallet', observedAt: '2026-08-30T00:01:30.000Z' })

    await expect(repository.reserveDailyBudget({ ...base, reservationKey: 'day_two_blocked', estimateCny: 0.2, at: '2026-08-30T00:02:00.000Z' })).rejects.toBeInstanceOf(ModelRunCostBudgetExceededError)
  })

  it('scans every receipt for an action without the workspace list limit', async () => {
    const repository = new MemoryModelUsageRepository()
    for (let index = 0; index < 1_005; index += 1) {
      await repository.record({ workspaceId: 'ws_action_scan', actionId: 'action_full_scan', modality: 'text', model: 'relay-text', providerRequestId: `receipt_${index}`, totalTokens: 1, costCny: 0.01, observedAt: `2026-08-29T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z` })
    }
    await repository.record({ workspaceId: 'ws_action_scan', actionId: 'other_action', modality: 'text', model: 'relay-text', providerRequestId: 'other_receipt', totalTokens: 1, costCny: 1 })
    await repository.record({ workspaceId: 'ws_other', actionId: 'action_full_scan', modality: 'text', model: 'relay-text', providerRequestId: 'other_workspace_receipt', totalTokens: 1, costCny: 1 })

    const rows = await repository.listByAction('ws_action_scan', 'action_full_scan')
    expect(rows).toHaveLength(1_005)
    expect(rows.every(row => row.workspaceId === 'ws_action_scan' && row.actionId === 'action_full_scan')).toBe(true)
    expect(rows[0]?.observedAt).toBe('2026-08-29T00:16:44.000Z')
    await expect(repository.listByAction('ws_action_scan', '  ')).rejects.toThrow('MODEL_USAGE_ACTION_REQUIRED')
  })

  it('fills a pending-cost receipt once and exposes it to the wallet settlement queue', async () => {
    const repository = new MemoryModelUsageRepository()
    const pending = await repository.record({ workspaceId: 'ws_pending', actionId: 'task_pending', modality: 'text', model: 'relay-text', providerRequestId: 'req_pending', totalTokens: 12 })
    expect(pending.settlementStatus).toBe('pending_cost')
    const completedReceipt = await repository.record({ workspaceId: 'ws_pending', actionId: 'task_pending', modality: 'text', model: 'relay-text', providerRequestId: 'req_pending', totalTokens: 12, costCny: 0.02, settlementStatus: 'pending_wallet' })
    expect(completedReceipt).toMatchObject({ costCny: 0.02, settlementStatus: 'pending_wallet', revision: 2 })
    const claimed = await repository.claimPending({ workspaceId: 'ws_pending', owner: 'worker-1' })
    expect(claimed[0]).toMatchObject({ id: pending.id, claimOwner: 'worker-1', attemptCount: 1 })
    const claimedRevision = claimed[0]!.revision
    const settled = await repository.resolve({ workspaceId: 'ws_pending', id: pending.id, expectedRevision: claimedRevision, status: 'settled', actorId: 'worker-1', reason: '钱包与行动账本已结算', evidenceRef: 'relay://req_pending' })
    expect(settled).toMatchObject({ settlementStatus: 'settled', resolvedBy: 'worker-1', revision: claimedRevision + 1 })
  })

  it('rejects settled without a final cost while allowing an explicitly waived empty-cost receipt', async () => {
    const repository = new MemoryModelUsageRepository()
    const blocked = await repository.record({ workspaceId: 'ws_cost_invariant', modality: 'image', model: 'relay-image', providerRequestId: 'provider_missing_cost' })

    await expect(repository.resolve({ workspaceId: blocked.workspaceId, id: blocked.id, expectedRevision: blocked.revision, status: 'settled', actorId: 'reconciler', reason: 'must not settle without cost' }))
      .rejects.toThrow('MODEL_USAGE_SETTLED_COST_REQUIRED')
    expect((await repository.list(blocked.workspaceId))[0]).toMatchObject({ settlementStatus: 'pending_cost', revision: blocked.revision })

    const waived = await repository.resolve({ workspaceId: blocked.workspaceId, id: blocked.id, expectedRevision: blocked.revision, status: 'waived', actorId: 'finance-reviewer', reason: 'provider confirmed no charge', evidenceRef: 'ticket://waiver-1' })
    expect(waived).toMatchObject({ settlementStatus: 'waived', resolvedBy: 'finance-reviewer' })
    expect(waived.costCny).toBeUndefined()

    const free = await repository.record({ workspaceId: 'ws_cost_invariant', modality: 'image', model: 'relay-image', providerRequestId: 'provider_zero_cost' })
    await expect(repository.resolve({ workspaceId: free.workspaceId, id: free.id, expectedRevision: free.revision, status: 'settled', costCny: 0, actorId: 'reconciler', reason: 'provider reported zero actual cost' }))
      .resolves.toMatchObject({ settlementStatus: 'settled', costCny: 0 })
  })

  it('reserves idempotently and settles the matching action to provider actual cost', async () => {
    const repository = new MemoryModelUsageRepository()
    const request = { workspaceId: 'ws_budget', reservationKey: 'action_1', modality: 'text' as const, model: 'relay-text', estimateCny: 0.6, estimateVersion: 'pricing-v1', dailyLimitCny: 1, at: '2026-08-29T01:00:00.000Z' }
    const first = await repository.reserveDailyBudget(request)
    const retry = await repository.reserveDailyBudget(request)
    expect(retry).toMatchObject({ reused: true, reservation: { revision: first.reservation.revision } })
    const settled = await repository.settleDailyBudget({ workspaceId: 'ws_budget', reservationKey: 'action_1', actualCostCny: 0.4, providerRequestId: 'provider_1' })
    expect(settled.reservation).toMatchObject({ status: 'settled', actualCostCny: 0.4, providerRequestId: 'provider_1' })
    const settledRetry = await repository.settleDailyBudget({ workspaceId: 'ws_budget', reservationKey: 'action_1', actualCostCny: 0.4, providerRequestId: 'provider_1' })
    expect(settledRetry.reservation.revision).toBe(settled.reservation.revision)
  })

  it('updates one action budget with cumulative costs from multiple provider receipts', async () => {
    const repository = new MemoryModelUsageRepository()
    await repository.reserveDailyBudget({ workspaceId: 'ws_repairs', reservationKey: 'action_repairs', modality: 'text', model: 'relay-text', estimateCny: 0.6, estimateVersion: 'pricing-v1', dailyLimitCny: 2, at: '2026-08-29T01:00:00.000Z' })
    const first = await repository.settleDailyBudget({ workspaceId: 'ws_repairs', reservationKey: 'action_repairs', actualCostCny: 0.4, providerRequestId: 'provider_first' })
    const firstRevision = first.reservation.revision
    const repaired = await repository.settleDailyBudget({ workspaceId: 'ws_repairs', reservationKey: 'action_repairs', actualCostCny: 0.65, providerRequestId: 'provider_repair' })

    expect(repaired.reservation).toMatchObject({ status: 'settled', actualCostCny: 0.65, providerRequestId: 'provider_repair', revision: firstRevision + 1 })
    await expect(repository.settleDailyBudget({ workspaceId: 'ws_repairs', reservationKey: 'action_repairs', actualCostCny: 0.39, providerRequestId: 'provider_stale' })).rejects.toThrow('MODEL_COST_BUDGET_SETTLEMENT_CONFLICT')
    await expect(repository.settleDailyBudget({ workspaceId: 'ws_repairs', reservationKey: 'action_repairs', actualCostCny: 0.7, providerRequestId: 'provider_repair' })).rejects.toThrow('MODEL_COST_BUDGET_SETTLEMENT_CONFLICT')
  })

  it('releases provider failures and keeps actual-cost overruns durable and fail-closed', async () => {
    const repository = new MemoryModelUsageRepository()
    const base = { workspaceId: 'ws_failures', modality: 'image' as const, model: 'relay-image', estimateVersion: 'pricing-v1', dailyLimitCny: 1, at: '2026-08-29T01:00:00.000Z' }
    await repository.reserveDailyBudget({ ...base, reservationKey: 'failed', estimateCny: 0.8 })
    expect(await repository.releaseDailyBudget({ workspaceId: base.workspaceId, reservationKey: 'failed' })).toMatchObject({ status: 'released' })
    await expect(repository.reserveDailyBudget({ ...base, reservationKey: 'replacement', estimateCny: 0.8 })).resolves.toMatchObject({ reused: false })
    await expect(repository.settleDailyBudget({ workspaceId: base.workspaceId, reservationKey: 'replacement', actualCostCny: 1.2, providerRequestId: 'provider_over' })).rejects.toBeInstanceOf(ModelCostBudgetActualExceededError)
    await expect(repository.settleDailyBudget({ workspaceId: base.workspaceId, reservationKey: 'replacement', actualCostCny: 1.2, providerRequestId: 'provider_over' })).rejects.toBeInstanceOf(ModelCostBudgetActualExceededError)
    await expect(repository.reserveDailyBudget({ ...base, reservationKey: 'must_block', estimateCny: 0.01 })).rejects.toBeInstanceOf(ModelCostBudgetExceededError)
  })

  it('serializes concurrent reservations so only capacity-fitting work starts', async () => {
    const repository = new MemoryModelUsageRepository()
    const reserve = (reservationKey: string) => repository.reserveDailyBudget({ workspaceId: 'ws_concurrent', reservationKey, modality: 'video', model: 'relay-video', estimateCny: 0.75, estimateVersion: 'pricing-v1', dailyLimitCny: 1, at: '2026-08-29T01:00:00.000Z' })
    const results = await Promise.allSettled([reserve('a'), reserve('b')])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })

  it('enforces a shared per-run cap independently from the daily workspace cap', async () => {
    const repository = new MemoryModelUsageRepository()
    const base = { workspaceId: 'ws_run_budget', runKey: 'run_1', modality: 'image' as const, model: 'relay-image', estimateVersion: 'pricing-v2', dailyLimitCny: 10, runLimitCny: 1, at: '2026-08-29T01:00:00.000Z' }
    await repository.reserveDailyBudget({ ...base, reservationKey: 'request_a', estimateCny: 0.6 })
    await expect(repository.reserveDailyBudget({ ...base, reservationKey: 'request_b', estimateCny: 0.5 })).rejects.toBeInstanceOf(ModelRunCostBudgetExceededError)
    await repository.settleDailyBudget({ workspaceId: base.workspaceId, reservationKey: 'request_a', actualCostCny: 0.6, providerRequestId: 'provider_a' })
    await expect(repository.reserveDailyBudget({ ...base, reservationKey: 'request_c', estimateCny: 0.5 })).rejects.toBeInstanceOf(ModelRunCostBudgetExceededError)
  })

  it('enforces a shared run across UTC days when the run and daily limits are equal', async () => {
    const repository = new MemoryModelUsageRepository()
    const base = { workspaceId: 'ws_cross_day_run', runKey: 'run_cross_day', modality: 'video' as const, model: 'relay-video', estimateVersion: 'pricing-v3', dailyLimitCny: 1, runLimitCny: 1 }
    await repository.reserveDailyBudget({ ...base, reservationKey: 'day_one', estimateCny: 0.6, at: '2026-08-29T23:59:00.000Z' })
    await repository.settleDailyBudget({ workspaceId: base.workspaceId, reservationKey: 'day_one', actualCostCny: 0.6, providerRequestId: 'provider_day_one' })
    await expect(repository.reserveDailyBudget({ ...base, reservationKey: 'day_two', estimateCny: 0.5, at: '2026-08-30T00:01:00.000Z' })).rejects.toBeInstanceOf(ModelRunCostBudgetExceededError)
  })
})

describe('PostgresModelUsageRepository settlement cost invariant', () => {
  it('atomically rejects settled when both stored and supplied costs are absent', async () => {
    const client = new RecordingClient()
    client.enqueue()
    client.enqueue()
    client.enqueue()
    client.enqueue([{ revision: 1, cost_cny: null }])
    client.enqueue()
    const repository = new PostgresModelUsageRepository(new RecordingPool(client))

    await expect(repository.resolve({ workspaceId: 'ws_usage', id: 'usage_1', expectedRevision: 1, status: 'settled', actorId: 'reconciler', reason: 'wallet settled' }))
      .rejects.toThrow('MODEL_USAGE_SETTLED_COST_REQUIRED')

    const update = client.calls.find(call => call.text.startsWith('UPDATE model_usage_ledger SET settlement_status='))
    expect(update?.text).toContain("AND ($4 <> 'settled' OR COALESCE($5,cost_cny) IS NOT NULL)")
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })

  it('allows waived with no cost', async () => {
    const client = new RecordingClient()
    client.enqueue()
    client.enqueue()
    client.enqueue([postgresUsageRow({ settlement_status: 'waived', resolved_by: 'finance-reviewer', resolution_reason: 'provider confirmed no charge', resolution_evidence_ref: 'ticket://waiver-1', resolved_at: '2026-08-31T00:01:00.000Z', revision: 2 })])
    client.enqueue()
    const repository = new PostgresModelUsageRepository(new RecordingPool(client))

    await expect(repository.resolve({ workspaceId: 'ws_usage', id: 'usage_1', expectedRevision: 1, status: 'waived', actorId: 'finance-reviewer', reason: 'provider confirmed no charge', evidenceRef: 'ticket://waiver-1' }))
      .resolves.toMatchObject({ settlementStatus: 'waived', resolvedBy: 'finance-reviewer', revision: 2 })
  })
})
