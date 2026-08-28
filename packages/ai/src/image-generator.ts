import { emitRelayUsage, type RelayUsageContext, type RelayUsageSink } from './relay-usage.js'
import { inspectOutboundUrl } from '../../connectors/src/outbound-security.js'
import { readBoundedResponseText } from '../../connectors/src/bounded-response.js'

export interface ImageGenerationInput {
  productTitle: string
  category?: string
  direction: string
  count: number
  /** Product references used for image-to-image/edit generation. */
  sourceImageUrls?: string[]
  /** Workspace-scoped uploaded asset references resolved by the model relay. */
  sourceAssetRefs?: string[]
  /** Whether to create a new concept or optimize the supplied product assets. */
  mode?: 'create' | 'optimize'
  usageContext?: RelayUsageContext
}

export interface ImageGenerator {
  generate(input: ImageGenerationInput): Promise<string[]>
}

export interface OpenAICompatibleImageGeneratorOptions {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
  size?: string
  quality?: string
  outputFormat?: 'png' | 'jpeg' | 'webp'
  responseFormat?: 'url' | 'b64_json'
  fetch?: typeof fetch
  usageSink?: RelayUsageSink
}

const MAX_IMAGE_RELAY_RESPONSE_BYTES = 32 * 1024 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export class OpenAICompatibleImageGenerator implements ImageGenerator {
  private readonly fetchImpl: typeof fetch
  constructor(private readonly options: OpenAICompatibleImageGeneratorOptions) {
    if (!options.baseUrl.trim() || !options.apiKey.trim() || !options.model.trim()) throw new Error('image provider URL, API key and model are required')
    this.fetchImpl = options.fetch ?? fetch
  }

  async generate(input: ImageGenerationInput): Promise<string[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000)
    try {
      const modeInstruction = input.mode === 'optimize'
        ? '基于提供的已授权商品素材优化构图、背景和光影；必须保持商品本体、颜色、材质、结构、Logo/印花和 SKU 对应关系不变。'
        : '从零设计概念构图；不得把概念图当作真实商品保真证明。'
      const prompt = `生成电商商品主图：商品是“${input.productTitle}”，${input.category ? `类目是“${input.category}”，` : ''}模式：${input.mode ?? 'create'}。${modeInstruction}风格要求：${input.direction}。商品主体清晰完整，不添加未经确认的品牌、功效、价格或人物，适合平台商品首图。`
      const sourceImages = (input.sourceImageUrls ?? []).filter(image => /^https:\/\//u.test(image)).slice(0, 10)
      const sourceAssetRefs = [...new Set((input.sourceAssetRefs ?? []).map(ref => ref.trim()).filter(Boolean))].slice(0, 10)
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, '')}/images/generations`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({
          model: this.options.model,
          prompt,
          n: input.count,
          size: this.options.size ?? '1024x1024',
          ...(this.options.quality ? { quality: this.options.quality } : {}),
          ...(this.options.outputFormat ? { output_format: this.options.outputFormat } : {}),
          response_format: this.options.responseFormat ?? 'b64_json',
          image_mode: input.mode ?? 'create',
          ...(sourceImages.length ? { image: sourceImages } : {}),
          ...(sourceAssetRefs.length ? { source_asset_refs: sourceAssetRefs } : {}),
        }),
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) throw new Error(`image provider returned HTTP ${response.status}`)
      const payload = JSON.parse(await readBoundedResponseText(response, MAX_IMAGE_RELAY_RESPONSE_BYTES, 'image provider response')) as unknown
      await emitRelayUsage(this.options.usageSink, payload, response.headers, { modality: 'image', model: this.options.model, context: { ...input.usageContext, billingUnits: input.count } })
      if (!record(payload) || !Array.isArray(payload.data)) throw new Error('image provider response does not contain data')
      const images = payload.data.flatMap(item => {
        if (!record(item)) return []
        if (typeof item.url === 'string' && /^https:\/\//u.test(item.url)) return [item.url]
        if (typeof item.b64_json === 'string' && item.b64_json.trim()) return [`data:image/png;base64,${item.b64_json}`]
        return []
      }).slice(0, input.count)
      if (images.length !== input.count) throw new Error('image provider returned an incomplete result')
      return images
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function createImageGeneratorFromEnv(source: Record<string, string | undefined> = process.env, usageSink?: RelayUsageSink): ImageGenerator | undefined {
  const relayUrl = source.MODEL_RELAY_BASE_URL?.trim()
  const apiKey = source.MODEL_RELAY_API_KEY?.trim()
  const model = source.IMAGE_MODEL?.trim() ?? source.AI_IMAGE_MODEL?.trim()
  if (!relayUrl || !apiKey || !model) return undefined
  if (!/^https:\/\//u.test(relayUrl) || inspectOutboundUrl(relayUrl, { environment: source.NODE_ENV, resolveDns: false })) return undefined
  const responseFormat = source.IMAGE_RESPONSE_FORMAT === 'url' ? 'url' : 'b64_json'
  const outputFormat = ['png', 'jpeg', 'webp'].includes(source.IMAGE_OUTPUT_FORMAT ?? '') ? source.IMAGE_OUTPUT_FORMAT as 'png' | 'jpeg' | 'webp' : undefined
  return new OpenAICompatibleImageGenerator({
    baseUrl: relayUrl,
    apiKey,
    model,
    timeoutMs: Number(source.IMAGE_TIMEOUT_MS ?? 120_000),
    size: source.IMAGE_SIZE?.trim() || '1024x1024',
    ...(source.IMAGE_QUALITY?.trim() ? { quality: source.IMAGE_QUALITY.trim() } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    responseFormat,
    ...(usageSink ? { usageSink } : {}),
  })
}
