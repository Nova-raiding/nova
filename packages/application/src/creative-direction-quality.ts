export const CREATIVE_DIRECTION_DIMENSIONS = [
  'coreIdea',
  'structure',
  'visualDirection',
  'copyDirection',
  'sellingPoints',
  'fitReason',
  'risk',
] as const

export type CreativeDirectionDimension = typeof CREATIVE_DIRECTION_DIMENSIONS[number]

export interface CreativeDirectionQualityCandidate {
  id: string
  name: string
  coreIdea: string
  structure: string
  visualDirection: string
  copyDirection: string
  sellingPoints: readonly string[]
  fitReason: string
  risk: string
}

export interface CreativeDirectionQualityThresholds {
  /** Aggregate token overlap at or above this value is a near duplicate. */
  maxTokenSimilarity: number
  /** Combined token and per-field overlap at or above this value is rejected. */
  maxOverallSimilarity: number
  /** A field must be at or below this similarity to count as meaningfully different. */
  maxSimilarDimensionScore: number
  /** At least this many semantic fields must be meaningfully different. */
  minDifferentDimensions: number
}

export type CreativeDirectionQualityReasonCode =
  | 'DIRECTION_COUNT_INVALID'
  | 'DIRECTION_ID_DUPLICATE'
  | 'DIRECTION_CONTENT_INSUFFICIENT'
  | 'TOKEN_SIMILARITY_TOO_HIGH'
  | 'OVERALL_SIMILARITY_TOO_HIGH'
  | 'INSUFFICIENT_FIELD_DIFFERENCE'

export interface CreativeDirectionQualityReason {
  code: CreativeDirectionQualityReasonCode
  message: string
  actual?: number
  threshold?: number
  dimensions?: CreativeDirectionDimension[]
  directionIds?: string[]
}

export interface CreativeDirectionPairScore {
  directionIds: [string, string]
  tokenSimilarity: number
  averageDimensionSimilarity: number
  overallSimilarity: number
  diversityScore: number
  dimensionSimilarities: Record<CreativeDirectionDimension, number>
  differentDimensions: CreativeDirectionDimension[]
  passed: boolean
  reasons: CreativeDirectionQualityReason[]
}

export interface CreativeDirectionQualityReport {
  passed: boolean
  thresholds: CreativeDirectionQualityThresholds
  normalizedDirections: Array<{ id: string; dimensions: Record<CreativeDirectionDimension, string> }>
  pairScores: CreativeDirectionPairScore[]
  reasons: CreativeDirectionQualityReason[]
}

export interface CreativeDirectionQualityOptions {
  thresholds?: Partial<CreativeDirectionQualityThresholds>
  /** Additional concept-to-alias mappings used before token comparison. */
  synonyms?: Readonly<Record<string, readonly string[]>>
}

export const DEFAULT_CREATIVE_DIRECTION_QUALITY_THRESHOLDS: CreativeDirectionQualityThresholds = {
  maxTokenSimilarity: 0.78,
  maxOverallSimilarity: 0.72,
  maxSimilarDimensionScore: 0.5,
  minDifferentDimensions: 3,
}

const DEFAULT_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  minimal: ['极简', '简约', '简洁', 'minimal', 'minimalist', 'clean and simple'],
  premium: ['高级感', '高端感', '品质感', '质感', 'premium', 'high end', 'high-end'],
  highlight: ['突出', '强调', '聚焦', '着重', 'highlight', 'emphasize', 'focus', 'focused'],
  benefit: ['核心卖点', '主要卖点', '主要利益点', '核心利益点', 'key selling point', 'key benefit', 'main benefit'],
  scene: ['使用场景', '生活场景', '场景化', 'lifestyle scene', 'usage scene'],
  evidence: ['事实证明', '证据优先', '可信证明', 'proof first', 'evidence first'],
}

function roundScore(value: number) { return Math.round(value * 1000) / 1000 }

function normalizeBase(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function synonymAliases(options?: CreativeDirectionQualityOptions['synonyms']) {
  const merged: Record<string, readonly string[]> = { ...DEFAULT_SYNONYMS, ...(options ?? {}) }
  return Object.entries(merged)
    .flatMap(([concept, aliases]) => aliases.map(alias => ({ concept: normalizeBase(concept), alias: normalizeBase(alias) })))
    .filter(item => item.concept && item.alias)
    .sort((left, right) => right.alias.length - left.alias.length)
}

function escapeRegularExpression(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }

function canonicalize(value: string, aliases: ReturnType<typeof synonymAliases>) {
  let normalized = normalizeBase(value)
  for (const { concept, alias } of aliases) {
    normalized = /\p{Script=Han}/u.test(alias)
      ? normalized.split(alias).join(` ${concept} `)
      : normalized.replace(new RegExp(`(^|\\s)${escapeRegularExpression(alias)}(?=\\s|$)`, 'gu'), `$1${concept}`)
    normalized = normalized.replace(/\s+/gu, ' ').trim()
  }
  return normalized
}

function tokens(value: string) {
  const result = new Set<string>()
  for (const token of value.match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/gu) ?? []) result.add(`word:${token}`)
  for (const run of value.match(/[\p{Script=Han}]+/gu) ?? []) {
    const characters = [...run]
    if (characters.length === 1) result.add(`han:${run}`)
    else for (let index = 0; index < characters.length - 1; index += 1) result.add(`han:${characters[index]}${characters[index + 1]}`)
  }
  return result
}

function jaccard(left: Set<string>, right: Set<string>) {
  if (!left.size && !right.size) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

function dimensions(direction: CreativeDirectionQualityCandidate, aliases: ReturnType<typeof synonymAliases>): Record<CreativeDirectionDimension, string> {
  return {
    coreIdea: canonicalize(direction.coreIdea, aliases),
    structure: canonicalize(direction.structure, aliases),
    visualDirection: canonicalize(direction.visualDirection, aliases),
    copyDirection: canonicalize(direction.copyDirection, aliases),
    sellingPoints: canonicalize(direction.sellingPoints.join(' '), aliases),
    fitReason: canonicalize(direction.fitReason, aliases),
    risk: canonicalize(direction.risk, aliases),
  }
}

function validThreshold(value: number, minimum: number, maximum: number, name: string) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`CREATIVE_DIRECTION_QUALITY_THRESHOLD_INVALID:${name}`)
  return value
}

function thresholds(options?: CreativeDirectionQualityOptions): CreativeDirectionQualityThresholds {
  const values = { ...DEFAULT_CREATIVE_DIRECTION_QUALITY_THRESHOLDS, ...(options?.thresholds ?? {}) }
  if (!Number.isInteger(values.minDifferentDimensions)) throw new Error('CREATIVE_DIRECTION_QUALITY_THRESHOLD_INVALID:minDifferentDimensions')
  return {
    maxTokenSimilarity: validThreshold(values.maxTokenSimilarity, 0, 1, 'maxTokenSimilarity'),
    maxOverallSimilarity: validThreshold(values.maxOverallSimilarity, 0, 1, 'maxOverallSimilarity'),
    maxSimilarDimensionScore: validThreshold(values.maxSimilarDimensionScore, 0, 1, 'maxSimilarDimensionScore'),
    minDifferentDimensions: validThreshold(values.minDifferentDimensions, 1, CREATIVE_DIRECTION_DIMENSIONS.length, 'minDifferentDimensions'),
  }
}

export function evaluateCreativeDirectionQuality(
  directions: readonly CreativeDirectionQualityCandidate[],
  options: CreativeDirectionQualityOptions = {},
): CreativeDirectionQualityReport {
  const qualityThresholds = thresholds(options)
  const aliases = synonymAliases(options.synonyms)
  const normalizedDirections = directions.map(direction => ({ id: direction.id.trim(), dimensions: dimensions(direction, aliases) }))
  const reasons: CreativeDirectionQualityReason[] = []

  if (directions.length !== 3) reasons.push({ code: 'DIRECTION_COUNT_INVALID', message: `必须提供恰好 3 个方向，当前为 ${directions.length} 个`, actual: directions.length, threshold: 3 })
  const ids = normalizedDirections.map(direction => direction.id)
  if (ids.some((id, index) => !id || ids.indexOf(id) !== index)) reasons.push({ code: 'DIRECTION_ID_DUPLICATE', message: '三个方向必须具有非空且互不相同的 ID', directionIds: ids })
  normalizedDirections.forEach(direction => {
    const missing = CREATIVE_DIRECTION_DIMENSIONS.filter(dimension => !direction.dimensions[dimension])
    if (missing.length) reasons.push({ code: 'DIRECTION_CONTENT_INSUFFICIENT', message: `方向 ${direction.id || '(empty)'} 缺少可评估字段：${missing.join('、')}`, dimensions: missing, directionIds: [direction.id] })
  })

  const pairScores: CreativeDirectionPairScore[] = []
  for (let leftIndex = 0; leftIndex < normalizedDirections.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < normalizedDirections.length; rightIndex += 1) {
      const left = normalizedDirections[leftIndex]!
      const right = normalizedDirections[rightIndex]!
      const dimensionSimilarities = Object.fromEntries(CREATIVE_DIRECTION_DIMENSIONS.map(dimension => [dimension, roundScore(jaccard(tokens(left.dimensions[dimension]), tokens(right.dimensions[dimension])))])) as Record<CreativeDirectionDimension, number>
      const averageDimensionSimilarity = roundScore(CREATIVE_DIRECTION_DIMENSIONS.reduce((sum, dimension) => sum + dimensionSimilarities[dimension], 0) / CREATIVE_DIRECTION_DIMENSIONS.length)
      const leftAll = CREATIVE_DIRECTION_DIMENSIONS.map(dimension => left.dimensions[dimension]).join(' ')
      const rightAll = CREATIVE_DIRECTION_DIMENSIONS.map(dimension => right.dimensions[dimension]).join(' ')
      const tokenSimilarity = roundScore(jaccard(tokens(leftAll), tokens(rightAll)))
      const overallSimilarity = roundScore(tokenSimilarity * 0.6 + averageDimensionSimilarity * 0.4)
      const differentDimensions = CREATIVE_DIRECTION_DIMENSIONS.filter(dimension => dimensionSimilarities[dimension] <= qualityThresholds.maxSimilarDimensionScore)
      const pairReasons: CreativeDirectionQualityReason[] = []
      const directionIds: [string, string] = [left.id, right.id]
      if (tokenSimilarity >= qualityThresholds.maxTokenSimilarity) pairReasons.push({ code: 'TOKEN_SIMILARITY_TOO_HIGH', message: `方向 ${left.id}/${right.id} 的规范化 token 重合度过高`, actual: tokenSimilarity, threshold: qualityThresholds.maxTokenSimilarity, directionIds })
      if (overallSimilarity >= qualityThresholds.maxOverallSimilarity) pairReasons.push({ code: 'OVERALL_SIMILARITY_TOO_HIGH', message: `方向 ${left.id}/${right.id} 的综合相似度过高`, actual: overallSimilarity, threshold: qualityThresholds.maxOverallSimilarity, directionIds })
      if (differentDimensions.length < qualityThresholds.minDifferentDimensions) pairReasons.push({ code: 'INSUFFICIENT_FIELD_DIFFERENCE', message: `方向 ${left.id}/${right.id} 只有 ${differentDimensions.length} 个明显不同字段`, actual: differentDimensions.length, threshold: qualityThresholds.minDifferentDimensions, dimensions: differentDimensions, directionIds })
      pairScores.push({ directionIds, tokenSimilarity, averageDimensionSimilarity, overallSimilarity, diversityScore: roundScore(1 - overallSimilarity), dimensionSimilarities, differentDimensions, passed: pairReasons.length === 0, reasons: pairReasons })
      reasons.push(...pairReasons)
    }
  }

  return { passed: reasons.length === 0, thresholds: qualityThresholds, normalizedDirections, pairScores, reasons }
}

export class CreativeDirectionQualityError extends Error {
  readonly code = 'CREATIVE_DIRECTIONS_NOT_DISTINCT'
  constructor(readonly report: CreativeDirectionQualityReport) {
    super(`三个创意方向未达到明显不同门禁：${report.reasons.map(reason => reason.message).join('；')}`)
    this.name = 'CreativeDirectionQualityError'
  }
}

export function assertCreativeDirectionsClearlyDifferent(
  directions: readonly CreativeDirectionQualityCandidate[],
  options: CreativeDirectionQualityOptions = {},
) {
  const report = evaluateCreativeDirectionQuality(directions, options)
  if (!report.passed) throw new CreativeDirectionQualityError(report)
  return report
}
