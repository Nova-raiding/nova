export const DELIVERY_PLATFORMS = ['taobao', 'tmall', 'jd', 'pinduoduo', 'xiaohongshu', 'douyin'] as const
export type DeliveryPlatform = typeof DELIVERY_PLATFORMS[number]
export type DeliveryDevice = 'desktop' | 'mobile'

export interface PlatformDeliveryCapability {
  platform: DeliveryPlatform
  localPlanning: 'supported'
  officialDimensions: 'external_spec_required'
  productionDelivery: 'production_canary_required'
}

/**
 * Capability declarations intentionally contain no dimensions. Exact platform
 * dimensions must arrive with evidence in each planning request.
 */
export const PLATFORM_DELIVERY_CAPABILITIES: Readonly<Record<DeliveryPlatform, PlatformDeliveryCapability>> = {
  taobao: { platform: 'taobao', localPlanning: 'supported', officialDimensions: 'external_spec_required', productionDelivery: 'production_canary_required' },
  tmall: { platform: 'tmall', localPlanning: 'supported', officialDimensions: 'external_spec_required', productionDelivery: 'production_canary_required' },
  jd: { platform: 'jd', localPlanning: 'supported', officialDimensions: 'external_spec_required', productionDelivery: 'production_canary_required' },
  pinduoduo: { platform: 'pinduoduo', localPlanning: 'supported', officialDimensions: 'external_spec_required', productionDelivery: 'production_canary_required' },
  xiaohongshu: { platform: 'xiaohongshu', localPlanning: 'supported', officialDimensions: 'external_spec_required', productionDelivery: 'production_canary_required' },
  douyin: { platform: 'douyin', localPlanning: 'supported', officialDimensions: 'external_spec_required', productionDelivery: 'production_canary_required' },
}

export interface NormalizedSafeZone {
  x: number
  y: number
  width: number
  height: number
}

export interface DeliverySourceAsset {
  id: string
  width: number
  height: number
  safeZone?: NormalizedSafeZone
  productIds?: readonly string[]
}

export interface DeliverySpecificationEvidence {
  state: 'production_canary' | 'official_document' | 'unverified'
  reference: string
  checkedAt?: string
  /** Present when the specification came from the governed runtime registry. */
  binding?: {
    recordId: string
    revision: number
    immutableDigest: string
    sourceSha256: string
    evidenceArtifactSha256: string
    approvedAt: string
    expiresAt: string
  }
}

export interface DeliverySpecification {
  id: string
  device: DeliveryDevice
  width: number
  height: number
  safeZone?: NormalizedSafeZone
  maxCopyLength?: { headline?: number; subtitle?: number; cta?: number }
  formats?: readonly ('jpg' | 'png' | 'webp')[]
  maxFileBytes?: number
  evidence?: DeliverySpecificationEvidence
}

export interface DeliveryProductBindingInput {
  productId: string
  assetIds: readonly string[]
  sectionId?: string
}

export interface DeliveryVariantPlanInput {
  platform: string
  placement: string
  devices: readonly DeliveryDevice[]
  productCount: number
  sourceAssets: readonly DeliverySourceAsset[]
  specifications: readonly DeliverySpecification[]
  copy?: { headline?: string; subtitle?: string; cta?: string }
  navigation?: { requested: boolean; labels?: readonly string[] }
  section?: { id?: string; name?: string }
  productBindings?: readonly DeliveryProductBindingInput[]
  activity?: { startsAt?: string; endsAt?: string; countdown: 'none' | 'static_text' | 'live' }
}

export type DeliveryVariantFindingCode =
  | 'UNKNOWN_PLATFORM'
  | 'PLACEMENT_REQUIRED'
  | 'DEVICE_REQUIRED'
  | 'PRODUCT_COUNT_INVALID'
  | 'SOURCE_ASSET_MISSING'
  | 'SOURCE_ASSET_INVALID'
  | 'DELIVERY_SPEC_MISSING'
  | 'DELIVERY_SPEC_INVALID'
  | 'DELIVERY_SPEC_EXTERNALLY_UNVERIFIED'
  | 'SAFE_ZONE_MISSING'
  | 'FILE_POLICY_MISSING'
  | 'COPY_TOO_LONG'
  | 'NAVIGATION_LABELS_MISSING'
  | 'SECTION_REQUIRED'
  | 'PRODUCT_BINDING_MISSING'
  | 'PRODUCT_BINDING_INVALID'
  | 'ACTIVITY_WINDOW_INCOMPLETE'
  | 'ACTIVITY_WINDOW_INVALID'
  | 'RUNTIME_RENDERING_REQUIRED'

export interface DeliveryVariantFinding {
  code: DeliveryVariantFindingCode
  severity: 'error' | 'warning' | 'info'
  path: string
  message: string
  variantId?: string
  actual?: number
  limit?: number
}

export interface SourceCropPlan {
  sourceAssetId: string
  mode: 'none' | 'cover'
  cropAxis: 'none' | 'horizontal' | 'vertical'
  anchor: 'source_safe_zone_center' | 'center'
  requiresManualReview: boolean
}

export interface DeliveryVariant {
  id: string
  platform: string
  placement: string
  device: DeliveryDevice
  width: number
  height: number
  specificationId: string
  specificationEvidence?: DeliverySpecificationEvidence
  externallyUnverified: boolean
  safeZone?: NormalizedSafeZone
  crops: SourceCropPlan[]
  filePolicy?: { formats: readonly ('jpg' | 'png' | 'webp')[]; maxFileBytes: number }
}

export interface DeliveryCompositionPlan {
  layout: 'single_product' | 'multi_product_grid'
  navigation: { requested: boolean; labels: string[]; requiresRuntimeLinks: boolean }
  section?: { id?: string; name?: string }
  productBindings: DeliveryProductBindingInput[]
}

export interface DeliveryCountdownPlan {
  mode: 'none' | 'static_text' | 'live'
  requiresRuntimeRendering: boolean
  startsAt?: string
  endsAt?: string
}

export interface DeliveryVariantPlan {
  platform: string
  placement: string
  capability: PlatformDeliveryCapability | { platform: string; localPlanning: 'unsupported'; officialDimensions: 'unknown'; productionDelivery: 'blocked' }
  externallyUnverified: boolean
  readyForLocalPreview: boolean
  readyForProduction: boolean
  variants: DeliveryVariant[]
  composition: DeliveryCompositionPlan
  countdown: DeliveryCountdownPlan
  findings: DeliveryVariantFinding[]
}

const MAX_COLLECTION_ITEMS = 256
const MAX_PRODUCTS = 100
const MAX_TEXT_LENGTH = 16_384
const MAX_IDENTIFIER_LENGTH = 256
const MAX_DIMENSION = 100_000
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
const VALID_DEVICES = new Set<DeliveryDevice>(['desktop', 'mobile'])
const VALID_FORMATS = new Set<'jpg' | 'png' | 'webp'>(['jpg', 'png', 'webp'])

const immutable = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value && typeof value === 'object') {
    if (seen.has(value)) return value
    seen.add(value)
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child, seen)
  }
  return value
}

function boundedString(value: unknown, maximum = MAX_TEXT_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maximum
}

function validIdentifier(value: unknown) {
  return boundedString(value, MAX_IDENTIFIER_LENGTH) && value.trim().length > 0
}

function isPlatform(value: string): value is DeliveryPlatform {
  return (DELIVERY_PLATFORMS as readonly string[]).includes(value)
}

function safeZoneValid(value?: NormalizedSafeZone) {
  return Boolean(value && [value.x, value.y, value.width, value.height].every(Number.isFinite) && value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0 && value.x + value.width <= 1 && value.y + value.height <= 1)
}

function textLength(value?: string) {
  if (value === undefined) return 0
  if (!boundedString(value)) return MAX_TEXT_LENGTH + 1
  return [...value.normalize('NFKC')].length
}

function cropPlan(asset: DeliverySourceAsset, targetWidth: number, targetHeight: number, multiProduct: boolean): SourceCropPlan {
  const sourceRatio = asset.width / asset.height
  const targetRatio = targetWidth / targetHeight
  const sameRatio = Math.abs(sourceRatio - targetRatio) / targetRatio <= 0.01
  return {
    sourceAssetId: asset.id,
    mode: sameRatio ? 'none' : 'cover',
    cropAxis: sameRatio ? 'none' : sourceRatio > targetRatio ? 'horizontal' : 'vertical',
    anchor: safeZoneValid(asset.safeZone) ? 'source_safe_zone_center' : 'center',
    requiresManualReview: multiProduct || !sameRatio && !safeZoneValid(asset.safeZone),
  }
}

function normalizedIso(value?: string) {
  if (!value || Number.isNaN(Date.parse(value))) return undefined
  return new Date(value).toISOString()
}

function composition(input: DeliveryVariantPlanInput, findings: DeliveryVariantFinding[]): DeliveryCompositionPlan {
  const multiProduct = input.productCount > 1
  const rawLabels = input.navigation?.labels ?? []
  if (rawLabels.length > MAX_COLLECTION_ITEMS) findings.push({ code: 'NAVIGATION_LABELS_MISSING', severity: 'error', path: 'navigation.labels', message: '导航标签数量超过安全上限' })
  const labels = rawLabels.slice(0, MAX_COLLECTION_ITEMS).filter(label => boundedString(label, MAX_IDENTIFIER_LENGTH)).map(label => label.trim()).filter(Boolean)
  if (input.navigation?.requested && !labels.length) findings.push({ code: 'NAVIGATION_LABELS_MISSING', severity: 'error', path: 'navigation.labels', message: '已请求导航，但没有提供导航标签' })
  const sectionId = boundedString(input.section?.id, MAX_IDENTIFIER_LENGTH) ? input.section!.id!.trim() : ''
  const sectionName = boundedString(input.section?.name, MAX_IDENTIFIER_LENGTH) ? input.section!.name!.trim() : ''
  if (multiProduct && !sectionId && !sectionName) findings.push({ code: 'SECTION_REQUIRED', severity: 'error', path: 'section', message: '多商品 Banner/广告必须绑定明确专区' })
  const rawBindings = input.productBindings ?? []
  if (rawBindings.length > MAX_PRODUCTS) findings.push({ code: 'PRODUCT_BINDING_INVALID', severity: 'error', path: 'productBindings', message: '商品绑定数量超过安全上限' })
  const bindings = rawBindings.slice(0, MAX_PRODUCTS).map(binding => ({ ...binding, productId: boundedString(binding.productId, MAX_IDENTIFIER_LENGTH) ? binding.productId.trim() : '', assetIds: Array.isArray(binding.assetIds) ? [...binding.assetIds.slice(0, MAX_COLLECTION_ITEMS)] : [] }))
  if (multiProduct && bindings.length !== input.productCount) findings.push({ code: 'PRODUCT_BINDING_MISSING', severity: 'error', path: 'productBindings', message: `商品数量为 ${input.productCount}，但只有 ${bindings.length} 个商品绑定` })
  const scopedAssets = input.sourceAssets.slice(0, MAX_COLLECTION_ITEMS)
  const assets = new Set(scopedAssets.map(asset => asset.id))
  const assetsById = new Map(scopedAssets.map(asset => [asset.id, asset]))
  const seenProducts = new Set<string>()
  bindings.forEach((binding, index) => {
    const invalid = !binding.productId || seenProducts.has(binding.productId) || !binding.assetIds.length || binding.assetIds.some(assetId => {
      if (!validIdentifier(assetId)) return true
      if (!assets.has(assetId)) return true
      const declaredProducts = assetsById.get(assetId)?.productIds
      return Boolean(declaredProducts?.length && !declaredProducts.includes(binding.productId))
    })
    if (invalid) findings.push({ code: 'PRODUCT_BINDING_INVALID', severity: 'error', path: `productBindings[${index}]`, message: '商品绑定必须使用唯一商品 ID，并引用当前请求中的素材' })
    seenProducts.add(binding.productId)
  })
  return { layout: multiProduct ? 'multi_product_grid' : 'single_product', navigation: { requested: input.navigation?.requested ?? false, labels, requiresRuntimeLinks: input.navigation?.requested ?? false }, ...(input.section ? { section: { ...(sectionId ? { id: sectionId } : {}), ...(sectionName ? { name: sectionName } : {}) } } : {}), productBindings: bindings }
}

function countdown(input: DeliveryVariantPlanInput, findings: DeliveryVariantFinding[]): DeliveryCountdownPlan {
  const mode = input.activity?.countdown ?? 'none'
  if (mode === 'none') return { mode, requiresRuntimeRendering: false }
  const startsAt = normalizedIso(input.activity?.startsAt)
  const endsAt = normalizedIso(input.activity?.endsAt)
  if (!startsAt || !endsAt) findings.push({ code: 'ACTIVITY_WINDOW_INCOMPLETE', severity: 'error', path: 'activity', message: '倒计时需要完整且可解析的活动开始、结束时间' })
  else if (Date.parse(startsAt) >= Date.parse(endsAt)) findings.push({ code: 'ACTIVITY_WINDOW_INVALID', severity: 'error', path: 'activity', message: '活动结束时间必须晚于开始时间' })
  if (mode === 'live') findings.push({ code: 'RUNTIME_RENDERING_REQUIRED', severity: 'info', path: 'activity.countdown', message: '实时倒计时不能烘焙进静态图片，必须由运行时组件渲染' })
  return { mode, requiresRuntimeRendering: mode === 'live', ...(startsAt ? { startsAt } : {}), ...(endsAt ? { endsAt } : {}) }
}

export function planDeliveryVariants(input: DeliveryVariantPlanInput): DeliveryVariantPlan {
  const findings: DeliveryVariantFinding[] = []
  const platform = boundedString(input.platform, MAX_IDENTIFIER_LENGTH) ? input.platform.trim().normalize('NFKC').toLocaleLowerCase('en-US') : ''
  const placement = boundedString(input.placement, MAX_IDENTIFIER_LENGTH) ? input.placement.trim() : ''
  const capability = isPlatform(platform)
    ? { ...PLATFORM_DELIVERY_CAPABILITIES[platform] }
    : { platform, localPlanning: 'unsupported' as const, officialDimensions: 'unknown' as const, productionDelivery: 'blocked' as const }
  if (!isPlatform(platform)) findings.push({ code: 'UNKNOWN_PLATFORM', severity: 'error', path: 'platform', message: `未知平台 ${platform || '(empty)'}；不能推断平台规格` })
  if (!placement) findings.push({ code: 'PLACEMENT_REQUIRED', severity: 'error', path: 'placement', message: '必须提供明确 placement' })
  const rawDevices = Array.isArray(input.devices) ? input.devices : []
  const devices = rawDevices.length <= MAX_COLLECTION_ITEMS ? [...new Set(rawDevices.filter(device => VALID_DEVICES.has(device)))] : []
  if (!devices.length) findings.push({ code: 'DEVICE_REQUIRED', severity: 'error', path: 'devices', message: '至少需要 desktop 或 mobile 之一' })
  if (!Number.isSafeInteger(input.productCount) || input.productCount < 1 || input.productCount > MAX_PRODUCTS) findings.push({ code: 'PRODUCT_COUNT_INVALID', severity: 'error', path: 'productCount', message: '商品数量必须是安全范围内的正整数' })
  const sourceAssets: readonly DeliverySourceAsset[] = Array.isArray(input.sourceAssets) && input.sourceAssets.length <= MAX_COLLECTION_ITEMS ? input.sourceAssets : []
  if (!sourceAssets.length) findings.push({ code: 'SOURCE_ASSET_MISSING', severity: 'error', path: 'sourceAssets', message: '至少需要一个来源素材，且数量不得超过安全上限' })
  const seenAssetIds = new Set<string>()
  sourceAssets.forEach((asset, index) => {
    if (!validIdentifier(asset.id) || seenAssetIds.has(asset.id) || !Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width < 1 || asset.height < 1 || asset.width > MAX_DIMENSION || asset.height > MAX_DIMENSION || asset.safeZone && !safeZoneValid(asset.safeZone) || asset.productIds && (asset.productIds.length > MAX_PRODUCTS || asset.productIds.some(id => !validIdentifier(id)))) findings.push({ code: 'SOURCE_ASSET_INVALID', severity: 'error', path: `sourceAssets[${index}]`, message: '素材必须有唯一 ID、安全范围内的正整数尺寸和有效作用域/安全区' })
    seenAssetIds.add(asset.id)
  })

  const planComposition = composition(input, findings)
  const countdownPlan = countdown(input, findings)
  const variants: DeliveryVariant[] = []
  const allSpecifications: readonly DeliverySpecification[] = Array.isArray(input.specifications) && input.specifications.length <= MAX_COLLECTION_ITEMS ? input.specifications : []
  if (allSpecifications.length !== input.specifications.length) findings.push({ code: 'DELIVERY_SPEC_INVALID', severity: 'error', path: 'specifications', message: '交付规格数量超过安全上限' })
  for (const device of devices) {
    const specifications = allSpecifications.filter(specification => specification.device === device)
    if (!specifications.length) findings.push({ code: 'DELIVERY_SPEC_MISSING', severity: 'error', path: `specifications.${device}`, message: `${device} 没有输入规格；不会推断或虚构官方尺寸` })
    specifications.forEach((specification, index) => {
      const variantId = `${platform || 'unknown'}-${placement || 'unknown'}-${device}-${specification.width}x${specification.height}-${index + 1}`
      const dimensionValid = validIdentifier(specification.id) && Number.isSafeInteger(specification.width) && Number.isSafeInteger(specification.height) && specification.width > 0 && specification.height > 0 && specification.width <= MAX_DIMENSION && specification.height <= MAX_DIMENSION
      if (!dimensionValid || specification.safeZone && !safeZoneValid(specification.safeZone)) {
        findings.push({ code: 'DELIVERY_SPEC_INVALID', severity: 'error', path: `specifications.${device}[${index}]`, message: '交付规格必须有 ID、正整数尺寸和有效归一化安全区', variantId })
        return
      }
      const externallyUnverified = specification.evidence?.state !== 'production_canary' || !validIdentifier(specification.evidence?.reference)
      if (externallyUnverified) findings.push({ code: 'DELIVERY_SPEC_EXTERNALLY_UNVERIFIED', severity: 'error', path: `specifications.${device}[${index}].evidence`, message: '该规格尚无真实 production canary 证据，不能声称为已验证官方规格', variantId })
      if (!specification.safeZone) findings.push({ code: 'SAFE_ZONE_MISSING', severity: Object.values(input.copy ?? {}).some(Boolean) ? 'error' : 'warning', path: `specifications.${device}[${index}].safeZone`, message: '未提供目标安全区，含文字版本不能进入生产交付', variantId })
      const formats: Array<'jpg' | 'png' | 'webp'> | undefined = specification.formats?.length && specification.formats.length <= 3 && specification.formats.every(format => VALID_FORMATS.has(format)) ? [...new Set(specification.formats)] : undefined
      const filePolicyValid = Boolean(formats?.length && Number.isSafeInteger(specification.maxFileBytes) && specification.maxFileBytes! > 0 && specification.maxFileBytes! <= MAX_FILE_BYTES)
      if (!filePolicyValid) findings.push({ code: 'FILE_POLICY_MISSING', severity: 'error', path: `specifications.${device}[${index}]`, message: '缺少文件格式或最大字节限制，不能形成可交付文件', variantId })
      const limits = specification.maxCopyLength
      for (const field of ['headline', 'subtitle', 'cta'] as const) {
        const actual = textLength(input.copy?.[field]); const limit = limits?.[field]
        if (actual > 0 && (!Number.isInteger(limit) || limit! < 1)) findings.push({ code: 'DELIVERY_SPEC_INVALID', severity: 'error', path: `specifications.${device}[${index}].maxCopyLength.${field}`, message: `${field} 有内容但缺少有效长度限制`, variantId, actual })
        else if (limit !== undefined && actual > limit) findings.push({ code: 'COPY_TOO_LONG', severity: 'error', path: `copy.${field}`, message: `${field} 长度 ${actual} 超过 ${device} 规格上限 ${limit}`, variantId, actual, limit })
      }
      variants.push({ id: variantId, platform, placement, device, width: specification.width, height: specification.height, specificationId: specification.id, ...(specification.evidence ? { specificationEvidence: { ...specification.evidence } } : {}), externallyUnverified, ...(specification.safeZone ? { safeZone: { ...specification.safeZone } } : {}), crops: sourceAssets.map(asset => cropPlan(asset, specification.width, specification.height, input.productCount > 1)), ...(filePolicyValid ? { filePolicy: { formats: formats!, maxFileBytes: specification.maxFileBytes! } } : {}) })
    })
  }
  const externallyUnverified = !isPlatform(platform) || variants.length === 0 || variants.some(variant => variant.externallyUnverified) || findings.some(finding => finding.code === 'DELIVERY_SPEC_MISSING')
  const hasErrors = findings.some(finding => finding.severity === 'error')
  return immutable({ platform, placement, capability, externallyUnverified, readyForLocalPreview: variants.length > 0 && !findings.some(finding => ['UNKNOWN_PLATFORM', 'DELIVERY_SPEC_INVALID', 'SOURCE_ASSET_MISSING', 'SOURCE_ASSET_INVALID'].includes(finding.code)), readyForProduction: variants.length > 0 && !hasErrors && !externallyUnverified, variants, composition: planComposition, countdown: countdownPlan, findings })
}
