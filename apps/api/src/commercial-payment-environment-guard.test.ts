import { describe, expect, it } from 'vitest'
import { resolveCommercialPaymentMode } from './commercial-payment-mode.js'

describe('commercial payment environment guard', () => {
  it('allows sandbox only for non-production automated tests', () => {
    expect(resolveCommercialPaymentMode({ COMMERCIAL_PAYMENT_PROVIDER: 'sandbox', NODE_ENV: 'test' }, false)).toBe('sandbox')
    expect(() => resolveCommercialPaymentMode({ COMMERCIAL_PAYMENT_PROVIDER: 'sandbox', NODE_ENV: 'development' }, false)).toThrow('未配置已批准')
    expect(() => resolveCommercialPaymentMode({ COMMERCIAL_PAYMENT_PROVIDER: 'sandbox', NODE_ENV: 'test' }, true)).toThrow('未配置已批准')
  })

  it.each(['alipay', 'wechat'] as const)('requires explicit provider mode before selecting %s', channel => {
    expect(() => resolveCommercialPaymentMode({ COMMERCIAL_PAYMENT_PROVIDER: channel, PAYMENT_MODE: 'sandbox' }, false)).toThrow('尚未配置')
    expect(() => resolveCommercialPaymentMode({ COMMERCIAL_PAYMENT_PROVIDER: channel }, false)).toThrow('尚未配置')
    expect(resolveCommercialPaymentMode({ COMMERCIAL_PAYMENT_PROVIDER: channel, PAYMENT_MODE: 'provider' }, false)).toBe(channel)
  })
})
