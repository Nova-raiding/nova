import { DomainError } from '../../../packages/application/src/service.js'
import { allowedModelUsageSettlementDecisions, type ActionLedgerRepository, type ModelUsageRepository, type ModelUsageSettlementDecision, type OperationAudit } from '../../../packages/persistence/src/index.js'
import type { ModelUsageRecord } from '../../../packages/persistence/src/model-usage-repository.js'

export const BILLING_SETTLEMENT_METHODS = new Set([
  'billing.reconciliation.run', 'billing.model-usage.reconciliation.run', 'billing.model-usage.resolve',
])

export interface BillingSettlementDependencies {
  workspaceId: string
  params: Record<string, unknown>
  requireRole: (allowed: readonly string[]) => string
  required: (key: string) => string
  runPaymentReconciliation: (input: { workspaceId: string; actorId: string; limit: number }) => Promise<unknown>
  runModelUsageReconciliation: (input: { workspaceId: string; actorId: string; limit: number }) => Promise<Record<string, unknown>>
  settlePendingModelUsage: (input: { workspaceId: string; usageId: string; actorId: string; expectedRevision: number; reason: string; evidenceRef: string }) => Promise<ModelUsageRecord>
  refundPluginWalletDebit: (input: { workspaceId: string; debitIdempotencyKey: string; actorId: string; reason: string }) => Promise<unknown>
  modelUsage?: ModelUsageRepository
  actionLedger?: ActionLedgerRepository
  audit: (input: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<void>
}

export async function handleBillingSettlementMethod(method: string, deps: BillingSettlementDependencies): Promise<unknown> {
  const { workspaceId, params } = deps
  if (method === 'billing.reconciliation.run') {
    const actorId = deps.requireRole(['finance_ops', 'ops_admin', 'platform_admin', 'platform_ops'])
    const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(20, Math.max(1, Number(params.limit))) : 10
    return deps.runPaymentReconciliation({ workspaceId, actorId, limit })
  }
  if (method === 'billing.model-usage.reconciliation.run') {
    const actorId = deps.requireRole(['finance', 'platform_ops'])
    const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(100, Math.max(1, Number(params.limit))) : 50
    const reconciliation = await deps.runModelUsageReconciliation({ workspaceId, actorId, limit })
    await deps.audit({ workspaceId, actorId, action: 'billing.model-usage.reconciliation.run', resourceType: 'model_usage', resourceId: workspaceId, before: {}, after: reconciliation, reason: '运营人员执行模型用量结算重试' })
    return reconciliation
  }
  if (method === 'billing.model-usage.resolve') {
    const actorId = deps.requireRole(['finance', 'platform_ops'])
    if (!deps.modelUsage) throw new DomainError('MODEL_USAGE_LEDGER_NOT_CONFIGURED', '模型用量结算台账未配置', 503)
    const usageId = deps.required('usage_id')
    const revisionText = deps.required('revision')
    if (!/^\d+$/u.test(revisionText)) throw new DomainError('MODEL_USAGE_REVISION_INVALID', 'revision 必须是正整数', 400)
    const revision = Number(revisionText)
    const decision = deps.required('decision') as ModelUsageSettlementDecision
    if (!['retry', 'waive', 'manual_attention'].includes(decision)) throw new DomainError('MODEL_USAGE_DECISION_INVALID', 'decision 必须是 retry、waive 或 manual_attention', 400)
    const reason = deps.required('reason').trim()
    const evidenceRef = deps.required('evidence_ref').trim()
    const before = (await deps.modelUsage.list(workspaceId, 1000)).find(item => item.id === usageId)
    if (!before) throw new DomainError('MODEL_USAGE_NOT_FOUND', '模型用量记录不存在', 404)
    const allowedDecisions = allowedModelUsageSettlementDecisions(before)
    if (!allowedDecisions.includes(decision)) throw new DomainError('MODEL_USAGE_DECISION_NOT_ALLOWED', '当前结算状态不允许该人工处理动作', 409, { settlement_status: before.settlementStatus, allowed_decisions: allowedDecisions })
    let after: ModelUsageRecord
    if (decision === 'retry') after = await deps.settlePendingModelUsage({ workspaceId, usageId, actorId, expectedRevision: revision, reason, evidenceRef })
    else if (decision === 'waive') {
      if (before.actionId) await deps.refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: before.actionId, actorId, reason: `模型成本缺失豁免：${reason}` })
      after = await deps.modelUsage.resolve({ workspaceId, id: usageId, expectedRevision: revision, status: 'waived', actorId, reason, evidenceRef })
    } else if (decision === 'manual_attention') {
      if (before.actionId) await deps.actionLedger?.transitionSettlementStatus({ workspaceId, actionKey: before.actionId, from: ['authorized', 'pending_receipt', 'manual_attention'], to: 'manual_attention' })
      after = await deps.modelUsage.resolve({ workspaceId, id: usageId, expectedRevision: revision, status: 'manual_attention', actorId, reason, evidenceRef })
    } else throw new DomainError('MODEL_USAGE_DECISION_INVALID', 'decision 必须是 retry、waive 或 manual_attention', 400)
    await deps.audit({ workspaceId, actorId, action: 'billing.model-usage.resolve', resourceType: 'model_usage', resourceId: usageId, before: before as unknown as Record<string, unknown>, after: after as unknown as Record<string, unknown>, reason })
    return { id: after.id, settlement_status: after.settlementStatus, allowed_decisions: allowedModelUsageSettlementDecisions(after), revision: after.revision, resolved_by: after.resolvedBy ?? null, resolution_reason: after.resolutionReason ?? null, resolution_evidence_ref: after.resolutionEvidenceRef ?? null, resolved_at: after.resolvedAt ?? null }
  }
  throw new Error(`Unsupported billing settlement method: ${method}`)
}
