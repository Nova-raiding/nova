import { describe, expect, it } from 'vitest'
import { normalizeApiPage } from '../demo/merchant-studio/src/api.js'

describe('Merchant Studio API page normalization', () => {
  it('accepts the legacy collection response during rolling upgrades', () => {
    expect(normalizeApiPage([{ id: 'a' }, { id: 'b' }], 10, 20)).toEqual({
      items: [{ id: 'a' }, { id: 'b' }], total: 2, limit: 10, offset: 20,
    })
  })

  it('preserves a server page and rejects malformed pagination metadata', () => {
    const page = { items: [{ id: 'a' }], total: 31, limit: 10, offset: 20 }
    expect(normalizeApiPage(page, 5, 0)).toBe(page)
    expect(() => normalizeApiPage({ items: [], total: Number.NaN, limit: 10, offset: 0 }, 10, 0)).toThrow('API 分页响应格式无效')
  })
})
