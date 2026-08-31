import { createHash } from 'node:crypto'

export type VisualGateStatus = 'pass' | 'block' | 'warn'

export type VisualRegionKind =
  | 'product'
  | 'logo'
  | 'certification_mark'
  | 'packaging_text'
  | 'marketing_copy'
  | 'background'
  | 'other'

export interface VisualRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface VisualEvidenceRegion {
  readonly id: string
  /** Labels are display metadata and may use any language. */
  readonly label: string
  readonly kind: VisualRegionKind
  readonly rect: VisualRect
}

export interface VisualImageEvidence {
  readonly width: number
  readonly height: number
  /** SHA-256, with or without the `sha256:` prefix. */
  readonly hash: string
}

export interface OcrTextEvidence {
  readonly text: string
  readonly confidence: number
  readonly regionId?: string
  readonly language?: string
}

export type ComparisonOutcome = 'unchanged' | 'changed' | 'not_applicable' | 'unknown'

export interface VisualComparisonEvidence {
  readonly outcome: ComparisonOutcome
  readonly confidence: number
  readonly originalValue?: string
  readonly candidateValue?: string
}

export interface ObservedVisualChange {
  readonly id: string
  readonly kind: 'product' | 'logo' | 'certification_mark' | 'packaging_text' | 'marketing_copy' | 'background' | 'lighting' | 'composition'
  readonly rect: VisualRect
}

export interface HumanReviewEvidence {
  readonly status: 'not_required' | 'pending' | 'approved' | 'rejected'
  readonly reviewerId?: string
  readonly reviewedAt?: string
  /** SHA-256 of `candidateHash + NUL + reviewerId + NUL + reviewedAt`. */
  readonly attestationHash?: string
  readonly note?: string
}

export interface VisualAuthenticityGateInput {
  readonly originalImage: VisualImageEvidence
  readonly candidateImage?: VisualImageEvidence
  readonly protectedRegions: readonly VisualEvidenceRegion[]
  readonly editableRegions: readonly VisualEvidenceRegion[]
  readonly observedChanges: readonly ObservedVisualChange[]
  readonly ocr: {
    readonly original: readonly OcrTextEvidence[]
    readonly candidate: readonly OcrTextEvidence[]
  }
  readonly protectedComparisons: {
    readonly logo: VisualComparisonEvidence
    readonly certificationMark: VisualComparisonEvidence
    readonly packagingText: VisualComparisonEvidence
  }
  readonly productComparisons: {
    readonly structure: VisualComparisonEvidence
    readonly color: VisualComparisonEvidence
    readonly material: VisualComparisonEvidence
  }
  readonly provenance: {
    readonly source: string
    readonly provider: string
    readonly model: string
  }
  readonly humanReview: HumanReviewEvidence
  readonly confidenceThreshold?: number
}

export type VisualAuthenticityFindingCode =
  | 'CANDIDATE_IMAGE_MISSING'
  | 'IMAGE_DIMENSIONS_INVALID'
  | 'IMAGE_HASH_INVALID'
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_CONFIDENCE_INVALID'
  | 'REGION_INVALID'
  | 'REGION_POLICY_CONFLICT'
  | 'CHANGE_OUTSIDE_EDITABLE_REGION'
  | 'PROTECTED_REGION_CHANGED'
  | 'PRODUCT_STRUCTURE_CHANGED'
  | 'PRODUCT_COLOR_CHANGED'
  | 'PRODUCT_MATERIAL_CHANGED'
  | 'LOGO_DRIFT'
  | 'CERTIFICATION_MARK_DRIFT'
  | 'PACKAGING_TEXT_DRIFT'
  | 'HUMAN_REVIEW_REJECTED'
  | 'HUMAN_REVIEW_ATTESTATION_INVALID'
  | 'LOW_CONFIDENCE_REQUIRES_HUMAN_REVIEW'
  | 'LOW_CONFIDENCE_HUMAN_VERIFIED'
  | 'AUTHENTICITY_EVIDENCE_COMPLETE'

export interface VisualAuthenticityFinding {
  readonly code: VisualAuthenticityFindingCode
  readonly status: VisualGateStatus
  readonly path: string
  readonly message: string
  readonly evidence?: Readonly<Record<string, unknown>>
}

export interface VisualAuthenticityNextAction {
  readonly code: string
  readonly priority: 'required' | 'recommended'
  readonly action: string
  readonly findingCodes: readonly VisualAuthenticityFindingCode[]
}

export interface VisualAuthenticityGateResult {
  readonly status: VisualGateStatus
  readonly publishable: boolean
  readonly requiresHumanReview: boolean
  readonly findings: readonly VisualAuthenticityFinding[]
  readonly nextActions: readonly VisualAuthenticityNextAction[]
  readonly evaluatedAt: string
}

const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/iu
const DEFAULT_CONFIDENCE_THRESHOLD = 0.8
const MAX_IMAGE_EDGE = 100_000
const MAX_EVIDENCE_ITEMS = 1_000
const MAX_TEXT_LENGTH = 8_192
const ALLOWED_VARIATIONS = new Set<ObservedVisualChange['kind']>(['background', 'lighting', 'composition'])
const CHANGE_KINDS = new Set<string>(['product', 'logo', 'certification_mark', 'packaging_text', 'marketing_copy', 'background', 'lighting', 'composition'])

const immutable = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value && typeof value === 'object') {
    if (seen.has(value)) return value
    seen.add(value)
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child, seen)
  }
  return value
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_TEXT_LENGTH && value.trim().length > 0

const validConfidence = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

const validRect = (value: unknown): value is VisualRect => {
  if (!isRecord(value)) return false
  const { x, y, width, height } = value
  return [x, y, width, height].every(item => typeof item === 'number' && Number.isFinite(item)) &&
    (x as number) >= 0 && (y as number) >= 0 && (width as number) > 0 && (height as number) > 0 &&
    (x as number) + (width as number) <= 1 && (y as number) + (height as number) <= 1
}

const contains = (outer: VisualRect, inner: VisualRect) =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

/** Edge contact is safe; positive-area intersection is an overlap. */
const overlaps = (left: VisualRect, right: VisualRect) =>
  left.x < right.x + right.width && left.x + left.width > right.x &&
  left.y < right.y + right.height && left.y + left.height > right.y

const block = (
  code: VisualAuthenticityFindingCode,
  path: string,
  message: string,
  evidence?: Readonly<Record<string, unknown>>,
): VisualAuthenticityFinding => ({ code, status: 'block', path, message, ...(evidence ? { evidence } : {}) })

const warn = (
  code: VisualAuthenticityFindingCode,
  path: string,
  message: string,
  evidence?: Readonly<Record<string, unknown>>,
): VisualAuthenticityFinding => ({ code, status: 'warn', path, message, ...(evidence ? { evidence } : {}) })

const passed = (
  code: VisualAuthenticityFindingCode,
  path: string,
  message: string,
  evidence?: Readonly<Record<string, unknown>>,
): VisualAuthenticityFinding => ({ code, status: 'pass', path, message, ...(evidence ? { evidence } : {}) })

const validateImage = (value: unknown, path: string, findings: VisualAuthenticityFinding[]) => {
  if (!isRecord(value)) {
    findings.push(block('EVIDENCE_MISSING', path, `${path} evidence is required / 缺少${path}证据。`))
    return
  }
  if (!Number.isSafeInteger(value.width) || (value.width as number) <= 0 || (value.width as number) > MAX_IMAGE_EDGE ||
      !Number.isSafeInteger(value.height) || (value.height as number) <= 0 || (value.height as number) > MAX_IMAGE_EDGE) {
    findings.push(block('IMAGE_DIMENSIONS_INVALID', path, '图片宽高必须是正整数像素。', { width: value.width, height: value.height }))
  }
  if (!nonEmpty(value.hash) || !SHA256.test(value.hash)) {
    findings.push(block('IMAGE_HASH_INVALID', `${path}.hash`, '图片必须提供有效 SHA-256 哈希。'))
  }
}

const validateRegions = (
  value: unknown,
  path: string,
  findings: VisualAuthenticityFinding[],
): VisualEvidenceRegion[] => {
  if (!Array.isArray(value)) {
    findings.push(block('EVIDENCE_MISSING', path, `${path} must be supplied as an array / ${path} 必须显式提供。`))
    return []
  }
  if (value.length > MAX_EVIDENCE_ITEMS) {
    findings.push(block('REGION_INVALID', path, `区域数量超过安全上限 ${MAX_EVIDENCE_ITEMS}。`))
    return []
  }
  const seenIds = new Set<string>()
  return value.flatMap((region, index) => {
    if (!isRecord(region) || !nonEmpty(region.id) || seenIds.has(region.id) || !nonEmpty(region.label) || !nonEmpty(region.kind) ||
        !['product', 'logo', 'certification_mark', 'packaging_text', 'marketing_copy', 'background', 'other'].includes(region.kind) || !validRect(region.rect)) {
      findings.push(block('REGION_INVALID', `${path}[${index}]`, '区域必须包含跨语言可读标签与合法的归一化矩形。'))
      return []
    }
    seenIds.add(region.id)
    return [region as unknown as VisualEvidenceRegion]
  })
}

const comparisonEntries = (input: VisualAuthenticityGateInput) => [
  { path: 'protectedComparisons.logo', value: input.protectedComparisons?.logo, changedCode: 'LOGO_DRIFT' as const, label: 'Logo' },
  { path: 'protectedComparisons.certificationMark', value: input.protectedComparisons?.certificationMark, changedCode: 'CERTIFICATION_MARK_DRIFT' as const, label: '认证标' },
  { path: 'protectedComparisons.packagingText', value: input.protectedComparisons?.packagingText, changedCode: 'PACKAGING_TEXT_DRIFT' as const, label: '包装文字' },
  { path: 'productComparisons.structure', value: input.productComparisons?.structure, changedCode: 'PRODUCT_STRUCTURE_CHANGED' as const, label: '商品结构' },
  { path: 'productComparisons.color', value: input.productComparisons?.color, changedCode: 'PRODUCT_COLOR_CHANGED' as const, label: '商品颜色' },
  { path: 'productComparisons.material', value: input.productComparisons?.material, changedCode: 'PRODUCT_MATERIAL_CHANGED' as const, label: '商品材质' },
]

/**
 * Deterministic evidence gate. It does not perform image recognition; it
 * validates the evidence produced by OCR/comparison providers and fails closed
 * when protected attributes changed or required evidence cannot be trusted.
 */
export function evaluateVisualAuthenticity(input: VisualAuthenticityGateInput): VisualAuthenticityGateResult {
  const findings: VisualAuthenticityFinding[] = []
  const manualReviewReasons: Array<{ path: string; label: string; confidence?: number }> = []
  const threshold = validConfidence(input.confidenceThreshold) ? input.confidenceThreshold : DEFAULT_CONFIDENCE_THRESHOLD

  validateImage(input.originalImage, 'originalImage', findings)
  if (input.candidateImage === undefined) findings.push(block('CANDIDATE_IMAGE_MISSING', 'candidateImage', '缺少候选图，不能宣称成片可用。'))
  else validateImage(input.candidateImage, 'candidateImage', findings)

  if (!isRecord(input.provenance) || !nonEmpty(input.provenance.source) || !nonEmpty(input.provenance.provider) || !nonEmpty(input.provenance.model)) {
    findings.push(block('EVIDENCE_MISSING', 'provenance', '必须提供原图来源、provider 和 model 证据。'))
  }

  const protectedRegions = validateRegions(input.protectedRegions, 'protectedRegions', findings)
  const editableRegions = validateRegions(input.editableRegions, 'editableRegions', findings)
  for (const protectedRegion of protectedRegions) {
    for (const editableRegion of editableRegions) {
      if (overlaps(protectedRegion.rect, editableRegion.rect)) {
        findings.push(block('REGION_POLICY_CONFLICT', 'editableRegions', '可编辑区域不能覆盖受保护区域。', { protectedRegionId: protectedRegion.id, protectedLabel: protectedRegion.label, editableRegionId: editableRegion.id }))
      }
    }
  }

  if (!Array.isArray(input.observedChanges)) {
    findings.push(block('EVIDENCE_MISSING', 'observedChanges', '必须提供候选图的观测变化区域。'))
  } else {
    if (input.observedChanges.length > MAX_EVIDENCE_ITEMS) {
      findings.push(block('REGION_INVALID', 'observedChanges', `观测变化数量超过安全上限 ${MAX_EVIDENCE_ITEMS}。`))
    }
    const changes = input.observedChanges.length > MAX_EVIDENCE_ITEMS ? [] : input.observedChanges
    changes.forEach((change, index) => {
      if (!isRecord(change) || !nonEmpty(change.id) || !nonEmpty(change.kind) || !CHANGE_KINDS.has(change.kind) || !validRect(change.rect)) {
        findings.push(block('REGION_INVALID', `observedChanges[${index}]`, '观测变化必须包含合法类型与归一化矩形。'))
        return
      }
      const changeRect = change.rect as VisualRect
      const changeKind = change.kind as ObservedVisualChange['kind']
      const protectedHit = protectedRegions.find(region => overlaps(region.rect, changeRect))
      if (protectedHit) {
        findings.push(block('PROTECTED_REGION_CHANGED', `observedChanges[${index}]`, `变化侵入受保护区域“${protectedHit.label}”。`, { changeId: change.id, changeKind, protectedRegionId: protectedHit.id, protectedLabel: protectedHit.label }))
      }
      if (!ALLOWED_VARIATIONS.has(changeKind) && editableRegions.length > 0 && !editableRegions.some(region => contains(region.rect, changeRect))) {
        findings.push(block('CHANGE_OUTSIDE_EDITABLE_REGION', `observedChanges[${index}]`, '非背景/光影/构图变化必须完整位于可编辑区域内。', { changeId: change.id, changeKind }))
      }
    })
  }

  if (!isRecord(input.ocr) || !Array.isArray(input.ocr.original) || !Array.isArray(input.ocr.candidate)) {
    findings.push(block('EVIDENCE_MISSING', 'ocr', '必须同时提供原图与候选图 OCR 文本及置信度。'))
  } else {
    ;(['original', 'candidate'] as const).forEach(side => {
      if (input.ocr[side].length > MAX_EVIDENCE_ITEMS) {
        findings.push(block('EVIDENCE_CONFIDENCE_INVALID', `ocr.${side}`, `OCR 证据数量超过安全上限 ${MAX_EVIDENCE_ITEMS}。`))
        return
      }
      input.ocr[side].forEach((entry, index) => {
        if (!isRecord(entry) || !nonEmpty(entry.text) || !validConfidence(entry.confidence)) {
          findings.push(block('EVIDENCE_CONFIDENCE_INVALID', `ocr.${side}[${index}]`, 'OCR 证据必须包含非空文本与 0–1 置信度。'))
        } else if (entry.confidence < threshold) {
          manualReviewReasons.push({ path: `ocr.${side}[${index}]`, label: `OCR ${side}: ${entry.text}`, confidence: entry.confidence })
        }
      })
    })
  }

  for (const entry of comparisonEntries(input)) {
    const comparison = entry.value
    if (!isRecord(comparison) || !nonEmpty(comparison.outcome) || !['unchanged', 'changed', 'not_applicable', 'unknown'].includes(comparison.outcome)) {
      findings.push(block('EVIDENCE_MISSING', entry.path, `缺少${entry.label}比较证据。`))
      continue
    }
    if (!validConfidence(comparison.confidence)) {
      findings.push(block('EVIDENCE_CONFIDENCE_INVALID', `${entry.path}.confidence`, `${entry.label}比较置信度必须在 0–1 之间。`))
      continue
    }
    if (comparison.outcome === 'changed') {
      findings.push(block(entry.changedCode, entry.path, `${entry.label}与原图不一致，候选图不可用。`, { originalValue: comparison.originalValue, candidateValue: comparison.candidateValue, confidence: comparison.confidence }))
    } else if (comparison.outcome === 'unknown' || comparison.confidence < threshold) {
      manualReviewReasons.push({ path: entry.path, label: entry.label, confidence: comparison.confidence })
    }
  }

  const review = input.humanReview
  let validHumanApproval = false
  if (!isRecord(review) || !nonEmpty(review.status)) {
    findings.push(block('EVIDENCE_MISSING', 'humanReview', '必须显式提供人工审核状态。'))
  } else if (review.status === 'rejected') {
    findings.push(block('HUMAN_REVIEW_REJECTED', 'humanReview.status', '人工审核已拒绝该候选图。'))
  } else if (review.status === 'approved') {
    const reviewedAt = nonEmpty(review.reviewedAt) ? Date.parse(review.reviewedAt) : Number.NaN
    const candidateHash = input.candidateImage && nonEmpty(input.candidateImage.hash) && SHA256.test(input.candidateImage.hash)
      ? input.candidateImage.hash.replace(/^sha256:/iu, '').toLowerCase()
      : ''
    const expectedAttestation = nonEmpty(review.reviewerId) && nonEmpty(review.reviewedAt) && candidateHash
      ? createHash('sha256').update(`${candidateHash}\0${review.reviewerId}\0${review.reviewedAt}`).digest('hex')
      : ''
    const actualAttestation = nonEmpty(review.attestationHash) ? review.attestationHash.replace(/^sha256:/iu, '').toLowerCase() : ''
    const attestationValid = nonEmpty(review.reviewerId) && Number.isFinite(reviewedAt) && reviewedAt <= Date.now() && reviewedAt >= 0 && actualAttestation === expectedAttestation
    if (!attestationValid) {
      findings.push(block('HUMAN_REVIEW_ATTESTATION_INVALID', 'humanReview', '人工批准缺少可校验的审核人、时间或签名哈希，按伪造审核阻断。'))
    } else {
      validHumanApproval = true
    }
  } else if (review.status !== 'pending' && review.status !== 'not_required') {
    findings.push(block('EVIDENCE_MISSING', 'humanReview.status', '人工审核状态无效。'))
  }

  if (manualReviewReasons.length > 0) {
    if (validHumanApproval) {
      findings.push(passed('LOW_CONFIDENCE_HUMAN_VERIFIED', 'humanReview', '低置信度证据已由有效人工审核凭据覆核。', { reasons: manualReviewReasons }))
    } else {
      findings.push(warn('LOW_CONFIDENCE_REQUIRES_HUMAN_REVIEW', 'humanReview', '存在低置信度或未知证据，必须人工审核，不得标记为成片可用。', { threshold, reasons: manualReviewReasons }))
    }
  }

  const hasBlock = findings.some(finding => finding.status === 'block')
  const hasWarn = findings.some(finding => finding.status === 'warn')
  if (!hasBlock && !hasWarn && !findings.some(finding => finding.status === 'pass')) {
    findings.push(passed('AUTHENTICITY_EVIDENCE_COMPLETE', 'visualAuthenticity', '视觉真实性证据完整：受保护属性未改变，候选图可进入下一交付阶段。'))
  }

  const status: VisualGateStatus = hasBlock ? 'block' : hasWarn ? 'warn' : 'pass'
  const blockingCodes = findings.filter(finding => finding.status === 'block').map(finding => finding.code)
  const nextActions: VisualAuthenticityNextAction[] = []
  if (blockingCodes.length > 0) {
    nextActions.push({ code: 'REGENERATE_OR_RESTORE_PROTECTED_CONTENT', priority: 'required', action: '恢复原图受保护属性、补齐缺失证据后重新生成并执行门禁。', findingCodes: [...new Set(blockingCodes)] })
  }
  if (hasWarn) {
    nextActions.push({ code: 'COMPLETE_HUMAN_VISUAL_REVIEW', priority: 'required', action: '由有权审核人对原图与候选图对比复核，并写入可校验审核凭据。', findingCodes: ['LOW_CONFIDENCE_REQUIRES_HUMAN_REVIEW'] })
  }

  return immutable({
    status,
    publishable: status === 'pass',
    requiresHumanReview: hasWarn,
    findings,
    nextActions,
    evaluatedAt: new Date().toISOString(),
  })
}
