export const VIDEO_DELIVERY_PLATFORMS = ['taobao', 'tmall', 'jd', 'pinduoduo', 'xiaohongshu', 'douyin'] as const
export type VideoDeliveryPlatform = typeof VIDEO_DELIVERY_PLATFORMS[number]

export interface VideoRect {
  x: number
  y: number
  width: number
  height: number
}

export interface VideoPlatformSpecification {
  durationsSeconds?: readonly number[]
  aspectRatios?: readonly string[]
  resolutions?: readonly { width: number; height: number }[]
  fps?: readonly number[]
  containers?: readonly ('mp4' | 'mov' | 'webm')[]
  maxFileBytes?: number
  maxSubtitleChars?: number
  subtitleSafeZone?: VideoRect
}

export interface VideoPlatformCapabilityEvidence {
  state: 'production_canary' | 'official_document' | 'test_e2e' | 'unverified'
  evidenceRef?: string
  verifiedAt?: string
  specification?: VideoPlatformSpecification
}

export interface VideoRightsEvidence {
  status: 'approved' | 'restricted' | 'unknown' | 'denied'
  evidenceRef?: string
  validUntil?: string
  platforms?: readonly string[]
}

export interface VideoPromotionScope {
  validFrom?: string
  validUntil?: string
  productIds?: readonly string[]
  skuIds?: readonly string[]
}

export interface VideoClaim {
  id: string
  kind: 'product_selling_point' | 'price' | 'promotion' | 'creative'
  text: string
  factSourceIds?: readonly string[]
  productIds?: readonly string[]
  skuIds?: readonly string[]
  promotion?: VideoPromotionScope
}

export interface VideoAudioTrack {
  id: string
  kind: 'music' | 'voiceover' | 'sound_effect'
  rights: VideoRightsEvidence
}

export interface VideoStoryboardScene {
  id: string
  startSeconds: number
  endSeconds: number
  visual: string
  productIds: readonly string[]
  skuIds: readonly string[]
  claims: readonly VideoClaim[]
  onScreenCopy?: string
  subtitle?: { text: string; safeZone?: VideoRect }
  transition?: { kind: string; durationSeconds?: number }
  audio?: readonly VideoAudioTrack[]
  people?: readonly { id: string; rights: VideoRightsEvidence }[]
  logos?: readonly { brandId: string; assetId: string; rights: VideoRightsEvidence }[]
}

export interface VideoCoverInput {
  assetId: string
  productIds: readonly string[]
  skuIds: readonly string[]
  factSourceIds: readonly string[]
  rights: VideoRightsEvidence
}

export interface VideoOutputInput {
  container: 'mp4' | 'mov' | 'webm'
  videoCodec: string
  audioCodec?: string
  fileBytes?: number
}

export interface VideoCompletionEvidence {
  rendering?: { state: 'real_render_passed' | 'model_preview' | 'failed'; artifactRef?: string; checksum?: string; rendererVersion?: string }
  ocr?: { state: 'passed' | 'failed' | 'not_run'; reportRef?: string }
  humanReview?: { state: 'approved' | 'rejected' | 'pending'; reviewRef?: string; actorId?: string; reviewedAt?: string }
}

export interface VideoStoryboardQualityInput {
  platform: string
  platformCapability: VideoPlatformCapabilityEvidence
  reviewAt: string
  durationSeconds: number
  aspectRatio: string
  resolution: { width: number; height: number }
  fps: number
  scenes: readonly VideoStoryboardScene[]
  cover: VideoCoverInput
  output: VideoOutputInput
  completionEvidence: VideoCompletionEvidence
  provenance: 'model_generated' | 'manual'
}

export type VideoQualityFindingCode =
  | 'PLATFORM_UNKNOWN'
  | 'PLATFORM_SPEC_EXTERNALLY_UNVERIFIED'
  | 'PLATFORM_SPEC_MISMATCH'
  | 'VIDEO_CONFIGURATION_INVALID'
  | 'SCENE_REQUIRED'
  | 'SCENE_TIME_INVALID'
  | 'TIMELINE_GAP'
  | 'TIMELINE_OVERLAP'
  | 'TIMELINE_DURATION_MISMATCH'
  | 'TRANSITION_MISSING'
  | 'SCENE_VISUAL_MISSING'
  | 'SELLING_POINT_SOURCE_MISSING'
  | 'PRICE_PROMOTION_SOURCE_MISSING'
  | 'CLAIM_SCOPE_INVALID'
  | 'PROMOTION_VALIDITY_MISSING'
  | 'PROMOTION_EXPIRED'
  | 'PROMOTION_SCOPE_MISSING'
  | 'UNDECLARED_PRICE_OR_PROMOTION_COPY'
  | 'SUBTITLE_SAFE_ZONE_MISSING'
  | 'SUBTITLE_SAFE_ZONE_INVALID'
  | 'SUBTITLE_TOO_LONG'
  | 'AUDIO_RIGHTS_INVALID'
  | 'PEOPLE_RIGHTS_INVALID'
  | 'LOGO_RIGHTS_INVALID'
  | 'COVER_RIGHTS_INVALID'
  | 'COVER_PRODUCT_MISMATCH'
  | 'COVER_SOURCE_MISSING'
  | 'OUTPUT_FORMAT_INVALID'
  | 'OUTPUT_FILE_TOO_LARGE'
  | 'REAL_RENDER_EVIDENCE_REQUIRED'
  | 'OCR_EVIDENCE_REQUIRED'
  | 'HUMAN_REVIEW_REQUIRED'

export interface VideoQualityFinding {
  code: VideoQualityFindingCode
  severity: 'block' | 'warn'
  path: string
  message: string
  nextAction: string
  sceneId?: string
}

export interface VideoStoryboardQualityReport {
  platform: string
  externallyUnverified: boolean
  storyboardValid: boolean
  publishable: boolean
  findings: VideoQualityFinding[]
  blocks: VideoQualityFinding[]
  warnings: VideoQualityFinding[]
  nextActions: string[]
}

const EPSILON = 0.001
const LOCAL_SUBTITLE_CHARS_PER_SECOND = 6
const LOCAL_SUBTITLE_MINIMUM_CHARS = 8
const MAX_SCENES = 256
const MAX_NESTED_ITEMS = 512
const MAX_TEXT_LENGTH = 16_384
const MAX_DIMENSION = 100_000
const MAX_DURATION_SECONDS = 24 * 60 * 60
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/iu

const immutable = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value && typeof value === 'object') {
    if (seen.has(value)) return value
    seen.add(value)
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child, seen)
  }
  return value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH
}

function finding(code: VideoQualityFindingCode, severity: 'block' | 'warn', path: string, message: string, nextAction: string, sceneId?: string): VideoQualityFinding {
  return { code, severity, path, message, nextAction, ...(sceneId ? { sceneId } : {}) }
}

function isKnownPlatform(value: string): value is VideoDeliveryPlatform {
  return (VIDEO_DELIVERY_PLATFORMS as readonly string[]).includes(value)
}

function validRect(rect?: VideoRect) {
  return Boolean(rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= 1 && rect.y + rect.height <= 1)
}

function inside(inner: VideoRect, outer: VideoRect) {
  return inner.x + EPSILON >= outer.x && inner.y + EPSILON >= outer.y && inner.x + inner.width <= outer.x + outer.width + EPSILON && inner.y + inner.height <= outer.y + outer.height + EPSILON
}

function parseTime(value?: string) {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function rightsFinding(rights: VideoRightsEvidence, platform: string, reviewAt: number, code: 'AUDIO_RIGHTS_INVALID' | 'PEOPLE_RIGHTS_INVALID' | 'LOGO_RIGHTS_INVALID' | 'COVER_RIGHTS_INVALID', path: string, label: string, sceneId?: string) {
  const validUntil = parseTime(rights.validUntil)
  const invalid = rights.status !== 'approved' || !rights.evidenceRef?.trim() || rights.validUntil !== undefined && validUntil === undefined || validUntil !== undefined && validUntil <= reviewAt || rights.platforms?.length && !rights.platforms.includes(platform)
  return invalid ? finding(code, 'block', path, `${label}缺少当前平台可用的有效授权证据`, `补充${label}授权文件、有效期和平台范围，或移除该素材`, sceneId) : undefined
}

function copyLooksCommercial(value?: string) {
  return Boolean(value && /(?:[$¥￥]\s*\d|\d+(?:\.\d+)?\s*元|\d(?:\.\d)?\s*折|优惠|满减|券|促销|coupon|discount|price|off\b)/iu.test(value))
}

function validatePlatformAndOutput(input: VideoStoryboardQualityInput, platform: string, findings: VideoQualityFinding[]) {
  const evidence = input.platformCapability
  const verifiedAt = parseTime(evidence.verifiedAt)
  const reviewAt = parseTime(input.reviewAt)
  const canary = isPlainRecord(evidence) && evidence.state === 'production_canary' && boundedText(evidence.evidenceRef) &&
    (evidence.verifiedAt === undefined || verifiedAt !== undefined && reviewAt !== undefined && verifiedAt <= reviewAt)
  if (!isKnownPlatform(platform)) findings.push(finding('PLATFORM_UNKNOWN', 'block', 'platform', `未知平台 ${platform || '(empty)'}`, '选择六个已声明平台之一，并提供对应能力证据'))
  if (!canary) findings.push(finding('PLATFORM_SPEC_EXTERNALLY_UNVERIFIED', 'block', 'platformCapability', '平台视频规格没有 production canary 证据', '完成目标平台真实规格与上传 canary 后重新评估'))
  const specification = evidence.specification
  if (canary && !specification) findings.push(finding('PLATFORM_SPEC_MISMATCH', 'block', 'platformCapability.specification', 'canary 证据没有绑定可校验的视频规格', '将时长、比例、分辨率、fps、格式和字幕约束绑定到 canary 证据'))
  if (specification) {
    if (specification.durationsSeconds?.length && !specification.durationsSeconds.includes(input.durationSeconds)) findings.push(finding('PLATFORM_SPEC_MISMATCH', 'block', 'durationSeconds', '视频时长不在已验证平台规格中', '改用已验证时长或重新取得平台 canary'))
    if (specification.aspectRatios?.length && !specification.aspectRatios.includes(input.aspectRatio)) findings.push(finding('PLATFORM_SPEC_MISMATCH', 'block', 'aspectRatio', '视频比例不在已验证平台规格中', '改用已验证比例'))
    if (specification.resolutions?.length && !specification.resolutions.some(value => value.width === input.resolution.width && value.height === input.resolution.height)) findings.push(finding('PLATFORM_SPEC_MISMATCH', 'block', 'resolution', '视频分辨率不在已验证平台规格中', '改用已验证分辨率'))
    if (specification.fps?.length && !specification.fps.includes(input.fps)) findings.push(finding('PLATFORM_SPEC_MISMATCH', 'block', 'fps', '视频帧率不在已验证平台规格中', '改用已验证帧率'))
    if (specification.containers?.length && !specification.containers.includes(input.output.container)) findings.push(finding('OUTPUT_FORMAT_INVALID', 'block', 'output.container', '输出封装格式不在已验证平台规格中', '改用平台 canary 验证过的格式'))
    if (specification.maxFileBytes !== undefined && (!Number.isFinite(input.output.fileBytes) || input.output.fileBytes! > specification.maxFileBytes)) findings.push(finding(input.output.fileBytes === undefined ? 'OUTPUT_FORMAT_INVALID' : 'OUTPUT_FILE_TOO_LARGE', 'block', 'output.fileBytes', input.output.fileBytes === undefined ? '缺少成片文件大小，无法验证交付限制' : '成片超过平台文件大小限制', '完成真实渲染后记录文件字节数，并压缩到平台限制内'))
  }
  const ratio = /^(\d+):(\d+)$/u.exec(input.aspectRatio)
  const declaredRatio = ratio ? Number(ratio[1]) / Number(ratio[2]) : undefined
  const renderedRatio = input.resolution.width / input.resolution.height
  const ratioMismatch = declaredRatio === undefined || !Number.isFinite(declaredRatio) || declaredRatio <= 0 || Math.abs(renderedRatio - declaredRatio) / declaredRatio > 0.01
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > MAX_DURATION_SECONDS || ratioMismatch || !Number.isSafeInteger(input.resolution.width) || !Number.isSafeInteger(input.resolution.height) || input.resolution.width <= 0 || input.resolution.height <= 0 || input.resolution.width > MAX_DIMENSION || input.resolution.height > MAX_DIMENSION || !Number.isFinite(input.fps) || input.fps <= 0 || input.fps > 1_000 || !['mp4', 'mov', 'webm'].includes(input.output.container) || !boundedText(input.output.videoCodec) || input.output.fileBytes !== undefined && (!Number.isSafeInteger(input.output.fileBytes) || input.output.fileBytes <= 0 || input.output.fileBytes > MAX_FILE_BYTES)) findings.push(finding('VIDEO_CONFIGURATION_INVALID', 'block', 'video', '时长、比例/分辨率、fps、格式或视频编码无效', '补齐相互一致的有效视频技术参数'))
}

function validateTimeline(input: VideoStoryboardQualityInput, findings: VideoQualityFinding[]) {
  if (!input.scenes.length) {
    findings.push(finding('SCENE_REQUIRED', 'block', 'scenes', '至少需要一个镜头', '生成完整分镜后重新检查'))
    return
  }
  const sceneIds = new Set<string>()
  input.scenes.forEach((scene, index) => {
    const path = `scenes[${index}]`
    if (!scene.id.trim() || sceneIds.has(scene.id) || !Number.isFinite(scene.startSeconds) || !Number.isFinite(scene.endSeconds) || scene.startSeconds < 0 || scene.endSeconds <= scene.startSeconds || scene.transition?.durationSeconds !== undefined && (!Number.isFinite(scene.transition.durationSeconds) || scene.transition.durationSeconds < 0 || scene.transition.durationSeconds > scene.endSeconds - scene.startSeconds)) findings.push(finding('SCENE_TIME_INVALID', 'block', path, '镜头 ID、时间范围或转场时长无效', '确保镜头 ID 唯一，起止时间有效且转场不长于镜头', scene.id))
    sceneIds.add(scene.id)
    if (!scene.visual.trim()) findings.push(finding('SCENE_VISUAL_MISSING', 'block', `${path}.visual`, '镜头缺少画面描述', '补充可执行且不臆造商品事实的画面描述', scene.id))
    if (index === 0 && scene.startSeconds > EPSILON) findings.push(finding('TIMELINE_GAP', 'block', `${path}.startSeconds`, '时间线没有从 0 秒开始', '将首镜头起点设为 0 秒', scene.id))
    const previous = input.scenes[index - 1]
    if (previous) {
      if (scene.startSeconds > previous.endSeconds + EPSILON) findings.push(finding('TIMELINE_GAP', 'block', `${path}.startSeconds`, `镜头 ${previous.id} 与 ${scene.id} 之间存在空洞`, '让相邻镜头首尾连续', scene.id))
      if (scene.startSeconds < previous.endSeconds - EPSILON) findings.push(finding('TIMELINE_OVERLAP', 'block', `${path}.startSeconds`, `镜头 ${previous.id} 与 ${scene.id} 时间重叠`, '移除重叠并保持单调时间线', scene.id))
      if (!previous.transition?.kind.trim()) findings.push(finding('TRANSITION_MISSING', 'warn', `scenes[${index - 1}].transition`, `镜头 ${previous.id} 未说明到下一镜头的转场`, '补充切换、淡入淡出或明确硬切', previous.id))
    }
  })
  const last = input.scenes[input.scenes.length - 1]!
  if (Math.abs(last.endSeconds - input.durationSeconds) > EPSILON) findings.push(finding('TIMELINE_DURATION_MISMATCH', 'block', 'durationSeconds', `最后镜头结束于 ${last.endSeconds}s，与总时长 ${input.durationSeconds}s 不一致`, '调整最后镜头或总时长，使二者完全一致', last.id))
}

function validateClaimsAndSubtitles(input: VideoStoryboardQualityInput, platform: string, reviewAt: number, findings: VideoQualityFinding[]) {
  const specification = input.platformCapability.specification
  input.scenes.forEach((scene, sceneIndex) => {
    const path = `scenes[${sceneIndex}]`
    scene.claims.forEach((claim, claimIndex) => {
      const claimPath = `${path}.claims[${claimIndex}]`
      if (claim.kind === 'product_selling_point' && !claim.factSourceIds?.length) findings.push(finding('SELLING_POINT_SOURCE_MISSING', 'block', `${claimPath}.factSourceIds`, `商品卖点“${claim.text}”没有事实来源`, '绑定商品事实或删除该卖点', scene.id))
      if (claim.kind !== 'creative' && (!claim.productIds?.length || !claim.skuIds?.length) || claim.productIds?.some(id => !scene.productIds.includes(id)) || claim.skuIds?.some(id => !scene.skuIds.includes(id))) findings.push(finding('CLAIM_SCOPE_INVALID', 'block', claimPath, '文案必须显式绑定且不得引用镜头范围外的商品或 SKU', '将 claim scope 限制到镜头已绑定商品/SKU', scene.id))
      if (claim.kind === 'price' || claim.kind === 'promotion') {
        if (!claim.factSourceIds?.length) findings.push(finding('PRICE_PROMOTION_SOURCE_MISSING', 'block', `${claimPath}.factSourceIds`, '价格/促销 claim 缺少活动或价格快照来源', '绑定已确认价格/促销快照', scene.id))
        const validFrom = parseTime(claim.promotion?.validFrom); const validUntil = parseTime(claim.promotion?.validUntil)
        if (validFrom === undefined || validUntil === undefined || validFrom >= validUntil) findings.push(finding('PROMOTION_VALIDITY_MISSING', 'block', `${claimPath}.promotion`, '价格/促销缺少完整有效期', '补充明确开始和结束时间', scene.id))
        else if (validUntil <= reviewAt) findings.push(finding('PROMOTION_EXPIRED', 'block', `${claimPath}.promotion.validUntil`, '价格/促销在审核时已经过期', '更新活动快照或移除价格促销表达', scene.id))
        const products = claim.promotion?.productIds; const skus = claim.promotion?.skuIds
        if (!products?.length || !skus?.length || products.some(id => !scene.productIds.includes(id)) || skus.some(id => !scene.skuIds.includes(id))) findings.push(finding('PROMOTION_SCOPE_MISSING', 'block', `${claimPath}.promotion`, '价格/促销必须绑定当前镜头内的商品和 SKU scope', '补齐活动适用商品和 SKU，并与镜头绑定一致', scene.id))
      }
    })
    if ((copyLooksCommercial(scene.onScreenCopy) || copyLooksCommercial(scene.subtitle?.text)) && !scene.claims.some(claim => claim.kind === 'price' || claim.kind === 'promotion')) findings.push(finding('UNDECLARED_PRICE_OR_PROMOTION_COPY', 'block', `${path}.onScreenCopy`, '画面或字幕包含价格/促销表达，但没有结构化价格/促销 claim', '补充有效期和 SKU scope，或移除价格促销文本', scene.id))
    if (scene.subtitle?.text) {
      const subtitlePath = `${path}.subtitle`
      if (!scene.subtitle.safeZone) findings.push(finding('SUBTITLE_SAFE_ZONE_MISSING', 'block', `${subtitlePath}.safeZone`, '字幕缺少归一化安全区', '提供字幕安全区并在真实渲染后复核', scene.id))
      else if (!validRect(scene.subtitle.safeZone) || specification?.subtitleSafeZone && !inside(scene.subtitle.safeZone, specification.subtitleSafeZone)) findings.push(finding('SUBTITLE_SAFE_ZONE_INVALID', 'block', `${subtitlePath}.safeZone`, '字幕安全区越界或超出平台已验证安全区', '将字幕移动到平台安全区内', scene.id))
      const localLimit = Math.max(LOCAL_SUBTITLE_MINIMUM_CHARS, Math.floor((scene.endSeconds - scene.startSeconds) * LOCAL_SUBTITLE_CHARS_PER_SECOND))
      const limit = specification?.maxSubtitleChars === undefined ? localLimit : Math.min(localLimit, specification.maxSubtitleChars)
      const actual = [...scene.subtitle.text.normalize('NFKC')].length
      if (actual > limit) findings.push(finding('SUBTITLE_TOO_LONG', 'block', `${subtitlePath}.text`, `字幕长度 ${actual} 超过当前镜头可读上限 ${limit}`, '缩短字幕或增加镜头展示时间', scene.id))
    }
    scene.audio?.forEach((track, index) => { const result = rightsFinding(track.rights, platform, reviewAt, 'AUDIO_RIGHTS_INVALID', `${path}.audio[${index}].rights`, `${track.kind} 音频`, scene.id); if (result) findings.push(result) })
    scene.people?.forEach((person, index) => { const result = rightsFinding(person.rights, platform, reviewAt, 'PEOPLE_RIGHTS_INVALID', `${path}.people[${index}].rights`, `人物 ${person.id}`, scene.id); if (result) findings.push(result) })
    scene.logos?.forEach((logo, index) => { const result = rightsFinding(logo.rights, platform, reviewAt, 'LOGO_RIGHTS_INVALID', `${path}.logos[${index}].rights`, `Logo ${logo.assetId}`, scene.id); if (result) findings.push(result) })
  })
}

function validateCover(input: VideoStoryboardQualityInput, platform: string, reviewAt: number, findings: VideoQualityFinding[]) {
  const products = new Set(input.scenes.flatMap(scene => scene.productIds))
  const skus = new Set(input.scenes.flatMap(scene => scene.skuIds))
  const coverPath = 'cover'
  if (!input.cover.assetId.trim() || !input.cover.productIds.length || input.cover.productIds.some(id => !products.has(id)) || input.cover.skuIds.some(id => !skus.has(id))) findings.push(finding('COVER_PRODUCT_MISMATCH', 'block', coverPath, '封面素材没有绑定分镜中的商品/SKU，或包含无关商品', '重新选择与分镜商品一致的封面素材'))
  if (!input.cover.factSourceIds.length) findings.push(finding('COVER_SOURCE_MISSING', 'block', `${coverPath}.factSourceIds`, '封面缺少商品事实来源', '绑定封面商品图和文字对应的事实来源'))
  const rights = rightsFinding(input.cover.rights, platform, reviewAt, 'COVER_RIGHTS_INVALID', `${coverPath}.rights`, '封面素材')
  if (rights) findings.push(rights)
}

function validateCompletionEvidence(input: VideoStoryboardQualityInput, reviewAt: number | undefined, findings: VideoQualityFinding[]) {
  const rendering = input.completionEvidence.rendering
  if (!isPlainRecord(rendering) || rendering.state !== 'real_render_passed' || !boundedText(rendering.artifactRef) || !boundedText(rendering.checksum) || !SHA256.test(rendering.checksum) || !boundedText(rendering.rendererVersion)) findings.push(finding('REAL_RENDER_EVIDENCE_REQUIRED', 'block', 'completionEvidence.rendering', input.provenance === 'model_generated' ? '模型生成的脚本/预览不等于真实成片' : '缺少真实渲染成片证据', '完成真实渲染并记录 artifact、SHA-256 checksum 和 renderer version'))
  const ocr = input.completionEvidence.ocr
  if (!isPlainRecord(ocr) || ocr.state !== 'passed' || !boundedText(ocr.reportRef)) findings.push(finding('OCR_EVIDENCE_REQUIRED', 'block', 'completionEvidence.ocr', '缺少成片 OCR 通过证据', '对真实成片执行 OCR，核对字幕、价格和包装文字'))
  const human = input.completionEvidence.humanReview
  const reviewedAt = parseTime(human?.reviewedAt)
  if (!isPlainRecord(human) || human.state !== 'approved' || !boundedText(human.reviewRef) || !boundedText(human.actorId) || reviewedAt === undefined || reviewAt !== undefined && reviewedAt > reviewAt) findings.push(finding('HUMAN_REVIEW_REQUIRED', 'block', 'completionEvidence.humanReview', '缺少评估时点之前可审计的人工成片批准', '由授权审核人查看真实成片并记录批准证据'))
}

function withinComplexityLimits(input: VideoStoryboardQualityInput) {
  if (!Array.isArray(input.scenes) || input.scenes.length > MAX_SCENES || !boundedText(input.platform) || !boundedText(input.aspectRatio) || !boundedText(input.reviewAt)) return false
  const scenes: readonly VideoStoryboardScene[] = input.scenes
  for (const scene of scenes) {
    if (!boundedText(scene.id) || !boundedText(scene.visual) || scene.onScreenCopy !== undefined && !boundedText(scene.onScreenCopy) || scene.subtitle?.text !== undefined && !boundedText(scene.subtitle.text)) return false
    const groups = [scene.productIds, scene.skuIds, scene.claims, scene.audio ?? [], scene.people ?? [], scene.logos ?? []]
    if (groups.some(group => !Array.isArray(group) || group.length > MAX_NESTED_ITEMS)) return false
    if (scene.claims.some(claim => !boundedText(claim.id) || !boundedText(claim.text) || [claim.factSourceIds ?? [], claim.productIds ?? [], claim.skuIds ?? [], claim.promotion?.productIds ?? [], claim.promotion?.skuIds ?? []].some(group => group.length > MAX_NESTED_ITEMS))) return false
  }
  return true
}

export function evaluateVideoStoryboardQuality(input: VideoStoryboardQualityInput): VideoStoryboardQualityReport {
  const findings: VideoQualityFinding[] = []
  const platform = typeof input.platform === 'string' && input.platform.length <= MAX_TEXT_LENGTH ? input.platform.trim().normalize('NFKC').toLocaleLowerCase('en-US') : ''
  if (!withinComplexityLimits(input)) {
    findings.push(finding('VIDEO_CONFIGURATION_INVALID', 'block', 'input', '输入文本或集合超过安全处理上限，或结构无效', '缩小分镜、文案和绑定集合后重试'))
    return immutable({ platform, externallyUnverified: true, storyboardValid: false, publishable: false, findings, blocks: findings, warnings: [], nextActions: [findings[0]!.nextAction] })
  }
  const reviewAt = parseTime(input.reviewAt)
  if (reviewAt === undefined) findings.push(finding('VIDEO_CONFIGURATION_INVALID', 'block', 'reviewAt', '审核时间无效', '提供带时区的 ISO 审核时间'))
  validatePlatformAndOutput(input, platform, findings)
  validateTimeline(input, findings)
  validateClaimsAndSubtitles(input, platform, reviewAt ?? Number.POSITIVE_INFINITY, findings)
  validateCover(input, platform, reviewAt ?? Number.POSITIVE_INFINITY, findings)
  validateCompletionEvidence(input, reviewAt, findings)
  const externallyUnverified = !isKnownPlatform(platform) || input.platformCapability.state !== 'production_canary' || !input.platformCapability.evidenceRef?.trim() || !input.platformCapability.specification
  const blocks = findings.filter(item => item.severity === 'block')
  const warnings = findings.filter(item => item.severity === 'warn')
  const completionCodes = new Set<VideoQualityFindingCode>(['PLATFORM_SPEC_EXTERNALLY_UNVERIFIED', 'REAL_RENDER_EVIDENCE_REQUIRED', 'OCR_EVIDENCE_REQUIRED', 'HUMAN_REVIEW_REQUIRED'])
  const storyboardValid = !blocks.some(item => !completionCodes.has(item.code))
  return immutable({ platform, externallyUnverified, storyboardValid, publishable: blocks.length === 0 && !externallyUnverified, findings, blocks, warnings, nextActions: [...new Set(findings.map(item => item.nextAction))] })
}
