import { describe, expect, it, vi } from 'vitest'
import { CommercialPurchaseService } from './commercial-purchase-service.js'

const request = { workspace_id: 'ws-1', actor_id: 'actor-1', purchase_kind: 'purchase' as const, sku_code: 'basic', idempotency_key: 'order-1', reason: 'subscribe' }
const order = { order_id: 'order-1', workspace_id: 'ws-1', sku_code: 'basic', sku_version_id: 'basic-v2', status: 'pending' as const, amount_fen: 200000, currency: 'CNY' as const, payment_provider: 'alipay', access_revision: null, created_at: '2026-09-02T00:00:00Z', paid_at: null }
const serverSnapshot = Object.freeze({ source: 'server-catalog', version: 'basic-v2' })
const sku = { code: 'basic', kind: 'monthly' as const, version_id: 'basic-v2', lifecycle: 'approved' as const, executable: true as const, effective_at: '2026-09-01T00:00:00Z', blockers: [] as string[], server_snapshot_ref: 'snapshot:basic-v2', server_snapshot: serverSnapshot }

describe('CommercialPurchaseService', () => {
  it('passes only a server snapshot reference to order creation', async () => {
    const createFromServerSnapshot = vi.fn(async () => order)
    const service = new CommercialPurchaseService({ resolveApprovedExecutableSku: async () => sku }, { createFromServerSnapshot, getPaymentStatus: async () => null })
    await expect(service.create(request)).resolves.toEqual(order)
    expect(createFromServerSnapshot).toHaveBeenCalledWith({ workspace_id: 'ws-1', actor_id: 'actor-1', purchase_kind: 'purchase', server_snapshot_ref: 'snapshot:basic-v2', server_snapshot: serverSnapshot, idempotency_key: 'order-1', reason: 'subscribe' })
  })

  it('fails closed for draft, blocked, private, or kind-mismatched SKUs', async () => {
    const orders = { createFromServerSnapshot: vi.fn(async () => order), getPaymentStatus: async () => null }
    for (const candidate of [null, { ...sku, blockers: ['APPROVAL_REQUIRED'] }, { ...sku, kind: 'private_trial' as const }, { ...sku, kind: 'point_pack' as const }]) {
      const service = new CommercialPurchaseService({ resolveApprovedExecutableSku: async () => candidate }, orders)
      await expect(service.create(request)).rejects.toHaveProperty('code')
    }
    expect(orders.createFromServerSnapshot).not.toHaveBeenCalled()
  })

  it('returns the workspace-scoped payment status and preserves paid without inferring recovery', async () => {
    const paid = { ...order, status: 'paid' as const, paid_at: '2026-09-02T00:01:00Z', access_revision: null }
    const service = new CommercialPurchaseService({ resolveApprovedExecutableSku: async () => sku }, { createFromServerSnapshot: async () => order, getPaymentStatus: async input => input.workspace_id === 'ws-1' ? paid : null })
    await expect(service.paymentStatus({ workspace_id: 'ws-1', actor_id: 'actor-1', order_id: 'order-1' })).resolves.toMatchObject({ status: 'paid', access_revision: null })
  })
})
