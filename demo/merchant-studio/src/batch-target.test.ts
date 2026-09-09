import { describe, expect, it } from 'vitest'
import { projectProductRowTarget, projectProductTarget } from './batch-target.js'

describe('merchant batch target projection', () => {
  it('carries canonical API scope into a batch target', () => {
    expect(projectProductTarget({
      id: 'product-1',
      platform: 'taobao',
      title: '商品一',
      accountId: 'store-1',
      storeName: '淘宝店',
      brandId: undefined,
      canonical_scope: {
        verification_status: 'verified',
        canonical_product_id: 'canonical-1',
        brand_id: 'brand-1',
        listing_id: 'listing-1',
        listing_count: 1,
      },
    })).toMatchObject({ productId: 'product-1', platform: 'taobao', accountId: 'store-1', brandId: 'brand-1', canonicalProductId: 'canonical-1', listingId: 'listing-1' })
  })

  it('preserves the normalized relation fields used by the product table', () => {
    expect(projectProductRowTarget({ id: 'product-2', platformId: 'jd', title: '商品二', accountId: 'store-2', storeName: '京东店', brandId: 'brand-2', canonicalProductId: 'canonical-2', listingId: 'listing-2' })).toEqual({ productId: 'product-2', platform: 'jd', title: '商品二', accountId: 'store-2', storeName: '京东店', brandId: 'brand-2', canonicalProductId: 'canonical-2', listingId: 'listing-2' })
  })
})
