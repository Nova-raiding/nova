import { createHash } from 'node:crypto'

export type AssetScanStatus = 'quarantined' | 'scanning' | 'clean' | 'blocked'
export type AssetRightsStatus = 'pending' | 'approved' | 'restricted' | 'rejected'
export type PreviewPlanStatus = 'ready' | 'blocked' | 'manual_required'

export interface AssetPreviewPlannerInput {
  readonly workspaceId: string
  readonly assetId: string
  readonly revision: number
  readonly sourceSha256: string
  readonly scanStatus: AssetScanStatus
  readonly rightsStatus: AssetRightsStatus
  readonly previewAllowed: boolean
  readonly declaredMimeType: string
  /** MIME detected from trusted magic-byte inspection, not the filename. */
  readonly detectedMimeType: string
  readonly extension: string
  readonly sizeBytes: number
  readonly uncompressedSizeBytes?: number
  readonly image?: { readonly width: number; readonly height: number }
  readonly document?: { readonly pageCount: number }
  readonly storageRef: { readonly provider: 's3' | 'local' | 'opaque'; readonly key: string; readonly bucket?: string }
}

export type PreviewJobKind = 'sanitize_svg' | 'image_thumbnail' | 'document_page_thumbnail' | 'safe_static_preview'
export type PreviewOutputFormat = 'svg' | 'webp' | 'jpeg' | 'png'

export interface AssetPreviewDerivativeJob {
  readonly id: string
  readonly kind: PreviewJobKind
  readonly targetKey: string
  readonly cacheKey: string
  readonly outputFormat: PreviewOutputFormat
  readonly width?: number
  readonly height?: number
  readonly page?: number
  readonly dependsOn?: readonly string[]
  readonly contentDisposition: 'inline'
  readonly contentHandling: {
    readonly activeContent: 'stripped'
    readonly macros: 'not_executed'
    readonly scripts: 'not_executed'
    readonly metadata: 'minimal'
  }
}

export interface AssetPreviewPlanFinding {
  readonly code:
  | 'SCAN_NOT_CLEAN'
  | 'PREVIEW_RIGHTS_DENIED'
  | 'SOURCE_IDENTITY_INVALID'
  | 'SOURCE_SIZE_INVALID'
  | 'STORAGE_PATH_INVALID'
  | 'EXECUTABLE_CONTENT_BLOCKED'
  | 'MIME_SIGNATURE_MISMATCH'
  | 'IMAGE_DIMENSIONS_REQUIRED'
  | 'PIXEL_BOMB_BLOCKED'
  | 'DOCUMENT_PAGE_COUNT_REQUIRED'
  | 'PAGE_BOMB_BLOCKED'
  | 'ARCHIVE_BOMB_BLOCKED'
  | 'FORMAT_UNSUPPORTED_MANUAL'
  | 'PDF_PAGE_LIMIT_APPLIED'
  | 'DOCUMENT_PAGE_LIMIT_APPLIED'
  | 'SVG_SANITIZATION_REQUIRED'
  | 'EXTERNAL_RENDERING_UNVERIFIED'
  readonly severity: 'block' | 'warning' | 'info'
  readonly path: string
  readonly message: string
}

export interface AssetPreviewPlan {
  readonly status: PreviewPlanStatus
  readonly source: { readonly sha256: string; readonly revision: number }
  readonly cacheKey: string
  readonly jobs: readonly AssetPreviewDerivativeJob[]
  readonly findings: readonly AssetPreviewPlanFinding[]
  readonly warnings: readonly string[]
  readonly externallyUnverified: readonly string[]
  readonly manifestPolicy: {
    readonly includesOriginalBody: false
    readonly includesCredentials: false
    readonly includesStorageRef: false
  }
}

const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/iu
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u
const MAX_IMAGE_BYTES = 50 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024
const MAX_COMPRESSION_RATIO = 100
const MAX_IMAGE_EDGE = 50_000
const MAX_IMAGE_PIXELS = 100_000_000
const MAX_DOCUMENT_PAGES = 1_000
const MAX_INPUT_TEXT = 2_048
const PDF_PREVIEW_PAGE_LIMIT = 5
const OFFICE_PREVIEW_PAGE_LIMIT = 3
const IMAGE_TARGET_EDGES = [320, 640, 1280] as const

const immutable = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value && typeof value === 'object') {
    if (seen.has(value)) return value
    seen.add(value)
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child, seen)
  }
  return value
}

const executableExtensions = new Set(['exe', 'com', 'dll', 'msi', 'scr', 'bat', 'cmd', 'ps1', 'sh', 'js', 'mjs', 'cjs', 'jar', 'app'])
const executableMimeTypes = new Set([
  'application/x-executable', 'application/x-msdownload', 'application/x-sh', 'application/x-powershell',
  'application/java-archive', 'text/javascript', 'application/javascript', 'text/html',
])

const expectedMimeByExtension: Readonly<Record<string, readonly string[]>> = {
  jpg: ['image/jpeg'], jpeg: ['image/jpeg'], png: ['image/png'], webp: ['image/webp'], gif: ['image/gif'],
  svg: ['image/svg+xml'], pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ai: ['application/postscript', 'application/pdf'], eps: ['application/postscript'],
}

const normalizeSha = (value: string) => value.replace(/^sha256:/iu, '').toLowerCase()
const boundedText = (value: unknown) => typeof value === 'string' && value.length <= MAX_INPUT_TEXT ? value : ''
const normalizeExtension = (value: unknown) => boundedText(value).trim().normalize('NFKC').toLowerCase().replace(/^\./u, '')
const normalizeMime = (value: unknown) => {
  const raw = boundedText(value).trim().toLowerCase()
  return raw.includes(';') ? '' : raw
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const unsafePath = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_INPUT_TEXT || value !== value.normalize('NFC') || /[%\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069]/u.test(value)) return true
  let decoded = value
  try {
    for (let index = 0; index < 3; index += 1) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    }
  } catch { return true }
  const normalized = decoded.replace(/\\/gu, '/')
  return !normalized || normalized.startsWith('/') || normalized.includes('\0') || normalized.split('/').some(segment => segment === '..' || segment === '.')
}

const finding = (
  code: AssetPreviewPlanFinding['code'],
  severity: AssetPreviewPlanFinding['severity'],
  path: string,
  message: string,
): AssetPreviewPlanFinding => ({ code, severity, path, message })

const contentHandling: AssetPreviewDerivativeJob['contentHandling'] = {
  activeContent: 'stripped', macros: 'not_executed', scripts: 'not_executed', metadata: 'minimal',
}

const fit = (width: number, height: number, edge: number) => {
  const scale = Math.min(1, edge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

const uniqueBy = <T>(values: readonly T[], key: (value: T) => string): T[] =>
  [...new Map(values.map(value => [key(value), value])).values()]

/**
 * Plans derivatives without exposing source storage references, original body,
 * extracted text, workbook cells, credentials, or provider responses.
 */
export function planAssetPreviews(input: AssetPreviewPlannerInput): AssetPreviewPlan {
  const findings: AssetPreviewPlanFinding[] = []
  const warnings: string[] = []
  const externallyUnverified = ['衍生文件尚未由渲染 worker 生成或重新扫描。']
  const extension = normalizeExtension(input.extension)
  const declaredMime = normalizeMime(input.declaredMimeType)
  const detectedMime = normalizeMime(input.detectedMimeType)
  const sourceSha = typeof input.sourceSha256 === 'string' ? normalizeSha(input.sourceSha256) : ''
  const source = { sha256: sourceSha, revision: input.revision }

  if (!SEGMENT.test(input.workspaceId) || !SEGMENT.test(input.assetId) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !SHA256.test(input.sourceSha256) || /^0{64}$/u.test(sourceSha)) {
    findings.push(finding('SOURCE_IDENTITY_INVALID', 'block', 'source', '工作区、素材 ID、revision 和 SHA-256 必须是合法且可稳定定址的。'))
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    findings.push(finding('SOURCE_SIZE_INVALID', 'block', 'sizeBytes', '素材大小必须是正整数字节。'))
  }
  const storageScopeValid = isPlainRecord(input.storageRef) && (input.storageRef.provider === 'opaque' || typeof input.storageRef.key === 'string' && input.storageRef.key.split('/', 1)[0] === input.workspaceId)
  if (!isPlainRecord(input.storageRef) || !['s3', 'local', 'opaque'].includes(input.storageRef.provider as string) || unsafePath(input.storageRef.key) || (input.storageRef.bucket !== undefined && unsafePath(input.storageRef.bucket)) || !storageScopeValid) {
    findings.push(finding('STORAGE_PATH_INVALID', 'block', 'storageRef', '存储引用不得为空、绝对路径或包含路径穿越。'))
  }
  if (input.scanStatus !== 'clean') findings.push(finding('SCAN_NOT_CLEAN', 'block', 'scanStatus', '只有 clean 素材可以生成预览衍生物。'))
  if (input.rightsStatus !== 'approved' || input.previewAllowed !== true) findings.push(finding('PREVIEW_RIGHTS_DENIED', 'block', 'rightsStatus', '素材权益未批准或未允许预览衍生。'))
  if (executableExtensions.has(extension) || executableMimeTypes.has(declaredMime) || executableMimeTypes.has(detectedMime)) {
    findings.push(finding('EXECUTABLE_CONTENT_BLOCKED', 'block', 'detectedMimeType', '可执行或脚本内容不得进入预览渲染链。'))
  }

  const expectedMime = expectedMimeByExtension[extension]
  if (!extension || !declaredMime || !detectedMime || !expectedMime || !expectedMime.includes(declaredMime) || !expectedMime.includes(detectedMime) || declaredMime !== detectedMime) {
    findings.push(finding('MIME_SIGNATURE_MISMATCH', 'block', 'detectedMimeType', '扩展名、声明 MIME 和魔数检测 MIME 必须一致且在支持列表中。'))
  }

  const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(extension)
  const isDocument = ['pdf', 'docx', 'xlsx'].includes(extension)
  const byteLimit = isImage ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES
  if (input.sizeBytes > byteLimit) findings.push(finding('SOURCE_SIZE_INVALID', 'block', 'sizeBytes', `素材超过 ${Math.round(byteLimit / 1024 / 1024)} MiB 预览上限。`))

  if (isImage) {
    const width = input.image?.width
    const height = input.image?.height
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width ?? 0) <= 0 || (height ?? 0) <= 0) {
      findings.push(finding('IMAGE_DIMENSIONS_REQUIRED', 'block', 'image', '图片预览必须提供可验证的正整数宽高。'))
    } else if (width! > MAX_IMAGE_EDGE || height! > MAX_IMAGE_EDGE || width! * height! > MAX_IMAGE_PIXELS) {
      findings.push(finding('PIXEL_BOMB_BLOCKED', 'block', 'image', '图片边长或总像素超过安全渲染上限。'))
    }
  }

  if (isDocument) {
    const pageCount = input.document?.pageCount
    if (!Number.isSafeInteger(pageCount) || (pageCount ?? 0) <= 0) {
      findings.push(finding('DOCUMENT_PAGE_COUNT_REQUIRED', 'block', 'document.pageCount', '文档必须提供可验证的正整数页数。'))
    } else if (pageCount! > MAX_DOCUMENT_PAGES) {
      findings.push(finding('PAGE_BOMB_BLOCKED', 'block', 'document.pageCount', '文档页数超过安全预览上限。'))
    }
    if (extension === 'docx' || extension === 'xlsx') {
      const expanded = input.uncompressedSizeBytes
      if (!Number.isSafeInteger(expanded) || (expanded ?? 0) <= 0 || expanded! > MAX_UNCOMPRESSED_BYTES || expanded! / input.sizeBytes > MAX_COMPRESSION_RATIO) {
        findings.push(finding('ARCHIVE_BOMB_BLOCKED', 'block', 'uncompressedSizeBytes', 'Office 文档必须提供安全的解压后大小，且不得超过解压比与容量上限。'))
      }
    }
  }

  const baseCacheKey = digest(JSON.stringify({ workspaceId: input.workspaceId, assetId: input.assetId, revision: input.revision, sourceSha, extension, declaredMime, detectedMime }))
  const baseTarget = `previews/${input.workspaceId}/${input.assetId}/r${input.revision}/${baseCacheKey.slice(0, 20)}`
  const blocked = findings.some(item => item.severity === 'block')
  if (blocked) return immutable({
    status: 'blocked', source, cacheKey: baseCacheKey, jobs: [], findings,
    warnings: findings.filter(item => item.severity === 'warning').map(item => item.message),
    externallyUnverified, manifestPolicy: { includesOriginalBody: false, includesCredentials: false, includesStorageRef: false },
  })

  if (extension === 'ai' || extension === 'eps') {
    const unsupported = finding('FORMAT_UNSUPPORTED_MANUAL', 'warning', 'extension', `${extension.toUpperCase()} 不进入自动渲染，需人工转为已扫描的安全静态格式。`)
    findings.push(unsupported)
    warnings.push(unsupported.message)
    return immutable({
      status: 'manual_required', source, cacheKey: baseCacheKey, jobs: [], findings, warnings, externallyUnverified,
      manifestPolicy: { includesOriginalBody: false, includesCredentials: false, includesStorageRef: false },
    })
  }

  const jobs: AssetPreviewDerivativeJob[] = []
  const addJob = (job: Omit<AssetPreviewDerivativeJob, 'id' | 'cacheKey' | 'contentDisposition' | 'contentHandling'>) => {
    const jobCacheKey = digest(JSON.stringify({ baseCacheKey, ...job }))
    jobs.push({ id: `preview-job:${jobCacheKey.slice(0, 24)}`, cacheKey: jobCacheKey, contentDisposition: 'inline', contentHandling, ...job })
  }

  let imageDependency: string[] | undefined
  if (extension === 'svg') {
    const sanitizerKey = `${baseTarget}/sanitized.svg`
    addJob({ kind: 'sanitize_svg', targetKey: sanitizerKey, outputFormat: 'svg' })
    imageDependency = [jobs.at(-1)!.id]
    const notice = finding('SVG_SANITIZATION_REQUIRED', 'info', 'extension', 'SVG 必须先移除脚本、外部引用与危险元数据，再格栅化预览。')
    findings.push(notice)
  }

  if (isImage) {
    const dimensions = uniqueBy(IMAGE_TARGET_EDGES.map(edge => fit(input.image!.width, input.image!.height, edge)), value => `${value.width}x${value.height}`)
    for (const dimensionsForJob of dimensions) {
      for (const format of ['webp', 'jpeg'] as const) {
        addJob({ kind: 'image_thumbnail', targetKey: `${baseTarget}/image-${dimensionsForJob.width}x${dimensionsForJob.height}.${format === 'jpeg' ? 'jpg' : format}`, outputFormat: format, ...dimensionsForJob, ...(imageDependency ? { dependsOn: imageDependency } : {}) })
      }
    }
  } else if (extension === 'pdf') {
    const pageLimit = Math.min(input.document!.pageCount, PDF_PREVIEW_PAGE_LIMIT)
    if (input.document!.pageCount > pageLimit) {
      const notice = finding('PDF_PAGE_LIMIT_APPLIED', 'warning', 'document.pageCount', `PDF 仅生成前 ${pageLimit} 页静态缩略图。`)
      findings.push(notice); warnings.push(notice.message)
    }
    for (let page = 1; page <= pageLimit; page += 1) {
      for (const format of ['webp', 'jpeg'] as const) addJob({ kind: 'document_page_thumbnail', targetKey: `${baseTarget}/page-${page}.${format === 'jpeg' ? 'jpg' : format}`, outputFormat: format, page, width: 960 })
    }
  } else if (extension === 'docx' || extension === 'xlsx') {
    const pageLimit = Math.min(input.document!.pageCount, OFFICE_PREVIEW_PAGE_LIMIT)
    if (input.document!.pageCount > pageLimit) {
      const notice = finding('DOCUMENT_PAGE_LIMIT_APPLIED', 'warning', 'document.pageCount', `${extension.toUpperCase()} 仅生成前 ${pageLimit} 页安全静态预览。`)
      findings.push(notice); warnings.push(notice.message)
    }
    for (let page = 1; page <= pageLimit; page += 1) addJob({ kind: 'safe_static_preview', targetKey: `${baseTarget}/static-page-${page}.png`, outputFormat: 'png', page, width: 1200 })
  }

  const unverified = finding('EXTERNAL_RENDERING_UNVERIFIED', 'info', 'jobs', '规划器只生成确定性任务；衍生文件仍需 worker 执行、重新扫描和哈希验证。')
  findings.push(unverified)
  return immutable({
    status: 'ready', source, cacheKey: baseCacheKey,
    jobs: uniqueBy(jobs, job => job.cacheKey), findings, warnings, externallyUnverified,
    manifestPolicy: { includesOriginalBody: false, includesCredentials: false, includesStorageRef: false },
  })
}
