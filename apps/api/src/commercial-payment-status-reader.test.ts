import { describe, expect, it, vi } from 'vitest'
import type { CommercialOrderPaymentStatusV2 } from '../../../packages/persistence/src/commercial-contract-repository.js'
import { readOwnCommercialPaymentStatus, type OwnCommercialPaymentStatusInput } from './commercial-payment-status-reader.js'

// Synthetic repository records only: these tests do not create or verify a real payment.
const paymentUrl = 'https://pay.example.test/checkout/private-order'
function paymentStatus(): CommercialOrderPaymentStatusV2 {
  return {
    order: {
      id: 'order-own', workspaceId: 'workspace-own', skuId: 'sku-points', skuVersionId: 'sku-points-v1',
      amountFen: 10000, currency: 'CNY', paymentProvider: 'alipay', status: 'pending',
      idempotencyKey: 'purchase-own', requestHash: 'a'.repeat(64), createdByActorId: 'actor-own',
      providerOrderId: 'provider-private-order', checkoutUrl: paymentUrl,
      checkoutExpiresAt: '2026-09-14T01:15:00.000Z', checkoutIdempotencyKey: 'checkout-own',
      createdAt: '2026-09-14T01:00:00.000Z', paidAt: null,
    },
    skuCode: 'points', accessRevision: null,
  }
}

const ownInput = { workspaceId: 'workspace-own', orderId: 'order-own', actorId: 'actor-own' }

describe('strict self-scoped commercial payment status reader', () => {
  it('returns the complete payment record only for its exact workspace, order and creator', async () => {
    const status = paymentStatus()
    const repository = { getPaymentStatus: vi.fn(async () => status) }
    await expect(readOwnCommercialPaymentStatus(repository, ownInput)).resolves.toBe(status)
    expect(repository.getPaymentStatus).toHaveBeenCalledExactlyOnceWith('workspace-own', 'order-own')
  })

  it.each([
    ['another creator in the same workspace', { createdByActorId: 'actor-other' }],
    ['a different workspace', { workspaceId: 'workspace-other' }],
    ['a different order', { id: 'order-other' }],
    ['an empty creator', { createdByActorId: '' }],
    ['a legacy missing creator', { createdByActorId: undefined }],
    ['a case-mismatched creator', { createdByActorId: 'ACTOR-OWN' }],
  ])('returns no record or payment URL for %s', async (_label, overrides) => {
    const status = paymentStatus()
    Object.assign(status.order, overrides)
    const repository = { getPaymentStatus: vi.fn(async () => status) }
    const result = await readOwnCommercialPaymentStatus(repository, ownInput)
    expect(result).toBeNull()
    expect(JSON.stringify(result)).not.toContain(paymentUrl)
    expect(JSON.stringify(result)).not.toContain(status.order.providerOrderId!)
  })

  it('does not grant an administrator implicit access to another creator’s payment', async () => {
    const repository = { getPaymentStatus: vi.fn(async () => paymentStatus()) }
    await expect(readOwnCommercialPaymentStatus(repository, { ...ownInput, actorId: 'workspace-admin' })).resolves.toBeNull()
  })

  it('returns the same null result for an unknown order', async () => {
    const repository = { getPaymentStatus: vi.fn(async () => null) }
    await expect(readOwnCommercialPaymentStatus(repository, ownInput)).resolves.toBeNull()
  })

  it.each([
    { actorId: undefined }, { actorId: null }, { actorId: '' }, { actorId: ' ' },
    { actorId: ' actor-own' }, { actorId: 'actor-own ' },
    { workspaceId: '' }, { workspaceId: ' workspace-own' },
    { orderId: '' }, { orderId: 'order-own ' },
  ])('fails closed before repository access for invalid identity input %j', async overrides => {
    const repository = { getPaymentStatus: vi.fn(async () => paymentStatus()) }
    const input: OwnCommercialPaymentStatusInput = { ...ownInput, ...overrides }
    await expect(readOwnCommercialPaymentStatus(repository, input)).resolves.toBeNull()
    expect(repository.getPaymentStatus).not.toHaveBeenCalled()
  })

  it('does not turn a repository failure into a successful payment response', async () => {
    const repository = { getPaymentStatus: vi.fn(async () => { throw new Error('repository unavailable') }) }
    await expect(readOwnCommercialPaymentStatus(repository, ownInput)).rejects.toThrow('repository unavailable')
  })
})
