import { describe, expect, it } from 'vitest'
import { buildCanonicalChainConsistencyReport, canonicalProductReadModeFromFlag } from './canonical-product-consistency.js'

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
