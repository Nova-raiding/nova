import { describe, expect, it, vi } from 'vitest'
import {
  CREATIVE_POINT_PACKS,
  DRAFT_CREATIVE_POINT_RATES,
  LOCAL_PLAN_ENTITLEMENTS,
  ONBOARDING_OFFER,
  PRIVATE_VALIDATION_OFFER,
  validateResolvedPlanEntitlements,
} from '../packages/application/src/commercial-plan-catalog.js'
import { CommercialAccessService } from '../packages/application/src/commercial-access-service.js'
import { ContinuousFeatureEntitlementService, type ContinuousFeatureEntitlementSnapshotV2 } from '../packages/application/src/continuous-feature-entitlement.js'
import { ERROR_CODES } from '@merchant-marketing/contracts'

describe('commercial plan coverage gates', () => {
  it('keeps unresolved commercial rules blocked while allowing only resolved approved entries', () => {
    const catalog = [
      ...LOCAL_PLAN_ENTITLEMENTS,
      ONBOARDING_OFFER,
      PRIVATE_VALIDATION_OFFER,
      ...CREATIVE_POINT_PACKS,
      ...DRAFT_CREATIVE_POINT_RATES,
    ]

    expect(catalog.length).toBeGreaterThan(0)
    for (const item of catalog) {
      const blockers = 'blockers' in item ? item.blockers : []
      if (blockers.length > 0) {
        expect(item.executable, JSON.stringify(item)).toBe(false)
        expect(item.lifecycle, JSON.stringify(item)).toBe('draft')
      } else {
        expect(item.executable, JSON.stringify(item)).toBe(true)
        expect(item.lifecycle, JSON.stringify(item)).toBe('active')
      }
    }
    for (const item of catalog.filter(item => 'blockers' in item && item.blockers.length > 0)) {
      expect(item.blockers?.length ?? 0, JSON.stringify(item)).toBeGreaterThan(0)
    }
  })

  it('accepts an approved, resolved snapshot and preserves its explicit storage unit', () => {
    expect(validateResolvedPlanEntitlements(LOCAL_PLAN_ENTITLEMENTS[0]!)).toMatchObject({ executable: true, lifecycle: 'active', storage: { unit: 'GB_DECIMAL' } })

    const resolved = {
      ...LOCAL_PLAN_ENTITLEMENTS[0]!,
      storage: { sourceLabel: '50g' as const, normalizedBytes: 50_000_000_000 as const, normalizationStatus: 'resolved' as const, unit: 'GB_DECIMAL' as const },
      lifecycle: 'active' as const,
      executable: true,
      blockers: [],
    }
    expect(validateResolvedPlanEntitlements(resolved)).toMatchObject({ executable: true, lifecycle: 'active', blockers: [] })
  })

  it('does not admit an unapproved point rate into the charged execution path', async () => {
    const listV2EntitlementSnapshots = vi.fn(async () => [{
      id: 'entitlement-v2-1', workspaceId: 'workspace-1', subscriptionPeriodId: 'period-1',
      periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', periodStatus: 'active',
      catalogVersionId: 'catalog-v1', skuCode: 'monthly_basic',
      resolvedBenefits: [{ code: 'max_brands', quantity: 1 }, { code: 'max_stores', quantity: 5 }],
      unresolvedBlockers: [], executable: true, checksum: 'a'.repeat(64), createdAt: '2026-09-01T00:00:00.000Z',
    } satisfies ContinuousFeatureEntitlementSnapshotV2])
    const resolveApprovedRate = vi.fn(async () => ({ state: 'unavailable' as const }))
    const service = new CommercialAccessService({
      registry: [{ surface: 'MCP', operation: 'catalog.image.generate', domain: 'COMMERCIAL', enabled: true, classification: 'POINT_CHARGED', rate_action: 'image.generate.standard' }],
      registry_version: 'coverage-test-v1',
      balance_projection: { projectCreativePointBalance: async () => ({ state: 'known' as const, available_points: 10, access_revision: 'rev-1', freshness: 'fresh' as const }) },
      rate_resolver: { resolveApprovedRate },
      entitlement_projection: { listV2EntitlementSnapshots },
      now: () => new Date('2026-09-15T00:00:00.000Z'),
      id_factory: () => 'decision-1',
    })

    const result = await service.decide({ surface: 'MCP', operation: 'catalog.image.generate', workspace_id: 'workspace-1' })
    expect(result).toMatchObject({ outcome: 'DECISION', decision: { allowed: false, error_code: ERROR_CODES.RATE_CARD_UNAVAILABLE, quoted_points: null, rate_card_version: null } })
    expect(resolveApprovedRate).toHaveBeenCalledOnce()
    expect(listV2EntitlementSnapshots).not.toHaveBeenCalled()
  })

  it.each([
    ['period expired', { periodEnd: '2026-09-15T00:00:00.000Z' }],
    ['period not executable', { executable: false }],
    ['unresolved blocker', { unresolvedBlockers: ['STORAGE_UNIT_UNRESOLVED'] }],
  ])('fails closed when continuous entitlement is %s', async (_label, override) => {
    const base: ContinuousFeatureEntitlementSnapshotV2 = {
      id: 'entitlement-v2-1', workspaceId: 'workspace-1', subscriptionPeriodId: 'period-1',
      periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', periodStatus: 'active',
      catalogVersionId: 'catalog-v1', skuCode: 'monthly_basic',
      resolvedBenefits: [{ code: 'max_brands', quantity: 1 }, { code: 'max_stores', quantity: 5 }],
      unresolvedBlockers: [], executable: true, checksum: 'b'.repeat(64), createdAt: '2026-09-01T00:00:00.000Z',
    }
    const service = new ContinuousFeatureEntitlementService({
      projection: { listV2EntitlementSnapshots: async () => [{ ...base, ...override }] },
      now: () => new Date('2026-09-15T00:00:00.000Z'),
    })

    await expect(service.decide({ workspace_id: 'workspace-1' })).resolves.toMatchObject({
      allowed: false,
      code: 'COMMERCIAL_ENTITLEMENT_REQUIRED',
      snapshot_id: null,
    })
  })
})
