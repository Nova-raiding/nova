import { randomUUID } from 'node:crypto'
import { DomainError } from '../../../packages/application/src/service.js'
import type { ActionKind, ActionLedgerRepository } from '../../../packages/persistence/src/index.js'
import type { PostgresBillingRepository } from '../../../packages/persistence/src/billing-repository.js'
import type { CommercialExtensionsRepository } from '../../../packages/persistence/src/commercial-extensions-repository.js'
import type { ActionSettlementInput } from './commercial-settlement-support.js'
import type { WalletTransaction } from './wallet-amount-helpers.js'

type PluginWalletDebitInput = {
  workspaceId: string; amountFen?: number; idempotencyKey: string; actorId: string; description: string
  taskId?: string; campaignItemId?: string; modelRunKey?: string; contextLinkId?: string; contextHash?: string
}
type WalletPersistence = {
  billing?: Pick<PostgresBillingRepository, 'debit' | 'settleDebit' | 'refundDebit' | 'effectiveDebitFens' | 'balanceFen'>
  commercialExtensions?: Pick<CommercialExtensionsRepository, 'getModelMarkupPolicy'>
  actionLedger?: Pick<ActionLedgerRepository, 'settleProviderUsage'>
}

/** Wallet debit, provider settlement, and compensation share one idempotency contract. */
export function createWalletSettlementRuntime(dependencies: {
  ready: () => Promise<unknown>
  persistence: () => WalletPersistence
  isTest: () => boolean
  actionKindForDescription: (description: string) => ActionKind
  modalityForActionKind: (kind: ActionKind) => string | undefined
  reserveDailyModelBudget: (workspaceId: string, actionKey: string, runKey: string, modality: string) => Promise<unknown>
  releaseDailyModelBudget: (workspaceId: string, actionKey: string) => Promise<unknown>
  assertProviderActionCanStart: (workspaceId: string, actionKey: string) => Promise<unknown>
  recordActionSettlement: (input: ActionSettlementInput) => Promise<unknown>
  refundActionSettlement: (input: { workspaceId: string; actionKey: string; reason: string }) => Promise<unknown>
  walletTransactions: WalletTransaction[]
  walletBalanceFen: (workspaceId: string) => number
  walletLedgerEffectiveFen: (workspaceId: string, debitKey: string) => number
  settlementOrderId: (debitKey: string, type: 'debit' | 'refund') => string
  reversalOrderId: (debitKey: string) => string
}) {
  async function debitPluginWalletAfterBudget(input: PluginWalletDebitInput) {
    const amountFen = input.amountFen ?? 1
    const actionKind = dependencies.actionKindForDescription(input.description)
    const providerMetered = ['model_text', 'model_image', 'model_ocr', 'model_video', 'image_edit'].includes(actionKind)
    await dependencies.ready()
    if (providerMetered) await dependencies.assertProviderActionCanStart(input.workspaceId, input.idempotencyKey)
    const persistence = dependencies.persistence()
    const pricingPolicy = providerMetered ? await persistence.commercialExtensions?.getModelMarkupPolicy() : undefined
    const settlement = input.description.includes('套餐额度外') ? 'wallet_overage' as const : 'wallet' as const
    const authorization = pricingPolicy ? { reservedAmountFen: amountFen, multiplier: pricingPolicy.multiplier, settlementStatus: 'authorized' as const } : {}
    if (dependencies.isTest()) {
      const transaction = { id: `fixture_debit_${input.idempotencyKey}`, workspaceId: input.workspaceId, type: 'debit' as const, amountFen, orderId: input.idempotencyKey, actorId: input.actorId, description: input.description, createdAt: new Date().toISOString() }
      await dependencies.recordActionSettlement({ workspaceId: input.workspaceId, actionKey: input.idempotencyKey, actionKind, settlement, amountFen: transaction.amountFen, actorId: input.actorId, description: input.description, ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.campaignItemId ? { campaignItemId: input.campaignItemId } : {}), ...(input.contextLinkId && input.contextHash ? { contextLinkId: input.contextLinkId, contextHash: input.contextHash } : {}), ...authorization })
      return transaction
    }
    if (!Number.isSafeInteger(amountFen) || amountFen <= 0) throw new DomainError('BILLING_AMOUNT_INVALID', '扣款金额必须是正整数分', 400)
    if (persistence.billing) {
      try {
        const transaction = await persistence.billing.debit({ ...input, amountFen })
        try {
          await dependencies.recordActionSettlement({ workspaceId: input.workspaceId, actionKey: input.idempotencyKey, actionKind, settlement, amountFen, actorId: input.actorId, description: input.description, ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.campaignItemId ? { campaignItemId: input.campaignItemId } : {}), ...(input.contextLinkId && input.contextHash ? { contextLinkId: input.contextLinkId, contextHash: input.contextHash } : {}), ...authorization })
        } catch (error) {
          // A durable debit without its action record is compensated before the error escapes.
          try { if (transaction.created) await persistence.billing.refundDebit({ workspaceId: input.workspaceId, debitIdempotencyKey: input.idempotencyKey, actorId: input.actorId, reason: '扣款台账写入失败，自动退款' }) } catch { /* keep the ledger failure for alerting */ }
          throw error
        }
        return transaction
      } catch (error) {
        if (error instanceof Error && error.message === 'BILLING_INSUFFICIENT_BALANCE') throw new DomainError('RECHARGE_REQUIRED', '插件钱包余额不足，请充值后继续', 402)
        if ((error as { code?: string })?.code === 'WALLET_DEBIT_IDEMPOTENCY_CONFLICT' || String(error).includes('WALLET_DEBIT_IDEMPOTENCY_CONFLICT')) throw new DomainError('WALLET_DEBIT_IDEMPOTENCY_CONFLICT', '钱包扣款幂等键已绑定到不同金额或动作，请换用新的幂等键', 409)
        throw error
      }
    }
    const existing = dependencies.walletTransactions.find(item => item.workspaceId === input.workspaceId && item.type === 'debit' && item.orderId === input.idempotencyKey)
    if (existing) {
      if (existing.amountFen !== amountFen || existing.description !== `${input.description}（${input.actorId}）`) throw new DomainError('WALLET_DEBIT_IDEMPOTENCY_CONFLICT', '钱包扣款幂等键已绑定到不同金额或动作，请换用新的幂等键', 409)
      return existing
    }
    if (dependencies.walletBalanceFen(input.workspaceId) < amountFen) throw new DomainError('RECHARGE_REQUIRED', '插件钱包余额不足，请充值后继续', 402)
    const transaction = { id: `billing_tx_${randomUUID()}`, workspaceId: input.workspaceId, type: 'debit' as const, amountFen, orderId: input.idempotencyKey, actorId: input.actorId, description: `${input.description}（${input.actorId}）`, createdAt: new Date().toISOString() }
    dependencies.walletTransactions.push(transaction)
    try {
      await dependencies.recordActionSettlement({ workspaceId: input.workspaceId, actionKey: input.idempotencyKey, actionKind, settlement, amountFen, actorId: input.actorId, description: input.description, ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.campaignItemId ? { campaignItemId: input.campaignItemId } : {}), ...(input.contextLinkId && input.contextHash ? { contextLinkId: input.contextLinkId, contextHash: input.contextHash } : {}), ...authorization })
    } catch (error) {
      const index = dependencies.walletTransactions.findIndex(item => item.id === transaction.id)
      if (index >= 0) dependencies.walletTransactions.splice(index, 1)
      throw error
    }
    return transaction
  }

  async function settleLegacyRmbProviderUsage(input: PluginWalletDebitInput) {
    const modality = dependencies.modalityForActionKind(dependencies.actionKindForDescription(input.description))
    if (!modality) return debitPluginWalletAfterBudget(input)
    const runKey = input.modelRunKey?.trim() || input.taskId?.trim() || input.campaignItemId?.trim() || input.idempotencyKey
    await dependencies.reserveDailyModelBudget(input.workspaceId, input.idempotencyKey, runKey, modality)
    try { return await debitPluginWalletAfterBudget(input) }
    catch (error) { await dependencies.releaseDailyModelBudget(input.workspaceId, input.idempotencyKey); throw error }
  }

  async function settlePluginWalletDebit(input: { workspaceId: string; debitIdempotencyKey: string; finalAmountFen: number; actorId: string; providerRequestId?: string }) {
    await dependencies.ready()
    const persistence = dependencies.persistence()
    if (!dependencies.isTest() && persistence.billing) {
      try {
        await persistence.billing.settleDebit({ workspaceId: input.workspaceId, debitIdempotencyKey: input.debitIdempotencyKey, finalAmountFen: input.finalAmountFen, actorId: input.actorId, description: '模型真实用量结算' })
      } catch (error) {
        if (error instanceof Error && error.message === 'BILLING_INSUFFICIENT_BALANCE') throw new DomainError('RECHARGE_REQUIRED', '模型已返回真实用量，但钱包不足以完成结算，请充值', 402)
        throw error
      }
    } else if (!dependencies.isTest()) {
      const original = dependencies.walletTransactions.find(item => item.workspaceId === input.workspaceId && item.type === 'debit' && item.orderId === input.debitIdempotencyKey)
      if (!original) throw new Error('billing debit not found')
      // Compute corrections from the effective ledger total to avoid paying a delta twice.
      const delta = input.finalAmountFen - dependencies.walletLedgerEffectiveFen(input.workspaceId, input.debitIdempotencyKey)
      if (delta !== 0) {
        const type: WalletTransaction['type'] = delta > 0 ? 'debit' : 'refund'
        const orderId = dependencies.settlementOrderId(input.debitIdempotencyKey, type)
        const existing = dependencies.walletTransactions.find(item => item.workspaceId === input.workspaceId && item.type === type && item.orderId === orderId)
        if (existing) {
          if (existing.amountFen !== Math.abs(delta)) throw new DomainError('WALLET_DEBIT_IDEMPOTENCY_CONFLICT', '结算金额与账本中已有的结算记录不一致，需人工核对', 409)
        } else {
          if (delta > 0 && dependencies.walletBalanceFen(input.workspaceId) < delta) throw new DomainError('RECHARGE_REQUIRED', '模型已返回真实用量，但钱包不足以完成结算，请充值', 402)
          dependencies.walletTransactions.push({ id: `billing_tx_${randomUUID()}`, workspaceId: input.workspaceId, type, amountFen: Math.abs(delta), orderId, actorId: input.actorId, description: `模型真实用量结算（${input.actorId}）`, createdAt: new Date().toISOString() })
        }
      }
    }
    await persistence.actionLedger?.settleProviderUsage({ workspaceId: input.workspaceId, actionKey: input.debitIdempotencyKey, ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}), actualAmountFen: input.finalAmountFen })
  }

  async function refundPluginWalletDebit(input: { workspaceId: string; debitIdempotencyKey: string; actorId: string; reason: string }) {
    await dependencies.releaseDailyModelBudget(input.workspaceId, input.debitIdempotencyKey)
    if (dependencies.isTest()) {
      await dependencies.refundActionSettlement({ workspaceId: input.workspaceId, actionKey: input.debitIdempotencyKey, reason: input.reason })
      return { refunded: false }
    }
    await dependencies.ready()
    const billing = dependencies.persistence().billing
    if (billing?.refundDebit) {
      try {
        const result = { refunded: true, transaction: await billing.refundDebit(input) }
        await dependencies.refundActionSettlement({ workspaceId: input.workspaceId, actionKey: input.debitIdempotencyKey, reason: input.reason })
        return result
      } catch (error) { if (error instanceof Error && error.message === 'billing debit not found') return { refunded: false }; throw error }
    }
    const debit = dependencies.walletTransactions.find(item => item.workspaceId === input.workspaceId && item.type === 'debit' && item.orderId === input.debitIdempotencyKey)
    if (!debit) {
      await dependencies.refundActionSettlement({ workspaceId: input.workspaceId, actionKey: input.debitIdempotencyKey, reason: input.reason })
      return { refunded: false }
    }
    const refundOrderId = dependencies.reversalOrderId(input.debitIdempotencyKey)
    const existing = dependencies.walletTransactions.find(item => item.workspaceId === input.workspaceId && item.type === 'refund' && item.orderId === refundOrderId)
    if (existing) return { refunded: false, transaction: existing }
    // Reverse what the debit key effectively charged, including any settlement delta.
    const refundFen = dependencies.walletLedgerEffectiveFen(input.workspaceId, input.debitIdempotencyKey)
    if (refundFen <= 0) throw new Error('BILLING_AMOUNT_INVALID')
    const transaction = { id: `billing_tx_${randomUUID()}`, workspaceId: input.workspaceId, type: 'refund' as const, amountFen: refundFen, orderId: refundOrderId, actorId: input.actorId, description: `模型失败退款（${input.actorId}）：${input.reason}`, createdAt: new Date().toISOString() }
    dependencies.walletTransactions.push(transaction)
    await dependencies.refundActionSettlement({ workspaceId: input.workspaceId, actionKey: input.debitIdempotencyKey, reason: input.reason })
    return { refunded: true, transaction }
  }

  return { settleLegacyRmbProviderUsage, settlePluginWalletDebit, refundPluginWalletDebit }
}
