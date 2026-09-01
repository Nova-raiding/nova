import { describe, expect, it } from 'vitest'
import { buildCanonicalChainConsistencyReport } from './canonical-product-consistency.js'

describe('canonical product publish target consistency', () => {
  it('requires a listing for the legacy product platform and account tuple', () => {
    const report = buildCanonicalChainConsistencyReport({
      workspaceId: 'ws_target',
      legacyProducts: [{ id: 'legacy-1', workspaceId: 'ws_target', brandId: 'brand-1', platform: 'taobao', accountId: 'store-1' }],
      canonicalProducts: [{ id: 'canonical-1', workspaceId: 'ws_target', brandId: 'brand-1', legacyProductId: 'legacy-1' }],
      listings: [{ id: 'listing-jd', workspaceId: 'ws_target', brandId: 'brand-1', canonicalProductId: 'canonical-1', platform: 'jd', accountId: 'store-1' }],
      campaignItems: [],
      tasks: [],
    })

    expect(report.findings).toMatchObject([{ status: 'conflict', codes: ['LISTING_MAPPING_MISSING', 'LISTING_PLATFORM_MISMATCH'] }])
  })
})
