import { describe, expect, it } from 'vitest'
import { planAssetPreviews, type AssetPreviewPlannerInput } from './asset-preview-planner.js'

const sha = (character: string) => character.repeat(64)

const imageInput = (overrides: Partial<AssetPreviewPlannerInput> = {}): AssetPreviewPlannerInput => ({
  workspaceId: 'ws_alpha', assetId: 'asset_image_1', revision: 3, sourceSha256: sha('a'),
  scanStatus: 'clean', rightsStatus: 'approved', previewAllowed: true,
  declaredMimeType: 'image/png', detectedMimeType: 'image/png', extension: '.PNG', sizeBytes: 2_000_000,
  image: { width: 1600, height: 1200 }, storageRef: { provider: 's3', bucket: 'merchant-assets', key: 'ws_alpha/source/image.png' },
  ...overrides,
})

const documentInput = (extension: 'pdf' | 'docx' | 'xlsx', pageCount: number): AssetPreviewPlannerInput => {
  const mime = extension === 'pdf' ? 'application/pdf'
    : extension === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  return {
    workspaceId: 'ws_docs', assetId: `asset_${extension}`, revision: 1, sourceSha256: sha('b'),
    scanStatus: 'clean', rightsStatus: 'approved', previewAllowed: true,
    declaredMimeType: mime, detectedMimeType: mime, extension, sizeBytes: 2_000_000,
    ...(extension === 'pdf' ? {} : { uncompressedSizeBytes: 20_000_000 }),
    document: { pageCount }, storageRef: { provider: 's3', key: `ws_docs/source/file.${extension}` },
  }
}

describe('asset derivative preview planner', () => {
  it('plans deterministic multi-size WebP/JPEG image thumbnails without source body or credentials', () => {
    const first = planAssetPreviews(imageInput())
    const second = planAssetPreviews(imageInput())

    expect(first).toEqual(second)
    expect(first).toMatchObject({ status: 'ready', source: { sha256: sha('a'), revision: 3 }, manifestPolicy: { includesOriginalBody: false, includesCredentials: false, includesStorageRef: false } })
    expect(first.jobs).toHaveLength(6)
    expect(new Set(first.jobs.map(job => job.cacheKey)).size).toBe(first.jobs.length)
    expect(first.jobs.map(job => job.outputFormat)).toEqual(['webp', 'jpeg', 'webp', 'jpeg', 'webp', 'jpeg'])
    const serialized = JSON.stringify(first)
    expect(serialized).not.toContain('merchant-assets')
    expect(serialized).not.toContain('ws_alpha/source/image.png')
    expect(serialized).not.toContain('credential')
  })

  it('deduplicates identical small-image dimensions across target sizes', () => {
    const plan = planAssetPreviews(imageInput({ image: { width: 1, height: 1 } }))
    expect(plan.jobs).toHaveLength(2)
    expect(plan.jobs.map(job => [job.width, job.height])).toEqual([[1, 1], [1, 1]])
  })

  it('names cache and target keys by workspace so tenants cannot collide', () => {
    const alpha = planAssetPreviews(imageInput({ workspaceId: 'ws_alpha' }))
    const beta = planAssetPreviews(imageInput({ workspaceId: 'ws_beta', storageRef: { provider: 's3', key: 'ws_beta/source/image.png' } }))
    expect(alpha.cacheKey).not.toBe(beta.cacheKey)
    expect(alpha.jobs[0]?.targetKey).toContain('/ws_alpha/')
    expect(beta.jobs[0]?.targetKey).toContain('/ws_beta/')
    expect(new Set([...alpha.jobs, ...beta.jobs].map(job => job.targetKey)).size).toBe(alpha.jobs.length + beta.jobs.length)
  })

  it('limits PDF page thumbnails and records the externally unverified boundary', () => {
    const plan = planAssetPreviews(documentInput('pdf', 12))
    expect(plan.status).toBe('ready')
    expect(plan.jobs).toHaveLength(10)
    expect(new Set(plan.jobs.map(job => job.page))).toEqual(new Set([1, 2, 3, 4, 5]))
    expect(plan.findings).toContainEqual(expect.objectContaining({ code: 'PDF_PAGE_LIMIT_APPLIED', severity: 'warning' }))
    expect(plan.externallyUnverified).not.toEqual([])
  })

  it.each(['docx', 'xlsx'] as const)('plans only safe static %s previews with active content disabled', extension => {
    const plan = planAssetPreviews(documentInput(extension, 8))
    expect(plan.status).toBe('ready')
    expect(plan.jobs).toHaveLength(3)
    expect(plan.jobs.every(job => job.kind === 'safe_static_preview' && job.outputFormat === 'png')).toBe(true)
    expect(plan.jobs.every(job => job.contentHandling.macros === 'not_executed' && job.contentHandling.scripts === 'not_executed')).toBe(true)
    expect(plan.findings).toContainEqual(expect.objectContaining({ code: 'DOCUMENT_PAGE_LIMIT_APPLIED' }))
  })

  it('requires SVG sanitization before every raster derivative', () => {
    const plan = planAssetPreviews(imageInput({
      assetId: 'asset_svg', declaredMimeType: 'image/svg+xml', detectedMimeType: 'image/svg+xml', extension: 'svg',
      image: { width: 800, height: 600 }, storageRef: { provider: 's3', key: 'ws_alpha/source/vector.svg' },
    }))
    const sanitizer = plan.jobs.find(job => job.kind === 'sanitize_svg')
    expect(sanitizer).toBeDefined()
    expect(plan.jobs.filter(job => job.kind === 'image_thumbnail').every(job => job.dependsOn?.includes(sanitizer!.id))).toBe(true)
    expect(plan.findings).toContainEqual(expect.objectContaining({ code: 'SVG_SANITIZATION_REQUIRED' }))
  })

  it.each(['ai', 'eps'] as const)('marks %s unsupported/manual and emits no derivative job', extension => {
    const mime = extension === 'ai' ? 'application/postscript' : 'application/postscript'
    const plan = planAssetPreviews({ ...documentInput('pdf', 1), assetId: `asset_${extension}`, extension, declaredMimeType: mime, detectedMimeType: mime })
    expect(plan).toMatchObject({ status: 'manual_required', jobs: [] })
    expect(plan.findings).toContainEqual(expect.objectContaining({ code: 'FORMAT_UNSUPPORTED_MANUAL' }))
  })

  it.each([
    { scanStatus: 'quarantined' as const, rightsStatus: 'approved' as const, previewAllowed: true, code: 'SCAN_NOT_CLEAN' },
    { scanStatus: 'blocked' as const, rightsStatus: 'approved' as const, previewAllowed: true, code: 'SCAN_NOT_CLEAN' },
    { scanStatus: 'clean' as const, rightsStatus: 'rejected' as const, previewAllowed: true, code: 'PREVIEW_RIGHTS_DENIED' },
    { scanStatus: 'clean' as const, rightsStatus: 'approved' as const, previewAllowed: false, code: 'PREVIEW_RIGHTS_DENIED' },
  ])('fails closed for scan/rights state: $code', change => {
    const plan = planAssetPreviews(imageInput(change))
    expect(plan).toMatchObject({ status: 'blocked', jobs: [] })
    expect(plan.findings).toContainEqual(expect.objectContaining({ code: change.code, severity: 'block' }))
  })

  it('blocks executable content, signature mismatch and encoded path traversal', () => {
    const executable = planAssetPreviews(imageInput({ extension: 'exe', declaredMimeType: 'application/x-msdownload', detectedMimeType: 'application/x-msdownload' }))
    expect(executable.findings).toContainEqual(expect.objectContaining({ code: 'EXECUTABLE_CONTENT_BLOCKED' }))

    const mismatch = planAssetPreviews(imageInput({ detectedMimeType: 'application/pdf' }))
    expect(mismatch.findings).toContainEqual(expect.objectContaining({ code: 'MIME_SIGNATURE_MISMATCH' }))

    const traversal = planAssetPreviews(imageInput({ storageRef: { provider: 's3', key: 'ws_alpha/%2e%2e/secrets/token' } }))
    expect(traversal).toMatchObject({ status: 'blocked', jobs: [] })
    expect(traversal.findings).toContainEqual(expect.objectContaining({ code: 'STORAGE_PATH_INVALID' }))
  })

  it('accepts exact bomb boundaries and blocks the first value beyond them', () => {
    const boundary = planAssetPreviews(imageInput({ sizeBytes: 50 * 1024 * 1024, image: { width: 10_000, height: 10_000 } }))
    expect(boundary.status).toBe('ready')
    const pixelBomb = planAssetPreviews(imageInput({ image: { width: 10_001, height: 10_000 } }))
    expect(pixelBomb.findings).toContainEqual(expect.objectContaining({ code: 'PIXEL_BOMB_BLOCKED' }))

    const pageBoundary = planAssetPreviews(documentInput('pdf', 1_000))
    expect(pageBoundary.status).toBe('ready')
    const pageBomb = planAssetPreviews(documentInput('pdf', 1_001))
    expect(pageBomb.findings).toContainEqual(expect.objectContaining({ code: 'PAGE_BOMB_BLOCKED' }))
  })

  it('fails safe when dimensions, page count, archive expansion or identity evidence is absent', () => {
    const image = planAssetPreviews(imageInput({ image: undefined }))
    expect(image.findings).toContainEqual(expect.objectContaining({ code: 'IMAGE_DIMENSIONS_REQUIRED' }))

    const office = planAssetPreviews({ ...documentInput('docx', 2), document: undefined, uncompressedSizeBytes: undefined })
    expect(office.findings.map(item => item.code)).toEqual(expect.arrayContaining(['DOCUMENT_PAGE_COUNT_REQUIRED', 'ARCHIVE_BOMB_BLOCKED']))

    const identity = planAssetPreviews(imageInput({ workspaceId: '../other', revision: 0, sourceSha256: 'bad' }))
    expect(identity).toMatchObject({ status: 'blocked', jobs: [] })
    expect(identity.findings).toContainEqual(expect.objectContaining({ code: 'SOURCE_IDENTITY_INVALID' }))
  })

  it('rejects double-encoded traversal and cross-workspace storage scope', () => {
    const doubleEncoded = planAssetPreviews(imageInput({ storageRef: { provider: 's3', key: 'ws_alpha/%252e%252e/private.png' } }))
    const crossScope = planAssetPreviews(imageInput({ storageRef: { provider: 's3', key: 'ws_other/source/image.png' } }))
    expect(doubleEncoded.findings).toContainEqual(expect.objectContaining({ code: 'STORAGE_PATH_INVALID' }))
    expect(crossScope.findings).toContainEqual(expect.objectContaining({ code: 'STORAGE_PATH_INVALID' }))
  })

  it('rejects non-finite sizes, null hashes and MIME parameter spoofing', () => {
    const result = planAssetPreviews(imageInput({
      sourceSha256: '0'.repeat(64), sizeBytes: Number.POSITIVE_INFINITY,
      declaredMimeType: 'image/png; application/x-msdownload',
    }))
    expect(result.status).toBe('blocked')
    expect(result.findings.map(item => item.code)).toEqual(expect.arrayContaining(['SOURCE_IDENTITY_INVALID', 'SOURCE_SIZE_INVALID', 'MIME_SIGNATURE_MISMATCH']))
  })

  it('bounds hostile path and dimension inputs without generating jobs', () => {
    const result = planAssetPreviews(imageInput({
      storageRef: { provider: 'local', key: `ws_alpha/${'a'.repeat(2_049)}` },
      image: { width: Number.NaN, height: -1 },
    }))
    expect(result).toMatchObject({ status: 'blocked', jobs: [] })
    expect(result.findings.map(item => item.code)).toEqual(expect.arrayContaining(['STORAGE_PATH_INVALID', 'IMAGE_DIMENSIONS_REQUIRED']))
  })

  it('returns a recursively frozen plan independent from later input mutation', () => {
    const input = imageInput()
    const plan = planAssetPreviews(input)
    ;(input.image as { width: number; height: number }).width = 1
    expect(plan.jobs[0]?.width).toBe(320)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.jobs)).toBe(true)
  })
})
