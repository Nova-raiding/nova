import { DomainError } from '../../../packages/application/src/service.js'
import { allowedModelUsageSettlementDecisions, type ActionLedgerRecord } from '../../../packages/persistence/src/index.js'
import type { ModelUsageRecord } from '../../../packages/persistence/src/model-usage-repository.js'
import { chargeFenFromCny, publicMoneyRecord } from './wallet-money.js'
import type { BillingExportTransaction } from './mcp-billing-export.js'

export interface BillingStatementDependencies {
  workspaceId: string
  params: Record<string, unknown>
  billingScope: { scope: 'mine' | 'workspace'; actorId: string }
  canViewProviderCosts: boolean
  storageMode: string
  listTransactions: (actorId?: string) => Promise<BillingExportTransaction[]>
  listModelUsage: (period: { fromAt?: string; toAt?: string; actorId?: string }) => Promise<ModelUsageRecord[]>
  listActions: () => Promise<ActionLedgerRecord[]>
  balanceFen: () => Promise<number>
  walletEffectiveDebitFens: (workspaceId: string, debitKeys: readonly string[], actorId?: string) => Promise<Map<string, number>>
  externalProviderUsageStatement: (input: { modelUsage: ModelUsageRecord[]; fromAt?: string; toAt?: string }) => Promise<{ status: string }>
  paymentProviderReadiness: () => { ready: boolean; reasons: string[] }
}

export async function billingReconciliationStatement(deps: BillingStatementDependencies) {
  const { workspaceId, params, billingScope, canViewProviderCosts } = deps
      const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(100, Math.max(1, Number(params.limit))) : 100
      const parseStatementTime = (value: unknown) => { if (typeof value !== 'string' || !value.trim()) return undefined; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null }
      const fromAt = parseStatementTime(params.from_at)
      const toAt = parseStatementTime(params.to_at)
      if (fromAt === null || toAt === null || (fromAt && toAt && fromAt >= toAt)) throw new DomainError('MODEL_USAGE_STATEMENT_PERIOD_INVALID', 'from_at/to_at 必须是有效且递增的 ISO 时间', 400)
      const allTransactions = await deps.listTransactions(billingScope.scope === 'mine' ? billingScope.actorId : undefined)
      const periodTransactions = allTransactions.filter(item => (!fromAt || item.createdAt >= fromAt) && (!toAt || item.createdAt < toAt))
      const transactions = periodTransactions.slice(0, limit)
      const candidateModelUsage = await deps.listModelUsage({ ...(fromAt ? { fromAt } : {}), ...(toAt ? { toAt } : {}), ...(billingScope.scope === 'mine' ? { actorId: billingScope.actorId } : {}) })
      // Model usage is attributed to the actor that authorized its action.
      // Keep the report workspace-scoped, then join the bounded action ledger
      // so older receipts remain reportable without duplicating identity data.
      const fullActionLedger = await deps.listActions()
      const actionLedger = billingScope.scope === 'mine' ? fullActionLedger.filter(item => item.actorId === billingScope.actorId) : fullActionLedger
      const actorByAction = new Map(actionLedger.map(item => [item.actionKey, item.actorId]))
      const actionByKey = new Map(actionLedger.map(item => [item.actionKey, item]))
      const modelUsage = billingScope.scope === 'mine' && deps.storageMode === 'memory' ? candidateModelUsage.filter(item => item.actionId && actorByAction.get(item.actionId) === billingScope.actorId) : candidateModelUsage
      const actionSummary = actionLedger.reduce((acc, item) => { const key = `${item.actionKind}:${item.settlement}:${item.settlementStatus ?? item.state}`; acc[key] = (acc[key] ?? 0) + 1; return acc }, {} as Record<string, number>)
      const modelUsageTotals = modelUsage.reduce((acc, item) => {
        acc.totalTokens += item.totalTokens ?? 0
        acc.costCny += item.costCny ?? 0
        acc.customerChargeCny += item.customerChargeCny ?? 0
        acc.byModality[item.modality] = (acc.byModality[item.modality] ?? 0) + 1
        return acc
      }, { totalTokens: 0, costCny: 0, customerChargeCny: 0, byModality: {} as Record<string, number> })
      const missingCostEvidenceCount = modelUsage.filter(item => item.costCny === undefined).length
      const modelUsageByActor = modelUsage.reduce((groups, item) => {
        const actorId = billingScope.scope === 'mine' ? billingScope.actorId : item.actionId ? actorByAction.get(item.actionId) ?? 'unknown' : 'unknown'
        const current = groups.get(actorId) ?? { actor_id: actorId, record_count: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, provider_cost_cny: 0, customer_charge_cny: 0, unsettled_records: 0, by_modality: {} as Record<string, number> }
        current.record_count += 1
        current.input_tokens += item.inputTokens ?? 0
        current.output_tokens += item.outputTokens ?? 0
        current.total_tokens += item.totalTokens ?? 0
        current.provider_cost_cny += item.costCny ?? 0
        current.customer_charge_cny += item.customerChargeCny ?? 0
        if (!['settled', 'waived'].includes(item.settlementStatus)) current.unsettled_records += 1
        current.by_modality[item.modality] = (current.by_modality[item.modality] ?? 0) + 1
        groups.set(actorId, current)
        return groups
      }, new Map<string, { actor_id: string; record_count: number; input_tokens: number; output_tokens: number; total_tokens: number; provider_cost_cny: number; customer_charge_cny: number; unsettled_records: number; by_modality: Record<string, number> }>())
      const byActor = [...modelUsageByActor.values()].map(item => ({ ...item, provider_cost_cny: canViewProviderCosts ? item.provider_cost_cny.toFixed(6) : null, customer_charge_cny: item.customer_charge_cny.toFixed(6) }))
      // Summary amounts describe the selected ledger scope and period, not the
      // first page of rows. The balance is already whole-workspace, so silently
      // truncating recharge/debit/refund totals at the display limit is unsafe.
      const totals = periodTransactions.reduce((acc, item) => { acc[item.type] = (acc[item.type] ?? 0) + item.amountFen; return acc }, {} as Record<string, number>)
      const balanceFen = await deps.balanceFen()
      const provider = deps.paymentProviderReadiness()
      const unsettledModelUsage = modelUsage.filter(item => !['settled', 'waived'].includes(item.settlementStatus))
      const unknownActorCount = byActor.filter(item => item.actor_id === 'unknown').reduce((sum, item) => sum + item.record_count, 0)
      // The wallet side of the check reads the ledger through the one definition
      // of what a debit key costs (`packages/persistence/src/debit-key.ts`),
      // never through a local aggregate. Aggregating here used to miss the
      // `refund:<key>` row, so this branch's corrected reversal-first ledger was
      // reported `needs_review` while a ledger that over-credited the workspace
      // reconciled clean.
      const walletEffectiveFen = await deps.walletEffectiveDebitFens(workspaceId, modelUsage.flatMap(item => item.actionId ? [item.actionId] : []), billingScope.scope === 'mine' ? billingScope.actorId : undefined)
      const walletMismatchCount = modelUsage.reduce((count, item) => {
        if (!item.actionId || item.customerChargeCny === undefined) return count
        const action = actionByKey.get(item.actionId)
        if (!action || (action.settlement !== 'wallet' && action.settlement !== 'wallet_overage') || !['settled', 'waived'].includes(item.settlementStatus)) return count
        const expectedFen = chargeFenFromCny(item.customerChargeCny)
        // No ledger row for the key at all is the fixture ledger's `NODE_ENV=test`
        // shape; the action's authorized amount is the only evidence there is.
        const actualFen = walletEffectiveFen.get(item.actionId) ?? action.amountFen
        return actualFen === expectedFen ? count : count + 1
      }, 0)
      const orphanActionCount = modelUsage.filter(item => item.actionId && !actionByKey.has(item.actionId)).length
      const missingRunKeyCount = modelUsage.filter(item => !item.budgetRunKey?.trim()).length
      const budgetLinkMismatchCount = modelUsage.filter(item => item.lastError?.code === 'MODEL_USAGE_BUDGET_LINK_CONFLICT').length
      const externalProviderStatement = billingScope.scope === 'workspace'
        ? await deps.externalProviderUsageStatement({ modelUsage, ...(fromAt ? { fromAt } : {}), ...(toAt ? { toAt } : {}) })
        : { status: 'not_applicable_personal_scope', source: 'workspace_provider_account', reason: '外部中转账单只支持工作区级对账；个人视图使用本地可归属用量台账' }
      const localReconciliationStatus = missingRunKeyCount > 0 || budgetLinkMismatchCount > 0 || unknownActorCount > 0 || walletMismatchCount > 0 || orphanActionCount > 0 ? 'needs_review' : unsettledModelUsage.length > 0 ? 'pending' : 'locally_consistent'
      const reconciliationStatus = localReconciliationStatus === 'needs_review' || externalProviderStatement.status === 'needs_review' ? 'needs_review' : localReconciliationStatus
      return { currency: 'CNY', statement: { from_at: fromAt ?? null, to_at: toAt ?? null, scope: billingScope.scope, balance_scope: 'workspace', transaction_scope: billingScope.scope, model_usage_scope: billingScope.scope, wallet_scope: 'workspace', source: 'model_usage_ledger' }, balance_scope: 'workspace', transaction_scope: billingScope.scope, model_usage_scope: billingScope.scope, balance_cny: (balanceFen / 100).toFixed(2), recharge_cny: ((totals.recharge ?? 0) / 100).toFixed(2), debit_cny: ((totals.debit ?? 0) / 100).toFixed(2), refund_cny: ((totals.refund ?? 0) / 100).toFixed(2), transaction_count: periodTransactions.length, returned_transaction_count: transactions.length, transaction_limit: limit, has_more_transactions: periodTransactions.length > transactions.length, transactions: transactions.map(publicMoneyRecord), model_usage: { record_count: modelUsage.length, total_tokens: modelUsageTotals.totalTokens, provider_cost_cny: canViewProviderCosts && billingScope.scope === 'workspace' && missingCostEvidenceCount === 0 ? modelUsageTotals.costCny.toFixed(6) : null, missing_cost_evidence_count: missingCostEvidenceCount, customer_charge_cny: modelUsageTotals.customerChargeCny.toFixed(6), unsettled_records: unsettledModelUsage.length, reconciliation_status: reconciliationStatus, reconciliation_checks: { unknown_actor_count: unknownActorCount, orphan_action_count: orphanActionCount, wallet_amount_mismatch_count: walletMismatchCount, missing_run_key_count: missingRunKeyCount, budget_link_mismatch_count: budgetLinkMismatchCount }, external_provider_statement: externalProviderStatement, by_actor: byActor, unsettled: billingScope.scope === 'workspace' ? unsettledModelUsage.slice(0, 100).map(item => ({ id: item.id, revision: item.revision, action_id: item.actionId ?? null, run_key: item.budgetRunKey ?? null, modality: item.modality, model: item.model, settlement_status: item.settlementStatus, allowed_decisions: allowedModelUsageSettlementDecisions(item), attempt_count: item.attemptCount, provider_request_id: canViewProviderCosts ? item.providerRequestId ?? null : null, observed_at: item.observedAt, next_attempt_at: item.nextAttemptAt ?? null, last_error: item.lastError ?? null, settlement_reason: typeof item.metadata?.settlement_reason === 'string' ? item.metadata.settlement_reason : item.settlementStatus })) : [], by_modality: modelUsageTotals.byModality }, action_ledger: { record_count: actionLedger.length, by_kind_settlement_state: actionSummary }, provider: { mode: process.env.PAYMENT_MODE === 'provider' ? 'provider' : 'fixture', ready: process.env.PAYMENT_MODE === 'provider' && provider.ready, reasons: provider.reasons } }
}
