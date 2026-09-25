import { createHash } from 'node:crypto'
import { DomainError } from '../../../packages/application/src/service.js'
import { relayUsageReceiptKey, type RelayUsageRecord } from '../../../packages/ai/src/relay-usage.js'
import { evaluatePlatformModelTaskCostLimit } from '../../../packages/ai/src/platform-model-gate.js'
import type { createRelayPricingClientFromEnv } from '../../../packages/ai/src/relay-pricing.js'
import { decideOcrPointFinalization, OCR_COST_POINT_POLICY_VERSION, OCR_FREE_THRESHOLD_POINT_POLICY_VERSION } from '../../../packages/application/src/ocr-point-lifecycle.js'
import type { ActionKind, ActionLedgerRepository, ActionSettlement, CommercialExtensionsRepository, OperationalAlert, OperationalAlertsRepository } from '../../../packages/persistence/src/index.js'
import type { ApiPersistence } from './server.js'
import { chargeFenFromCny } from './wallet-money.js'

type ActionAuthorization = Awaited<ReturnType<ActionLedgerRepository['get']>>
type Reservation = { debitIdempotencyKey: string; actorId: string; providerRequests: Set<string> }
type WalletDebitInput = { workspaceId: string; amountFen?: number; idempotencyKey: string; actorId: string; description: string; taskId?: string; campaignItemId?: string; modelRunKey?: string; contextLinkId?: string; contextHash?: string }
type ActionSettlementInput = { workspaceId: string; actionKey: string; actionKind: ActionKind; settlement: ActionSettlement; amountFen: number; actorId: string; description: string; taskId?: string; campaignItemId?: string; contextLinkId?: string; contextHash?: string; reservedAmountFen?: number; multiplier?: number; settlementStatus?: 'authorized' | 'pending_receipt' | 'settled' | 'released' | 'refunded' | 'manual_attention' }

export interface RelayUsageRuntimeDependencies {
  isProduction: () => boolean
  persistenceReady: () => Promise<unknown>
  persistence: () => ApiPersistence
  memoryCommercialExtensions: () => CommercialExtensionsRepository
  memoryAlerts: () => OperationalAlertsRepository
  relayPricing: ReturnType<typeof createRelayPricingClientFromEnv>
  getActionLedgerWithHistoricalImageCompat: (workspaceId: string, actionKey: string) => Promise<{ action: ActionAuthorization; actionKey: string }>
  persistOperationalAlertNotification: (alert: OperationalAlert) => Promise<void>
  modelBillingReservations: () => Map<string, Reservation>
  recordActionSettlement: (input: ActionSettlementInput) => Promise<{ settlementStatus?: string }>
  settlePluginWalletDebit: (input: { workspaceId: string; debitIdempotencyKey: string; finalAmountFen: number; actorId: string; providerRequestId?: string }) => Promise<unknown>
  settleLegacyRmbProviderUsage: (input: WalletDebitInput) => Promise<unknown>
}

export function createRelayUsageRuntime(deps: RelayUsageRuntimeDependencies) {
  async function recordRelayUsage(usage: RelayUsageRecord, options: { deferCreativePointSettlementToWorker?: boolean } = {}) {
    const isProduction = deps.isProduction
    if (isProduction() && !usage.workspaceId?.trim()) throw new Error('MODEL_USAGE_WORKSPACE_REQUIRED')
    if (isProduction() && !usage.actionId?.trim()) throw new Error('MODEL_USAGE_ACTION_REQUIRED')
    if (isProduction() && !usage.runKey?.trim()) throw new Error('MODEL_USAGE_RUN_KEY_REQUIRED')
    if (!usage.workspaceId) return
    const workspaceId = usage.workspaceId
    await deps.persistenceReady()
    const persistence = deps.persistence()
    const memoryCommercialExtensions = deps.memoryCommercialExtensions()
    const memoryAlerts = deps.memoryAlerts()
    const modelBillingReservations = deps.modelBillingReservations()
    const relayPricing = deps.relayPricing
    const getActionLedgerWithHistoricalImageCompat = deps.getActionLedgerWithHistoricalImageCompat
    const persistOperationalAlertNotification = deps.persistOperationalAlertNotification
    const recordActionSettlement = deps.recordActionSettlement
    const settlePluginWalletDebit = deps.settlePluginWalletDebit
    const settleLegacyRmbProviderUsage = deps.settleLegacyRmbProviderUsage
    if (!persistence.modelUsage) throw new Error('MODEL_USAGE_LEDGER_NOT_CONFIGURED')
    const receiptKey = relayUsageReceiptKey(usage)
    const policy = await (persistence.commercialExtensions ?? memoryCommercialExtensions).getModelMarkupPolicy()
    const durableAuthorizationLookup = usage.actionId ? await getActionLedgerWithHistoricalImageCompat(workspaceId, usage.actionId) : undefined
    const durableAuthorization = durableAuthorizationLookup?.action
    const durableAuthorizationActionKey = durableAuthorizationLookup?.actionKey ?? usage.actionId
    // Asset OCR uses a stable attempt key for idempotency, but local fixture
    // parsing does not create a customer action-ledger row.  Do not attach that
    // synthetic key to the PostgreSQL model-usage foreign key in development;
    // production still requires a real authorization and fails closed below.
    const persistedActionId = durableAuthorization || isProduction() ? usage.actionId : undefined
    const effectiveMultiplier = durableAuthorization?.multiplier ?? policy.multiplier
    let pricingFailure: { code: string; message: string } | undefined
    if (usage.costCny === undefined && relayPricing) {
      try {
        const quote = await relayPricing.quote(usage)
        usage.costCny = quote.costCny
        usage.metadata = { ...(usage.metadata ?? {}), ...quote.metadata }
      } catch (error) {
        pricingFailure = { code: (error as { code?: string })?.code ?? 'MODEL_PRICING_DERIVATION_FAILED', message: error instanceof Error ? error.message : String(error) }
      }
    }
    if (usage.costCny === undefined) {
      if (durableAuthorization && durableAuthorizationActionKey) await persistence.actionLedger?.transitionSettlementStatus({ workspaceId, actionKey: durableAuthorizationActionKey, from: ['authorized', 'pending_receipt'], to: 'pending_receipt' })
      const pending = await persistence.modelUsage.record({ receiptKey, workspaceId, ...(persistedActionId ? { actionId: persistedActionId, ...(isProduction() ? { budgetReservationKey: persistedActionId, budgetRunKey: usage.runKey! } : {}) } : {}), ...(usage.contextLinkId && usage.contextHash ? { contextLinkId: usage.contextLinkId, contextHash: usage.contextHash } : {}), modality: usage.modality, model: usage.model, ...(usage.providerRequestId ? { providerRequestId: usage.providerRequestId } : {}), ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}), ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}), ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}), settlementStatus: 'pending_cost', lastError: { code: pricingFailure?.code ?? 'MODEL_USAGE_COST_MISSING', message: pricingFailure?.message ?? 'provider receipt omitted actual cost' }, nextAttemptAt: new Date().toISOString(), metadata: { ...(usage.metadata ?? {}), settlement_reason: pricingFailure?.code ?? 'provider_cost_missing' } })
      const alert = await (persistence.alerts ?? memoryAlerts).upsert({ workspaceId, alertKey: `model-cost-missing:${receiptKey}`, code: pricingFailure?.code ?? 'MODEL_USAGE_COST_MISSING', severity: 'high', entityType: 'model_usage', entityId: pending.id, title: '模型中转成本证据不足，结果已阻断交付', observedAt: usage.observedAt, evidence: { receipt_key: receiptKey, modality: usage.modality, model: usage.model, provider_request_id: usage.providerRequestId ?? null, action_id: usage.actionId ?? null, pricing_error: pricingFailure ?? null }, nextAction: '核对中转站回执成本或价格快照、计费分组和汇率；完成待结算记录后再恢复模型交付。' })
      void persistOperationalAlertNotification(alert)
      throw Object.assign(new Error('model relay usage is missing actual cost'), { code: 'MODEL_USAGE_COST_MISSING' })
    }
    // Provider cost remains durable evidence, but the retired RMB wallet is no
    // Included quota and entitlement authorizations are zero-charge customer
    // settlements. Wallet authorizations remain customer-charge settlements;
    // provider cost evidence must not silently turn a wallet debit into a free
    // operation.
    const zeroCustomerChargeAuthorization = durableAuthorization?.settlement === 'included_quota' || durableAuthorization?.settlement === 'entitlement'
    const customerChargeCny = usage.costCny === undefined
      ? undefined
      : zeroCustomerChargeAuthorization ? 0 : usage.costCny
    const usageInput = { receiptKey, workspaceId, ...(persistedActionId ? { actionId: persistedActionId } : {}), ...(usage.contextLinkId && usage.contextHash ? { contextLinkId: usage.contextLinkId, contextHash: usage.contextHash } : {}), modality: usage.modality, model: usage.model, ...(usage.providerRequestId ? { providerRequestId: usage.providerRequestId } : {}), ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}), ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}), ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}), ...(usage.metadata || usage.runKey ? { metadata: { ...(usage.metadata ?? {}), ...(usage.runKey ? { run_key: usage.runKey } : {}) } } : {}) }
    let recordedUsage
    if (isProduction() && usage.actionId && usage.costCny !== undefined) {
      try {
        recordedUsage = (await persistence.modelUsage.recordUsageAndSettleBudget({ ...usageInput, budgetReservationKey: usage.actionId, budgetRunKey: usage.runKey!, costCny: usage.costCny, markupMultiplier: effectiveMultiplier, customerChargeCny, pricingPolicyRevision: policy.revision, ...(usage.observedAt ? { observedAt: usage.observedAt } : {}) })).usage
      } catch (error) {
        if (!['MODEL_DAILY_COST_ACTUAL_EXCEEDED', 'MODEL_TASK_COST_ACTUAL_EXCEEDED'].includes((error as { code?: string })?.code ?? '')) throw error
        const details = (error as { details: { usedCny: number; reservedCny: number; requestCny: number; limitCny: number } }).details
        const committedUsageId = (error as { committed?: { usage?: { id?: string } } }).committed?.usage?.id ?? receiptKey
        await (persistence.alerts ?? memoryAlerts).upsert({ workspaceId, alertKey: `model-budget-overrun:${usage.actionId}`, code: (error as { code?: string }).code ?? 'MODEL_DAILY_COST_ACTUAL_EXCEEDED', severity: 'high', entityType: 'model_usage', entityId: committedUsageId, title: '模型实际成本超过预算预留，结果已阻断', observedAt: usage.observedAt, evidence: { action_id: usage.actionId, provider_request_id: usage.providerRequestId ?? null, used_cny: details.usedCny, reserved_cny: details.reservedCny, request_cny: details.requestCny, limit_cny: details.limitCny }, nextAction: '核对价格版本和实际成本；在运营后台人工处理，不得静默放行或重复调用模型。' })
        throw Object.assign(error as Error, { providerSucceeded: true, details: { used_cny: details.usedCny, reserved_cny: details.reservedCny, request_cny: details.requestCny, limit_cny: details.limitCny } })
      }
    } else {
      recordedUsage = await persistence.modelUsage.record({ ...usageInput, ...(usage.costCny !== undefined ? { costCny: usage.costCny, markupMultiplier: effectiveMultiplier, customerChargeCny, pricingPolicyRevision: policy.revision, settlementStatus: 'pending_wallet' as const } : { settlementStatus: 'pending_cost' as const }) })
    }
    const creativePointsRepository = persistence.creativePoints
    const creativeReservation = usage.actionId && creativePointsRepository?.getReservationByActionKey
      ? await creativePointsRepository.getReservationByActionKey(workspaceId, usage.actionId)
      : null
    if (!options.deferCreativePointSettlementToWorker && creativeReservation?.status === 'active') {
      if (!persistence.creativePointLifecycle || usage.costCny === undefined) throw new DomainError('POINT_SETTLEMENT_EVIDENCE_UNAVAILABLE', '模型回执缺少创意点结算所需的持久化用量、成本或 provider 回执仓储', 503)
      const providerRequestId = usage.providerRequestId ?? usage.providerAttemptId
      if (!providerRequestId) throw new DomainError('MODEL_USAGE_RECEIPT_IDENTITY_MISSING', '模型回执缺少真实 provider request id，创意点保持预留并等待对账', 409)
      if (usage.modality === 'ocr') {
        const taskCap = evaluatePlatformModelTaskCostLimit(process.env)
        const rate = creativeReservation.rateCardVersion
        const policyVersion = rate.startsWith(`${OCR_FREE_THRESHOLD_POINT_POLICY_VERSION}:`)
          ? OCR_FREE_THRESHOLD_POINT_POLICY_VERSION
          : OCR_COST_POINT_POLICY_VERSION
        const validRate = rate.startsWith(`${policyVersion}:`)
        const decision = decideOcrPointFinalization({ reservedPoints: creativeReservation.points, providerOutcome: 'succeeded',
          verifiedReceipt: Boolean(recordedUsage && usage.providerRequestId && validRate && taskCap.ready && usage.costCny <= taskCap.limitCny), actualCostCny: usage.costCny, policyVersion })
        if (decision.action !== 'settle') throw Object.assign(new Error('OCR provider succeeded but cost, approved rate, task limit, or receipt requires reconciliation'), { code: 'MODEL_USAGE_SETTLEMENT_PENDING', providerSucceeded: true, reconciliationRequired: true, receiptKey })
        const usageEvidence = { modality: 'ocr', model: usage.model, ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}), ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}), ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}) }
        const costEvidence = { currency: 'CNY', actual: usage.costCny }
        const receiptHash = createHash('sha256').update(JSON.stringify({ providerRequestId, usage: usageEvidence, cost: costEvidence, observedAt: usage.observedAt, rate })).digest('hex')
        await persistence.creativePointLifecycle.recordProviderReceipt({ workspaceId, operationId: creativeReservation.operationId, provider: 'model-relay', providerRequestId, outcome: 'succeeded', usage: usageEvidence, cost: costEvidence, receiptHash, verifiedAt: usage.observedAt, at: usage.observedAt })
        await creativePointsRepository!.settle({ workspaceId, reservationId: creativeReservation.id, idempotencyKey: `commercial.settle:${usage.actionId}`, actualPoints: decision.actualPoints, metadata: { provider_request_id: providerRequestId, receipt_hash: receiptHash, cost_cny: usage.costCny, modality: 'ocr', rate_card_version: rate }, at: usage.observedAt })
      } else {
      const usageEvidence = { modality: usage.modality, model: usage.model, ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}), ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}), ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}) }
      const costEvidence = { currency: 'CNY', actual: usage.costCny }
      const receiptHash = createHash('sha256').update(JSON.stringify({ providerRequestId, usage: usageEvidence, cost: costEvidence, observedAt: usage.observedAt })).digest('hex')
      await persistence.creativePointLifecycle.recordProviderReceipt({ workspaceId, operationId: creativeReservation.operationId, provider: 'model-relay', providerRequestId, outcome: 'succeeded', usage: usageEvidence, cost: costEvidence, receiptHash, verifiedAt: usage.observedAt, at: usage.observedAt })
      await creativePointsRepository!.settle({ workspaceId, reservationId: creativeReservation.id, idempotencyKey: `commercial.settle:${usage.actionId}`, actualPoints: creativeReservation.points, metadata: { provider_request_id: providerRequestId, receipt_hash: receiptHash, cost_cny: usage.costCny, modality: usage.modality }, at: usage.observedAt })
      }
    }
    if (recordedUsage.settlementStatus === 'settled' || recordedUsage.settlementStatus === 'waived') return { recorded: true as const, costEvidence: true as const }
    const reservation = usage.actionId ? modelBillingReservations.get(`${workspaceId}:${usage.actionId}`) : undefined
    const durableWalletAuthorization = durableAuthorization && (durableAuthorization.settlement === 'wallet' || durableAuthorization.settlement === 'wallet_overage') ? durableAuthorization : undefined
    const durableZeroChargeAuthorization = zeroCustomerChargeAuthorization ? durableAuthorization : undefined
    try {
      if (durableZeroChargeAuthorization && durableAuthorizationActionKey) {
        let settlementActionKey = durableAuthorizationActionKey
        if (durableZeroChargeAuthorization.settlementStatus === 'settled') {
          settlementActionKey = `model-usage:${receiptKey}`
          const repairAction = await recordActionSettlement({
            workspaceId,
            actionKey: settlementActionKey,
            actionKind: durableZeroChargeAuthorization.actionKind,
            settlement: durableZeroChargeAuthorization.settlement,
            amountFen: 0,
            reservedAmountFen: 0,
            multiplier: effectiveMultiplier,
            settlementStatus: 'authorized',
            actorId: durableZeroChargeAuthorization.actorId,
            description: '模型结构修复请求真实用量结算',
            ...(durableZeroChargeAuthorization.taskId ? { taskId: durableZeroChargeAuthorization.taskId } : {}),
            ...(durableZeroChargeAuthorization.campaignItemId ? { campaignItemId: durableZeroChargeAuthorization.campaignItemId } : {}),
            ...(durableZeroChargeAuthorization.contextLinkId && durableZeroChargeAuthorization.contextHash ? { contextLinkId: durableZeroChargeAuthorization.contextLinkId, contextHash: durableZeroChargeAuthorization.contextHash } : {}),
          })
          if (repairAction.settlementStatus === 'authorized') await persistence.actionLedger?.transitionSettlementStatus({ workspaceId, actionKey: settlementActionKey, from: ['authorized'], to: 'pending_receipt' })
        } else if (durableZeroChargeAuthorization.settlementStatus === 'authorized') {
          await persistence.actionLedger?.transitionSettlementStatus({ workspaceId, actionKey: settlementActionKey, from: ['authorized'], to: 'pending_receipt' })
        } else if (durableZeroChargeAuthorization.settlementStatus !== 'pending_receipt') {
          throw Object.assign(new Error(`model action settlement is ${durableZeroChargeAuthorization.settlementStatus}`), { code: 'MODEL_USAGE_ZERO_CHARGE_SETTLEMENT_BLOCKED' })
        }
        await persistence.actionLedger?.settleProviderUsage({ workspaceId, actionKey: settlementActionKey, actualAmountFen: 0, ...(usage.providerRequestId ? { providerRequestId: usage.providerRequestId } : {}) })
      } else if ((durableWalletAuthorization || reservation) && recordedUsage.customerChargeCny !== undefined && recordedUsage.customerChargeCny > 0) {
        const actualAmountFen = chargeFenFromCny(recordedUsage.customerChargeCny)
        if (durableWalletAuthorization && usage.actionId) {
          const actionKey = durableAuthorizationActionKey ?? usage.actionId
          if (durableWalletAuthorization.settlementStatus === 'authorized' || durableWalletAuthorization.settlementStatus === 'pending_receipt') {
            await persistence.actionLedger?.transitionSettlementStatus({ workspaceId, actionKey, from: ['authorized', 'pending_receipt'], to: 'pending_receipt' })
            await settlePluginWalletDebit({ workspaceId, debitIdempotencyKey: usage.actionId, finalAmountFen: actualAmountFen, actorId: durableWalletAuthorization.actorId, providerRequestId: usage.providerRequestId })
          } else if (durableWalletAuthorization.settlementStatus === 'settled') {
            const repairDebitKey = `model-usage:${receiptKey}`
            await settleLegacyRmbProviderUsage({ workspaceId, amountFen: actualAmountFen, idempotencyKey: repairDebitKey, actorId: durableWalletAuthorization.actorId, description: '模型结构修复请求真实用量结算' })
            await persistence.actionLedger?.settleProviderUsage({ workspaceId, actionKey: repairDebitKey, actualAmountFen, ...(usage.providerRequestId ? { providerRequestId: usage.providerRequestId } : {}) })
          } else {
            throw Object.assign(new Error(`model action settlement is ${durableWalletAuthorization.settlementStatus}`), { code: 'MODEL_USAGE_WALLET_SETTLEMENT_BLOCKED' })
          }
          modelBillingReservations.delete(`${workspaceId}:${usage.actionId}`)
        } else if (reservation) {
          const requestKey = usage.providerRequestId ?? receiptKey
          if (!reservation.providerRequests.has(requestKey)) {
            if (reservation.providerRequests.size === 0) await settlePluginWalletDebit({ workspaceId, debitIdempotencyKey: reservation.debitIdempotencyKey, finalAmountFen: actualAmountFen, actorId: reservation.actorId, providerRequestId: usage.providerRequestId })
            else await settleLegacyRmbProviderUsage({ workspaceId, amountFen: actualAmountFen, idempotencyKey: `model-usage:${receiptKey}`, actorId: reservation.actorId, description: '模型修复请求真实用量结算' })
            reservation.providerRequests.add(requestKey)
          }
        }
      }
      await persistence.modelUsage.resolve({ workspaceId, id: recordedUsage.id, expectedRevision: recordedUsage.revision, status: 'settled', actorId: 'model-usage-settlement', reason: '中转回执成本与钱包结算完成', evidenceRef: usage.providerRequestId ?? receiptKey })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        if (durableAuthorization && durableAuthorizationActionKey) await persistence.actionLedger?.transitionSettlementStatus({ workspaceId, actionKey: durableAuthorizationActionKey, from: ['authorized', 'pending_receipt'], to: 'pending_receipt' })
        await persistence.modelUsage.resolve({ workspaceId, id: recordedUsage.id, expectedRevision: recordedUsage.revision, status: 'pending_wallet', actorId: 'model-usage-settlement', reason: '等待钱包结算重试', lastError: { code: (error as { code?: string })?.code ?? 'MODEL_USAGE_WALLET_SETTLEMENT_FAILED', message }, nextAttemptAt: new Date(Date.now() + 60_000).toISOString() })
      } catch { /* a concurrent reconciler may already have advanced the row */ }
      await (persistence.alerts ?? memoryAlerts).upsert({ workspaceId, alertKey: `model-wallet-settlement:${receiptKey}`, code: 'MODEL_USAGE_WALLET_SETTLEMENT_FAILED', severity: 'high', entityType: 'model_usage', entityId: recordedUsage.id, title: '模型已返回结果，但钱包结算尚未完成', observedAt: usage.observedAt, evidence: { receipt_key: receiptKey, action_id: usage.actionId ?? null, error: message }, nextAction: '在运营后台重试该笔模型用量结算；不要向用户重复退款或重复调用模型。' })
      throw error
    }
    return { recorded: true as const, costEvidence: true as const }
  }

  return { recordRelayUsage }
}
