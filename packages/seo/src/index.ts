import { createHash } from 'node:crypto'

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
  factsVersion?: number
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
  factsVersion: number
  contextHash: string
}

const platformLimits: Record<SeoGeoPlatform, number> = { jd: 60, taobao: 60, tmall: 60, pinduoduo: 60, xiaohongshu: 25, douyin: 55 }
const platforms = new Set<SeoGeoPlatform>(Object.keys(platformLimits) as SeoGeoPlatform[])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u
const MAX_INPUT_LENGTH = 5_000
const MAX_COLLECTION_ITEMS = 100

export class SeoGeoInputError extends Error {
  readonly code = 'SEO_GEO_INPUT_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'SeoGeoInputError'
  }
}

const normalize = (value: string) => value.replace(/[\s，。！？、|｜]+/gu, ' ').trim()

function requireText(value: unknown, field: string, { optional = false } = {}): string | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string') throw new SeoGeoInputError(`${field} 必须是字符串`)
  if (value.length === 0 || value.trim().length === 0) throw new SeoGeoInputError(`${field} 不能为空`)
  if (value.length > MAX_INPUT_LENGTH) throw new SeoGeoInputError(`${field} 超出长度限制`)
  if (CONTROL_CHARACTERS.test(value)) throw new SeoGeoInputError(`${field} 包含非法控制字符`)
  const normalized = normalize(value)
  if (normalized.length === 0) throw new SeoGeoInputError(`${field} 不能为空`)
  return normalized
}

function validateInput(input: SeoGeoInput): { factsVersion: number; normalized: SeoGeoInput } {
  if (!input || typeof input !== 'object') throw new SeoGeoInputError('SEO/GEO 输入无效')
  if (typeof input.platform !== 'string' || !platforms.has(input.platform)) throw new SeoGeoInputError('platform 无效')
  const productId = requireText(input.productId, 'productId')!
  const title = requireText(input.title, 'title')!
  const category = requireText(input.category, 'category', { optional: true })
  const keyword = requireText(input.keyword, 'keyword', { optional: true })
  const objective = requireText(input.objective, 'objective', { optional: true })
  const factsVersion = input.factsVersion === undefined ? 1 : input.factsVersion
  if (!Number.isSafeInteger(factsVersion) || factsVersion < 1) throw new SeoGeoInputError('factsVersion 必须是正整数')
  if (input.attributes !== undefined && (!input.attributes || typeof input.attributes !== 'object' || Array.isArray(input.attributes))) throw new SeoGeoInputError('attributes 必须是对象')
  const attributes: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.attributes ?? {})) {
    const normalizedKey = requireText(key, 'attributes.key')!
    const normalizedValue = requireText(value, `attributes.${normalizedKey}`)!
    attributes[normalizedKey] = normalizedValue
  }
  if (Object.keys(attributes).length > MAX_COLLECTION_ITEMS) throw new SeoGeoInputError('attributes 条目过多')
  if (input.sellingPoints !== undefined && !Array.isArray(input.sellingPoints)) throw new SeoGeoInputError('sellingPoints 必须是数组')
  const sellingPoints = input.sellingPoints === undefined ? undefined : input.sellingPoints.map((point, index) => requireText(point, `sellingPoints[${index}]`)!)
  if (sellingPoints && sellingPoints.length > MAX_COLLECTION_ITEMS) throw new SeoGeoInputError('sellingPoints 条目过多')
  return { factsVersion, normalized: { platform: input.platform, productId, title, ...(category ? { category } : {}), ...(Object.keys(attributes).length ? { attributes } : {}), ...(sellingPoints?.length ? { sellingPoints } : {}), ...(keyword ? { keyword } : {}), ...(objective ? { objective } : {}) } }
}

function contextHash(input: SeoGeoInput, factsVersion: number): string {
  const canonical = JSON.stringify({ platform: input.platform, productId: input.productId, title: input.title, category: input.category ?? null, attributes: Object.fromEntries(Object.entries(input.attributes ?? {}).sort(([a], [b]) => a.localeCompare(b))), sellingPoints: input.sellingPoints ?? [], keyword: input.keyword ?? null, objective: input.objective ?? null, factsVersion })
  return createHash('sha256').update(canonical).digest('hex')
}

export function generateSeoGeoSuggestions(input: SeoGeoInput): SeoGeoSuggestion[] {
  const { normalized, factsVersion } = validateInput(input)
  const facts = Object.entries(normalized.attributes ?? {}).map(([key, value]) => `${key}${value}`)
  const points = normalized.sellingPoints ?? []
  const keywords = [normalized.keyword, normalized.category, ...facts.slice(0, 3), ...points.slice(0, 2)].filter((value): value is string => Boolean(value)).map(normalize)
  const dedupedKeywords = [...new Set(keywords)].slice(0, 8)
  const evidence = [
    { source: 'product_fact' as const, value: normalized.title },
    ...facts.slice(0, 3).map(value => ({ source: 'product_fact' as const, value })),
    ...points.slice(0, 2).map(value => ({ source: 'selling_point' as const, value })),
    ...(normalized.keyword ? [{ source: 'merchant_keyword' as const, value: normalized.keyword }] : []),
  ]
  const base = normalize([normalized.title, normalized.category, ...dedupedKeywords].filter(Boolean).join(' '))
  const title = base.slice(0, platformLimits[normalized.platform])
  const risks = [
    ...(normalized.title.length > platformLimits[normalized.platform] ? ['原商品标题超过平台建议长度，已截断'] : []),
    ...(points.length === 0 ? ['缺少已确认卖点，未自动补写功效或承诺'] : []),
    'SEO/GEO 分数是本地建议，不代表平台排名、收录或转化结果',
  ]
  const seo = Math.min(100, 55 + dedupedKeywords.length * 5 + (normalized.category ? 10 : 0))
  const geo = Math.min(100, 50 + evidence.length * 6 + (normalized.objective ? 5 : 0))
  return [{ id: `seo_geo_${normalized.productId}_${normalized.platform}`, platform: normalized.platform, title, score: { seo, geo, total: Math.round((seo + geo) / 2) }, keywords: dedupedKeywords, evidence, risks, rationale: ['关键词来自商品标题、类目、属性或商家输入', '未生成未经事实证明的功效、销量、排名和价格承诺'], status: 'suggested', rankingGuarantee: false, factsVersion, contextHash: contextHash(normalized, factsVersion) }]
}
