import { describe, expect, it } from 'vitest'
import { COMMERCIAL_PURCHASE_ERROR_CODES, isCommercialPurchaseErrorCode } from './commercial-order.js'

describe('commercial purchase error contract', () => {
  it('keeps native MCP purchase failures stable without accepting arbitrary codes', () => {
    expect(COMMERCIAL_PURCHASE_ERROR_CODES).toEqual([
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
    ])
    for (const code of COMMERCIAL_PURCHASE_ERROR_CODES) expect(isCommercialPurchaseErrorCode(code)).toBe(true)
    expect(isCommercialPurchaseErrorCode('billing.recharge.create')).toBe(false)
  })

  it('exposes onboarding_once as a first-class purchase kind', () => {
    const request: import('./commercial-order.js').CommercialPurchaseCreateRequest = {
      workspace_id: 'ws-1', actor_id: 'actor-1', purchase_kind: 'onboarding_once', sku_code: 'onboarding_once', idempotency_key: 'order-1', reason: '正式接入',
    }
    expect(request.purchase_kind).toBe('onboarding_once')
    expect(isCommercialPurchaseErrorCode('ONBOARDING_PURCHASE_UNAVAILABLE')).toBe(true)
  })
})
