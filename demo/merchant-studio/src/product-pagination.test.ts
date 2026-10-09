import { describe, expect, it } from 'vitest'
import { clampProductPage } from './product-pagination'

describe('product pagination after refresh', () => {
  it('clamps a stale page when the refreshed total shrinks', () => {
    expect(clampProductPage(4, 21, 20)).toBe(1)
  })

  it('keeps page zero for an empty result and handles invalid inputs safely', () => {
    expect(clampProductPage(3, 0, 20)).toBe(0)
    expect(clampProductPage(Number.NaN, 10, 20)).toBe(0)
  })
})
