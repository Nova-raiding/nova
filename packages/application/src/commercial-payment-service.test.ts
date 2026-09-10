import { describe, expect, it, vi } from 'vitest'
import type { PaymentProvider } from '../../billing/src/payment-provider.js'
import { CommercialPaymentError, CommercialPaymentService } from './commercial-payment-service.js'

const order = { id: 'cor-1', workspaceId: 'ws-1', amountFen: 200000, currency: 'CNY' as const, status: 'pending' as const, paymentProvider: 'gateway', checkoutUrl: null, providerOrderId: null, checkoutExpiresAt: null, checkoutIdempotencyKey: null }

describe('CommercialPaymentService', () => {
  it('uses immutable order money facts and persists a provider checkout resource', async () => {
    const attachCheckout = vi.fn(async (input: Record<string, unknown>) => ({ order: { ...order, checkoutUrl: input.paymentUrl as string, checkoutIdempotencyKey: input.idempotencyKey as string }, channel: input.channel as 'alipay', paymentUrl: input.paymentUrl as string, providerOrderId: input.providerOrderId as string, expiresAt: null, replayed: false }))
    const provider: PaymentProvider = { createCheckout: vi.fn(async input => ({ paymentUrl: 'https://pay.example/cor-1', providerOrderId: 'po-1', expiresAt: '2026-09-10T01:00:00Z' })), refund: vi.fn(async () => ({ providerRefundId: 'r-1' })) }
    const service = new CommercialPaymentService({ getPaymentStatus: async () => ({ order, skuCode: 'basic', accessRevision: null }), attachCheckout }, provider, channel => `https://api.example/v1/commercial/callback/${channel}`)
    await expect(service.createCheckout({ workspaceId: 'ws-1', orderId: 'cor-1', channel: 'alipay', idempotencyKey: 'checkout-1' })).resolves.toMatchObject({ paymentUrl: 'https://pay.example/cor-1', replayed: false })
    expect(provider.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ amountFen: 200000, callbackUrl: 'https://api.example/v1/commercial/callback/alipay' }))
    expect(provider.createCheckout).not.toHaveBeenCalledWith(expect.objectContaining({ amountFen: 200001 }))
    expect(attachCheckout).toHaveBeenCalledWith(expect.objectContaining({ paymentUrl: 'https://pay.example/cor-1', idempotencyKey: 'checkout-1' }))
    expect(attachCheckout.mock.calls[0]?.[0]).not.toHaveProperty('amountFen')
  })

  it('fails closed when provider configuration is missing or order is not pending', async () => {
    const orders = { getPaymentStatus: async () => ({ order, skuCode: 'basic', accessRevision: null }), attachCheckout: vi.fn() }
    await expect(new CommercialPaymentService(orders, undefined, () => 'https://api.example/callback/alipay').createCheckout({ workspaceId: 'ws-1', orderId: 'cor-1', channel: 'alipay', idempotencyKey: 'key' })).rejects.toMatchObject({ code: 'COMMERCIAL_PAYMENT_NOT_CONFIGURED' })
    const paid = { ...order, status: 'paid' as const }
    await expect(new CommercialPaymentService({ ...orders, getPaymentStatus: async () => ({ order: paid, skuCode: 'basic', accessRevision: 1 }) }, undefined, () => 'https://api.example/callback/alipay').createCheckout({ workspaceId: 'ws-1', orderId: 'cor-1', channel: 'alipay', idempotencyKey: 'key' })).rejects.toMatchObject({ code: 'COMMERCIAL_ORDER_NOT_PAYABLE' })
  })

  it('keeps provider query as reconciliation evidence and uses order amount for refund', async () => {
    const provider: PaymentProvider = {
      createCheckout: vi.fn(async () => ({ paymentUrl: 'https://pay.example/cor-1' })),
      queryStatus: vi.fn(async (): Promise<{ state: 'paid'; providerTradeId: string; amountFen: number }> => ({ state: 'paid', providerTradeId: 'trade-1', amountFen: 200000 })),
      refund: vi.fn(async input => ({ providerRefundId: `refund:${input.orderId}`, state: 'accepted' })),
    }
    const service = new CommercialPaymentService({ getPaymentStatus: async () => ({ order: { ...order, status: 'paid', providerOrderId: 'trade-1' }, skuCode: 'basic', accessRevision: 1 }), attachCheckout: vi.fn() }, provider, channel => `https://api.example/callback/${channel}`)
    await expect(service.queryProviderStatus({ workspaceId: 'ws-1', orderId: 'cor-1', channel: 'alipay' })).resolves.toMatchObject({ state: 'paid', reconciliationRequired: false })
    await expect(service.refund({ workspaceId: 'ws-1', orderId: 'cor-1', channel: 'alipay', actorId: 'finance-1', reason: 'approved refund' })).resolves.toMatchObject({ providerRefundId: 'refund:cor-1' })
    expect(provider.refund).toHaveBeenCalledWith(expect.objectContaining({ amountFen: 200000, providerTradeId: 'trade-1' }))
  })

  it('marks mismatched paid query as reconciliation-required and does not refund', async () => {
    const provider: PaymentProvider = { createCheckout: vi.fn(), queryStatus: vi.fn(async (): Promise<{ state: 'paid'; providerTradeId: string; amountFen: number }> => ({ state: 'paid', providerTradeId: 'trade-1', amountFen: 1 })), refund: vi.fn() }
    const service = new CommercialPaymentService({ getPaymentStatus: async () => ({ order, skuCode: 'basic', accessRevision: null }), attachCheckout: vi.fn() }, provider, () => 'https://api.example/callback/alipay')
    await expect(service.queryProviderStatus({ workspaceId: 'ws-1', orderId: 'cor-1', channel: 'alipay' })).resolves.toMatchObject({ reconciliationRequired: true })
    expect(provider.refund).not.toHaveBeenCalled()
  })
})
