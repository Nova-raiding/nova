export type CommercialPurchaseKind = 'purchase' | 'upgrade' | 'point_pack'

/** Client intent: deliberately contains no amount, currency, points or benefits. */
export interface CommercialPurchaseCreateRequest {
  workspace_id: string
  actor_id: string
  purchase_kind: CommercialPurchaseKind
  sku_code: string
  idempotency_key: string
  reason: string
}

export interface CommercialPaymentStatusRequest {
  workspace_id: string
  actor_id: string
  order_id: string
}

export interface CommercialPurchaseOrderView {
  order_id: string
  workspace_id: string
  sku_code: string
  sku_version_id: string
  status: 'pending' | 'paid' | 'failed' | 'closed' | 'refunded' | 'reconciliation_required'
  amount_fen: number
  currency: 'CNY'
  payment_provider: string
  access_revision: number | null
  created_at: string
  paid_at: string | null
}

export const COMMERCIAL_PURCHASE_ERROR_CODES = [
  'COMMERCIAL_PURCHASE_UNAVAILABLE',
  'COMMERCIAL_PURCHASE_KIND_MISMATCH',
  'PRIVATE_PURCHASE_UNAVAILABLE',
  'COMMERCIAL_ORDER_NOT_FOUND',
] as const

export type CommercialPurchaseErrorCode = (typeof COMMERCIAL_PURCHASE_ERROR_CODES)[number]

export function isCommercialPurchaseErrorCode(value: string): value is CommercialPurchaseErrorCode {
  return (COMMERCIAL_PURCHASE_ERROR_CODES as readonly string[]).includes(value)
}
