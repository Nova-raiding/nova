import { createHash } from 'node:crypto'
import { emitRelayUsage, type RelayUsageContext, type RelayUsageSink } from './relay-usage.js'
import { relaySecurityFromEnv, assertRelayBaseUrl, assertRelayUrl, type RelaySecurityPolicy } from './relay-security.js'
import { readBoundedResponseText } from '../../connectors/src/bounded-response.js'
import { assertProviderResponseAccepted, ProviderRequestFailedError, ProviderOutcomeUnknownError, providerIdempotencyKey, rethrowProviderTransportFailure, throwProviderOutcomeUnknown } from './provider-request.js'
import { isPlaceholderModelConfiguration } from './platform-model-gate.js'
import { composeMarketingImages } from './image-marketing-compositor.js'

function imageTrace(event: string, fields: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === 'production' && process.env.MERCHANT_IMAGE_TRACE_LOGS !== 'true') return
  try { console.info(JSON.stringify({ event: `merchant.image.${event}`, ts: new Date().toISOString(), ...fields })) } catch { /* diagnostics must never affect generation */ }
}

export interface ImageGenerationInput {
  productTitle: string
  category?: string
  direction: string
  count: number
  /** Platform-aware visual brief assembled from confirmed product/task facts. */
  visualBrief?: {
    size?: string
    platform?: string
    placement?: string
    skuLabels?: string[]
    sellingPoints?: string[]
    /** Verified short search/traffic keyword labels. Never inferred claims. */
    trafficKeywords?: string[]
    /** Authorized brand logo asset references; the provider must not redraw them. */
    logoAssetIds?: string[]
    /** Confirmed promotion labels, already scoped to the product/SKU. */
    promotionLabels?: string[]
    headline?: string
    subheadline?: string
    cta?: string
    styleKeywords?: string[]
    /** Confirmed, reviewable marketing copy. Never inferred by the provider. */
    marketingLabels?: string[]
    /** Ordered long-page chapters, each with one buyer question. */
    detailSections?: string[]
    /** Frozen platform rules that shaped this candidate. */
    platformRules?: string[]
    outputVariant?: 'main' | 'secondary' | 'detail_long' | 'banner'
    /** Sanitized competitor observations; reference only, never product facts. */
    competitorStructures?: string[]
    competitorThemes?: string[]
    differentiationAngles?: string[]
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
  editPath?: string
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
const MAX_PROVIDER_ERROR_SUMMARY = 500

class ImageOutputUnchangedError extends Error {
  readonly code = 'IMAGE_OUTPUT_UNCHANGED'
  readonly providerOutcome = 'failed' as const
  readonly providerSucceeded = false
  readonly reconciliationRequired = false
  readonly retryable = false

  constructor(readonly providerIdempotencyKey: string) {
    super('image provider returned the source image unchanged')
    this.name = 'ImageOutputUnchangedError'
  }
}

function providerErrorSummary(payload: unknown): { summary?: string; code?: string; requestId?: string } {
  if (!record(payload)) return {}
  const error = record(payload.error) ? payload.error : payload
  const code = typeof error.code === 'string' ? error.code.trim().slice(0, 120) : undefined
  const message = typeof error.message === 'string' ? error.message.trim() : undefined
  const type = typeof error.type === 'string' ? error.type.trim().slice(0, 120) : undefined
  const requestId = [payload.request_id, payload.requestId, error.request_id, error.requestId]
    .find(value => typeof value === 'string' && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value))
  if (!code && !message && !type) return { requestId: typeof requestId === 'string' ? requestId.trim() : undefined }
  const summary = [code, type, message].filter(Boolean).join(': ').slice(0, MAX_PROVIDER_ERROR_SUMMARY)
  return { summary, code, requestId: typeof requestId === 'string' ? requestId.trim() : undefined }
}

const PLATFORM_VISUAL_DNA: Record<string, string> = {
  jd: '京东风格默认：清晰、明亮、专业、可信；用克制冷中性色和轻量品牌色点缀，商品完整占主体，优先呈现材质、结构和可验证细节，避免拼接、杂乱背景和大段文字。',
  taobao: '淘宝风格默认：移动端搜索首屏优先，商品轮廓一眼可识别；用明确视觉焦点、适度留白和一处可验证卖点的构图制造点击差异，不堆促销贴纸，不放未经确认的价格或承诺。',
  tmall: '天猫风格默认：品牌橱窗感、品质感和统一视觉系统；精致留白、柔和高级光影、干净材质背景或纯色背景，画面克制但要有明确设计层次，严格如实呈现商品。',
  pinduoduo: '拼多多风格默认：小尺寸搜索卡片也能快速识别；主体轮廓大而清晰、对比强、色彩醒目、信息层级直接，优先突出真实规格和已确认卖点；不得虚构价格、折扣、销量、优惠券或平台权益。',
  xiaohongshu: '小红书风格默认：编辑化生活方式、自然光、真实可用场景、柔和但有重点的配色和 3:4 竖向阅读节奏；商品仍是主角，保留干净安全区，不做粗暴促销海报。',
  douyin: '抖音电商风格默认：3:4 或竖版信息流首屏，单一强视觉焦点、明显前后层次、动态但不混乱的构图；用大面积留白承载后置短文案，不生成夸张承诺或遮挡商品。',
}

const PLATFORM_HERO_TEMPLATES: Record<string, string> = {
  jd: '模板=专业商品棚拍；构图=完整商品、主体占画面约 75%–85%、正面或轻微三分之四、边缘完整；光线=均匀柔光加轻微轮廓光；背景=纯白或极浅灰；禁止促销文字和拼贴。',
  taobao: '模板=搜索首屏商品 hero；构图=商品轮廓一眼可识别、主体大而完整、留白形成点击焦点、只保留一个视觉卖点区域；光线=明亮商业棚拍；背景=干净浅色或纯白；禁止虚构优惠与承诺。',
  tmall: '模板=品牌橱窗 hero；构图=商品完整居中但有精致层次、材质细节清晰、留白均衡；光线=高级柔光和自然阴影；背景=纯白、暖白或品牌中性色；禁止廉价促销贴纸和杂乱装饰。',
  pinduoduo: '模板=高识别搜索卡片；构图=商品占画面 80% 左右、轮廓和关键结构清楚、强明暗对比、缩小后仍能识别；光线=明亮硬朗但不丢细节；背景=简洁高对比纯色；只允许使用已确认卖点，禁止虚构价格、折扣、销量。',
  xiaohongshu: '模板=生活方式商品 hero；构图=3:4 竖版、商品为唯一主角、真实使用语境、留出后置文字安全区；光线=自然窗光或柔和编辑光；背景=真实但简洁的生活场景；禁止把商品替换成别的款式。',
  douyin: '模板=信息流首屏 hero；构图=3:4 或竖版、单一强焦点、前后层次明显、主体在首屏安全区域内；光线=有动势的明亮商业光；背景=简洁纯色或轻场景；预留大面积后置文案区，禁止夸张承诺和遮挡商品。',
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

function imageReferencesFromPayload(payload: unknown): string[] {
  if (!record(payload)) return []
  // Relays use both the OpenAI envelope (`data: []`) and the New API
  // envelope (`data: { data: [] }`). Keep the accepted shapes explicit so a
  // provider response is not mistaken for a successful artifact merely
  // because it contains an unrelated nested URL.
  const dataNode = record(payload.data) ? payload.data : undefined
  const resultNode = dataNode && record(dataNode.result) ? dataNode.result : undefined
  const rootItems = [
    ...(Array.isArray(payload.data) ? payload.data : []),
    ...(Array.isArray(payload.images) ? payload.images : []),
    ...(dataNode && Array.isArray(dataNode.data) ? dataNode.data : []),
    ...(dataNode && Array.isArray(dataNode.images) ? dataNode.images : []),
    ...(resultNode && Array.isArray(resultNode.data) ? resultNode.data : []),
  ]
  const metadata = record(payload.metadata) ? payload.metadata : undefined
  const output = metadata && record(metadata.output) ? metadata.output : undefined
  const choices = output && Array.isArray(output.choices) ? output.choices : []
  const choiceItems = choices.flatMap(choice => {
    if (!record(choice) || !record(choice.message) || !Array.isArray(choice.message.content)) return []
    return choice.message.content
  })
  const items = [...choiceItems, ...rootItems]
  return items.flatMap(item => {
    if (typeof item === 'string') {
      if (/^https:\/\//u.test(item) || /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/iu.test(item)) return [item]
      return []
    }
    if (!record(item)) return []
    if (typeof item.url === 'string' && /^https:\/\//u.test(item.url)) return [item.url]
    if (typeof item.image === 'string' && /^https:\/\//u.test(item.image)) return [item.image]
    if (typeof item.b64_json === 'string' && item.b64_json.trim()) return [`data:image/png;base64,${item.b64_json}`]
    return []
  }).filter((value, index, values) => values.indexOf(value) === index)
}

function dataUrlDigest(value: string): string | undefined {
  const match = /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/iu.exec(value)
  if (!match) return undefined
  return createHash('sha256').update(Buffer.from(match[1]!, 'base64')).digest('hex')
}

export class OpenAICompatibleImageGenerator implements ImageGenerator {
  private readonly fetchImpl: typeof fetch
  constructor(private readonly options: OpenAICompatibleImageGeneratorOptions) {
    if (!options.baseUrl.trim() || !options.apiKey.trim() || !options.model.trim()) throw new Error('image provider URL, API key and model are required')
    assertRelayBaseUrl(options.baseUrl)
    validateImageRelayPath(options.editPath)
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
      const imageSize = brief?.size ?? this.options.size ?? '1024x1024'
      const [canvasWidth, canvasHeight] = imageSize.split('x').map(Number)
      const isLongPage = canvasHeight! >= canvasWidth! * 3
      const platform = brief?.platform?.trim().toLowerCase()
      const platformDna = platform ? PLATFORM_VISUAL_DNA[platform] ?? `目标平台为 ${platform}，使用适合移动端商品详情页的高转化信息层级。` : '使用适合移动端商品详情页的高转化信息层级。'
      const heroTemplate = platform ? PLATFORM_HERO_TEMPLATES[platform] ?? '模板=通用商品 hero；构图=商品完整、主体突出、留白均衡；光线=均匀商业柔光；背景=简洁纯色。' : '模板=通用商品 hero；构图=商品完整、主体突出、留白均衡；光线=均匀商业柔光；背景=简洁纯色。'
      const placement = brief?.placement?.trim() || '商品详情页运营图'
      const bannerRequested = brief?.outputVariant === 'banner' || /banner|横幅|广告位|活动头图/iu.test(`${input.direction} ${placement}`)
      const sceneRequested = /场景|户外|通勤|生活方式|lifestyle|environment|outdoor|commut/iu.test(`${input.direction} ${placement}`)
      const slotGuidance = isLongPage ? '槽位为完整商品详情页长图：从上到下制作多个连续章节，统一字体和视觉系统，包含首屏、细节展示和已知规格信息，禁止只做一个模块或把内容缩成正方形。' : bannerRequested
        ? '槽位为电商 Banner/活动头图：采用横向视觉层级，商品与核心利益点形成单一焦点，预留左右安全区和响应式裁切区；营销文案只使用已确认标签，最多一个主 CTA，不堆叠角标或长段落。'
        : sceneRequested
        ? '槽位为场景型商品主图：必须把商品置于与品类匹配的真实、简洁环境中，形成可见的前景、中景和背景层次；商品仍占画面主要视觉面积，款式、颜色、结构和材质严格跟随参考图。'
        : /主图|listing|hero/iu.test(placement)
        ? '槽位为商品主图：只展示单件商品正面，商品占画面主体，白底或极浅灰背景，不做营销海报。'
        : /细节|detail/iu.test(placement)
          ? '槽位为商品细节图：只放大展示原图中可验证的材质、结构或接口，不新增不可见功能。'
          : /场景|lifestyle|使用/iu.test(placement)
            ? '槽位为使用场景图：允许真实环境和人物，但商品颜色、款式、比例必须严格跟随参考图。'
            : '槽位为详情页模块图：只完成一个明确任务，背景、文案和装饰服从商品事实。'
      const skuLabels = boundedList(brief?.skuLabels, 12, 80)
      const sellingPoints = boundedList(brief?.sellingPoints, 6, 120)
      const styleKeywords = boundedList(brief?.styleKeywords, 8, 80)
      const marketingLabels = boundedList(brief?.marketingLabels, 8, 120)
      const trafficKeywords = boundedList(brief?.trafficKeywords, 8, 60)
      const logoAssetIds = boundedList(brief?.logoAssetIds, 4, 120)
      const promotionLabels = boundedList(brief?.promotionLabels, 4, 120)
      const detailSections = boundedList(brief?.detailSections, 10, 120)
      const platformRules = boundedList(brief?.platformRules, 8, 160)
      const competitorStructures = boundedList(brief?.competitorStructures, 6, 160)
      const competitorThemes = boundedList(brief?.competitorThemes, 6, 160)
      const differentiationAngles = boundedList(brief?.differentiationAngles, 6, 160)
      const copy = [brief?.headline, brief?.subheadline, brief?.cta].map(value => value?.trim()).filter(Boolean).map(value => value!.slice(0, 120))
      const isMainImage = /主图|白底/iu.test(input.direction) || /主图/iu.test(brief?.placement ?? '')
      const contentPlatformMainImage = isMainImage && (platform === 'xiaohongshu' || platform === 'douyin')
      const sceneMainImage = isMainImage && sceneRequested
      const hasMarketingLayer = Boolean(logoAssetIds.length || sellingPoints.length || trafficKeywords.length || marketingLabels.length || promotionLabels.length || copy.length)
      const effectiveHeroTemplate = sceneMainImage
        ? '模板=场景型搜索首屏 hero；构图=商品为唯一主角并占主要视觉面积，使用明确景深、环境层次和干净留白；光线=符合场景的自然商业光；背景=与品类匹配的真实简洁环境；禁止白底抠图复用、促销贴纸和虚构信息。'
        : heroTemplate
      const prompt = [
        `生成电商商品运营视觉：商品是“${input.productTitle}”，${input.category ? `类目是“${input.category}”，` : ''}模式：${input.mode ?? 'create'}。`,
        modeInstruction,
        `版位：${placement}。${platformDna}${slotGuidance}`,
        isMainImage ? `平台模板执行：${effectiveHeroTemplate}` : '',
        platformRules.length ? `已冻结的平台规则：${platformRules.join('；')}。` : '',
        competitorStructures.length || competitorThemes.length || differentiationAngles.length
          ? `同平台同类竞品研究（仅借鉴构图与表达趋势，不复制品牌、商品事实或原文）：结构=${competitorStructures.join('、') || '无'}；表达主题=${competitorThemes.join('、') || '无'}；差异化机会=${differentiationAngles.join('、') || '无'}。` : '',
        isLongPage
          ? `长图必须按以下连续章节完成，每章解决一个购买顾虑，章节之间用同一套网格、字体、色板和光影衔接：${(detailSections.length ? detailSections : ['首屏价值主张：商品与核心收益', '痛点场景：用户为何需要', '核心卖点：最多三个已证据支持的收益', '使用流程：步骤化说明', '细节证据：材质/结构/工艺', '参数规格：尺寸/容量/适配', 'SKU与套餐边界：包含与不包含', '信任与行动：售后与克制 CTA']).join(' → ')}。每章只放一个结论，正文保持短句，严禁把多个正方形卡片简单纵向拼接。` : '',
        `风格方向：${input.direction}。${styleKeywords.length ? `品牌/风格关键词：${styleKeywords.join('、')}。` : ''}`,
        skuLabels.length ? `只展示已确认的 SKU 标签：${skuLabels.join('、')}。` : '',
        sellingPoints.length ? `围绕已确认卖点组织视觉层级：${sellingPoints.join('；')}。` : '',
        copy.length ? `已确认的短文案仅作为排版参考：${copy.join('｜')}。` : '',
        trafficKeywords.length ? `已确认的搜索/流量关键词只能作为短标签排版，不得扩展为排名、销量或功效承诺：${trafficKeywords.join('、')}。` : '',
        logoAssetIds.length ? `品牌 Logo 已授权，引用素材 ID ${logoAssetIds.join('、')}；必须原样使用、保持比例与安全区，不得重绘、变形、改字或伪造 Logo。` : '未提供已授权品牌 Logo，不得臆造任何 Logo 或品牌标识。',
        promotionLabels.length ? `已确认促销活动标签（仅原样排版，不得改价、补折扣或延长有效期）：${promotionLabels.join('｜')}。` : '',
        marketingLabels.length ? `已确认营销文案（仅原样排版，不得改写或补数字）：${marketingLabels.join('｜')}。` : '',
        isMainImage && hasMarketingLayer ? '这是营销版商品主图：在不遮挡商品的前提下，必须形成清晰的营销排版层——品牌 Logo 安全区、一个核心卖点/主标题、最多三个已确认短标签、已确认活动标签（若有）和一个克制 CTA（若有）；使用明确网格、字号层级和可读对比，不能只返回白底商品照。中文文字尽量短、整洁、可读；未确认的字段留空，不要自行补写。' : '',
        bannerRequested
          ? 'Banner 必须让商品、核心利益点和 CTA 在缩略图中仍可识别；商品放在视觉重心一侧，另一侧保留可读文案安全区，背景使用品牌/活动氛围但不得抢过商品。不得绘制未经确认的价格、折扣、销量、倒计时、平台 Logo 或二维码。'
          : '',
        contentPlatformMainImage
          ? '内容电商主图必须做出明显的新视觉方案：使用真实生活方式场景或简洁有层次的环境、3:4 或竖版阅读构图、单一视觉焦点和可后置排版的安全区；禁止把商品孤零零地原样抠在白底上。'
          : sceneMainImage
          ? '用户已明确要求重新设计场景：必须生成肉眼可识别的新环境、新景深和新光影关系，不能使用纯白/浅灰无缝背景，不能只放大、裁切、锐化或原样回传参考图。商品应自然融入场景，但不得增加参考图中不存在的 Logo、图案、配件或功能。'
          : isMainImage && hasMarketingLayer
          ? '主图需重新设计为平台搜索首屏营销构图：商品仍是最大视觉焦点，营销信息放在预留安全区，使用一处主标题、少量卖点标签和轻量活动徽章，保持商品轮廓、颜色、材质、结构和 SKU 不变；禁止把画面做成廉价促销海报、禁止虚构 Logo/价格/折扣/销量/认证/功效。'
          : isMainImage
          ? '电商主图必须使用纯白无缝背景，但必须做出肉眼可识别的新构图设计：使用不同于参考图的主体尺度与留白比例、轻微三分之四视觉层次或结构化裁切、精致接触阴影与轮廓光，形成明确的新主图版式；禁止任何文字、信息卡片、水印、Logo 臆造、边框、道具和复杂场景。即使参考图已经是白底，也必须重新渲染一张具有新构图的图片：不得只做像素级复制、不得原样回传参考图像素。商品颜色、款式、材质、结构、Logo 和 SKU 必须与参考图完全一致，严禁改色、换款或重绘成另一件商品。'
          : '画面不要素白：加入有层级的背景、材质/场景细节、信息卡片、几何图形或纹理，但装饰必须服务于商品和卖点。信息卡片只承载已确认文案，采用清晰网格、统一圆角和 8px 倍数间距，避免廉价贴纸堆叠。',
        '商品本体、Logo、包装、SKU 对应关系和已确认事实不可改变；不要编造价格、折扣、认证、功效、销量、评论或配件。',
        '参考图是商品主体的唯一视觉事实来源；如果文字描述、自动解析结果或模型上下文与参考图冲突，忽略冲突描述，严格保留参考图中的商品类别、颜色、材质、结构和配件，不得把商品替换成其他品类。',
        '生成前自检：场景类型、平台比例、商品身份、颜色、结构、材质、Logo、SKU、主体完整性和可读性必须同时满足；任一项无法满足就不要把结果当作合格候选。',
        hasMarketingLayer ? '这是后置排版流程：模型只负责生成商品、场景、光影和构图，严禁在图片中绘制任何文字、中文、英文、数字、Logo、促销标签或水印；请在画面左侧或上方预留干净、连续、无纹理的文案安全区，准确文案将由程序后置排版。' : '中文长文案和精确事实文字不要交给模型直接绘制；为后置排版保留清晰安全区，并返回适合叠加真实文案的构图。',
        isMainImage
          ? '商品主体清晰完整，保持原图的颜色、结构、材质和比例，不得改色、换款、增加图案或生成文字。'
          : '商品主体清晰完整，避免无信息的极简海报、随机英文、乱码和不可读的小字。',
      ].filter(Boolean).join('')
      const sourceAssetRefs = [...new Set((input.sourceAssetRefs ?? []).map(ref => ref.trim()).filter(Boolean))].slice(0, 10)
      const sourceImages = (input.sourceImages ?? []).filter(image => /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/iu.test(image)).slice(0, 10)
      if (input.mode === 'optimize' && sourceImages.length === 0) {
        throw new ProviderRequestFailedError('image-source', 422, 'image optimize requires an uploaded source image', undefined, 'SOURCE_IMAGE_REQUIRED: optimize mode cannot fall back to text-only generation')
      }
      // Qwen native input preserves both reference pixels and canvas size.
      // The relay multipart Ali edit converter drops size.
      const nativeQwen = /^qwen-image-/iu.test(this.options.model)
      const requestBody = JSON.stringify({
        model: this.options.model,
        prompt,
        ...(isMainImage ? { negative_prompt: '文字，中文文字，英文文字，数字，乱码，信息卡片，标签，水印，臆造Logo，品牌标识，边框，道具，人物，复杂场景，廉价促销海报，阴影过重，裁切，缺失袖子，变形衣物，改色，换款' } : {}),
        n: input.count,
        size: imageSize,
        ...(this.options.quality ? { quality: this.options.quality } : {}),
        ...(this.options.outputFormat ? { output_format: this.options.outputFormat } : {}),
        response_format: this.options.responseFormat ?? 'b64_json',
        ...(nativeQwen ? { parameters: { size: imageSize.replace('x', '*'), n: input.count, watermark: false }, input: { messages: [{ role: 'user', content: [...sourceImages.map(image => ({ image })), { text: prompt }] }] } } : {}),
        image_mode: input.mode ?? 'create',
        ...(input.mode === 'optimize' ? { source_image_required: true } : {}),
        ...(sourceAssetRefs.length ? { source_asset_refs: sourceAssetRefs } : {}),
        ...(sourceImages.length ? { image: sourceImages } : {}),
        ...(sourceImages.length ? { input_image: sourceImages[0] } : {}),
      })
      const providerKey = options.providerOperationKey?.trim() || providerIdempotencyKey({ operation: 'image_generate', model: this.options.model, workspaceId: input.usageContext?.workspaceId, actionId: input.usageContext?.actionId, requestBody })
      if (providerKey.length > 255 || /[\u0000-\u001f\u007f]/u.test(providerKey)) throw new Error('provider operation key is invalid')
      // OpenAI-compatible edits require multipart image files. JSON image
      // fields on /images/generations may be silently ignored by relays.
      const editing = input.mode === 'optimize' && !nativeQwen
      imageTrace('provider.request', {
        model: this.options.model,
        operation: editing ? 'image_edit' : 'image_generate',
        provider_request_id: providerKey,
        size: imageSize,
        count: input.count,
        mode: input.mode ?? 'create',
        source_image_count: sourceImages.length,
        source_asset_ref_count: sourceAssetRefs.length,
        long_page: isLongPage,
        marketing_layer: hasMarketingLayer,
        selling_point_count: sellingPoints.length,
        traffic_keyword_count: trafficKeywords.length,
        promotion_label_count: promotionLabels.length,
        logo_asset_count: logoAssetIds.length,
        marketing_copy_count: copy.length,
      })
      const editBody = editing ? new FormData() : undefined
      if (editBody) {
        editBody.set('model', this.options.model)
        editBody.set('prompt', prompt)
        editBody.set('n', String(input.count))
        editBody.set('size', imageSize)
        editBody.set('response_format', this.options.responseFormat ?? 'b64_json')
        for (const [index, source] of sourceImages.entries()) {
          const [header, encoded] = source.split(',')
          const mime = header!.slice(5, header!.indexOf(';'))
          editBody.append(sourceImages.length === 1 ? 'image' : 'image[]', new Blob([Buffer.from(encoded!, 'base64')], { type: mime }), `source-${index}.${mime.split('/')[1]}`)
        }
      }
      let response: Response
      try {
        if (this.options.relaySecurity?.environment || this.options.relaySecurity?.allowedHosts?.length) await assertRelayUrl(this.options.baseUrl, this.options.relaySecurity)
        response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, '')}${editing ? this.options.editPath ?? '/images/edits' : this.options.path ?? '/images/generations'}`, {
          method: 'POST',
          headers: { accept: 'application/json', ...(!editing ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${this.options.apiKey}`, 'idempotency-key': providerKey },
          body: editBody ?? requestBody,
          signal: controller.signal,
          redirect: 'error',
        })
      } catch (error) { rethrowProviderTransportFailure(error, providerKey, 'image provider request') }
      let responseText: string
      try { responseText = await readBoundedResponseText(response, MAX_IMAGE_RELAY_RESPONSE_BYTES, 'image provider response') }
      catch (error) { rethrowProviderTransportFailure(error, providerKey, 'image provider response') }
      let payload: unknown
      try { payload = JSON.parse(responseText) as unknown }
      catch (error) {
        assertProviderResponseAccepted(response, providerKey, 'image provider', undefined)
        throwProviderOutcomeUnknown(providerKey, 'image provider response parsing', error)
      }
      const providerError = providerErrorSummary(payload)
      imageTrace('provider.response', { model: this.options.model, provider_request_id: providerKey, http_status: response.status, provider_error: providerError.summary ?? null, response_item_count: record(payload) && Array.isArray(payload.data) ? payload.data.length : 0, parsed_image_count: imageReferencesFromPayload(payload).length })
      assertProviderResponseAccepted(response, providerKey, 'image provider', providerError.summary)
      if (providerError.summary) {
        const requestId = providerError.requestId
        if (requestId) throw new ProviderOutcomeUnknownError(providerKey, `image provider returned ${providerError.summary}; outcome requires reconciliation`, undefined, response.status, requestId, providerError.summary)
        throw new ProviderRequestFailedError(providerKey, response.status || 502, `image provider returned ${providerError.summary}`, undefined, providerError.summary)
      }
      const images = imageReferencesFromPayload(payload).slice(0, input.count)
      if (images.length !== input.count) throwProviderOutcomeUnknown(providerKey, 'image provider incomplete result')
      if (input.mode === 'optimize' && sourceImages.length > 0) {
        const sourceDigests = new Set(sourceImages.map(dataUrlDigest).filter((value): value is string => Boolean(value)))
        const unchanged = images.some(image => {
          const digest = dataUrlDigest(image)
          return Boolean(digest && sourceDigests.has(digest))
        })
        if (unchanged) {
          throw new ImageOutputUnchangedError(providerKey)
        }
      }
      // Artifact delivery is downstream of durable usage/cost settlement. A
      // provider response must never reach the worker callback when its
      // receipt cannot be recorded; this is the image equivalent of the text,
      // OCR, edit and video adapters' fail-closed boundary.
      await emitRelayUsage(this.options.usageSink, payload, response.headers, { modality: 'image', model: this.options.model, context: { ...input.usageContext, billingUnits: input.count, providerAttemptId: providerKey } })
      const finalImages = hasMarketingLayer
        ? await composeMarketingImages(images, { productTitle: input.productTitle, ...brief }, this.fetchImpl)
        : images
      imageTrace('compositor.completed', { provider_request_id: providerKey, input_count: images.length, output_count: finalImages.length, marketing_layer: hasMarketingLayer })
      return finalImages
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
    ...(source.IMAGE_EDIT_PATH?.trim() ? { editPath: source.IMAGE_EDIT_PATH.trim() } : {}),
    ...(source.IMAGE_STATUS_PATH?.trim() ? { statusPath: source.IMAGE_STATUS_PATH.trim() } : {}),
    timeoutMs: Number(source.IMAGE_TIMEOUT_MS ?? 300_000),
    size: source.IMAGE_SIZE?.trim() || '1024x1024',
    ...(source.IMAGE_QUALITY?.trim() ? { quality: source.IMAGE_QUALITY.trim() } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    responseFormat,
    ...(usageSink ? { usageSink } : {}),
  })
}
