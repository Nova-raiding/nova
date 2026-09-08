import { describe, expect, it } from 'vitest'
import type { ContinuousFeatureEntitlementSnapshotV2 } from '../../../packages/application/src/continuous-feature-entitlement.js'
import { resolveCommercialCountBenefit } from './commercial-count-capacity.js'

const now = new Date('2026-09-15T00:00:00.000Z')
const snapshot = (override: Partial<ContinuousFeatureEntitlementSnapshotV2> = {}): ContinuousFeatureEntitlementSnapshotV2 => ({
  id: 'entitlement-v2-1',
  workspaceId: 'workspace-1',
  subscriptionPeriodId: 'period-1',
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-10-01T00:00:00.000Z',
  periodStatus: 'active',
  catalogVersionId: 'catalog-version-1',
  skuCode: 'monthly-basic',
  resolvedBenefits: [{ code: 'max_brands', quantity: 1 }, { code: 'max_stores', quantity: 5 }],
  unresolvedBlockers: [],
  executable: true,
  checksum: 'a'.repeat(64),
  createdAt: '2026-09-01T00:00:00.000Z',
  ...override,
})

describe('commercial count capacity', () => {
  it('returns a non-negative integer from the sole authoritative V2 snapshot', async () => {
    await expect(resolveCommercialCountBenefit({ workspaceId: 'workspace-1', code: 'max_stores', snapshots: [snapshot()], now })).resolves.toBe(5)
  })

  it.each([
    ['missing entitlement', []],
    ['expired entitlement', [snapshot({ periodEnd: now.toISOString() })]],
    ['unverified checksum', [snapshot({ checksum: 'fixture' })]],
    ['overlapping entitlement', [snapshot(), snapshot({ id: 'entitlement-v2-2', subscriptionPeriodId: 'period-2', checksum: 'b'.repeat(64) })]],
  ])('fails closed for %s', async (_name, snapshots) => {
    await expect(resolveCommercialCountBenefit({ workspaceId: 'workspace-1', code: 'max_stores', snapshots, now })).rejects.toMatchObject({
      code: snapshots.length > 1 ? 'COMMERCIAL_ENTITLEMENT_AMBIGUOUS' : 'COMMERCIAL_ENTITLEMENT_REQUIRED',
    })
  })

  it.each([
    [[], 'missing benefit', 'COMMERCIAL_ENTITLEMENT_REQUIRED'],
    [[{ code: 'max_brands', quantity: 1 }, { code: 'max_stores', quantity: -1 }], 'negative quantity', 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE'],
    [[{ code: 'max_brands', quantity: 1 }, { code: 'max_stores', quantity: 1.5 }], 'fractional quantity', 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE'],
    [[{ code: 'max_brands', quantity: 1 }, { code: 'max_stores', quantity: 5 }, { code: 'max_stores', quantity: 6 }], 'duplicate benefit', 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE'],
  ])('rejects %s (%s)', async (resolvedBenefits, _name, code) => {
    await expect(resolveCommercialCountBenefit({ workspaceId: 'workspace-1', code: 'max_stores', snapshots: [snapshot({ resolvedBenefits })], now })).rejects.toMatchObject({
      code,
    })
  })
})
