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
  /** Deterministic checks merchants can inspect before accepting a title. */
  quality: { characterCount: number; keywordCoverage: number; duplicateTerms: string[]; platformFit: 'within_limit' | 'truncated' }
}

const platformLimits: Record<SeoGeoPlatform, number> = { jd: 60, taobao: 60, tmall: 60, pinduoduo: 60, xiaohongshu: 25, douyin: 55 }
const platforms = new Set<SeoGeoPlatform>(Object.keys(platformLimits) as SeoGeoPlatform[])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u
const MAX_INPUT_LENGTH = 5_000
const MAX_COLLECTION_ITEMS = 100

// These expressions are intentionally conservative. A title is customer-facing
// copy, so unsupported superlatives, guarantees and medical claims must never
// be assembled from an imported title or merchant keyword. Confirmed facts can
// still be shown in the evidence list for human review.
const unsupportedClaimPatterns: readonly RegExp[] = [
  /全网(?:第一|最低|最好|最强)/u,
  /(?:销量|销售|排名|口碑)(?:第一|冠军|领先)/u,
  /(?:顶级|极致|完美|绝对|唯一|首选|国家级|官方认证)/u,
  /(?:100%|百分之百)(?:有效|安全|纯天然|无添加)/iu,
  /(?:零风险|无风险|永久|根治|治疗|治愈|药效)/u,
  /(?:假一赔十|假一赔百)/u,
]

export class SeoGeoInputError extends Error {
  readonly code = 'SEO_GEO_INPUT_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'SeoGeoInputError'
  }
}

const normalize = (value: string) => value.replace(/[\s，。！？、|｜]+/gu, ' ').trim()

function uniqueTerms(values: readonly string[]): string[] {
  const seen = new Set<string>()
  return values.filter(value => {
    const key = normalize(value).toLocaleLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function removeUnsupportedClaims(value: string): { value: string; removed: boolean } {
  let next = value
  let removed = false
  for (const pattern of unsupportedClaimPatterns) {
    // A term can contain more than one claim (for example “零风险永久有效”);
    // remove every occurrence before it enters the candidate title.
    while (pattern.test(next)) {
      removed = true
      next = next.replace(pattern, ' ')
    }
  }
  return { value: normalize(next), removed }
}

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
  const allCandidateTerms = [normalized.keyword, normalized.category, ...facts.slice(0, 3), ...points.slice(0, 2)].filter((value): value is string => Boolean(value)).map(normalize)
  const sanitizedTerms = allCandidateTerms.map(removeUnsupportedClaims)
  const dedupedKeywords = [...new Map(sanitizedTerms.filter(term => term.value).map(term => [term.value.toLocaleLowerCase(), term.value])).values()].slice(0, 8)
  const evidence = [
    { source: 'product_fact' as const, value: normalized.title },
    ...facts.slice(0, 3).map(value => ({ source: 'product_fact' as const, value })),
    ...points.slice(0, 2).map(value => ({ source: 'selling_point' as const, value })),
    ...(normalized.keyword ? [{ source: 'merchant_keyword' as const, value: normalized.keyword }] : []),
  ]
  const sanitizedTitle = removeUnsupportedClaims(normalized.title)
  const titleAnchor = sanitizedTitle.value
  // Do not append a category/keyword when it is already contained in the
  // merchant title. Repeating the same phrase is a common source of spammy
  // looking titles and wastes the platform character budget.
  const additions = dedupedKeywords.filter(term => {
    const needle = normalize(term).toLocaleLowerCase()
    return needle && !titleAnchor.toLocaleLowerCase().includes(needle)
  })
  const base = normalize([titleAnchor, ...additions].filter(Boolean).join(' '))
  const limit = platformLimits[normalized.platform]
  // Cut by characters, not UTF-16 code units. `slice` splits a surrogate pair,
  // and the lone half survives JSON but is encoded as U+FFFD by the first UTF-8
  // writer (the publish body or the database), so a title truncated inside an
  // emoji reached the platform ending in a replacement character. The risk note
  // counts characters too, or it reports a truncation that did not happen for a
  // title shorter than the limit in characters.
  const title = Array.from(base).slice(0, limit).join('')
  const titleTerms = title.split(' ').filter(Boolean)
  const duplicateTerms = titleTerms.filter((term, index, all) => all.findIndex(candidate => candidate.toLocaleLowerCase() === term.toLocaleLowerCase()) !== index)
  const coveredKeywords = dedupedKeywords.filter(keyword => title.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())).length
  const risks = [
    ...(Array.from(normalized.title).length > limit ? ['原商品标题超过平台建议长度，已截断'] : []),
    ...(sanitizedTitle.removed || sanitizedTerms.some(term => term.removed) ? ['检测到未经证明的夸大、保证或医疗表达，已从候选标题移除'] : []),
    ...(points.length === 0 ? ['缺少已确认卖点，未自动补写功效或承诺'] : []),
    'SEO/GEO 分数是本地建议，不代表平台排名、收录或转化结果',
  ]
  const seo = Math.min(100, 55 + dedupedKeywords.length * 5 + (normalized.category ? 10 : 0))
  const geo = Math.min(100, 50 + evidence.length * 6 + (normalized.objective ? 5 : 0))
  return [{ id: `seo_geo_${normalized.productId}_${normalized.platform}`, platform: normalized.platform, title, score: { seo, geo, total: Math.round((seo + geo) / 2) }, keywords: dedupedKeywords, evidence, risks, rationale: ['关键词来自商品标题、类目、属性或商家输入', '已去除标题中重复的完整词组，优先保留商品原名', '未生成未经事实证明的功效、销量、排名和价格承诺'], status: 'suggested', rankingGuarantee: false, factsVersion, contextHash: contextHash(normalized, factsVersion), quality: { characterCount: Array.from(title).length, keywordCoverage: dedupedKeywords.length ? Math.round((coveredKeywords / dedupedKeywords.length) * 100) : 0, duplicateTerms: [...new Set(duplicateTerms)], platformFit: Array.from(base).length > limit ? 'truncated' : 'within_limit' } }]
}
