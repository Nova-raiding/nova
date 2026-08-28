import type { RuleCenter, RuleEvaluationContext, RuleHit } from './rule-center.js'

export type ReviewSeverity = 'error' | 'warning'
export type ReviewPriority = 'P0' | 'P1' | 'P2'
export type ReviewFindingStatus = 'open' | 'acknowledged' | 'resolved' | 'waived'
export type ReviewCategoryId = 'product_truth' | 'brand_consistency' | 'copy_price_compliance' | 'visual_brief_quality' | 'technical_specification' | 'platform_preflight'

/**
 * Evidence is deliberately scoped to checks performed by this application.
 * `externalVerification` is a boundary marker, not a claim about any platform.
 */
export interface ReviewEvidence {
  kind: 'fact' | 'rule' | 'brand' | 'content' | 'image'
  sourceIds: string[]
  verified: boolean
  scope: 'local_deterministic'
  externalVerification: 'not_performed'
  boundary: '外部平台审核、OCR 和线上渲染效果未在本地审核中验证'
}

export interface ReviewFinding {
  code: 'MISSING_SOURCE' | 'MISSING_RULE_VERSION' | 'PRICE_NOT_ALLOWED' | 'SKU_MISMATCH' | 'SKU_IMAGE_MAPPING_INVALID' | 'FORBIDDEN_TERM' | 'BRAND_FORBIDDEN_TERM' | 'BRAND_VISUAL_ASSET_NOT_READY' | 'BRAND_FONT_LICENSE_NOT_APPROVED' | 'RULE_EXPIRED' | 'RULE_NOT_YET_EFFECTIVE' | 'RULE_PRIORITY_CONFLICT' | 'PROMOTION_EXPIRED' | 'PROMOTION_SCOPE_INVALID' | 'PROMOTION_SKU_UNREFERENCED' | 'MAIN_IMAGE_REQUIRED' | 'IMAGE_URL_INVALID' | 'DUPLICATE_IMAGE' | 'IMAGE_FORMAT_UNSUPPORTED' | 'IMAGE_TOO_SMALL' | 'PRODUCT_FACTS_UNCONFIRMED' | 'SELLING_POINT_PROOF_MISSING' | 'VISUAL_BRIEF_MISSING' | 'VISUAL_BRIEF_INCOMPLETE' | 'TECHNICAL_SCHEMA_INVALID' | 'TECHNICAL_EXPORT_MANIFEST_MISSING' | 'PLATFORM_PREFLIGHT_PENDING'
  severity: ReviewSeverity
  priority: ReviewPriority
  status: ReviewFindingStatus
  field: string
  message: string
  repairSuggestion: string
  evidence: ReviewEvidence
  decision?: { reason: string; actorId: string; updatedAt: string }
}

export interface ReviewCategoryResult {
  id: ReviewCategoryId
  name: string
  status: 'passed' | 'warning' | 'blocking' | 'not_evaluated' | 'external_pending'
  findingCount: number
  summary: string
}

export interface ReviewReport {
  findings: ReviewFinding[]
  categories: ReviewCategoryResult[]
  blocking: boolean
  evidenceBoundary: ReviewEvidence['boundary']
  ruleHits?: RuleHit[]
}

export const REVIEW_EVIDENCE_BOUNDARY: ReviewEvidence['boundary'] = '外部平台审核、OCR 和线上渲染效果未在本地审核中验证'

function finding(input: {
  code: ReviewFinding['code']
  severity: ReviewSeverity
  priority: ReviewPriority
  field: string
  message: string
  repairSuggestion: string
  kind: ReviewEvidence['kind']
  sourceIds?: readonly string[]
}): ReviewFinding {
  return {
    code: input.code,
    severity: input.severity,
    priority: input.priority,
    status: 'open',
    field: input.field,
    message: input.message,
    repairSuggestion: input.repairSuggestion,
    evidence: {
      kind: input.kind,
      sourceIds: [...(input.sourceIds ?? [])],
      verified: true,
      scope: 'local_deterministic',
      externalVerification: 'not_performed',
      boundary: REVIEW_EVIDENCE_BOUNDARY,
    },
  }
}

export function reviewProductImages(images: readonly string[] | undefined): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  const values = (images ?? []).map(image => image.trim()).filter(Boolean)
  if (!values.length) return [finding({ code: 'MAIN_IMAGE_REQUIRED', severity: 'error', priority: 'P0', field: 'images[0]', message: '商品必须提供至少一张主图', repairSuggestion: '上传或生成至少一张真实商品主图后重新审核', kind: 'image' })]
  const seen = new Set<string>()
  values.forEach((image, index) => {
    const imageSource = [`images[${index}]`]
    if (!/^(https:\/\/|s3:\/\/|oss:\/\/|fixture:\/\/|data:image\/)/iu.test(image)) findings.push(finding({ code: 'IMAGE_URL_INVALID', severity: 'error', priority: 'P0', field: `images[${index}]`, message: '主图必须使用 HTTPS、受控对象存储或已登记的图片数据 URI', repairSuggestion: '替换为 HTTPS、受控对象存储地址或已登记的图片数据 URI', kind: 'image', sourceIds: imageSource }))
    if (/^data:image\/svg\+xml[;,]/iu.test(image)) findings.push(finding({ code: 'IMAGE_FORMAT_UNSUPPORTED', severity: 'error', priority: 'P0', field: `images[${index}]`, message: '商品主图不能使用低保真 SVG 示意图，请使用 PNG、JPEG 或 WebP 图片', repairSuggestion: '上传 PNG、JPEG 或 WebP 格式的真实商品图片', kind: 'image', sourceIds: imageSource }))
    const png = image.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/iu)
    const webp = image.match(/^data:image\/webp;base64,([A-Za-z0-9+/=]+)$/iu)
    if (png || webp) {
      try {
        const bytes = Buffer.from((png?.[1] ?? webp?.[1] ?? ''), 'base64')
        if (png) {
          const validPng = bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a
          if (!validPng) findings.push(finding({ code: 'IMAGE_FORMAT_UNSUPPORTED', severity: 'error', priority: 'P0', field: `images[${index}]`, message: 'PNG 数据签名无效，无法作为商品主图使用', repairSuggestion: '重新导出或上传可正常解析的 PNG 图片', kind: 'image', sourceIds: imageSource }))
          else if (bytes.readUInt32BE(16) < 1024 || bytes.readUInt32BE(20) < 1024) findings.push(finding({ code: 'IMAGE_TOO_SMALL', severity: 'error', priority: 'P1', field: `images[${index}]`, message: '商品主图分辨率不足 1024×1024', repairSuggestion: '更换或重新生成至少 1024×1024 的商品主图', kind: 'image', sourceIds: imageSource }))
        } else {
          const validWebp = bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.toString('ascii', 12, 16) === 'VP8 '
          const width = validWebp ? bytes.readUInt16LE(26) & 0x3fff : 0
          const height = validWebp ? bytes.readUInt16LE(28) & 0x3fff : 0
          if (!validWebp) findings.push(finding({ code: 'IMAGE_FORMAT_UNSUPPORTED', severity: 'error', priority: 'P0', field: `images[${index}]`, message: 'WebP 数据签名无效，无法作为商品主图使用', repairSuggestion: '重新导出或上传可正常解析的 WebP 图片', kind: 'image', sourceIds: imageSource }))
          else if (width < 1024 || height < 1024) findings.push(finding({ code: 'IMAGE_TOO_SMALL', severity: 'error', priority: 'P1', field: `images[${index}]`, message: '商品主图分辨率不足 1024×1024', repairSuggestion: '更换或重新生成至少 1024×1024 的商品主图', kind: 'image', sourceIds: imageSource }))
        }
      } catch {
        findings.push(finding({ code: 'IMAGE_FORMAT_UNSUPPORTED', severity: 'error', priority: 'P0', field: `images[${index}]`, message: '图片数据无法解析，请重新上传或生成', repairSuggestion: '重新上传或生成可解析的 PNG、JPEG 或 WebP 图片', kind: 'image', sourceIds: imageSource }))
      }
    }
    if (seen.has(image)) findings.push(finding({ code: 'DUPLICATE_IMAGE', severity: 'warning', priority: 'P2', field: `images[${index}]`, message: '图片与前面图片重复', repairSuggestion: '删除重复图片，补充不同角度或细节图', kind: 'image', sourceIds: imageSource }))
    seen.add(image)
  })
  return findings
}

export interface DeterministicReviewInput {
  body: { title: string; detail: string; sellingPoints: string[] }
  modules?: Array<{ key: string; factSourceIds: string[] }>
  facts: { skuIds: string[]; price?: number; minPrice?: number; maxPrice?: number; sourceIds: string[] }
  referencedSkuIds: string[]
  skuImageMappings?: Array<{ skuId: string; imageCount: number; sourceIds: string[] }>
  ruleVersionIds: string[]
  forbiddenTerms?: string[]
  brand?: { forbiddenTerms: string[]; sourceIds: string[] }
  availableRuleVersionIds?: string[]
  /** Optional context-aware rule evaluation; omitted for legacy callers. */
  ruleCenter?: RuleCenter
  ruleContext?: RuleEvaluationContext
  reviewAt?: string
  productFactsConfirmed?: boolean
  sellingPointProofs?: Array<{ id: string; text: string; proofStatus: 'pending' | 'confirmed' | 'rejected'; sourceIds: string[] }>
  checkVisualBrief?: boolean
  brief?: { platform: string; placement: string; targetDimensions: string; visualHierarchy: string[]; productImageGuidance: string; logoSafety: string; headline: string; subheadline: string; coreSellingPoint: string; cta: string; textDensity: string; safeArea: string; protectedAreas: string[] }
  technical?: { schemaValid: boolean; exportManifestPresent?: boolean }
  platformPreflight?: { status: 'verified' | 'pending' | 'blocked'; reasons?: string[]; sourceIds?: string[] }
  promotions?: Array<{ platform: string; productId: string; accountId?: string; skuIds: string[]; validFrom?: string; validTo?: string; sourceId?: string }>
  promotionContext?: { platform: string; productId: string; accountId?: string; skuIds: string[] }
}

/**
 * Deterministic P0 checks. This function never claims legal or platform
 * approval; it only blocks facts that are mechanically unverifiable.
 */
export function reviewDeterministic(input: DeterministicReviewInput): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  if (input.productFactsConfirmed === false) findings.push(finding({ code: 'PRODUCT_FACTS_UNCONFIRMED', severity: 'error', priority: 'P0', field: 'product.factsConfirmed', message: '商品事实尚未确认，不能进入正式审核', repairSuggestion: '在 Codex 中确认商品、SKU、价格、库存和素材事实后重新审核', kind: 'fact' }))
  if ((input.sellingPointProofs?.length ?? 0) > 3) findings.push(finding({ code: 'SELLING_POINT_PROOF_MISSING', severity: 'error', priority: 'P0', field: 'product.sellingPoints', message: '核心卖点超过 3 条，不能进入正式审核', repairSuggestion: '保留最重要的 3 条核心卖点后重新确认商品事实', kind: 'fact' }))
  for (const point of input.sellingPointProofs ?? []) if (point.proofStatus !== 'confirmed' || point.sourceIds.length === 0) findings.push(finding({ code: 'SELLING_POINT_PROOF_MISSING', severity: 'error', priority: 'P0', field: `product.sellingPoints.${point.id}`, message: `核心卖点“${point.text}”缺少已确认证明来源`, repairSuggestion: '补充来源 ID 并将证明状态确认后重新审核', kind: 'fact', sourceIds: point.sourceIds }))
  for (const mapping of input.skuImageMappings ?? []) if (mapping.imageCount < 1) findings.push(finding({ code: 'SKU_IMAGE_MAPPING_INVALID', severity: 'error', priority: 'P0', field: `sku.${mapping.skuId}.images`, message: `SKU ${mapping.skuId} 缺少已确认的商品图片映射`, repairSuggestion: '为该 SKU 绑定至少一张真实商品图片，并重新确认商品事实', kind: 'image', sourceIds: mapping.sourceIds }))
  for (const [index, promotion] of (input.promotions ?? []).entries()) {
    const field = `promotion[${index}]`
    if (promotion.validFrom && Date.parse(promotion.validFrom) > Date.now()) findings.push(finding({ code: 'PROMOTION_EXPIRED', severity: 'error', priority: 'P0', field: `${field}.validFrom`, message: '促销尚未到生效时间，不能用于当前内容', repairSuggestion: '等待活动生效或切换到当前有效的价格快照', kind: 'fact', sourceIds: promotion.sourceId ? [promotion.sourceId] : [] }))
    if (promotion.validTo && Date.parse(promotion.validTo) <= Date.now()) findings.push(finding({ code: 'PROMOTION_EXPIRED', severity: 'error', priority: 'P0', field: `${field}.validTo`, message: '促销已过期，不能继续批准或导出当前内容', repairSuggestion: '更新促销有效期并重新确认价格，或移除促销表达后创建新版本', kind: 'fact', sourceIds: promotion.sourceId ? [promotion.sourceId] : [] }))
    if (input.promotionContext && (promotion.platform !== input.promotionContext.platform || promotion.productId !== input.promotionContext.productId || (promotion.accountId ?? null) !== (input.promotionContext.accountId ?? null))) findings.push(finding({ code: 'PROMOTION_SCOPE_INVALID', severity: 'error', priority: 'P0', field, message: '促销快照的平台、店铺或商品作用域与当前任务不一致', repairSuggestion: '重新选择当前平台/店铺/商品下的促销快照', kind: 'fact', sourceIds: promotion.sourceId ? [promotion.sourceId] : [] }))
    if (input.promotionContext && promotion.skuIds.length > 0 && promotion.skuIds.some(skuId => !input.promotionContext!.skuIds.includes(skuId))) findings.push(finding({ code: 'PROMOTION_SKU_UNREFERENCED', severity: 'error', priority: 'P0', field: `${field}.skuIds`, message: '促销快照引用了当前任务未确认的 SKU', repairSuggestion: '重新确认 SKU 事实并创建作用域匹配的促销快照', kind: 'fact', sourceIds: promotion.sourceId ? [promotion.sourceId] : [] }))
  }
  const evaluatedRules = input.ruleCenter?.evaluate(input.ruleContext, input.reviewAt)
  for (const ruleFinding of evaluatedRules?.findings ?? []) findings.push(finding({
    code: ruleFinding.code,
    severity: ruleFinding.severity,
    priority: 'P0',
    field: ruleFinding.field,
    message: ruleFinding.message,
    repairSuggestion: '更新或替换为当前有效的规则版本后重新审核',
    kind: 'rule',
    sourceIds: [ruleFinding.ruleVersionId],
  }))
  if (input.facts.sourceIds.length === 0) findings.push(finding({ code: 'MISSING_SOURCE', severity: 'error', priority: 'P0', field: 'facts', message: '正式内容必须关联至少一个已确认事实来源', repairSuggestion: '补充并确认商品资料、素材或授权来源，再重新生成内容', kind: 'fact' }))
  for (const module of input.modules ?? []) if (!module.factSourceIds.length) findings.push(finding({ code: 'MISSING_SOURCE', severity: 'error', priority: 'P0', field: `modules.${module.key}`, message: `内容模块 ${module.key} 缺少事实来源`, repairSuggestion: `为内容模块 ${module.key} 绑定已确认的事实来源`, kind: 'content' }))
  if (input.ruleVersionIds.length === 0) findings.push(finding({ code: 'MISSING_RULE_VERSION', severity: 'error', priority: 'P0', field: 'rules', message: '缺少适用且有效的规则版本', repairSuggestion: '选择当前品类和平台的有效规则版本后重新审核', kind: 'rule' }))
  if (input.availableRuleVersionIds && input.ruleVersionIds.some(version => !input.availableRuleVersionIds!.includes(version))) {
    findings.push(finding({ code: 'MISSING_RULE_VERSION', severity: 'error', priority: 'P0', field: 'rules', message: '引用的规则版本已停用、过期或不存在', repairSuggestion: '切换到当前有效的规则版本，并重新生成或审核内容', kind: 'rule', sourceIds: input.ruleVersionIds }))
  }
  if (input.facts.price !== undefined && ((input.facts.minPrice !== undefined && input.facts.price < input.facts.minPrice) || (input.facts.maxPrice !== undefined && input.facts.price > input.facts.maxPrice))) {
    findings.push(finding({ code: 'PRICE_NOT_ALLOWED', severity: 'error', priority: 'P0', field: 'price', message: '价格不在已确认的允许范围内', repairSuggestion: '调整价格到已确认范围，或补充新的价格事实并重新审核', kind: 'fact', sourceIds: input.facts.sourceIds }))
  }
  const known = new Set(input.facts.skuIds)
  for (const skuId of input.referencedSkuIds) if (!known.has(skuId)) findings.push(finding({ code: 'SKU_MISMATCH', severity: 'error', priority: 'P0', field: 'sku', message: `内容引用了不存在或未确认的 SKU: ${skuId}`, repairSuggestion: `删除 ${skuId} 的引用，或先补充并确认该 SKU`, kind: 'fact', sourceIds: input.facts.sourceIds }))
  const forbiddenTerms = input.forbiddenTerms ?? evaluatedRules?.checks.forbiddenTerms ?? []
  const haystack = [input.body.title, input.body.detail, ...input.body.sellingPoints].join('\n')
  const brandForbiddenTerms = new Set((input.brand?.forbiddenTerms ?? []).filter(Boolean))
  const matchedBrandSpans = [...brandForbiddenTerms].flatMap(term => {
    const spans: Array<{ start: number; end: number }> = []
    for (let start = haystack.indexOf(term); start >= 0; start = haystack.indexOf(term, start + Math.max(1, term.length))) spans.push({ start, end: start + term.length })
    return spans
  })
  for (const term of forbiddenTerms) {
    if (!term) continue
    // Prefer the more specific frozen brand evidence when the same term is
    // present in both rule sources, so merchants only receive one action item.
    const ruleMatches: number[] = []
    for (let start = haystack.indexOf(term); start >= 0; start = haystack.indexOf(term, start + Math.max(1, term.length))) ruleMatches.push(start)
    if (ruleMatches.length && ruleMatches.every(start => matchedBrandSpans.some(span => start >= span.start && start + term.length <= span.end))) continue
    if (haystack.includes(term)) findings.push(finding({ code: 'FORBIDDEN_TERM', severity: 'error', priority: 'P0', field: 'content', message: `内容包含禁用词: ${term}`, repairSuggestion: `删除或改写禁用词“${term}”，然后重新执行规则审核`, kind: 'rule', sourceIds: input.ruleVersionIds }))
  }
  for (const term of brandForbiddenTerms) {
    if (haystack.includes(term)) findings.push(finding({ code: 'BRAND_FORBIDDEN_TERM', severity: 'error', priority: 'P0', field: 'content', message: `内容包含品牌禁用词: ${term}`, repairSuggestion: `删除或改写品牌禁用词“${term}”，并按已冻结品牌档案重新审核`, kind: 'brand', sourceIds: input.brand?.sourceIds }))
  }
  if (input.checkVisualBrief && input.brief === undefined) findings.push(finding({ code: 'VISUAL_BRIEF_MISSING', severity: 'error', priority: 'P0', field: 'brief', message: '缺少静态视觉 Brief，无法确认版位、层级、安全区和商品图保护要求', repairSuggestion: '重新生成包含完整 Brief 的内容版本', kind: 'content' }))
  else if (input.checkVisualBrief && input.brief) {
    const requiredBrief = ['platform', 'placement', 'targetDimensions', 'productImageGuidance', 'logoSafety', 'headline', 'subheadline', 'coreSellingPoint', 'cta', 'textDensity', 'safeArea'] as const
    const missingBrief: string[] = [...requiredBrief.filter(key => !input.brief?.[key]?.trim()), ...(input.brief.visualHierarchy.length ? [] : ['visualHierarchy']), ...(input.brief.protectedAreas.length ? [] : ['protectedAreas'])]
    if (missingBrief.length) findings.push(finding({ code: 'VISUAL_BRIEF_INCOMPLETE', severity: 'error', priority: 'P1', field: 'brief', message: `视觉 Brief 缺少：${missingBrief.join('、')}`, repairSuggestion: '补齐版位、尺寸、视觉层级、真实商品图指导、Logo 安全区、CTA 和保护区域', kind: 'content' }))
  }
  if (input.technical?.schemaValid === false) findings.push(finding({ code: 'TECHNICAL_SCHEMA_INVALID', severity: 'error', priority: 'P0', field: 'content.schema', message: '内容结构未通过统一 JSON Schema 校验', repairSuggestion: '修正 title、detail、sellingPoints、modules 和 brief 字段后重新提交', kind: 'content' }))
  if (input.technical?.exportManifestPresent === false) findings.push(finding({ code: 'TECHNICAL_EXPORT_MANIFEST_MISSING', severity: 'error', priority: 'P1', field: 'export.manifest', message: '交付包缺少可追溯 manifest', repairSuggestion: '重新生成包含版本向量、规则和事实来源的交付包', kind: 'content' }))
  if (input.platformPreflight && input.platformPreflight.status !== 'verified') findings.push(finding({ code: 'PLATFORM_PREFLIGHT_PENDING', severity: input.platformPreflight.status === 'blocked' ? 'error' : 'warning', priority: input.platformPreflight.status === 'blocked' ? 'P0' : 'P1', field: 'platform.preflight', message: input.platformPreflight.status === 'blocked' ? `平台发布预检被阻断：${(input.platformPreflight.reasons ?? []).join('、') || '存在未满足条件'}` : '平台发布预检尚未取得真实平台回执，当前只能完成本地映射检查', repairSuggestion: '完成目标平台字段、类目、图片、SKU/价格/库存和账号权限校验后重新审核', kind: 'rule', sourceIds: input.platformPreflight.sourceIds }))
  return findings
}

export function isReviewBlocking(findings: readonly ReviewFinding[]) { return findings.some(finding => finding.severity === 'error') }

const categoryDefinitions: Array<{ id: ReviewCategoryId; name: string; codes: ReviewFinding['code'][] }> = [
  { id: 'product_truth', name: '商品真实性', codes: ['MISSING_SOURCE', 'PRICE_NOT_ALLOWED', 'SKU_MISMATCH', 'SKU_IMAGE_MAPPING_INVALID', 'PRODUCT_FACTS_UNCONFIRMED', 'SELLING_POINT_PROOF_MISSING'] },
  { id: 'brand_consistency', name: '品牌一致性', codes: ['BRAND_FORBIDDEN_TERM', 'BRAND_VISUAL_ASSET_NOT_READY', 'BRAND_FONT_LICENSE_NOT_APPROVED'] },
  { id: 'copy_price_compliance', name: '文案、价格与合规', codes: ['FORBIDDEN_TERM', 'MISSING_RULE_VERSION', 'RULE_EXPIRED', 'RULE_NOT_YET_EFFECTIVE', 'RULE_PRIORITY_CONFLICT', 'PROMOTION_EXPIRED', 'PROMOTION_SCOPE_INVALID', 'PROMOTION_SKU_UNREFERENCED'] },
  { id: 'visual_brief_quality', name: '视觉 Brief 质量', codes: ['MAIN_IMAGE_REQUIRED', 'IMAGE_URL_INVALID', 'DUPLICATE_IMAGE', 'IMAGE_FORMAT_UNSUPPORTED', 'IMAGE_TOO_SMALL', 'VISUAL_BRIEF_MISSING', 'VISUAL_BRIEF_INCOMPLETE'] },
  { id: 'technical_specification', name: '技术规格', codes: ['TECHNICAL_SCHEMA_INVALID', 'TECHNICAL_EXPORT_MANIFEST_MISSING'] },
  { id: 'platform_preflight', name: '平台发布预检', codes: ['PLATFORM_PREFLIGHT_PENDING'] },
]

/**
 * Always returns all six PRD review categories. Categories without sufficient
 * local evidence are explicitly marked instead of being presented as passed.
 */
export function buildReviewReport(findings: ReviewFinding[], coverage: { brandProfileBound: boolean; visualBriefChecked: boolean; technicalSchemaChecked: boolean; platformMappingChecked: boolean; ruleHits?: RuleHit[] }): ReviewReport {
  const unavailable = new Map<ReviewCategoryId, ReviewCategoryResult['status']>([
    ['brand_consistency', coverage.brandProfileBound ? 'passed' : 'not_evaluated'],
    ['visual_brief_quality', coverage.visualBriefChecked ? 'passed' : 'not_evaluated'],
    ['technical_specification', coverage.technicalSchemaChecked ? 'passed' : 'not_evaluated'],
    ['platform_preflight', coverage.platformMappingChecked ? 'external_pending' : 'not_evaluated'],
  ])
  const categories = categoryDefinitions.map(definition => {
    const categoryFindings = findings.filter(item => definition.codes.includes(item.code))
    const handledCount = categoryFindings.filter(item => item.status !== 'open').length
    const externalPendingOnly = categoryFindings.length > 0 && categoryFindings.every(item => item.code === 'PLATFORM_PREFLIGHT_PENDING' && item.severity === 'warning')
    const status: ReviewCategoryResult['status'] = categoryFindings.some(item => item.severity === 'error')
      ? 'blocking'
      : externalPendingOnly
        ? 'external_pending'
      : categoryFindings.length
        ? 'warning'
        : unavailable.get(definition.id) ?? 'passed'
    const summary = status === 'blocking' ? `${categoryFindings.length} 项阻断问题`
      : status === 'warning' ? handledCount === categoryFindings.length
        ? `${categoryFindings.length} 项改进建议，均已处理并保留审计记录`
        : `${categoryFindings.length} 项改进建议，${handledCount} 项已处理`
        : status === 'not_evaluated' ? '缺少本地证据，尚未完成该类检查'
          : status === 'external_pending' ? '本地映射已检查；仍需目标平台最终校验'
            : '本地确定性检查通过'
    return { id: definition.id, name: definition.name, status, findingCount: categoryFindings.length, summary }
  })
  return { findings, categories, blocking: isReviewBlocking(findings), evidenceBoundary: REVIEW_EVIDENCE_BOUNDARY, ...(coverage.ruleHits ? { ruleHits: coverage.ruleHits } : {}) }
}
