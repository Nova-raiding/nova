import { emitRelayUsage, type RelayUsageContext, type RelayUsageSink } from './relay-usage.js'
import { inspectOutboundUrl } from '../../connectors/src/outbound-security.js'
import { readBoundedResponseText } from '../../connectors/src/bounded-response.js'

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
  timeoutMs?: number
  fetch?: typeof fetch
  usageSink?: RelayUsageSink
}

const MAX_IMAGE_EDIT_RESPONSE_BYTES = 32 * 1024 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export class OpenAICompatibleImageEditGenerator implements ImageEditGenerator {
  private readonly fetchImpl: typeof fetch
  constructor(private readonly options: ImageEditGeneratorOptions) {
    if (!options.baseUrl.trim() || !options.apiKey.trim() || !options.model.trim()) throw new Error('image edit relay URL, API key and model are required')
    if (new URL(options.baseUrl).protocol !== 'https:') throw new Error('image edit relay URL must use HTTPS')
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
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, '')}/images/edits`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ model: this.options.model, prompt: input.prompt, image: sourceImages, image_mode: 'optimize', edit_region: input.region, n: 1, response_format: 'b64_json' }),
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) throw new Error(`image edit provider returned HTTP ${response.status}`)
      const payload = JSON.parse(await readBoundedResponseText(response, MAX_IMAGE_EDIT_RESPONSE_BYTES, 'image edit response')) as unknown
      await emitRelayUsage(this.options.usageSink, payload, response.headers, { modality: 'image_edit', model: this.options.model, context: { ...input.usageContext, billingUnits: 1 } })
      if (!record(payload) || !Array.isArray(payload.data)) throw new Error('image edit provider response does not contain data')
      const images = payload.data.flatMap(item => {
        if (!record(item)) return []
        if (typeof item.url === 'string' && /^https:\/\//u.test(item.url)) return [item.url]
        if (typeof item.b64_json === 'string' && item.b64_json.trim()) return [`data:image/png;base64,${item.b64_json}`]
        return []
      }).slice(0, 1)
      if (images.length !== 1) throw new Error('image edit provider returned an incomplete result')
      return images
    } finally { clearTimeout(timeout) }
  }
}

export function createImageEditGeneratorFromEnv(source: Record<string, string | undefined> = process.env, usageSink?: RelayUsageSink): ImageEditGenerator | undefined {
  const relayUrl = source.MODEL_RELAY_BASE_URL?.trim()
  const apiKey = relayUrl ? source.MODEL_RELAY_API_KEY?.trim() : undefined
  const model = source.IMAGE_EDIT_MODEL?.trim() || source.IMAGE_MODEL?.trim() || source.AI_IMAGE_MODEL?.trim()
  if (!relayUrl || !apiKey || !model) return undefined
  if (!/^https:\/\//u.test(relayUrl) || inspectOutboundUrl(relayUrl, { environment: source.NODE_ENV, resolveDns: false })) return undefined
  try { return new OpenAICompatibleImageEditGenerator({ baseUrl: relayUrl, apiKey, model, timeoutMs: Number(source.IMAGE_EDIT_TIMEOUT_MS ?? 120_000), ...(usageSink ? { usageSink } : {}) }) } catch { return undefined }
}
