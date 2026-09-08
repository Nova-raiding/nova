import { describe, expect, it, vi } from 'vitest'
import { CommercialPurchaseService } from './commercial-purchase-service.js'
import { PRIVATE_VALIDATION_OFFER } from './commercial-plan-catalog.js'

const privateSku = {
  code: PRIVATE_VALIDATION_OFFER.code,
  kind: 'private_trial' as const,
  version_id: 'private-validation-v2',
  lifecycle: 'approved' as const,
  executable: true as const,
  effective_at: '2026-09-01T00:00:00.000Z',
  blockers: [] as string[],
  server_snapshot_ref: 'snapshot:private-validation-v2',
  server_snapshot: PRIVATE_VALIDATION_OFFER,
}

describe('private trial initial grant contract', () => {
  it('keeps the intended initial entitlement exact and explicit', () => {
    expect(PRIVATE_VALIDATION_OFFER).toMatchObject({
      code: 'private_validation_7d',
      visibility: 'private',
      priceCny: 1999,
      durationDays: 7,
      maxBrands: 1,
      maxStores: 1,
      creativePoints: 500,
      period: { startsAt: 'payment_verified', timezone: 'UTC', durationDays: 7 },
    })
  })

  it('does not treat the unresolved private offer as a grantable public SKU', async () => {
    const createFromServerSnapshot = vi.fn()
    const service = new CommercialPurchaseService(
      { resolveApprovedExecutableSku: async () => null },
      { createFromServerSnapshot, getPaymentStatus: async () => null },
    )

    await expect(service.create({
      workspace_id: 'ws-private-trial',
      actor_id: 'merchant-1',
      purchase_kind: 'purchase',
      sku_code: PRIVATE_VALIDATION_OFFER.code,
      idempotency_key: 'private-trial-initial-1',
      reason: 'private trial must remain fail-closed until grant workflow exists',
    })).rejects.toMatchObject({ code: 'COMMERCIAL_PURCHASE_UNAVAILABLE' })
    expect(createFromServerSnapshot).not.toHaveBeenCalled()
  })

  it('rejects even an approved private SKU until a dedicated grant workflow exists', async () => {
    const createFromServerSnapshot = vi.fn()
    const service = new CommercialPurchaseService(
      { resolveApprovedExecutableSku: async () => privateSku },
      { createFromServerSnapshot, getPaymentStatus: async () => null },
    )

    await expect(service.create({
      workspace_id: 'ws-private-trial',
      actor_id: 'merchant-1',
      purchase_kind: 'purchase',
      sku_code: PRIVATE_VALIDATION_OFFER.code,
      idempotency_key: 'private-trial-initial-2',
      reason: 'private trial requires invite, payment verification and entitlement grant',
    })).rejects.toMatchObject({ code: 'PRIVATE_PURCHASE_UNAVAILABLE' })
    expect(createFromServerSnapshot).not.toHaveBeenCalled()
  })
})
