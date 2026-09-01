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
  it('freezes the three monthly offers without converting the unresolved 50g unit', () => {
    expect(LOCAL_PLAN_ENTITLEMENTS).toEqual([
      expect.objectContaining({ planCode: 'basic', monthlyPriceCny: 2000, maxBrands: 1, maxStores: 5, creativePoints: 5000, serviceHours: 5, firstResponseBusinessHours: 4 }),
      expect.objectContaining({ planCode: 'growth', monthlyPriceCny: 5000, maxBrands: 3, maxStores: 15, creativePoints: 12500, serviceHours: 10, firstResponseBusinessHours: 2 }),
      expect.objectContaining({ planCode: 'custom', monthlyPriceCny: null, minimumMonthlyPriceCny: 10000, maxBrands: null, maxStores: null, creativePoints: null }),
    ])
    for (const plan of LOCAL_PLAN_ENTITLEMENTS) {
      expect(plan.storage).toEqual({ sourceLabel: '50g', normalizedBytes: null, normalizationStatus: 'unit_unresolved' })
      expect(plan).toMatchObject({ lifecycle: 'draft', executable: false })
      expect(plan.blockers).toContain('STORAGE_UNIT_UNRESOLVED')
    }
  })

  it('models the onboarding fee and six monthly grants without inventing dates or expiry', () => {
    expect(ONBOARDING_OFFER).toMatchObject({
      priceCny: 5000,
      grantSchedule: { grantCount: 6, pointsPerGrant: 500, cadence: 'monthly', startsAt: null, grantExpiresAtRule: null, schedulingStatus: 'unresolved' },
      lifecycle: 'draft',
      executable: false,
    })
  })

  it('models the private validation offer and keeps qualification/accounting blocked', () => {
    expect(PRIVATE_VALIDATION_OFFER).toMatchObject({
      visibility: 'private', priceCny: 1999, durationDays: 7, maxBrands: 1, maxStores: 1,
      creativePoints: 500, oneToOneServiceHours: 1, coreExperienceIncluded: true, outcomeReviewCount: 1,
      onboardingOffset: { amountCny: 5000, eligibilityWindowDaysAfterValidation: 7, eligibilityAndAccountingStatus: 'unresolved' },
      lifecycle: 'draft', executable: false,
    })
  })

  it('keeps both point packs unexecutable and does not invent an expiry rule', () => {
    expect(CREATIVE_POINT_PACKS).toEqual([
      expect.objectContaining({ creativePoints: 500, priceCny: 300, expiryRule: null, lifecycle: 'draft', executable: false }),
      expect.objectContaining({ creativePoints: 2000, priceCny: 1000, expiryRule: null, lifecycle: 'draft', executable: false }),
    ])
  })

  it('keeps all rates as non-executable drafts and preserves unresolved formulae', () => {
    expect(DRAFT_CREATIVE_POINT_RATES).toEqual([
      expect.objectContaining({ action: 'image.generate.standard', points: 1, pricingMode: 'fixed', approvalStatus: 'pending_business_approval', executable: false }),
      expect.objectContaining({ action: 'image.edit.annotation', points: 1, pricingMode: 'fixed', approvalStatus: 'pending_business_approval', executable: false }),
      expect.objectContaining({ action: 'video.generate.standard_15s', points: 90, pricingMode: 'starts_at', variableFormula: null, executable: false }),
      expect.objectContaining({ action: 'text.generate', points: null, pricingMode: 'unresolved', variableFormula: null, executable: false }),
    ])
    expect(DRAFT_CREATIVE_POINT_RATES.every(rate => rate.lifecycle === 'draft' && !rate.executable)).toBe(true)
  })

  it('fails closed for incomplete, invalid, or storage-unresolved activation inputs', () => {
    expect(() => validatePlanEntitlements({ ...LOCAL_PLAN_ENTITLEMENTS[0]!, maxBrands: null })).toThrow('PLAN_STANDARD_ENTITLEMENTS_INCOMPLETE')
    expect(() => validatePlanEntitlements({ ...LOCAL_PLAN_ENTITLEMENTS[0]!, maxStores: 1.5 })).toThrow('PLAN_MAXSTORES_INVALID')
    expect(() => validatePlanEntitlements({ ...LOCAL_PLAN_ENTITLEMENTS[0]!, storage: { sourceLabel: '50g', normalizedBytes: null, normalizationStatus: 'resolved' } })).toThrow('PLAN_STORAGE_RESOLUTION_INCONSISTENT')
    expect(() => validateResolvedPlanEntitlements(LOCAL_PLAN_ENTITLEMENTS[0]!)).toThrow('PLAN_STORAGE_UNIT_REQUIRED_FOR_ACTIVATION')
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
      storage: { sourceLabel: '50g' as const, normalizedBytes: 123_456_789, normalizationStatus: 'resolved' as const },
      serviceHours: 12,
      firstResponseBusinessHours: 2,
      lifecycle: 'active' as const,
      executable: true,
      blockers: [],
    }
    expect(validateResolvedPlanEntitlements(resolved)).toMatchObject({ planCode: 'custom', maxBrands: 2, storage: { normalizedBytes: 123_456_789 } })
  })
})
