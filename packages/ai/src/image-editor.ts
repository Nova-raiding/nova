import { emitRelayUsage, type RelayUsageContext, type RelayUsageSink } from './relay-usage.js'
import { relaySecurityFromEnv, assertRelayUrl, type RelaySecurityPolicy } from './relay-security.js'
import { readBoundedResponseText } from '../../connectors/src/bounded-response.js'
import { assertProviderResponseAccepted, providerIdempotencyKey, rethrowProviderTransportFailure, throwProviderOutcomeUnknown } from './provider-request.js'

export interface ImageEditInput {
  prompt: string
  sourceImages: Array<{ bytes: Uint8Array; mimeType: string }>
  region: { x: number; y: number; width: number; height: number }
  usageContext?: RelayUsageContext
}

export interface ImageEditGenerator {
  generate(input: ImageEditInput): Promise<string[]>
}

interface ImageEditGeneratorOptions {
  baseUrl: string
  apiKey: string
  model: string
  path?: string
  timeoutMs?: number
  fetch?: typeof fetch
  usageSink?: RelayUsageSink
  relaySecurity?: RelaySecurityPolicy
}

const MAX_IMAGE_EDIT_RESPONSE_BYTES = 32 * 1024 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validateImageEditRelayPath(value: string | undefined) {
  if (!value) return undefined
  if (!value.startsWith('/') || value.includes('\\') || /^https?:\/\//iu.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('image edit path must be a safe relative path')
  return value
}

export class OpenAICompatibleImageEditGenerator implements ImageEditGenerator {
  private readonly fetchImpl: typeof fetch
  constructor(private readonly options: ImageEditGeneratorOptions) {
    if (!options.baseUrl.trim() || !options.apiKey.trim() || !options.model.trim()) throw new Error('image edit relay URL, API key and model are required')
    validateImageEditRelayPath(options.path)
    this.fetchImpl = options.fetch ?? fetch
  }

  async generate(input: ImageEditInput): Promise<string[]> {
    const sourceImages = input.sourceImages.slice(0, 10).map(source => {
      if (!source.mimeType.toLowerCase().startsWith('image/') || source.bytes.byteLength === 0) throw new Error('image edit source must contain image bytes')
      return `data:${source.mimeType};base64,${Buffer.from(source.bytes).toString('base64')}`
    })
    if (sourceImages.length === 0) throw new Error('image edit requires at least one source image')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000)
    try {
      const requestBody = JSON.stringify({ model: this.options.model, prompt: input.prompt, image: sourceImages, image_mode: 'optimize', edit_region: input.region, n: 1, size: '1024x1024', response_format: 'url' })
      const providerKey = providerIdempotencyKey({ operation: 'image_edit', model: this.options.model, workspaceId: input.usageContext?.workspaceId, actionId: input.usageContext?.actionId, requestBody })
      let response: Response
      try {
        if (this.options.relaySecurity?.environment || this.options.relaySecurity?.allowedHosts?.length) await assertRelayUrl(this.options.baseUrl, this.options.relaySecurity)
        response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, '')}${this.options.path ?? '/images/generations'}`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}`, 'idempotency-key': providerKey },
          body: requestBody,
          signal: controller.signal,
          redirect: 'error',
        })
      } catch (error) { rethrowProviderTransportFailure(error, providerKey, 'image edit provider request') }
      assertProviderResponseAccepted(response, providerKey, 'image edit provider')
      let responseText: string
      try { responseText = await readBoundedResponseText(response, MAX_IMAGE_EDIT_RESPONSE_BYTES, 'image edit response') }
      catch (error) { rethrowProviderTransportFailure(error, providerKey, 'image edit provider response') }
      let payload: unknown
      try { payload = JSON.parse(responseText) as unknown }
      catch (error) { throwProviderOutcomeUnknown(providerKey, 'image edit provider response parsing', error) }
      await emitRelayUsage(this.options.usageSink, payload, response.headers, { modality: 'image_edit', model: this.options.model, context: { ...input.usageContext, billingUnits: 1, providerAttemptId: providerKey } })
      if (!record(payload) || !Array.isArray(payload.data)) throwProviderOutcomeUnknown(providerKey, 'image edit provider response without data')
      const images = payload.data.flatMap(item => {
        if (!record(item)) return []
        if (typeof item.url === 'string' && /^https:\/\//u.test(item.url)) return [item.url]
        if (typeof item.b64_json === 'string' && item.b64_json.trim()) return [`data:image/png;base64,${item.b64_json}`]
        return []
      }).slice(0, 1)
      if (images.length !== 1) throwProviderOutcomeUnknown(providerKey, 'image edit provider incomplete result')
      return images
    } finally { clearTimeout(timeout) }
  }
}

export function createImageEditGeneratorFromEnv(source: Record<string, string | undefined> = process.env, usageSink?: RelayUsageSink): ImageEditGenerator | undefined {
  const relayUrl = source.MODEL_RELAY_BASE_URL?.trim()
  const apiKey = relayUrl ? source.MODEL_RELAY_API_KEY?.trim() : undefined
  const model = source.IMAGE_EDIT_MODEL?.trim() || source.IMAGE_MODEL?.trim() || source.AI_IMAGE_MODEL?.trim()
  if (!relayUrl || !apiKey || !model) return undefined
  const relaySecurity = relaySecurityFromEnv(source)
  if (!relaySecurity) return undefined
  try { return new OpenAICompatibleImageEditGenerator({ baseUrl: relayUrl, apiKey, model, relaySecurity, ...(source.IMAGE_EDIT_PATH?.trim() ? { path: source.IMAGE_EDIT_PATH.trim() } : {}), timeoutMs: Number(source.IMAGE_EDIT_TIMEOUT_MS ?? 300_000), ...(usageSink ? { usageSink } : {}) }) } catch { return undefined }
}
