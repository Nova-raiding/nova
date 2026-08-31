export type CompetitorReferenceAccessKind = 'public' | 'licensed' | 'owned' | 'private'
export type CompetitorAssetKind = 'logo' | 'trademark' | 'person' | 'image'

export interface CompetitorReferenceScope {
  workspaceId: string
  brandId: string
  productId: string
}

export interface CompetitorReferenceSource {
  url: string
  platform: string
  fetchedAt: string
  access: {
    kind: CompetitorReferenceAccessKind
    /** Proof that the page is public or that this use is authorized. */
    evidence: string
    ownerWorkspaceId?: string
  }
}

export interface CompetitorSellingPoint {
  text: string
}

export interface CompetitorOriginalSpan {
  text: string
}

export interface CompetitorExtractedAsset {
  id: string
  kind: CompetitorAssetKind
  description?: string
}

export interface CompetitorReferenceExtraction {
  structures?: string[]
  themes?: string[]
  trends?: string[]
  sellingPoints?: Array<string | CompetitorSellingPoint>
  originalSpans?: CompetitorOriginalSpan[]
  assets?: CompetitorExtractedAsset[]
}

export interface CompetitorCandidateClaim {
  text: string
  /** Evidence for the target product, never evidence copied from the competitor. */
  targetEvidenceIds?: string[]
}

export interface CompetitorCandidateAssetUse {
  sourceAssetId: string
  kind: CompetitorAssetKind
}

export interface CompetitorCandidateContent {
  title?: string
  body?: string
  sellingPoints?: string[]
  claims?: CompetitorCandidateClaim[]
  assetUses?: CompetitorCandidateAssetUse[]
}

export interface CompetitorReferencePolicyThresholds {
  /** English words and Han characters count as one quote unit each. */
  maxShortQuoteUnits: number
  /** Similarity at or above this value is treated as a semantic near-copy. */
  nearCopySimilarity: number
  /** Prevents generic calls-to-action and other short public phrases from matching. */
  minComparableUnits: number
}

export interface CompetitorReferencePolicyInput {
  scope: CompetitorReferenceScope
  reference: CompetitorReferenceSource
  extracted: CompetitorReferenceExtraction
  candidate: CompetitorCandidateContent
  thresholds?: Partial<CompetitorReferencePolicyThresholds>
}

export type CompetitorReferenceFindingCode =
  | 'COMPETITOR_SCOPE_REQUIRED'
  | 'COMPETITOR_SOURCE_URL_REQUIRED'
  | 'COMPETITOR_SOURCE_URL_INVALID'
  | 'COMPETITOR_PLATFORM_REQUIRED'
  | 'COMPETITOR_FETCH_TIME_REQUIRED'
  | 'COMPETITOR_FETCH_TIME_INVALID'
  | 'COMPETITOR_ACCESS_EVIDENCE_REQUIRED'
  | 'COMPETITOR_CROSS_TENANT_PRIVATE_SOURCE'
  | 'COMPETITOR_QUOTE_LIMIT_EXCEEDED'
  | 'COMPETITOR_VERBATIM_COPY'
  | 'COMPETITOR_NEAR_COPY'
  | 'COMPETITOR_ASSET_REUSE'
  | 'COMPETITOR_UNVERIFIED_FACT_TRANSFER'

export interface CompetitorReferenceFinding {
  code: CompetitorReferenceFindingCode
  severity: 'error'
  field: string
  message: string
  evidence?: string
  remediation: string
  similarity?: number
  limit?: number
  actual?: number
}

export interface CompetitorRemovedSpan {
  source: 'candidate_content' | 'reference_excerpt'
  field: string
  text: string
  reasonCodes: CompetitorReferenceFindingCode[]
}

export interface CompetitorReferenceProvenance {
  complete: boolean
  scope: CompetitorReferenceScope
  url: string
  platform: string
  fetchedAt: string
  accessKind: CompetitorReferenceAccessKind
  accessEvidence: string
  ownerWorkspaceId?: string
}

export interface CompetitorReferencePolicyResult {
  allowed: boolean
  findings: CompetitorReferenceFinding[]
  allowedInsights: { structures: string[]; themes: string[]; trends: string[] }
  removedSpans: CompetitorRemovedSpan[]
  provenance: CompetitorReferenceProvenance
  humanReview: {
    required: boolean
    reasons: CompetitorReferenceFindingCode[]
    instruction: string
  }
  thresholds: CompetitorReferencePolicyThresholds
}

export const DEFAULT_COMPETITOR_REFERENCE_THRESHOLDS: CompetitorReferencePolicyThresholds = {
  maxShortQuoteUnits: 25,
  nearCopySimilarity: 0.72,
  minComparableUnits: 8,
}

const commonPublicPhrases = new Set([
  '立即购买', '马上购买', '了解更多', '限时优惠', '品质生活', '值得信赖', '轻松出行',
  'shop now', 'buy now', 'learn more', 'free shipping', 'limited time offer', 'quality you can trust',
])

const conceptAliases: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['简约', ['极简', '简约', 'minimal', 'minimalist']],
  ['布局', ['布局', '版式', '排版', 'layout', 'composition']],
  ['强调', ['突出', '强调', '凸显', 'highlight', 'highlights', 'highlighted', 'emphasize', 'emphasizes', 'emphasized', 'emphasise', 'emphasises', 'emphasised']],
  ['核心利益', ['核心卖点', '主要卖点', '主要利益点', '核心利益点', 'key benefit', 'core benefit', 'main selling point']],
  ['真实场景', ['真实场景', '实际使用场景', '真实使用环境', 'real scenario', 'real-life setting', 'real use case']],
  ['可信', ['可信感', '可靠感', '信任感', '可信', '可靠', 'credibility', 'credible', 'reliability', 'reliable', 'trust', 'trustworthy']],
  ['建立', ['建立', '营造', '塑造', 'build', 'builds', 'built', 'create', 'creates', 'created', 'establish', 'establishes', 'established']],
  ['轻量', ['轻便', '轻盈', '轻量', 'lightweight']],
  ['快速', ['快速', '迅速', '快捷', 'fast', 'quick', 'rapid']],
]

interface CandidateSpan {
  field: string
  text: string
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function aliasPattern(alias: string) {
  const normalized = alias.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\p{Cf}/gu, '')
  const units = normalized.match(/[\p{Letter}\p{Number}]+/gu) ?? []
  if (!units.length) return undefined
  const separator = '[\\s\\p{P}\\p{S}]*'
  const latin = units.every(unit => /^[a-z0-9]+$/iu.test(unit))
  const body = latin
    ? units.map(escapeRegExp).join(separator)
    : [...units.join('')].map(escapeRegExp).join(separator)
  return new RegExp(latin ? `(?<![a-z0-9])${body}(?![a-z0-9])` : body, 'giu')
}

function canonicalize(value: string) {
  // Remove format controls before tokenization. Turning a zero-width control
  // into a space would let an attacker split every Han bigram into one-char
  // tokens and bypass similarity checks.
  let normalized = value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\p{Cf}/gu, '')
  for (const [canonical, aliases] of conceptAliases) {
    for (const alias of [...aliases].sort((left, right) => right.length - left.length)) {
      const pattern = aliasPattern(alias)
      if (pattern) normalized = normalized.replace(pattern, canonical)
    }
  }
  normalized = normalized
    .replace(/\b(?:a|an|the|and|or|to|of|in|on|at|with|through|by|for|from|this|that|use|using|uses)\b/giu, ' ')
    .replace(/(?:并且|并以|并|以及|通过|采用|使用|以此|从而|进行)/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return normalized
}

function literalCanonicalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{Letter}\p{Number}]+/gu, '')
}

function quoteUnits(value: string) {
  const canonical = value.normalize('NFKC')
  const han = canonical.match(/\p{Script=Han}/gu)?.length ?? 0
  const words = canonical.replace(/\p{Script=Han}/gu, ' ').match(/[\p{Letter}\p{Number}]+/gu)?.length ?? 0
  return han + words
}

function tokenSet(value: string) {
  const canonical = canonicalize(value)
  const tokens = new Set(canonical.match(/[a-z0-9]+/giu) ?? [])
  const hanRuns = canonical.match(/\p{Script=Han}+/gu) ?? []
  for (const run of hanRuns) {
    if (run.length === 1) tokens.add(run)
    else for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return tokens
}

function dice(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return (2 * intersection) / (left.size + right.size)
}

function similarity(left: string, right: string) {
  const a = canonicalize(left)
  const b = canonicalize(right)
  if (!a || !b) return 0
  if (a === b) return 1
  const compactA = a.replace(/\s+/gu, '')
  const compactB = b.replace(/\s+/gu, '')
  if (compactA.includes(compactB) || compactB.includes(compactA)) return Math.min(compactA.length, compactB.length) / Math.max(compactA.length, compactB.length)
  return dice(tokenSet(a), tokenSet(b))
}

function isCommonPhrase(value: string) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\p{Cf}/gu, '').replace(/[^\p{Letter}\p{Number}]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return commonPublicPhrases.has(normalized)
}

function comparable(value: string, thresholds: CompetitorReferencePolicyThresholds) {
  return !isCommonPhrase(value) && quoteUnits(value) >= thresholds.minComparableUnits
}

function candidateSpans(candidate: CompetitorCandidateContent) {
  const result: CandidateSpan[] = []
  const add = (field: string, text: string | undefined) => {
    const trimmed = text?.trim()
    if (trimmed) result.push({ field, text: trimmed })
  }
  add('candidate.title', candidate.title)
  const body = candidate.body?.trim() ?? ''
  const bodySentences = body.split(/(?<=[。！？.!?；;])\s*/u).map(sentence => sentence.trim()).filter(Boolean)
  for (const [index, sentence] of bodySentences.entries()) add(`candidate.body[${index}]`, sentence)
  // Compare the aggregate after individual sentences. Otherwise a copied
  // sentence can be split into sub-threshold fragments; ordering it last also
  // avoids duplicate aggregate findings when one sentence already matched.
  if (bodySentences.length > 1) add('candidate.body', body)
  for (const [index, point] of (candidate.sellingPoints ?? []).entries()) add(`candidate.sellingPoints[${index}]`, point)
  for (const [index, claim] of (candidate.claims ?? []).entries()) add(`candidate.claims[${index}]`, claim.text)
  return result
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function validHttpUrl(value: string) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}

export function evaluateCompetitorReferencePolicy(input: CompetitorReferencePolicyInput): CompetitorReferencePolicyResult {
  const thresholds = { ...DEFAULT_COMPETITOR_REFERENCE_THRESHOLDS, ...(input.thresholds ?? {}) }
  if (!Number.isInteger(thresholds.maxShortQuoteUnits) || thresholds.maxShortQuoteUnits < 1 || thresholds.maxShortQuoteUnits > 100) throw new RangeError('COMPETITOR_QUOTE_LIMIT_INVALID')
  if (!Number.isFinite(thresholds.nearCopySimilarity) || thresholds.nearCopySimilarity < 0.5 || thresholds.nearCopySimilarity > 1) throw new RangeError('COMPETITOR_SIMILARITY_THRESHOLD_INVALID')
  if (!Number.isInteger(thresholds.minComparableUnits) || thresholds.minComparableUnits < 3 || thresholds.minComparableUnits > thresholds.maxShortQuoteUnits) throw new RangeError('COMPETITOR_MIN_COMPARABLE_UNITS_INVALID')

  const findings: CompetitorReferenceFinding[] = []
  const removed = new Map<string, CompetitorRemovedSpan>()
  const addFinding = (finding: CompetitorReferenceFinding) => findings.push(finding)
  const removeSpan = (span: Omit<CompetitorRemovedSpan, 'reasonCodes'>, reason: CompetitorReferenceFindingCode) => {
    const key = `${span.source}:${span.field}:${span.text}`
    const current = removed.get(key)
    if (current) current.reasonCodes = [...new Set([...current.reasonCodes, reason])]
    else removed.set(key, { ...span, reasonCodes: [reason] })
  }

  const scopeComplete = Boolean(input.scope.workspaceId.trim() && input.scope.brandId.trim() && input.scope.productId.trim())
  if (!scopeComplete) addFinding({ code: 'COMPETITOR_SCOPE_REQUIRED', severity: 'error', field: 'scope', message: '竞品参考必须绑定 workspace、brand 和 product 范围。', remediation: '补齐当前任务的稳定范围标识后重新检查。' })
  const url = input.reference.url.trim()
  if (!url) addFinding({ code: 'COMPETITOR_SOURCE_URL_REQUIRED', severity: 'error', field: 'reference.url', message: '竞品参考缺少来源 URL。', remediation: '提供可审计的原始来源 URL。' })
  else if (!validHttpUrl(url)) addFinding({ code: 'COMPETITOR_SOURCE_URL_INVALID', severity: 'error', field: 'reference.url', message: '竞品参考 URL 不是有效 HTTP(S) 地址。', evidence: url, remediation: '提供有效且可审计的 HTTP(S) 来源。' })
  if (!input.reference.platform.trim()) addFinding({ code: 'COMPETITOR_PLATFORM_REQUIRED', severity: 'error', field: 'reference.platform', message: '竞品参考缺少来源平台。', remediation: '记录网页、平台或资料库名称。' })
  const fetchedAt = input.reference.fetchedAt.trim()
  if (!fetchedAt) addFinding({ code: 'COMPETITOR_FETCH_TIME_REQUIRED', severity: 'error', field: 'reference.fetchedAt', message: '竞品参考缺少抓取时间。', remediation: '记录带时区的 ISO 8601 抓取时间。' })
  else if (!Number.isFinite(Date.parse(fetchedAt))) addFinding({ code: 'COMPETITOR_FETCH_TIME_INVALID', severity: 'error', field: 'reference.fetchedAt', message: '竞品参考抓取时间无效。', evidence: fetchedAt, remediation: '使用有效的 ISO 8601 时间。' })
  if (!input.reference.access.evidence.trim()) addFinding({ code: 'COMPETITOR_ACCESS_EVIDENCE_REQUIRED', severity: 'error', field: 'reference.access.evidence', message: '缺少公开来源或授权使用证据。', remediation: '附上公开可访问证明或有效授权记录。' })
  const crossTenantPrivate = input.reference.access.kind === 'private' && input.reference.access.ownerWorkspaceId !== input.scope.workspaceId
  if (crossTenantPrivate) addFinding({ code: 'COMPETITOR_CROSS_TENANT_PRIVATE_SOURCE', severity: 'error', field: 'reference.access.ownerWorkspaceId', message: '不能使用其他工作区的私有竞品素材。', remediation: '移除该来源，并改用当前工作区获授权或公开的参考资料。' })

  const spans = candidateSpans(input.candidate)
  for (const [sourceIndex, source] of (input.extracted.originalSpans ?? []).entries()) {
    const units = quoteUnits(source.text)
    if (units > thresholds.maxShortQuoteUnits) {
      addFinding({ code: 'COMPETITOR_QUOTE_LIMIT_EXCEEDED', severity: 'error', field: `extracted.originalSpans[${sourceIndex}]`, message: '保留的竞品原文超过短引用限额。', evidence: source.text, actual: units, limit: thresholds.maxShortQuoteUnits, remediation: '删除长原文，仅保留不超过限额且有来源的必要短引用。' })
      removeSpan({ source: 'reference_excerpt', field: `extracted.originalSpans[${sourceIndex}]`, text: source.text }, 'COMPETITOR_QUOTE_LIMIT_EXCEEDED')
    }
    if (!comparable(source.text, thresholds)) continue
    let matchedBodyFragment = false
    for (const candidate of spans) {
      if (candidate.field === 'candidate.body' && matchedBodyFragment) continue
      if (!comparable(candidate.text, thresholds)) continue
      const score = similarity(source.text, candidate.text)
      const sourceCanonical = literalCanonicalize(source.text)
      const candidateCanonical = literalCanonicalize(candidate.text)
      const verbatim = sourceCanonical.length > 0 && candidateCanonical.includes(sourceCanonical)
      if (!verbatim && score < thresholds.nearCopySimilarity) continue
      const code = verbatim ? 'COMPETITOR_VERBATIM_COPY' as const : 'COMPETITOR_NEAR_COPY' as const
      addFinding({ code, severity: 'error', field: candidate.field, message: verbatim ? '候选内容包含竞品逐字复制。' : '候选内容与竞品原文构成近似复制。', evidence: candidate.text, similarity: Number(score.toFixed(4)), remediation: '删除该段并仅使用抽象结构重新独立创作。' })
      removeSpan({ source: 'candidate_content', field: candidate.field.replace(/^candidate\./u, ''), text: candidate.text }, code)
      if (/^candidate\.body\[\d+\]$/u.test(candidate.field)) matchedBodyFragment = true
    }
  }

  const sourceFacts = (input.extracted.sellingPoints ?? []).map(item => typeof item === 'string' ? item : item.text).map(text => text.trim()).filter(Boolean)
  for (const fact of sourceFacts) {
    const matchingClaims = (input.candidate.claims ?? []).map((claim, index) => ({ claim, index, score: similarity(fact, claim.text) })).filter(item => canonicalize(item.claim.text).includes(canonicalize(fact)) || item.score >= 0.68)
    const independentlyProven = matchingClaims.some(item => uniqueStrings(item.claim.targetEvidenceIds ?? []).length > 0)
    if (independentlyProven) continue
    const matchingSpan = spans.find(span => {
      const factCanonical = canonicalize(fact)
      const spanCanonical = canonicalize(span.text)
      return Boolean(factCanonical && (spanCanonical.includes(factCanonical) || similarity(fact, span.text) >= 0.68))
    })
    if (!matchingSpan) continue
    const explicit = matchingClaims[0]
    const field = explicit ? `candidate.claims[${explicit.index}]` : matchingSpan.field
    const evidence = explicit?.claim.text ?? matchingSpan.text
    addFinding({ code: 'COMPETITOR_UNVERIFIED_FACT_TRANSFER', severity: 'error', field, message: '候选内容迁移了竞品事实，但没有当前商品的独立证据。', evidence, remediation: '删除该事实，或绑定当前商品经确认的事实来源。' })
    removeSpan({ source: 'candidate_content', field: field.replace(/^candidate\./u, ''), text: evidence }, 'COMPETITOR_UNVERIFIED_FACT_TRANSFER')
  }

  const sourceAssets = new Map((input.extracted.assets ?? []).map(asset => [asset.id, asset]))
  for (const [index, use] of (input.candidate.assetUses ?? []).entries()) {
    const sourceAsset = sourceAssets.get(use.sourceAssetId)
    if (!sourceAsset) continue
    addFinding({ code: 'COMPETITOR_ASSET_REUSE', severity: 'error', field: `candidate.assetUses[${index}]`, message: `候选内容试图挪用竞品的${sourceAsset.kind}资产。`, evidence: sourceAsset.description ?? sourceAsset.id, remediation: '删除竞品 Logo、商标、人物或图片，只使用当前工作区已授权资产。' })
    removeSpan({ source: 'candidate_content', field: `assetUses[${index}]`, text: sourceAsset.description ?? sourceAsset.id }, 'COMPETITOR_ASSET_REUSE')
  }

  const provenanceComplete = scopeComplete
    && Boolean(url && validHttpUrl(url) && input.reference.platform.trim() && fetchedAt && Number.isFinite(Date.parse(fetchedAt)) && input.reference.access.evidence.trim())
    && !crossTenantPrivate
  const unsafeInsightSources = [...(input.extracted.originalSpans ?? []).map(item => item.text), ...sourceFacts]
  const safeInsight = (value: string) => !unsafeInsightSources.some(source => comparable(source, thresholds) && similarity(source, value) >= thresholds.nearCopySimilarity)
  const allowedInsights = provenanceComplete ? {
    structures: uniqueStrings(input.extracted.structures ?? []).filter(safeInsight),
    themes: uniqueStrings(input.extracted.themes ?? []).filter(safeInsight),
    trends: uniqueStrings(input.extracted.trends ?? []).filter(safeInsight),
  } : { structures: [], themes: [], trends: [] }
  const reasonCodes = [...new Set(findings.map(finding => finding.code))]
  const provenance: CompetitorReferenceProvenance = {
    complete: provenanceComplete,
    scope: { ...input.scope },
    url,
    platform: input.reference.platform.trim(),
    fetchedAt,
    accessKind: input.reference.access.kind,
    accessEvidence: input.reference.access.evidence.trim(),
    ...(input.reference.access.ownerWorkspaceId ? { ownerWorkspaceId: input.reference.access.ownerWorkspaceId } : {}),
  }
  return {
    allowed: findings.length === 0,
    findings,
    allowedInsights,
    removedSpans: [...removed.values()],
    provenance,
    humanReview: {
      required: findings.length > 0,
      reasons: reasonCodes,
      instruction: findings.length ? '先剔除标记片段、补齐来源或目标商品证据，再由人工复核。' : '无需额外人工复核；仍须保留 provenance 并仅使用允许的抽象 insights。',
    },
    thresholds,
  }
}

export class CompetitorReferencePolicyError extends Error {
  readonly code = 'COMPETITOR_REFERENCE_POLICY_BLOCKED'
  constructor(readonly report: CompetitorReferencePolicyResult) {
    super('竞品参考未通过合规与防抄袭门禁')
    this.name = 'CompetitorReferencePolicyError'
  }
}

export function assertCompetitorReferencePolicy(input: CompetitorReferencePolicyInput) {
  const report = evaluateCompetitorReferencePolicy(input)
  if (!report.allowed) throw new CompetitorReferencePolicyError(report)
  return report
}
