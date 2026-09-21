import { describe, expect, it } from 'vitest'
import { FixturePaymentProvider, HttpPaymentProvider, PaymentProviderRefundOutcomeUnknownError, PaymentProviderRefundRejectedError, classifyPaymentRefundState, createPaymentProviderFromEnv, normalizePaymentRefundQueryState, verifyPaymentCallbackSignature } from './payment-provider.js'
import { createHmac } from 'node:crypto'
import { paymentCallbackCanonical, signPaymentCallback } from './callback-envelope.mjs'

describe('payment provider adapter', () => {
  it('keeps the production callback canonical contract stable and currency-bound', () => {
    const envelope = { channel: 'alipay' as const, workspaceId: 'ws-1', orderId: 'order-1', providerTradeId: 'trade-1', amountFen: 200000, currency: 'CNY' as const, state: 'paid' as const, timestamp: '1799614800', nonce: 'nonce-123456789012' }
    expect(paymentCallbackCanonical(envelope)).toBe('alipay|ws-1|order-1|trade-1|200000|CNY|paid|1799614800|nonce-123456789012')
    expect(signPaymentCallback({ secret: 'server-secret', ...envelope })).toBe(createHmac('sha256', 'server-secret').update(paymentCallbackCanonical(envelope)).digest('hex'))
  })

  it('verifies a short-lived signed callback and returns a deduplication proof', () => {
    const timestamp = '1799614800'
    const payload = { orderId: 'order-1', providerTradeId: 'trade-1', amountFen: 200000, currency: 'CNY' as const, state: 'paid' as const }
    const canonical = ['alipay', 'ws-1', payload.orderId, payload.providerTradeId, payload.amountFen, payload.currency, payload.state, timestamp, 'nonce-123456789012'].join('|')
    const signature = createHmac('sha256', 'server-secret').update(canonical).digest('hex')
    expect(verifyPaymentCallbackSignature({ secret: 'server-secret', channel: 'alipay', workspaceId: 'ws-1', payload, signature, timestamp, nonce: 'nonce-123456789012', nowMs: 1799614800_000 })).toMatchObject({ nonce: 'nonce-123456789012', payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/u) })
  })

  it('rejects tampering and expired callbacks before payment evidence is accepted', () => {
    const timestamp = '1799614800'
    const payload = { orderId: 'order-1', providerTradeId: 'trade-1', amountFen: 200000, currency: 'CNY' as const, state: 'paid' as const }
    const canonical = ['wechat', 'ws-1', payload.orderId, payload.providerTradeId, payload.amountFen, payload.currency, payload.state, timestamp, 'nonce-123456789012'].join('|')
    const signature = createHmac('sha256', 'server-secret').update(canonical).digest('hex')
    expect(() => verifyPaymentCallbackSignature({ secret: 'server-secret', channel: 'wechat', workspaceId: 'ws-1', payload: { ...payload, amountFen: 200001 }, signature, timestamp, nonce: 'nonce-123456789012', nowMs: 1799614800_000 })).toThrow('signature is invalid')
    expect(() => verifyPaymentCallbackSignature({ secret: 'server-secret', channel: 'wechat', workspaceId: 'ws-1', payload, signature, timestamp, nonce: 'nonce-123456789012', nowMs: 1799614800_000 + 300_001 })).toThrow('expired')
  })

  it.each([
    ['unsupported currency', { currency: 'USD' as never }, 'unsupported'],
    ['unsupported state', { state: 'settled' as never }, 'state is invalid'],
    ['short nonce', {}, 'nonce is invalid'],
  ])('rejects callback evidence with %s', (_name, change, message) => {
    const timestamp = '1799614800'
    const payload = { orderId: 'order-boundary', providerTradeId: 'trade-boundary', amountFen: 1000, currency: 'CNY' as const, state: 'paid' as const }
    const nonce = 'nonce-123456789012'
    const canonical = ['alipay', 'ws-boundary', payload.orderId, payload.providerTradeId, payload.amountFen, payload.currency, payload.state, timestamp, nonce].join('|')
    const signature = createHmac('sha256', 'server-secret').update(canonical).digest('hex')
    const changedPayload = { ...payload, ...change }
    const changedNonce = _name === 'short nonce' ? 'short' : nonce
    expect(() => verifyPaymentCallbackSignature({ secret: 'server-secret', channel: 'alipay', workspaceId: 'ws-boundary', payload: changedPayload, signature, timestamp, nonce: changedNonce, nowMs: 1799614800_000 })).toThrow(message)
  })

  it('accepts a callback exactly at the freshness boundary but rejects one millisecond later', () => {
    const timestamp = '1799614800'
    const payload = { orderId: 'order-freshness', providerTradeId: 'trade-freshness', amountFen: 1000, currency: 'CNY' as const, state: 'paid' as const }
    const nonce = 'nonce-123456789012'
    const canonical = ['alipay', 'ws-freshness', payload.orderId, payload.providerTradeId, payload.amountFen, payload.currency, payload.state, timestamp, nonce].join('|')
    const signature = createHmac('sha256', 'server-secret').update(canonical).digest('hex')
    expect(() => verifyPaymentCallbackSignature({ secret: 'server-secret', channel: 'alipay', workspaceId: 'ws-freshness', payload, signature, timestamp, nonce, nowMs: 1799614800_000 + 300_000 })).not.toThrow()
    expect(() => verifyPaymentCallbackSignature({ secret: 'server-secret', channel: 'alipay', workspaceId: 'ws-freshness', payload, signature, timestamp, nonce, nowMs: 1799614800_000 + 300_001 })).toThrow('expired')
  })

  it('completes a deterministic local fixture checkout and refund without network access', async () => {
    const provider = new FixturePaymentProvider()
    const input = { channel: 'alipay' as const, orderId: 'fixture-order-1', idempotencyKey: 'fixture-key-1', workspaceId: 'ws-fixture', amountFen: 1000, callbackUrl: 'fixture://callback', description: 'local test' }
    await expect(provider.createCheckout(input)).resolves.toMatchObject({ paymentUrl: 'fixture://alipay/ws-fixture/1000?order_id=fixture-order-1', providerOrderId: 'fixture-order-1' })
    await expect(provider.queryStatus({ channel: input.channel, orderId: input.orderId, workspaceId: input.workspaceId })).resolves.toMatchObject({ state: 'pending', amountFen: 1000 })
    provider.confirm({ workspaceId: input.workspaceId, channel: input.channel, orderId: input.orderId })
    await expect(provider.queryStatus({ channel: input.channel, orderId: input.orderId, workspaceId: input.workspaceId })).resolves.toMatchObject({ state: 'paid', providerTradeId: 'fixture-trade-fixture-order-1', amountFen: 1000 })
    await expect(provider.refund({ channel: input.channel, orderId: input.orderId, providerTradeId: 'fixture-trade-fixture-order-1', workspaceId: input.workspaceId, amountFen: 1000, reason: 'test' })).resolves.toMatchObject({ providerRefundId: 'fixture-refund-fixture-order-1', state: 'accepted' })
    await expect(provider.queryRefundStatus?.({ channel: input.channel, orderId: input.orderId, refundRequestId: `refund:${input.orderId}`, workspaceId: input.workspaceId, amountFen: 1000 })).resolves.toMatchObject({ state: 'succeeded', providerRefundId: 'fixture-refund-fixture-order-1', amountFen: 1000 })
    await expect(provider.queryStatus({ channel: input.channel, orderId: input.orderId, workspaceId: input.workspaceId })).resolves.toMatchObject({ state: 'closed' })
  })

  it('keeps fixture orders idempotent and rejects amount reuse', async () => {
    const provider = new FixturePaymentProvider()
    const input = { channel: 'wechat' as const, orderId: 'fixture-order-2', idempotencyKey: 'fixture-key-2', workspaceId: 'ws-fixture', amountFen: 2000, callbackUrl: 'fixture://callback', description: 'local test' }
    await provider.createCheckout(input)
    await expect(provider.createCheckout(input)).resolves.toMatchObject({ providerOrderId: input.orderId })
    await expect(provider.createCheckout({ ...input, amountFen: 3000 })).rejects.toThrow('idempotency conflict')
  })

  it('fails closed when an existing tenant order is retried with a different idempotency key', async () => {
    const provider = new FixturePaymentProvider()
    const input = { channel: 'alipay' as const, orderId: 'fixture-order-idempotency', idempotencyKey: 'key-original', workspaceId: 'ws-fixture', amountFen: 1000, callbackUrl: 'fixture://callback', description: 'local test' }
    await provider.createCheckout(input)
    await expect(provider.createCheckout({ ...input, idempotencyKey: 'key-replayed' })).rejects.toThrow('idempotency conflict')
  })

  it('rejects invalid payment identity and money inputs before fixture state changes', async () => {
    const provider = new FixturePaymentProvider()
    const valid = { channel: 'wechat' as const, orderId: 'fixture-order-validation', idempotencyKey: 'key-validation', workspaceId: 'ws-fixture', amountFen: 1000, callbackUrl: 'fixture://callback', description: 'local test' }
    await expect(provider.createCheckout({ ...valid, workspaceId: ' ' })).rejects.toThrow('workspace id is required')
    await expect(provider.createCheckout({ ...valid, amountFen: 0 })).rejects.toThrow('positive safe integer')
    await expect(provider.createCheckout({ ...valid, channel: 'paypal' as never })).rejects.toThrow('unsupported')
    await expect(provider.queryStatus({ channel: valid.channel, orderId: valid.orderId, workspaceId: '' })).rejects.toThrow('workspace id is required')
    await expect(provider.refund({ channel: valid.channel, orderId: valid.orderId, providerTradeId: '', workspaceId: valid.workspaceId, amountFen: valid.amountFen, reason: 'test' })).rejects.toThrow('provider trade id is required')
    await expect(provider.queryRefundStatus?.({ channel: valid.channel, orderId: valid.orderId, refundRequestId: '', workspaceId: valid.workspaceId, amountFen: valid.amountFen })).rejects.toThrow('refund request id is required')
    await expect(provider.queryStatus({ channel: valid.channel, orderId: valid.orderId, workspaceId: valid.workspaceId })).resolves.toEqual({ state: 'failed' })
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
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', apiKey: 'server-only-key', merchantId: 'merchant-1', fetch: async (_url, init) => { requestBody = String(init?.body); authorization = String((init?.headers as Record<string, string>)?.authorization); return new Response(JSON.stringify({ payment_url: 'https://pay.example/order/1', provider_order_id: 'provider-1', order_id: 'recharge-1', workspace_id: 'ws-1', amount_fen: 1000 }), { status: 200 }) } })
    await expect(provider.createCheckout({ channel: 'wechat', orderId: 'recharge-1', idempotencyKey: 'recharge-key-1', workspaceId: 'ws-1', amountFen: 1000, callbackUrl: 'https://merchant.example/v1/billing/callback/wechat', description: '充值' })).resolves.toEqual({ paymentUrl: 'https://pay.example/order/1', providerOrderId: 'provider-1' })
    expect(authorization).toBe('Bearer server-only-key')
    expect(requestBody).not.toContain('server-only-key')
    expect(requestBody).toContain('"idempotency_key":"recharge-key-1"')
    expect(() => new HttpPaymentProvider({ endpoint: 'http://payments.example/checkout', apiKey: 'key', merchantId: 'merchant' })).toThrow()
    expect(() => new HttpPaymentProvider({ endpoint: 'https://127.0.0.1/checkout', apiKey: 'key', merchantId: 'merchant' })).toThrow(/PRIVATE_ADDRESS_BLOCKED/)
  })

  it('rejects a checkout response that is not bound to the requested tenant order and amount', async () => {
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ payment_url: 'https://pay.example/order/1', provider_order_id: 'provider-1', order_id: 'other-order', workspace_id: 'ws-1', amount_fen: 1000 }), { status: 200 }) })
    await expect(provider.createCheckout({ channel: 'wechat', orderId: 'order-1', idempotencyKey: 'key-1', workspaceId: 'ws-1', amountFen: 1000, callbackUrl: 'https://merchant.example/callback', description: '充值' })).rejects.toThrow('did not match the request')
  })

  it('rejects non-HTTPS provider callback URLs before making a request', async () => {
    let called = false
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', apiKey: 'key', merchantId: 'merchant', fetch: async () => { called = true; return new Response('{}') } })
    await expect(provider.createCheckout({ channel: 'wechat', orderId: 'order-1', idempotencyKey: 'key-1', workspaceId: 'ws-1', amountFen: 100, callbackUrl: 'http://merchant.example/callback', description: '充值' })).rejects.toThrow('callback url must use HTTPS')
    expect(called).toBe(false)
  })

  it('does not create a provider from incomplete deployment configuration', () => {
    expect(createPaymentProviderFromEnv({ PAYMENT_PROVIDER_CHECKOUT_API_URL: 'https://payments.example/checkout', PAYMENT_PROVIDER_MERCHANT_ID: 'merchant' })).toBeUndefined()
    expect(createPaymentProviderFromEnv({ PAYMENT_PROVIDER_CHECKOUT_API_URL: 'http://payments.example/checkout', PAYMENT_PROVIDER_API_KEY: 'key', PAYMENT_PROVIDER_MERCHANT_ID: 'merchant' })).toBeUndefined()
    expect(createPaymentProviderFromEnv({ PAYMENT_PROVIDER_CHECKOUT_API_URL: 'https://payments.example/checkout', PAYMENT_PROVIDER_API_KEY: 'key', PAYMENT_PROVIDER_MERCHANT_ID: 'merchant' })).toBeDefined()
    expect(createPaymentProviderFromEnv({ PAYMENT_PROVIDER_CHECKOUT_API_URL: 'https://payments.example/checkout', PAYMENT_PROVIDER_API_KEY: 'key', PAYMENT_PROVIDER_MERCHANT_ID: 'merchant', PAYMENT_PROVIDER_TIMEOUT_MS: 'invalid' })).toBeUndefined()
    expect(createPaymentProviderFromEnv({ PAYMENT_PROVIDER_CHECKOUT_API_URL: 'https://payments.example/checkout', PAYMENT_PROVIDER_API_KEY: 'key', PAYMENT_PROVIDER_MERCHANT_ID: 'merchant', PAYMENT_PROVIDER_TIMEOUT_MS: '999' })).toBeUndefined()
    expect(createPaymentProviderFromEnv({ PAYMENT_PROVIDER_CHECKOUT_API_URL: 'https://payments.example/checkout', PAYMENT_PROVIDER_API_KEY: 'key', PAYMENT_PROVIDER_MERCHANT_ID: 'merchant', PAYMENT_PROVIDER_TIMEOUT_MS: '120001' })).toBeUndefined()
  })

  it('calls the server-side refund endpoint with an idempotency key and never exposes the API key', async () => {
    let requestUrl = ''; let requestBody = ''; let authorization = ''
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundEndpoint: 'https://payments.example/refund', apiKey: 'server-only-key', merchantId: 'merchant-1', fetch: async (url, init) => { requestUrl = String(url); requestBody = String(init?.body); authorization = String((init?.headers as Record<string, string>)?.authorization); return new Response(JSON.stringify({ order_id: 'recharge-1', refund_request_id: 'billing-tx-refund-1', workspace_id: 'ws-1', amount_fen: 1000, provider_refund_id: 'refund-1', state: 'accepted' }), { status: 200 }) } })
    await expect(provider.refund({ channel: 'alipay', orderId: 'recharge-1', refundRequestId: 'billing-tx-refund-1', providerTradeId: 'trade-1', workspaceId: 'ws-1', amountFen: 1000, reason: '商家申请退款' })).resolves.toEqual({ providerRefundId: 'refund-1', state: 'accepted' })
    expect(requestUrl).toBe('https://payments.example/refund')
    expect(authorization).toBe('Bearer server-only-key')
    expect(requestBody).toContain('"refund_request_id":"billing-tx-refund-1"')
    expect(requestBody).toContain('"idempotency_key":"billing-tx-refund-1"')
    expect(requestBody).not.toContain('server-only-key')
    await expect(new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', apiKey: 'key', merchantId: 'merchant' }).refund({ channel: 'wechat', orderId: 'r', providerTradeId: 't', workspaceId: 'w', amountFen: 100, reason: 'r' })).rejects.toThrow('refund endpoint is not configured')
  })

  it('classifies refund rejection separately from unknown provider outcomes', async () => {
    const rejected = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundEndpoint: 'https://payments.example/refund', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ order_id: 'recharge-rejected', refund_request_id: 'refund:recharge-rejected', workspace_id: 'ws-1', amount_fen: 1000, provider_refund_id: 'refund-rejected', state: 'rejected' }), { status: 200 }) })
    await expect(rejected.refund({ channel: 'alipay', orderId: 'recharge-rejected', providerTradeId: 'trade-rejected', workspaceId: 'ws-1', amountFen: 1000, reason: '拒绝退款' })).rejects.toBeInstanceOf(PaymentProviderRefundRejectedError)

    const processing = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundEndpoint: 'https://payments.example/refund', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ order_id: 'recharge-processing', refund_request_id: 'refund:recharge-processing', workspace_id: 'ws-1', amount_fen: 1000, provider_refund_id: 'refund-processing', state: 'processing' }), { status: 200 }) })
    await expect(processing.refund({ channel: 'alipay', orderId: 'recharge-processing', providerTradeId: 'trade-processing', workspaceId: 'ws-1', amountFen: 1000, reason: '处理中' })).rejects.toBeInstanceOf(PaymentProviderRefundOutcomeUnknownError)

    const timeout = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundEndpoint: 'https://payments.example/refund', apiKey: 'key', merchantId: 'merchant', fetch: async () => { throw new DOMException('timeout', 'AbortError') } })
    await expect(timeout.refund({ channel: 'alipay', orderId: 'recharge-timeout', providerTradeId: 'trade-timeout', workspaceId: 'ws-1', amountFen: 1000, reason: '超时' })).rejects.toBeInstanceOf(PaymentProviderRefundOutcomeUnknownError)

    const mismatched = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundEndpoint: 'https://payments.example/refund', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ order_id: 'another-order', refund_request_id: 'refund:recharge-mismatch', amount_fen: 1000, provider_refund_id: 'refund-mismatch', state: 'completed' }), { status: 200 }) })
    await expect(mismatched.refund({ channel: 'alipay', orderId: 'recharge-mismatch', providerTradeId: 'trade-mismatch', workspaceId: 'ws-1', amountFen: 1000, reason: '错单响应' })).rejects.toBeInstanceOf(PaymentProviderRefundOutcomeUnknownError)

    const crossWorkspace = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundEndpoint: 'https://payments.example/refund', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ order_id: 'recharge-cross-workspace', refund_request_id: 'refund:recharge-cross-workspace', workspace_id: 'ws-other', amount_fen: 1000, provider_refund_id: 'refund-cross-workspace', state: 'completed' }), { status: 200 }) })
    await expect(crossWorkspace.refund({ channel: 'alipay', orderId: 'recharge-cross-workspace', providerTradeId: 'trade-cross-workspace', workspaceId: 'ws-1', amountFen: 1000, reason: '跨租户响应' })).rejects.toBeInstanceOf(PaymentProviderRefundOutcomeUnknownError)

    const unboundClientError = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundEndpoint: 'https://payments.example/refund', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ state: 'rejected' }), { status: 409 }) })
    await expect(unboundClientError.refund({ channel: 'alipay', orderId: 'recharge-http-rejected', providerTradeId: 'trade-http-rejected', workspaceId: 'ws-1', amountFen: 1000, reason: '未绑定错误' })).rejects.toBeInstanceOf(PaymentProviderRefundOutcomeUnknownError)
  })

  it('fails closed when the refund response omits the provider state', async () => {
    // A refund is irreversible, so a missing/blank state is missing evidence,
    // never an acceptance. The refund-query path already classifies the same
    // input as unknown; the submission path must not be more optimistic.
    expect(classifyPaymentRefundState(undefined)).toBe('unknown')
    expect(classifyPaymentRefundState('   ')).toBe('unknown')
    expect(normalizePaymentRefundQueryState(undefined)).toBe('unknown')
    expect(normalizePaymentRefundQueryState('   ')).toBe('unknown')
    expect(classifyPaymentRefundState('accepted')).toBe('accepted')
    expect(classifyPaymentRefundState('completed')).toBe('accepted')
    expect(classifyPaymentRefundState('processing')).toBe('unknown')
    expect(classifyPaymentRefundState('rejected')).toBe('rejected')

    const bound = { order_id: 'recharge-no-state', refund_request_id: 'refund:recharge-no-state', workspace_id: 'ws-1', amount_fen: 1000, provider_refund_id: 'refund-no-state' }
    const request = { channel: 'alipay' as const, orderId: 'recharge-no-state', providerTradeId: 'trade-no-state', workspaceId: 'ws-1', amountFen: 1000, reason: '缺少状态' }

    const absent = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundEndpoint: 'https://payments.example/refund', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify(bound), { status: 200 }) })
    await expect(absent.refund(request)).rejects.toBeInstanceOf(PaymentProviderRefundOutcomeUnknownError)

    const blank = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundEndpoint: 'https://payments.example/refund', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ ...bound, state: '   ' }), { status: 200 }) })
    await expect(blank.refund(request)).rejects.toBeInstanceOf(PaymentProviderRefundOutcomeUnknownError)

    // Equivalence: explicit acceptance evidence is unchanged, and the HTTP
    // error branch keeps its existing bound-rejection/unbound-unknown split.
    const accepted = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundEndpoint: 'https://payments.example/refund', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ ...bound, state: 'accepted' }), { status: 200 }) })
    await expect(accepted.refund(request)).resolves.toEqual({ providerRefundId: 'refund-no-state', state: 'accepted' })

    const boundError = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundEndpoint: 'https://payments.example/refund', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ ...bound, state: 'rejected' }), { status: 409 }) })
    await expect(boundError.refund(request)).rejects.toBeInstanceOf(PaymentProviderRefundRejectedError)

    const unboundError = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundEndpoint: 'https://payments.example/refund', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ state: 'rejected' }), { status: 409 }) })
    await expect(unboundError.refund(request)).rejects.toBeInstanceOf(PaymentProviderRefundOutcomeUnknownError)
  })

  it('queries provider refund status with strict order request and amount binding', async () => {
    let requestUrl = ''; let requestBody = ''; let authorization = ''
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundQueryEndpoint: 'https://payments.example/refund/query', apiKey: 'server-only-key', merchantId: 'merchant-1', fetch: async (url, init) => { requestUrl = String(url); requestBody = String(init?.body); authorization = String((init?.headers as Record<string, string>)?.authorization); return new Response(JSON.stringify({ state: 'REFUND_SUCCESS', order_id: 'recharge-query', refund_request_id: 'refund:recharge-query', workspace_id: 'ws-1', provider_refund_id: 'refund-9', amount_fen: 1000 }), { status: 200 }) } })
    await expect(provider.queryRefundStatus?.({ channel: 'alipay', orderId: 'recharge-query', refundRequestId: 'refund:recharge-query', workspaceId: 'ws-1', amountFen: 1000, providerRefundId: 'refund-9' })).resolves.toEqual({ state: 'succeeded', providerRefundId: 'refund-9', amountFen: 1000 })
    expect(requestUrl).toBe('https://payments.example/refund/query')
    expect(authorization).toBe('Bearer server-only-key')
    expect(requestBody).toContain('"refund_request_id":"refund:recharge-query"')
    expect(requestBody).toContain('"amount_fen":1000')
    expect(requestBody).not.toContain('server-only-key')
  })

  it('fails closed to unknown for ambiguous refund query evidence', async () => {
    for (const payload of [
      { state: 'succeeded', order_id: 'other-order', refund_request_id: 'refund:recharge-query', amount_fen: 1000 },
      { state: 'succeeded', order_id: 'recharge-query', refund_request_id: 'refund:other', amount_fen: 1000 },
      { state: 'succeeded', order_id: 'recharge-query', refund_request_id: 'refund:recharge-query', amount_fen: 1001 },
      { state: 'succeeded', order_id: 'recharge-query', refund_request_id: 'refund:recharge-query', workspace_id: 'ws-other', amount_fen: 1000 },
      { state: 'succeeded', refund_request_id: 'refund:recharge-query', amount_fen: 1000 },
      { state: 'succeeded', order_id: 'recharge-query', amount_fen: 1000 },
      { state: 'mystery', order_id: 'recharge-query', refund_request_id: 'refund:recharge-query', amount_fen: 1000 },
    ]) {
      const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundQueryEndpoint: 'https://payments.example/refund/query', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify(payload), { status: 200 }) })
      await expect(provider.queryRefundStatus?.({ channel: 'alipay', orderId: 'recharge-query', refundRequestId: 'refund:recharge-query', workspaceId: 'ws-1', amountFen: 1000 })).resolves.toEqual({ state: 'unknown' })
    }
  })

  it('requires the returned provider refund id to match the persisted refund id', async () => {
    for (const payload of [
      { state: 'succeeded', order_id: 'recharge-query', refund_request_id: 'refund:recharge-query', amount_fen: 1000 },
      { state: 'succeeded', order_id: 'recharge-query', refund_request_id: 'refund:recharge-query', provider_refund_id: 'refund-other', amount_fen: 1000 },
    ]) {
      const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundQueryEndpoint: 'https://payments.example/refund/query', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify(payload), { status: 200 }) })
      await expect(provider.queryRefundStatus?.({ channel: 'alipay', orderId: 'recharge-query', refundRequestId: 'refund:recharge-query', workspaceId: 'ws-1', amountFen: 1000, providerRefundId: 'refund-expected' })).resolves.toEqual({ state: 'unknown' })
    }
  })

  it('fails closed to unknown for refund query transport and parse failures', async () => {
    const httpFailure = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundQueryEndpoint: 'https://payments.example/refund/query', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ error: 'GATEWAY_ERROR' }), { status: 500 }) })
    await expect(httpFailure.queryRefundStatus?.({ channel: 'alipay', orderId: 'recharge-http', refundRequestId: 'refund:recharge-http', workspaceId: 'ws-1', amountFen: 1000 })).resolves.toEqual({ state: 'unknown' })

    const invalidJson = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundQueryEndpoint: 'https://payments.example/refund/query', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response('{invalid', { status: 200 }) })
    await expect(invalidJson.queryRefundStatus?.({ channel: 'alipay', orderId: 'recharge-json', refundRequestId: 'refund:recharge-json', workspaceId: 'ws-1', amountFen: 1000 })).resolves.toEqual({ state: 'unknown' })

    const networkFailure = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundQueryEndpoint: 'https://payments.example/refund/query', apiKey: 'key', merchantId: 'merchant', fetch: async () => { throw new DOMException('timeout', 'AbortError') } })
    await expect(networkFailure.queryRefundStatus?.({ channel: 'alipay', orderId: 'recharge-network', refundRequestId: 'refund:recharge-network', workspaceId: 'ws-1', amountFen: 1000 })).resolves.toEqual({ state: 'unknown' })

    await expect(new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', apiKey: 'key', merchantId: 'merchant' }).queryRefundStatus?.({ channel: 'alipay', orderId: 'recharge-missing', refundRequestId: 'refund:recharge-missing', workspaceId: 'ws-1', amountFen: 1000 })).rejects.toThrow('refund query endpoint is not configured')
  })

  it('queries provider order status without exposing credentials and normalizes success states', async () => {
    let requestBody = ''; let authorization = ''
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', queryEndpoint: 'https://payments.example/query', apiKey: 'server-only-key', merchantId: 'merchant-1', fetch: async (_url, init) => { requestBody = String(init?.body); authorization = String((init?.headers as Record<string, string>)?.authorization); return new Response(JSON.stringify({ state: 'TRADE_SUCCESS', order_id: 'recharge-9', workspace_id: 'ws-9', trade_no: 'trade-9', amount_fen: 1000 }), { status: 200 }) } })
    await expect(provider.queryStatus?.({ channel: 'alipay', orderId: 'recharge-9', workspaceId: 'ws-9' })).resolves.toEqual({ state: 'paid', providerTradeId: 'trade-9', amountFen: 1000 })
    expect(authorization).toBe('Bearer server-only-key')
    expect(requestBody).toContain('"order_id":"recharge-9"')
    expect(requestBody).not.toContain('server-only-key')
  })

  it('rejects unknown payment states and paid evidence without a provider trade id', async () => {
    for (const payload of [
      { state: 'mystery', order_id: 'recharge-state', workspace_id: 'ws-state', amount_fen: 1000 },
      { state: 'paid', order_id: 'recharge-state', workspace_id: 'ws-state', amount_fen: 1000 },
    ]) {
      const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', queryEndpoint: 'https://payments.example/query', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify(payload), { status: 200 }) })
      await expect(provider.queryStatus?.({ channel: 'alipay', orderId: 'recharge-state', workspaceId: 'ws-state' })).rejects.toThrow(payload.state === 'mystery' ? 'unknown state' : 'provider trade id')
    }
  })

  it('does not treat a succeeded refund query without a provider refund id as evidence', async () => {
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', refundQueryEndpoint: 'https://payments.example/refund/query', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ state: 'succeeded', order_id: 'recharge-query', refund_request_id: 'refund:recharge-query', workspace_id: 'ws-1', amount_fen: 1000 }), { status: 200 }) })
    await expect(provider.queryRefundStatus?.({ channel: 'alipay', orderId: 'recharge-query', refundRequestId: 'refund:recharge-query', workspaceId: 'ws-1', amountFen: 1000 })).resolves.toEqual({ state: 'unknown' })
  })

  it('rejects a paid query without a positive amount before it becomes payment evidence', async () => {
    for (const payload of [{ state: 'paid', order_id: 'order-amount' }, { state: 'paid', order_id: 'order-amount', amount_fen: 0 }, { state: 'paid', order_id: 'order-amount', amount_fen: -1 }, { state: 'paid', order_id: 'order-amount', amount_fen: 1.5 }]) {
      const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', queryEndpoint: 'https://payments.example/query', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ ...payload, workspace_id: 'ws-amount' }), { status: 200 }) })
      await expect(provider.queryStatus?.({ channel: 'alipay', orderId: 'order-amount', workspaceId: 'ws-amount' })).rejects.toThrow('positive amount')
    }
  })

  it('rejects a status query response explicitly bound to another order', async () => {
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', queryEndpoint: 'https://payments.example/query', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ state: 'paid', order_id: 'another-order', workspace_id: 'ws-9', trade_no: 'trade-9', amount_fen: 1000 }), { status: 200 }) })
    await expect(provider.queryStatus?.({ channel: 'alipay', orderId: 'recharge-9', workspaceId: 'ws-9' })).rejects.toThrow('did not match the order')
  })

  it.each(['closed', 'failed'] as const)('rejects an unbound %s terminal query before it can close an order', async state => {
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', queryEndpoint: 'https://payments.example/query', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ state })) })
    await expect(provider.queryStatus?.({ channel: 'alipay', orderId: 'order-terminal', workspaceId: 'ws-terminal' })).rejects.toThrow('terminal status must identify the requested order')
  })

  it('rejects paid query evidence that is not explicitly bound to the requested order', async () => {
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', queryEndpoint: 'https://payments.example/query', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ state: 'paid', workspace_id: 'ws-9', trade_no: 'trade-9', amount_fen: 1000 }), { status: 200 }) })
    await expect(provider.queryStatus?.({ channel: 'alipay', orderId: 'recharge-9', workspaceId: 'ws-9' })).rejects.toThrow('must identify the requested order')
  })

  it('rejects paid query evidence missing or mismatching the requested workspace', async () => {
    for (const workspaceId of [undefined, 'ws-other']) {
      const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', queryEndpoint: 'https://payments.example/query', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response(JSON.stringify({ state: 'paid', order_id: 'recharge-9', ...(workspaceId ? { workspace_id: workspaceId } : {}), trade_no: 'trade-9', amount_fen: 1000 }), { status: 200 }) })
      await expect(provider.queryStatus?.({ channel: 'alipay', orderId: 'recharge-9', workspaceId: 'ws-9' })).rejects.toThrow('must identify the requested workspace')
    }
  })

  it('rejects an oversized payment provider response before parsing it', async () => {
    const provider = new HttpPaymentProvider({ endpoint: 'https://payments.example/checkout', apiKey: 'key', merchantId: 'merchant', fetch: async () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024) } }) })
    await expect(provider.createCheckout({ channel: 'wechat', orderId: 'order-1', idempotencyKey: 'key-1', workspaceId: 'ws-1', amountFen: 100, callbackUrl: 'https://merchant.example/callback', description: '充值' })).rejects.toThrow('safety limit')
  })
})
