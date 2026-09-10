import type { PaymentChannel, PaymentProvider } from '../../billing/src/payment-provider.js'

export interface CommercialCheckoutOrder {
  id: string
  workspaceId: string
  amountFen: number
  currency: 'CNY'
  status: 'pending' | 'paid' | 'failed' | 'closed' | 'refunded' | 'reconciliation_required'
  paymentProvider: string
  checkoutUrl: string | null
  providerOrderId: string | null
  checkoutExpiresAt: string | null
  checkoutIdempotencyKey: string | null
}

export interface CommercialCheckoutOrderPort {
  getPaymentStatus(workspaceId: string, orderId: string): Promise<{ order: CommercialCheckoutOrder; skuCode: string; accessRevision: number | null } | null>
  attachCheckout(input: { workspaceId: string; orderId: string; channel: PaymentChannel; idempotencyKey: string; paymentUrl: string; providerOrderId?: string | null; expiresAt?: string | null }): Promise<{ order: CommercialCheckoutOrder; channel: PaymentChannel; paymentUrl: string; providerOrderId: string | null; expiresAt: string | null; replayed: boolean }>
}

export class CommercialPaymentError extends Error {
  constructor(readonly code: 'COMMERCIAL_ORDER_NOT_FOUND' | 'COMMERCIAL_ORDER_NOT_PAYABLE' | 'COMMERCIAL_CHECKOUT_CONFLICT' | 'COMMERCIAL_PAYMENT_NOT_CONFIGURED' | 'COMMERCIAL_CHECKOUT_FAILED' | 'COMMERCIAL_PAYMENT_RECONCILIATION_REQUIRED' | 'COMMERCIAL_REFUND_FAILED', message: string) {
    super(message)
    this.name = 'CommercialPaymentError'
  }
}

const required = (value: string, field: string) => {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) throw new TypeError(`${field} is required`)
  return value
}

/** Server-owned V2 checkout orchestration. Client input contains only order,
 * channel and idempotency; money and SKU facts are loaded from the order. */
export class CommercialPaymentService {
  constructor(private readonly orders: CommercialCheckoutOrderPort, private readonly provider: PaymentProvider | undefined, private readonly callbackUrl: (channel: PaymentChannel) => string) {}

  async createCheckout(input: { workspaceId: string; orderId: string; channel: PaymentChannel; idempotencyKey: string }): Promise<{ order: CommercialCheckoutOrder; channel: PaymentChannel; paymentUrl: string; providerOrderId: string | null; expiresAt: string | null; replayed: boolean }> {
    required(input.workspaceId, 'workspaceId'); required(input.orderId, 'orderId'); required(input.idempotencyKey, 'idempotencyKey')
    if (input.channel !== 'alipay' && input.channel !== 'wechat') throw new TypeError('channel is unsupported')
    const current = await this.orders.getPaymentStatus(input.workspaceId, input.orderId)
    if (!current) throw new CommercialPaymentError('COMMERCIAL_ORDER_NOT_FOUND', 'commercial order was not found')
    if (current.order.status !== 'pending') {
      if (current.order.checkoutIdempotencyKey === input.idempotencyKey && current.order.checkoutUrl) return { order: current.order, channel: input.channel, paymentUrl: current.order.checkoutUrl, providerOrderId: current.order.providerOrderId, expiresAt: current.order.checkoutExpiresAt, replayed: true }
      throw new CommercialPaymentError('COMMERCIAL_ORDER_NOT_PAYABLE', 'commercial order is not pending')
    }
    if (!this.provider) throw new CommercialPaymentError('COMMERCIAL_PAYMENT_NOT_CONFIGURED', 'payment provider is not configured')
    let checkout
    try {
      checkout = await this.provider.createCheckout({
        channel: input.channel,
        orderId: current.order.id,
        idempotencyKey: input.idempotencyKey,
        workspaceId: current.order.workspaceId,
        amountFen: current.order.amountFen,
        callbackUrl: this.callbackUrl(input.channel),
        description: `merchant-marketing 商业订单 ${current.order.id}`,
      })
    } catch (error) {
      throw new CommercialPaymentError('COMMERCIAL_CHECKOUT_FAILED', error instanceof Error ? error.message : 'payment provider checkout failed')
    }
    try {
      return await this.orders.attachCheckout({ workspaceId: current.order.workspaceId, orderId: current.order.id, channel: input.channel, idempotencyKey: input.idempotencyKey, paymentUrl: checkout.paymentUrl, providerOrderId: checkout.providerOrderId ?? null, expiresAt: checkout.expiresAt ?? null })
    } catch (error) {
      if (error instanceof CommercialPaymentError) throw error
      throw new CommercialPaymentError('COMMERCIAL_CHECKOUT_CONFLICT', error instanceof Error ? error.message : 'checkout resource could not be persisted')
    }
  }

  /** Query is recovery evidence only. It never marks an order paid; a signed
   * callback or separately audited verification must invoke the V2 grant UoW. */
  async queryProviderStatus(input: { workspaceId: string; orderId: string; channel: PaymentChannel }): Promise<{ state: 'pending' | 'paid' | 'closed' | 'failed'; providerTradeId?: string; amountFen?: number; reconciliationRequired: boolean }> {
    const current = await this.orders.getPaymentStatus(input.workspaceId, input.orderId)
    if (!current) throw new CommercialPaymentError('COMMERCIAL_ORDER_NOT_FOUND', 'commercial order was not found')
    if (!this.provider?.queryStatus) throw new CommercialPaymentError('COMMERCIAL_PAYMENT_NOT_CONFIGURED', 'payment provider query is not configured')
    try {
      const status = await this.provider.queryStatus({ channel: input.channel, orderId: current.order.id, workspaceId: current.order.workspaceId })
      const mismatch = status.state === 'paid' && status.amountFen !== current.order.amountFen
      return { ...status, reconciliationRequired: mismatch || (status.state === 'paid' && current.order.status !== 'paid') }
    } catch (error) {
      throw new CommercialPaymentError('COMMERCIAL_PAYMENT_RECONCILIATION_REQUIRED', error instanceof Error ? error.message : 'provider status is unavailable; reconciliation required')
    }
  }

  /** Execute only the external refund leg. The caller must persist the
   * approved request and completion evidence in the refund event repository;
   * a provider response alone never changes order/grant state. */
  async refund(input: { workspaceId: string; orderId: string; channel: PaymentChannel; actorId: string; reason: string }): Promise<{ providerRefundId: string; state?: string }> {
    required(input.workspaceId, 'workspaceId'); required(input.orderId, 'orderId'); required(input.actorId, 'actorId'); required(input.reason, 'reason')
    const current = await this.orders.getPaymentStatus(input.workspaceId, input.orderId)
    if (!current) throw new CommercialPaymentError('COMMERCIAL_ORDER_NOT_FOUND', 'commercial order was not found')
    if (current.order.status !== 'paid' || !current.order.providerOrderId) throw new CommercialPaymentError('COMMERCIAL_ORDER_NOT_PAYABLE', 'only a paid order with a provider trade reference can be refunded')
    if (!this.provider) throw new CommercialPaymentError('COMMERCIAL_PAYMENT_NOT_CONFIGURED', 'payment provider is not configured')
    try {
      return await this.provider.refund({ channel: input.channel, orderId: current.order.id, providerTradeId: current.order.providerOrderId, workspaceId: current.order.workspaceId, amountFen: current.order.amountFen, reason: input.reason })
    } catch (error) {
      throw new CommercialPaymentError('COMMERCIAL_REFUND_FAILED', error instanceof Error ? error.message : 'payment provider refund failed')
    }
  }
}
