export type CommercialPlanCode = 'basic' | 'growth' | 'custom'
export type CatalogLifecycle = 'draft' | 'active'
export type PriceMode = 'fixed' | 'starts_at' | 'custom'

export interface CommercialPolicyReference {
  policyId: string
  version: string
  permission: string
}

export interface SourceStorageTerm {
  /** The source document says `50g`; the approved catalog meaning is decimal GB. */
  sourceLabel: '50g'
  normalizedBytes: number
  normalizationStatus: 'resolved'
  unit: 'GB_DECIMAL'
}

export interface CommercialPlanEntitlements {
  policyRef?: CommercialPolicyReference
  planCode: CommercialPlanCode
  monthlyPriceCny: number | null
  minimumMonthlyPriceCny: number | null
  priceMode: PriceMode
  maxBrands: number | null
  maxStores: number | null
  creativePoints: number | null
  storage: SourceStorageTerm
  serviceHours: number | null
  firstResponseBusinessHours: number | null
  reviewCadence: 'none' | 'monthly' | 'weekly_or_monthly' | 'contract'
  availability: 'included' | 'custom_quote'
  lifecycle: CatalogLifecycle
  executable: boolean
  blockers: readonly string[]
  billingPeriod?: {
    cadence: 'monthly'
    startsAt: 'payment_verified'
    timezone: 'UTC'
    endsAt: 'next_monthly_anniversary'
  }
  creativePointExpiry?: 'billing_period_end'
}

export interface OnboardingOffer {
  policyRef?: CommercialPolicyReference
  code: 'onboarding_once'
  priceCny: 5000
  priceMode: 'fixed'
  grantSchedule: {
    grantCount: 6
    pointsPerGrant: 500
    cadence: 'monthly'
    startsAt: 'payment_verified'
    timezone: 'UTC'
    grantExpiresAtRule: 'next_monthly_anniversary'
    schedulingStatus: 'resolved'
  }
  lifecycle: 'active'
  executable: true
  blockers: readonly []
}

export interface PrivateValidationOffer {
  policyRef?: CommercialPolicyReference
  code: 'private_validation_7d'
  visibility: 'private'
  priceCny: 1999
  durationDays: 7
  period: { startsAt: 'payment_verified'; timezone: 'UTC'; durationDays: 7 }
  maxBrands: 1
  maxStores: 1
  creativePoints: 500
  oneToOneServiceHours: 1
  coreExperienceIncluded: true
  outcomeReviewCount: 1
  onboardingOffset: {
    targetOfferCode: 'onboarding_once'
    amountCny: 5000
    eligibilityWindowDaysAfterValidation: 7
    eligibilityAndAccountingStatus: 'unresolved'
  }
  lifecycle: 'draft'
  executable: false
  blockers: readonly ['PRIVATE_OFFER_ELIGIBILITY_UNRESOLVED', 'PRIVATE_OFFSET_ACCOUNTING_UNRESOLVED']
}

export interface CreativePointPack {
  policyRef?: CommercialPolicyReference
  code: 'points_500' | 'points_2000'
  creativePoints: 500 | 2000
  priceCny: 300 | 1000
  expiryRule: 'purchase_plus_30_natural_days'
  expiryDays: 30
  lifecycle: 'active'
  executable: true
  blockers: readonly []
}

export type CreativePointAction =
  | 'image.generate.standard'
  | 'image.edit.annotation'
  | 'video.generate.standard_15s'
  | 'text.generate'

export interface DraftCreativePointRate {
  policyRef?: CommercialPolicyReference
  action: CreativePointAction
  unit: 'image' | 'video' | 'request'
  points: number | null
  pricingMode: 'fixed'
  variableFormula: null
  lifecycle: 'active'
  approvalStatus: 'approved'
  executable: true
  blockers: readonly string[]
}

/**
 * Local source contract used to seed a versioned catalog. It is never a
 * replacement for the persisted offer snapshot or evidence of production
 * readiness. `50g` deliberately remains unnormalised until its unit is
 * approved; callers must not derive bytes from this catalog.
 */
export const LOCAL_PLAN_ENTITLEMENTS: readonly CommercialPlanEntitlements[] = Object.freeze([
  {
    policyRef: { policyId: 'commercial.plan.basic', version: 'v2', permission: 'commercial.plan.basic.use' },
    planCode: 'basic', monthlyPriceCny: 2000, minimumMonthlyPriceCny: null, priceMode: 'fixed',
    maxBrands: 1, maxStores: 5, creativePoints: 5000,
    storage: { sourceLabel: '50g', normalizedBytes: 50_000_000_000, normalizationStatus: 'resolved', unit: 'GB_DECIMAL' },
    serviceHours: 5, firstResponseBusinessHours: 4, reviewCadence: 'none', availability: 'included',
    lifecycle: 'active', executable: true, blockers: [],
    billingPeriod: { cadence: 'monthly', startsAt: 'payment_verified', timezone: 'UTC', endsAt: 'next_monthly_anniversary' }, creativePointExpiry: 'billing_period_end',
  },
  {
    policyRef: { policyId: 'commercial.plan.growth', version: 'v2', permission: 'commercial.plan.growth.use' },
    planCode: 'growth', monthlyPriceCny: 5000, minimumMonthlyPriceCny: null, priceMode: 'fixed',
    maxBrands: 3, maxStores: 15, creativePoints: 12500,
    storage: { sourceLabel: '50g', normalizedBytes: 50_000_000_000, normalizationStatus: 'resolved', unit: 'GB_DECIMAL' },
    serviceHours: 10, firstResponseBusinessHours: 2, reviewCadence: 'monthly', availability: 'included',
    lifecycle: 'active', executable: true, blockers: [],
    billingPeriod: { cadence: 'monthly', startsAt: 'payment_verified', timezone: 'UTC', endsAt: 'next_monthly_anniversary' }, creativePointExpiry: 'billing_period_end',
  },
  {
    policyRef: { policyId: 'commercial.plan.custom', version: 'v2', permission: 'commercial.plan.custom.contract' },
    planCode: 'custom', monthlyPriceCny: null, minimumMonthlyPriceCny: 10000, priceMode: 'starts_at',
    maxBrands: null, maxStores: null, creativePoints: null,
    storage: { sourceLabel: '50g', normalizedBytes: 50_000_000_000, normalizationStatus: 'resolved', unit: 'GB_DECIMAL' },
    serviceHours: null, firstResponseBusinessHours: null, reviewCadence: 'weekly_or_monthly', availability: 'custom_quote',
    lifecycle: 'draft', executable: false, blockers: ['ORDER_TERMS_REQUIRED'],
  },
])

export const ONBOARDING_OFFER: OnboardingOffer = Object.freeze<OnboardingOffer>({
  policyRef: { policyId: 'commercial.onboarding', version: 'v2', permission: 'commercial.onboarding.purchase' },
  code: 'onboarding_once',
  priceCny: 5000,
  priceMode: 'fixed',
  grantSchedule: {
    grantCount: 6,
    pointsPerGrant: 500,
    cadence: 'monthly',
    startsAt: 'payment_verified',
    timezone: 'UTC',
    grantExpiresAtRule: 'next_monthly_anniversary',
    schedulingStatus: 'resolved',
  },
  lifecycle: 'active',
  executable: true,
  blockers: [],
})

export const PRIVATE_VALIDATION_OFFER: PrivateValidationOffer = Object.freeze<PrivateValidationOffer>({
  policyRef: { policyId: 'commercial.private_validation', version: 'v1', permission: 'commercial.private_sku.read' },
  code: 'private_validation_7d',
  visibility: 'private',
  priceCny: 1999,
  durationDays: 7,
  period: { startsAt: 'payment_verified', timezone: 'UTC', durationDays: 7 },
  maxBrands: 1,
  maxStores: 1,
  creativePoints: 500,
  oneToOneServiceHours: 1,
  coreExperienceIncluded: true,
  outcomeReviewCount: 1,
  onboardingOffset: {
    targetOfferCode: 'onboarding_once',
    amountCny: 5000,
    eligibilityWindowDaysAfterValidation: 7,
    eligibilityAndAccountingStatus: 'unresolved',
  },
  lifecycle: 'draft',
  executable: false,
  blockers: ['PRIVATE_OFFER_ELIGIBILITY_UNRESOLVED', 'PRIVATE_OFFSET_ACCOUNTING_UNRESOLVED'],
})

export const CREATIVE_POINT_PACKS: readonly CreativePointPack[] = Object.freeze([
  { policyRef: { policyId: 'commercial.points.pack.500', version: 'v2', permission: 'commercial.points.pack.purchase' }, code: 'points_500', creativePoints: 500, priceCny: 300, expiryRule: 'purchase_plus_30_natural_days', expiryDays: 30, lifecycle: 'active', executable: true, blockers: [] },
  { policyRef: { policyId: 'commercial.points.pack.2000', version: 'v2', permission: 'commercial.points.pack.purchase' }, code: 'points_2000', creativePoints: 2000, priceCny: 1000, expiryRule: 'purchase_plus_30_natural_days', expiryDays: 30, lifecycle: 'active', executable: true, blockers: [] },
])

export const DRAFT_CREATIVE_POINT_RATES: readonly DraftCreativePointRate[] = Object.freeze([
  { policyRef: { policyId: 'commercial.points.rate.image.generate.standard', version: 'v2', permission: 'commercial.points.consume' }, action: 'image.generate.standard', unit: 'image', points: 1, pricingMode: 'fixed', variableFormula: null, lifecycle: 'active', approvalStatus: 'approved', executable: true, blockers: [] },
  { policyRef: { policyId: 'commercial.points.rate.image.edit.annotation', version: 'v2', permission: 'commercial.points.consume' }, action: 'image.edit.annotation', unit: 'image', points: 1, pricingMode: 'fixed', variableFormula: null, lifecycle: 'active', approvalStatus: 'approved', executable: true, blockers: [] },
  { policyRef: { policyId: 'commercial.points.rate.video.generate.standard_15s', version: 'v2', permission: 'commercial.points.consume' }, action: 'video.generate.standard_15s', unit: 'video', points: 90, pricingMode: 'fixed', variableFormula: null, lifecycle: 'active', approvalStatus: 'approved', executable: true, blockers: [] },
  { policyRef: { policyId: 'commercial.points.rate.text.generate', version: 'v2', permission: 'commercial.points.consume' }, action: 'text.generate', unit: 'request', points: 1, pricingMode: 'fixed', variableFormula: null, lifecycle: 'active', approvalStatus: 'approved', executable: true, blockers: [] },
])

const nonNegativeIntegerFields = [
  'monthlyPriceCny', 'minimumMonthlyPriceCny', 'maxBrands', 'maxStores', 'creativePoints',
  'serviceHours', 'firstResponseBusinessHours',
] as const

export function validatePlanEntitlements(value: CommercialPlanEntitlements): CommercialPlanEntitlements {
  if (!['basic', 'growth', 'custom'].includes(value.planCode)) throw new Error('PLAN_CODE_INVALID')
  for (const field of nonNegativeIntegerFields) {
    const item = value[field]
    if (item !== null && (!Number.isFinite(item) || item < 0 || !Number.isInteger(item))) throw new Error(`PLAN_${field.toUpperCase()}_INVALID`)
  }
  if (value.storage.sourceLabel !== '50g') throw new Error('PLAN_STORAGE_SOURCE_LABEL_INVALID')
  if (!Number.isSafeInteger(value.storage.normalizedBytes) || value.storage.normalizedBytes < 0) throw new Error('PLAN_STORAGE_BYTES_INVALID')
  if (value.storage.normalizationStatus !== 'resolved') throw new Error('PLAN_STORAGE_RESOLUTION_INCONSISTENT')
  if (value.planCode !== 'custom' && [value.monthlyPriceCny, value.maxBrands, value.maxStores, value.creativePoints, value.serviceHours, value.firstResponseBusinessHours].some(item => item === null)) throw new Error('PLAN_STANDARD_ENTITLEMENTS_INCOMPLETE')
  if (value.planCode === 'custom' && value.minimumMonthlyPriceCny === null) throw new Error('PLAN_CUSTOM_MINIMUM_PRICE_REQUIRED')
  if (value.executable && value.lifecycle !== 'active') throw new Error('PLAN_EXECUTION_STATE_INVALID')
  return structuredClone(value)
}

/**
 * Activation is only possible from an approved persisted snapshot. The source
 * catalog intentionally fails here while `50g` or custom order quantities are
 * unresolved.
 */
export function validateResolvedPlanEntitlements(value: CommercialPlanEntitlements): CommercialPlanEntitlements {
  const validated = validatePlanEntitlements(value)
  for (const field of ['maxBrands', 'maxStores', 'creativePoints', 'serviceHours', 'firstResponseBusinessHours'] as const) {
    if (validated[field] === null) throw new Error(`PLAN_${field.toUpperCase()}_REQUIRED_FOR_ACTIVATION`)
  }
  if (validated.storage.normalizationStatus !== 'resolved') throw new Error('PLAN_STORAGE_UNIT_REQUIRED_FOR_ACTIVATION')
  if (validated.lifecycle !== 'active' || !validated.executable || validated.blockers.length > 0) throw new Error('PLAN_NOT_EXECUTABLE')
  return validated
}
