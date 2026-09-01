import { inspectOutboundUrl } from '../../connectors/src/outbound-security.js'
import { readBoundedResponseText } from '../../connectors/src/bounded-response.js'

export type PaymentChannel = 'alipay' | 'wechat'

export interface PaymentCheckoutInput {
  channel: PaymentChannel
  orderId: string
  /** Stable across retries and API replicas; providers must deduplicate on this key. */
  idempotencyKey: string
  workspaceId: string
  amountFen: number
  callbackUrl: string
  description: string
}

export interface PaymentCheckoutResult {
  paymentUrl: string
  providerOrderId?: string
  expiresAt?: string
}

export interface PaymentRefundInput {
  channel: PaymentChannel
  orderId: string
  providerTradeId: string
  workspaceId: string
  amountFen: number
  reason: string
}

export interface PaymentRefundResult {
  providerRefundId: string
  state?: string
}

export interface PaymentStatusInput {
  channel: PaymentChannel
  orderId: string
  workspaceId: string
}

export interface PaymentStatusResult {
  state: 'pending' | 'paid' | 'closed' | 'failed'
  providerTradeId?: string
  amountFen?: number
}

export interface PaymentProvider {
  createCheckout(input: PaymentCheckoutInput): Promise<PaymentCheckoutResult>
  queryStatus?(input: PaymentStatusInput): Promise<PaymentStatusResult>
  refund(input: PaymentRefundInput): Promise<PaymentRefundResult>
}

/** Deterministic local checkout used only by explicit fixture environments. */
export class FixturePaymentProvider implements PaymentProvider {
  private readonly orders = new Map<string, { amountFen: number; state: PaymentStatusResult['state']; tradeId?: string }>()

  private orderKey(input: Pick<PaymentCheckoutInput, 'workspaceId' | 'channel' | 'orderId'>): string {
    return `${input.workspaceId}\u0000${input.channel}\u0000${input.orderId}`
  }

  async createCheckout(input: PaymentCheckoutInput): Promise<PaymentCheckoutResult> {
    const existing = this.orders.get(this.orderKey(input))
    if (existing && existing.amountFen !== input.amountFen) throw new Error('fixture payment order amount conflict')
    if (!existing) this.orders.set(this.orderKey(input), { amountFen: input.amountFen, state: 'pending' })
    return { paymentUrl: `fixture://${input.channel}/${input.workspaceId}/${input.amountFen}?order_id=${encodeURIComponent(input.orderId)}`, providerOrderId: input.orderId }
  }

  async queryStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    const order = this.orders.get(this.orderKey(input))
    return order ? { state: order.state, ...(order.tradeId ? { providerTradeId: order.tradeId } : {}), amountFen: order.amountFen } : { state: 'failed' }
  }

  async refund(input: PaymentRefundInput): Promise<PaymentRefundResult> {
    const order = this.orders.get(this.orderKey(input))
    if (!order || order.amountFen !== input.amountFen || order.state !== 'paid') throw new Error('fixture payment order is not refundable')
    order.state = 'closed'
    return { providerRefundId: `fixture-refund-${input.orderId}`, state: 'accepted' }
  }

  /** Test/local checkout confirmation; never exposed through production configuration. */
  confirm(input: { workspaceId: string; channel: PaymentChannel; orderId: string; providerTradeId?: string }) {
    const order = this.orders.get(this.orderKey(input))
    if (!order) throw new Error('fixture payment order not found')
    order.state = 'paid'
    order.tradeId = input.providerTradeId ?? `fixture-trade-${input.orderId}`
    return { ...order }
  }
}

export interface HttpPaymentProviderOptions {
  endpoint: string
  refundEndpoint?: string
  queryEndpoint?: string
  apiKey: string
  merchantId: string
  timeoutMs?: number
  fetch?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const MAX_PAYMENT_PROVIDER_RESPONSE_BYTES = 1 * 1024 * 1024

export class HttpPaymentProvider implements PaymentProvider {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: HttpPaymentProviderOptions) {
    for (const [label, endpoint] of [['provider', options.endpoint], ['refund', options.refundEndpoint], ['query', options.queryEndpoint]] as const) {
      if (!endpoint) continue
      let parsed: URL
      try { parsed = new URL(endpoint) } catch { throw new Error(`payment provider ${label} endpoint is invalid`) }
      if (parsed.protocol !== 'https:') throw new Error(`payment provider ${label} endpoint must use HTTPS`)
      const reason = inspectOutboundUrl(endpoint, { environment: process.env.NODE_ENV, resolveDns: false })
      if (reason) throw new Error(`payment provider ${label} endpoint is unsafe: ${reason}`)
    }
    if (!options.apiKey.trim() || !options.merchantId.trim()) throw new Error('payment provider API key and merchant id are required')
    this.fetchImpl = options.fetch ?? fetch
  }

  async queryStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    if (!this.options.queryEndpoint) throw new Error('payment provider query endpoint is not configured')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000)
    try {
      const response = await this.fetchImpl(this.options.queryEndpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ merchant_id: this.options.merchantId, channel: input.channel, order_id: input.orderId, workspace_id: input.workspaceId }),
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) throw new Error(`payment provider query returned HTTP ${response.status}`)
      const payload = JSON.parse(await readBoundedResponseText(response, MAX_PAYMENT_PROVIDER_RESPONSE_BYTES, 'payment provider response')) as unknown
      const rawState = isRecord(payload) && typeof payload.state === 'string' ? payload.state.toLowerCase() : ''
      const state = rawState === 'success' || rawState === 'paid' || rawState === 'trade_success' ? 'paid' : rawState === 'closed' || rawState === 'cancelled' ? 'closed' : rawState === 'failed' || rawState === 'refunded' ? 'failed' : 'pending'
      const providerTradeId = isRecord(payload) && typeof payload.provider_trade_id === 'string' ? payload.provider_trade_id : isRecord(payload) && typeof payload.trade_no === 'string' ? payload.trade_no : undefined
      const amountFen = isRecord(payload) && typeof payload.amount_fen === 'number' && Number.isSafeInteger(payload.amount_fen) ? payload.amount_fen : undefined
      return { state, ...(providerTradeId ? { providerTradeId } : {}), ...(amountFen !== undefined ? { amountFen } : {}) }
    } finally { clearTimeout(timeout) }
  }

  async createCheckout(input: PaymentCheckoutInput): Promise<PaymentCheckoutResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000)
    try {
      const response = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ merchant_id: this.options.merchantId, channel: input.channel, order_id: input.orderId, idempotency_key: input.idempotencyKey, workspace_id: input.workspaceId, amount_fen: input.amountFen, callback_url: input.callbackUrl, description: input.description }),
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) throw new Error(`payment provider returned HTTP ${response.status}`)
      const payload = JSON.parse(await readBoundedResponseText(response, MAX_PAYMENT_PROVIDER_RESPONSE_BYTES, 'payment provider response')) as unknown
      const paymentUrl = isRecord(payload) && typeof payload.payment_url === 'string' ? payload.payment_url : isRecord(payload) && typeof payload.code_url === 'string' ? payload.code_url : undefined
      if (!paymentUrl || !/^(?:https:\/\/|weixin:\/\/|alipays:\/\/)/u.test(paymentUrl)) throw new Error('payment provider returned no supported checkout URI')
      return { paymentUrl, ...(isRecord(payload) && typeof payload.provider_order_id === 'string' ? { providerOrderId: payload.provider_order_id } : {}), ...(isRecord(payload) && typeof payload.expires_at === 'string' ? { expiresAt: payload.expires_at } : {}) }
    } finally { clearTimeout(timeout) }
  }

  async refund(input: PaymentRefundInput): Promise<PaymentRefundResult> {
    if (!this.options.refundEndpoint) throw new Error('payment provider refund endpoint is not configured')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000)
    try {
      const response = await this.fetchImpl(this.options.refundEndpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ merchant_id: this.options.merchantId, channel: input.channel, order_id: input.orderId, provider_trade_id: input.providerTradeId, workspace_id: input.workspaceId, amount_fen: input.amountFen, reason: input.reason, idempotency_key: `refund:${input.orderId}` }),
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) throw new Error(`payment provider refund returned HTTP ${response.status}`)
      const payload = JSON.parse(await readBoundedResponseText(response, MAX_PAYMENT_PROVIDER_RESPONSE_BYTES, 'payment provider response')) as unknown
      const providerRefundId = isRecord(payload) && typeof payload.provider_refund_id === 'string' ? payload.provider_refund_id : isRecord(payload) && typeof payload.refund_id === 'string' ? payload.refund_id : undefined
      if (!providerRefundId) throw new Error('payment provider returned no refund id')
      return { providerRefundId, ...(isRecord(payload) && typeof payload.state === 'string' ? { state: payload.state } : {}) }
    } finally { clearTimeout(timeout) }
  }
}

export function createPaymentProviderFromEnv(source: Record<string, string | undefined> = process.env): PaymentProvider | undefined {
  const endpoint = source.PAYMENT_PROVIDER_CHECKOUT_API_URL?.trim()
  const refundEndpoint = source.PAYMENT_PROVIDER_REFUND_API_URL?.trim()
  const queryEndpoint = source.PAYMENT_PROVIDER_QUERY_API_URL?.trim()
  const apiKey = source.PAYMENT_PROVIDER_API_KEY?.trim()
  const merchantId = source.PAYMENT_PROVIDER_MERCHANT_ID?.trim()
  if (!endpoint || !apiKey || !merchantId) return undefined
  try { return new HttpPaymentProvider({ endpoint, ...(refundEndpoint ? { refundEndpoint } : {}), ...(queryEndpoint ? { queryEndpoint } : {}), apiKey, merchantId, timeoutMs: Number(source.PAYMENT_PROVIDER_TIMEOUT_MS ?? 15_000) }) } catch { return undefined }
}
