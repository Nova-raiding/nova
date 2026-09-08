import { describe, expect, it, vi } from 'vitest'
import { CommercialPurchaseService } from './commercial-purchase-service.js'

const request = { workspace_id: 'ws-1', actor_id: 'actor-1', purchase_kind: 'purchase' as const, sku_code: 'basic', idempotency_key: 'order-1', reason: 'subscribe' }
const order = { order_id: 'order-1', workspace_id: 'ws-1', sku_code: 'basic', sku_version_id: 'basic-v2', status: 'pending' as const, amount_fen: 200000, currency: 'CNY' as const, payment_provider: 'alipay', access_revision: null, created_at: '2026-09-02T00:00:00Z', paid_at: null }
const serverSnapshot = Object.freeze({ source: 'server-catalog', version: 'basic-v2' })
const sku = { code: 'basic', kind: 'monthly' as const, version_id: 'basic-v2', lifecycle: 'approved' as const, executable: true as const, effective_at: '2026-09-01T00:00:00Z', blockers: [] as string[], server_snapshot_ref: 'snapshot:basic-v2', server_snapshot: serverSnapshot }
const onboardingOrder = { ...order, sku_code: 'onboarding_once', sku_version_id: 'onboarding-v1', amount_fen: 500000 }
const onboardingSnapshot = Object.freeze({ source: 'server-catalog', version: 'onboarding-v1', amount_fen: 500000, creative_points: 500, benefits: ['six_month_grants'] })
const onboardingSku = { code: 'onboarding_once', kind: 'onboarding' as const, version_id: 'onboarding-v1', lifecycle: 'approved' as const, executable: true as const, effective_at: '2026-09-01T00:00:00Z', blockers: [] as string[], server_snapshot_ref: 'snapshot:onboarding-v1', server_snapshot: onboardingSnapshot }

describe('CommercialPurchaseService', () => {
  it('passes only a server snapshot reference to order creation', async () => {
    const createFromServerSnapshot = vi.fn(async () => order)
    const service = new CommercialPurchaseService({ resolveApprovedExecutableSku: async () => sku }, { createFromServerSnapshot, getPaymentStatus: async () => null })
    await expect(service.create(request)).resolves.toEqual(order)
    expect(createFromServerSnapshot).toHaveBeenCalledWith({ workspace_id: 'ws-1', actor_id: 'actor-1', purchase_kind: 'purchase', server_snapshot_ref: 'snapshot:basic-v2', server_snapshot: serverSnapshot, idempotency_key: 'order-1', reason: 'subscribe' })
  })

  it('accepts onboarding_once only for the server-owned onboarding SKU snapshot', async () => {
    const createFromServerSnapshot = vi.fn(async () => onboardingOrder)
    const service = new CommercialPurchaseService({ resolveApprovedExecutableSku: async () => onboardingSku }, { createFromServerSnapshot, getPaymentStatus: async () => null })
    await expect(service.create({ workspace_id: 'ws-1', actor_id: 'actor-1', purchase_kind: 'onboarding_once', sku_code: 'onboarding_once', idempotency_key: 'onboarding-order-1', reason: '正式接入' })).resolves.toEqual(onboardingOrder)
    expect(createFromServerSnapshot).toHaveBeenCalledWith({ workspace_id: 'ws-1', actor_id: 'actor-1', purchase_kind: 'onboarding_once', server_snapshot_ref: 'snapshot:onboarding-v1', server_snapshot: onboardingSnapshot, idempotency_key: 'onboarding-order-1', reason: '正式接入' })
  })

  it('fails closed for draft, blocked, private, or kind-mismatched SKUs', async () => {
    const orders = { createFromServerSnapshot: vi.fn(async () => order), getPaymentStatus: async () => null }
    for (const candidate of [null, { ...sku, blockers: ['APPROVAL_REQUIRED'] }, { ...sku, kind: 'private_trial' as const }, { ...sku, kind: 'point_pack' as const }]) {
      const service = new CommercialPurchaseService({ resolveApprovedExecutableSku: async () => candidate }, orders)
      await expect(service.create(request)).rejects.toHaveProperty('code')
    }
    expect(orders.createFromServerSnapshot).not.toHaveBeenCalled()
  })

  it('uses the onboarding-specific error for unavailable onboarding SKUs', async () => {
    const orders = { createFromServerSnapshot: vi.fn(async () => order), getPaymentStatus: async () => null }
    const service = new CommercialPurchaseService({ resolveApprovedExecutableSku: async () => null }, orders)
    await expect(service.create({ workspace_id: 'ws-1', actor_id: 'actor-1', purchase_kind: 'onboarding_once', sku_code: 'onboarding_once', idempotency_key: 'onboarding-order-2', reason: '正式接入' })).rejects.toMatchObject({ code: 'ONBOARDING_PURCHASE_UNAVAILABLE' })
    expect(orders.createFromServerSnapshot).not.toHaveBeenCalled()
  })

  it('keeps private_trial fail-closed even when requested through onboarding', async () => {
    const orders = { createFromServerSnapshot: vi.fn(async () => order), getPaymentStatus: async () => null }
    const service = new CommercialPurchaseService({ resolveApprovedExecutableSku: async () => ({ ...onboardingSku, kind: 'private_trial' as const }) }, orders)
    await expect(service.create({ workspace_id: 'ws-1', actor_id: 'actor-1', purchase_kind: 'onboarding_once', sku_code: 'private_validation_7d', idempotency_key: 'private-order-1', reason: '私测' })).rejects.toMatchObject({ code: 'PRIVATE_PURCHASE_UNAVAILABLE' })
    expect(orders.createFromServerSnapshot).not.toHaveBeenCalled()
  })

  it('returns the workspace-scoped payment status and preserves paid without inferring recovery', async () => {
    const paid = { ...order, status: 'paid' as const, paid_at: '2026-09-02T00:01:00Z', access_revision: null }
    const service = new CommercialPurchaseService({ resolveApprovedExecutableSku: async () => sku }, { createFromServerSnapshot: async () => order, getPaymentStatus: async input => input.workspace_id === 'ws-1' ? paid : null })
    await expect(service.paymentStatus({ workspace_id: 'ws-1', actor_id: 'actor-1', order_id: 'order-1' })).resolves.toMatchObject({ status: 'paid', access_revision: null })
  })
})
