import { createHmac } from 'node:crypto'

export function paymentCallbackCanonical(input) {
  return [
    input.channel,
    input.workspaceId,
    input.orderId,
    input.providerTradeId,
    input.amountFen,
    input.currency,
    input.state,
    input.timestamp,
    input.nonce,
  ].join('|')
}

export function signPaymentCallback(input) {
  return createHmac('sha256', input.secret).update(paymentCallbackCanonical(input)).digest('hex')
}
