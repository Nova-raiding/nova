export type SeoGeoPlatform = 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin'

export interface SeoGeoInput {
  platform: SeoGeoPlatform
  productId: string
  title: string
  category?: string
  attributes?: Record<string, string>
  sellingPoints?: string[]
  keyword?: string
  objective?: string
}

export interface SeoGeoSuggestion {
  id: string
  platform: SeoGeoPlatform
  title: string
  score: { seo: number; geo: number; total: number }
  keywords: string[]
  evidence: Array<{ source: 'product_fact' | 'selling_point' | 'merchant_keyword'; value: string }>
  risks: string[]
  rationale: string[]
  status: 'suggested' | 'accepted' | 'rejected'
  rankingGuarantee: false
}

const platformLimits: Record<SeoGeoPlatform, number> = { jd: 60, taobao: 60, tmall: 60, pinduoduo: 60, xiaohongshu: 25, douyin: 55 }
const normalize = (value: string) => value.replace(/[\s，。！？、|｜]+/gu, ' ').trim()

export function generateSeoGeoSuggestions(input: SeoGeoInput): SeoGeoSuggestion[] {
  const facts = Object.entries(input.attributes ?? {}).filter(([, value]) => value.trim()).map(([key, value]) => `${key}${value}`)
  const points = (input.sellingPoints ?? []).filter(Boolean)
  const keywords = [input.keyword?.trim(), input.category?.trim(), ...facts.slice(0, 3), ...points.slice(0, 2)].filter((value): value is string => Boolean(value)).map(normalize)
  const dedupedKeywords = [...new Set(keywords)].slice(0, 8)
  const evidence = [
    { source: 'product_fact' as const, value: input.title },
    ...facts.slice(0, 3).map(value => ({ source: 'product_fact' as const, value })),
    ...points.slice(0, 2).map(value => ({ source: 'selling_point' as const, value })),
    ...(input.keyword?.trim() ? [{ source: 'merchant_keyword' as const, value: input.keyword.trim() }] : []),
  ]
  const base = normalize([input.title, input.category, ...dedupedKeywords].filter(Boolean).join(' '))
  const title = base.slice(0, platformLimits[input.platform])
  const risks = [
    ...(input.title.length > platformLimits[input.platform] ? ['原商品标题超过平台建议长度，已截断'] : []),
    ...(points.length === 0 ? ['缺少已确认卖点，未自动补写功效或承诺'] : []),
    'SEO/GEO 分数是本地建议，不代表平台排名、收录或转化结果',
  ]
  const seo = Math.min(100, 55 + dedupedKeywords.length * 5 + (input.category ? 10 : 0))
  const geo = Math.min(100, 50 + evidence.length * 6 + (input.objective ? 5 : 0))
  return [{ id: `seo_geo_${input.productId}_${input.platform}`, platform: input.platform, title, score: { seo, geo, total: Math.round((seo + geo) / 2) }, keywords: dedupedKeywords, evidence, risks, rationale: ['关键词来自商品标题、类目、属性或商家输入', '未生成未经事实证明的功效、销量、排名和价格承诺'], status: 'suggested', rankingGuarantee: false }]
}
