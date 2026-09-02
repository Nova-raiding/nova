import { describe, expect, it, vi } from 'vitest'
import {
  ContinuousFeatureEntitlementService,
  type ContinuousFeatureEntitlementSnapshotV2,
  type LegacyCommercialShadowSource,
} from './continuous-feature-entitlement.js'

const now = new Date('2026-09-15T00:00:00.000Z')
const snapshot = (override: Partial<ContinuousFeatureEntitlementSnapshotV2> = {}): ContinuousFeatureEntitlementSnapshotV2 => ({
  id: 'entitlement-v2-1',
  workspaceId: 'workspace-1',
  subscriptionPeriodId: 'period-1',
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-10-01T00:00:00.000Z',
  periodStatus: 'active',
  catalogVersionId: 'catalog-version-1',
  skuCode: 'monthly_basic',
  resolvedBenefits: [
    { code: 'max_brands', quantity: 1 },
    { code: 'max_stores', quantity: 5 },
    { code: 'monthly_creative_points', quantity: 5_000 },
  ],
  unresolvedBlockers: [],
  executable: true,
  checksum: 'a'.repeat(64),
  createdAt: '2026-09-01T00:00:00.000Z',
  ...override,
})

function harness(items: readonly ContinuousFeatureEntitlementSnapshotV2[] = [snapshot()]) {
  const listV2EntitlementSnapshots = vi.fn(async () => items)
  const service = new ContinuousFeatureEntitlementService({ projection: { listV2EntitlementSnapshots }, now: () => now })
  return { service, listV2EntitlementSnapshots }
}

describe('ContinuousFeatureEntitlementService C14', () => {
  it('allows only one current executable V2 snapshot and returns immutable evidence', async () => {
    const h = harness()
    await expect(h.service.decide({ workspace_id: 'workspace-1' })).resolves.toEqual({
      allowed: true,
      code: 'OK',
      snapshot_id: 'entitlement-v2-1',
      subscription_period_id: 'period-1',
      catalog_version_id: 'catalog-version-1',
      checksum: 'a'.repeat(64),
      ignored_legacy_sources: [],
    })
    expect(h.listV2EntitlementSnapshots).toHaveBeenCalledWith({ workspace_id: 'workspace-1' })
  })

  it.each([
    ['missing', []],
    ['inactive period', [snapshot({ periodStatus: 'expired' })]],
    ['future period', [snapshot({ periodStart: '2026-09-16T00:00:00.000Z' })]],
    ['expired period', [snapshot({ periodEnd: '2026-09-15T00:00:00.000Z' })]],
    ['blocked snapshot', [snapshot({ executable: false })]],
    ['unresolved snapshot', [snapshot({ unresolvedBlockers: ['STORAGE_UNIT_UNRESOLVED'] })]],
    ['wrong tenant', [snapshot({ workspaceId: 'workspace-2' })]],
    ['malformed checksum', [snapshot({ checksum: 'fixture' })]],
    ['point-pack-only benefits', [snapshot({ resolvedBenefits: [{ code: 'creative_points', quantity: 2_000 }] })]],
  ])('fails closed for %s V2 evidence', async (_name, items) => {
    await expect(harness(items).service.decide({ workspace_id: 'workspace-1' })).resolves.toMatchObject({
      allowed: false,
      code: 'COMMERCIAL_ENTITLEMENT_REQUIRED',
      snapshot_id: null,
    })
  })

  it('maps projection failure or malformed projection to unavailable', async () => {
    const failed = harness()
    failed.listV2EntitlementSnapshots.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(failed.service.decide({ workspace_id: 'workspace-1' })).resolves.toMatchObject({
      allowed: false, code: 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE',
    })

    const malformed = new ContinuousFeatureEntitlementService({
      projection: { listV2EntitlementSnapshots: async () => null as never },
      now: () => now,
    })
    await expect(malformed.decide({ workspace_id: 'workspace-1' })).resolves.toMatchObject({
      allowed: false, code: 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE',
    })
  })

  it('rejects overlapping authoritative snapshots as ambiguous', async () => {
    await expect(harness([snapshot(), snapshot({ id: 'entitlement-v2-2', subscriptionPeriodId: 'period-2', checksum: 'b'.repeat(64) })]).service.decide({
      workspace_id: 'workspace-1',
    })).resolves.toMatchObject({ allowed: false, code: 'COMMERCIAL_ENTITLEMENT_AMBIGUOUS' })
  })

  it('keeps every legacy source shadow-only and incapable of contributing allow', async () => {
    const legacy: LegacyCommercialShadowSource[] = ['rmb_wallet', 'task_quota', 'addon', 'image_entitlement']
    await expect(harness([]).service.decide({ workspace_id: 'workspace-1', observed_legacy_sources: legacy })).resolves.toEqual({
      allowed: false,
      code: 'COMMERCIAL_ENTITLEMENT_REQUIRED',
      snapshot_id: null,
      subscription_period_id: null,
      catalog_version_id: null,
      checksum: null,
      ignored_legacy_sources: ['task_quota', 'addon', 'rmb_wallet', 'image_entitlement'],
    })
  })

  it('validates workspace identity before reading the V2 projection', async () => {
    const h = harness()
    await expect(h.service.decide({ workspace_id: ' workspace-1' })).rejects.toThrow('workspace_id')
    expect(h.listV2EntitlementSnapshots).not.toHaveBeenCalled()
  })
})
