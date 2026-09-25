import { effectiveDebitFenOf, effectiveDebitFensOf, type ActionKind } from '../../../packages/persistence/src/index.js'
import { walletBalanceFen as balanceFenOfTransactions } from './wallet-money.js'

export type RechargeChannel = 'alipay' | 'wechat'
export type RechargeState = 'pending' | 'paid' | 'closed' | 'failed'

export interface RechargeOrder {
  id: string
  workspaceId: string
  channel: RechargeChannel
  amountFen: number
  state: RechargeState
  paymentMode: 'fixture' | 'provider'
  paymentUrl?: string
  providerTradeId?: string
  createdByActorId?: string
  createdAt: string
  updatedAt: string
}

export interface WalletTransaction {
  id: string
  workspaceId: string
  type: 'recharge' | 'debit' | 'refund'
  amountFen: number
  orderId?: string
  actorId?: string
  description: string
  createdAt: string
}

export function publicRechargeOrder(order: RechargeOrder) {
  return { id: order.id, workspace_id: order.workspaceId, channel: order.channel, amount_cny: (order.amountFen / 100).toFixed(2), state: order.state, payment_mode: order.paymentMode, payment_url: order.paymentUrl ?? null, provider_trade_id: order.providerTradeId ?? null, created_by_actor_id: order.createdByActorId ?? null, attribution_status: order.createdByActorId ? 'attributed' : 'legacy_unattributed', expires_at: null, paid_at: order.state === 'paid' ? order.updatedAt : null, created_at: order.createdAt, updated_at: order.updatedAt }
}

export function walletBalanceFen(workspaceId: string, transactions: readonly WalletTransaction[]): number {
  return balanceFenOfTransactions(workspaceId, transactions)
}

export function walletEffectiveDebitFensFromMemory(workspaceId: string, debitKeys: readonly string[], transactions: readonly WalletTransaction[], actorId?: string): Map<string, number> {
  return effectiveDebitFensOf(transactions.filter(item => item.workspaceId === workspaceId && (!actorId || item.actorId === actorId)), debitKeys)
}

export function walletLedgerEffectiveFen(workspaceId: string, debitKey: string, transactions: readonly WalletTransaction[]): number {
  return effectiveDebitFenOf(transactions.filter(item => item.workspaceId === workspaceId), debitKey) ?? 0
}

export function actionKindForDescription(description: string): ActionKind {
  if (description.includes('同步')) return 'catalog_sync'
  if (description.includes('连接')) return 'platform_connect'
  if (description.includes('图片编辑') || description.includes('image_edit')) return 'image_edit'
  if (description.includes('创意预览')) return 'creative_preview'
  if (description.includes('SEO')) return 'seo'
  if (description.includes('Brief')) return 'brief'
  if (description.includes('发布')) return 'publish'
  if (description.includes('图片') || description.includes('图像') || description.includes('image')) return 'model_image'
  if (description.includes('OCR') || description.includes('解析') || description.includes('ocr')) return 'model_ocr'
  if (description.includes('视频') || description.includes('video')) return 'model_video'
  return 'model_text'
}
