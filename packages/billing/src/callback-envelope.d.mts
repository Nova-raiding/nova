export type PaymentCallbackEnvelope = {
  channel: 'alipay' | 'wechat'
  workspaceId: string
  orderId: string
  providerTradeId: string
  amountFen: number
  currency: 'CNY'
  state: 'pending' | 'paid' | 'closed' | 'failed'
  timestamp: string
  nonce: string
}

export function paymentCallbackCanonical(input: PaymentCallbackEnvelope): string
export function signPaymentCallback(input: PaymentCallbackEnvelope & { secret: string }): string
