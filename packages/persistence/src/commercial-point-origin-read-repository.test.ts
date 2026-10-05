import { describe, expect, it } from 'vitest'
import { commercialCatalogContentHash } from './commercial-catalog-repository.js'
import { projectFrozenGiftPlan, PostgresCommercialPointOriginReadRepository } from './commercial-point-origin-read-repository.js'
import type { SqlPool } from './repository.js'
function row(points = 500) {
  const sku = { kind: 'onboarding', code: 'opening', versionId: 'frozen-version', lifecycle: 'approved', executable: true, priceFen: 500000, priceMode: 'fixed', durationDays: null, payload: { policyRef: { policyId: 'approved', version: 'v2' }, grantSchedule: { grantCount: 1, pointsPerGrant: points, cadence: 'monthly', startsAt: 'payment_verified', grantExpiresAtRule: 'next_monthly_anniversary', schedulingStatus: 'resolved' } }, benefits: [], checksum: '' }
  sku.checksum = commercialCatalogContentHash({ priceFen: sku.priceFen, priceMode: sku.priceMode, durationDays: sku.durationDays, payload: sku.payload, benefits: sku.benefits })
  return { source_order_id: 'order', source_order_status: 'paid', order_snapshot_id: 'snapshot', sku, batches: [{ schedule_id: 'batch', sequence: 1, points, source_checksum: sku.checksum, due_at: '2027-01-31T00:00:00Z', expires_at: '2027-02-28T00:00:00Z', schedule_status: 'granted', grant_id: 'gift', granted_at: '2027-01-31T00:00:00Z', blockers: [] }] }
}
describe('frozen gift projection', () => {
  it('uses frozen top-level policy and distinguishes time expiry from execution facts', () => {
    expect(projectFrozenGiftPlan(row(), '2027-03-01T00:00:00Z')).toMatchObject({ points_per_grant: 500, policy_ref: { policyId: 'approved', version: 'v2' }, batches: [{ expired_by_time: true, expiration_id: null, expired_at: null, dispatch_id: null }] })
    expect(projectFrozenGiftPlan(row(600), '2027-01-31T00:00:00Z').points_per_grant).toBe(600)
  })
  it('rejects altered snapshots and missing paid schedule facts', () => {
    const altered = row(); altered.sku.priceFen++
    expect(() => projectFrozenGiftPlan(altered, '2027-01-31')).toThrow('GIFT_POLICY_UNVERIFIED')
    expect(() => projectFrozenGiftPlan({ ...row(), batches: [] }, '2027-01-31')).toThrow('GIFT_SCHEDULE_INCOMPLETE')
    const checksum = row(); checksum.batches[0]!.source_checksum = 'a'.repeat(64)
    expect(() => projectFrozenGiftPlan(checksum, '2027-01-31')).toThrow('GIFT_SCHEDULE_INCONSISTENT')
  })
  it('keeps missing SQL schema unknown instead of empty plan', async () => {
    const unavailable: SqlPool = { connect: async () => { throw new Error('missing schema') } }
    const reader = new PostgresCommercialPointOriginReadRepository(unavailable)
    expect(await reader.readOnboardingGifts('ws')).toMatchObject({ status: 'unknown', plans: null })
    expect(await reader.readStatementOrigins('ws', ['ledger'])).toMatchObject({ ledger: { status: 'unknown', source_order_id: null } })
  })
})
