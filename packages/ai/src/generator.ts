import { createHash } from 'node:crypto'
import { assertUsageSinkConfiguredBeforeDispatch, emitRelayUsage, relayUsageReceiptKey, type RelayUsageContext, type RelayUsageSink } from './relay-usage.js'
import { inspectOutboundUrl } from '../../connectors/src/outbound-security.js'
import { assertRelayBaseUrl, assertRelayUrl, relaySecurityFromEnv, type RelaySecurityPolicy } from './relay-security.js'
import { readBoundedResponseText } from '../../connectors/src/bounded-response.js'
import { assertProviderResponseAccepted, providerIdempotencyKey, resolveProviderTimeoutMs, rethrowProviderTransportFailure, throwProviderOutcomeUnknown, withProviderRequestRetry, type ProviderBeforeRequest } from './provider-request.js'
import { isPlaceholderModelConfiguration } from './platform-model-gate.js'

export interface ContentGenerationInput {
  platform: string
  /** Unbound preview: creative copy only, with no fact-backed detail modules. */
  candidateOnly?: boolean
  product: {
    id?: string
    title: string
    category?: string
    price?: number
    stock: number
    skuCount: number
    /** Frozen merchant-confirmed SKU scope. Providers may only cite these IDs. */
    skuIds?: string[]
    attributes?: Record<string, string>
  }
  directionId: string
  /** Immutable product fact versions that the provider may cite. */
  confirmedFactSourceIds?: string[]
  /** Frozen, merchant-confirmed visual constraints; providers must treat them as non-negotiable. */
  brandVisualRules?: {
    logo?: { assetIds: string[]; allowRecolor: boolean; allowDistortion: boolean; allowRedraw: boolean; clearSpace?: string }
    colors?: { primary: string[]; secondary: string[]; forbidden: string[] }
    fonts?: Array<{ family: string; assetId?: string; licenseStatus: 'approved' | 'restricted' | 'unknown' }>
    styleKeywords?: string[]
    restrictedSubjects?: { people: string[]; spokespersons: string[]; intellectualProperties: string[]; prohibitedContent: string[] }
  }
  referenceAssets?: Array<{ id: string; revision: number; preference?: { verdict: 'excellent' | 'disliked'; reasons: string[]; note?: string } }>
  promotions?: Array<{ kind: string; label: string; skuIds: string[]; validFrom?: string; validTo?: string; originalPriceCny?: number; priceCny?: number; couponPriceCny?: number; depositCny?: number; balanceCny?: number; giftDescription?: string; giftValueCny?: number }>
  knowledgeContext?: {
    rules: Array<{ id: string; content: string; version: string; sourceReference: string; effectiveFrom?: string; effectiveTo?: string }>
    /** Approved, product-scoped facts frozen before generation; never silently omit these. */
    documents?: Array<{ id: string; title: string; content: string; revision: number }>
    assets: Array<{ id: string; kind: 'brand' | 'customer'; name: string; content: string | Record<string, unknown>; revision: number; confirmed: false }>
    confirmedLearningSuggestions: Array<{ id: string; summary: string; proposedRule: { content: string; scope: string; version: string } }>
    competitorReferences?: Array<{ competitorAnalysisId: string; structuralObservations: string[]; expressionObservations: string[]; differentiationAngles: string[]; safeExpressionGuidance: string[]; compliance: { originalTextCopied: false; competitorBrandReused: false } }>
  }
  usageContext?: RelayUsageContext
  /** Charged actions keep one settled provider receipt until multi-receipt billing is supported. */
  allowSchemaRepair?: boolean
  /** Legacy read-only fence; it does not replace a durable provider claim. */
  beforeProviderRequest?: (proof: { workspaceId?: string; actionId?: string; model: string; attempt: number; providerAttemptKey: string; requestBodySha256: string }) => Promise<void>
  /** Runtime-only durable knowledge claim, created once for each physical provider request. */
  claimProviderAttempt?: (proof: {
    workspaceId?: string
    actionId?: string
    model: string
    attempt: number
    transportAttempt: number
    providerAttemptKey: string
    requestBodySha256: string
  }) => Promise<unknown>
  /** CAS the claim to provider_started immediately before each outbound request. */
  startProviderAttempt?: (proof: { attempt: number; transportAttempt: number; providerAttemptKey: string; requestBodySha256: string }, claim: unknown) => Promise<void>
  markProviderAttemptUnknown?: (proof: { attempt: number; transportAttempt: number; providerAttemptKey: string; requestBodySha256: string }, claim: unknown, providerRequestId?: string) => Promise<void>
  /** Usage evidence has been durably recorded for this physical response. */
  recordProviderResponse?: (proof: { attempt: number; transportAttempt: number; providerAttemptKey: string; requestBodySha256: string }, claim: unknown, providerRequestId: string) => Promise<void>
  /** A recorded response failed schema validation and authorizes one repair attempt. */
  markProviderRepairRequired?: (proof: { attempt: number; transportAttempt: number; providerAttemptKey: string; requestBodySha256: string }, claim: unknown) => Promise<void>
  /** Close only conclusive attempts; ambiguous outcomes intentionally keep claims active. */
  settleProviderAttempt?: (proof: { attempt: number; transportAttempt: number; providerAttemptKey: string; requestBodySha256: string }, claim: unknown, outcome: 'completed' | 'rejected') => Promise<void>
}

export interface GeneratedContent {
  title: string
  detail: string
  sellingPoints: string[]
  modules?: ContentModule[]
  brief?: StaticBrief
}

export interface ContentModule {
  key: string
  title: string
  purpose: string
  body: string
  factSourceIds: string[]
  /** Explicitly separates verified facts, creative suggestions and missing inputs. */
  contentKind?: 'fact' | 'creative' | 'pending'
  pendingReason?: string
  /** SKU IDs explicitly used by this module; used for deterministic mapping checks. */
  referencedSkuIds?: string[]
  imageGuidance?: string
  /** Buyer-decision and proof contract for newly generated detail-page modules. */
  decisionContract?: DetailPageDecisionContract
}

export type DetailPageEvidenceType = 'real_image' | 'parameter' | 'test_report' | 'comparison' | 'usage_result' | 'manual_review'
export type DetailPageEvidenceStatus = 'verified' | 'missing' | 'expired' | 'conflict'

export interface DetailPageDecisionContract {
  buyerQuestion: string
  pageTask: string
  claim: {
    text: string
    factSourceIds: string[]
    skuIds?: string[]
    platforms: string[]
    regions?: string[]
    validUntil?: string
    limitations: string[]
  }
  evidence: {
    type: DetailPageEvidenceType
    sourceIds: string[]
    status: DetailPageEvidenceStatus
  }
  visualContract: {
    requiredElements: string[]
    protectedElements: string[]
    prohibitedImplications: string[]
    accessibilityText: string
  }
  priority: number
  optional: boolean
}

export interface StaticBrief {
  platform: string
  placement: string
  targetDimensions: string
  visualHierarchy: string[]
  productImageGuidance: string
  logoSafety: string
  headline: string
  subheadline: string
  coreSellingPoint: string
  priceExpression?: string
  cta: string
  textDensity: string
  safeArea: string
  protectedAreas: string[]
}

export interface ContentGenerator {
  generate(input: ContentGenerationInput, options?: { signal?: AbortSignal }): Promise<GeneratedContent>
}

export interface OpenAICompatibleGeneratorOptions {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
  fetch?: typeof fetch
  beforeRequest?: ProviderBeforeRequest
  usageSink?: RelayUsageSink
  relaySecurity?: RelaySecurityPolicy
  maxInputTokens?: number
  maxOutputTokens?: number
  /** Maximum output tokens reserved across the initial call and repairs. */
  maxTotalOutputTokens?: number
  /** Relay-supported switch for reasoning models used for strict JSON tasks. */
  disableThinking?: boolean
}

const MAX_TEXT_RELAY_RESPONSE_BYTES = 4 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readContent(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined
  const choice = payload.choices[0]
  if (!isRecord(choice) || !isRecord(choice.message)) return undefined
  const content = choice.message.content
  if (typeof content !== 'string') return content
  try { return JSON.parse(content) } catch {
    // A few OpenAI-compatible relays wrap otherwise valid JSON in one
    // Markdown code fence even when json_object was requested. Accept only a
    // fence that covers the entire response; never extract JSON from prose.
    const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu.exec(content.trim())
    if (!fenced?.[1]) return undefined
    try { return JSON.parse(fenced[1].trim()) } catch { return undefined }
  }
}

function normalizeProviderStructure(value: unknown, input: ContentGenerationInput): unknown {
  if (!isRecord(value)) return value
  // Never manufacture module provenance by copying every frozen product source.
  // A source must be selected for the specific module by the provider; an empty
  // list must reach schema validation and fail closed.
  const modules = value.modules
  if (!isRecord(value.brief)) return modules === value.modules ? value : { ...value, modules }
  const brief = { ...value.brief }
  if (brief.targetDimensions === undefined || brief.targetDimensions === '') brief.targetDimensions = '按目标平台版位规范配置，未配置时由设计确认'
  if (Array.isArray(brief.visualHierarchy) && brief.visualHierarchy.length === 0) brief.visualHierarchy = ['商品主体', '标题', '核心卖点']
  if (Array.isArray(brief.protectedAreas) && brief.protectedAreas.length === 0) brief.protectedAreas = ['商品主体', 'Logo（如有）', '包装文字与认证标识（如有）']
  return { ...value, ...(modules !== undefined ? { modules } : {}), brief }
}

/** Validate without repairing or silently dropping fields. This is the trust boundary for model/Codex output. */
export function validateContentSchema(value: unknown, source = 'content', options: { requireDecisionContracts?: boolean; candidateOnly?: boolean } = {}): GeneratedContent {
  const errors: string[] = []
  const requiredText = (record: Record<string, unknown>, key: string, errorPath = key) => {
    if (typeof record[key] !== 'string' || !(record[key] as string).trim()) errors.push(`${errorPath} 必须是非空字符串`)
    return typeof record[key] === 'string' ? (record[key] as string).trim() : ''
  }
  if (!isRecord(value)) throw new Error(`CONTENT_SCHEMA_INVALID: ${source} 必须是 JSON 对象`)
  const title = requiredText(value, 'title')
  const detail = requiredText(value, 'detail')
  if (options.candidateOnly) {
    for (const key of Object.keys(value)) if (!['title', 'detail', 'sellingPoints', 'brief'].includes(key)) errors.push(`未绑定候选不得包含 ${key}`)
    if (isRecord(value.brief) && value.brief.priceExpression !== undefined) errors.push('未绑定候选不得包含价格表达')
  }
  if (!Array.isArray(value.sellingPoints) || value.sellingPoints.length === 0) errors.push('sellingPoints 必须是非空字符串数组')
  else value.sellingPoints.forEach((item, index) => { if (typeof item !== 'string' || !item.trim()) errors.push(`sellingPoints[${index}] 必须是非空字符串`) })

  let modules: ContentModule[] | undefined
  if (options.candidateOnly && value.modules !== undefined) errors.push('未绑定候选不得包含事实模块')
  if (options.candidateOnly && value.brief === undefined) errors.push('未绑定候选 brief 必须是对象')
  if (options.requireDecisionContracts === true && value.modules === undefined) {
    errors.push('modules 必须是非空数组')
  }
  if (value.modules !== undefined) {
    if (!Array.isArray(value.modules) || value.modules.length === 0) errors.push('modules 必须是非空数组')
    else {
      modules = value.modules.map((raw, index): ContentModule | undefined => {
        if (!isRecord(raw)) { errors.push(`modules[${index}] 必须是对象`); return undefined }
        const key = requiredText(raw, 'key', `modules[${index}].key`)
        const moduleTitle = requiredText(raw, 'title', `modules[${index}].title`)
        const purpose = requiredText(raw, 'purpose', `modules[${index}].purpose`)
        const body = requiredText(raw, 'body', `modules[${index}].body`)
        const sourceIds = raw.factSourceIds
        if (!Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.some(item => typeof item !== 'string' || !item.trim())) errors.push(`modules[${index}].factSourceIds 必须是非空字符串数组`)
        const factSourceIds = Array.isArray(sourceIds) ? sourceIds.filter((item): item is string => typeof item === 'string').map(item => item.trim()) : []
        const contentKind = raw.contentKind
        if (!['fact', 'creative', 'pending'].includes(String(contentKind))) errors.push(`modules[${index}].contentKind 必须是 fact、creative 或 pending`)
        const normalizedContentKind: NonNullable<ContentModule['contentKind']> | undefined = contentKind === 'fact' || contentKind === 'creative' || contentKind === 'pending' ? contentKind : undefined
        if (contentKind === 'pending' && (typeof raw.pendingReason !== 'string' || !raw.pendingReason.trim())) errors.push(`modules[${index}].pendingReason 必须是非空字符串`)
        const referenced = raw.referencedSkuIds
        if (referenced !== undefined && (!Array.isArray(referenced) || referenced.some(item => typeof item !== 'string' || !item.trim()))) errors.push(`modules[${index}].referencedSkuIds 必须是字符串数组`)
        if (raw.imageGuidance !== undefined && (typeof raw.imageGuidance !== 'string' || !raw.imageGuidance.trim())) errors.push(`modules[${index}].imageGuidance 必须是非空字符串`)
        const decisionContract = validateDecisionContract(raw.decisionContract, index, errors, options.requireDecisionContracts === true)
        if (decisionContract && decisionContract.claim.factSourceIds.some(sourceId => !factSourceIds.includes(sourceId))) errors.push(`modules[${index}].decisionContract.claim.factSourceIds 必须属于模块 factSourceIds`)
        if (decisionContract?.claim.skuIds?.length && !Array.isArray(referenced)) errors.push(`modules[${index}].referencedSkuIds 在 claim.skuIds 存在时不能为空`)
        else if (decisionContract?.claim.skuIds && Array.isArray(referenced) && decisionContract.claim.skuIds.some(skuId => !referenced.includes(skuId))) errors.push(`modules[${index}].decisionContract.claim.skuIds 必须属于 referencedSkuIds`)
        if (decisionContract?.evidence.status === 'verified' && decisionContract.evidence.sourceIds.some(sourceId => !decisionContract.claim.factSourceIds.includes(sourceId))) errors.push(`modules[${index}].decisionContract.evidence.sourceIds 必须属于 claim.factSourceIds`)
        return normalizedContentKind ? { key, title: moduleTitle, purpose, body, factSourceIds, contentKind: normalizedContentKind, ...(typeof raw.pendingReason === 'string' && raw.pendingReason.trim() ? { pendingReason: raw.pendingReason.trim() } : {}), ...(Array.isArray(referenced) && referenced.length ? { referencedSkuIds: referenced.filter((item): item is string => typeof item === 'string').map(item => item.trim()) } : {}), ...(typeof raw.imageGuidance === 'string' && raw.imageGuidance.trim() ? { imageGuidance: raw.imageGuidance.trim() } : {}), ...(decisionContract ? { decisionContract } : {}) } : undefined
      }).filter((item): item is ContentModule => Boolean(item))
    }
  }

  let brief: StaticBrief | undefined
  if (value.brief !== undefined) {
    if (!isRecord(value.brief)) errors.push('brief 必须是对象')
    else {
      const raw = value.brief
      const textKeys = ['platform', 'placement', 'targetDimensions', 'productImageGuidance', 'logoSafety', 'headline', 'subheadline', 'coreSellingPoint', 'cta', 'textDensity', 'safeArea'] as const
      const text: Record<string, string> = {}
      textKeys.forEach(key => { text[key] = requiredText(raw, key, `brief.${key}`) })
      const list = (key: 'visualHierarchy' | 'protectedAreas') => {
        const value = raw[key]
        if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) errors.push(`brief.${key} 必须是非空字符串数组`)
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()) : []
      }
      const visualHierarchy = list('visualHierarchy'); const protectedAreas = list('protectedAreas')
      if (raw.priceExpression !== undefined && (typeof raw.priceExpression !== 'string' || !raw.priceExpression.trim())) errors.push('brief.priceExpression 必须是非空字符串')
      brief = { ...text, visualHierarchy, protectedAreas, ...(typeof raw.priceExpression === 'string' && raw.priceExpression.trim() ? { priceExpression: raw.priceExpression.trim() } : {}) } as StaticBrief
    }
  }
  if (errors.length) throw new Error(`CONTENT_SCHEMA_INVALID: ${source} 结构化内容校验失败：${errors.join('；')}`)
  return { title, detail, sellingPoints: (value.sellingPoints as string[]).map(item => item.trim()), ...(modules ? { modules } : {}), ...(brief ? { brief } : {}) }
}

function stringList(record: Record<string, unknown>, key: string, path: string, errors: string[], options: { allowEmpty?: boolean } = {}) {
  const value = record[key]
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0) || value.some(item => typeof item !== 'string' || !item.trim())) errors.push(`${path} 必须是${options.allowEmpty ? '' : '非空'}字符串数组`)
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim()) : []
}

function validateDecisionContract(value: unknown, index: number, errors: string[], required: boolean): DetailPageDecisionContract | undefined {
  const base = `modules[${index}].decisionContract`
  if (value === undefined) {
    if (required) errors.push(`${base} 必须是对象`)
    return undefined
  }
  if (!isRecord(value)) { errors.push(`${base} 必须是对象`); return undefined }
  const text = (record: Record<string, unknown>, key: string, path: string) => {
    if (typeof record[key] !== 'string' || !record[key].trim()) errors.push(`${path} 必须是非空字符串`)
    return typeof record[key] === 'string' ? record[key].trim() : ''
  }
  const buyerQuestion = text(value, 'buyerQuestion', `${base}.buyerQuestion`)
  const pageTask = text(value, 'pageTask', `${base}.pageTask`)
  const rawClaim = value.claim
  const rawEvidence = value.evidence
  const rawVisual = value.visualContract
  if (!isRecord(rawClaim)) errors.push(`${base}.claim 必须是对象`)
  if (!isRecord(rawEvidence)) errors.push(`${base}.evidence 必须是对象`)
  if (!isRecord(rawVisual)) errors.push(`${base}.visualContract 必须是对象`)
  if (!isRecord(rawClaim) || !isRecord(rawEvidence) || !isRecord(rawVisual)) return undefined
  const claimText = text(rawClaim, 'text', `${base}.claim.text`)
  const factSourceIds = stringList(rawClaim, 'factSourceIds', `${base}.claim.factSourceIds`, errors)
  const skuIds = rawClaim.skuIds === undefined ? undefined : stringList(rawClaim, 'skuIds', `${base}.claim.skuIds`, errors, { allowEmpty: true })
  const platforms = stringList(rawClaim, 'platforms', `${base}.claim.platforms`, errors)
  const regions = rawClaim.regions === undefined ? undefined : stringList(rawClaim, 'regions', `${base}.claim.regions`, errors, { allowEmpty: true })
  const limitations = stringList(rawClaim, 'limitations', `${base}.claim.limitations`, errors, { allowEmpty: true })
  const validUntil = rawClaim.validUntil === undefined ? undefined : text(rawClaim, 'validUntil', `${base}.claim.validUntil`)
  if (validUntil && Number.isNaN(Date.parse(validUntil))) errors.push(`${base}.claim.validUntil 必须是有效时间`)
  const evidenceType = rawEvidence.type
  const evidenceStatus = rawEvidence.status
  const evidenceTypes: DetailPageEvidenceType[] = ['real_image', 'parameter', 'test_report', 'comparison', 'usage_result', 'manual_review']
  const evidenceStatuses: DetailPageEvidenceStatus[] = ['verified', 'missing', 'expired', 'conflict']
  if (!evidenceTypes.includes(evidenceType as DetailPageEvidenceType)) errors.push(`${base}.evidence.type 不受支持`)
  if (!evidenceStatuses.includes(evidenceStatus as DetailPageEvidenceStatus)) errors.push(`${base}.evidence.status 不受支持`)
  const evidenceSourceIds = stringList(rawEvidence, 'sourceIds', `${base}.evidence.sourceIds`, errors, { allowEmpty: evidenceStatus !== 'verified' })
  if (evidenceStatus === 'verified' && evidenceSourceIds.length === 0) errors.push(`${base}.evidence.sourceIds 在 verified 时不能为空`)
  const requiredElements = stringList(rawVisual, 'requiredElements', `${base}.visualContract.requiredElements`, errors)
  const protectedElements = stringList(rawVisual, 'protectedElements', `${base}.visualContract.protectedElements`, errors, { allowEmpty: true })
  const prohibitedImplications = stringList(rawVisual, 'prohibitedImplications', `${base}.visualContract.prohibitedImplications`, errors, { allowEmpty: true })
  const accessibilityText = text(rawVisual, 'accessibilityText', `${base}.visualContract.accessibilityText`)
  if (!Number.isInteger(value.priority) || Number(value.priority) < 1 || Number(value.priority) > 100) errors.push(`${base}.priority 必须是 1 至 100 的整数`)
  if (typeof value.optional !== 'boolean') errors.push(`${base}.optional 必须是布尔值`)
  return {
    buyerQuestion, pageTask,
    claim: { text: claimText, factSourceIds, ...(skuIds ? { skuIds } : {}), platforms, ...(regions ? { regions } : {}), ...(validUntil ? { validUntil } : {}), limitations },
    evidence: { type: evidenceType as DetailPageEvidenceType, sourceIds: evidenceSourceIds, status: evidenceStatus as DetailPageEvidenceStatus },
    visualContract: { requiredElements, protectedElements, prohibitedImplications, accessibilityText },
    priority: Number(value.priority), optional: value.optional as boolean,
  }
}

function validateProviderScope(content: GeneratedContent, input: ContentGenerationInput): GeneratedContent {
  const allowedSources = input.confirmedFactSourceIds ? new Set(input.confirmedFactSourceIds) : undefined
  const allowedSkus = input.product.skuIds ? new Set(input.product.skuIds) : undefined
  const errors: string[] = []
  for (const [index, module] of (content.modules ?? []).entries()) {
    const sourceIds = [
      ...module.factSourceIds,
      ...(module.decisionContract?.claim.factSourceIds ?? []),
      ...(module.decisionContract?.evidence.sourceIds ?? []),
    ]
    for (const sourceId of sourceIds) if (allowedSources && !allowedSources.has(sourceId)) errors.push(`modules[${index}] 引用了未确认的事实来源 ${sourceId}`)
    const skuIds = [...(module.referencedSkuIds ?? []), ...(module.decisionContract?.claim.skuIds ?? [])]
    for (const skuId of skuIds) if (allowedSkus && !allowedSkus.has(skuId)) errors.push(`modules[${index}] 引用了未确认的 SKU ${skuId}`)
    if (module.decisionContract && !module.decisionContract.claim.platforms.includes(input.platform)) errors.push(`modules[${index}] 未限定到目标平台 ${input.platform}`)
  }
  if (errors.length) throw new Error(`CONTENT_SCHEMA_INVALID: 模型响应超出冻结事实范围：${[...new Set(errors)].join('；')}`)
  return content
}

function validate(value: unknown, input: ContentGenerationInput): GeneratedContent {
  return validateProviderScope(validateContentSchema(value, '模型响应', input.candidateOnly ? { candidateOnly: true } : { requireDecisionContracts: true }), input)
}

function prompt(input: ContentGenerationInput) {
  const { usageContext: _usageContext, allowSchemaRepair: _allowSchemaRepair, beforeProviderRequest: _beforeProviderRequest, claimProviderAttempt: _claimProviderAttempt, startProviderAttempt: _startProviderAttempt, markProviderAttemptUnknown: _markProviderAttemptUnknown, recordProviderResponse: _recordProviderResponse, markProviderRepairRequired: _markProviderRepairRequired, settleProviderAttempt: _settleProviderAttempt, ...providerInput } = input
  if (input.candidateOnly) return JSON.stringify({
    role: 'commerce-content-candidate',
    outputShape: { title: '非空字符串', detail: '非空字符串', sellingPoints: ['非空字符串'], brief: { platform: '目标 platform', placement: '非空字符串', targetDimensions: '按目标平台版位规范配置，未配置时由设计确认', visualHierarchy: ['非空字符串'], productImageGuidance: '非空字符串', logoSafety: '非空字符串', headline: '非空字符串', subheadline: '非空字符串', coreSellingPoint: '非空字符串', cta: '非空字符串', textDensity: '非空字符串', safeArea: '非空字符串', protectedAreas: ['非空字符串'] } },
    instruction: '仅生成未绑定商品的创意文案预览，返回 JSON 的 title、detail、sellingPoints、brief。不得返回 modules、事实来源、SKU、价格、库存、材质、功能、效果、认证或促销等未经确认的商品事实。product.title 只作为用户提供的主题，不证明商品事实。所有文字应明确属于待确认的创意建议；不得照抄 outputShape 示例字符串。brief 的必填字段都不可为空，未知尺寸使用指定待确认文案。',
    input: providerInput,
  })
  return JSON.stringify({
    role: 'commerce-content-generation',
    outputShape: {
      title: '非空字符串', detail: '非空字符串', sellingPoints: ['非空字符串'],
      modules: [{ key: '非空字符串', title: '非空字符串', purpose: '非空字符串', body: '非空字符串', factSourceIds: ['从 confirmedFactSourceIds 逐字选择的来源 ID'], contentKind: 'fact | creative | pending', decisionContract: { buyerQuestion: '非空字符串', pageTask: '非空字符串', claim: { text: '非空字符串', factSourceIds: ['与模块相同的已确认来源 ID'], platforms: ['目标 platform'], limitations: [] }, evidence: { type: 'parameter | real_image | test_report | comparison | usage_result | manual_review', sourceIds: ['已确认来源 ID，只有 verified 时必填'], status: 'verified | missing | expired | conflict' }, visualContract: { requiredElements: ['非空字符串'], protectedElements: [], prohibitedImplications: [], accessibilityText: '非空字符串' }, priority: 1, optional: false } }],
      brief: { platform: '目标 platform', placement: '非空字符串', targetDimensions: '非空字符串', visualHierarchy: ['非空字符串'], productImageGuidance: '非空字符串', logoSafety: '非空字符串', headline: '非空字符串', subheadline: '非空字符串', coreSellingPoint: '非空字符串', cta: '非空字符串', textDensity: '非空字符串', safeArea: '非空字符串', protectedAreas: ['非空字符串'] },
    },
    outputShapePolicy: 'outputShape 仅描述字段结构，不是商品事实；必须填写真实内容，绝不能照抄示意字符串。没有可引用的 confirmedFactSourceIds 时不要编造来源或生成事实模块。claim.validUntil 仅在已确认事实有有效期时填写。',
    knowledgePolicy: 'knowledgeContext.rules are frozen task rules; knowledgeContext.documents are approved product-scoped facts with frozen revisions, but never invent factSourceIds; knowledgeContext.assets have confirmed=false and are reference-only, never product facts; confirmedLearningSuggestions are suggestions and never bypass rule approval; competitorReferences are structured observations only and must not be copied into product claims or verbatim expression.',
    instruction: '根据商品事实生成合规电商营销内容。不得编造事实，不得使用绝对化或最高级宣传；promotion 只能使用输入中已确认且仍在 validFrom/validTo 内的价格/优惠，必须按 skuIds 限定，不得自行合并不同 SKU 价格。product.id 是商品 ID，绝不是 SKU ID；所有 claim.skuIds 和 referencedSkuIds 只能逐字引用 product.skuIds 中的值，product.skuIds 为空时必须省略 SKU 引用。brandVisualRules 是商家已确认的强约束，必须原样遵守，不得改色、变形、重绘 Logo，不得使用禁用色或未批准字体，也不得出现 restrictedSubjects 中列明的禁用内容、人物、代言人或 IP。referenceAssets 中 excellent 素材及原因只用于风格参考，不得把参考素材内容当作当前商品事实；disliked 素材不得进入参考集合。competitorReferences 只用于差异化结构和表达方向，禁止复制竞品原文、品牌或未经确认的卖点。只返回 JSON：title、detail、sellingPoints、modules、brief。modules 中每项必须包含 key、title、purpose、body、factSourceIds、contentKind 和 decisionContract。每个模块 factSourceIds 及其 decisionContract.claim.factSourceIds 都必须非空且只能引用输入 confirmedFactSourceIds；找不到已确认来源时必须删除整个模块，不得编造 source ID。decisionContract 必须明确 buyerQuestion、pageTask、claim（text、factSourceIds、skuIds、platforms、regions、validUntil、limitations）、evidence（type、sourceIds、status）、visualContract（requiredElements、protectedElements、prohibitedImplications、accessibilityText）、priority、optional。evidence.type 只能是 real_image、parameter、test_report、comparison、usage_result、manual_review 之一；evidence.status 只能是 verified、missing、expired、conflict 之一；verified 证据必须有 sourceIds，缺失、过期或冲突证据不得标记 verified。contentKind=pending 时必须填写 pendingReason；可选 referencedSkuIds 和 imageGuidance；claim.skuIds 非空时，模块 referencedSkuIds 必须存在并逐个包含相同的 SKU ID，不能用一个值代表多个 SKU；没有事实的模块省略。brief 必须包含 platform、placement、targetDimensions、visualHierarchy、productImageGuidance、logoSafety、headline、subheadline、coreSellingPoint、cta、textDensity、safeArea、protectedAreas，所有必填字符串都不得为空；输入未提供精确尺寸时 targetDimensions 必须填写“按目标平台版位规范配置，未配置时由设计确认”；价格没有输入时不要输出 priceExpression。',
    input: providerInput,
  })
}

const REPAIR_MESSAGE_TOKEN_RESERVE = 800
const REPAIR_DIAGNOSTIC_MAX_CHARS = 600
const REPAIR_MAX_OUTPUT_TOKENS = 2_500
export const MAX_CONTENT_INPUT_TOKENS = 4_000
function estimateRequestTokensFromPrompt(promptText: string, additionalMessages: readonly string[] = []) {
  const payload = additionalMessages.length ? { prompt: promptText, additionalMessages } : { prompt: promptText }
  return Math.ceil(Buffer.byteLength(JSON.stringify(payload), 'utf8') / 3) + (additionalMessages.length ? 0 : REPAIR_MESSAGE_TOKEN_RESERVE)
}
export function estimateContentGenerationRequestTokens(input: ContentGenerationInput, additionalMessages: readonly string[] = []) {
  return estimateRequestTokensFromPrompt(prompt(input), additionalMessages)
}

export function resolveTokenBudget(value: unknown, fallback: number, name: 'input' | 'output') {
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value)
  const maximum = name === 'input' ? MAX_CONTENT_INPUT_TOKENS : 1_000_000
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new Error(`TOKEN_BUDGET_INVALID: ${name} token budget 必须是 1 至 ${maximum} 的整数`)
  }
  return candidate
}

export function budgetContentGenerationInput(input: ContentGenerationInput, maxInputTokens = 4_000): ContentGenerationInput {
  maxInputTokens = resolveTokenBudget(maxInputTokens, 4_000, 'input')
  const hardContext: ContentGenerationInput = {
    platform: input.platform,
    ...(input.candidateOnly ? { candidateOnly: true } : {}),
    product: input.product,
    directionId: input.directionId,
    ...(input.confirmedFactSourceIds?.length ? { confirmedFactSourceIds: input.confirmedFactSourceIds } : {}),
    ...(input.brandVisualRules ? { brandVisualRules: input.brandVisualRules } : {}),
    ...(input.promotions ? { promotions: input.promotions } : {}),
    ...(input.knowledgeContext ? { knowledgeContext: { rules: input.knowledgeContext.rules, ...(input.knowledgeContext.documents?.length ? { documents: input.knowledgeContext.documents } : {}), assets: [], confirmedLearningSuggestions: [] } } : {}),
    ...(input.usageContext ? { usageContext: input.usageContext } : {}),
  }
  if (estimateContentGenerationRequestTokens(hardContext) > maxInputTokens) throw new Error(`CONTEXT_BUDGET_EXCEEDED: 固定指令、商品硬事实、已审核知识文档和适用规则超过 ${maxInputTokens} 输入 Token 预算`)

  const bounded: ContentGenerationInput = structuredClone(hardContext)
  const addIfFits = (mutate: () => void, rollback: () => void) => { mutate(); if (estimateContentGenerationRequestTokens(bounded) > maxInputTokens) rollback() }
  if (input.referenceAssets?.length) addIfFits(() => { bounded.referenceAssets = input.referenceAssets!.slice(0, 50) }, () => { delete bounded.referenceAssets })
  if (input.knowledgeContext) {
    const context = bounded.knowledgeContext!
    for (const asset of input.knowledgeContext.assets.slice(0, 20)) {
      const compact = { ...asset, content: typeof asset.content === 'string' ? asset.content.slice(0, 800) : Object.fromEntries(Object.entries(asset.content).slice(0, 30)) }
      addIfFits(() => { context.assets.push(compact) }, () => { context.assets.pop() })
    }
    for (const suggestion of input.knowledgeContext.confirmedLearningSuggestions.slice(0, 20)) addIfFits(() => { context.confirmedLearningSuggestions.push(suggestion) }, () => { context.confirmedLearningSuggestions.pop() })
    if (input.knowledgeContext.competitorReferences?.length) addIfFits(() => { context.competitorReferences = input.knowledgeContext!.competitorReferences!.slice(0, 5) }, () => { delete context.competitorReferences })
  }
  budgetedInputBudgets.set(bounded, maxInputTokens)
  return bounded
}

// The application service freezes and budgets the exact envelope before it is
// persisted. Keep that work reusable when the OpenAI-compatible adapter is the
// next consumer; the WeakMap does not retain request data after the envelope is
// unreachable and the budget remains part of the cache key.
const budgetedInputBudgets = new WeakMap<object, number>()

function reuseBudgetedInput(input: ContentGenerationInput, maxInputTokens: number): ContentGenerationInput {
  return budgetedInputBudgets.get(input) === maxInputTokens ? input : budgetContentGenerationInput(input, maxInputTokens)
}

export class OpenAICompatibleContentGenerator implements ContentGenerator {
  private readonly fetchImpl: typeof fetch
  constructor(private readonly options: OpenAICompatibleGeneratorOptions) {
    if (!options.baseUrl.trim() || !options.apiKey.trim() || !options.model.trim()) throw new Error('AI base URL, API key and model are required')
    assertRelayBaseUrl(options.baseUrl)
    this.fetchImpl = options.fetch ?? fetch
  }

  async generate(input: ContentGenerationInput, options: { signal?: AbortSignal } = {}): Promise<GeneratedContent> {
    const durableClaimHooks = [input.claimProviderAttempt, input.startProviderAttempt, input.markProviderAttemptUnknown, input.settleProviderAttempt]
    if (durableClaimHooks.some(Boolean) && durableClaimHooks.some(hook => !hook)) {
      throw new Error('KNOWLEDGE_CLAIM_HOOKS_INCOMPLETE: durable provider claim hooks must be configured together')
    }
    const controller = new AbortController()
    const callerSignal = options.signal
    const abortFromCaller = () => controller.abort(callerSignal?.reason)
    if (callerSignal?.aborted) abortFromCaller()
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeout = setTimeout(() => controller.abort(new DOMException('model provider request timed out', 'TimeoutError')), this.options.timeoutMs ?? 90_000)
    try {
      const boundedInput = reuseBudgetedInput(input, this.options.maxInputTokens ?? 4_000)
      // The initial prompt is immutable across repair attempts. Reusing its
      // serialized form avoids rebuilding the full product/knowledge payload
      // for every retry while keeping the exact request body unchanged.
      const initialPrompt = prompt(boundedInput)
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: initialPrompt }]
      const repairMessages: string[] = []
      const maxOutputTokens = this.options.maxOutputTokens ?? 2_500
      const maxTotalOutputTokens = this.options.maxTotalOutputTokens ?? maxOutputTokens + (2 * Math.min(maxOutputTokens, REPAIR_MAX_OUTPUT_TOKENS))
      if (!Number.isSafeInteger(maxTotalOutputTokens) || maxTotalOutputTokens < 1 || maxTotalOutputTokens > 1_000_000) throw new Error('TOKEN_BUDGET_INVALID: total output token budget must be between 1 and 1000000')
      let reservedOutputTokens = 0
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const requestOutputTokens = attempt === 0 ? maxOutputTokens : Math.min(maxOutputTokens, REPAIR_MAX_OUTPUT_TOKENS)
        if (reservedOutputTokens + requestOutputTokens > maxTotalOutputTokens) throw new Error('OUTPUT_BUDGET_EXCEEDED: 累计模型输出 Token 预算已用尽，停止继续修复')
        reservedOutputTokens += requestOutputTokens
        const requestBody = JSON.stringify({ model: this.options.model, temperature: attempt === 0 ? 0.4 : 0, max_tokens: requestOutputTokens, response_format: { type: 'json_object' }, ...(this.options.disableThinking ? { thinking: { type: 'disabled' } } : {}), messages })
        const logicalAttemptKey = input.usageContext?.actionId?.trim()
          ? `mm-${createHash('sha256').update(JSON.stringify([input.usageContext.workspaceId?.trim() ?? '', input.usageContext.actionId.trim(), this.options.model.trim(), attempt, requestBody]), 'utf8').digest('hex')}`
          : providerIdempotencyKey({ operation: 'text_generate', model: this.options.model, workspaceId: input.usageContext?.workspaceId, requestBody })
        assertUsageSinkConfiguredBeforeDispatch(this.options.usageSink, this.options.relaySecurity?.environment)
        const requestBodySha256 = createHash('sha256').update(requestBody, 'utf8').digest('hex')
        // Keep the legacy read-only hook for callers that still need its
        // receipt; worker dispatch safety is enforced by the durable claim
        // hooks below at every physical provider request.
        if (input.beforeProviderRequest) await input.beforeProviderRequest({ workspaceId: input.usageContext?.workspaceId, actionId: input.usageContext?.actionId, model: this.options.model, attempt, providerAttemptKey: logicalAttemptKey, requestBodySha256 })
        let transportAttempt = 0
        let successfulProviderAttempt: { proof: { attempt: number; transportAttempt: number; providerAttemptKey: string; requestBodySha256: string }; claim: unknown } | undefined
        let response: Response
        response = await withProviderRequestRetry(async () => {
          transportAttempt += 1
          const providerProof = { attempt, transportAttempt, providerAttemptKey: logicalAttemptKey, requestBodySha256 }
          const claim = input.claimProviderAttempt ? await input.claimProviderAttempt({
            workspaceId: input.usageContext?.workspaceId,
            actionId: input.usageContext?.actionId,
            model: this.options.model,
            ...providerProof,
          }) : undefined
          if (input.startProviderAttempt && claim === undefined) throw new Error('KNOWLEDGE_CLAIM_MISSING: provider attempt claim was not created')
          if (claim !== undefined) {
            try { await input.startProviderAttempt?.(providerProof, claim) }
            catch (error) {
              // No provider fetch has started. A best-effort CAS release is
              // safe even if the start acknowledgement was lost in transit.
              if (input.settleProviderAttempt) await input.settleProviderAttempt(providerProof, claim, 'rejected').catch(() => undefined)
              throw error
            }
          }
          let candidate: Response
          let dispatched = false
          try {
            if (this.options.relaySecurity?.environment || this.options.relaySecurity?.allowedHosts?.length) await assertRelayUrl(this.options.baseUrl, this.options.relaySecurity)
            if (this.options.beforeRequest) await this.options.beforeRequest({ operation: 'text_generate', workspaceId: input.usageContext?.workspaceId, actionId: input.usageContext?.actionId, signal: controller.signal })
            controller.signal.throwIfAborted()
            dispatched = true
            candidate = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
              method: 'POST',
              headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}`, 'idempotency-key': logicalAttemptKey },
              body: requestBody,
              signal: controller.signal,
              redirect: 'error',
            })
          } catch (error) {
            if (!dispatched && claim !== undefined) {
              await input.settleProviderAttempt?.(providerProof, claim, 'rejected')
              throw error
            }
            if (claim !== undefined) await input.markProviderAttemptUnknown?.(providerProof, claim)
            rethrowProviderTransportFailure(error, logicalAttemptKey, 'text provider request')
          }
          const providerRequestId = candidate.headers.get('x-oneapi-request-id')?.trim() || undefined
          try { assertProviderResponseAccepted(candidate, logicalAttemptKey, 'text provider') }
          catch (error) {
            if ((error as { providerOutcome?: unknown })?.providerOutcome === 'failed' && claim !== undefined) {
              await input.settleProviderAttempt?.(providerProof, claim, 'rejected')
            } else if ((error as { providerOutcome?: unknown })?.providerOutcome === 'unknown' && claim !== undefined) {
              await input.markProviderAttemptUnknown?.(providerProof, claim, providerRequestId)
            }
            throw error
          }
          if (claim !== undefined) successfulProviderAttempt = { proof: providerProof, claim }
          return candidate
        }, { signal: controller.signal })
        let responseText: string
        try { responseText = await readBoundedResponseText(response, MAX_TEXT_RELAY_RESPONSE_BYTES, 'model response') }
        catch (error) {
          if (successfulProviderAttempt) await input.markProviderAttemptUnknown?.(successfulProviderAttempt.proof, successfulProviderAttempt.claim)
          rethrowProviderTransportFailure(error, logicalAttemptKey, 'text provider response')
        }
        let payload: unknown
        try { payload = JSON.parse(responseText) as unknown }
        catch (error) {
          if (successfulProviderAttempt) await input.markProviderAttemptUnknown?.(successfulProviderAttempt.proof, successfulProviderAttempt.claim)
          throwProviderOutcomeUnknown(logicalAttemptKey, 'text provider response parsing', error)
        }
        let usageReceipt: Awaited<ReturnType<typeof emitRelayUsage>>
        try { usageReceipt = await emitRelayUsage(this.options.usageSink, payload, response.headers, { modality: 'text', model: this.options.model, context: { ...input.usageContext, providerAttemptId: logicalAttemptKey } }) }
        catch (error) {
          if (successfulProviderAttempt) await input.markProviderAttemptUnknown?.(successfulProviderAttempt.proof, successfulProviderAttempt.claim)
          throw error
        }
        const afterProviderClaim = async (transition: () => Promise<void>) => {
          try { await transition() }
          catch (error) {
            if (successfulProviderAttempt) await input.markProviderAttemptUnknown?.(successfulProviderAttempt.proof, successfulProviderAttempt.claim).catch(() => undefined)
            throw Object.assign(new Error('provider succeeded but durable dispatch state is uncertain'), {
              code: 'CHARGED_TEXT_DISPATCH_SETTLEMENT_UNKNOWN', providerOutcome: 'unknown',
              providerSucceeded: true, reconciliationRequired: true, cause: error,
            })
          }
        }
        // The response belongs to the physical retry that returned 2xx. Keep
        // its dispatch claim active until schema validation chooses completion
        // or an explicitly authorized repair attempt.
        if (successfulProviderAttempt && input.recordProviderResponse) {
          await afterProviderClaim(() => input.recordProviderResponse!(successfulProviderAttempt!.proof, successfulProviderAttempt!.claim, relayUsageReceiptKey(usageReceipt)))
        }
        const content = normalizeProviderStructure(readContent(payload), boundedInput)
        let validContent: GeneratedContent
        try {
          validContent = validate(content, boundedInput)
        } catch (error) {
          if (attempt === 2 || input.allowSchemaRepair === false || !(error instanceof Error) || !error.message.includes('CONTENT_SCHEMA_INVALID')) {
            if (successfulProviderAttempt && input.settleProviderAttempt) await afterProviderClaim(() => input.settleProviderAttempt!(successfulProviderAttempt!.proof, successfulProviderAttempt!.claim, 'completed'))
            if (input.allowSchemaRepair === false && error instanceof Error && error.message.includes('CONTENT_SCHEMA_INVALID')) {
              throw Object.assign(new Error('charged generation provider returned invalid structured content; manual reconciliation is required'), {
                code: 'CHARGED_TEXT_SCHEMA_REPAIR_DISABLED', providerSucceeded: true, reconciliationRequired: true,
                providerOutcome: 'unknown', cause: error,
              })
            }
            throw error
          }
          const repairMessage = boundedInput.candidateOnly
            ? `上一个 JSON 未通过结构校验：${error.message.slice(0, REPAIR_DIAGNOSTIC_MAX_CHARS)}。只返回完整 JSON：title、detail、sellingPoints、brief；不得返回 modules 或任何未经确认的商品事实。逐字段核对初始 outputShape，勿照抄示意值。`
            : `上一个 JSON 未通过结构校验：${error.message.slice(0, REPAIR_DIAGNOSTIC_MAX_CHARS)}。重新返回完整 JSON，逐字段核对初始消息中的 outputShape。尤其每个模块必须有 factSourceIds、decisionContract.claim.factSourceIds、decisionContract.visualContract.requiredElements、decisionContract.priority 和 decisionContract.optional；claim.validUntil 只在输入事实有真实有效期时填写，不得虚构时间。仅使用输入 confirmedFactSourceIds 中的真实 ID；缺少来源则删除该模块，不能复制 outputShape 的示意值。只修复结构和缺失字段，不增加未确认事实。evidence.type 仅允许 real_image、parameter、test_report、comparison、usage_result、manual_review；evidence.status 仅允许 verified、missing、expired、conflict；product.id 不是 SKU ID，claim.skuIds 和 referencedSkuIds 只能使用 product.skuIds 中的值。不要复述上一份响应。`
          const nextRepairMessages = [...repairMessages, repairMessage]
          if (estimateRequestTokensFromPrompt(initialPrompt, nextRepairMessages) > (this.options.maxInputTokens ?? 4_000)) {
            if (successfulProviderAttempt && input.settleProviderAttempt) await afterProviderClaim(() => input.settleProviderAttempt!(successfulProviderAttempt!.proof, successfulProviderAttempt!.claim, 'completed'))
            throw new Error('CONTEXT_BUDGET_EXCEEDED: 累计结构修复消息加入后超过输入 Token 预算')
          }
          if (successfulProviderAttempt && input.markProviderRepairRequired) await afterProviderClaim(() => input.markProviderRepairRequired!(successfulProviderAttempt!.proof, successfulProviderAttempt!.claim))
          repairMessages.push(repairMessage)
          messages.push({ role: 'user', content: repairMessage })
          continue
        }
        if (successfulProviderAttempt && input.settleProviderAttempt) await afterProviderClaim(() => input.settleProviderAttempt!(successfulProviderAttempt!.proof, successfulProviderAttempt!.claim, 'completed'))
        return validContent
      }
      throw Object.assign(new Error('CONTENT_SCHEMA_INVALID: 模型结构化内容修复失败'), { code: 'CONTENT_SCHEMA_INVALID' })
    } finally {
      clearTimeout(timeout)
      callerSignal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

export function createContentGeneratorFromEnv(source: Record<string, string | undefined> = process.env, usageSink?: RelayUsageSink, beforeRequest?: ProviderBeforeRequest): ContentGenerator | undefined {
  const relayUrl = source.MODEL_RELAY_BASE_URL?.trim()
  const apiKey = source.MODEL_RELAY_API_KEY?.trim()
  const model = source.AI_MODEL?.trim() || source.MODEL_ID?.trim()
  if (!relayUrl || !apiKey || !model) return undefined
  const thinkingMode = source.AI_THINKING_MODE?.trim()
  if (thinkingMode && thinkingMode !== 'disabled') throw new Error('AI_THINKING_MODE must be disabled when configured')
  const relaySecurity = relaySecurityFromEnv(source)
  if (!relaySecurity) return undefined
  const maxInputTokens = resolveTokenBudget(source.AI_MAX_INPUT_TOKENS, 4_000, 'input')
  const maxOutputTokens = resolveTokenBudget(source.AI_MAX_OUTPUT_TOKENS, 2_500, 'output')
  if (isPlaceholderModelConfiguration(relayUrl) || isPlaceholderModelConfiguration(apiKey) || isPlaceholderModelConfiguration(model)) return undefined
  return new OpenAICompatibleContentGenerator({ baseUrl: relayUrl, apiKey, model, relaySecurity, timeoutMs: resolveProviderTimeoutMs(source.AI_TIMEOUT_MS, 90_000, 'AI_TIMEOUT_MS'), maxInputTokens, maxOutputTokens, ...(thinkingMode === 'disabled' ? { disableThinking: true } : {}), ...(usageSink ? { usageSink } : {}), ...(beforeRequest ? { beforeRequest } : {}) })
}
