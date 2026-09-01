import { describe, expect, it } from 'vitest'
import { buildCanonicalChainConsistencyReport, canonicalProductReadModeFromFlag, evaluateCanonicalWorkspaceCutoverGate, resolveCanonicalProductReadScope } from './canonical-product-consistency.js'

const base = {
  workspaceId: 'ws_1',
  legacyProducts: [
    { id: 'legacy_1', workspaceId: 'ws_1', brandId: 'brand_1', platform: 'taobao', accountId: 'account_1' },
    { id: 'legacy_2', workspaceId: 'ws_1', brandId: 'brand_1' },
  ],
  canonicalProducts: [{ id: 'canonical_1', workspaceId: 'ws_1', brandId: 'brand_1', legacyProductId: 'legacy_1' }],
  listings: [{ id: 'listing_1', workspaceId: 'ws_1', brandId: 'brand_1', canonicalProductId: 'canonical_1', platform: 'taobao', accountId: 'account_1' }],
  campaignItems: [{ id: 'item_1', workspaceId: 'ws_1', brandId: 'brand_1', canonicalProductId: 'canonical_1', listingId: 'listing_1', platform: 'taobao', accountId: 'account_1' }],
  tasks: [{ id: 'task_1', workspaceId: 'ws_1', productId: 'legacy_1', brandId: 'brand_1', canonicalProductId: 'canonical_1', listingId: 'listing_1', campaignItemId: 'item_1', platform: 'taobao', accountId: 'account_1' }],
} as const

describe('canonical product consistency report', () => {
  it('requires fresh, evidenced, fully verified workspace metrics before cutover', () => {
    const report = buildCanonicalChainConsistencyReport({
      ...base,
      evaluation: { generatedAt: '2026-09-01T00:00:00.000Z', revision: 'rev-1', freshness: 'fresh', availability: 'available' },
    })
    expect(evaluateCanonicalWorkspaceCutoverGate(report)).toMatchObject({ eligible: false, code: 'CANONICAL_WORKSPACE_NOT_VERIFIED', metrics: { counts: { verified: 1, legacy_only: 1 } } })

    const clean = buildCanonicalChainConsistencyReport({
      ...base,
      legacyProducts: [base.legacyProducts[0]!],
      evaluation: { generatedAt: '2026-09-01T00:00:00.000Z', revision: 'rev-2', freshness: 'fresh', availability: 'available' },
    })
    expect(evaluateCanonicalWorkspaceCutoverGate(clean)).toEqual({
      eligible: true,
      metrics: expect.objectContaining({ workspaceId: 'ws_1', revision: 'rev-2', findingCount: 1, orphanFindingCount: 0 }),
    })
  })

  it('blocks empty, stale, and evidence-free reports with stable codes', () => {
    const empty = buildCanonicalChainConsistencyReport({ workspaceId: 'ws_empty', legacyProducts: [], canonicalProducts: [], listings: [], campaignItems: [], tasks: [], evaluation: { generatedAt: '2026-09-01T00:00:00.000Z', revision: 'empty', freshness: 'fresh', availability: 'available' } })
    expect(evaluateCanonicalWorkspaceCutoverGate(empty)).toMatchObject({ eligible: false, code: 'CANONICAL_WORKSPACE_EMPTY' })
    const stale = buildCanonicalChainConsistencyReport({ ...base, evaluation: { generatedAt: '2026-09-01T00:00:00.000Z', revision: 'stale', freshness: 'stale', availability: 'available' } })
    expect(evaluateCanonicalWorkspaceCutoverGate(stale)).toMatchObject({ eligible: false, code: 'CANONICAL_REPORT_STALE' })
    const noEvidence = buildCanonicalChainConsistencyReport({ ...base, evaluation: { freshness: 'fresh', availability: 'available' } })
    expect(evaluateCanonicalWorkspaceCutoverGate(noEvidence)).toMatchObject({ eligible: false, code: 'CANONICAL_REPORT_EVIDENCE_REQUIRED' })
  })

  it('fails closed when a scoped canonical read has incomplete identity projection', () => {
    expect(resolveCanonicalProductReadScope({
      mode: 'canonical_read', workspaceId: 'ws_1', platform: 'taobao', accountId: 'store_1',
      candidates: [{ id: 'canonical_1', workspaceId: 'ws_1', brandId: 'brand_1', title: '标准标题', facts: { category: '女装' } }],
      listings: [{ id: 'listing_incomplete', workspaceId: 'ws_1', brandId: 'brand_1', canonicalProductId: 'canonical_1', platform: 'taobao' }],
    })).toEqual({ status: 'blocked', code: 'CANONICAL_PRODUCT_LISTING_SCOPE_INVALID', reason: 'CANONICAL_LISTING_SCOPE_MISMATCH' })
  })

  it('fails closed when the workspace read-mode flag is missing, disabled, or invalid', () => {
    expect(canonicalProductReadModeFromFlag({ enabled: false, value: 'canonical_read' })).toBe('legacy_shadow')
    expect(canonicalProductReadModeFromFlag({ enabled: true, value: 'unexpected' })).toBe('legacy_shadow')
    expect(canonicalProductReadModeFromFlag({ enabled: true, value: 'dual_verify' })).toBe('dual_verify')
  })
  it('reports a fully linked chain as verified without changing any input', () => {
    const report = buildCanonicalChainConsistencyReport(base)
    expect(report).toMatchObject({ status: 'attention_required', counts: { verified: 1, legacy_only: 1, conflict: 0, blocked: 0 }, orphanFindings: [] })
    expect(report.findings[0]).toMatchObject({ legacyProductId: 'legacy_2', status: 'legacy_only', codes: ['CANONICAL_MAPPING_MISSING'], nextAction: { method: 'brand-unit.product.create', confirmation: 'interactive_confirmation' } })
    expect(report.findings[1]).toMatchObject({ legacyProductId: 'legacy_1', status: 'verified', canonicalProductId: 'canonical_1', listingIds: ['listing_1'], campaignItemIds: ['item_1'], taskIds: ['task_1'] })
    expect(base.legacyProducts[0]?.id).toBe('legacy_1')
  })

  it('does not guess when mappings are ambiguous or scopes conflict', () => {
    const report = buildCanonicalChainConsistencyReport({
      ...base,
      canonicalProducts: [
        ...base.canonicalProducts,
        { id: 'canonical_2', workspaceId: 'ws_1', brandId: 'brand_1', legacyProductId: 'legacy_1' },
      ],
      tasks: [{ ...base.tasks[0], canonicalProductId: 'canonical_2', platform: 'jd' }],
    })
    expect(report.findings.find(item => item.legacyProductId === 'legacy_1')).toMatchObject({ status: 'conflict', codes: ['CANONICAL_MAPPING_AMBIGUOUS', 'TASK_CAMPAIGN_ITEM_SCOPE_MISMATCH', 'TASK_CANONICAL_SCOPE_MISMATCH', 'TASK_LISTING_SCOPE_MISMATCH', 'TASK_PLATFORM_MISMATCH'] })
  })

  it('blocks a mapped task without canonical and listing scope', () => {
    const report = buildCanonicalChainConsistencyReport({
      ...base,
      tasks: [{ id: 'task_unbound', workspaceId: 'ws_1', productId: 'legacy_1' }],
    })

    expect(report.findings.find(item => item.legacyProductId === 'legacy_1')).toMatchObject({
      status: 'blocked',
      codes: ['TASK_CANONICAL_SCOPE_MISSING', 'TASK_LISTING_SCOPE_MISSING'],
    })
  })

  it('conflicts when a canonical target has duplicate listings for the same brand and store', () => {
    const report = buildCanonicalChainConsistencyReport({
      ...base,
      listings: [
        ...base.listings,
        { id: 'listing_duplicate', workspaceId: 'ws_1', brandId: 'brand_1', canonicalProductId: 'canonical_1', platform: 'taobao', accountId: 'account_1' },
      ],
    })

    expect(report.findings.find(item => item.legacyProductId === 'legacy_1')).toMatchObject({
      status: 'conflict',
      codes: ['LISTING_TARGET_AMBIGUOUS'],
    })
    expect(report.orphanFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'listing', entityId: 'listing_1', status: 'conflict', codes: ['LISTING_TARGET_DUPLICATE'] }),
      expect.objectContaining({ entityType: 'listing', entityId: 'listing_duplicate', status: 'conflict', codes: ['LISTING_TARGET_DUPLICATE'] }),
    ]))
  })

  it('is workspace-scoped and marks a canonical product with a missing required listing as blocked', () => {
    const report = buildCanonicalChainConsistencyReport({
      ...base,
      canonicalProducts: [...base.canonicalProducts, { id: 'canonical_other', workspaceId: 'ws_2', brandId: 'brand_2', legacyProductId: 'legacy_1' }],
      listings: [],
      campaignItems: [],
      tasks: [],
    })
    expect(report.findings.find(item => item.legacyProductId === 'legacy_1')).toMatchObject({ status: 'blocked', codes: ['LISTING_MAPPING_MISSING'], nextAction: { method: 'brand-unit.listing.create', confirmation: 'interactive_confirmation' } })
    expect(report.findings.every(item => item.legacyProductId !== 'legacy_other')).toBe(true)
  })

  it('accepts legacy campaign rows without backfilled canonical or listing links without guessing', () => {
    const report = buildCanonicalChainConsistencyReport({
      ...base,
      campaignItems: [{ id: 'legacy-item', workspaceId: 'ws_1', brandId: 'brand_1', platform: 'taobao', accountId: 'account_1' }],
      tasks: [],
    })
    expect(report.findings.find(item => item.legacyProductId === 'legacy_1')).toMatchObject({ status: 'verified', campaignItemIds: [] })
  })

  it('reports orphan standard descendants instead of silently treating the report as clean', () => {
    const report = buildCanonicalChainConsistencyReport({
      ...base,
      listings: [{ id: 'listing_orphan', workspaceId: 'ws_1', brandId: 'brand_1', canonicalProductId: 'canonical_missing', platform: 'taobao', accountId: 'account_1' }],
      campaignItems: [{ id: 'item_orphan', workspaceId: 'ws_1', brandId: 'brand_1', canonicalProductId: 'canonical_missing', listingId: 'listing_missing' }],
      tasks: [{ id: 'task_orphan', workspaceId: 'ws_1', productId: 'product_missing', campaignItemId: 'item_missing' }],
    })
    expect(report.status).toBe('attention_required')
    expect(report.orphanFindings).toMatchObject([
      { entityType: 'campaign_item', entityId: 'item_orphan', status: 'blocked', codes: ['CAMPAIGN_CANONICAL_ORPHAN', 'CAMPAIGN_LISTING_ORPHAN'] },
      { entityType: 'listing', entityId: 'listing_orphan', status: 'blocked', codes: ['LISTING_CANONICAL_ORPHAN'] },
      { entityType: 'task', entityId: 'task_orphan', status: 'blocked', codes: ['TASK_CAMPAIGN_ITEM_ORPHAN', 'TASK_PRODUCT_ORPHAN'] },
    ])
    expect(report.orphanFindings.every(finding => finding.blocking && finding.nextAction)).toBe(true)
  })

  it('blocks publish jobs whose task has not been bound to the canonical scope', () => {
    const report = buildCanonicalChainConsistencyReport({
      ...base,
      tasks: [{ id: 'task_unbound', workspaceId: 'ws_1', productId: 'legacy_1' }],
      publishJobs: [{ id: 'publish_unbound', workspaceId: 'ws_1', taskId: 'task_unbound' }],
    })

    expect(report.orphanFindings).toContainEqual(expect.objectContaining({
      entityType: 'publish_job',
      entityId: 'publish_unbound',
      status: 'conflict',
      codes: ['PUBLISH_CANONICAL_SCOPE_MISSING', 'PUBLISH_LISTING_SCOPE_MISSING'],
    }))
    expect(report.status).toBe('attention_required')
  })

  it('does not report a canonical-only root as clean during legacy cutover', () => {
    const report = buildCanonicalChainConsistencyReport({
      workspaceId: 'ws_1', legacyProducts: [],
      canonicalProducts: [{ id: 'canonical_native', workspaceId: 'ws_1', brandId: 'brand_1' }],
      listings: [], campaignItems: [], tasks: [],
    })
    expect(report).toMatchObject({ status: 'attention_required', counts: { verified: 0, legacy_only: 0, conflict: 0, blocked: 1 } })
    expect(report.orphanFindings).toContainEqual(expect.objectContaining({ entityType: 'canonical_product', entityId: 'canonical_native', status: 'blocked', codes: ['CANONICAL_LEGACY_MAPPING_MISSING'] }))
  })

  it('blocks a canonical root whose explicit legacy product is missing', () => {
    const report = buildCanonicalChainConsistencyReport({
      workspaceId: 'ws_1',
      legacyProducts: [],
      canonicalProducts: [{ id: 'canonical_dangling', workspaceId: 'ws_1', brandId: 'brand_1', legacyProductId: 'legacy_missing' }],
      listings: [], campaignItems: [], tasks: [],
    })
    expect(report).toMatchObject({ status: 'attention_required', counts: { verified: 0, legacy_only: 0, conflict: 0, blocked: 1 } })
    expect(report.orphanFindings).toContainEqual(expect.objectContaining({ entityType: 'canonical_product', entityId: 'canonical_dangling', status: 'blocked', codes: ['CANONICAL_LEGACY_PRODUCT_ORPHAN'] }))
  })

  it('blocks delivery when a product asset is missing, cross-brand, or not clean', () => {
    const report = buildCanonicalChainConsistencyReport({
      ...base,
      legacyProducts: [{ ...base.legacyProducts[0], sourceAssetIds: ['asset_missing', 'asset_pending'] }],
      assetBindings: [
        { workspaceId: 'ws_1', productId: 'legacy_1', assetId: 'asset_missing', assetRole: 'source', status: 'active', assetExists: false },
        { workspaceId: 'ws_1', productId: 'legacy_1', assetId: 'asset_pending', assetRole: 'source', status: 'active', assetExists: true, assetBrandId: 'brand_other', scanStatus: 'quarantined', rightsStatus: 'pending' },
      ],
    })
    expect(report.findings.find(item => item.legacyProductId === 'legacy_1')).toMatchObject({
      status: 'conflict',
      codes: ['ASSET_BRAND_SCOPE_MISMATCH', 'ASSET_NOT_FOUND', 'ASSET_RIGHTS_NOT_APPROVED', 'ASSET_SCAN_NOT_CLEAN'],
    })
  })
})
