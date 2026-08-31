export type ImageGenerationCallbackError = { code: string; message: string }
export type ImageGenerationCallbackResult = { intent_hash: string; owner_token?: string; provider_request_id?: string; images?: string[]; error?: ImageGenerationCallbackError }

export class ImageGenerationCallbackSchemaError extends Error {
  readonly code = 'IMAGE_GENERATION_CALLBACK_SCHEMA_INVALID'
  constructor(message: string) { super(message); this.name = 'ImageGenerationCallbackSchemaError' }
}

const MAX_IDENTIFIER_LENGTH = 256
const MAX_IMAGE_URL_LENGTH = 2_048
const MAX_IMAGE_DATA_URI_LENGTH = 21 * 1024 * 1024
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u
const BASE64 = '(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?'
const DATA_IMAGE_REFERENCE = new RegExp(`^data:image\\/[a-z0-9.+-]+;base64,(${BASE64})$`, 'iu')

function boundedString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ImageGenerationCallbackSchemaError(`${field} must be a string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || CONTROL_CHARACTERS.test(normalized)) throw new ImageGenerationCallbackSchemaError(`${field} must be non-empty and at most ${maximum} characters`)
  return normalized
}

function imageReference(value: unknown, index: number): string {
  if (typeof value !== 'string' || !value || CONTROL_CHARACTERS.test(value)) throw new ImageGenerationCallbackSchemaError(`images[${index}] must be a non-empty string reference`)
  if (value.length > MAX_IMAGE_DATA_URI_LENGTH) throw new ImageGenerationCallbackSchemaError(`images[${index}] exceeds the reference size limit`)
  if (DATA_IMAGE_REFERENCE.test(value)) return value
  if (value.length > MAX_IMAGE_URL_LENGTH || !/^https:\/\//iu.test(value)) throw new ImageGenerationCallbackSchemaError(`images[${index}] must be an HTTPS URL or image data URI`)
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) throw new Error('unsafe URL')
  } catch { throw new ImageGenerationCallbackSchemaError(`images[${index}] must be a valid HTTPS URL`) }
  return value
}

export function validateImageGenerationCallbackResult(value: unknown, options: { allowEventId?: boolean } = {}): ImageGenerationCallbackResult & { event_id?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ImageGenerationCallbackSchemaError('callback must be a JSON object')
  const input = value as Record<string, unknown>
  const allowed = new Set(['intent_hash', 'owner_token', 'provider_request_id', 'images', 'error', ...(options.allowEventId ? ['event_id'] : [])])
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new ImageGenerationCallbackSchemaError(`unknown callback field: ${key}`)
  const intentHash = boundedString(input.intent_hash, 'intent_hash', 64)
  if (!intentHash || !/^[a-f0-9]{64}$/u.test(intentHash)) throw new ImageGenerationCallbackSchemaError('intent_hash must be a lowercase SHA-256 hash')
  const eventId = options.allowEventId ? boundedString(input.event_id, 'event_id', MAX_IDENTIFIER_LENGTH) : undefined
  if (options.allowEventId && !eventId) throw new ImageGenerationCallbackSchemaError('event_id is required')
  const ownerToken = boundedString(input.owner_token, 'owner_token', MAX_IDENTIFIER_LENGTH)
  const providerRequestId = boundedString(input.provider_request_id, 'provider_request_id', MAX_IDENTIFIER_LENGTH)
  let images: string[] | undefined
  if (input.images !== undefined) {
    if (!Array.isArray(input.images) || input.images.length < 1 || input.images.length > 6) throw new ImageGenerationCallbackSchemaError('images must contain 1 to 6 references')
    images = input.images.map(imageReference)
  }
  let error: ImageGenerationCallbackError | undefined
  if (input.error !== undefined) {
    if (!input.error || typeof input.error !== 'object' || Array.isArray(input.error)) throw new ImageGenerationCallbackSchemaError('error must be a non-empty JSON object')
    const candidate = input.error as Record<string, unknown>
    if (Object.keys(candidate).length !== 2 || !Object.prototype.hasOwnProperty.call(candidate, 'code') || !Object.prototype.hasOwnProperty.call(candidate, 'message')) throw new ImageGenerationCallbackSchemaError('error must contain only code and message')
    const code = boundedString(candidate.code, 'error.code', 128)
    const message = boundedString(candidate.message, 'error.message', 500)
    if (!code || !message) throw new ImageGenerationCallbackSchemaError('error.code and error.message are required')
    error = { code, message }
  }
  if (error && images) throw new ImageGenerationCallbackSchemaError('callback cannot contain both images and error')
  if (!error && !images) throw new ImageGenerationCallbackSchemaError('callback must contain images or error')
  return { intent_hash: intentHash, ...(eventId ? { event_id: eventId } : {}), ...(ownerToken ? { owner_token: ownerToken } : {}), ...(providerRequestId ? { provider_request_id: providerRequestId } : {}), ...(images ? { images } : {}), ...(error ? { error } : {}) }
}
