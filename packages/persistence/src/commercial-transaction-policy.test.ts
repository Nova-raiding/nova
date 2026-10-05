import { describe, expect, it } from 'vitest'
import type { CommercialCatalogSkuSnapshot } from './commercial-catalog-repository.js'
import { commercialOnboardingGrantSchedule, monthlyAnniversary } from './commercial-contract-repository.js'
import { commercialCycle, commercialPaymentIsTimely, commercialPlanIdentity, commercialPurchasePolicy } from './commercial-transaction-policy.js'
const sku = (payload: Record<string,unknown>): CommercialCatalogSkuSnapshot => ({ kind:'monthly',payload } as CommercialCatalogSkuSnapshot)
describe('frozen commercial transaction policy', () => {
  it('accepts actual arrival before immutable cutoff, including late verification, and excludes its exact boundary', () => {
    const terms = {createdAt:'2026-01-31T23:00:00Z',expiresAt:'2026-02-01T00:00:00Z'}
    expect(commercialPaymentIsTimely({...terms,paidAt:'2026-02-01T07:59:59+08:00'})).toBe(true)
    expect(commercialPaymentIsTimely({...terms,paidAt:'2026-02-01T08:00:00+08:00'})).toBe(false)
    expect(commercialPaymentIsTimely({...terms,paidAt:'2026-01-31T22:59:59Z'})).toBe(false)
  })
  it('rejects unapproved or unbounded payment policies', () => {
    expect(() => commercialPurchasePolicy(sku({purchasePolicy:{approved:false,version:'v1',expiresInSeconds:3600}}))).toThrow()
    expect(() => commercialPurchasePolicy(sku({purchasePolicy:{approved:true,version:'v1',expiresInSeconds:604801}}))).toThrow()
    expect(commercialPurchasePolicy(sku({purchasePolicy:{approved:true,version:'v1',expiresInSeconds:3600}}))).toEqual({version:'v1',expiresInSeconds:3600})
  })
  it('uses explicit cycle and tier identity independently of mutable price', () => {
    const plan=sku({cycle:{unit:'month',count:6},planFamily:'standard',tierRank:2})
    expect(commercialCycle(plan)).toEqual({unit:'month',count:6})
    expect(commercialPlanIdentity(plan)).toEqual({planFamily:'standard',tierRank:2})
    expect(() => commercialPlanIdentity(sku({}))).toThrow()
  })
  it('freezes configurable gift quantity/count and keeps monthly UTC anniversaries', () => {
    const plan=sku({grantSchedule:{grantCount:12,pointsPerGrant:600,cadence:'monthly',startsAt:'payment_verified',grantExpiresAtRule:'next_monthly_anniversary',schedulingStatus:'resolved'}})
    expect(commercialOnboardingGrantSchedule(plan)).toEqual({grantCount:12,pointsPerGrant:600})
    expect(monthlyAnniversary('2026-01-31T23:00:00.000Z',1)).toBe('2026-02-28T23:00:00.000Z')
    expect(monthlyAnniversary('2026-01-31T23:00:00.000Z',2)).toBe('2026-03-31T23:00:00.000Z')
    expect(() => commercialOnboardingGrantSchedule(sku({grantSchedule:{...plan.payload.grantSchedule as object,grantCount:25}}))).toThrow()
  })
})
