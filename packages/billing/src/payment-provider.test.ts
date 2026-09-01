import { describe, expect, it } from 'vitest'
import { FixturePaymentProvider, HttpPaymentProvider, createPaymentProviderFromEnv } from './payment-provider.js'

describe('payment provider adapter', () => {
  it('completes a deterministic local fixture checkout and refund without network access', async () => {
    const provider = new FixturePaymentProvider()
    const input = { channel: 'alipay' as const, orderId: 'fixture-order-1', idempotencyKey: 'fixture-key-1', workspaceId: 'ws-fixture', amountFen: 1000, callbackUrl: 'fixture://callback', description: 'local test' }
    await expect(provider.createCheckout(input)).resolves.toMatchObject({ paymentUrl: 'fixture://alipay/ws-fixture/1000?order_id=fixture-order-1', providerOrderId: 'fixture-order-1' })
    await expect(provider.queryStatus({ channel: input.channel, orderId: input.orderId, workspaceId: input.workspaceId })).resolves.toMatchObject({ state: 'pending', amountFen: 1000 })
    provider.confirm({ workspaceId: input.workspaceId, channel: input.channel, orderId: input.orderId })
    await expect(provider.queryStatus({ channel: input.channel, orderId: input.orderId, workspaceId: input.workspaceId })).resolves.toMatchObject({ state: 'paid', providerTradeId: 'fixture-trade-fixture-order-1', amountFen: 1000 })
    await expect(provider.refund({ channel: input.channel, orderId: input.orderId, providerTradeId: 'fixture-trade-fixture-order-1', workspaceId: input.workspaceId, amountFen: 1000, reason: 'test' })).resolves.toMatchObject({ providerRefundId: 'fixture-refund-fixture-order-1', state: 'accepted' })
    await expect(provider.queryStatus({ channel: input.channel, orderId: input.orderId, workspaceId: input.workspaceId })).resolves.toMatchObject({ state: 'closed' })
  })

  it('keeps fixture orders idempotent and rejects amount reuse', async () => {
    const provider = new FixturePaymentProvider()
    const input = { channel: 'wechat' as const, orderId: 'fixture-order-2', idempotencyKey: 'fixture-key-2', workspaceId: 'ws-fixture', amountFen: 2000, callbackUrl: 'fixture://callback', description: 'local test' }
    await provider.createCheckout(input)
    await expect(provider.createCheckout(input)).resolves.toMatchObject({ providerOrderId: input.orderId })
    await expect(provider.createCheckout({ ...input, amountFen: 3000 })).rejects.toThrow('amount conflict')
  })

  it('isolates identical order ids across workspaces and payment channels', async () => {
    const provider = new FixturePaymentProvider()
    const orderId = 'shared-order-id'
    await provider.createCheckout({ channel: 'alipay', orderId, idempotencyKey: 'key-a', workspaceId: 'ws-a', amountFen: 1000, callbackUrl: 'fixture://callback', description: 'local test' })
    await provider.createCheckout({ channel: 'wechat', orderId, idempotencyKey: 'key-b', workspaceId: 'ws-b', amountFen: 2000, callbackUrl: 'fixture://callback', description: 'local test' })
    provider.confirm({ workspaceId: 'ws-a', channel: 'alipay', orderId })

    await expect(provider.queryStatus({ channel: 'alipay', orderId, workspaceId: 'ws-a' })).resolves.toMatchObject({ state: 'paid', amountFen: 1000 })
    await expect(provider.queryStatus({ channel: 'wechat', orderId, workspaceId: 'ws-b' })).resolves.toMatchObject({ state: 'pending', amountFen: 2000 })
    await expect(provider.queryStatus({ channel: 'alipay', orderId, workspaceId: 'ws-b' })).resolves.toMatchObject({ state: 'failed' })
  })

  it('creates a checkout through the server-side provider and accepts only HTTPS payment URLs', async () => {
    let requestBody = ''; let authorization = ''
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', apiKey: 'server-only-key', merchantId: 'merchant-1', fetch: async (_url, init) => { requestBody = String(init?.body); authorization = String((init?.headers as Record<string, string>)?.authorization); return new Response(JSON.stringify({ payment_url: 'https://pay.example/order/1', provider_order_id: 'provider-1' }), { status: 200 }) } })
    await expect(provider.createCheckout({ channel: 'wechat', orderId: 'recharge-1', idempotencyKey: 'recharge-key-1', workspaceId: 'ws-1', amountFen: 1000, callbackUrl: 'https://merchant.example/v1/billing/callback/wechat', description: '充值' })).resolves.toEqual({ paymentUrl: 'https://pay.example/order/1', providerOrderId: 'provider-1' })
    expect(authorization).toBe('Bearer server-only-key')
    expect(requestBody).not.toContain('server-only-key')
    expect(requestBody).toContain('"idempotency_key":"recharge-key-1"')
    expect(() => new HttpPaymentProvider({ endpoint: 'http://payments.example/checkout', apiKey: 'key', merchantId: 'merchant' })).toThrow()
    expect(() => new HttpPaymentProvider({ endpoint: 'https://127.0.0.1/checkout', apiKey: 'key', merchantId: 'merchant' })).toThrow(/PRIVATE_ADDRESS_BLOCKED/)
  })

  it('does not create a provider from incomplete deployment configuration', () => {
    expect(createPaymentProviderFromEnv({ PAYMENT_PROVIDER_CHECKOUT_API_URL: 'https://payments.example/checkout', PAYMENT_PROVIDER_MERCHANT_ID: 'merchant' })).toBeUndefined()
    expect(createPaymentProviderFromEnv({ PAYMENT_PROVIDER_CHECKOUT_API_URL: 'http://payments.example/checkout', PAYMENT_PROVIDER_API_KEY: 'key', PAYMENT_PROVIDER_MERCHANT_ID: 'merchant' })).toBeUndefined()
    expect(createPaymentProviderFromEnv({ PAYMENT_PROVIDER_CHECKOUT_API_URL: 'https://payments.example/checkout', PAYMENT_PROVIDER_API_KEY: 'key', PAYMENT_PROVIDER_MERCHANT_ID: 'merchant' })).toBeDefined()
  })

  it('calls the server-side refund endpoint with an idempotency key and never exposes the API key', async () => {
    let requestUrl = ''; let requestBody = ''; let authorization = ''
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundEndpoint: 'https://payments.example/refund', apiKey: 'server-only-key', merchantId: 'merchant-1', fetch: async (url, init) => { requestUrl = String(url); requestBody = String(init?.body); authorization = String((init?.headers as Record<string, string>)?.authorization); return new Response(JSON.stringify({ provider_refund_id: 'refund-1', state: 'accepted' }), { status: 200 }) } })
    await expect(provider.refund({ channel: 'alipay', orderId: 'recharge-1', providerTradeId: 'trade-1', workspaceId: 'ws-1', amountFen: 1000, reason: '商家申请退款' })).resolves.toEqual({ providerRefundId: 'refund-1', state: 'accepted' })
    expect(requestUrl).toBe('https://payments.example/refund')
    expect(authorization).toBe('Bearer server-only-key')
    expect(requestBody).toContain('"idempotency_key":"refund:recharge-1"')
    expect(requestBody).not.toContain('server-only-key')
    await expect(new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', apiKey: 'key', merchantId: 'merchant' }).refund({ channel: 'wechat', orderId: 'r', providerTradeId: 't', workspaceId: 'w', amountFen: 100, reason: 'r' })).rejects.toThrow('refund endpoint is not configured')
  })

  it('queries provider order status without exposing credentials and normalizes success states', async () => {
    let requestBody = ''; let authorization = ''
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', queryEndpoint: 'https://payments.example/query', apiKey: 'server-only-key', merchantId: 'merchant-1', fetch: async (_url, init) => { requestBody = String(init?.body); authorization = String((init?.headers as Record<string, string>)?.authorization); return new Response(JSON.stringify({ state: 'TRADE_SUCCESS', trade_no: 'trade-9', amount_fen: 1000 }), { status: 200 }) } })
    await expect(provider.queryStatus?.({ channel: 'alipay', orderId: 'recharge-9', workspaceId: 'ws-9' })).resolves.toEqual({ state: 'paid', providerTradeId: 'trade-9', amountFen: 1000 })
    expect(authorization).toBe('Bearer server-only-key')
    expect(requestBody).toContain('"order_id":"recharge-9"')
    expect(requestBody).not.toContain('server-only-key')
  })

  it('rejects an oversized payment provider response before parsing it', async () => {
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024) } }) })
    await expect(provider.createCheckout({ channel: 'wechat', orderId: 'order-1', idempotencyKey: 'key-1', workspaceId: 'ws-1', amountFen: 100, callbackUrl: 'https://merchant.example/callback', description: '充值' })).rejects.toThrow('safety limit')
  })
})
