export type CommercialPlanCode = 'basic' | 'growth' | 'custom'
export type CatalogLifecycle = 'draft' | 'active'
export type PriceMode = 'fixed' | 'starts_at' | 'custom'

export interface SourceStorageTerm {
  /** The source document says `50g`; it does not define GB or GiB. */
  sourceLabel: '50g'
  normalizedBytes: number | null
  normalizationStatus: 'unit_unresolved' | 'resolved'
}

export interface CommercialPlanEntitlements {
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
}

export interface OnboardingOffer {
  code: 'onboarding_once'
  priceCny: 5000
  priceMode: 'fixed'
  grantSchedule: {
    grantCount: 6
    pointsPerGrant: 500
    cadence: 'monthly'
    startsAt: null
    grantExpiresAtRule: null
    schedulingStatus: 'unresolved'
  }
  lifecycle: 'draft'
  executable: false
  blockers: readonly ['ONBOARDING_GRANT_SCHEDULE_UNRESOLVED']
}

export interface PrivateValidationOffer {
  code: 'private_validation_7d'
  visibility: 'private'
  priceCny: 1999
  durationDays: 7
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
  code: 'points_500' | 'points_2000'
  creativePoints: 500 | 2000
  priceCny: 300 | 1000
  expiryRule: null
  lifecycle: 'draft'
  executable: false
  blockers: readonly ['CREATIVE_POINT_PACK_EXPIRY_UNRESOLVED', 'BUSINESS_APPROVAL_REQUIRED']
}

export type CreativePointAction =
  | 'image.generate.standard'
  | 'image.edit.annotation'
  | 'video.generate.standard_15s'
  | 'text.generate'

export interface DraftCreativePointRate {
  action: CreativePointAction
  unit: 'image' | 'video' | 'request'
  points: number | null
  pricingMode: 'fixed' | 'starts_at' | 'unresolved'
  variableFormula: null
  lifecycle: 'draft'
  approvalStatus: 'pending_business_approval'
  executable: false
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
    planCode: 'basic', monthlyPriceCny: 2000, minimumMonthlyPriceCny: null, priceMode: 'fixed',
    maxBrands: 1, maxStores: 5, creativePoints: 5000,
    storage: { sourceLabel: '50g', normalizedBytes: null, normalizationStatus: 'unit_unresolved' },
    serviceHours: 5, firstResponseBusinessHours: 4, reviewCadence: 'none', availability: 'included',
    lifecycle: 'draft', executable: false, blockers: ['STORAGE_UNIT_UNRESOLVED'],
  },
  {
    planCode: 'growth', monthlyPriceCny: 5000, minimumMonthlyPriceCny: null, priceMode: 'fixed',
    maxBrands: 3, maxStores: 15, creativePoints: 12500,
    storage: { sourceLabel: '50g', normalizedBytes: null, normalizationStatus: 'unit_unresolved' },
    serviceHours: 10, firstResponseBusinessHours: 2, reviewCadence: 'monthly', availability: 'included',
    lifecycle: 'draft', executable: false, blockers: ['STORAGE_UNIT_UNRESOLVED'],
  },
  {
    planCode: 'custom', monthlyPriceCny: null, minimumMonthlyPriceCny: 10000, priceMode: 'starts_at',
    maxBrands: null, maxStores: null, creativePoints: null,
    storage: { sourceLabel: '50g', normalizedBytes: null, normalizationStatus: 'unit_unresolved' },
    serviceHours: null, firstResponseBusinessHours: null, reviewCadence: 'weekly_or_monthly', availability: 'custom_quote',
    lifecycle: 'draft', executable: false, blockers: ['ORDER_TERMS_REQUIRED', 'STORAGE_UNIT_UNRESOLVED'],
  },
])

export const ONBOARDING_OFFER: OnboardingOffer = Object.freeze<OnboardingOffer>({
  code: 'onboarding_once',
  priceCny: 5000,
  priceMode: 'fixed',
  grantSchedule: {
    grantCount: 6,
    pointsPerGrant: 500,
    cadence: 'monthly',
    startsAt: null,
    grantExpiresAtRule: null,
    schedulingStatus: 'unresolved',
  },
  lifecycle: 'draft',
  executable: false,
  blockers: ['ONBOARDING_GRANT_SCHEDULE_UNRESOLVED'],
})

export const PRIVATE_VALIDATION_OFFER: PrivateValidationOffer = Object.freeze<PrivateValidationOffer>({
  code: 'private_validation_7d',
  visibility: 'private',
  priceCny: 1999,
  durationDays: 7,
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
  { code: 'points_500', creativePoints: 500, priceCny: 300, expiryRule: null, lifecycle: 'draft', executable: false, blockers: ['CREATIVE_POINT_PACK_EXPIRY_UNRESOLVED', 'BUSINESS_APPROVAL_REQUIRED'] },
  { code: 'points_2000', creativePoints: 2000, priceCny: 1000, expiryRule: null, lifecycle: 'draft', executable: false, blockers: ['CREATIVE_POINT_PACK_EXPIRY_UNRESOLVED', 'BUSINESS_APPROVAL_REQUIRED'] },
])

export const DRAFT_CREATIVE_POINT_RATES: readonly DraftCreativePointRate[] = Object.freeze([
  { action: 'image.generate.standard', unit: 'image', points: 1, pricingMode: 'fixed', variableFormula: null, lifecycle: 'draft', approvalStatus: 'pending_business_approval', executable: false, blockers: ['BUSINESS_APPROVAL_REQUIRED'] },
  { action: 'image.edit.annotation', unit: 'image', points: 1, pricingMode: 'fixed', variableFormula: null, lifecycle: 'draft', approvalStatus: 'pending_business_approval', executable: false, blockers: ['BUSINESS_APPROVAL_REQUIRED'] },
  { action: 'video.generate.standard_15s', unit: 'video', points: 90, pricingMode: 'starts_at', variableFormula: null, lifecycle: 'draft', approvalStatus: 'pending_business_approval', executable: false, blockers: ['VIDEO_RATE_FORMULA_UNRESOLVED', 'BUSINESS_APPROVAL_REQUIRED'] },
  { action: 'text.generate', unit: 'request', points: null, pricingMode: 'unresolved', variableFormula: null, lifecycle: 'draft', approvalStatus: 'pending_business_approval', executable: false, blockers: ['TEXT_RATE_UNRESOLVED', 'BUSINESS_APPROVAL_REQUIRED'] },
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
  if (value.storage.normalizedBytes !== null && (!Number.isSafeInteger(value.storage.normalizedBytes) || value.storage.normalizedBytes < 0)) throw new Error('PLAN_STORAGE_BYTES_INVALID')
  if ((value.storage.normalizedBytes === null) !== (value.storage.normalizationStatus === 'unit_unresolved')) throw new Error('PLAN_STORAGE_RESOLUTION_INCONSISTENT')
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
  if (validated.storage.normalizedBytes === null || validated.storage.normalizationStatus !== 'resolved') throw new Error('PLAN_STORAGE_UNIT_REQUIRED_FOR_ACTIVATION')
  if (validated.lifecycle !== 'active' || !validated.executable || validated.blockers.length > 0) throw new Error('PLAN_NOT_EXECUTABLE')
  return validated
}
