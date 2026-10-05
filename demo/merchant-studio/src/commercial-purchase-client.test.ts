import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommercialFirstCheckout, createCommercialPaymentRequest, createCommercialUpgradeQuote, fetchCommercialFirstCheckoutRequest, fetchCommercialPurchaseRequest } from './api'

const order = { order_id: 'plan-1', sku_code: 'basic', sku_version_id: 'cv-2', status: 'pending', amount_fen: 215000, currency: 'CNY', payment_provider: 'alipay', expires_at: '2099-01-01T00:00:00Z', snapshot: { quantity: 1, cycle: { unit: 'month', count: 1 }, benefits: [{ code: 'monthly_creative_points', quantity: 5000 }] } }
const opening = { ...order, order_id: 'open-1', sku_code: 'onboarding_once', amount_fen: 510000 }
const envelope = (result: unknown) => new Response(JSON.stringify({ data: { result } }), { headers: { 'content-type': 'application/json' } })

describe('merchant commercial client keeps charge authority and recovery on the server', () => {
  beforeEach(() => vi.stubGlobal('window', globalThis))
  afterEach(() => vi.unstubAllGlobals())
  it('creates both opening and first period atomically, then requests payment separately without client money', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      calls.push({ method: request.method, params: request.params })
      return request.method === 'commercial.checkout.create' ? envelope({ checkout_id: 'checkout-1', orders: [opening, order] }) : envelope({ ...order, payment_url: 'https://payment.example/checkout-plan-1' })
    }))
    const checkout = await createCommercialFirstCheckout('/api', 'onboarding_once', 'basic', 'intent-1')
    expect(checkout.orders.map(item => item.amount_fen)).toEqual([510000, 215000])
    expect(calls.map(item => item.method)).toEqual(['commercial.checkout.create'])
    expect(calls[0].params).toEqual({ onboarding_sku_code: 'onboarding_once', subscription_sku_code: 'basic', idempotency_key: 'intent-1', reason: 'merchant_first_purchase_checkout' })
    await createCommercialPaymentRequest('/api', 'plan-1', 'payment:plan-1')
    expect(calls[1]).toEqual({ method: 'commercial.order.payment.create', params: { order_id: 'plan-1', idempotency_key: 'payment:plan-1' } })
    expect(JSON.stringify(calls)).not.toContain('amount_fen')
  })
  it('looks up an uncertain original intent without repeating create or inferring completion from a missing fact', async () => {
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => { methods.push(JSON.parse(String(init.body)).method); return envelope(null) }))
    await expect(fetchCommercialPurchaseRequest('/api', 'intent-1')).resolves.toBeNull()
    await expect(fetchCommercialFirstCheckoutRequest('/api', 'intent-1')).resolves.toBeNull()
    expect(methods).toEqual(['commercial.order.request.get', 'commercial.checkout.request.get'])
  })
  it('rejects an invalid quote instead of calculating a local fallback charge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ upgrade_quote_id: 'uq-1', target_sku_code: 'growth', amount_fen: -500 })))
    await expect(createCommercialUpgradeQuote('/api', 'growth', 'quote-1')).rejects.toThrow('暂不能付款')
  })
})
