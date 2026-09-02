import { describe, expect, it } from 'vitest'
import { COMMERCIAL_PURCHASE_ERROR_CODES, isCommercialPurchaseErrorCode } from './commercial-order.js'

describe('commercial purchase error contract', () => {
  it('keeps native MCP purchase failures stable without accepting arbitrary codes', () => {
    expect(COMMERCIAL_PURCHASE_ERROR_CODES).toEqual([
      'COMMERCIAL_PURCHASE_UNAVAILABLE',
      'COMMERCIAL_PURCHASE_KIND_MISMATCH',
      'PRIVATE_PURCHASE_UNAVAILABLE',
      'COMMERCIAL_ORDER_NOT_FOUND',
    ])
    for (const code of COMMERCIAL_PURCHASE_ERROR_CODES) expect(isCommercialPurchaseErrorCode(code)).toBe(true)
    expect(isCommercialPurchaseErrorCode('billing.recharge.create')).toBe(false)
  })
})
