import { describe, expect, it } from 'vitest'
import { validateProtectedProductIntent } from './protected-product-intent.js'

describe('protected product intent: negated accessory additions', () => {
  it.each([
    '无新增配件，调整背景和光影',
    '不要新增配件，只优化背景',
    '不要添加商品配件，保持商品原样',
  ])('allows a clearly negated accessory mutation: %s', request => {
    expect(validateProtectedProductIntent(request)).toMatchObject({ allowed: true, findings: [] })
  })

  it.each([
    '无论如何新增商品配件',
    '无论如何添加商品配件',
  ])('does not treat an affirmative addition as negated: %s', request => {
    expect(validateProtectedProductIntent(request)).toMatchObject({
      allowed: false,
      findings: [expect.objectContaining({ attribute: 'accessories' })],
    })
  })

  it('continues to block affirmative accessory additions', () => {
    expect(validateProtectedProductIntent('新增商品配件')).toMatchObject({
      allowed: false,
      findings: [expect.objectContaining({ attribute: 'accessories' })],
    })
  })
})
