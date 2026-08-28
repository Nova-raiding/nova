/**
 * Domain-only contracts for one-sentence multimodal generation.
 *
 * The module deliberately contains no model, storage, HTTP, or image/video
 * processing code. It describes requests and validates the invariants that a
 * transport or application layer must preserve.
 */

export type GenerationModality = 'text' | 'image' | 'video'

export type CapabilityStage = 'available' | 'planned'

export type VideoOutput = 'script' | 'storyboard' | 'rendering'

export interface CapabilityDeclaration {
  readonly id: string
  readonly modality: GenerationModality
  readonly output: 'text' | 'image' | VideoOutput
  readonly stage: CapabilityStage
  readonly oneSentence: true
  readonly description: string
}

/** The public, staged promise of this domain module. */
export const ONE_SENTENCE_CAPABILITIES: readonly CapabilityDeclaration[] = [
  {
    id: 'one_sentence_text',
    modality: 'text',
    output: 'text',
    stage: 'available',
    oneSentence: true,
    description: '一句话生成营销文案。',
  },
  {
    id: 'one_sentence_image',
    modality: 'image',
    output: 'image',
    stage: 'available',
    oneSentence: true,
    description: '一句话生成营销图片候选。',
  },
  {
    id: 'one_sentence_video_script',
    modality: 'video',
    output: 'script',
    stage: 'available',
    oneSentence: true,
    description: '一句话生成视频脚本。',
  },
  {
    id: 'one_sentence_video_storyboard',
    modality: 'video',
    output: 'storyboard',
    stage: 'available',
    oneSentence: true,
    description: '一句话生成视频分镜。',
  },
  {
    id: 'one_sentence_video_rendering',
    modality: 'video',
    output: 'rendering',
    stage: 'planned',
    oneSentence: true,
    description: '视频成片渲染为后续能力，当前不可执行。',
  },
] as const

export interface SnapshotRef {
  readonly id: string
  readonly version: string
  readonly hash?: string
}

export interface GenerationContext {
  readonly brand: SnapshotRef
  readonly product: SnapshotRef
  readonly rules: readonly SnapshotRef[]
}

export interface TextGenerationRequest {
  readonly kind: 'generation'
  readonly modality: 'text'
  readonly prompt: string
  readonly context: GenerationContext
}

export interface ImageGenerationRequest {
  readonly kind: 'generation'
  readonly modality: 'image'
  readonly prompt: string
  readonly context: GenerationContext
}

export interface VideoGenerationRequest {
  readonly kind: 'generation'
  readonly modality: 'video'
  readonly prompt: string
  readonly output: 'script' | 'storyboard' | 'rendering'
  /** Always explicit so a caller cannot mistake a plan for a rendered video. */
  readonly rendering: 'planned' | 'requested'
  readonly context: GenerationContext
}

export type OneSentenceGenerationRequest =
  | TextGenerationRequest
  | ImageGenerationRequest
  | VideoGenerationRequest

export interface ImageRef {
  readonly id: string
  readonly uri: string
  readonly width: number
  readonly height: number
}

export interface NormalizedRect {
  /** Coordinates are normalized to the source image: 0 <= x/y <= 1. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ImageRegion {
  readonly id: string
  readonly rect: NormalizedRect
  readonly label?: string
}

export interface ImageEditConstraints {
  /** If present, the requested region must be fully inside one allowed region. */
  readonly editableRegions?: readonly ImageRegion[]
  /** Requested edits may not overlap any of these regions. */
  readonly nonModifiableRegions?: readonly ImageRegion[]
}

export interface ImageLocalEditRequest {
  readonly kind: 'image_local_edit'
  readonly id: string
  readonly sourceImage: ImageRef
  readonly prompt: string
  readonly region: ImageRegion
  readonly constraints: ImageEditConstraints
  readonly context: GenerationContext
}

export interface ImageEditCandidate {
  readonly kind: 'image_candidate'
  readonly id: string
  readonly sourceImageId: string
  readonly prompt: string
  readonly region: ImageRegion
  readonly context: GenerationContext
  readonly status: 'candidate'
  readonly originalPreserved: true
}

export type MultimodalValue =
  | CapabilityDeclaration
  | GenerationContext
  | OneSentenceGenerationRequest
  | ImageLocalEditRequest
  | ImageEditCandidate

export interface ValidationIssue {
  readonly code:
  | 'INVALID_CONTEXT'
  | 'INVALID_SNAPSHOT_REFERENCE'
  | 'INVALID_PROMPT'
  | 'INVALID_VIDEO_OUTPUT'
  | 'INVALID_IMAGE'
  | 'INVALID_REGION'
  | 'REGION_OUTSIDE_EDITABLE_AREA'
  | 'REGION_OVERLAPS_NON_MODIFIABLE_AREA'
  | 'VIDEO_RENDERING_NOT_AVAILABLE'
  readonly path: string
  readonly message: string
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }

const issue = (
  code: ValidationIssue['code'],
  path: string,
  message: string,
): ValidationIssue => ({ code, path, message })

const success = <T>(value: T): ValidationResult<T> => ({ ok: true, value })

const failure = <T>(...issues: ValidationIssue[]): ValidationResult<T> => ({ ok: false, issues })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const validateSnapshotRef = (value: unknown, path: string): ValidationIssue[] => {
  if (!isRecord(value) || !nonEmptyString(value.id) || !nonEmptyString(value.version)) {
    return [issue('INVALID_SNAPSHOT_REFERENCE', path, '快照引用必须包含非空 id 和 version。')]
  }
  if (value.hash !== undefined && !nonEmptyString(value.hash)) {
    return [issue('INVALID_SNAPSHOT_REFERENCE', `${path}.hash`, '快照 hash 为空时应省略，而不是传空字符串。')]
  }
  return []
}

export const validateGenerationContext = (value: unknown): ValidationResult<GenerationContext> => {
  if (!isRecord(value)) return failure(issue('INVALID_CONTEXT', '', '生成上下文必须是对象。'))

  const issues = [
    ...validateSnapshotRef(value.brand, 'brand'),
    ...validateSnapshotRef(value.product, 'product'),
  ]
  if (!Array.isArray(value.rules) || value.rules.length === 0) {
    issues.push(issue('INVALID_CONTEXT', 'rules', '生成上下文至少需要一个规则快照引用。'))
  } else {
    value.rules.forEach((rule, index) => {
      issues.push(...validateSnapshotRef(rule, `rules[${index}]`))
    })
  }

  return issues.length === 0
    ? success(value as unknown as GenerationContext)
    : failure(...issues)
}

const validatePrompt = (prompt: unknown): ValidationIssue[] =>
  nonEmptyString(prompt)
    ? []
    : [issue('INVALID_PROMPT', 'prompt', '一句话需求不能为空。')]

const validateImageRef = (value: unknown): ValidationIssue[] => {
  if (!isRecord(value) || !nonEmptyString(value.id) || !nonEmptyString(value.uri)) {
    return [issue('INVALID_IMAGE', 'sourceImage', '图片必须包含非空 id 和 uri。')]
  }
  if (!isFiniteNumber(value.width) || value.width <= 0) {
    return [issue('INVALID_IMAGE', 'sourceImage.width', '图片宽度必须是正数。')]
  }
  if (!isFiniteNumber(value.height) || value.height <= 0) {
    return [issue('INVALID_IMAGE', 'sourceImage.height', '图片高度必须是正数。')]
  }
  return []
}

const rectIsValid = (rect: unknown): rect is NormalizedRect => {
  if (!isRecord(rect)) return false
  const { x, y, width, height } = rect
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return false
  return x >= 0 && y >= 0 && width > 0 && height > 0 &&
    x + width <= 1 && y + height <= 1
}

const validateRegion = (value: unknown, path: string): ValidationIssue[] => {
  if (!isRecord(value) || !nonEmptyString(value.id) || !rectIsValid(value.rect)) {
    return [issue('INVALID_REGION', path, '区域必须包含 id，并且是图像范围内的非空归一化矩形。')]
  }
  return []
}

const contains = (outer: NormalizedRect, inner: NormalizedRect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

const overlaps = (left: NormalizedRect, right: NormalizedRect): boolean =>
  left.x < right.x + right.width &&
  left.x + left.width > right.x &&
  left.y < right.y + right.height &&
  left.y + left.height > right.y

const contextIssues = (context: unknown): ValidationIssue[] => {
  const result = validateGenerationContext(context)
  return result.ok ? [] : [...result.issues]
}

export const validateImageEditRequest = (
  request: unknown,
): ValidationResult<ImageLocalEditRequest> => {
  if (!isRecord(request)) return failure(issue('INVALID_IMAGE', '', '图片局部修改请求必须是对象。'))

  const issues = [
    ...contextIssues(request.context),
    ...validatePrompt(request.prompt),
    ...validateImageRef(request.sourceImage),
    ...validateRegion(request.region, 'region'),
  ]
  const constraints = request.constraints
  if (!isRecord(constraints)) {
    issues.push(issue('INVALID_REGION', 'constraints', '必须提供图片区域修改约束。'))
  } else {
    const editableRegions = constraints.editableRegions
    const protectedRegions = constraints.nonModifiableRegions
    if (editableRegions !== undefined && !Array.isArray(editableRegions)) {
      issues.push(issue('INVALID_REGION', 'constraints.editableRegions', '可修改区域必须是数组。'))
    }
    if (protectedRegions !== undefined && !Array.isArray(protectedRegions)) {
      issues.push(issue('INVALID_REGION', 'constraints.nonModifiableRegions', '不可修改区域必须是数组。'))
    }
    if (Array.isArray(editableRegions)) {
      editableRegions.forEach((region, index) => {
        issues.push(...validateRegion(region, `constraints.editableRegions[${index}]`))
      })
    }
    if (Array.isArray(protectedRegions)) {
      protectedRegions.forEach((region, index) => {
        issues.push(...validateRegion(region, `constraints.nonModifiableRegions[${index}]`))
      })
    }

    const targetRect = isRecord(request.region) && rectIsValid(request.region.rect)
      ? request.region.rect
      : undefined
    if (issues.length === 0 && targetRect !== undefined) {
      if (Array.isArray(editableRegions) && editableRegions.length > 0 &&
          !editableRegions.some(region => {
            if (!isRecord(region) || !rectIsValid(region.rect)) return false
            return contains(region.rect, targetRect)
          })) {
        issues.push(issue('REGION_OUTSIDE_EDITABLE_AREA', 'region', '请求区域必须完全位于可修改区域内。'))
      }
      if (Array.isArray(protectedRegions) && protectedRegions.some(region =>
        isRecord(region) && rectIsValid(region.rect) && overlaps(region.rect, targetRect))) {
        issues.push(issue('REGION_OVERLAPS_NON_MODIFIABLE_AREA', 'region', '请求区域不能覆盖不可修改区域。'))
      }
    }
  }

  return issues.length === 0
    ? success(request as unknown as ImageLocalEditRequest)
    : failure(...issues)
}

/** Create a normalized image annotation before attaching it to an edit request. */
export const createImageRegion = (input: {
  readonly id: string
  readonly rect: NormalizedRect
  readonly label?: string
}): ValidationResult<ImageRegion> => {
  const issues = validateRegion(input, 'region')
  return issues.length === 0 ? success(input) : failure(...issues)
}

export const createImageLocalEditRequest = (input: {
  readonly id: string
  readonly sourceImage: ImageRef
  readonly prompt: string
  readonly region: ImageRegion
  readonly constraints: ImageEditConstraints
  readonly context: GenerationContext
}): ValidationResult<ImageLocalEditRequest> =>
  validateImageEditRequest({ kind: 'image_local_edit', ...input })

export const createGenerationContext = (
  context: GenerationContext,
): ValidationResult<GenerationContext> => validateGenerationContext(context)

export const createTextGenerationRequest = (input: {
  readonly prompt: string
  readonly context: GenerationContext
}): ValidationResult<TextGenerationRequest> => {
  const contextResult = validateGenerationContext(input.context)
  const issues = [...validatePrompt(input.prompt), ...(contextResult.ok ? [] : contextResult.issues)]
  return issues.length === 0
    ? success({ kind: 'generation', modality: 'text', prompt: input.prompt, context: input.context })
    : failure(...issues)
}

export const createImageGenerationRequest = (input: {
  readonly prompt: string
  readonly context: GenerationContext
}): ValidationResult<ImageGenerationRequest> => {
  const contextResult = validateGenerationContext(input.context)
  const issues = [...validatePrompt(input.prompt), ...(contextResult.ok ? [] : contextResult.issues)]
  return issues.length === 0
    ? success({ kind: 'generation', modality: 'image', prompt: input.prompt, context: input.context })
    : failure(...issues)
}

export const createVideoGenerationRequest = (input: {
  readonly prompt: string
  readonly output: 'script' | 'storyboard' | 'rendering'
  readonly context: GenerationContext
}): ValidationResult<VideoGenerationRequest> => {
  const contextResult = validateGenerationContext(input.context)
  const issues = [...validatePrompt(input.prompt), ...(contextResult.ok ? [] : contextResult.issues)]
  const output = input.output
  if (output !== 'script' && output !== 'storyboard' && output !== 'rendering') {
    issues.push(issue('INVALID_VIDEO_OUTPUT', 'output', '视频输出只能是 script、storyboard 或 rendering。'))
    return failure(...issues)
  }
  if (output === 'rendering') {
    issues.push(issue('VIDEO_RENDERING_NOT_AVAILABLE', 'output', '当前视频只支持 script 或 storyboard，rendering 是后续能力。'))
    return failure(...issues)
  }
  if (issues.length > 0) return failure(...issues)
  return success({ kind: 'generation', modality: 'video', prompt: input.prompt, output, rendering: 'planned', context: input.context })
}

/** Build an explicit request for a rendered video. Transport availability is
 * checked by the application/provider layer; this domain function only
 * validates the same fact and rule snapshot boundary as script generation. */
export const createVideoRenderingRequest = (input: {
  readonly prompt: string
  readonly context: GenerationContext
}): ValidationResult<VideoGenerationRequest> => {
  const contextResult = validateGenerationContext(input.context)
  const issues = [...validatePrompt(input.prompt), ...(contextResult.ok ? [] : contextResult.issues)]
  return issues.length > 0
    ? failure(...issues)
    : success({ kind: 'generation', modality: 'video', prompt: input.prompt, output: 'rendering', rendering: 'requested', context: input.context })
}

export const createOneSentenceGenerationRequest = (
  input:
    | { readonly modality: 'text'; readonly prompt: string; readonly context: GenerationContext }
    | { readonly modality: 'image'; readonly prompt: string; readonly context: GenerationContext }
    | { readonly modality: 'video'; readonly prompt: string; readonly output: 'script' | 'storyboard' | 'rendering'; readonly context: GenerationContext },
): ValidationResult<OneSentenceGenerationRequest> => {
  if (input.modality === 'text') return createTextGenerationRequest(input)
  if (input.modality === 'image') return createImageGenerationRequest(input)
  return input.output === 'rendering' ? createVideoRenderingRequest(input) : createVideoGenerationRequest(input)
}

export const createImageEditCandidate = (
  request: ImageLocalEditRequest,
  candidateId = `image-candidate:${request.id}`,
): ValidationResult<ImageEditCandidate> => {
  const validated = validateImageEditRequest(request)
  if (!validated.ok) return validated
  if (!nonEmptyString(candidateId)) {
    return failure(issue('INVALID_IMAGE', 'candidateId', '候选图片 id 不能为空。'))
  }
  return success({
    kind: 'image_candidate',
    id: candidateId,
    sourceImageId: request.sourceImage.id,
    prompt: request.prompt,
    region: request.region,
    context: request.context,
    status: 'candidate',
    originalPreserved: true,
  })
}

/** JSON serialization is explicit at the boundary so no class/runtime state leaks out. */
export const serializeMultimodal = (value: MultimodalValue): string => JSON.stringify(value)

export const serializeGenerationContext = (context: GenerationContext): string =>
  serializeMultimodal(context)

export const serializeImageEditCandidate = (candidate: ImageEditCandidate): string =>
  serializeMultimodal(candidate)

export const parseGenerationContext = (serialized: string): ValidationResult<GenerationContext> => {
  try {
    return validateGenerationContext(JSON.parse(serialized) as unknown)
  } catch {
    return failure(issue('INVALID_CONTEXT', '', '生成上下文不是合法 JSON。'))
  }
}

export const getCapability = (id: string): CapabilityDeclaration | undefined =>
  ONE_SENTENCE_CAPABILITIES.find(capability => capability.id === id)
