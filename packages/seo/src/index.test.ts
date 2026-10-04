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

  it('never truncates inside a character', () => {
    const suggestion = generateSeoGeoSuggestions({ ...validInput, platform: 'xiaohongshu', title: '😀'.repeat(30) })[0]!

    // `slice` left a lone high surrogate here, which the first UTF-8 writer
    // turned into U+FFFD in the published title.
    expect(/[\uD800-\uDFFF]/u.test(suggestion.title)).toBe(false)
    expect(suggestion.title).toBe('😀'.repeat(25))
    // A title shorter than the limit in characters is not reported as truncated
    // just because its emoji are two UTF-16 code units each.
    expect(generateSeoGeoSuggestions({ ...validInput, platform: 'xiaohongshu', title: '😀'.repeat(20) })[0]!.risks)
      .not.toContain('原商品标题超过平台建议长度，已截断')
  })

  it('keeps platform title limits and the no-guarantee contract', () => {
    const suggestion = generateSeoGeoSuggestions({ ...validInput, platform: 'xiaohongshu', title: '非常长的商品标题'.repeat(20) })[0]!

    expect([...suggestion.title].length).toBeLessThanOrEqual(25)
    expect(suggestion.rankingGuarantee).toBe(false)
    expect(suggestion.risks).toContain('SEO/GEO 分数是本地建议，不代表平台排名、收录或转化结果')
  })

  it('reports when a short platform limit drops one or more evidence-backed keywords', () => {
    const suggestion = generateSeoGeoSuggestions({
      ...validInput,
      platform: 'xiaohongshu',
      title: '轻薄防晒外套',
      category: '女装外套',
      attributes: { 颜色: '浅蓝', 尺码: 'M', 材质: '聚酯纤维' },
      keyword: '通勤防晒',
      sellingPoints: ['防晒', '轻薄'],
    })[0]!

    expect(suggestion.quality.keywordCoverage).toBeLessThan(100)
    expect(suggestion.risks).toContain('平台字符上限导致部分关键词未纳入候选标题，请人工取舍后再确认')
  })

  it('removes unsupported superlatives and guarantees from generated copy', () => {
    const suggestion = generateSeoGeoSuggestions({
      ...validInput,
      title: '全网第一 极致防晒外套',
      keyword: '销量冠军 100%有效',
      sellingPoints: ['轻量便携', '零风险永久有效'],
    })[0]!

    expect(suggestion.title).not.toMatch(/全网第一|极致|销量冠军|100%有效|零风险|永久有效/u)
    expect(suggestion.title).toContain('防晒外套')
    expect(suggestion.risks).toContain('检测到未经证明的夸大、保证或医疗表达，已从候选标题移除')
  })

  it('deduplicates keywords case-insensitively while retaining platform limits', () => {
    const suggestion = generateSeoGeoSuggestions({
      ...validInput,
      platform: 'douyin',
      title: '轻量防晒外套',
      category: '女装',
      keyword: '通勤',
      attributes: { style: '通勤', material: '锦纶' },
      sellingPoints: ['通勤', '轻量'],
    })[0]!

    expect(suggestion.keywords.filter(keyword => keyword === '通勤')).toHaveLength(1)
    expect([...suggestion.title].length).toBeLessThanOrEqual(55)
  })

  it('deduplicates repeated whitespace-separated keyword tokens before assembling the title', () => {
    const suggestion = generateSeoGeoSuggestions({
      ...validInput,
      title: '轻量外套',
      keyword: '通勤 通勤 防晒 通勤',
    })[0]!

    expect(suggestion.title.match(/通勤/gu)).toHaveLength(1)
    expect(suggestion.title.match(/防晒/gu)).toHaveLength(1)
    expect(suggestion.evidence.find(item => item.source === 'merchant_keyword')).toEqual({ source: 'merchant_keyword', value: '通勤 防晒' })
    expect(suggestion.quality.duplicateTerms).toEqual([])
  })

  it('reports deterministic editorial quality and avoids repeating the title anchor', () => {
    const suggestion = generateSeoGeoSuggestions({
      ...validInput,
      title: '轻量防晒外套',
      category: '轻量防晒外套',
      keyword: '轻量防晒外套',
    })[0]!

    expect(suggestion.title.startsWith('轻量防晒外套')).toBe(true)
    expect(suggestion.title.match(/轻量防晒外套/gu)).toHaveLength(1)
    expect(suggestion.quality).toMatchObject({ duplicateTerms: [], platformFit: 'within_limit' })
    expect(suggestion.quality.keywordCoverage).toBe(100)
    expect(suggestion.rationale).toContain('已去除标题中重复的完整词组，优先保留商品原名')
  })
})
