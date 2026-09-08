import { describe, expect, it } from 'vitest'
import {
  CREATIVE_POINT_PACKS,
  DRAFT_CREATIVE_POINT_RATES,
  LOCAL_PLAN_ENTITLEMENTS,
  ONBOARDING_OFFER,
  PRIVATE_VALIDATION_OFFER,
  validatePlanEntitlements,
  validateResolvedPlanEntitlements,
} from './commercial-plan-catalog.js'

describe('local commercial catalog source contract', () => {
  it('freezes the three monthly offers with the approved decimal-GB storage contract', () => {
    expect(LOCAL_PLAN_ENTITLEMENTS).toEqual([
      expect.objectContaining({ planCode: 'basic', monthlyPriceCny: 2000, maxBrands: 1, maxStores: 5, creativePoints: 5000, serviceHours: 5, firstResponseBusinessHours: 4 }),
      expect.objectContaining({ planCode: 'growth', monthlyPriceCny: 5000, maxBrands: 3, maxStores: 15, creativePoints: 12500, serviceHours: 10, firstResponseBusinessHours: 2 }),
      expect.objectContaining({ planCode: 'custom', monthlyPriceCny: null, minimumMonthlyPriceCny: 10000, maxBrands: null, maxStores: null, creativePoints: null }),
    ])
    expect(LOCAL_PLAN_ENTITLEMENTS[0]?.storage).toEqual({ sourceLabel: '50g', normalizedBytes: 50_000_000_000, normalizationStatus: 'resolved', unit: 'GB_DECIMAL' })
    expect(LOCAL_PLAN_ENTITLEMENTS[0]).toMatchObject({ policyRef: { version: 'v2' }, billingPeriod: { cadence: 'monthly', startsAt: 'payment_verified', endsAt: 'next_monthly_anniversary' }, creativePointExpiry: 'billing_period_end' })
    expect(LOCAL_PLAN_ENTITLEMENTS[1]?.storage).toEqual({ sourceLabel: '50g', normalizedBytes: 50_000_000_000, normalizationStatus: 'resolved', unit: 'GB_DECIMAL' })
    expect(LOCAL_PLAN_ENTITLEMENTS[1]).toMatchObject({ lifecycle: 'active', executable: true, blockers: [] })
    expect(LOCAL_PLAN_ENTITLEMENTS[2]).toMatchObject({ lifecycle: 'draft', executable: false, blockers: ['ORDER_TERMS_REQUIRED'] })
  })

  it('models the onboarding fee with the approved six-grant schedule', () => {
    expect(ONBOARDING_OFFER).toMatchObject({
      priceCny: 5000,
      grantSchedule: { grantCount: 6, pointsPerGrant: 500, cadence: 'monthly', startsAt: 'payment_verified', timezone: 'UTC', grantExpiresAtRule: 'next_monthly_anniversary', schedulingStatus: 'resolved' },
      lifecycle: 'active',
      executable: true,
      blockers: [],
    })
    expect(ONBOARDING_OFFER.policyRef).toEqual({ policyId: 'commercial.onboarding', version: 'v2', permission: 'commercial.onboarding.purchase' })
  })

  it('models the private validation offer and keeps qualification/accounting blocked', () => {
    expect(PRIVATE_VALIDATION_OFFER).toMatchObject({
      visibility: 'private', priceCny: 1999, durationDays: 7, maxBrands: 1, maxStores: 1,
      creativePoints: 500, oneToOneServiceHours: 1, coreExperienceIncluded: true, outcomeReviewCount: 1,
      onboardingOffset: { amountCny: 5000, eligibilityWindowDaysAfterValidation: 7, eligibilityAndAccountingStatus: 'unresolved' },
      lifecycle: 'draft', executable: false,
    })
  })

  it('keeps both point packs executable only with an explicit expiry rule', () => {
    expect(CREATIVE_POINT_PACKS).toEqual([
      expect.objectContaining({ creativePoints: 500, priceCny: 300, expiryRule: 'purchase_plus_30_natural_days', expiryDays: 30, lifecycle: 'active', executable: true }),
      expect.objectContaining({ creativePoints: 2000, priceCny: 1000, expiryRule: 'purchase_plus_30_natural_days', expiryDays: 30, lifecycle: 'active', executable: true }),
    ])
  })

  it('keeps all rates executable only with approved fixed pricing', () => {
    expect(DRAFT_CREATIVE_POINT_RATES).toEqual([
      expect.objectContaining({ action: 'image.generate.standard', points: 1, pricingMode: 'fixed', approvalStatus: 'approved', executable: true }),
      expect.objectContaining({ action: 'image.edit.annotation', points: 1, pricingMode: 'fixed', approvalStatus: 'approved', executable: true }),
      expect.objectContaining({ action: 'video.generate.standard_15s', points: 90, pricingMode: 'fixed', variableFormula: null, executable: true }),
      expect.objectContaining({ action: 'text.generate', points: 1, pricingMode: 'fixed', variableFormula: null, executable: true }),
    ])
    expect(DRAFT_CREATIVE_POINT_RATES.every(rate => rate.lifecycle === 'active' && rate.approvalStatus === 'approved' && rate.executable)).toBe(true)
    expect(DRAFT_CREATIVE_POINT_RATES.every(rate => rate.policyRef?.permission === 'commercial.points.consume')).toBe(true)
  })

  it('fails closed for incomplete, invalid, or storage-unresolved activation inputs', () => {
    expect(() => validatePlanEntitlements({ ...LOCAL_PLAN_ENTITLEMENTS[0]!, maxBrands: null })).toThrow('PLAN_STANDARD_ENTITLEMENTS_INCOMPLETE')
    expect(() => validatePlanEntitlements({ ...LOCAL_PLAN_ENTITLEMENTS[0]!, maxStores: 1.5 })).toThrow('PLAN_MAXSTORES_INVALID')
    expect(() => validatePlanEntitlements({ ...LOCAL_PLAN_ENTITLEMENTS[0]!, storage: { sourceLabel: '50g', normalizedBytes: null, normalizationStatus: 'resolved', unit: 'GB_DECIMAL' } as never })).toThrow('PLAN_STORAGE_BYTES_INVALID')
    expect(() => validateResolvedPlanEntitlements(LOCAL_PLAN_ENTITLEMENTS[2]!)).toThrow('PLAN_MAXBRANDS_REQUIRED_FOR_ACTIVATION')
  })

  it('accepts only an explicitly resolved and approved activation snapshot', () => {
    const resolved = {
      ...LOCAL_PLAN_ENTITLEMENTS[2]!,
      maxBrands: 2,
      maxStores: 8,
      creativePoints: 9000,
      // The catalog accepts a value only after an upstream approval supplies it;
      // this arbitrary test value does not claim a GB/GiB conversion.
      storage: { sourceLabel: '50g' as const, normalizedBytes: 123_456_789 as 50_000_000_000, normalizationStatus: 'resolved' as const, unit: 'GB_DECIMAL' as const },
      serviceHours: 12,
      firstResponseBusinessHours: 2,
      lifecycle: 'active' as const,
      executable: true,
      blockers: [],
    }
    expect(validateResolvedPlanEntitlements(resolved)).toMatchObject({ planCode: 'custom', maxBrands: 2, storage: { normalizedBytes: 123_456_789 } })
  })
})
