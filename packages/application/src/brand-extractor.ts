export type BrandCandidateFieldKey = 'name' | 'positioning' | 'audience' | 'tone' | 'forbiddenTerms' | 'logoRules' | 'colors' | 'fonts' | 'rights'

export interface BrandCandidateSource {
  value: string | string[]
  confidence: number
  assetId: string
  assetName: string
  reference: string
}

export interface BrandCandidateField {
  key: BrandCandidateFieldKey
  label: string
  value: string | string[]
  confidence: number
  status: 'needs_confirmation' | 'conflict'
  confirmationRequired: true
  sources: BrandCandidateSource[]
  alternatives: Array<{ value: string | string[]; confidence: number; sourceAssetIds: string[] }>
}

export interface BrandExtraction {
  assetIds: string[]
  generatedAt: string
  fields: Partial<Record<BrandCandidateFieldKey, BrandCandidateField>>
  ignoredAssets: Array<{ assetId: string; assetName: string; reason: string }>
  warnings: string[]
}

export interface BrandExtractableAsset {
  id: string
  name: string
  parseStatus: string
  extractedFacts?: Record<string, unknown>
  extractedFactsSource?: 'parser' | 'model_ocr' | 'manual'
}

const definitions: Array<{ key: BrandCandidateFieldKey; label: string; aliases: string[]; list?: boolean }> = [
  { key: 'name', label: '品牌名称', aliases: ['品牌名称', '品牌名', 'brandname', 'brand'] },
  { key: 'positioning', label: '品牌定位', aliases: ['品牌定位', '定位', 'brandpositioning', 'positioning'] },
  { key: 'audience', label: '目标人群', aliases: ['目标人群', '目标受众', '受众', 'audience', 'targetaudience'] },
  { key: 'tone', label: '品牌语气', aliases: ['品牌语气', '品牌调性', '语气', '调性', 'tone', 'brandtone'], list: true },
  { key: 'forbiddenTerms', label: '禁用表达', aliases: ['禁用表达', '禁用词', '禁止用语', '不可使用', 'forbiddenterms', 'forbiddenwords'], list: true },
  { key: 'logoRules', label: 'Logo 使用规范', aliases: ['logo使用规范', 'logo规范', 'logorules', 'logoguidelines'], list: true },
  { key: 'colors', label: '品牌颜色', aliases: ['品牌颜色', '品牌色', '主色', '辅助色', 'brandcolors', 'colors'], list: true },
  { key: 'fonts', label: '品牌字体', aliases: ['品牌字体', '指定字体', '字体规范', 'brandfonts', 'fonts'], list: true },
  { key: 'rights', label: '品牌权益与授权', aliases: ['品牌权益', '授权范围', '使用授权', 'rights', 'brandrights'], list: true },
]

function normalizedKey(value: string) {
  return value.toLowerCase().replace(/[\s_.:：/\\-]+/gu, '')
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const result = String(value).replace(/\s+/gu, ' ').trim()
  return result && result.length <= 2000 ? result : undefined
}

function listValue(value: unknown): string[] | undefined {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,，、;；|]+/u) : []
  const result = [...new Set(input.map(cleanText).filter((item): item is string => Boolean(item)))].slice(0, 50)
  return result.length ? result : undefined
}

function sameValue(left: string | string[], right: string | string[]) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function directCandidates(asset: BrandExtractableAsset): BrandCandidateSource[] {
  const facts = asset.extractedFacts ?? {}
  const confidence = asset.extractedFactsSource === 'manual' ? 0.98 : 0.9
  const candidates: BrandCandidateSource[] = []
  for (const [rawKey, rawValue] of Object.entries(facts)) {
    const definition = definitions.find(item => item.aliases.map(normalizedKey).includes(normalizedKey(rawKey)))
    if (!definition) continue
    const value = definition.list ? listValue(rawValue) : cleanText(rawValue)
    if (!value || (Array.isArray(value) && !value.length)) continue
    candidates.push({ value, confidence, assetId: asset.id, assetName: asset.name, reference: rawKey })
  }
  return candidates
}

function textCandidates(asset: BrandExtractableAsset): BrandCandidateSource[] {
  const rawText = asset.extractedFacts?.text
  const text = typeof rawText === 'string' ? rawText.slice(0, 2 * 1024 * 1024).replace(/\r\n?/gu, '\n') : undefined
  if (!text?.trim()) return []
  const confidence = asset.extractedFactsSource === 'manual' ? 0.85 : 0.68
  const candidates: BrandCandidateSource[] = []
  for (const definition of definitions) {
    const aliases = definition.aliases.filter(alias => /[\u3400-\u9fff]/u.test(alias))
    for (const alias of aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      const match = new RegExp(`(?:^|[\\n。；;])\\s*${escaped}\\s*[:：]\\s*([^\\n。；;]{1,500})`, 'iu').exec(text)
      if (!match?.[1]) continue
      const value = definition.list ? listValue(match[1]) : cleanText(match[1])
      if (value && (!Array.isArray(value) || value.length)) candidates.push({ value, confidence, assetId: asset.id, assetName: asset.name, reference: `正文:${alias}` })
      break
    }
  }
  return candidates
}

export function extractBrandCandidates(assets: BrandExtractableAsset[], generatedAt = new Date().toISOString()): BrandExtraction {
  const fields: BrandExtraction['fields'] = {}
  const ignoredAssets: BrandExtraction['ignoredAssets'] = []
  const sourcesByKey = new Map<BrandCandidateFieldKey, BrandCandidateSource[]>()
  for (const asset of assets) {
    if (asset.parseStatus !== 'succeeded' || !asset.extractedFacts) {
      ignoredAssets.push({ assetId: asset.id, assetName: asset.name, reason: asset.parseStatus === 'failed' ? '素材读取失败' : '素材尚未读取并确认' })
      continue
    }
    const candidates = [...directCandidates(asset), ...textCandidates(asset)]
    for (const candidate of candidates) {
      const definition = definitions.find(item => item.aliases.map(normalizedKey).includes(normalizedKey(candidate.reference.replace(/^正文:/u, ''))))
        ?? definitions.find(item => candidate.reference === `正文:${item.aliases.find(alias => candidate.reference.endsWith(alias))}`)
      if (!definition) continue
      sourcesByKey.set(definition.key, [...(sourcesByKey.get(definition.key) ?? []), candidate])
    }
  }
  for (const definition of definitions) {
    const sources = sourcesByKey.get(definition.key) ?? []
    if (!sources.length) continue
    const alternatives: BrandCandidateField['alternatives'] = []
    for (const source of sources.sort((left, right) => right.confidence - left.confidence)) {
      const existing = alternatives.find(item => sameValue(item.value, source.value))
      if (existing) { existing.confidence = Math.max(existing.confidence, source.confidence); existing.sourceAssetIds.push(source.assetId) }
      else alternatives.push({ value: source.value, confidence: source.confidence, sourceAssetIds: [source.assetId] })
    }
    const selected = alternatives[0]!
    fields[definition.key] = {
      key: definition.key,
      label: definition.label,
      value: selected.value,
      confidence: selected.confidence,
      status: alternatives.length > 1 ? 'conflict' : 'needs_confirmation',
      confirmationRequired: true,
      sources,
      alternatives,
    }
  }
  const warnings = [
    ...(Object.keys(fields).length ? [] : ['没有从已读取素材中识别出品牌字段，请人工补录。']),
    ...(Object.values(fields).some(field => field?.status === 'conflict') ? ['不同素材存在冲突值，不能自动合并；请逐字段选择。'] : []),
    '所有自动提取字段都必须由商家确认后才能写入品牌档案。',
  ]
  return { assetIds: assets.map(asset => asset.id), generatedAt, fields, ignoredAssets, warnings }
}
