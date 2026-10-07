import { describe, expect, it } from 'vitest'
import { FixturePaymentProvider } from './payment-provider.js'

describe('fixture refund reconciliation isolation', () => {
  it('does not expose a refund from another workspace or channel for a colliding order id', async () => {
    const provider = new FixturePaymentProvider()
    const orderId = 'shared-refund-order'
    const create = (workspaceId: string, channel: 'alipay' | 'wechat', amountFen: number) => provider.createCheckout({
      channel,
      orderId,
      idempotencyKey: `${workspaceId}-${channel}-key`,
      workspaceId,
      amountFen,
      callbackUrl: 'fixture://callback',
      description: 'isolated local test',
    })

    await create('workspace-a', 'alipay', 1000)
    await create('workspace-b', 'alipay', 2000)
    await create('workspace-a', 'wechat', 3000)
    provider.confirm({ workspaceId: 'workspace-a', channel: 'alipay', orderId })
    await provider.refund({ channel: 'alipay', orderId, providerTradeId: `fixture-trade-${orderId}`, workspaceId: 'workspace-a', amountFen: 1000, reason: 'local reconciliation test' })

    await expect(provider.queryRefundStatus({ channel: 'alipay', orderId, refundRequestId: `refund:${orderId}`, workspaceId: 'workspace-a', amountFen: 1000 }))
      .resolves.toMatchObject({ state: 'succeeded', providerRefundId: `fixture-refund-${orderId}`, amountFen: 1000 })
    await expect(provider.queryRefundStatus({ channel: 'alipay', orderId, refundRequestId: `refund:${orderId}`, workspaceId: 'workspace-b', amountFen: 2000 }))
      .resolves.toMatchObject({ state: 'unknown' })
    await expect(provider.queryRefundStatus({ channel: 'wechat', orderId, refundRequestId: `refund:${orderId}`, workspaceId: 'workspace-a', amountFen: 3000 }))
      .resolves.toMatchObject({ state: 'unknown' })
  })

  it('returns unknown rather than refund evidence when the reconciliation amount differs', async () => {
    const provider = new FixturePaymentProvider()
    const orderId = 'refund-amount-boundary'
    await provider.createCheckout({ channel: 'wechat', orderId, idempotencyKey: 'refund-amount-key', workspaceId: 'workspace-refund', amountFen: 2500, callbackUrl: 'fixture://callback', description: 'local reconciliation test' })
    provider.confirm({ workspaceId: 'workspace-refund', channel: 'wechat', orderId })
    await provider.refund({ channel: 'wechat', orderId, providerTradeId: `fixture-trade-${orderId}`, workspaceId: 'workspace-refund', amountFen: 2500, reason: 'local reconciliation test' })

    await expect(provider.queryRefundStatus({ channel: 'wechat', orderId, refundRequestId: `refund:${orderId}`, workspaceId: 'workspace-refund', amountFen: 2499 }))
      .resolves.toEqual({ state: 'unknown' })
  })
})
