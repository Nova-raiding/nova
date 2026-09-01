export type CommercialPlanCode = 'basic' | 'growth' | 'custom'

export interface CommercialPlanEntitlements {
  planCode: CommercialPlanCode
  maxBrands: number | null
  maxStores: number | null
  creativePoints: number | null
  storageBytes: number | null
  serviceHours: number | null
  firstResponseBusinessHours: number | null
  reviewCadence: 'none' | 'monthly' | 'weekly_or_monthly' | 'contract'
  availability: 'included' | 'configuration_required' | 'custom_quote'
}

const GB = 1024 ** 3

/** Local catalog contract. Values are inputs for an Ops-created offer version,
 * never a replacement for the persisted offer or a production readiness claim. */
export const LOCAL_PLAN_ENTITLEMENTS: readonly CommercialPlanEntitlements[] = Object.freeze([
  { planCode: 'basic', maxBrands: 1, maxStores: 5, creativePoints: 2000, storageBytes: 50 * GB, serviceHours: 5, firstResponseBusinessHours: 4, reviewCadence: 'none', availability: 'included' },
  { planCode: 'growth', maxBrands: 3, maxStores: 15, creativePoints: 6500, storageBytes: 50 * GB, serviceHours: 10, firstResponseBusinessHours: 2, reviewCadence: 'monthly', availability: 'included' },
  { planCode: 'custom', maxBrands: null, maxStores: null, creativePoints: null, storageBytes: null, serviceHours: null, firstResponseBusinessHours: null, reviewCadence: 'contract', availability: 'custom_quote' },
])

export function validatePlanEntitlements(value: CommercialPlanEntitlements): CommercialPlanEntitlements {
  if (!value.planCode || !['basic', 'growth', 'custom'].includes(value.planCode)) throw new Error('PLAN_CODE_INVALID')
  for (const field of ['maxBrands', 'maxStores', 'creativePoints', 'storageBytes', 'serviceHours', 'firstResponseBusinessHours'] as const) {
    const item = value[field]
    if (item !== null && (!Number.isFinite(item) || item < 0 || !Number.isInteger(item))) throw new Error(`PLAN_${field.toUpperCase()}_INVALID`)
  }
  if (value.planCode !== 'custom' && [value.maxBrands, value.maxStores, value.creativePoints, value.storageBytes, value.serviceHours, value.firstResponseBusinessHours].some(item => item === null)) throw new Error('PLAN_STANDARD_ENTITLEMENTS_INCOMPLETE')
  return structuredClone(value)
}

/**
 * Validates the representation that may cross the order/subscription boundary.
 * A custom plan can be displayed as "按需" in the catalog, but it must never
 * reach activation with null/unlimited quantities. The caller must resolve the
 * negotiated values from the signed order/SOW first.
 */
export function validateResolvedPlanEntitlements(value: CommercialPlanEntitlements): CommercialPlanEntitlements {
  const validated = validatePlanEntitlements(value)
  const quantitativeFields = ['maxBrands', 'maxStores', 'creativePoints', 'storageBytes', 'serviceHours', 'firstResponseBusinessHours'] as const
  for (const field of quantitativeFields) {
    if (validated[field] === null) throw new Error(`PLAN_${field.toUpperCase()}_REQUIRED_FOR_ACTIVATION`)
  }
  return validated
}
