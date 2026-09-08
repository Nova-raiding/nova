export type CommercialPurchaseKind = 'purchase' | 'upgrade' | 'onboarding_once' | 'point_pack'

/**
 * Private trial conversion is intentionally an operations-only workflow.  A
 * customer cannot submit an eligibility, offset, price or payment-subject
 * value through the public purchase surface.
 */
export type PrivateTrialEligibilityStatus =
  | 'pending_business_approval'
  | 'approved_pending_validation'
  | 'approved'
  | 'rejected'
  | 'expired'

export type PrivateTrialCreditStatus =
  | 'pending_accounting_approval'
  | 'approved'
  | 'applied'
  | 'rejected'
  | 'expired'

export interface PrivateTrialConversionOrderView {
  eligibility_id: string
  credit_id: string
  onboarding_order_id: string
  list_amount_fen: 500000
  offset_amount_fen: 199900
  payable_amount_fen: 300100
  status: 'pending'
  expires_at: string
}

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
  'ONBOARDING_PURCHASE_UNAVAILABLE',
  'COMMERCIAL_PURCHASE_KIND_MISMATCH',
  'PRIVATE_PURCHASE_UNAVAILABLE',
  'COMMERCIAL_ORDER_NOT_FOUND',
  'PRIVATE_TRIAL_ELIGIBILITY_NOT_FOUND',
  'PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID',
  'PRIVATE_TRIAL_VALIDATION_UNVERIFIED',
  'PRIVATE_TRIAL_WINDOW_EXPIRED',
  'PRIVATE_TRIAL_PAYMENT_SUBJECT_MISMATCH',
  'PRIVATE_TRIAL_CREDIT_ALREADY_USED',
  'PRIVATE_TRIAL_ACCOUNTING_APPROVAL_REQUIRED',
] as const

export type CommercialPurchaseErrorCode = (typeof COMMERCIAL_PURCHASE_ERROR_CODES)[number]

export function isCommercialPurchaseErrorCode(value: string): value is CommercialPurchaseErrorCode {
  return (COMMERCIAL_PURCHASE_ERROR_CODES as readonly string[]).includes(value)
}
