import { emitRelayUsage, type RelayUsageContext, type RelayUsageSink } from './relay-usage.js'
import { relaySecurityFromEnv, assertRelayBaseUrl, assertRelayUrl, type RelaySecurityPolicy } from './relay-security.js'
import { readBoundedResponseText } from '../../connectors/src/bounded-response.js'
import { assertProviderResponseAccepted, providerIdempotencyKey, rethrowProviderTransportFailure, throwProviderOutcomeUnknown } from './provider-request.js'
import { isPlaceholderModelConfiguration } from './platform-model-gate.js'

export interface ImageGenerationInput {
  productTitle: string
  category?: string
  direction: string
  count: number
  /** Platform-aware visual brief assembled from confirmed product/task facts. */
  visualBrief?: {
    platform?: string
    placement?: string
    skuLabels?: string[]
    sellingPoints?: string[]
    headline?: string
    subheadline?: string
    cta?: string
    styleKeywords?: string[]
  }
  /** Workspace-scoped uploaded asset references resolved by the model relay. */
  sourceAssetRefs?: string[]
  /** Resolved image pixels (data URLs) for faithful image-to-image optimization. */
  sourceImages?: string[]
  /** Whether to create a new concept or optimize the supplied product assets. */
  mode?: 'create' | 'optimize'
  usageContext?: RelayUsageContext
}

export interface ImageGenerator {
  generate(input: ImageGenerationInput, options?: { signal?: AbortSignal; providerOperationKey?: string }): Promise<string[]>
  queryStatus?(providerRequestId: string, options?: { signal?: AbortSignal }): Promise<ImageGenerationStatus>
}

export interface ImageGenerationStatus {
  state: 'processing' | 'succeeded' | 'failed'
  providerRequestId: string
  images?: string[]
  evidence: { observedAt: string; source: 'provider_status'; providerStatus?: string }
}

export interface OpenAICompatibleImageGeneratorOptions {
  baseUrl: string
  apiKey: string
  model: string
  path?: string
  timeoutMs?: number
  size?: string
  quality?: string
  outputFormat?: 'png' | 'jpeg' | 'webp'
  responseFormat?: 'url' | 'b64_json'
  statusPath?: string
  fetch?: typeof fetch
  usageSink?: RelayUsageSink
  relaySecurity?: RelaySecurityPolicy
}

const MAX_IMAGE_RELAY_RESPONSE_BYTES = 32 * 1024 * 1024

const PLATFORM_VISUAL_DNA: Record<string, string> = {
  jd: '京东风格默认：理性品质、清晰参数、克制冷中性色与品牌色点缀，使用结构化卖点区和规格对照，不做空白极简海报。',
  taobao: '淘宝风格默认：移动端首屏转化、强卖点层级、明快色彩点缀、模块化信息图和明确行动区，保持商品主体最大且清晰。',
  tmall: '天猫风格默认：品牌感与品质感、统一视觉系统、精致留白配合高对比卖点模块，形成高级但不寡淡的详情页首屏。',
  pinduoduo: '拼多多风格默认：高信息密度、强对比、快速识别规格与利益点、清晰促销区域，但不编造价格或优惠。',
  xiaohongshu: '小红书风格默认：生活方式编辑感、自然场景、柔和但有重点的色彩、竖版阅读节奏，保留可叠加短文案的安全区。',
  douyin: '抖音电商风格默认：强视觉动势、明确焦点、短句大字安全区、适合封面和短视频转化，但不让装饰遮挡商品。',
}

function validateImageRelayPath(value: string | undefined) {
  if (!value) return undefined
  if (!value.startsWith('/') || value.includes('\\') || /^https?:\/\//iu.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('image generation path must be a safe relative path')
  return value
}

function boundedList(values: string[] | undefined, maxItems: number, maxLength: number) {
  return (values ?? []).map(value => value.trim()).filter(Boolean).slice(0, maxItems).map(value => value.slice(0, maxLength))
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export class OpenAICompatibleImageGenerator implements ImageGenerator {
  private readonly fetchImpl: typeof fetch
  constructor(private readonly options: OpenAICompatibleImageGeneratorOptions) {
    if (!options.baseUrl.trim() || !options.apiKey.trim() || !options.model.trim()) throw new Error('image provider URL, API key and model are required')
    assertRelayBaseUrl(options.baseUrl)
    validateImageRelayPath(options.path)
    validateImageRelayPath(options.statusPath)
    this.fetchImpl = options.fetch ?? fetch
  }

  async generate(input: ImageGenerationInput, options: { signal?: AbortSignal; providerOperationKey?: string } = {}): Promise<string[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000)
    const abort = () => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    try {
      const modeInstruction = input.mode === 'optimize'
        ? '基于提供的已授权商品素材优化构图、背景和光影；必须保持商品本体、颜色、材质、结构、Logo/印花和 SKU 对应关系不变。'
        : '从零设计概念构图；不得把概念图当作真实商品保真证明。'
      const brief = input.visualBrief
      const platform = brief?.platform?.trim().toLowerCase()
      const platformDna = platform ? PLATFORM_VISUAL_DNA[platform] ?? `目标平台为 ${platform}，使用适合移动端商品详情页的高转化信息层级。` : '使用适合移动端商品详情页的高转化信息层级。'
      const placement = brief?.placement?.trim() || '商品详情页运营图'
      const slotGuidance = /主图|listing|hero/iu.test(placement)
        ? '槽位为商品主图：只展示单件商品正面，商品占画面主体，白底或极浅灰背景，不做营销海报。'
        : /细节|detail/iu.test(placement)
          ? '槽位为商品细节图：只放大展示原图中可验证的材质、结构或接口，不新增不可见功能。'
          : /场景|lifestyle|使用/iu.test(placement)
            ? '槽位为使用场景图：允许真实环境和人物，但商品颜色、款式、比例必须严格跟随参考图。'
            : '槽位为详情页模块图：只完成一个明确任务，背景、文案和装饰服从商品事实。'
      const skuLabels = boundedList(brief?.skuLabels, 12, 80)
      const sellingPoints = boundedList(brief?.sellingPoints, 6, 120)
      const styleKeywords = boundedList(brief?.styleKeywords, 8, 80)
      const copy = [brief?.headline, brief?.subheadline, brief?.cta].map(value => value?.trim()).filter(Boolean).map(value => value!.slice(0, 120))
      const isMainImage = /主图|白底/iu.test(input.direction) || /主图/iu.test(brief?.placement ?? '')
      const prompt = [
        `生成电商商品运营视觉：商品是“${input.productTitle}”，${input.category ? `类目是“${input.category}”，` : ''}模式：${input.mode ?? 'create'}。`,
        modeInstruction,
        `版位：${placement}。${platformDna}${slotGuidance}`,
        `风格方向：${input.direction}。${styleKeywords.length ? `品牌/风格关键词：${styleKeywords.join('、')}。` : ''}`,
        skuLabels.length ? `只展示已确认的 SKU 标签：${skuLabels.join('、')}。` : '',
        sellingPoints.length ? `围绕已确认卖点组织视觉层级：${sellingPoints.join('；')}。` : '',
        copy.length ? `已确认的短文案仅作为排版参考：${copy.join('｜')}。` : '',
        isMainImage
          ? '电商主图必须使用纯白无缝背景，主体完整居中，禁止任何文字、信息卡片、水印、Logo 臆造、边框、道具和复杂场景。'
          : '画面不要素白：加入有层级的背景、材质/场景细节、信息卡片、几何图形或纹理，但装饰必须服务于商品和卖点。',
        '商品本体、Logo、包装、SKU 对应关系和已确认事实不可改变；不要编造价格、折扣、认证、功效、销量、评论或配件。',
        '中文长文案和精确事实文字不要交给模型直接绘制；为后置排版保留清晰安全区，并返回适合叠加真实文案的构图。',
        isMainImage
          ? '商品主体清晰完整，保持原图中的浅蓝色、连帽结构、袖子和正背面款式，不得改色、换款、增加图案或生成文字。'
          : '商品主体清晰完整，避免无信息的极简海报、随机英文、乱码和不可读的小字。',
      ].filter(Boolean).join('')
      const sourceAssetRefs = [...new Set((input.sourceAssetRefs ?? []).map(ref => ref.trim()).filter(Boolean))].slice(0, 10)
      const sourceImages = (input.sourceImages ?? []).filter(image => /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/iu.test(image)).slice(0, 10)
      const requestBody = JSON.stringify({
        model: this.options.model,
        prompt,
        ...(isMainImage ? { negative_prompt: '文字，中文文字，英文文字，乱码，信息卡片，标签，水印，臆造Logo，品牌标识，边框，道具，人物，复杂场景，渐变背景，阴影过重，裁切，缺失袖子，变形衣物，改色，换款' } : {}),
        n: input.count,
        size: this.options.size ?? '1024x1024',
        ...(this.options.quality ? { quality: this.options.quality } : {}),
        ...(this.options.outputFormat ? { output_format: this.options.outputFormat } : {}),
        response_format: this.options.responseFormat ?? 'b64_json',
        image_mode: input.mode ?? 'create',
        ...(sourceAssetRefs.length ? { source_asset_refs: sourceAssetRefs } : {}),
        ...(sourceImages.length ? { image: sourceImages } : {}),
      })
      const providerKey = options.providerOperationKey?.trim() || providerIdempotencyKey({ operation: 'image_generate', model: this.options.model, workspaceId: input.usageContext?.workspaceId, actionId: input.usageContext?.actionId, requestBody })
      if (providerKey.length > 255 || /[\u0000-\u001f\u007f]/u.test(providerKey)) throw new Error('provider operation key is invalid')
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
      } catch (error) { rethrowProviderTransportFailure(error, providerKey, 'image provider request') }
      assertProviderResponseAccepted(response, providerKey, 'image provider')
      let responseText: string
      try { responseText = await readBoundedResponseText(response, MAX_IMAGE_RELAY_RESPONSE_BYTES, 'image provider response') }
      catch (error) { rethrowProviderTransportFailure(error, providerKey, 'image provider response') }
      let payload: unknown
      try { payload = JSON.parse(responseText) as unknown }
      catch (error) { throwProviderOutcomeUnknown(providerKey, 'image provider response parsing', error) }
      if (!record(payload) || !Array.isArray(payload.data)) throwProviderOutcomeUnknown(providerKey, 'image provider response without data')
      const images = payload.data.flatMap(item => {
        if (!record(item)) return []
        if (typeof item.url === 'string' && /^https:\/\//u.test(item.url)) return [item.url]
        if (typeof item.b64_json === 'string' && item.b64_json.trim()) return [`data:image/png;base64,${item.b64_json}`]
        return []
      }).slice(0, input.count)
      if (images.length !== input.count) throwProviderOutcomeUnknown(providerKey, 'image provider incomplete result')
      // Preserve the real provider artifact even when the asynchronous usage
      // callback is temporarily unavailable; the worker/API keep it marked
      // pending settlement and block publication until reconciliation.
      try {
        await emitRelayUsage(this.options.usageSink, payload, response.headers, { modality: 'image', model: this.options.model, context: { ...input.usageContext, billingUnits: input.count, providerAttemptId: providerKey } })
      } catch (error) {
        if (!['MODEL_USAGE_SETTLEMENT_PENDING', 'MODEL_USAGE_COST_MISSING', 'MODEL_USAGE_EVIDENCE_MISSING'].includes(String((error as { code?: unknown })?.code ?? ''))) throw error
      }
      return images
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
    }
  }

  async queryStatus(providerRequestId: string, options: { signal?: AbortSignal } = {}): Promise<ImageGenerationStatus> {
    const requestId = providerRequestId.trim()
    if (!requestId || requestId.length > 256 || /[\u0000-\u001f\u007f]/u.test(requestId)) throw new Error('image provider request id is invalid')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000)
    const abort = () => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    try {
      const template = this.options.statusPath ?? '/images/generations/{request_id}'
      const path = template.replace(/\{request_id\}/gu, encodeURIComponent(requestId))
      const usesPathParameter = template.includes('{request_id}')
      if (this.options.relaySecurity?.environment || this.options.relaySecurity?.allowedHosts?.length) await assertRelayUrl(this.options.baseUrl, this.options.relaySecurity)
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, '')}${path}`, {
        method: usesPathParameter ? 'GET' : 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        ...(usesPathParameter ? {} : { body: JSON.stringify({ request_id: requestId }) }),
        signal: controller.signal,
        redirect: 'error',
      }).catch(error => rethrowProviderTransportFailure(error, requestId, 'image provider status request'))
      assertProviderResponseAccepted(response, requestId, 'image provider status')
      const responseText = await readBoundedResponseText(response, MAX_IMAGE_RELAY_RESPONSE_BYTES, 'image provider status response')
      let payload: unknown
      try { payload = JSON.parse(responseText) as unknown } catch (error) { throwProviderOutcomeUnknown(requestId, 'image provider status response parsing', error) }
      return parseImageGenerationStatus(payload, requestId)
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
    }
  }
}

function parseImageGenerationStatus(payload: unknown, providerRequestId: string): ImageGenerationStatus {
  const root = record(payload) ? payload : {}
  const data = record(root.data) ? root.data : root
  const rawStatus = typeof data.status === 'string' ? data.status.toLowerCase() : typeof data.state === 'string' ? data.state.toLowerCase() : ''
  const images = Array.isArray(data.data) ? data.data.flatMap(item => {
    if (!record(item)) return []
    if (typeof item.url === 'string' && /^https:\/\//u.test(item.url)) return [item.url]
    if (typeof item.b64_json === 'string' && item.b64_json.trim()) return [`data:image/png;base64,${item.b64_json}`]
    return []
  }) : []
  const responseId = typeof data.request_id === 'string' ? data.request_id : typeof data.id === 'string' ? data.id : typeof data.task_id === 'string' ? data.task_id : undefined
  if (responseId && responseId !== providerRequestId) throwProviderOutcomeUnknown(providerRequestId, 'image provider status returned a different request id')
  if (['failed', 'error', 'cancelled', 'canceled', 'rejected', 'expired'].includes(rawStatus)) return { state: 'failed', providerRequestId, evidence: { observedAt: new Date().toISOString(), source: 'provider_status', providerStatus: rawStatus } }
  if (['processing', 'queued', 'pending', 'running', 'in_progress'].includes(rawStatus)) return { state: 'processing', providerRequestId, evidence: { observedAt: new Date().toISOString(), source: 'provider_status', providerStatus: rawStatus } }
  if (['succeeded', 'success', 'completed', 'done'].includes(rawStatus)) {
    if (!images.length) throwProviderOutcomeUnknown(providerRequestId, 'image provider status completed without artifacts')
    return { state: 'succeeded', providerRequestId, images, evidence: { observedAt: new Date().toISOString(), source: 'provider_status', providerStatus: rawStatus } }
  }
  throwProviderOutcomeUnknown(providerRequestId, 'image provider status response contains no recognized state')
}

export function createImageGeneratorFromEnv(source: Record<string, string | undefined> = process.env, usageSink?: RelayUsageSink): ImageGenerator | undefined {
  const relayUrl = source.MODEL_RELAY_BASE_URL?.trim()
  const apiKey = source.MODEL_RELAY_API_KEY?.trim()
  const model = source.IMAGE_MODEL?.trim() || source.AI_IMAGE_MODEL?.trim()
  if (!relayUrl || !apiKey || !model || isPlaceholderModelConfiguration(relayUrl) || isPlaceholderModelConfiguration(apiKey) || isPlaceholderModelConfiguration(model)) return undefined
  const relaySecurity = relaySecurityFromEnv(source)
  if (!relaySecurity) return undefined
  const responseFormat = source.IMAGE_RESPONSE_FORMAT === 'url' ? 'url' : 'b64_json'
  const outputFormat = ['png', 'jpeg', 'webp'].includes(source.IMAGE_OUTPUT_FORMAT ?? '') ? source.IMAGE_OUTPUT_FORMAT as 'png' | 'jpeg' | 'webp' : undefined
  return new OpenAICompatibleImageGenerator({
    baseUrl: relayUrl,
    relaySecurity,
    apiKey,
    model,
    ...(source.IMAGE_GENERATION_PATH?.trim() ? { path: source.IMAGE_GENERATION_PATH.trim() } : {}),
    ...(source.IMAGE_STATUS_PATH?.trim() ? { statusPath: source.IMAGE_STATUS_PATH.trim() } : {}),
    timeoutMs: Number(source.IMAGE_TIMEOUT_MS ?? 300_000),
    size: source.IMAGE_SIZE?.trim() || '1024x1024',
    ...(source.IMAGE_QUALITY?.trim() ? { quality: source.IMAGE_QUALITY.trim() } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    responseFormat,
    ...(usageSink ? { usageSink } : {}),
  })
}
