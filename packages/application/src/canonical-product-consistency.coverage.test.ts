import { describe, expect, it } from 'vitest'
import { buildCanonicalChainConsistencyReport } from './canonical-product-consistency.js'

const emptyInput = (workspaceId = 'ws_empty') => ({
  workspaceId,
  legacyProducts: [],
  canonicalProducts: [],
  listings: [],
  campaignItems: [],
  tasks: [],
  publishJobs: [],
})

describe('canonical product consistency coverage matrix', () => {
  it('returns a truthful clean empty state with zero findings', () => {
    expect(buildCanonicalChainConsistencyReport(emptyInput())).toMatchObject({
      workspaceId: 'ws_empty',
      status: 'clean',
      contractVersion: 1,
      contractStatus: 'clean',
      availability: 'available',
      readMode: 'snapshot',
      freshness: 'unknown',
      generatedAt: null,
      revision: null,
      blocking: null,
      counts: { verified: 0, legacy_only: 0, conflict: 0, blocked: 0 },
      findings: [],
      orphanFindings: [],
    })
  })

  it.each([
    ['legacy_only', 'legacy_missing', ['CANONICAL_MAPPING_MISSING']],
    ['verified', 'legacy_verified', []],
    ['conflict', 'legacy_conflict', ['CANONICAL_MAPPING_AMBIGUOUS']],
    ['blocked', 'legacy_blocked', ['LISTING_MAPPING_MISSING']],
  ] as const)('exposes the %s state and its remediation code', (status, legacyProductId, codes) => {
    const report = buildCanonicalChainConsistencyReport({
      workspaceId: 'ws_matrix',
      legacyProducts: [
        { id: 'legacy_missing', workspaceId: 'ws_matrix' },
        { id: 'legacy_verified', workspaceId: 'ws_matrix', brandId: 'brand-1', platform: 'taobao', accountId: 'store-1' },
        { id: 'legacy_conflict', workspaceId: 'ws_matrix', brandId: 'brand-1' },
        { id: 'legacy_blocked', workspaceId: 'ws_matrix', brandId: 'brand-1', platform: 'jd', accountId: 'store-2' },
      ],
      canonicalProducts: [
        { id: 'canonical_verified', workspaceId: 'ws_matrix', brandId: 'brand-1', legacyProductId: 'legacy_verified' },
        { id: 'canonical_conflict_a', workspaceId: 'ws_matrix', brandId: 'brand-1', legacyProductId: 'legacy_conflict' },
        { id: 'canonical_conflict_b', workspaceId: 'ws_matrix', brandId: 'brand-1', legacyProductId: 'legacy_conflict' },
        { id: 'canonical_blocked', workspaceId: 'ws_matrix', brandId: 'brand-1', legacyProductId: 'legacy_blocked' },
      ],
      listings: [
        { id: 'listing_verified', workspaceId: 'ws_matrix', brandId: 'brand-1', canonicalProductId: 'canonical_verified', platform: 'taobao', accountId: 'store-1' },
      ],
      campaignItems: [],
      tasks: [],
    })

    const finding = report.findings.find(item => item.legacyProductId === legacyProductId)
    expect(finding).toMatchObject({ status, codes })
    expect(report.counts).toEqual({ verified: 1, legacy_only: 1, conflict: 1, blocked: 1 })
  })

  it('blocks a canonical binding when the legacy product has no brand', () => {
    const report = buildCanonicalChainConsistencyReport({
      workspaceId: 'ws_missing_brand',
      legacyProducts: [{ id: 'legacy-1', workspaceId: 'ws_missing_brand' }],
      canonicalProducts: [{ id: 'canonical-1', workspaceId: 'ws_missing_brand', brandId: 'brand-1', legacyProductId: 'legacy-1' }],
      listings: [], campaignItems: [], tasks: [],
    })
    expect(report.findings[0]).toMatchObject({ status: 'blocked', codes: ['MISSING_BRAND'] })
  })

  it('does not allow foreign workspace rows with colliding IDs to change local status', () => {
    const report = buildCanonicalChainConsistencyReport({
      workspaceId: 'ws_local',
      legacyProducts: [
        { id: 'product-1', workspaceId: 'ws_local', brandId: 'brand-local', platform: 'taobao', accountId: 'store-local' },
        { id: 'product-foreign', workspaceId: 'ws_foreign', brandId: 'brand-foreign' },
      ],
      canonicalProducts: [
        { id: 'canonical-1', workspaceId: 'ws_foreign', brandId: 'brand-foreign', legacyProductId: 'product-1' },
      ],
      listings: [
        { id: 'listing-1', workspaceId: 'ws_foreign', brandId: 'brand-foreign', canonicalProductId: 'canonical-1', platform: 'taobao', accountId: 'store-local' },
      ],
      campaignItems: [],
      tasks: [],
    })

    expect(report.workspaceId).toBe('ws_local')
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]).toMatchObject({ legacyProductId: 'product-1', status: 'legacy_only', codes: ['CANONICAL_MAPPING_MISSING'] })
    expect(report.orphanFindings).toEqual([])
  })

  it('emits the stable finding contract without guessing a remediation permission', () => {
    const report = buildCanonicalChainConsistencyReport({ ...emptyInput('ws_contract'), legacyProducts: [{ id: 'product-1', workspaceId: 'ws_contract' }] })
    expect(report.findings[0]).toMatchObject({
      productId: 'product-1',
      contractStatus: 'legacy_only',
      scope: { brandId: null, platform: null, accountId: null, listingId: null },
      relation: { listingIds: [], campaignItemIds: [], taskIds: [], publishJobIds: [] },
      blocking: { code: 'CANONICAL_MAPPING_MISSING', objectType: 'canonical_product', objectId: 'product-1' },
      nextAction: { method: 'brand-unit.product.create', confirmation: 'interactive_confirmation', permission: { allowed: false, requiredRole: 'platform_ops' } },
      evidence: { codes: ['CANONICAL_MAPPING_MISSING'], generatedAt: null, revision: null },
    })
  })

  it('propagates caller-owned revision and freshness evidence deterministically', () => {
    const report = buildCanonicalChainConsistencyReport({
      ...emptyInput('ws_evidence'),
      evaluation: { generatedAt: '2026-08-31T00:00:00.000Z', revision: 7, readMode: 'live', freshness: 'fresh' },
    })
    expect(report).toMatchObject({ contractVersion: 1, contractStatus: 'clean', generatedAt: '2026-08-31T00:00:00.000Z', revision: 7, readMode: 'live', freshness: 'fresh' })
  })

  it('fails closed for an unavailable read and never returns clean', () => {
    const report = buildCanonicalChainConsistencyReport({
      ...emptyInput('ws_unavailable'),
      evaluation: { availability: 'unavailable', unavailableCode: 'REPOSITORY_TIMEOUT', unavailableMessage: 'repository timed out' },
    })
    expect(report).toMatchObject({ status: 'attention_required', contractStatus: 'unavailable', availability: 'unavailable', blocking: { code: 'REPOSITORY_TIMEOUT', objectType: 'workspace' } })
  })

  it('fails closed when workspace scope is empty', () => {
    const report = buildCanonicalChainConsistencyReport({ ...emptyInput(''), workspaceId: '   ' })
    expect(report).toMatchObject({ status: 'attention_required', contractStatus: 'unavailable', availability: 'unavailable', blocking: { code: 'WORKSPACE_ID_REQUIRED' } })
  })

  it('does not expose a green compatibility status for an unknown read', () => {
    const report = buildCanonicalChainConsistencyReport({ ...emptyInput('ws_unknown'), evaluation: { availability: 'unknown' } })
    expect(report).toMatchObject({ status: 'attention_required', contractStatus: 'unknown', availability: 'unknown' })
  })

  it('does not expose a green compatibility status for an expired snapshot', () => {
    const report = buildCanonicalChainConsistencyReport({ ...emptyInput('ws_expired'), evaluation: { freshness: 'expired' } })
    expect(report).toMatchObject({ status: 'attention_required', contractStatus: 'unavailable', freshness: 'expired' })
  })
})
