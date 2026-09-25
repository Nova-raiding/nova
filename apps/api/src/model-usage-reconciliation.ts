import { createHash, randomUUID } from 'node:crypto'
import { DomainError } from '../../../packages/application/src/service.js'
import { decideOcrPointFinalization, OCR_COST_POINT_POLICY_VERSION, OCR_FREE_THRESHOLD_POINT_POLICY_VERSION } from '../../../packages/application/src/ocr-point-lifecycle.js'
import { evaluatePlatformModelTaskCostLimit } from '../../../packages/ai/src/platform-model-gate.js'
import type { ActionLedgerRepository, ModelUsageRecord } from '../../../packages/persistence/src/index.js'
import type { ApiPersistence } from './server.js'
import { chargeFenFromCny } from './wallet-money.js'

export function createModelUsageReconciliation(deps: {
  persistence: () => ApiPersistence
  getActionLedgerWithHistoricalImageCompat: (workspaceId: string, actionKey: string) => Promise<{ action: Awaited<ReturnType<ActionLedgerRepository['get']>>; actionKey: string }>
  settlePluginWalletDebit: (input: { workspaceId: string; debitIdempotencyKey: string; finalAmountFen: number; actorId: string; providerRequestId?: string }) => Promise<void>
}) {
  async function settleCreativePointReservationForUsage(workspaceId: string, usage: ModelUsageRecord) {
    const persistence = deps.persistence()
    const creativePoints = persistence.creativePoints
    const lifecycle = persistence.creativePointLifecycle
    if (!usage.actionId || !creativePoints?.getReservationByActionKey) return false
    const reservation = await creativePoints.getReservationByActionKey(workspaceId, usage.actionId)
    if (!reservation || reservation.status !== 'active') return false
    if (!lifecycle || usage.costCny === undefined || !Number.isFinite(usage.costCny) || usage.costCny < 0 || !usage.providerRequestId) {
      throw new DomainError('POINT_SETTLEMENT_EVIDENCE_UNAVAILABLE', '模型用量缺少创意点结算所需的真实 provider 请求、成本或生命周期仓储', 409)
    }

    const usageEvidence = {
      modality: usage.modality,
      model: usage.model,
      ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}),
      ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
    }
    const costEvidence = { currency: 'CNY', actual: usage.costCny }
    let actualPoints = reservation.points
    let receiptHash: string
    let receiptMetadata: Record<string, unknown>
    if (usage.modality === 'ocr') {
      const rate = reservation.rateCardVersion
      const policyVersion = rate.startsWith(`${OCR_FREE_THRESHOLD_POINT_POLICY_VERSION}:`)
        ? OCR_FREE_THRESHOLD_POINT_POLICY_VERSION
        : OCR_COST_POINT_POLICY_VERSION
      const taskCap = evaluatePlatformModelTaskCostLimit(process.env)
      const decision = decideOcrPointFinalization({
        reservedPoints: reservation.points,
        providerOutcome: 'succeeded',
        verifiedReceipt: Boolean(rate.startsWith(`${policyVersion}:`) && taskCap.ready && usage.costCny <= taskCap.limitCny),
        actualCostCny: usage.costCny,
        policyVersion,
      })
      if (decision.action !== 'settle') throw new DomainError('MODEL_USAGE_SETTLEMENT_PENDING', 'OCR 成本或费率证据尚不足以恢复创意点结算', 409)
      actualPoints = decision.actualPoints
      receiptHash = createHash('sha256').update(JSON.stringify({ providerRequestId: usage.providerRequestId, usage: usageEvidence, cost: costEvidence, observedAt: usage.observedAt, rate })).digest('hex')
      receiptMetadata = { provider_request_id: usage.providerRequestId, receipt_hash: receiptHash, cost_cny: usage.costCny, modality: 'ocr', rate_card_version: rate }
    } else {
      receiptHash = createHash('sha256').update(JSON.stringify({ providerRequestId: usage.providerRequestId, usage: usageEvidence, cost: costEvidence, observedAt: usage.observedAt })).digest('hex')
      receiptMetadata = { provider_request_id: usage.providerRequestId, receipt_hash: receiptHash, cost_cny: usage.costCny, modality: usage.modality }
    }

    // Replaying this insert validates that a prior API receipt is byte-for-byte
    // the same evidence before a failed point settlement is retried.
    await lifecycle.recordProviderReceipt({
      workspaceId,
      operationId: reservation.operationId,
      provider: 'model-relay',
      providerRequestId: usage.providerRequestId,
      outcome: 'succeeded',
      usage: usageEvidence,
      cost: costEvidence,
      receiptHash,
      verifiedAt: usage.observedAt,
      at: usage.observedAt,
    })
    await creativePoints.settle({
      workspaceId,
      reservationId: reservation.id,
      idempotencyKey: `commercial.settle:${usage.actionId}`,
      actualPoints,
      metadata: receiptMetadata,
      at: usage.observedAt,
    })
    return true
  }

  async function settlePendingModelUsage(input: { workspaceId: string; usageId: string; actorId: string; expectedRevision: number; reason?: string; evidenceRef?: string }) {
    const modelUsage = deps.persistence().modelUsage
    if (!modelUsage) throw new DomainError('MODEL_USAGE_LEDGER_NOT_CONFIGURED', '模型用量结算台账未配置', 503)
    let usage = (await modelUsage.list(input.workspaceId, 1000)).find(item => item.id === input.usageId)
    if (!usage) throw new DomainError('MODEL_USAGE_NOT_FOUND', '模型用量记录不存在', 404)
    if (usage.revision !== input.expectedRevision) throw new DomainError('MODEL_USAGE_REVISION_CONFLICT', '模型用量记录已被其他操作更新，请刷新后重试', 409)
    if (usage.costCny === undefined || usage.customerChargeCny === undefined) throw new DomainError('MODEL_USAGE_COST_MISSING', '该回执仍缺少实际成本，无法自动结算', 409)
    const usageCostCny = usage.costCny
    const usageCustomerChargeCny = usage.customerChargeCny
    if (usage.budgetReservationKey && usage.budgetRunKey) {
      usage = (await modelUsage.recordUsageAndSettleBudget({ workspaceId: usage.workspaceId, receiptKey: usage.receiptKey, receiptHash: usage.receiptHash, ...(usage.actionId ? { actionId: usage.actionId } : {}), budgetReservationKey: usage.budgetReservationKey, budgetRunKey: usage.budgetRunKey, ...(usage.contextLinkId && usage.contextHash ? { contextLinkId: usage.contextLinkId, contextHash: usage.contextHash } : {}), modality: usage.modality, model: usage.model, ...(usage.providerRequestId ? { providerRequestId: usage.providerRequestId } : {}), ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}), ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}), ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}), costCny: usageCostCny, markupMultiplier: usage.markupMultiplier, customerChargeCny: usageCustomerChargeCny, pricingPolicyRevision: usage.pricingPolicyRevision, observedAt: usage.observedAt, ...(usage.metadata ? { metadata: usage.metadata } : {}) })).usage
    }
    // Keep the lifecycle hold authoritative before completing wallet/action
    // settlement. If this fails, the usage remains retryable and delivery
    // cannot mistake a settled model-usage row for settled creative points.
    await settleCreativePointReservationForUsage(input.workspaceId, usage)
    if (usage.actionId) {
      const actionLookup = await deps.getActionLedgerWithHistoricalImageCompat(input.workspaceId, usage.actionId)
      const action = actionLookup?.action
      if (!action) throw new DomainError('MODEL_USAGE_ACTION_NOT_FOUND', '原始扣费授权不存在，需人工核对', 409)
      const actionKey = actionLookup?.actionKey ?? usage.actionId
      if (action.settlement === 'wallet' || action.settlement === 'wallet_overage') {
        await deps.settlePluginWalletDebit({ workspaceId: input.workspaceId, debitIdempotencyKey: actionKey, finalAmountFen: chargeFenFromCny(usageCustomerChargeCny), actorId: input.actorId, ...(usage.providerRequestId ? { providerRequestId: usage.providerRequestId } : {}) })
      } else if (action.settlement === 'entitlement' || action.settlement === 'included_quota') {
        if (action.settlementStatus === 'authorized') await deps.persistence().actionLedger?.transitionSettlementStatus({ workspaceId: input.workspaceId, actionKey, from: ['authorized'], to: 'pending_receipt' })
        await deps.persistence().actionLedger?.settleProviderUsage({ workspaceId: input.workspaceId, actionKey, actualAmountFen: 0, ...(usage.providerRequestId ? { providerRequestId: usage.providerRequestId } : {}) })
      }
    }
    return modelUsage.resolve({ workspaceId: input.workspaceId, id: usage.id, expectedRevision: usage.revision, status: 'settled', actorId: input.actorId, reason: input.reason ?? '运营对账重试完成', evidenceRef: input.evidenceRef ?? usage.providerRequestId ?? usage.receiptKey })
  }

  async function runModelUsageReconciliation(input: { workspaceId: string; actorId: string; limit: number }) {
    const modelUsage = deps.persistence().modelUsage
    if (!modelUsage) throw new DomainError('MODEL_USAGE_LEDGER_NOT_CONFIGURED', '模型用量结算台账未配置', 503)
    const owner = `model-reconciliation:${input.actorId}:${randomUUID()}`
    const claimed = await modelUsage.claimPending({ workspaceId: input.workspaceId, owner, limit: input.limit, leaseSeconds: 120, now: new Date().toISOString() })
    const settled: string[] = []
    const repairedCreativePointSettlements: string[] = []
    const pending: Array<{ usage_id: string; status: string; code: string }> = []
    for (const usage of claimed) {
      try {
        const completed = await settlePendingModelUsage({ workspaceId: input.workspaceId, usageId: usage.id, actorId: input.actorId, expectedRevision: usage.revision })
        settled.push(completed.id)
      } catch (error) {
        const code = (error as { code?: string })?.code ?? (error instanceof Error ? error.message : 'MODEL_USAGE_RECONCILIATION_FAILED')
        const terminal = usage.attemptCount >= 5
        const status = terminal ? 'manual_attention' as const : usage.costCny === undefined ? 'pending_cost' as const : 'pending_wallet' as const
        let actionTransitionError: string | undefined
        if (usage.actionId) {
          try {
            const actionLookup = await deps.getActionLedgerWithHistoricalImageCompat(input.workspaceId, usage.actionId)
            const action = actionLookup?.action
            const targetStatus = terminal ? 'manual_attention' as const : 'pending_receipt' as const
            if (action && action.settlementStatus !== targetStatus && ['authorized', 'pending_receipt'].includes(action.settlementStatus ?? '')) {
              await deps.persistence().actionLedger?.transitionSettlementStatus({ workspaceId: input.workspaceId, actionKey: actionLookup?.actionKey ?? usage.actionId, from: ['authorized', 'pending_receipt'], to: targetStatus })
            }
          } catch (transitionError) {
            actionTransitionError = transitionError instanceof Error ? transitionError.message : String(transitionError)
          }
        }
        try {
          await modelUsage.resolve({ workspaceId: input.workspaceId, id: usage.id, expectedRevision: usage.revision, status, actorId: input.actorId, reason: terminal ? '自动重试达到上限，转人工核对' : '自动对账尚未完成', lastError: { code, message: error instanceof Error ? error.message : String(error), ...(actionTransitionError ? { action_transition_error: actionTransitionError } : {}) }, ...(terminal ? {} : { nextAttemptAt: new Date(Date.now() + Math.min(3600, 60 * 2 ** Math.min(usage.attemptCount, 5)) * 1000).toISOString() }) })
        } catch { /* another reconciler won the optimistic lock */ }
        pending.push({ usage_id: usage.id, status, code })
      }
    }

    // Older reconciliation code could settle the model usage/action ledger
    // before the point lifecycle. Those rows are terminal in model_usage_ledger
    // and therefore never appear in claimPending; inspect a bounded recent
    // window and repair only rows that still own an active point reservation.
    const persistence = deps.persistence()
    if (persistence.creativePoints?.getReservationByActionKey && persistence.creativePointLifecycle) {
      const recentSettled = await modelUsage.list(input.workspaceId, 1000)
      for (const usage of recentSettled.filter(row => row.settlementStatus === 'settled' && row.actionId && row.costCny !== undefined && row.providerRequestId)) {
        try {
          if (await settleCreativePointReservationForUsage(input.workspaceId, usage)) repairedCreativePointSettlements.push(usage.id)
        } catch (error) {
          const code = (error as { code?: string })?.code ?? (error instanceof Error ? error.message : 'CREATIVE_POINT_RECONCILIATION_FAILED')
          pending.push({ usage_id: usage.id, status: 'settled_creative_points_pending', code })
        }
      }
    }
    return { state: pending.length ? 'attention_required' as const : 'completed' as const, checked: claimed.length, settled, repaired_creative_point_settlements: repairedCreativePointSettlements, pending, actor_id: input.actorId }
  }

  return { settlePendingModelUsage, runModelUsageReconciliation }
}
