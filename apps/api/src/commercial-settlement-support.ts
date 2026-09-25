import { DomainError } from '../../../packages/application/src/service.js'
import type { ActionKind, ActionLedgerRepository, ActionSettlement, EntitlementKind, EntitlementRepository } from '../../../packages/persistence/src/index.js'
import type { CommercialRepository } from '../../../packages/persistence/src/commercial-repository.js'

export type ActionSettlementInput = {
  workspaceId: string; actionKey: string; actionKind: ActionKind; settlement: ActionSettlement
  amountFen: number; actorId: string; description: string; taskId?: string; campaignItemId?: string
  contextLinkId?: string; contextHash?: string; reservedAmountFen?: number; multiplier?: number
  settlementStatus?: 'authorized' | 'pending_receipt' | 'settled' | 'released' | 'refunded' | 'manual_attention'
}

export async function recordActionSettlement(input: ActionSettlementInput, dependencies: {
  ready: Promise<unknown>
  actionLedger: () => ActionLedgerRepository | undefined
}) {
  await dependencies.ready
  const ledger = dependencies.actionLedger()
  if (!ledger) throw new Error('ACTION_LEDGER_NOT_CONFIGURED')
  return ledger.record({ ...input, units: 1 })
}

export async function observeLegacyImageEntitlementShadow(input: { workspaceId: string; kind: EntitlementKind }, dependencies: {
  ready: Promise<unknown>
  entitlements: () => EntitlementRepository
}) {
  await dependencies.ready
  try {
    await dependencies.entitlements().list(input.workspaceId)
    return false as const
  } catch {
    // Migration shadow health never grants or denies a V2-admitted action.
    return false as const
  }
}

export async function refundActionSettlement(input: { workspaceId: string; actionKey: string; reason: string }, dependencies: {
  ready: Promise<unknown>
  actionLedger: () => ActionLedgerRepository | undefined
}) {
  await dependencies.ready
  return dependencies.actionLedger()?.refund(input) ?? { refunded: false }
}

export async function refundEntitlement(input: { workspaceId: string; actionKey: string; reason: string }, dependencies: {
  ready: Promise<unknown>
  entitlements: () => EntitlementRepository
  refundActionSettlement: (input: { workspaceId: string; actionKey: string; reason: string }) => Promise<unknown>
}) {
  await dependencies.ready
  const refunded = await dependencies.entitlements().refund({ workspaceId: input.workspaceId, idempotencyKey: input.actionKey })
  if (refunded.refunded) await dependencies.refundActionSettlement(input)
  return refunded
}

export async function currentWalletBalanceFen(workspaceId: string, dependencies: {
  ready: Promise<unknown>
  billingBalanceFen: () => ((workspaceId: string) => Promise<number>) | undefined
  memoryBalanceFen: (workspaceId: string) => number
}) {
  await dependencies.ready
  const durableBalance = dependencies.billingBalanceFen()
  return durableBalance ? durableBalance(workspaceId) : dependencies.memoryBalanceFen(workspaceId)
}

export async function synchronizeCommercialQuotaFromSubscription(
  subscription: { workspaceId: string; planCode: string; planName: string; billingCycle: 'monthly' | 'annual'; priceCny: number; includedStores: number; includedTasks: number },
  commercialRepository: Pick<CommercialRepository, 'getSettings' | 'updateSettings'>,
) {
  const current = await commercialRepository.getSettings(subscription.workspaceId)
  const next = {
    planCode: subscription.planCode,
    planName: subscription.planName,
    monthlyPriceCny: subscription.billingCycle === 'monthly' ? subscription.priceCny : current.monthlyPriceCny,
    annualPriceCny: subscription.billingCycle === 'annual' ? subscription.priceCny : current.annualPriceCny,
    includedStores: subscription.includedStores,
    includedTasks: subscription.includedTasks,
    updatedBy: 'payment_provider',
  }
  if (current.planCode === next.planCode && current.planName === next.planName && current.monthlyPriceCny === next.monthlyPriceCny && current.annualPriceCny === next.annualPriceCny && current.includedStores === next.includedStores && current.includedTasks === next.includedTasks) return current
  return commercialRepository.updateSettings({ workspaceId: subscription.workspaceId, ...next, expectedRevision: current.revision })
}

export async function assertProviderActionCanStart(workspaceId: string, actionKey: string, dependencies: {
  ready: Promise<unknown>
  actionLedger: () => ActionLedgerRepository | undefined
}) {
  await dependencies.ready
  const existing = await dependencies.actionLedger()?.get(workspaceId, actionKey)
  const settlementStatus = existing?.settlementStatus ?? existing?.state
  if (!existing) return
  throw new DomainError(
    'MODEL_ACTION_ALREADY_STARTED',
    '这次模型操作已经受理或正在结算，禁止重复调用模型；请刷新任务状态，待结算异常由运营后台处理',
    409,
    { settlement_status: settlementStatus },
  )
}
