import { describe, expect, it, vi } from 'vitest'
import { createCommercialCapacity } from './commercial-capacity.js'
import type { ContinuousFeatureEntitlementSnapshotV2 } from '../../../packages/application/src/continuous-feature-entitlement.js'

const currentEntitlement = (maxStores = 2, maxBrands = 2): ContinuousFeatureEntitlementSnapshotV2 => {
  const now = Date.now()
  return {
    id: 'entitlement-v2-test',
    workspaceId: 'ws-commercial-capacity',
    subscriptionPeriodId: 'period-v2-test',
    periodStart: new Date(now - 60_000).toISOString(),
    periodEnd: new Date(now + 60_000).toISOString(),
    periodStatus: 'active',
    catalogVersionId: 'approved-catalog-test',
    skuCode: 'basic',
    resolvedBenefits: [{ code: 'max_brands', quantity: maxBrands }, { code: 'max_stores', quantity: maxStores }],
    unresolvedBlockers: [],
    executable: true,
    checksum: 'a'.repeat(64),
    createdAt: new Date(now - 60_000).toISOString(),
  }
}

describe('production commercial capacity authority', () => {
  it('does not read or allow legacy subscription quotas when authoritative repository is missing', async () => {
    const legacyGet = vi.fn(async () => ({ includedStores: 999999 }))
    const capacity = createCommercialCapacity({ persistence: () => ({}), memoryCommercial: {} as never,
      memorySubscriptions: { get: legacyGet } as never, service: { listPlatformAccounts: () => [] }, isProduction: () => true })
    await expect(capacity.storeCapacity('ws_no_authority')).rejects.toMatchObject({ code: 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE', status: 503 })
    await expect(capacity.requireStorageCapacityLimit('ws_no_authority')).rejects.toMatchObject({ code: 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE', status: 503 })
    expect(legacyGet).not.toHaveBeenCalled()
  })

  it('maps entitlement projection query failures to retryable unavailable without consulting legacy quotas', async () => {
    const listEntitlementSnapshots = vi.fn(async () => { throw new Error('projection temporarily unavailable') })
    const legacyGet = vi.fn(async () => ({ includedStores: 999999 }))
    const capacity = createCommercialCapacity({
      persistence: () => ({ commercialContracts: { listEntitlementSnapshots } } as never),
      memoryCommercial: {} as never,
      memorySubscriptions: { get: legacyGet } as never,
      service: { listPlatformAccounts: () => [] },
      isProduction: () => true,
    })

    await expect(capacity.storeCapacity('ws-commercial-capacity')).rejects.toMatchObject({
      code: 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE',
      status: 503,
      details: { retryable: true },
    })
    expect(listEntitlementSnapshots).toHaveBeenCalledExactlyOnceWith('ws-commercial-capacity', 100)
    expect(legacyGet).not.toHaveBeenCalled()
  })

  it('uses only the active V2 benefit and allows a request exactly at its quota boundary', async () => {
    const listEntitlementSnapshots = vi.fn(async () => [currentEntitlement(2)])
    const capacity = createCommercialCapacity({
      persistence: () => ({ commercialContracts: { listEntitlementSnapshots } } as never),
      memoryCommercial: {} as never,
      memorySubscriptions: { get: vi.fn(async () => ({ includedStores: 999999 })) } as never,
      service: { listPlatformAccounts: () => [{ tokenState: 'active' }, { tokenState: 'revoked' }] as never },
      isProduction: () => true,
    })

    await expect(capacity.storeCapacity('ws-commercial-capacity')).resolves.toMatchObject({
      used: 1,
      included: 2,
      remaining: 1,
      planCode: 'commercial_v2',
    })
    await expect(capacity.requireCommercialCountCapacity({ workspaceId: 'ws-commercial-capacity', code: 'max_brands', used: 2, label: ' 个品牌' }))
      .resolves.toEqual({ used: 2, included: 2 })
  })

  it('returns a stable 402 with exact commercial quota facts only after V2 benefit validation', async () => {
    const listEntitlementSnapshots = vi.fn(async () => [currentEntitlement(2)])
    const capacity = createCommercialCapacity({
      persistence: () => ({ commercialContracts: { listEntitlementSnapshots } } as never),
      memoryCommercial: {} as never,
      memorySubscriptions: {} as never,
      service: { listPlatformAccounts: () => [] },
      isProduction: () => true,
    })

    await expect(capacity.requireCommercialCountCapacity({ workspaceId: 'ws-commercial-capacity', code: 'max_brands', used: 3, label: ' 个品牌' }))
      .rejects.toMatchObject({
        code: 'COMMERCIAL_QUOTA_EXCEEDED',
        status: 402,
        details: {
          used: 3,
          included: 2,
          quota: 'max_brands',
          next_actions: ['commercial.catalog.get', 'commercial.order.create', 'subscription.change'],
        },
      })
  })

  it('returns a stable store quota 402 at the V2 maximum and counts only non-revoked accounts', async () => {
    const capacity = createCommercialCapacity({
      persistence: () => ({ commercialContracts: { listEntitlementSnapshots: async () => [currentEntitlement(2)] } } as never),
      memoryCommercial: {} as never,
      memorySubscriptions: {} as never,
      service: { listPlatformAccounts: () => [{ tokenState: 'active' }, { tokenState: 'pending' }] as never },
      isProduction: () => true,
    })

    await expect(capacity.requireStoreCapacity('ws-commercial-capacity')).rejects.toMatchObject({
      code: 'STORE_QUOTA_EXCEEDED',
      status: 402,
      details: {
        used: 2,
        included: 2,
        remaining: 0,
        planCode: 'commercial_v2',
        next_actions: ['升级套餐增加店铺数', '购买店铺加购包'],
      },
    })
  })
})
