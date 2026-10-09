import { describe, expect, it } from 'vitest'
import { shouldShowSelectedCategory } from './rule-context.js'

describe('selected category field details', () => {
  const category = { code: '1312' }

  it('shows details only while the selected category is visible in the categories tab', () => {
    expect(shouldShowSelectedCategory('categories', category, [category])).toBe(true)
    expect(shouldShowSelectedCategory('rules', category, [category])).toBe(false)
    expect(shouldShowSelectedCategory('categories', category, [])).toBe(false)
    expect(shouldShowSelectedCategory('categories', category, [{ code: '1408' }])).toBe(false)
    expect(shouldShowSelectedCategory('categories', null, [category])).toBe(false)
  })
})
