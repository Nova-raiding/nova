import { describe, expect, it } from 'vitest'
import { SeoGeoInputError, generateSeoGeoSuggestions } from './index.js'

const validInput = {
  platform: 'taobao' as const,
  productId: 'product-1',
  title: '轻量防晒外套',
  category: '女装外套',
  attributes: { color: '米白', material: '锦纶' },
  sellingPoints: ['轻量便携'],
  keyword: '通勤',
}

describe('generateSeoGeoSuggestions', () => {
  it('returns a deterministic context hash and facts version', () => {
    const first = generateSeoGeoSuggestions({ ...validInput, factsVersion: 3 })[0]!
    const second = generateSeoGeoSuggestions({ ...validInput, attributes: { material: '锦纶', color: '米白' }, factsVersion: 3 })[0]!

    expect(first.contextHash).toMatch(/^[a-f0-9]{64}$/)
    expect(first.contextHash).toBe(second.contextHash)
    expect(first.factsVersion).toBe(3)
  })

  it('changes the context hash when the facts version changes', () => {
    const current = generateSeoGeoSuggestions({ ...validInput, factsVersion: 2 })[0]!
    const next = generateSeoGeoSuggestions({ ...validInput, factsVersion: 3 })[0]!

    expect(current.contextHash).not.toBe(next.contextHash)
  })

  it.each([
    ['empty title', { title: '   '}],
    ['malformed attribute', { attributes: { color: null } }],
    ['malformed selling points', { sellingPoints: 'cheap' }],
    ['control character', { keyword: '通勤\u0000防晒' }],
    ['invalid platform', { platform: 'unknown' }],
    ['invalid facts version', { factsVersion: 0 }],
  ])('fails closed for %s', (_name, override) => {
    expect(() => generateSeoGeoSuggestions({ ...validInput, ...override } as never)).toThrow(SeoGeoInputError)
  })

  it('does not emit an empty title after normalization', () => {
    expect(() => generateSeoGeoSuggestions({ ...validInput, title: '，。！？' })).toThrow(SeoGeoInputError)
  })

  it('keeps platform title limits and the no-guarantee contract', () => {
    const suggestion = generateSeoGeoSuggestions({ ...validInput, platform: 'xiaohongshu', title: '非常长的商品标题'.repeat(20) })[0]!

    expect([...suggestion.title].length).toBeLessThanOrEqual(25)
    expect(suggestion.rankingGuarantee).toBe(false)
    expect(suggestion.risks).toContain('SEO/GEO 分数是本地建议，不代表平台排名、收录或转化结果')
  })
})
