import { describe, expect, it } from 'vitest'
import { batchTargetKey, toggleBatchTarget } from '../demo/merchant-studio/src/batch-target.js'

describe('batch target identity', () => {
  it('keeps the same product selectable in multiple stores', () => {
    const storeA = { productId: 'p1', platform: 'jd', accountId: 'store-a' }
    const storeB = { productId: 'p1', platform: 'jd', accountId: 'store-b' }
    expect(toggleBatchTarget(toggleBatchTarget([], storeA), storeB)).toEqual([storeA, storeB])
  })

  it('toggles only the exact listing target', () => {
    const first = { productId: 'p1', platform: 'taobao', accountId: 'store-a', listingId: 'listing-1' }
    const second = { ...first, listingId: 'listing-2' }
    expect(batchTargetKey(first)).not.toBe(batchTargetKey(second))
    expect(toggleBatchTarget([first, second], first)).toEqual([second])
  })
})
