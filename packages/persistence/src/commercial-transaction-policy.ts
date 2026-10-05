import type { CommercialCatalogSkuSnapshot } from './commercial-catalog-repository.js'

export type CommercialPurchaseKindV3 = 'purchase' | 'renewal' | 'onboarding_once' | 'point_pack' | 'upgrade'
export type CommercialGrantStatusV3 = 'pending' | 'active' | 'scheduled' | 'awaiting_dependency' | 'reconciliation_required' | 'refunded'
export interface CommercialOrderTermsV3 {
  purchaseKind: CommercialPurchaseKindV3
  expiresAt: string
  policyVersion: string
  checkoutId: string | null
  onboardingOrderId: string | null
  upgradeQuoteId: string | null
  beneficiaryMemberId?: string | null
}
export interface CommercialCycleV3 { unit: 'month' | 'day'; count: number }

export function commercialCycle(sku: CommercialCatalogSkuSnapshot): CommercialCycleV3 {
  const cycle = sku.payload.cycle as Record<string, unknown> | undefined
  if (!cycle && sku.kind === 'monthly') return { unit: 'month', count: 1 }
  if (!cycle || !['month', 'day'].includes(String(cycle.unit)) || !Number.isSafeInteger(cycle.count) || Number(cycle.count) < 1 || Number(cycle.count) > 366) {
    throw new Error('COMMERCIAL_CYCLE_POLICY_UNRESOLVED')
  }
  return { unit: cycle.unit as CommercialCycleV3['unit'], count: Number(cycle.count) }
}

export function commercialPurchasePolicy(sku: CommercialCatalogSkuSnapshot): { version: string; expiresInSeconds: number } {
  const policy = sku.payload.purchasePolicy as Record<string, unknown> | undefined
  if (!policy || policy.approved !== true || typeof policy.version !== 'string' || !policy.version.trim()
    || !Number.isSafeInteger(policy.expiresInSeconds) || Number(policy.expiresInSeconds) < 1 || Number(policy.expiresInSeconds) > 604800) {
    throw new Error('COMMERCIAL_ORDER_EXPIRY_POLICY_UNRESOLVED')
  }
  return { version: policy.version, expiresInSeconds: Number(policy.expiresInSeconds) }
}

export function commercialPlanIdentity(sku: CommercialCatalogSkuSnapshot): { planFamily: string; tierRank: number } {
  if (typeof sku.payload.planFamily !== 'string' || !sku.payload.planFamily.trim() || !Number.isSafeInteger(sku.payload.tierRank) || Number(sku.payload.tierRank) < 1) {
    throw new Error('COMMERCIAL_PLAN_IDENTITY_UNRESOLVED')
  }
  return { planFamily: sku.payload.planFamily, tierRank: Number(sku.payload.tierRank) }
}

export class CommercialPlanChangePolicyError extends Error {
  constructor(readonly code:'COMMERCIAL_DOWNGRADE_NOT_ALLOWED'|'COMMERCIAL_PLAN_FAMILY_MISMATCH'|'COMMERCIAL_POLICY_UNRESOLVED',message:string){super(message);this.name='CommercialPlanChangePolicyError'}
}
/** New intents only. Previously frozen orders/quotes must reach their strict
 * original replay path before this rule is consulted. Prices never rank tiers. */
export function assertCommercialNewPlanNotLower(target:CommercialCatalogSkuSnapshot,existing:readonly CommercialCatalogSkuSnapshot[]):void {
  let targetIdentity:ReturnType<typeof commercialPlanIdentity>,sourceIdentities:ReturnType<typeof commercialPlanIdentity>[]
  try {targetIdentity=commercialPlanIdentity(target);sourceIdentities=existing.map(commercialPlanIdentity)}
  catch {throw new CommercialPlanChangePolicyError('COMMERCIAL_POLICY_UNRESOLVED','approved frozen plan family and tier identity required')}
  if(sourceIdentities.some(source=>source.planFamily!==targetIdentity.planFamily))throw new CommercialPlanChangePolicyError('COMMERCIAL_PLAN_FAMILY_MISMATCH','a new plan cannot switch the existing paid contract family')
  if(sourceIdentities.some(source=>source.tierRank>targetIdentity.tierRank))throw new CommercialPlanChangePolicyError('COMMERCIAL_DOWNGRADE_NOT_ALLOWED','new plan tier must not be lower than the current or already-paid future contract')
}

export function commercialPaymentIsTimely(input: { paidAt: string; createdAt: string; expiresAt: string }): boolean {
  const paid = Date.parse(input.paidAt), created = Date.parse(input.createdAt), end = Date.parse(input.expiresAt)
  if (![paid, created, end].every(Number.isSafeInteger) || created >= end) throw new Error('COMMERCIAL_ORDER_TIME_INVALID')
  return paid >= created && paid < end
}
