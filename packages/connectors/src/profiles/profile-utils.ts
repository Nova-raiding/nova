import type { PlatformProfile, PlatformWriteDraft, RawProduct, ValidationFinding } from '../types.js'

/**
 * Publish payload image references are the one write field whose value the
 * adapter appends *after* the merchant approved a payload snapshot (see
 * `imageMode: 'replace_pending_adapter'`), so the profile layer is the last
 * place that can bound them. The limits below are transport/abuse bounds, not
 * platform policy: a platform-specific image count belongs in the reviewed
 * adapter that owns that platform's evidence.
 */
export const MAX_WRITE_IMAGE_REFERENCES = 20
export const MAX_IMAGE_REFERENCE_LENGTH = 2_048
const MAX_IMAGE_DATA_URI_LENGTH = 21 * 1024 * 1024
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f]', 'u')
const BASE64 = '(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?'
/** Only image MIME types may be embedded in a write payload as a data URI. */
const DATA_IMAGE_REFERENCE = new RegExp(`^data:image\\/([a-z0-9.+-]+);base64,(${BASE64})$`, 'iu')
const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/avif',
  'image/bmp', 'image/heic', 'image/heif', 'image/tiff', 'image/svg+xml',
])
/** An opaque platform media handle (`media_123`, `jd-media-1`) is not a URL and
 * carries no scheme; only a conservative token shape is accepted. */
const OPAQUE_MEDIA_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const URL_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'heic', 'heif', 'tif', 'tiff', 'svg'])

function imageReferenceFinding(value: unknown, index: number): ValidationFinding | undefined {
  const field = `images[${index}]`
  if (typeof value !== 'string' || !value || CONTROL_CHARACTERS.test(value)) {
    return { field, code: 'INVALID_TYPE', message: `${field} must be a non-empty image reference without control characters`, severity: 'error' }
  }
  if (value.length > MAX_IMAGE_DATA_URI_LENGTH) {
    return { field, code: 'INVALID_VALUE', message: `${field} exceeds the image reference size limit`, severity: 'error' }
  }
  const dataImage = DATA_IMAGE_REFERENCE.exec(value)
  if (dataImage) {
    const mimeType = `image/${dataImage[1]!.toLowerCase()}`
    if (!IMAGE_MIME_TYPES.has(mimeType)) {
      return { field, code: 'INVALID_VALUE', message: `${field} must embed a supported image MIME type`, severity: 'error' }
    }
    return undefined
  }
  if (value.startsWith('data:')) {
    return { field, code: 'INVALID_VALUE', message: `${field} must be an https URL, an image data URI, or an opaque media reference`, severity: 'error' }
  }
  if (/^https:\/\//iu.test(value)) {
    if (value.length > MAX_IMAGE_REFERENCE_LENGTH) {
      return { field, code: 'INVALID_VALUE', message: `${field} exceeds ${MAX_IMAGE_REFERENCE_LENGTH} characters`, severity: 'error' }
    }
    let url: URL
    try { url = new URL(value) } catch {
      return { field, code: 'INVALID_VALUE', message: `${field} must be a valid https URL`, severity: 'error' }
    }
    if (!url.hostname || url.username || url.password || url.hash) {
      return { field, code: 'INVALID_VALUE', message: `${field} must be an https URL without credentials or fragment`, severity: 'error' }
    }
    const extension = url.pathname.includes('.') ? url.pathname.split('/').pop()?.split('.').pop()?.toLowerCase() : undefined
    if (extension && !URL_IMAGE_EXTENSIONS.has(extension)) {
      return { field, code: 'INVALID_VALUE', message: `${field} must reference an image file`, severity: 'error' }
    }
    return undefined
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(value)
  if (scheme) {
    return { field, code: 'INVALID_VALUE', message: `${field} scheme ${scheme[1]!.toLowerCase()} is not an allowed image reference`, severity: 'error' }
  }
  if (!OPAQUE_MEDIA_REFERENCE.test(value)) {
    return { field, code: 'INVALID_VALUE', message: `${field} is not a valid image reference`, severity: 'error' }
  }
  return undefined
}

/**
 * Media references are appended to the payload by the runtime adapter, so the
 * field can be absent, empty, or a single reference. A bare string is
 * normalized to a one-element list and each reference is still validated:
 * scheme, MIME (for data URIs) and per-reference length are all enforced.
 */
export function validateWriteImages(value: unknown): ValidationFinding[] {
  if (value === undefined || value === null) return []
  const references = typeof value === 'string' ? [value] : value
  if (!Array.isArray(references)) {
    return [{ field: 'images', code: 'INVALID_TYPE', message: 'images must be a list of image references', severity: 'error' }]
  }
  if (references.length > MAX_WRITE_IMAGE_REFERENCES) {
    return [{ field: 'images', code: 'INVALID_VALUE', message: `images must contain at most ${MAX_WRITE_IMAGE_REFERENCES} references`, severity: 'error' }]
  }
  return references.flatMap((reference, index) => imageReferenceFinding(reference, index) ?? [])
}

export function validateProfileWrite(profile: PlatformProfile, input: PlatformWriteDraft): ValidationFinding[] {
  const findings: ValidationFinding[] = []
  for (const field of Object.keys(input.fields)) {
    if (!profile.writableFields.includes(field)) {
      findings.push({ field, code: 'NOT_ALLOWED', message: `${field} is not writable for ${profile.platform}`, severity: 'error' })
    }
  }
  for (const field of profile.requiredFields) {
    if (input.fields[field] === undefined || input.fields[field] === null || input.fields[field] === '') {
      findings.push({ field, code: 'REQUIRED', message: `${field} is required`, severity: 'error' })
    }
  }
  if (typeof input.fields.title !== 'undefined' && typeof input.fields.title !== 'string') {
    findings.push({ field: 'title', code: 'INVALID_TYPE', message: 'title must be a string', severity: 'error' })
  }
  if (typeof input.fields.price !== 'undefined' && (typeof input.fields.price !== 'number' || input.fields.price < 0)) {
    findings.push({ field: 'price', code: 'INVALID_VALUE', message: 'price must be a non-negative number', severity: 'error' })
  }
  if (profile.writableFields.includes('images')) findings.push(...validateWriteImages(input.fields.images))
  return findings
}

export function mapFixture(platform: PlatformProfile['platform'], raw: RawProduct, mappingVersion: string) {
  const rawStatus = raw.listingStatus ?? Object.entries(raw.platformFields).find(([key]) => /status|state|sale/iu.test(key))?.[1]
  const normalizedStatus = typeof rawStatus === 'string' ? (/on.?sale|onsale|selling|published|上架/iu.test(rawStatus) ? 'on_sale' : /off.?sale|offsale|下架|deleted/iu.test(rawStatus) ? 'off_sale' : /draft/iu.test(rawStatus) ? 'draft' : 'unknown') : 'unknown'
  const rawPlatformFields = Object.fromEntries(Object.entries(raw.platformFields).slice(0, 50).map(([key, value]) => [key, typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null ? value : '[structured]']))
  return {
    platform,
    remoteId: raw.remoteId,
    title: raw.title,
    description: raw.description,
    price: raw.price,
    stock: raw.stock,
    sku: raw.sku,
    images: raw.images,
    category: raw.category,
    facts: { ...raw.attributes, stock: raw.stock, price: raw.price },
    mappingVersion,
    source: 'fixture' as const,
    listingStatus: normalizedStatus as 'on_sale' | 'off_sale' | 'draft' | 'unknown',
    platformUpdatedAt: raw.observedAt,
    rawPlatformFields,
  }
}
