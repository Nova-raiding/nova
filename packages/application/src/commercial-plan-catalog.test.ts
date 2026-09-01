import { describe, expect, it } from 'vitest'
import { LOCAL_PLAN_ENTITLEMENTS, validatePlanEntitlements, validateResolvedPlanEntitlements } from './commercial-plan-catalog.js'

describe('local commercial plan catalog', () => {
  it('exposes auditable basic and growth brand, store, creative and storage limits', () => {
    expect(LOCAL_PLAN_ENTITLEMENTS).toEqual(expect.arrayContaining([
      expect.objectContaining({ planCode: 'basic', maxBrands: 1, maxStores: 5, creativePoints: 5000, serviceHours: 5, firstResponseBusinessHours: 4 }),
      expect.objectContaining({ planCode: 'growth', maxBrands: 3, maxStores: 15, creativePoints: 12500, serviceHours: 10, firstResponseBusinessHours: 2 }),
    ]))
    expect(LOCAL_PLAN_ENTITLEMENTS[0]?.storageBytes).toBe(50 * 1024 ** 3)
  })

  it('fails closed for incomplete standard plans and invalid quantities', () => {
    expect(() => validatePlanEntitlements({ ...LOCAL_PLAN_ENTITLEMENTS[0]!, maxBrands: null })).toThrow('PLAN_STANDARD_ENTITLEMENTS_INCOMPLETE')
    expect(() => validatePlanEntitlements({ ...LOCAL_PLAN_ENTITLEMENTS[0]!, serviceHours: null })).toThrow('PLAN_STANDARD_ENTITLEMENTS_INCOMPLETE')
    expect(() => validatePlanEntitlements({ ...LOCAL_PLAN_ENTITLEMENTS[0]!, maxStores: 1.5 })).toThrow('PLAN_MAXSTORES_INVALID')
    expect(validatePlanEntitlements(LOCAL_PLAN_ENTITLEMENTS[1]!)).not.toBe(LOCAL_PLAN_ENTITLEMENTS[1])
  })

  it('rejects unresolved custom quantities before activation while allowing explicit zero', () => {
    expect(() => validateResolvedPlanEntitlements(LOCAL_PLAN_ENTITLEMENTS[2]!)).toThrow('PLAN_MAXBRANDS_REQUIRED_FOR_ACTIVATION')
    expect(validateResolvedPlanEntitlements({ ...LOCAL_PLAN_ENTITLEMENTS[2]!, maxBrands: 0, maxStores: 0, creativePoints: 0, storageBytes: 0, serviceHours: 0, firstResponseBusinessHours: 0 })).toMatchObject({ planCode: 'custom', maxBrands: 0, storageBytes: 0 })
  })
})
