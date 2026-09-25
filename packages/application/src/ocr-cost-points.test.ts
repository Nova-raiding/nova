import { describe, expect, it } from 'vitest'
import { ocrCreativePointsFromCost } from './ocr-cost-points.js'

describe('OCR actual CNY cost to creative points', () => {
  it.each([
    [0, 1], [0.000001, 1], [0.49, 1], [0.5, 1],
    [0.5000000000000001, 2], [0.75, 2], [1, 2], [1.01, 3],
    [4503599627370495.5, Number.MAX_SAFE_INTEGER],
  ])('rounds 2 × ¥%s up to %s point(s), with a one-point minimum', (costCny, expected) => {
    expect(ocrCreativePointsFromCost(costCny)).toBe(expected)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0.5', null, undefined])(
    'rejects invalid actual CNY cost: %s', costCny => {
      expect(() => ocrCreativePointsFromCost(costCny)).toThrow('OCR_COST_CNY_INVALID')
    },
  )

  it('rejects point arithmetic beyond the safe integer range', () => {
    expect(() => ocrCreativePointsFromCost(4503599627370496)).toThrow('OCR_CREATIVE_POINTS_OVERFLOW')
    expect(() => ocrCreativePointsFromCost(Number.MAX_VALUE)).toThrow('OCR_CREATIVE_POINTS_OVERFLOW')
  })
})
