import { describe, expect, it } from 'vitest'
import { projectFrozenOnboardingGiftPolicy } from './commercial-gift-policy-view.js'
const policy = (points: number) => ({ grantCount: 6, pointsPerGrant: points, cadence: 'monthly', startsAt: 'payment_verified', grantExpiresAtRule: 'next_monthly_anniversary', schedulingStatus: 'resolved' })
describe('frozen onboarding order policy', () => {
  it('preserves each order policy across catalog repricing', () => {
    const frozen = policy(500), current = policy(600)
    expect(projectFrozenOnboardingGiftPolicy(frozen)).toMatchObject({ grant_count: 6, points_per_grant: 500 })
    expect(projectFrozenOnboardingGiftPolicy(current)).toMatchObject({ points_per_grant: 600 })
    expect(frozen.pointsPerGrant).toBe(500)
  })
  it.each([null, {}, policy(-1), { ...policy(500), grantCount: 25 }, { ...policy(500), schedulingStatus: 'unresolved' }, { ...policy(500), cadence: '' }])('does not invent malformed policy %j', value => {
    expect(projectFrozenOnboardingGiftPolicy(value)).toBeNull()
  })
})
