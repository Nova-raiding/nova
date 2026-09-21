import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { inspectOutboundUrl } from '../../connectors/src/outbound-security.js'
import { readBoundedResponseText } from '../../connectors/src/bounded-response.js'
import { paymentCallbackCanonical } from './callback-envelope.mjs'

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
  /** Durable server-side request id reused for provider retries and queries. */
  refundRequestId?: string
  providerTradeId: string
  workspaceId: string
  amountFen: number
  reason: string
}

export interface PaymentRefundResult {
  providerRefundId: string
  state?: string
}

export interface PaymentRefundStatusInput {
  channel: PaymentChannel
  orderId: string
  refundRequestId: string
  workspaceId: string
  amountFen: number
  providerRefundId?: string
}

export interface PaymentRefundStatusResult {
  state: 'succeeded' | 'failed' | 'pending' | 'unknown'
  providerRefundId?: string
  amountFen?: number
}

export class PaymentProviderRefundRejectedError extends Error {
  readonly code = 'PAYMENT_PROVIDER_REFUND_REJECTED'
  constructor(message = 'payment provider refund was rejected') { super(message); this.name = 'PaymentProviderRefundRejectedError' }
}

export class PaymentProviderRefundOutcomeUnknownError extends Error {
  readonly code = 'PAYMENT_PROVIDER_REFUND_OUTCOME_UNKNOWN'
  constructor(message = 'payment provider refund outcome is unknown') { super(message); this.name = 'PaymentProviderRefundOutcomeUnknownError' }
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

export interface PaymentCallbackPayload {
  orderId: string
  providerTradeId: string
  amountFen: number
  currency: 'CNY'
  state: 'pending' | 'paid' | 'closed' | 'failed'
}

export interface PaymentCallbackProof {
  nonce: string
  signedAt: string
  payloadHash: string
}

/**
 * Verify the gateway-to-API callback envelope. Provider-specific adapters
 * terminate their native WeChat/Alipay signature and send this canonical
 * server-to-server envelope; no callback is payment evidence until this
 * function succeeds. Timestamp and nonce are part of the signed message and
 * must subsequently be consumed transactionally by the persistence layer.
 */
export function verifyPaymentCallbackSignature(input: {
  secret: string
  channel: PaymentChannel
  workspaceId: string
  payload: PaymentCallbackPayload
  signature: string
  timestamp: string
  nonce: string
  nowMs?: number
  maxAgeMs?: number
}): PaymentCallbackProof {
  validChannel(input.channel)
  requiredText(input.secret, 'callback secret')
  requiredText(input.workspaceId, 'workspace id')
  requiredText(input.signature, 'callback signature')
  if (!/^\d{10,13}$/u.test(input.timestamp)) throw new Error('payment callback timestamp is invalid')
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(input.nonce)) throw new Error('payment callback nonce is invalid')
  requiredText(input.payload.orderId, 'callback order id')
  requiredText(input.payload.providerTradeId, 'callback provider trade id')
  validAmount(input.payload.amountFen)
  if (input.payload.currency !== 'CNY') throw new Error('payment callback currency is unsupported')
  if (!['pending', 'paid', 'closed', 'failed'].includes(input.payload.state)) throw new Error('payment callback state is invalid')
  const timestampMs = input.timestamp.length === 10 ? Number(input.timestamp) * 1000 : Number(input.timestamp)
  const nowMs = input.nowMs ?? Date.now()
  const maxAgeMs = input.maxAgeMs ?? 5 * 60_000
  if (!Number.isSafeInteger(timestampMs) || !Number.isFinite(nowMs) || Math.abs(nowMs - timestampMs) > maxAgeMs) throw new Error('payment callback is expired')
  const canonical = paymentCallbackCanonical({ channel: input.channel, workspaceId: input.workspaceId, orderId: input.payload.orderId, providerTradeId: input.payload.providerTradeId, amountFen: input.payload.amountFen, currency: input.payload.currency, state: input.payload.state, timestamp: input.timestamp, nonce: input.nonce })
  const expected = createHmac('sha256', input.secret).update(canonical).digest('hex')
  const provided = input.signature.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/u.test(provided) || !timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))) throw new Error('payment callback signature is invalid')
  return { nonce: input.nonce, signedAt: new Date(timestampMs).toISOString(), payloadHash: createHash('sha256').update(canonical).digest('hex') }
}

export interface PaymentProvider {
  createCheckout(input: PaymentCheckoutInput): Promise<PaymentCheckoutResult>
  queryStatus?(input: PaymentStatusInput): Promise<PaymentStatusResult>
  queryRefundStatus?(input: PaymentRefundStatusInput): Promise<PaymentRefundStatusResult>
  refund(input: PaymentRefundInput): Promise<PaymentRefundResult>
}

function requiredText(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`payment ${field} is required`)
  return value
}

function validAmount(amountFen: number): number {
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) throw new Error('payment amount must be a positive safe integer in fen')
  return amountFen
}

function validChannel(channel: string): asserts channel is PaymentChannel {
  if (channel !== 'alipay' && channel !== 'wechat') throw new Error('payment channel is unsupported')
}

function validateCheckoutInput(input: PaymentCheckoutInput): void {
  validChannel(input.channel)
  requiredText(input.orderId, 'order id')
  requiredText(input.idempotencyKey, 'idempotency key')
  requiredText(input.workspaceId, 'workspace id')
  validAmount(input.amountFen)
  requiredText(input.callbackUrl, 'callback url')
  requiredText(input.description, 'description')
}

function validateStatusInput(input: PaymentStatusInput): void {
  validChannel(input.channel)
  requiredText(input.orderId, 'order id')
  requiredText(input.workspaceId, 'workspace id')
}

function validateRefundInput(input: PaymentRefundInput): void {
  validChannel(input.channel)
  requiredText(input.orderId, 'order id')
  requiredText(input.providerTradeId, 'provider trade id')
  requiredText(input.workspaceId, 'workspace id')
  validAmount(input.amountFen)
  requiredText(input.reason, 'refund reason')
}

function validateRefundStatusInput(input: PaymentRefundStatusInput): void {
  validChannel(input.channel)
  requiredText(input.orderId, 'order id')
  requiredText(input.refundRequestId, 'refund request id')
  requiredText(input.workspaceId, 'workspace id')
  validAmount(input.amountFen)
  if (input.providerRefundId !== undefined) requiredText(input.providerRefundId, 'provider refund id')
}

function refundResponseMatchesInput(payload: unknown, input: PaymentRefundInput, refundRequestId: string): payload is Record<string, unknown> {
  if (!isRecord(payload)) return false
  return payload.order_id === input.orderId
    && payload.refund_request_id === refundRequestId
    && payload.workspace_id === input.workspaceId
    && payload.amount_fen === input.amountFen
}

/** Deterministic local checkout used only by explicit fixture environments. */
export class FixturePaymentProvider implements PaymentProvider {
  private readonly orders = new Map<string, { amountFen: number; idempotencyKey: string; state: PaymentStatusResult['state']; tradeId?: string }>()

  private orderKey(input: Pick<PaymentCheckoutInput, 'workspaceId' | 'channel' | 'orderId'>): string {
    return `${input.workspaceId}\u0000${input.channel}\u0000${input.orderId}`
  }

  async createCheckout(input: PaymentCheckoutInput): Promise<PaymentCheckoutResult> {
    validateCheckoutInput(input)
    const existing = this.orders.get(this.orderKey(input))
    if (existing && (existing.amountFen !== input.amountFen || existing.idempotencyKey !== input.idempotencyKey)) throw new Error('fixture payment order idempotency conflict')
    if (!existing) this.orders.set(this.orderKey(input), { amountFen: input.amountFen, idempotencyKey: input.idempotencyKey, state: 'pending' })
    return { paymentUrl: `fixture://${input.channel}/${input.workspaceId}/${input.amountFen}?order_id=${encodeURIComponent(input.orderId)}`, providerOrderId: input.orderId }
  }

  async queryStatus(input: PaymentStatusInput): Promise<PaymentStatusResult> {
    validateStatusInput(input)
    const order = this.orders.get(this.orderKey(input))
    return order ? { state: order.state, ...(order.tradeId ? { providerTradeId: order.tradeId } : {}), amountFen: order.amountFen } : { state: 'failed' }
  }

  async refund(input: PaymentRefundInput): Promise<PaymentRefundResult> {
    validateRefundInput(input)
    const order = this.orders.get(this.orderKey(input))
    if (!order || order.amountFen !== input.amountFen || order.state !== 'paid') throw new Error('fixture payment order is not refundable')
    order.state = 'closed'
    return { providerRefundId: `fixture-refund-${input.orderId}`, state: 'accepted' }
  }

  async queryRefundStatus(input: PaymentRefundStatusInput): Promise<PaymentRefundStatusResult> {
    validateRefundStatusInput(input)
    const order = this.orders.get(this.orderKey(input))
    if (!order || order.amountFen !== input.amountFen) return { state: 'unknown' }
    return { state: order.state === 'closed' ? 'succeeded' : order.state === 'paid' ? 'pending' : 'unknown', providerRefundId: `fixture-refund-${input.orderId}`, amountFen: order.amountFen }
  }

  /** Test/local checkout confirmation; never exposed through production configuration. */
  confirm(input: { workspaceId: string; channel: PaymentChannel; orderId: string; providerTradeId?: string }) {
    validateStatusInput(input)
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
  refundQueryEndpoint?: string
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

/**
 * Classify the state a provider reports for a submitted refund. A refund is an
 * irreversible money movement, so an absent or blank state is missing evidence
 * rather than an acceptance: it stays `unknown` so the caller keeps the wallet
 * hold and reconciles through the refund-query path, which classifies the same
 * input as `unknown`.
 */
export function classifyPaymentRefundState(state: string | undefined): 'accepted' | 'rejected' | 'unknown' {
  if (state === undefined || !state.trim()) return 'unknown'
  const normalized = state.trim().toLowerCase()
  if (['accepted', 'success', 'succeeded', 'completed'].includes(normalized)) return 'accepted'
  if (['rejected', 'failed', 'failure', 'closed', 'cancelled', 'canceled', 'denied'].includes(normalized)) return 'rejected'
  return 'unknown'
}

export function normalizePaymentRefundQueryState(state: string | undefined): PaymentRefundStatusResult['state'] {
  if (state === undefined || !state.trim()) return 'unknown'
  const normalized = state.trim().toLowerCase()
  if (['succeeded', 'success', 'completed', 'refunded', 'refund_success'].includes(normalized)) return 'succeeded'
  if (['failed', 'failure', 'rejected', 'closed', 'cancelled', 'canceled', 'denied', 'refund_failed', 'refund_closed'].includes(normalized)) return 'failed'
  if (['pending', 'processing', 'wait', 'waiting', 'refund_processing'].includes(normalized)) return 'pending'
  return 'unknown'
}

export class HttpPaymentProvider implements PaymentProvider {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: HttpPaymentProviderOptions) {
    for (const [label, endpoint] of [['provider', options.endpoint], ['refund', options.refundEndpoint], ['refund query', options.refundQueryEndpoint], ['query', options.queryEndpoint]] as const) {
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
    validateStatusInput(input)
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
      const state = rawState === 'success' || rawState === 'paid' || rawState === 'trade_success' ? 'paid' : rawState === 'closed' || rawState === 'cancelled' ? 'closed' : rawState === 'failed' || rawState === 'refunded' ? 'failed' : rawState === 'pending' || rawState === 'processing' ? 'pending' : undefined
      if (!state) throw new Error('payment provider status returned an unknown state')
      if (isRecord(payload) && payload.order_id !== undefined && payload.order_id !== input.orderId) throw new Error('payment provider status response did not match the order')
      const terminal = state === 'paid' || state === 'closed' || state === 'failed'
      if (terminal && (!isRecord(payload) || payload.order_id !== input.orderId)) throw new Error('payment provider terminal status must identify the requested order')
      if (terminal && (!isRecord(payload) || payload.workspace_id !== input.workspaceId)) throw new Error('payment provider terminal status must identify the requested workspace')
      const providerTradeId = isRecord(payload) && typeof payload.provider_trade_id === 'string' ? payload.provider_trade_id : isRecord(payload) && typeof payload.trade_no === 'string' ? payload.trade_no : undefined
      const rawAmountFen = isRecord(payload) ? payload.amount_fen : undefined
      const amountFen = typeof rawAmountFen === 'number' && Number.isSafeInteger(rawAmountFen) && rawAmountFen > 0 ? rawAmountFen : undefined
      if (state === 'paid' && amountFen === undefined) throw new Error('payment provider paid status must include a positive amount in fen')
      if (state === 'paid' && !providerTradeId) throw new Error('payment provider paid status must include a provider trade id')
      return { state, ...(providerTradeId ? { providerTradeId } : {}), ...(amountFen !== undefined ? { amountFen } : {}) }
    } finally { clearTimeout(timeout) }
  }

  async createCheckout(input: PaymentCheckoutInput): Promise<PaymentCheckoutResult> {
    validateCheckoutInput(input)
    let callback: URL
    try { callback = new URL(input.callbackUrl) } catch { throw new Error('payment callback url is invalid') }
    if (callback.protocol !== 'https:') throw new Error('payment callback url must use HTTPS')
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
      if (!isRecord(payload) || payload.order_id !== input.orderId || payload.workspace_id !== input.workspaceId || payload.amount_fen !== input.amountFen) throw new Error('payment provider checkout response did not match the request')
      return { paymentUrl, ...(isRecord(payload) && typeof payload.provider_order_id === 'string' ? { providerOrderId: payload.provider_order_id } : {}), ...(isRecord(payload) && typeof payload.expires_at === 'string' ? { expiresAt: payload.expires_at } : {}) }
    } finally { clearTimeout(timeout) }
  }

  async refund(input: PaymentRefundInput): Promise<PaymentRefundResult> {
    validateRefundInput(input)
    if (!this.options.refundEndpoint) throw new Error('payment provider refund endpoint is not configured')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000)
    try {
      const refundRequestId = input.refundRequestId?.trim() || `refund:${input.orderId}`
      const response = await this.fetchImpl(this.options.refundEndpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ merchant_id: this.options.merchantId, channel: input.channel, order_id: input.orderId, refund_request_id: refundRequestId, provider_trade_id: input.providerTradeId, workspace_id: input.workspaceId, amount_fen: input.amountFen, reason: input.reason, idempotency_key: refundRequestId }),
        signal: controller.signal,
        redirect: 'error',
      })
      const responseText = await readBoundedResponseText(response, MAX_PAYMENT_PROVIDER_RESPONSE_BYTES, 'payment provider response')
      if (!response.ok) {
        let rejected = false
        try {
          const errorPayload = JSON.parse(responseText) as unknown
          const errorState = isRecord(errorPayload) && typeof errorPayload.state === 'string' ? errorPayload.state : undefined
          const classification = classifyPaymentRefundState(errorState)
          rejected = classification === 'rejected' && refundResponseMatchesInput(errorPayload, input, refundRequestId)
        } catch {}
        if (rejected) throw new PaymentProviderRefundRejectedError(`payment provider refund returned HTTP ${response.status}`)
        throw new PaymentProviderRefundOutcomeUnknownError(`payment provider refund outcome unknown after HTTP ${response.status}`)
      }
      let payload: unknown
      try { payload = JSON.parse(responseText) as unknown } catch { throw new PaymentProviderRefundOutcomeUnknownError('payment provider refund response was not valid JSON') }
      if (!refundResponseMatchesInput(payload, input, refundRequestId)) throw new PaymentProviderRefundOutcomeUnknownError('payment provider refund response did not match the request')
      const providerRefundId = isRecord(payload) && typeof payload.provider_refund_id === 'string' ? payload.provider_refund_id : isRecord(payload) && typeof payload.refund_id === 'string' ? payload.refund_id : undefined
      const state = isRecord(payload) && typeof payload.state === 'string' ? payload.state : undefined
      const classification = classifyPaymentRefundState(state)
      if (classification === 'rejected') throw new PaymentProviderRefundRejectedError(`payment provider refund was rejected: ${state}`)
      if (classification === 'unknown') throw new PaymentProviderRefundOutcomeUnknownError(`payment provider refund outcome unknown: ${state}`)
      if (!providerRefundId) throw new PaymentProviderRefundOutcomeUnknownError('payment provider returned no refund id')
      return { providerRefundId, ...(state ? { state } : {}) }
    } catch (error) {
      if (error instanceof PaymentProviderRefundRejectedError || error instanceof PaymentProviderRefundOutcomeUnknownError) throw error
      throw new PaymentProviderRefundOutcomeUnknownError(error instanceof Error ? error.message : 'payment provider refund outcome is unknown')
    } finally { clearTimeout(timeout) }
  }

  async queryRefundStatus(input: PaymentRefundStatusInput): Promise<PaymentRefundStatusResult> {
    validateRefundStatusInput(input)
    if (!this.options.refundQueryEndpoint) throw new Error('payment provider refund query endpoint is not configured')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000)
    try {
      const response = await this.fetchImpl(this.options.refundQueryEndpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ merchant_id: this.options.merchantId, channel: input.channel, order_id: input.orderId, refund_request_id: input.refundRequestId, ...(input.providerRefundId ? { provider_refund_id: input.providerRefundId } : {}), workspace_id: input.workspaceId, amount_fen: input.amountFen }),
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) return { state: 'unknown' }
      let payload: unknown
      try { payload = JSON.parse(await readBoundedResponseText(response, MAX_PAYMENT_PROVIDER_RESPONSE_BYTES, 'payment provider response')) as unknown } catch { return { state: 'unknown' } }
      if (!isRecord(payload)) return { state: 'unknown' }
      if (payload.order_id !== input.orderId || payload.refund_request_id !== input.refundRequestId || payload.workspace_id !== input.workspaceId) return { state: 'unknown' }
      const rawAmountFen = payload.amount_fen
      const amountFen = typeof rawAmountFen === 'number' && Number.isSafeInteger(rawAmountFen) && rawAmountFen > 0 ? rawAmountFen : undefined
      const state = normalizePaymentRefundQueryState(typeof payload.state === 'string' ? payload.state : undefined)
      if (state !== 'unknown' && amountFen !== input.amountFen) return { state: 'unknown' }
      const providerRefundId = typeof payload.provider_refund_id === 'string' ? payload.provider_refund_id : typeof payload.refund_id === 'string' ? payload.refund_id : undefined
      if (input.providerRefundId && providerRefundId !== input.providerRefundId) return { state: 'unknown' }
      if (state === 'unknown') return { state }
      if (state === 'succeeded' && !providerRefundId) return { state: 'unknown' }
      return { state, ...(providerRefundId ? { providerRefundId } : {}), ...(amountFen !== undefined ? { amountFen } : {}) }
    } catch {
      return { state: 'unknown' }
    } finally { clearTimeout(timeout) }
  }
}

export function createPaymentProviderFromEnv(source: Record<string, string | undefined> = process.env): PaymentProvider | undefined {
  const endpoint = source.PAYMENT_PROVIDER_CHECKOUT_API_URL?.trim()
  const refundEndpoint = source.PAYMENT_PROVIDER_REFUND_API_URL?.trim()
  const refundQueryEndpoint = source.PAYMENT_PROVIDER_REFUND_QUERY_API_URL?.trim()
  const queryEndpoint = source.PAYMENT_PROVIDER_QUERY_API_URL?.trim()
  const apiKey = source.PAYMENT_PROVIDER_API_KEY?.trim()
  const merchantId = source.PAYMENT_PROVIDER_MERCHANT_ID?.trim()
  if (!endpoint || !apiKey || !merchantId) return undefined
  const timeoutText = source.PAYMENT_PROVIDER_TIMEOUT_MS?.trim()
  const timeoutMs = timeoutText === undefined || timeoutText === '' ? 15_000 : Number(timeoutText)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) return undefined
  try { return new HttpPaymentProvider({ endpoint, ...(refundEndpoint ? { refundEndpoint } : {}), ...(refundQueryEndpoint ? { refundQueryEndpoint } : {}), ...(queryEndpoint ? { queryEndpoint } : {}), apiKey, merchantId, timeoutMs }) } catch { return undefined }
}
