import { alertNotificationReadiness } from './alert-notifier.js'
import { evaluatePlatformModelRelayGate, evaluatePlatformModelGate, evaluatePlatformModelCostGate } from '../../../packages/ai/src/platform-model-gate.js'
import type { Platform } from '../../../packages/application/src/service.js'
import type { ConnectorRuntime } from '../../../packages/application/src/connector-runtime.js'
import type { PaymentChannel } from '../../../packages/billing/src/payment-provider.js'
import type { paymentCapabilityStatus as paymentCapabilityStatusType } from './server.js'

type Gate = { ready: boolean; reasons: string[] }
type PaymentReadiness = {
  ready: boolean
  reasons: string[]
  supportedChannels: readonly PaymentChannel[]
  channelReadiness: Partial<Record<PaymentChannel, { ready: boolean; reasons: string[] }>>
}
type EvidenceReadiness = { configured: boolean; state: string; reasons: string[] }
export interface SetupDiagnosticsDependencies {
  isProduction: () => boolean
  fixtureMode: boolean
  paymentProviderReadiness: () => PaymentReadiness
  imageFactsExtractor: unknown
  imageEditGenerator: unknown
  videoGenerator: unknown
  requiredModelCostEvidenceByModality: () => Record<string, boolean>
  connectorRuntime: Pick<ConnectorRuntime, 'credentialProviderConfigured' | 'readiness' | 'isHttpConfigured' | 'isOAuthConfigured' | 'canRead'>
  configuredEnv: (...keys: string[]) => boolean
  lifecycleDiagnostics: () => { configured: boolean }
  productionReadinessDiagnostics: () => { ready: boolean; gates: Record<string, Gate>; required: boolean }
  evidenceReadiness: (kind: 'capability' | 'capacity') => EvidenceReadiness
  SUPPORTED_PLATFORMS: readonly Platform[]
  manualPlatformEnabled: (platform: Platform) => boolean
  fixturePlatformEnabled: (platform: Platform) => boolean
  paymentCapabilityStatus: typeof paymentCapabilityStatusType
}

/** A safe, secret-free setup report for the Codex App. It tells the operator
 * what can run locally and what still needs real credentials/infrastructure,
 * without echoing tokens, keys, endpoints, or bucket names. */
export function setupDiagnostics(options: { commercialReadiness?: { ready: boolean; reasons?: string[] } } = {}, deps: SetupDiagnosticsDependencies) {
  const { isProduction, fixtureMode, paymentProviderReadiness, imageFactsExtractor, imageEditGenerator, videoGenerator, requiredModelCostEvidenceByModality, connectorRuntime, configuredEnv, lifecycleDiagnostics, productionReadinessDiagnostics, evidenceReadiness, SUPPORTED_PLATFORMS, manualPlatformEnabled, fixturePlatformEnabled, paymentCapabilityStatus } = deps
  const production = isProduction()
  const configuredPlatformOperationsMode = process.env.PLATFORM_OPERATIONS_MODE?.trim().toLowerCase()
  const platformOperationsMode = configuredPlatformOperationsMode === 'manual' || configuredPlatformOperationsMode === 'official_api'
    ? configuredPlatformOperationsMode
    : production ? 'invalid' : fixtureMode ? 'fixture' : 'manual'
  const manualPlatformOperations = platformOperationsMode === 'manual'
  const relayGate = evaluatePlatformModelRelayGate(process.env)
  const paymentReadiness = paymentProviderReadiness()
  const contentProviderConfigured = evaluatePlatformModelGate(process.env, 'text').ready
  const imageProviderConfigured = evaluatePlatformModelGate(process.env, 'image').ready
  const imageEditModelGate = evaluatePlatformModelGate(process.env, 'image_edit')
  const ocrModelGate = evaluatePlatformModelGate(process.env, 'ocr')
  const videoModelGate = evaluatePlatformModelGate(process.env, 'video')
  const embeddingModelGate = evaluatePlatformModelGate(process.env, 'embedding')
  const imageFactsConfigured = Boolean(imageFactsExtractor) && ocrModelGate.ready
  const imageEditProviderConfigured = Boolean(imageEditGenerator) && imageEditModelGate.ready
  const videoProviderConfigured = Boolean(videoGenerator) && videoModelGate.ready
  // Configuration alone must not advertise vector indexing. The worker stays
  // lexical until the dedicated durable authorization/budget workflow is
  // explicitly enabled for the release.
  const vectorIndexEnabled = process.env.KNOWLEDGE_VECTOR_INDEX_ENABLED === 'true'
  const embeddingProviderConfigured = vectorIndexEnabled && embeddingModelGate.ready
  const modelCostGateConfigured = evaluatePlatformModelCostGate(process.env).ready && Object.values(requiredModelCostEvidenceByModality()).every(Boolean)
  const vaultConfigured = connectorRuntime.credentialProviderConfigured && !fixtureMode
  const localAcceptanceObjectStorage = production && process.env.DEPLOYMENT_PROFILE === 'local_acceptance' && process.env.ALLOW_LOCAL_DURABLE_OBJECT_STORAGE === 'true' && (process.env.ASSET_STORAGE_ROOT?.startsWith('/var/lib/merchant-assets/') ?? false)
  const configuredSseMode = String(process.env.ASSET_STORAGE_SSE_MODE?.trim() || (configuredEnv('ASSET_STORAGE_KMS_KEY_ID') ? 'aws:kms' : 'AES256')).toLowerCase()
  const objectStorageConfigured = production
    ? localAcceptanceObjectStorage || (configuredEnv('ASSET_STORAGE_BUCKET') && configuredEnv('ASSET_STORAGE_REGION') && configuredEnv('ASSET_STORAGE_ENDPOINT') && ['aes256', 'aws:kms'].includes(configuredSseMode) && (configuredSseMode !== 'aws:kms' || configuredEnv('ASSET_STORAGE_KMS_KEY_ID')))
    : true
  const dataLifecycle = lifecycleDiagnostics()
  const alertNotifications = alertNotificationReadiness()
  const controlPlaneReadiness = productionReadinessDiagnostics()
  const commercialReadiness = production
    ? options.commercialReadiness ?? { ready: false, reasons: ['commercial_readiness_not_checked'] }
    : { ready: true, reasons: [] as string[] }
  const capabilityEvidence = evidenceReadiness('capability')
  const capacityEvidence = evidenceReadiness('capacity')
  const platformDiagnostics = Object.fromEntries(SUPPORTED_PLATFORMS.map(platform => {
    const readiness = connectorRuntime.readiness[platform]
    return [platform, {
      mode: manualPlatformEnabled(platform) ? 'manual_operations' : fixturePlatformEnabled(platform) ? 'fixture' : connectorRuntime.isHttpConfigured(platform) ? 'official_api' : connectorRuntime.isOAuthConfigured(platform) ? 'oauth_only' : 'not_configured',
      oauthConfigured: connectorRuntime.isOAuthConfigured(platform),
      httpConfigured: connectorRuntime.isHttpConfigured(platform),
      credentialProviderConfigured: vaultConfigured,
      ready: manualPlatformEnabled(platform) || fixturePlatformEnabled(platform) || connectorRuntime.canRead(platform),
      reasons: manualPlatformEnabled(platform) ? ['manual_upload_required'] : fixturePlatformEnabled(platform) ? [] : readiness.reasons,
    }]
  }))
  const nextActions: string[] = []
  if (platformOperationsMode === 'invalid') nextActions.push('生产环境必须显式配置 PLATFORM_OPERATIONS_MODE=manual 或 official_api；当前保持上线阻断')
  if (fixtureMode) nextActions.push('当前是 Codex 本地 fixture 模式；真实业务应显式选择人工运营（PLATFORM_OPERATIONS_MODE=manual）或官方接口（official_api）')
  if (production && !relayGate.ready) nextActions.push('配置 HTTPS MODEL_RELAY_BASE_URL 和平台托管的 MODEL_RELAY_API_KEY；生产模型 token 只允许经自有中转站转发')
  if (!contentProviderConfigured) nextActions.push('配置平台模型中转站、AI_MODEL 和平台密钥后，启用真实商品文案生成；当前文案生成使用本地规则/fixture 回退')
  if (!imageProviderConfigured) nextActions.push('配置平台模型中转站、IMAGE_MODEL 和平台密钥后，启用真实商品主图生成；当前主图生成使用本地规则/fixture 回退')
  if (!imageEditProviderConfigured) nextActions.push('配置 IMAGE_EDIT_MODEL（或复用 IMAGE_MODEL）和图片编辑中转 provider 后启用局部图片编辑；未配置时保留原图并阻断编辑请求')
  if (!imageFactsConfigured) nextActions.push('配置平台模型中转站、MODEL_RELAY_API_KEY 和 OCR_MODEL 后启用图片 OCR 候选；未配置时继续要求商家人工确认图片事实')
  if (!videoProviderConfigured) nextActions.push('配置平台模型中转站、MODEL_RELAY_API_KEY、VIDEO_MODEL 和视频 provider 后启用视频渲染；未配置时只能生成无渲染分镜')
  if (process.env.KNOWLEDGE_VECTOR_INDEX_ENABLED === 'true' && !embeddingProviderConfigured) nextActions.push('知识库向量索引已显式启用但未通过门禁：需配置 EMBEDDING_MODEL/EMBEDDING_DIMENSIONS，并完成后台索引专用授权、预算预留和用量结算；当前保持阻断')
  if (!modelCostGateConfigured) nextActions.push('配置平台模型 RPM、TPM 和每日人民币成本上限；成本门禁未通过时生产模型请求保持阻断')
  if (production && !paymentReadiness.ready) nextActions.push('配置支付宝/微信服务端 checkout provider、商户号、回调验签、对账和退款能力：' + paymentReadiness.reasons.join('、'))
  if (platformOperationsMode === 'official_api' && !vaultConfigured) nextActions.push('official_api 模式需配置 VAULT_ADDR 和 VAULT_TOKEN（或接入外部凭据服务），让服务端安全读取商家授权凭据；不要把平台 token 放进插件参数')
  if (!objectStorageConfigured) nextActions.push('配置生产对象存储 bucket、region、HTTPS endpoint 和 KMS key，素材上传才可切换到云端持久化')
  if (!dataLifecycle.configured) nextActions.push('补齐生产数据生命周期、对象版本化和存储控制引用；缺少删除与保留门禁时禁止接收真实商家数据')
  if (production && alertNotifications.enabled && !alertNotifications.ready) nextActions.push(`配置可验证的告警 Webhook、允许主机和签名密钥：${alertNotifications.reason}`)
  if (production && !controlPlaneReadiness.ready) {
    for (const [name, gate] of Object.entries(controlPlaneReadiness.gates)) {
      if (!gate.ready) nextActions.push(`生产控制面 ${name} 未就绪：${gate.reasons.join('、')}`)
    }
  }
  if (production && !commercialReadiness.ready) nextActions.push(`商业目录/费率未通过生产准入：${commercialReadiness.reasons?.join('、') || 'commercial_readiness_not_checked'}`)
  if (platformOperationsMode === 'official_api' && !capabilityEvidence.configured) nextActions.push('official_api 模式未检测到通过发布门禁的平台 capability 证据（六平台范围）；example、fixture 或 test_e2e 证据不能标记生产可写')
  // Capacity evidence is retained as an observable production-evidence field,
  // but it is no longer a runtime admission gate. This deployment intentionally
  // has no separate preproduction environment; async workers must be able to
  // operate on the live ECS installation while capacity evidence is collected
  // as a follow-up operational artifact.
  if (!production) nextActions.push('当前不是生产模式；上线前还需完成 TLS/DNS/WAF、备份恢复、容量压测及所选运营模式验收')
  const platformOperationsReady = manualPlatformOperations || (platformOperationsMode === 'official_api' && Object.values(platformDiagnostics).every(item => item.ready) && vaultConfigured && capabilityEvidence.configured)
  const productionGate = production && !fixtureMode && platformOperationsMode !== 'invalid' && platformOperationsReady && commercialReadiness.ready && controlPlaneReadiness.ready && relayGate.ready && paymentReadiness.ready && contentProviderConfigured && imageProviderConfigured && imageEditProviderConfigured && imageFactsConfigured && videoProviderConfigured && modelCostGateConfigured && objectStorageConfigured && dataLifecycle.configured && alertNotifications.ready
  const payment = paymentCapabilityStatus({
    mode: process.env.PAYMENT_MODE,
    providerReady: paymentReadiness.ready,
    production,
    fixtureMode,
    productionGate,
    reasons: paymentReadiness.reasons,
    supportedChannels: paymentReadiness.supportedChannels,
    channelReadiness: paymentReadiness.channelReadiness,
  })
  return {
    mode: production ? 'production' : fixtureMode ? 'fixture' : 'local',
    ai: { ownership: 'platform', userKeyRequired: false, relay: { configured: relayGate.ready, host: relayGate.endpointHost ?? null }, contentGeneration: contentProviderConfigured ? 'configured' : fixtureMode ? 'fixture_fallback' : 'not_configured', imageGeneration: imageProviderConfigured ? 'configured' : fixtureMode ? 'fixture_fallback' : 'not_configured', imageEditing: imageEditProviderConfigured ? 'configured' : 'blocked', imageFacts: imageFactsConfigured ? 'configured' : 'manual_fallback', videoRendering: videoProviderConfigured ? 'configured' : 'storyboard_only', costGate: modelCostGateConfigured ? 'ready' : 'blocked' },
    modelReadiness: {
      text: { ...evaluatePlatformModelGate(process.env, 'text'), providerConfigured: contentProviderConfigured },
      image: { ...evaluatePlatformModelGate(process.env, 'image'), providerConfigured: imageProviderConfigured },
      image_edit: { ...imageEditModelGate, providerConfigured: imageEditProviderConfigured },
      ocr: { ...ocrModelGate, providerConfigured: imageFactsConfigured },
      video: { ...videoModelGate, providerConfigured: videoProviderConfigured },
      embedding: { ...embeddingModelGate, providerConfigured: embeddingProviderConfigured },
    },
    objectStorage: { configured: objectStorageConfigured, mode: localAcceptanceObjectStorage ? 'local_acceptance_durable' : production ? 's3_compatible' : 'local' },
    alertNotifications,
    productionControls: controlPlaneReadiness,
    commercialReadiness,
    dataLifecycle,
    platformOperations: { mode: platformOperationsMode, ready: platformOperationsReady, automatedWritesEnabled: platformOperationsMode === 'official_api' && platformOperationsReady, manualReportsAreOfficialReceipts: false },
    productionEvidence: { capability: capabilityEvidence, capacity: capacityEvidence },
    credentialProvider: { configured: vaultConfigured, required: platformOperationsMode === 'official_api', mode: fixtureMode ? 'fixture' : vaultConfigured ? 'vault_or_external' : 'none' },
    platforms: platformDiagnostics,
    payment: { mode: process.env.PAYMENT_MODE === 'provider' ? 'provider' : 'fixture', ...payment },
    productionGate,
    nextActions,
  }
}

