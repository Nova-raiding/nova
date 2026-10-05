import type { FrozenOnboardingGiftPolicyView } from '../../../packages/contracts/src/commercial-point-origins.js'
/** Called with frozen order SKU payload.grantSchedule, never current catalog data. */
export function projectFrozenOnboardingGiftPolicy(value: unknown): FrozenOnboardingGiftPolicyView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const policy = value as Record<string, unknown>
  if (typeof policy.grantCount !== 'number' || !Number.isSafeInteger(policy.grantCount) || policy.grantCount <= 0 || policy.grantCount > 24
    || typeof policy.pointsPerGrant !== 'number' || !Number.isSafeInteger(policy.pointsPerGrant) || policy.pointsPerGrant <= 0
    || policy.cadence !== 'monthly' || policy.startsAt !== 'payment_verified' || policy.grantExpiresAtRule !== 'next_monthly_anniversary' || policy.schedulingStatus !== 'resolved') return null
  return { grant_count: policy.grantCount, points_per_grant: policy.pointsPerGrant, cadence: policy.cadence,
    starts_at: policy.startsAt, grant_expires_at_rule: policy.grantExpiresAtRule }
}
