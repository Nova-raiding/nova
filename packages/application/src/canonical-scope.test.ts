import { describe, expect, it } from 'vitest'
import { resolveUnifiedCanonicalScope, type UnifiedCanonicalScope } from './canonical-scope.js'

const scope: UnifiedCanonicalScope = {
  workspaceId: 'ws_1',
  brandId: 'brand_1',
  canonicalProductId: 'canonical_1',
  listingId: 'listing_1',
  platform: 'taobao',
  accountId: 'account_1',
}

const legacy = {
  productId: 'product_1',
  ...scope,
}

describe('unified canonical scope and legacy projection', () => {
  it('returns one complete scope and an exact legacy projection', () => {
    const result = resolveUnifiedCanonicalScope({ scope, legacyProductId: 'product_1', legacyCandidates: [legacy] })
    expect(result).toEqual({ status: 'verified', scope, legacyProjection: legacy })
  })

  it('allows canonical-first operations without inventing a legacy product id', () => {
    const result = resolveUnifiedCanonicalScope({ scope })
    expect(result).toEqual({ status: 'verified', scope })
  })

  it.each([
    ['missing canonical scope', { ...scope, listingId: '' }, 'CANONICAL_SCOPE_REQUIRED'],
    ['missing legacy mapping', scope, 'LEGACY_PRODUCT_MAPPING_REQUIRED'],
    ['ambiguous legacy mapping', scope, 'LEGACY_PRODUCT_MAPPING_AMBIGUOUS'],
    ['cross-workspace projection', scope, 'LEGACY_PROJECTION_SCOPE_MISMATCH'],
  ] as const)('fails closed for %s', (_label, candidateScope, code) => {
    const result = resolveUnifiedCanonicalScope({
      scope: candidateScope,
      ...(code === 'CANONICAL_SCOPE_REQUIRED' ? {} : { legacyProductId: 'product_1' }),
      ...(code === 'LEGACY_PRODUCT_MAPPING_AMBIGUOUS' ? { legacyCandidates: [legacy, legacy] } : {}),
      ...(code === 'LEGACY_PRODUCT_MAPPING_REQUIRED' ? { legacyCandidates: [] } : {}),
      ...(code === 'LEGACY_PROJECTION_SCOPE_MISMATCH' ? { legacyCandidates: [{ ...legacy, workspaceId: 'ws_other' }] } : {}),
    })
    expect(result).toMatchObject({ status: 'blocked', code })
  })

  it('does not guess from incomplete candidate metadata or mutate input', () => {
    const candidate = { productId: 'product_1', workspaceId: scope.workspaceId, title: 'same title' }
    const result = resolveUnifiedCanonicalScope({ scope, legacyProductId: 'product_1', legacyCandidates: [candidate] })
    expect(result).toMatchObject({ status: 'blocked', code: 'LEGACY_PROJECTION_SCOPE_MISMATCH' })
    expect(candidate).toEqual({ productId: 'product_1', workspaceId: 'ws_1', title: 'same title' })
  })
})
