import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { alertNotificationReadiness, notifyOperationalAlert } from './alert-notifier.js'
import { Pool } from 'pg'
import { createClient } from 'redis'
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { MerchantService, assetReadiness, DomainError, type AssetRegistrationResult, type BrandVisualRules, type Platform, type PlatformAccount, type PlatformRejection } from '../../../packages/application/src/service.js'
import { defaultRuleCenterSeeds, type RuleHit, type RulePack } from '../../../packages/review/src/rule-center.js'
import { reviewProductImages } from '../../../packages/review/src/review.js'
import { ConnectorRuntime } from '../../../packages/application/src/connector-runtime.js'
import { allowedModelUsageSettlementDecisions, BusinessSnapshotVersionConflictError, COMMERCIAL_PLATFORMS, loadMigrations, MemoryActionLedgerRepository, MemoryBrandUnitRepository, MemoryCommercialExtensionsRepository, MemoryCommercialRepository, MemoryContextSnapshotRepository, MemoryDataLifecycleRepository, MemoryEntitlementRepository, MemoryGrowthRepository, MemoryMembersRepository, MemoryModelUsageRepository, MemoryObjectOrphanRepository, MemoryOperationsRepository, MemoryOperationalAlertsRepository, MemorySubscriptionRepository, MemoryUsageRepository, PostgresActionLedgerRepository, PostgresBillingRepository, PostgresBrandUnitRepository, PostgresBusinessRepository, PostgresCommercialExtensionsRepository, PostgresCommercialRepository, PostgresContextSnapshotRepository, PostgresDataLifecycleRepository, PostgresEntitlementRepository, PostgresGrowthRepository, PostgresMembersRepository, PostgresModelUsageRepository, PostgresObjectOrphanRepository, PostgresOperationsRepository, PostgresOperationalAlertsRepository, PostgresOutboxRepository, PostgresRuleRepository, PostgresSubscriptionRepository, PostgresUsageRepository, runMigrations, withWorkspaceTransaction, type ActionKind, type ActionLedgerRepository, type ActionSettlement, type BillingCycle, type BrandAccessRole, type BusinessEntityType, type CommercialPlatform, type CommercialExtensionsRepository, type ContextSnapshotRepository, type DataDeletionScope, type DataLifecycleRepository, type EntitlementKind, type EntitlementRepository, type GrowthRepository, type MemberRole, type MemberStatus, type MembersRepository, type ModelUsageRepository, type ModelUsageSettlementDecision, type ObjectOrphanRepository, type OperationsRepository, type OperationalAlert, type OperationalAlertsRepository, type PersistedRuleAudit, type PersistedRuleVersion, type SqlPool, type SubscriptionRepository, type UsageRepository } from '../../../packages/persistence/src/index.js'
import type { OutboxEvent, OutboxRepository } from '../../../packages/persistence/src/repository.js'
import { IdentityLifecycleError, MemoryIdentityLifecycleRepository, PostgresIdentityLifecycleRepository, type IdentityLifecycleRepository, type IdentityOperationsDetail } from '../../../packages/persistence/src/identity-lifecycle-repository.js'
import type { CampaignBatchRow, CampaignBatchState, CampaignItemRow, CampaignItemState } from '../../../packages/persistence/src/brand-unit-repository.js'
import { contextEnvelopeHash } from '../../../packages/persistence/src/context-snapshot-repository.js'
import { hashPkceVerifier, OAuthStateError, OAuthStateStore } from '../../../packages/security/src/oauth.js'
import { RedisOAuthStateStore, type OAuthRedisPort } from '../../../packages/security/src/redis-oauth.js'
import { ConnectorFailure, createVaultCredentialProviderFromEnv, isProductionCanaryReady, validatePlatformCapabilityEvidence } from '../../../packages/connectors/src/index.js'
import { platformWriteAllowed } from '../../../packages/connectors/src/write-boundary.js'
import { createContentGeneratorFromEnv, type ContentModule, type StaticBrief } from '../../../packages/ai/src/generator.js'
import { createImageGeneratorFromEnv } from '../../../packages/ai/src/image-generator.js'
import { createImageEditGeneratorFromEnv } from '../../../packages/ai/src/image-editor.js'
import { createImageFactsExtractorFromEnv } from '../../../packages/ai/src/image-facts.js'
import { createVideoGeneratorFromEnv } from '../../../packages/ai/src/video-generator.js'
import { relayUsageReceiptKey, type RelayUsageRecord } from '../../../packages/ai/src/relay-usage.js'
import { createRelayPricingClientFromEnv } from '../../../packages/ai/src/relay-pricing.js'
import { evaluatePlatformModelCostGate, evaluatePlatformModelGate, evaluatePlatformModelRelayGate } from '../../../packages/ai/src/platform-model-gate.js'
import { DocumentParseError, parseDocumentFacts } from '../../../packages/application/src/document-parser.js'
import { LocalObjectStorage, ObjectStorageError, S3CompatibleObjectStorage, withObjectStorageReadRetry, type CloudObjectTransport, type ObjectStoragePort } from '../../../packages/storage/src/index.js'
import { ERROR_CODES, isMcpMethod, validateMcpRequest, type ApiEnvelope, type McpRequest } from '../../../packages/contracts/src/index.js'
import { KnowledgeError, KnowledgeModule } from '../../../packages/knowledge/src/index.js'
import { cleanObjectStorageOrphans } from '../../../packages/workers/src/object-orphan-cleaner.js'
import { createImageEditCandidate, createOneSentenceGenerationRequest, createVideoGenerationRequest, createVideoRenderingRequest, type GenerationContext } from '../../../packages/multimodal/src/index.js'
import { generateSeoGeoSuggestions } from '../../../packages/seo/src/index.js'
import { createPaymentProviderFromEnv, type PaymentProvider } from '../../../packages/billing/src/payment-provider.js'
import { platformRuleSyncStatus } from '../../../packages/review/src/platform-rule-sync.js'
import { verifyAndParsePlatformRuleManifest } from '../../../packages/review/src/platform-rule-manifest.js'
import { assertOutboundUrl } from '../../../packages/connectors/src/outbound-security.js'
import { readBoundedResponseText } from '../../../packages/connectors/src/bounded-response.js'
import { mapWithConcurrency } from './bounded-concurrency.js'

const port = Number(process.env.PORT ?? 8787)
const fixtureMode = process.env.CONNECTOR_FIXTURE_MODE === 'true'
const maxActiveJobsPerWorkspace = Number(process.env.MAX_ACTIVE_JOBS_PER_WORKSPACE ?? 3)
const MAX_MCP_EXPORT_BYTES = 25 * 1024 * 1024
// Social-commerce platforms are API/fixture targets, but remain fail-closed
// for production until official OAuth, mapping and canary evidence exists.
const SUPPORTED_PLATFORMS: readonly Platform[] = ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin']
const PLATFORM_LABELS: Record<Platform, string> = { jd: '京东', taobao: '淘宝', tmall: '天猫', pinduoduo: '拼多多', xiaohongshu: '小红书', douyin: '抖音' }
const knowledge = new KnowledgeModule()
const relayPricing = createRelayPricingClientFromEnv(process.env)

const MERCHANT_CAPABILITY_CARDS = [
  { id: 'stores-products', title: '店铺与商品', summary: '绑定平台店铺、同步商品、查看多店铺商品事实。', entryMethod: 'platform.connect', nextMethods: ['platform.connect', 'catalog.sync.start', 'catalog.search'], readOnly: false },
  { id: 'first-value', title: '示例体验', summary: '可选查看安全预览，了解商品内容和视觉交付方式，不会发布或覆盖商品。', entryMethod: 'merchant.first_value', nextMethods: ['merchant.first_value'], readOnly: true },
  { id: 'knowledge-assets', title: '知识库与素材', summary: '管理商品原图、品牌资料、扫描状态和商用权益。', entryMethod: 'asset.list', nextMethods: ['asset.list', 'asset.upload', 'asset.parse', 'brand.get'], readOnly: true },
  { id: 'content', title: '商品内容', summary: '按事实确认、方案确认、生成、审核和版本交付商品文案。', entryMethod: 'task.understand', nextMethods: ['task.understand', 'task.plan.confirm', 'content.generate', 'content.review'], readOnly: false },
  { id: 'visuals', title: '主图与视觉', summary: '使用已授权商品素材生成候选主图，审阅后选择版本。', entryMethod: 'catalog.image.generate', nextMethods: ['catalog.image.generate', 'catalog.image.get', 'catalog.image.review', 'content.visual.select'], readOnly: false },
  { id: 'review-publish', title: '审核与发布', summary: '查看字段差异、规则结果和发布前确认状态。', entryMethod: 'publish.prepare', nextMethods: ['content.approve', 'publish.prepare', 'publish.confirm', 'publish.get'], readOnly: false },
  { id: 'bulk-publish', title: '批量发布', summary: '按店铺逐项预览、确认、暂停和重试最多 50 个商品。', entryMethod: 'publish.batch.prepare', nextMethods: ['publish.batch.prepare', 'publish.batch.confirm', 'publish.batch.get', 'publish.batch.pause', 'publish.batch.resume', 'publish.batch.retry_failed'], readOnly: false },
  { id: 'rules', title: '平台规则', summary: '按当前平台和店铺查看适用规则、版本新鲜度与生成前违规预检。', entryMethod: 'rule.sync.status', nextMethods: ['rule.sync.status', 'rule.list', 'content.review'], readOnly: true },
  { id: 'billing', title: '套餐与钱包', summary: '查看套餐、权益、模型成本和充值到账状态。', entryMethod: 'billing.status', nextMethods: ['billing.status', 'subscription.get', 'billing.reconciliation', 'billing.recharge.create'], readOnly: true },
] as const

async function recordRelayUsage(usage: RelayUsageRecord) {
  if (!usage.workspaceId) return
  const workspaceId = usage.workspaceId
  await persistenceReady
  if (!persistence.modelUsage) throw new Error('MODEL_USAGE_LEDGER_NOT_CONFIGURED')
  const receiptKey = relayUsageReceiptKey(usage)
  const policy = await (persistence.commercialExtensions ?? memoryCommercialExtensions).getModelMarkupPolicy()
  const durableAuthorization = usage.actionId ? await persistence.actionLedger?.get(workspaceId, usage.actionId) : undefined
  const effectiveMultiplier = durableAuthorization?.multiplier ?? policy.multiplier
  let pricingFailure: { code: string; message: string } | undefined
  if (isProduction() && usage.costCny === undefined && relayPricing) {
    try {
      const quote = await relayPricing.quote(usage)
      usage.costCny = quote.costCny
      usage.metadata = { ...(usage.metadata ?? {}), ...quote.metadata }
    } catch (error) {
      pricingFailure = { code: (error as { code?: string })?.code ?? 'MODEL_PRICING_DERIVATION_FAILED', message: error instanceof Error ? error.message : String(error) }
    }
  }
  if (isProduction() && usage.costCny === undefined) {
    if (durableAuthorization && usage.actionId) await persistence.actionLedger?.transitionSettlementStatus({ workspaceId, actionKey: usage.actionId, from: ['authorized', 'pending_receipt'], to: 'pending_receipt' })
    const pending = await persistence.modelUsage.record({ receiptKey, workspaceId, ...(usage.actionId ? { actionId: usage.actionId } : {}), modality: usage.modality, model: usage.model, ...(usage.providerRequestId ? { providerRequestId: usage.providerRequestId } : {}), ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}), ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}), ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}), settlementStatus: 'pending_cost', lastError: { code: pricingFailure?.code ?? 'MODEL_USAGE_COST_MISSING', message: pricingFailure?.message ?? 'provider receipt omitted actual cost' }, nextAttemptAt: new Date().toISOString(), metadata: { ...(usage.metadata ?? {}), settlement_reason: pricingFailure?.code ?? 'provider_cost_missing' } })
    const alert = await (persistence.alerts ?? memoryAlerts).upsert({ workspaceId, alertKey: `model-cost-missing:${receiptKey}`, code: pricingFailure?.code ?? 'MODEL_USAGE_COST_MISSING', severity: 'high', entityType: 'model_usage', entityId: pending.id, title: '模型中转成本证据不足，结果已阻断交付', observedAt: usage.observedAt, evidence: { receipt_key: receiptKey, modality: usage.modality, model: usage.model, provider_request_id: usage.providerRequestId ?? null, action_id: usage.actionId ?? null, pricing_error: pricingFailure ?? null }, nextAction: '核对中转站回执成本或价格快照、计费分组和汇率；完成待结算记录后再恢复模型交付。' })
    void notifyOperationalAlert(alert).catch(() => undefined)
    throw Object.assign(new Error('model relay usage is missing actual cost'), { code: 'MODEL_USAGE_COST_MISSING' })
  }
  const customerChargeCny = usage.costCny === undefined ? undefined : Number((usage.costCny * effectiveMultiplier).toFixed(6))
  const recordedUsage = await persistence.modelUsage.record({ receiptKey, workspaceId, ...(usage.actionId ? { actionId: usage.actionId } : {}), modality: usage.modality, model: usage.model, ...(usage.providerRequestId ? { providerRequestId: usage.providerRequestId } : {}), ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}), ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}), ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}), ...(usage.costCny !== undefined ? { costCny: usage.costCny, markupMultiplier: effectiveMultiplier, customerChargeCny, pricingPolicyRevision: policy.revision, settlementStatus: 'pending_wallet' as const } : { settlementStatus: 'pending_cost' as const }), ...(usage.metadata ? { metadata: usage.metadata } : {}) })
  if (recordedUsage.settlementStatus === 'settled' || recordedUsage.settlementStatus === 'waived') return
  const reservation = usage.actionId ? modelBillingReservations.get(`${workspaceId}:${usage.actionId}`) : undefined
  const durableWalletAuthorization = durableAuthorization && (durableAuthorization.settlement === 'wallet' || durableAuthorization.settlement === 'wallet_overage') ? durableAuthorization : undefined
  try {
    if ((durableWalletAuthorization || reservation) && recordedUsage.customerChargeCny !== undefined) {
      const actualAmountFen = Math.max(1, Math.ceil(recordedUsage.customerChargeCny * 100))
      if (durableWalletAuthorization && usage.actionId) {
        await persistence.actionLedger?.transitionSettlementStatus({ workspaceId, actionKey: usage.actionId, from: ['authorized', 'pending_receipt'], to: 'pending_receipt' })
        await settlePluginWalletDebit({ workspaceId, debitIdempotencyKey: usage.actionId, finalAmountFen: actualAmountFen, actorId: durableWalletAuthorization.actorId, providerRequestId: usage.providerRequestId })
        modelBillingReservations.delete(`${workspaceId}:${usage.actionId}`)
      } else if (reservation) {
        const requestKey = usage.providerRequestId ?? receiptKey
        if (!reservation.providerRequests.has(requestKey)) {
          if (reservation.providerRequests.size === 0) await settlePluginWalletDebit({ workspaceId, debitIdempotencyKey: reservation.debitIdempotencyKey, finalAmountFen: actualAmountFen, actorId: reservation.actorId, providerRequestId: usage.providerRequestId })
          else await debitPluginWallet({ workspaceId, amountFen: actualAmountFen, idempotencyKey: `model-usage:${receiptKey}`, actorId: reservation.actorId, description: '模型修复请求真实用量结算' })
          reservation.providerRequests.add(requestKey)
        }
      }
    }
    await persistence.modelUsage.resolve({ workspaceId, id: recordedUsage.id, expectedRevision: recordedUsage.revision, status: 'settled', actorId: 'model-usage-settlement', reason: '中转回执成本与钱包结算完成', evidenceRef: usage.providerRequestId ?? receiptKey })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      if (durableAuthorization && usage.actionId) await persistence.actionLedger?.transitionSettlementStatus({ workspaceId, actionKey: usage.actionId, from: ['authorized', 'pending_receipt'], to: 'pending_receipt' })
      await persistence.modelUsage.resolve({ workspaceId, id: recordedUsage.id, expectedRevision: recordedUsage.revision, status: 'pending_wallet', actorId: 'model-usage-settlement', reason: '等待钱包结算重试', lastError: { code: (error as { code?: string })?.code ?? 'MODEL_USAGE_WALLET_SETTLEMENT_FAILED', message }, nextAttemptAt: new Date(Date.now() + 60_000).toISOString() })
    } catch { /* a concurrent reconciler may already have advanced the row */ }
    await (persistence.alerts ?? memoryAlerts).upsert({ workspaceId, alertKey: `model-wallet-settlement:${receiptKey}`, code: 'MODEL_USAGE_WALLET_SETTLEMENT_FAILED', severity: 'high', entityType: 'model_usage', entityId: recordedUsage.id, title: '模型已返回结果，但钱包结算尚未完成', observedAt: usage.observedAt, evidence: { receipt_key: receiptKey, action_id: usage.actionId ?? null, error: message }, nextAction: '在运营后台重试该笔模型用量结算；不要向用户重复退款或重复调用模型。' })
    throw error
  }
}

const contentGenerator = createContentGeneratorFromEnv(process.env, recordRelayUsage)
const imageGenerator = createImageGeneratorFromEnv(process.env, recordRelayUsage)
const service = new MerchantService({
  fixtureMode,
  seedFixture: fixtureMode || process.env.NODE_ENV === 'test',
  contentGenerator,
  imageGenerator,
  contextSnapshotSink: async ({ task, envelope, inputTokensEstimate, maxInputTokens, versions }) => {
    await persistenceReady
    const saved = await (persistence.contextSnapshots ?? memoryContextSnapshots).save({ workspaceId: task.workspaceId, brandId: task.brandId!, envelope: envelope as unknown as Record<string, unknown>, inputTokensEstimate, maxInputTokens, versions, taskId: task.id, ...(task.campaignId ? { campaignId: task.campaignId, campaignItemId: task.campaignItemId! } : {}), ...(task.canonicalProductId ? { canonicalProductId: task.canonicalProductId } : {}), ...(task.listingId ? { listingId: task.listingId } : {}), linkId: `context_link_${task.id}` })
    return { id: saved.id, contextHash: saved.contextHash }
  },
  maxActiveJobsPerWorkspace: Number.isFinite(maxActiveJobsPerWorkspace) && maxActiveJobsPerWorkspace > 0 ? maxActiveJobsPerWorkspace : 3,
  knowledgeContextProvider: ({ workspaceId, platform, category, brand, store, competitorReference, asOf }) => ({
    rules: knowledge.findApplicableRules({ platform, ...(category ? { category } : {}), ...(brand ? { brand } : {}), ...(store ? { store } : {}) }, asOf, workspaceId).map(rule => ({ id: rule.id, content: rule.content, version: rule.version, sourceReference: rule.source.reference, ...(rule.effectiveFrom ? { effectiveFrom: rule.effectiveFrom } : {}), ...(rule.effectiveTo ? { effectiveTo: rule.effectiveTo } : {}) })),
    assets: knowledge.queryAssets({ workspaceId }).map(asset => ({ id: asset.id, kind: asset.kind, name: asset.name, content: asset.content, revision: asset.revision, confirmed: false as const })),
    confirmedLearningSuggestions: knowledge.listLearningSuggestions(workspaceId, 'confirmed').map(item => ({ id: item.id, summary: item.summary, proposedRule: { content: item.proposedRule.content, scope: item.proposedRule.scope, version: item.proposedRule.version } })),
    ...(competitorReference ? { competitorReferences: [competitorReference] } : {}),
  }),
})
type BrandUnitRecord = {
  id: string
  workspaceId: string
  name: string
  revision: number
  storeBindings: Array<{ platform: Platform; accountId: string }>
  createdAt: string
  updatedAt: string
}
type CampaignBatchRecord = {
  id: string
  workspaceId: string
  brandId: string
  platform: Platform
  accountId: string
  productIds: string[]
  targets?: Array<{ productId: string; platform: Platform; accountId: string; listingId?: string; canonicalProductId?: string }>
  state: 'draft'
  storage: 'memory'
  durable: false
  createdAt: string
  updatedAt: string
}
const brandUnits = new Map<string, BrandUnitRecord>()
const campaignBatches = new Map<string, CampaignBatchRecord>()
const invalidDurableSnapshots = new Map<string, Array<{ entityType: string; entityId: string; missing: string[] }>>()
const imageFactsExtractor = createImageFactsExtractorFromEnv(process.env, recordRelayUsage)
const imageEditGenerator = createImageEditGeneratorFromEnv(process.env, recordRelayUsage)
const videoGenerator = createVideoGeneratorFromEnv(process.env, recordRelayUsage)
let paymentProvider = createPaymentProviderFromEnv()

type PaymentChannel = 'alipay' | 'wechat'
export function fixturePaymentAllowed(source: NodeJS.ProcessEnv = process.env) { return source.ALLOW_LOCAL_PAYMENT_FIXTURE === 'true' }
function paymentChannel(params: Record<string, unknown>): PaymentChannel {
  if (params.channel !== 'alipay' && params.channel !== 'wechat') throw new DomainError('BILLING_CHANNEL_INVALID', '订阅支付渠道必须是支付宝或微信', 400)
  return params.channel
}

async function createSubscriptionCheckout(input: { channel: PaymentChannel; orderId: string; idempotencyKey: string; workspaceId: string; amountFen: number; kind: 'subscriptions' }) {
  const providerMode = process.env.PAYMENT_MODE === 'provider'
  if (!providerMode) return { paymentUrl: `fixture://${input.channel}/${input.workspaceId}/${input.amountFen}?order_id=${encodeURIComponent(input.orderId)}` }
  if (!paymentProvider) throw new DomainError('PAYMENT_NOT_CONFIGURED', '支付 provider adapter 未装配', 503)
  const callbackBase = process.env.PAYMENT_CALLBACK_BASE_URL?.trim().replace(/\/$/u, '')
  if (!callbackBase) throw new DomainError('PAYMENT_NOT_CONFIGURED', '支付回调地址未配置', 503)
  try {
    const checkout = await paymentProvider.createCheckout({ channel: input.channel, orderId: input.orderId, idempotencyKey: input.idempotencyKey, workspaceId: input.workspaceId, amountFen: input.amountFen, callbackUrl: `${callbackBase}/${input.kind}/callback/${input.channel}`, description: `merchant-marketing 订阅订单 ${input.orderId}` })
    return { paymentUrl: checkout.paymentUrl, ...(checkout.providerOrderId ? { providerOrderId: checkout.providerOrderId } : {}), ...(checkout.expiresAt ? { expiresAt: checkout.expiresAt } : {}) }
  } catch (error) {
    throw new DomainError('PAYMENT_PROVIDER_CHECKOUT_FAILED', error instanceof Error ? error.message : '支付服务商下单失败', 503)
  }
}

async function grantSubscriptionEntitlements(input: { workspaceId: string; orderNo: string; addonCodes: readonly string[]; extensions: CommercialExtensionsRepository; entitlements: EntitlementRepository }) {
  const addons = await input.extensions.listAddons()
  return Promise.all(input.addonCodes.map(code => {
    const addon = addons.find(item => item.code === code)
    if (!addon) throw new DomainError('SUBSCRIPTION_ADDON_NOT_FOUND', `订阅订单中的加购项不存在：${code}`, 409)
    return input.entitlements.grant({ workspaceId: input.workspaceId, orderNo: input.orderNo, addonCode: addon.code, kind: addon.kind, units: addon.units })
  }))
}
const hydratedKnowledgeWorkspaces = new Set<string>()
const connectorRuntime = new ConnectorRuntime({ fixtureMode, allowFixtureWrites: process.env.PLUGIN_WRITE_ENABLED === 'true', credentialProvider: createVaultCredentialProviderFromEnv() })
export const oauthStates = new OAuthStateStore()
const redisOAuthPort = createRedisOAuthPort(process.env.REDIS_URL)
const oauthStateStore = redisOAuthPort ? new RedisOAuthStateStore(redisOAuthPort) : oauthStates
const redisRateLimit = createRedisRateLimit(process.env.REDIS_URL)
const redisJobAdmission = createRedisJobAdmission(process.env.REDIS_URL)
const redisAutomationLease = createRedisAutomationLease(process.env.REDIS_URL)
const localAutomationLeases = new Map<string, { token: string; expiresAt: number }>()
type JsonObject = Record<string, unknown>

type BatchProduct = { id: string; workspaceId: string; version?: number }
type BatchProductWrite = { product: BatchProduct; version: number }

export function rollbackBatchProducts(products: Map<string, BatchProduct>, workspaceId: string, writes: readonly BatchProductWrite[], before: ReadonlyMap<string, BatchProduct>): void {
  for (const write of writes) {
    const current = products.get(write.product.id)
    // A concurrent request may have replaced or mutated this product after the
    // batch write. Preserve the newer state instead of rolling it back as if it
    // belonged to the failed batch.
    if (current !== write.product || current.workspaceId !== workspaceId || current.version !== write.version) continue
    const previous = before.get(write.product.id)
    if (previous) products.set(write.product.id, previous)
    else products.delete(write.product.id)
  }
}

function brandUnitsFor(workspaceId: string) {
  return [...brandUnits.values()].filter(unit => unit.workspaceId === workspaceId)
}

function requireBrandUnit(workspaceId: string, brandId: string) {
  const unit = brandUnits.get(brandId)
  if (!unit || unit.workspaceId !== workspaceId) throw new DomainError('BRAND_UNIT_NOT_FOUND', '品不存在或不属于当前工作区', 404, { brand_id: brandId })
  return unit
}

function parseCampaignProductIds(value: unknown) {
  if (typeof value !== 'string') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'product_ids_json 必须是 1 至 50 个商品 ID 的 JSON 数组', 400)
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'product_ids_json 必须是 1 至 50 个商品 ID 的 JSON 数组', 400) }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50 || parsed.some(item => typeof item !== 'string' || !item.trim()) || new Set(parsed).size !== parsed.length) {
    throw new DomainError('CAMPAIGN_PRODUCT_LIMIT', 'product_ids_json 必须是 1 至 50 个不重复商品 ID 的 JSON 数组', 400)
  }
  return parsed.map(item => String(item).trim())
}

function parseCampaignTargets(value: unknown) {
  if (typeof value !== 'string') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'targets_json 必须是 1 至 50 个目标的 JSON 数组', 400)
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'targets_json 必须是有效 JSON 数组', 400) }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50) throw new DomainError('CAMPAIGN_TARGET_LIMIT', 'targets_json 必须包含 1 至 50 个目标', 400)
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object' || (typeof (item as Record<string, unknown>).product_id !== 'string' && typeof (item as Record<string, unknown>).canonical_product_id !== 'string') || typeof (item as Record<string, unknown>).platform !== 'string' || !SUPPORTED_PLATFORMS.includes((item as Record<string, unknown>).platform as Platform) || typeof (item as Record<string, unknown>).account_id !== 'string' || !(item as Record<string, unknown>).account_id) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `第 ${index + 1} 个批量目标必须包含 product_id 或 canonical_product_id，以及 platform、account_id`, 400)
    const target = item as Record<string, unknown>
    return { productId: typeof target.product_id === 'string' ? target.product_id.trim() : '', platform: target.platform as Platform, accountId: String(target.account_id).trim(), ...(typeof target.canonical_product_id === 'string' && target.canonical_product_id.trim() ? { canonicalProductId: target.canonical_product_id.trim() } : {}), ...(typeof target.listing_id === 'string' && target.listing_id.trim() ? { listingId: target.listing_id.trim() } : {}) }
  })
}

type ExecutionModality = 'content' | 'image' | 'image_edit' | 'ocr' | 'video'

/**
 * Keep merchant-facing execution truth at the API boundary. Application
 * services intentionally have deterministic local fallbacks for tests and
 * fixture workflows, so a completed result is not sufficient evidence that a
 * provider was called.
 */
export function executionContract(modality: ExecutionModality, providerExecuted: boolean, providerKind?: string) {
  const labels: Record<ExecutionModality, { provider: string; simulated: string }> = {
    content: { provider: '已由配置的内容模型生成', simulated: '本地演示文案，未调用内容模型' },
    image: { provider: '已由配置的图片模型生成', simulated: '本地演示图片，未调用图片模型' },
    image_edit: { provider: '已由配置的图片编辑模型生成', simulated: '本地演示图片编辑结果，未调用图片编辑模型' },
    ocr: { provider: '已由配置的 OCR 模型解析', simulated: '本地解析器结果，未调用 OCR 模型' },
    video: { provider: '已由配置的视频模型执行', simulated: '视频脚本/分镜演示结果，未调用视频模型' },
  }
  const label = providerExecuted ? labels[modality].provider : labels[modality].simulated
  return {
    mode: providerExecuted ? 'provider' as const : 'simulated' as const,
    simulated: !providerExecuted,
    providerExecuted,
    ...(providerKind ? { providerKind } : {}),
    label,
    message: label,
  }
}
type SnapshotInput = { entityType: BusinessEntityType; entityId: string; entityVersion: number; payload: Record<string, unknown> }

function createRedisOAuthPort(url: string | undefined): OAuthRedisPort | undefined {
  if (!url?.trim()) return undefined
  const client = createClient({ url: url.trim() })
  client.on('error', () => undefined)
  const ready = client.connect()
  return {
    async set(key, value, ttlSeconds) { await ready; await client.set(key, value, { EX: ttlSeconds }) },
    async get(key) { await ready; return await client.get(key) },
    async eval(script, keys, args) { await ready; return await client.eval(script, { keys, arguments: args }) },
  }
}

interface RedisRateLimitPort { increment(key: string, ttlSeconds: number): Promise<number> }
function createRedisRateLimit(url: string | undefined): RedisRateLimitPort | undefined {
  if (!url?.trim()) return undefined
  const client = createClient({ url: url.trim() })
  client.on('error', () => undefined)
  const ready = client.connect()
  return {
    async increment(key, ttlSeconds) {
      await ready
      const result = await client.eval(`
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
        return count
      `, { keys: [key], arguments: [String(ttlSeconds)] })
      return Number(result)
    },
  }
}

interface RedisJobAdmissionPort {
  acquire(workspaceId: string, reservationId: string, limit: number, ttlSeconds: number): Promise<'owned' | 'existing' | 'quota'>
  release(workspaceId: string, reservationId: string): Promise<void>
}

interface RedisAutomationLeasePort {
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>
  renew(key: string, token: string, ttlMs: number): Promise<boolean>
  release(key: string, token: string): Promise<void>
}

function createRedisAutomationLease(url: string | undefined): RedisAutomationLeasePort | undefined {
  if (!url?.trim()) return undefined
  const client = createClient({ url: url.trim() })
  client.on('error', () => undefined)
  const ready = client.connect()
  return {
    async acquire(key, token, ttlMs) {
      await ready
      const result = await client.eval(`
        if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
        return 0
      `, { keys: [key], arguments: [token, String(ttlMs)] })
      return Number(result) === 1
    },
    async renew(key, token, ttlMs) {
      await ready
      const result = await client.eval(`
        if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
        return 0
      `, { keys: [key], arguments: [token, String(ttlMs)] })
      return Number(result) === 1
    },
    async release(key, token) {
      await ready
      await client.eval(`
        if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
        return 1
      `, { keys: [key], arguments: [token] })
    },
  }
}

function admissionKey(workspaceId: string, reservationId: string) {
  return createHash('sha256').update(`${workspaceId}\n${reservationId}`).digest('hex')
}

function createRedisJobAdmission(url: string | undefined): RedisJobAdmissionPort | undefined {
  if (!url?.trim()) return undefined
  const client = createClient({ url: url.trim() })
  client.on('error', () => undefined)
  const ready = client.connect()
  return {
    async acquire(workspaceId, reservationId, limit, ttlSeconds) {
      await ready
      const digest = admissionKey(workspaceId, reservationId)
      const result = await client.eval(`
        local reservation = KEYS[1]
        local counter = KEYS[2]
        if redis.call('EXISTS', reservation) == 1 then return 2 end
        local current = tonumber(redis.call('GET', counter) or '0')
        if current >= tonumber(ARGV[1]) then return 0 end
        redis.call('SET', reservation, '1', 'EX', ARGV[2])
        redis.call('INCR', counter)
        redis.call('EXPIRE', counter, ARGV[2])
        return 1
      `, { keys: [`merchant:job-admission:${digest}`, `merchant:job-admission-count:${createHash('sha256').update(workspaceId).digest('hex')}`], arguments: [String(limit), String(ttlSeconds)] })
      return Number(result) === 1 ? 'owned' : Number(result) === 2 ? 'existing' : 'quota'
    },
    async release(workspaceId, reservationId) {
      await ready
      const digest = admissionKey(workspaceId, reservationId)
      await client.eval(`
        if redis.call('DEL', KEYS[1]) == 1 then
          local current = tonumber(redis.call('DECR', KEYS[2]) or '0')
          if current <= 0 then redis.call('DEL', KEYS[2]) end
        end
        return 1
      `, { keys: [`merchant:job-admission:${digest}`, `merchant:job-admission-count:${createHash('sha256').update(workspaceId).digest('hex')}`], arguments: [] })
    },
  }
}

export interface ApiPersistence {
  mode: 'memory' | 'postgres'
  outbox?: OutboxRepository
  business?: PostgresBusinessRepository
  billing?: PostgresBillingRepository
  commercial?: import('../../../packages/persistence/src/index.js').CommercialRepository
  usage?: UsageRepository
  modelUsage?: ModelUsageRepository
  actionLedger?: ActionLedgerRepository
  entitlements?: EntitlementRepository
  operations?: OperationsRepository
  subscriptions?: SubscriptionRepository
  commercialExtensions?: CommercialExtensionsRepository
  growth?: GrowthRepository
  alerts?: OperationalAlertsRepository
  dataLifecycle?: DataLifecycleRepository
  members?: MembersRepository
  rules?: RuleRepositoryPort
  brandUnits?: import('../../../packages/persistence/src/index.js').BrandUnitRepository
  objectOrphans?: ObjectOrphanRepository
  contextSnapshots?: ContextSnapshotRepository
  identities?: IdentityLifecycleRepository
  persistSnapshotAndEvent?: (input: { workspaceId: string; entityType: BusinessEntityType; entityId: string; entityVersion: number; payload: Record<string, unknown>; eventType: string; eventPayload: Record<string, unknown> }) => Promise<void>
  persistSnapshotsAndEvent?: (input: { workspaceId: string; snapshots: SnapshotInput[]; aggregateId: string; eventType: string; sequence: number; eventPayload: Record<string, unknown> }) => Promise<void>
  ensureWorkspace?: (workspaceId: string) => Promise<void>
  listWorkspaceIds?: () => Promise<string[]>
  getWorkspaceStatus?: (workspaceId: string) => Promise<'active' | 'disabled'>
  setWorkspaceStatus?: (workspaceId: string, status: 'active' | 'disabled') => Promise<void>
  checkHealth?: () => Promise<void>
  close?: () => Promise<void>
}

export interface RuleRepositoryPort {
  list(workspaceId: string, packId?: string): Promise<PersistedRuleVersion[]>
  insertVersion(input: Omit<PersistedRuleVersion, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): Promise<PersistedRuleVersion>
  appendAudit(input: PersistedRuleAudit): Promise<PersistedRuleAudit>
  listAudit(workspaceId: string, packId?: string): Promise<PersistedRuleAudit[]>
  updateStatus(input: { workspaceId: string; id: string; status: string; revision: number; updatedAt?: string; activatedAt?: string | null; deactivatedAt?: string | null }): Promise<PersistedRuleVersion>
  insertVersionWithAudit?(input: { version: Omit<PersistedRuleVersion, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }; audit: PersistedRuleAudit }): Promise<{ version: PersistedRuleVersion; audit: PersistedRuleAudit }>
  transitionStatusWithAudit?(input: { workspaceId: string; packId: string; targetId: string; status: string; actorId: string; reason: string; occurredAt: string; targetAuditId: string; currentAuditId?: string; auditData?: Record<string, unknown> }): Promise<{ version: PersistedRuleVersion; audits: PersistedRuleAudit[] }>
}

const memoryCommercial = new MemoryCommercialRepository()
const memoryUsage = new MemoryUsageRepository(workspaceId => memoryCommercial.getSettings(workspaceId))
const memoryModelUsage = new MemoryModelUsageRepository()
const memoryActionLedger = new MemoryActionLedgerRepository()
const memoryEntitlements = new MemoryEntitlementRepository()
const memoryOperations = new MemoryOperationsRepository()
const memorySubscriptions = new MemorySubscriptionRepository()
const memoryMembers = new MemoryMembersRepository()
const memoryCommercialExtensions = new MemoryCommercialExtensionsRepository()
const memoryGrowth = new MemoryGrowthRepository()
const memoryAlerts = new MemoryOperationalAlertsRepository()
const memoryDataLifecycle = new MemoryDataLifecycleRepository()
const memoryBrandUnits = new MemoryBrandUnitRepository()
const memoryObjectOrphans = new MemoryObjectOrphanRepository()
const memoryContextSnapshots = new MemoryContextSnapshotRepository()
const memoryIdentities = new MemoryIdentityLifecycleRepository()
const memoryPersistence: ApiPersistence = { mode: 'memory', commercial: memoryCommercial, usage: memoryUsage, modelUsage: memoryModelUsage, actionLedger: memoryActionLedger, entitlements: memoryEntitlements, operations: memoryOperations, subscriptions: memorySubscriptions, members: memoryMembers, commercialExtensions: memoryCommercialExtensions, growth: memoryGrowth, alerts: memoryAlerts, dataLifecycle: memoryDataLifecycle, brandUnits: memoryBrandUnits, objectOrphans: memoryObjectOrphans, contextSnapshots: memoryContextSnapshots, identities: memoryIdentities }
let persistence: ApiPersistence = memoryPersistence
let persistenceError: unknown
const memoryWorkspaceStatuses = new Map<string, 'active' | 'disabled'>()
const knownWorkspaces = new Set<string>()
const workspaceEventSequences = new Map<string, number>()
let assetStorage: ObjectStoragePort | undefined
let ruleRepositoryOverride: RuleRepositoryPort | undefined
const inMemoryTimelineEvents = new Map<string, OutboxEvent[]>()
type RechargeChannel = 'alipay' | 'wechat'
type RechargeState = 'pending' | 'paid' | 'closed' | 'failed'
interface RechargeOrder {
  id: string
  workspaceId: string
  channel: RechargeChannel
  amountFen: number
  state: RechargeState
  paymentMode: 'fixture' | 'provider'
  paymentUrl?: string
  providerTradeId?: string
  createdAt: string
  updatedAt: string
}
interface WalletTransaction {
  id: string
  workspaceId: string
  type: 'recharge' | 'debit' | 'refund'
  amountFen: number
  orderId?: string
  description: string
  createdAt: string
}
const rechargeOrders = new Map<string, RechargeOrder>()
const rechargeIdempotency = new Map<string, string>()
const rechargeCreationInFlight = new Map<string, { channel: RechargeChannel; amountFen: number; promise: Promise<Record<string, unknown>> }>()
const subscriptionCreationInFlight = new Map<string, { intent: string; promise: Promise<Record<string, unknown>> }>()
const subscriptionChangeInFlight = new Map<string, { intent: string; promise: Promise<Record<string, unknown>> }>()
const walletTransactions: WalletTransaction[] = []
const modelBillingReservations = new Map<string, { debitIdempotencyKey: string; actorId: string; providerRequests: Set<string> }>()
type AutomationPolicy = { workspaceId: string; id: string; platform?: Platform; accountId?: string; enabled: boolean; mode: 'scan_alert_manual_retry' | 'scan_sync_alert_manual_retry'; syncEnabled: boolean; frequencyMinutes: number; retryLimit: number; windowStart?: string; windowEnd?: string; pauseReason?: string; lastRunAt?: string; nextRunAt?: string; /** Set while the scheduler has claimed work but has not recorded the resulting sync handle. */ claimedAt?: string; lastSyncJobId?: string; revision: number; updatedAt: string }
type AutomationRisk = { kind: string; product_id?: string; publish_job_id?: string; platform: Platform; account_id: string | null; message: string }
type AutomationRecommendation = { id: string; kind: string; priority: 'high' | 'medium'; title: string; action: string; method: string; parameters: Record<string, string>; execution: 'read_only' | 'interactive_confirmation'; requiresInteractiveConfirmation: boolean }
type PublishBatchItem = { taskId: string; platform: Platform; accountId?: string; contentVersionId?: string; confirmationHash?: string; remoteSnapshotHash?: string; state: 'prepared' | 'queued' | 'failed' | 'paused' | 'submitted' | 'published' | 'rejected' | 'unknown'; jobId?: string; error?: { code: string; message: string } }
type PublishBatch = { id: string; workspaceId: string; state: 'prepared' | 'queued' | 'paused' | 'partial' | 'completed' | 'failed'; items: PublishBatchItem[]; pauseReason?: string; createdAt: string; updatedAt: string; revision: number }
const automationPolicies = new Map<string, AutomationPolicy>()
const publishBatches = new Map<string, PublishBatch>()
const persistedPublishBatches = new Map<string, PublishBatch>()

function publicMoneyRecord<T extends { amountFen: number }>(record: T) {
  const { amountFen: _amountFen, ...withoutMinorUnit } = record
  return { ...withoutMinorUnit, amount_cny: (record.amountFen / 100).toFixed(2) }
}

function publicRechargeOrder(order: RechargeOrder) {
  return { id: order.id, workspace_id: order.workspaceId, channel: order.channel, amount_cny: (order.amountFen / 100).toFixed(2), state: order.state, payment_mode: order.paymentMode, payment_url: order.paymentUrl ?? null, provider_trade_id: order.providerTradeId ?? null, expires_at: null, paid_at: order.state === 'paid' ? order.updatedAt : null, created_at: order.createdAt, updated_at: order.updatedAt }
}

/** Prefix spreadsheet formula-like cells before emitting a user-downloadable CSV. */
export function csvCell(value: string) {
  const safe = /^[=+\-@]/u.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/gu, '""')}"`
}

export async function readWorkspaceStatusInTransaction(pool: SqlPool, workspaceId: string): Promise<'active' | 'disabled'> {
  return withWorkspaceTransaction(pool, workspaceId, async client => {
    const row = await client.query<{ status: 'active' | 'disabled' }>('SELECT status FROM workspaces WHERE id = $1', [workspaceId])
    return row.rows[0]?.status ?? 'active'
  })
}

function parseCnyToFen(value: unknown) {
  if (typeof value !== 'string' || !/^\d{1,8}(?:\.\d{1,2})?$/u.test(value.trim())) throw new DomainError('BILLING_AMOUNT_INVALID', '充值金额必须是合法的人民币金额', 400)
  const [yuan, fraction = ''] = value.trim().split('.')
  const fen = Number(yuan) * 100 + Number((fraction + '00').slice(0, 2))
  if (!Number.isSafeInteger(fen) || fen < 100 || fen > 1_000_000_00) throw new DomainError('BILLING_AMOUNT_INVALID', '充值金额需在1元到100万元之间', 400)
  return fen
}

function walletBalanceFen(workspaceId: string) {
  return walletTransactions.filter(item => item.workspaceId === workspaceId).reduce((sum, item) => sum + (item.type === 'debit' ? -item.amountFen : item.amountFen), 0)
}

function actionKindForDescription(description: string): ActionKind {
  if (description.includes('同步')) return 'catalog_sync'
  if (description.includes('连接')) return 'platform_connect'
  if (description.includes('图片编辑') || description.includes('image_edit')) return 'image_edit'
  if (description.includes('创意预览')) return 'creative_preview'
  if (description.includes('SEO')) return 'seo'
  if (description.includes('Brief')) return 'brief'
  if (description.includes('发布')) return 'publish'
  if (description.includes('图片') || description.includes('图像') || description.includes('image')) return 'model_image'
  if (description.includes('OCR') || description.includes('解析') || description.includes('ocr')) return 'model_ocr'
  if (description.includes('视频') || description.includes('video')) return 'model_video'
  return 'model_text'
}

async function recordActionSettlement(input: { workspaceId: string; actionKey: string; actionKind: ActionKind; settlement: ActionSettlement; amountFen: number; actorId: string; description: string; taskId?: string; reservedAmountFen?: number; multiplier?: number; settlementStatus?: 'authorized' | 'pending_receipt' | 'settled' | 'released' | 'refunded' | 'manual_attention' }) {
  await persistenceReady
  if (!persistence.actionLedger) throw new Error('ACTION_LEDGER_NOT_CONFIGURED')
  return persistence.actionLedger.record({ ...input, units: 1 })
}

async function consumeEntitlement(input: { workspaceId: string; kind: EntitlementKind; actionKey: string; actionKind: ActionKind; actorId: string; description: string }) {
  await persistenceReady
  let consumption
  try {
    consumption = await (persistence.entitlements ?? memoryEntitlements).consume({ workspaceId: input.workspaceId, kind: input.kind, units: 1, idempotencyKey: input.actionKey })
  } catch (error) {
    if ((error as { code?: string })?.code === 'ENTITLEMENT_CONSUMPTION_IDEMPOTENCY_CONFLICT' || String(error).includes('ENTITLEMENT_CONSUMPTION_IDEMPOTENCY_CONFLICT')) throw new DomainError('ENTITLEMENT_CONSUMPTION_IDEMPOTENCY_CONFLICT', '权益消费幂等键已绑定到其他消费意图，请换用新的幂等键', 409)
    throw error
  }
  if (consumption) await recordActionSettlement({ workspaceId: input.workspaceId, actionKey: input.actionKey, actionKind: input.actionKind, settlement: 'entitlement', amountFen: 0, actorId: input.actorId, description: input.description })
  return consumption
}

async function refundEntitlement(input: { workspaceId: string; actionKey: string; reason: string }) {
  await persistenceReady
  const refunded = await (persistence.entitlements ?? memoryEntitlements).refund({ workspaceId: input.workspaceId, idempotencyKey: input.actionKey })
  if (refunded.refunded) await refundActionSettlement({ workspaceId: input.workspaceId, actionKey: input.actionKey, reason: input.reason })
  return refunded
}

async function refundActionSettlement(input: { workspaceId: string; actionKey: string; reason: string }) {
  await persistenceReady
  return persistence.actionLedger?.refund(input) ?? { refunded: false }
}

async function currentWalletBalanceFen(workspaceId: string) {
  await persistenceReady
  return persistence.billing ? persistence.billing.balanceFen(workspaceId) : walletBalanceFen(workspaceId)
}

type PlatformUserCommercialSummary = {
  planCode: string
  planName: string
  subscriptionStatus: string
  usedTasks: number
  includedTasks: number
  remainingTasks: number
  walletBalanceCny: string
}

async function loadPlatformUserCommercialSummaries(workspaceIds: readonly string[]) {
  const usageRepository = persistence.usage ?? memoryUsage
  const subscriptionRepository = persistence.subscriptions ?? memorySubscriptions
  const summaries = await Promise.all(workspaceIds.map(async workspaceId => {
    const [usage, subscription, balanceFen] = await Promise.all([
      usageRepository.get(workspaceId),
      subscriptionRepository.get(workspaceId),
      currentWalletBalanceFen(workspaceId),
    ])
    return [workspaceId, {
      planCode: subscription.planCode,
      planName: subscription.planName,
      subscriptionStatus: subscription.status,
      usedTasks: usage.usedTasks,
      includedTasks: usage.includedTasks,
      remainingTasks: usage.remainingTasks,
      walletBalanceCny: (balanceFen / 100).toFixed(2),
    }] as const
  }))
  return new Map(summaries)
}

async function synchronizeCommercialQuotaFromSubscription(subscription: { workspaceId: string; planCode: string; planName: string; billingCycle: 'monthly' | 'annual'; priceCny: number; includedStores: number; includedTasks: number }) {
  const commercialRepository = persistence.commercial ?? memoryCommercial
  const current = await commercialRepository.getSettings(subscription.workspaceId)
  const next = {
    planCode: subscription.planCode,
    planName: subscription.planName,
    monthlyPriceCny: subscription.billingCycle === 'monthly' ? subscription.priceCny : current.monthlyPriceCny,
    annualPriceCny: subscription.billingCycle === 'annual' ? subscription.priceCny : current.annualPriceCny,
    includedStores: subscription.includedStores,
    includedTasks: subscription.includedTasks,
    updatedBy: 'payment_provider',
  }
  if (current.planCode === next.planCode && current.planName === next.planName && current.monthlyPriceCny === next.monthlyPriceCny && current.annualPriceCny === next.annualPriceCny && current.includedStores === next.includedStores && current.includedTasks === next.includedTasks) return current
  return commercialRepository.updateSettings({ workspaceId: subscription.workspaceId, ...next, expectedRevision: current.revision })
}

export async function assertProviderActionCanStart(workspaceId: string, actionKey: string) {
  await persistenceReady
  const existing = await persistence.actionLedger?.get(workspaceId, actionKey)
  const settlementStatus = existing?.settlementStatus ?? existing?.state
  if (!existing || settlementStatus === 'released' || settlementStatus === 'refunded') return
  throw new DomainError(
    'MODEL_ACTION_ALREADY_STARTED',
    '这次模型操作已经受理或正在结算，禁止重复调用模型；请刷新任务状态，待结算异常由运营后台处理',
    409,
    { settlement_status: settlementStatus },
  )
}

async function debitPluginWallet(input: { workspaceId: string; amountFen?: number; idempotencyKey: string; actorId: string; description: string }) {
  const amountFen = input.amountFen ?? 1
  const actionKind = actionKindForDescription(input.description)
  const providerMetered = ['model_text', 'model_image', 'model_ocr', 'model_video', 'image_edit'].includes(actionKind)
  await persistenceReady
  if (providerMetered) await assertProviderActionCanStart(input.workspaceId, input.idempotencyKey)
  const pricingPolicy = providerMetered ? await (persistence.commercialExtensions ?? memoryCommercialExtensions).getModelMarkupPolicy() : undefined
  const settlement = input.description.includes('套餐额度外') ? 'wallet_overage' as const : 'wallet' as const
  const authorization = pricingPolicy ? { reservedAmountFen: amountFen, multiplier: pricingPolicy.multiplier, settlementStatus: 'authorized' as const } : {}
  if (process.env.NODE_ENV === 'test') {
    const transaction = { id: `fixture_debit_${input.idempotencyKey}`, workspaceId: input.workspaceId, type: 'debit' as const, amountFen, orderId: input.idempotencyKey, description: input.description, createdAt: new Date().toISOString() }
    await recordActionSettlement({ workspaceId: input.workspaceId, actionKey: input.idempotencyKey, actionKind, settlement, amountFen: transaction.amountFen, actorId: input.actorId, description: input.description, ...authorization })
    return transaction
  }
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) throw new DomainError('BILLING_AMOUNT_INVALID', '扣款金额必须是正整数分', 400)
  if (persistence.billing) {
    try {
      const transaction = await persistence.billing.debit({ ...input, amountFen })
      try {
        await recordActionSettlement({ workspaceId: input.workspaceId, actionKey: input.idempotencyKey, actionKind, settlement, amountFen, actorId: input.actorId, description: input.description, ...authorization })
      } catch (error) {
        // The provider debit is durable even when the action ledger is down.
        // Compensate here because callers do not receive the transaction and
        // therefore cannot know that a refund is required.
        try {
          await persistence.billing.refundDebit({ workspaceId: input.workspaceId, debitIdempotencyKey: input.idempotencyKey, actorId: input.actorId, reason: '扣款台账写入失败，自动退款' })
        } catch { /* preserve the original ledger error for operational alerting */ }
        throw error
      }
      return transaction
    }
    catch (error) { if (error instanceof Error && error.message === 'BILLING_INSUFFICIENT_BALANCE') throw new DomainError('RECHARGE_REQUIRED', '插件钱包余额不足，请充值后继续', 402); if ((error as { code?: string })?.code === 'WALLET_DEBIT_IDEMPOTENCY_CONFLICT' || String(error).includes('WALLET_DEBIT_IDEMPOTENCY_CONFLICT')) throw new DomainError('WALLET_DEBIT_IDEMPOTENCY_CONFLICT', '钱包扣款幂等键已绑定到不同金额或动作，请换用新的幂等键', 409); throw error }
  }
  const existing = walletTransactions.find(item => item.workspaceId === input.workspaceId && item.type === 'debit' && item.orderId === input.idempotencyKey)
  if (existing) { if (existing.amountFen !== amountFen || existing.description !== `${input.description}（${input.actorId}）`) throw new DomainError('WALLET_DEBIT_IDEMPOTENCY_CONFLICT', '钱包扣款幂等键已绑定到不同金额或动作，请换用新的幂等键', 409); return existing }
  if (walletBalanceFen(input.workspaceId) < amountFen) throw new DomainError('RECHARGE_REQUIRED', '插件钱包余额不足，请充值后继续', 402)
  const transaction = { id: `billing_tx_${randomUUID()}`, workspaceId: input.workspaceId, type: 'debit' as const, amountFen, orderId: input.idempotencyKey, description: `${input.description}（${input.actorId}）`, createdAt: new Date().toISOString() }
  walletTransactions.push(transaction)
  try {
    await recordActionSettlement({ workspaceId: input.workspaceId, actionKey: input.idempotencyKey, actionKind, settlement, amountFen, actorId: input.actorId, description: input.description, ...authorization })
  } catch (error) {
    const index = walletTransactions.findIndex(item => item.id === transaction.id)
    if (index >= 0) walletTransactions.splice(index, 1)
    throw error
  }
  return transaction
}

async function settlePluginWalletDebit(input: { workspaceId: string; debitIdempotencyKey: string; finalAmountFen: number; actorId: string; providerRequestId?: string }) {
  await persistenceReady
  if (process.env.NODE_ENV !== 'test' && persistence.billing) {
    try {
      await persistence.billing.settleDebit({ workspaceId: input.workspaceId, debitIdempotencyKey: input.debitIdempotencyKey, finalAmountFen: input.finalAmountFen, actorId: input.actorId, description: '模型真实用量结算' })
    } catch (error) {
      if (error instanceof Error && error.message === 'BILLING_INSUFFICIENT_BALANCE') throw new DomainError('RECHARGE_REQUIRED', '模型已返回真实用量，但钱包不足以完成结算，请充值', 402)
      throw error
    }
  } else if (process.env.NODE_ENV !== 'test') {
    const original = walletTransactions.find(item => item.workspaceId === input.workspaceId && item.type === 'debit' && item.orderId === input.debitIdempotencyKey)
    if (!original) throw new Error('billing debit not found')
    const delta = input.finalAmountFen - original.amountFen
    const orderId = `${delta > 0 ? 'settlement' : 'settlement-refund'}:${input.debitIdempotencyKey}`
    const type: WalletTransaction['type'] = delta > 0 ? 'debit' : 'refund'
    const existing = walletTransactions.find(item => item.workspaceId === input.workspaceId && item.type === type && item.orderId === orderId)
    if (!existing && delta !== 0) {
      if (delta > 0 && walletBalanceFen(input.workspaceId) < delta) throw new DomainError('RECHARGE_REQUIRED', '模型已返回真实用量，但钱包不足以完成结算，请充值', 402)
      walletTransactions.push({ id: `billing_tx_${randomUUID()}`, workspaceId: input.workspaceId, type, amountFen: Math.abs(delta), orderId, description: `模型真实用量结算（${input.actorId}）`, createdAt: new Date().toISOString() })
    }
  }
  await persistence.actionLedger?.settleProviderUsage({ workspaceId: input.workspaceId, actionKey: input.debitIdempotencyKey, ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}), actualAmountFen: input.finalAmountFen })
}

async function settlePendingModelUsage(input: { workspaceId: string; usageId: string; actorId: string; expectedRevision: number; reason?: string; evidenceRef?: string }) {
  if (!persistence.modelUsage) throw new DomainError('MODEL_USAGE_LEDGER_NOT_CONFIGURED', '模型用量结算台账未配置', 503)
  const usage = (await persistence.modelUsage.list(input.workspaceId, 1000)).find(item => item.id === input.usageId)
  if (!usage) throw new DomainError('MODEL_USAGE_NOT_FOUND', '模型用量记录不存在', 404)
  if (usage.revision !== input.expectedRevision) throw new DomainError('MODEL_USAGE_REVISION_CONFLICT', '模型用量记录已被其他操作更新，请刷新后重试', 409)
  if (usage.costCny === undefined || usage.customerChargeCny === undefined) throw new DomainError('MODEL_USAGE_COST_MISSING', '该回执仍缺少实际成本，无法自动结算', 409)
  if (usage.actionId) {
    const action = await persistence.actionLedger?.get(input.workspaceId, usage.actionId)
    if (!action) throw new DomainError('MODEL_USAGE_ACTION_NOT_FOUND', '原始扣费授权不存在，需人工核对', 409)
    if (action.settlement === 'wallet' || action.settlement === 'wallet_overage') {
      await settlePluginWalletDebit({ workspaceId: input.workspaceId, debitIdempotencyKey: usage.actionId, finalAmountFen: Math.max(1, Math.ceil(usage.customerChargeCny * 100)), actorId: input.actorId, ...(usage.providerRequestId ? { providerRequestId: usage.providerRequestId } : {}) })
    }
  }
  return persistence.modelUsage.resolve({ workspaceId: input.workspaceId, id: usage.id, expectedRevision: usage.revision, status: 'settled', actorId: input.actorId, reason: input.reason ?? '运营对账重试完成', evidenceRef: input.evidenceRef ?? usage.providerRequestId ?? usage.receiptKey })
}

async function refundPluginWalletDebit(input: { workspaceId: string; debitIdempotencyKey: string; actorId: string; reason: string }) {
  if (process.env.NODE_ENV === 'test') {
    await refundActionSettlement({ workspaceId: input.workspaceId, actionKey: input.debitIdempotencyKey, reason: input.reason })
    return { refunded: false }
  }
  await persistenceReady
  if (persistence.billing?.refundDebit) {
    try { const result = { refunded: true, transaction: await persistence.billing.refundDebit(input) }; await refundActionSettlement({ workspaceId: input.workspaceId, actionKey: input.debitIdempotencyKey, reason: input.reason }); return result }
    catch (error) { if (error instanceof Error && error.message === 'billing debit not found') return { refunded: false }; throw error }
  }
  const debit = walletTransactions.find(item => item.workspaceId === input.workspaceId && item.type === 'debit' && item.orderId === input.debitIdempotencyKey)
  if (!debit) { await refundActionSettlement({ workspaceId: input.workspaceId, actionKey: input.debitIdempotencyKey, reason: input.reason }); return { refunded: false } }
  const refundOrderId = `refund:${input.debitIdempotencyKey}`
  const existing = walletTransactions.find(item => item.workspaceId === input.workspaceId && item.type === 'refund' && item.orderId === refundOrderId)
  if (existing) return { refunded: false, transaction: existing }
  const transaction = { id: `billing_tx_${randomUUID()}`, workspaceId: input.workspaceId, type: 'refund' as const, amountFen: debit.amountFen, orderId: refundOrderId, description: `模型失败退款（${input.actorId}）：${input.reason}`, createdAt: new Date().toISOString() }
  walletTransactions.push(transaction)
  await refundActionSettlement({ workspaceId: input.workspaceId, actionKey: input.debitIdempotencyKey, reason: input.reason })
  return { refunded: true, transaction }
}

/** A settled wallet balance is the product-wide paid-capability gate. Included
 * task quota changes how a paid action is settled, but never unlocks the
 * plugin while the merchant wallet is empty. */
async function requirePluginWalletAccess(workspaceId: string) {
  if (process.env.NODE_ENV === 'test') return 1
  const balanceFen = await currentWalletBalanceFen(workspaceId)
  if (balanceFen <= 0) throw new DomainError('RECHARGE_REQUIRED', '请先为插件钱包充值，充值到账后才能使用生成、检查和发布能力', 402, { balance_cny: '0.00', recharge_required: true })
  return balanceFen
}

function resolveTaskPublishAccount(task: { accountId?: string | null }, requestedAccountId?: string) {
  const requested = requestedAccountId?.trim() || undefined
  if (task.accountId && requested && task.accountId !== requested) {
    throw new DomainError('STORE_ACCOUNT_CONFLICT', '发布店铺必须与任务已绑定店铺一致，不能改投同平台其他店铺', 409, { task_account_id: task.accountId, requested_account_id: requested })
  }
  return requested ?? task.accountId ?? undefined
}

async function markRechargePaid(input: { workspaceId: string; orderId: string; providerTradeId: string; amountFen: number }) {
  await persistenceReady
  if (persistence.billing) return persistence.billing.markPaid(input)
  const order = rechargeOrders.get(input.orderId)
  if (!order || order.workspaceId !== input.workspaceId) return undefined
  if (order.amountFen !== input.amountFen) throw new DomainError('BILLING_CALLBACK_AMOUNT_MISMATCH', '支付回调金额与订单金额不一致', 400)
  if (order.state === 'paid') {
    if (order.providerTradeId && order.providerTradeId !== input.providerTradeId) throw new DomainError('PAYMENT_CALLBACK_REPLAY_CONFLICT', '已到账订单不能使用不同的支付交易号重复入账', 409)
    return order
  }
  if (order.state !== 'pending') throw new DomainError('BILLING_ORDER_NOT_PAYABLE', '充值订单当前不可入账', 409)
  order.state = 'paid'; order.paymentUrl = undefined; order.providerTradeId = input.providerTradeId; order.updatedAt = new Date().toISOString()
  walletTransactions.push({ id: `billing_tx_${randomUUID()}`, workspaceId: input.workspaceId, type: 'recharge', amountFen: input.amountFen, orderId: input.orderId, description: `充值到账（${order.channel}）`, createdAt: new Date().toISOString() })
  return order
}

async function markRechargeProviderState(input: { workspaceId: string; orderId: string; state: 'closed' | 'failed' }) {
  await persistenceReady
  if (persistence.billing?.markProviderState) return persistence.billing.markProviderState(input)
  const order = rechargeOrders.get(input.orderId)
  if (!order || order.workspaceId !== input.workspaceId || order.state !== 'pending') return undefined
  order.state = input.state
  order.paymentUrl = undefined
  order.updatedAt = new Date().toISOString()
  return order
}

async function refundRecharge(input: { workspaceId: string; orderId: string; actorId: string; reason: string; providerRefundId?: string }) {
  await persistenceReady
  if (persistence.billing?.refundOrder) return persistence.billing.refundOrder(input)
  const order = rechargeOrders.get(input.orderId)
  if (!order || order.workspaceId !== input.workspaceId) throw new DomainError('BILLING_ORDER_NOT_FOUND', '充值订单不存在', 404)
  if (order.state !== 'paid') throw new DomainError('BILLING_ORDER_NOT_REFUNDABLE', '充值订单当前不可退款', 409)
  const existing = walletTransactions.find(item => item.workspaceId === input.workspaceId && item.orderId === input.orderId && item.type === 'refund')
  if (existing) return existing
  const transaction = { id: `billing_tx_${randomUUID()}`, workspaceId: input.workspaceId, type: 'refund' as const, amountFen: order.amountFen, orderId: order.id, description: `退款（${input.actorId}）：${input.reason}${input.providerRefundId ? `；provider_refund_id=${input.providerRefundId}` : ''}`, createdAt: new Date().toISOString() }
  walletTransactions.push(transaction)
  return transaction
}

function verifyPaymentCallback(req: IncomingMessage, payload: { order_id: string; provider_trade_id: string; amount_fen: number; state: string }) {
  requireProviderPaymentConfigured()
  const secret = process.env.PAYMENT_CALLBACK_SECRET?.trim()
  if (!secret) return
  const provided = header(req, 'x-payment-signature')?.trim() ?? ''
  const canonical = `${payload.order_id}|${payload.provider_trade_id}|${payload.amount_fen}|${payload.state}`
  const expected = createHmac('sha256', secret).update(canonical).digest('hex')
  if (!provided || provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) throw new DomainError('PAYMENT_CALLBACK_SIGNATURE_INVALID', '支付回调验签失败', 401)
}

function paymentProviderReadiness(source: NodeJS.ProcessEnv = process.env) {
  const reasons: string[] = []
  const adapters = (source.PAYMENT_PROVIDER_ADAPTERS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (!adapters.includes('alipay') || !adapters.includes('wechat')) reasons.push('provider_adapters_incomplete')
  if (!/^https:\/\//iu.test(source.PAYMENT_CHECKOUT_BASE_URL?.trim() ?? '')) reasons.push('checkout_endpoint_must_use_https')
  if (!/^https:\/\//iu.test(source.PAYMENT_PROVIDER_CHECKOUT_API_URL?.trim() ?? '')) reasons.push('provider_checkout_api_must_use_https')
  if (!/^https:\/\//iu.test(source.PAYMENT_PROVIDER_QUERY_API_URL?.trim() ?? '')) reasons.push('provider_query_api_must_use_https')
  if (!source.PAYMENT_PROVIDER_API_KEY?.trim()) reasons.push('provider_api_key_missing')
  if (!source.PAYMENT_PROVIDER_MERCHANT_ID?.trim()) reasons.push('provider_merchant_id_missing')
  if (!/^https:\/\//iu.test(source.PAYMENT_PROVIDER_REFUND_API_URL?.trim() ?? '')) reasons.push('provider_refund_api_must_use_https')
  if (!/^https:\/\//iu.test(source.PAYMENT_CALLBACK_BASE_URL?.trim() ?? '')) reasons.push('callback_endpoint_must_use_https')
  if (!source.PAYMENT_CALLBACK_SECRET?.trim()) reasons.push('callback_secret_missing')
  if (source.PAYMENT_RECONCILIATION_ENABLED !== 'true') reasons.push('reconciliation_disabled')
  if (source.PAYMENT_REFUND_ENABLED !== 'true') reasons.push('refund_disabled')
  return { ready: reasons.length === 0, reasons }
}

function requireProviderPaymentConfigured() {
  if (!isProduction()) return
  const readiness = paymentProviderReadiness()
  if (process.env.PAYMENT_MODE !== 'provider' || !readiness.ready) throw new DomainError('PAYMENT_NOT_CONFIGURED', `生产环境支付 provider 未就绪：${readiness.reasons.join(', ')}`, 503, { reasons: readiness.reasons })
}

/** Test-only seam for exercising the HTTP authorization/orchestration boundary
 * without replacing the production Postgres repository implementation. */
export function setRuleRepositoryForTests(repository?: RuleRepositoryPort) {
  if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') throw new Error('RULE_REPOSITORY_OVERRIDE_TEST_ONLY')
  ruleRepositoryOverride = repository
}

export function setPaymentProviderForTests(provider?: PaymentProvider) {
  if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') throw new Error('PAYMENT_PROVIDER_OVERRIDE_TEST_ONLY')
  paymentProvider = provider
}

function ruleRepository() { return ruleRepositoryOverride ?? persistence.rules }

function iso(value: string | Date) { return typeof value === 'string' ? value : new Date(String(value)).toISOString() }
function publicRule(version: PersistedRuleVersion) {
  const lifecycleStatus = version.status === 'active' ? 'published' : version.status === 'inactive' ? 'disabled' : version.status
  return { id: version.id, workspaceId: version.workspaceId, packId: version.packId, name: version.name, version: version.version, scope: version.scope, status: version.status, lifecycleStatus, createdBy: version.createdBy, updatedAt: iso(version.updatedAt), source: { kind: version.sourceKind, reference: version.sourceReference, checkedAt: iso(version.sourceCheckedAt) }, checksum: version.checksum, revision: version.revision, ...(version.effectiveFrom ? { effectiveFrom: iso(version.effectiveFrom) } : {}), ...(version.effectiveTo ? { effectiveTo: iso(version.effectiveTo) } : {}), ...(version.severity ? { severity: version.severity } : {}), ...(version.action ? { action: version.action } : {}), ...(version.targetId ? { targetId: version.targetId } : {}), ...(version.scopeValue ? { scopeValue: version.scopeValue } : {}), ...(version.activatedAt ? { activatedAt: iso(version.activatedAt) } : {}), ...(version.deactivatedAt ? { deactivatedAt: iso(version.deactivatedAt) } : {}) }
}

function rulePackProjection(version: PersistedRuleVersion): RulePack {
  return { id: version.id, name: version.name, version: version.version, scope: version.scope as RulePack['scope'], status: version.status as RulePack['status'], updatedAt: iso(version.updatedAt), source: { kind: version.sourceKind as RulePack['source']['kind'], reference: version.sourceReference, checkedAt: iso(version.sourceCheckedAt) }, checksum: version.checksum, revision: version.revision, ...(version.effectiveFrom ? { effectiveFrom: iso(version.effectiveFrom) } : {}), ...(version.effectiveTo ? { effectiveTo: iso(version.effectiveTo) } : {}), ...(version.severity ? { severity: version.severity as RulePack['severity'] } : {}), ...(version.action ? { action: version.action as RulePack['action'] } : {}), ...(version.targetId ? { targetId: version.targetId } : {}), ...(version.scopeValue ? { scopeValue: version.scopeValue } : {}), ...(version.activatedAt ? { activatedAt: iso(version.activatedAt) } : {}), ...(version.deactivatedAt ? { deactivatedAt: iso(version.deactivatedAt) } : {}) }
}

async function rulePacksForWorkspace(workspaceId: string) {
  const repository = ruleRepository()
  if (repository) {
    const rows = await repository.list(workspaceId)
    return rows.map(rulePackProjection)
  }
  return service.ruleCenter.list({ includeInactive: false })
}

const lastPlatformRuleSync = new Map<string, number>()

export async function syncSignedPlatformRules(workspaceId: string) {
  const manifestUrl = process.env.PLATFORM_RULE_SYNC_MANIFEST_URL?.trim()
  const signingSecret = process.env.PLATFORM_RULE_SYNC_SIGNING_SECRET?.trim()
  const intervalHours = Math.max(1, Number(process.env.PLATFORM_RULE_SYNC_INTERVAL_HOURS ?? 24))
  if (!manifestUrl || !signingSecret) return { state: 'not_configured' as const, imported: 0, activated: 0, reason: !manifestUrl ? 'manifest_url_missing' : 'signing_secret_missing' }
  const repository = ruleRepository()
  if (!repository) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '规则定时同步需要持久化规则仓储', 503)
  if (!repository.insertVersionWithAudit || !repository.transitionStatusWithAudit) throw new DomainError('RULE_REPOSITORY_ATOMIC_SYNC_UNAVAILABLE', '规则仓储不支持原子导入和激活', 503)
  const last = lastPlatformRuleSync.get(workspaceId)
  if (last && Date.now() - last < intervalHours * 3_600_000) return { state: 'not_due' as const, imported: 0, activated: 0, next_sync_at: new Date(last + intervalHours * 3_600_000).toISOString() }
  await assertOutboundUrl(manifestUrl, { environment: process.env.NODE_ENV })
  const response = await fetch(manifestUrl, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new DomainError('RULE_MANIFEST_FETCH_FAILED', `签名规则清单返回 HTTP ${response.status}`, 503)
  const raw = await readBoundedResponseText(response, 2 * 1024 * 1024, 'platform rule manifest')
  let manifest
  try { manifest = verifyAndParsePlatformRuleManifest(raw, response.headers.get('x-rule-manifest-signature') ?? '', signingSecret) }
  catch (error) { throw new DomainError('RULE_MANIFEST_INVALID', error instanceof Error ? error.message : '签名规则清单无效', 409) }
  const existing = await repository.list(workspaceId)
  let imported = 0
  let activated = 0
  const versions: Array<{ platform: string; pack_id: string; version: string; state: string }> = []
  for (const entry of manifest.entries) {
    const checksum = createHash('sha256').update(canonicalJson({ platform: entry.platform, packId: entry.packId, version: entry.version, sourceReference: entry.sourceReference, sourceCheckedAt: entry.sourceCheckedAt, checks: entry.checks, severity: entry.severity, action: entry.action, effectiveFrom: entry.effectiveFrom ?? null, effectiveTo: entry.effectiveTo ?? null })).digest('hex')
    let target = existing.find(row => row.packId === entry.packId && row.version === entry.version)
    if (target && target.checksum !== checksum) throw new DomainError('RULE_MANIFEST_VERSION_CONFLICT', `规则 ${entry.packId}@${entry.version} 已存在但摘要不同`, 409)
    const at = new Date().toISOString()
    if (!target) {
      const id = `rule_sync_${createHash('sha256').update(`${workspaceId}:${entry.platform}:${entry.packId}:${entry.version}`).digest('hex').slice(0, 32)}`
      target = (await repository.insertVersionWithAudit({
        version: { id, workspaceId, packId: entry.packId, name: entry.name, version: entry.version, scope: 'platform', status: 'draft', sourceKind: 'official', sourceReference: entry.sourceReference, sourceCheckedAt: entry.sourceCheckedAt, checksum, checks: entry.checks, createdBy: 'signed-rule-sync', revision: 1, targetId: entry.platform, severity: entry.severity, action: entry.action, ...(entry.effectiveFrom ? { effectiveFrom: entry.effectiveFrom } : {}), ...(entry.effectiveTo ? { effectiveTo: entry.effectiveTo } : {}) },
        audit: { id: `rule_audit_${randomUUID()}`, workspaceId, rulePackId: entry.packId, ruleVersionId: id, version: entry.version, action: 'created', actorId: 'signed-rule-sync', reason: '签名平台规则清单定时导入', occurredAt: at, data: { manifest_generated_at: manifest.generatedAt, checksum } },
      })).version
      existing.push(target)
      imported += 1
    }
    if (target.status !== 'active') {
      target = (await repository.transitionStatusWithAudit({ workspaceId, packId: entry.packId, targetId: target.id, status: 'active', actorId: 'signed-rule-sync', reason: '签名平台规则清单定时激活', occurredAt: at, targetAuditId: `rule_audit_${randomUUID()}`, currentAuditId: `rule_audit_${randomUUID()}`, auditData: { manifest_generated_at: manifest.generatedAt, checksum } })).version
      activated += 1
    }
    versions.push({ platform: entry.platform, pack_id: entry.packId, version: entry.version, state: target.status })
  }
  lastPlatformRuleSync.set(workspaceId, Date.now())
  return { state: 'succeeded' as const, imported, activated, manifest_generated_at: manifest.generatedAt, versions }
}

const catalogCategories = [
  { code: '1312', name: '服装 / 防晒外套', fields: ['材质', '成分', '重量', '尺码', '颜色', '功能依据'], platforms: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'], status: 'active', updatedAt: '今天' },
  { code: '1408', name: '鞋靴 / 户外鞋', fields: ['鞋面材质', '闭合方式', '适用场景', '尺码'], platforms: ['jd', 'taobao', 'pinduoduo'], status: 'active', updatedAt: '昨天' },
  { code: '1503', name: '运动 / 速干裤装', fields: ['面料', '版型', '弹性', '洗护', '尺码'], platforms: ['taobao', 'tmall'], status: 'active', updatedAt: '3 天前' },
] as const

async function persistedRules(workspaceId: string) {
  const repository = ruleRepository()
  if (!repository) return undefined
  const rows = await repository.list(workspaceId)
  if (rows.length) return rows.map(publicRule)
  // Bootstrap only the first request for a new workspace. This keeps the
  // durable rule center usable after migration without silently changing the
  // in-memory fixture registry used by local tests.
  for (const seed of defaultRuleCenterSeeds) {
    const at = seed.createdAt ?? new Date().toISOString()
    const checksum = createHash('sha256').update(canonicalJson({ packId: seed.packId, version: seed.version, scope: seed.scope, source: seed.source, checks: seed.checks ?? {} })).digest('hex')
    try {
      await repository.insertVersion({ id: `${seed.packId}@${seed.version}`, workspaceId, packId: seed.packId, name: seed.name, version: seed.version, scope: seed.scope, status: seed.status ?? 'draft', sourceKind: seed.source.kind, sourceReference: seed.source.reference, sourceCheckedAt: seed.source.checkedAt, checksum, checks: (seed.checks ?? {}) as Record<string, unknown>, createdBy: seed.createdBy ?? 'system', revision: 1, ...(seed.effectiveFrom ? { effectiveFrom: seed.effectiveFrom } : {}), ...(seed.effectiveTo ? { effectiveTo: seed.effectiveTo } : {}), ...(seed.severity ? { severity: seed.severity } : {}), ...(seed.action ? { action: seed.action } : {}), ...(seed.targetId ? { targetId: seed.targetId } : {}), ...(seed.scopeValue ? { scopeValue: seed.scopeValue } : {}), activatedAt: seed.status === 'active' ? at : null })
      await repository.appendAudit({ id: `rule_audit_${randomUUID()}`, workspaceId, rulePackId: seed.packId, ruleVersionId: `${seed.packId}@${seed.version}`, version: seed.version, action: 'created', actorId: seed.createdBy ?? 'system', reason: 'workspace rule bootstrap', occurredAt: at, data: {} })
      if (seed.status === 'active') await repository.appendAudit({ id: `rule_audit_${randomUUID()}`, workspaceId, rulePackId: seed.packId, ruleVersionId: `${seed.packId}@${seed.version}`, version: seed.version, action: 'activated', actorId: seed.createdBy ?? 'system', reason: 'workspace rule bootstrap', occurredAt: at, data: {} })
    } catch { /* another request may have bootstrapped this workspace */ }
  }
  return (await repository.list(workspaceId)).map(publicRule)
}

type RuleEvaluationScope = { platform: Platform; category?: string; brand?: string; store?: string; campaign?: string }

async function evaluationRules(workspaceId: string, context?: RuleEvaluationScope): Promise<{ availableRuleVersionIds: string[]; forbiddenTerms: string[]; ruleHits: import('../../../packages/review/src/rule-center.js').RuleHit[] } | undefined> {
  const repository = ruleRepository()
  if (!repository) return undefined
  let rows = await repository.list(workspaceId)
  // A new durable workspace may reach content review before the merchant has
  // opened the rule page. Bootstrap the immutable default packs on the first
  // evaluation so the normal generate -> review -> approve flow is usable
  // without an unrelated preliminary MCP call.
  if (!rows.length) {
    await persistedRules(workspaceId)
    rows = await repository.list(workspaceId)
  }
  const scopeOrder = ['global', 'platform', 'category', 'brand', 'store', 'campaign']
  const active = rows.filter(row => {
    if (row.status !== 'active') return false
    if (!context) return true
    const scope = row.scope
    if (scope === 'global') return true
    const expected = context[scope as keyof RuleEvaluationScope]
    const target = row.targetId ?? row.scopeValue
    return typeof expected === 'string' && expected.length > 0 && typeof target === 'string' && target === expected
  }).sort((left, right) => scopeOrder.indexOf(left.scope) - scopeOrder.indexOf(right.scope))
  const terms = new Set<string>()
  for (const row of active) {
    const checks = row.checks as Record<string, unknown>
    const values = Array.isArray(checks.forbiddenTerms) ? checks.forbiddenTerms : Array.isArray(checks.forbidden_terms) ? checks.forbidden_terms : []
    for (const value of values) if (typeof value === 'string' && value.trim()) terms.add(value)
  }
  const inMemoryHits = context ? service.ruleCenter.evaluate(context).hits : []
  const durableHits = context
    ? (await persistedRuleEvaluation(workspaceId, { platform: context.platform, ...(context.category ? { category: context.category } : {}), ...(context.store ? { storeName: context.store } : {}) })).hits
    : []
  const seenHits = new Set<string>()
  const ruleHits = [...inMemoryHits, ...durableHits].filter(hit => {
    if (seenHits.has(hit.ruleVersionId)) return false
    seenHits.add(hit.ruleVersionId)
    return true
  })
  return { availableRuleVersionIds: active.map(row => row.version), forbiddenTerms: [...terms], ruleHits }
}

function ruleContextForTask(task: import('../../../packages/application/src/service.js').Task): RuleEvaluationScope {
  const product = service.products.get(task.productId)
  return {
    platform: task.platform,
    ...(product?.category ? { category: product.category } : {}),
    ...(product?.storeName ? { store: product.storeName } : {}),
  }
}

async function generationRulePreflight(workspaceId: string, productId: string) {
  const product = service.products.get(productId)
  if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '生成请求引用的商品不存在或不属于当前工作区', 404)
  const context: RuleEvaluationScope = { platform: product.platform, ...(product.category ? { category: product.category } : {}), ...(product.storeName ? { store: product.storeName } : {}) }
  const evaluation = service.ruleCenter.evaluate(context)
  const durable = await hydrateDurableRuleSnapshot(workspaceId, product)
  const findings = [...evaluation.findings, ...durable.findings]
  const seenHits = new Set<string>()
  const ruleHits = [...evaluation.hits, ...durable.hits].filter(hit => {
    if (seenHits.has(hit.ruleVersionId)) return false
    seenHits.add(hit.ruleVersionId)
    return true
  })
  const forbiddenTerms = new Set(evaluation.checks.forbiddenTerms)
  const currentRules = await evaluationRules(workspaceId, context)
  for (const term of currentRules?.forbiddenTerms ?? []) forbiddenTerms.add(term)
  return { blocking: findings.some(finding => finding.severity === 'error'), finding_count: findings.length, rule_hits: ruleHits, forbidden_terms: [...forbiddenTerms], findings }
}

async function requireGenerationRulePreflight(workspaceId: string, productId: string, message = '当前店铺平台规则存在阻断项，不能继续生成') {
  const rulePreflight = await generationRulePreflight(workspaceId, productId)
  if (rulePreflight.blocking) throw new DomainError('PLATFORM_RULE_PREFLIGHT_BLOCKED', message, 409, { rule_preflight: rulePreflight })
  return rulePreflight
}

function requireRuleSafeGenerationText(rulePreflight: Awaited<ReturnType<typeof generationRulePreflight>>, values: unknown[], message = '生成请求包含当前平台规则禁用表达') {
  const text = values.filter(value => value !== undefined && value !== null).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n')
  const matchedTerms = rulePreflight.forbidden_terms.filter(term => term && text.includes(term))
  if (matchedTerms.length) throw new DomainError('PLATFORM_RULE_CONTENT_BLOCKED', message, 409, { matched_terms: matchedTerms, rule_preflight: rulePreflight })
}

async function requireCurrentPublishReview(workspaceId: string, task: ReturnType<typeof service.getTask>) {
  if (!task.contentVersionId) throw new DomainError('CONTENT_NOT_APPROVED', '内容未批准，不能准备发布', 409)
  const report = service.reviewContentReport(workspaceId, task.contentVersionId, await evaluationRules(workspaceId, ruleContextForTask(task)))
  const blocking = report.findings.filter(finding => finding.severity === 'error' && finding.status === 'open')
  if (blocking.length) throw new DomainError('PUBLISH_RULE_REVIEW_BLOCKED', '内容未通过当前店铺平台的最新规则复检，不能准备发布', 409, { review: report, blocking_findings: blocking })
  return report
}

/**
 * Evaluate rules restored from PostgreSQL as part of generation preflight.
 * The in-memory RuleCenter is useful for fixture defaults, but it is not the
 * source of truth after a restart. Keep this projection structurally aligned
 * with RuleCenter.evaluate so callers receive the same hits and findings.
 */
async function persistedRuleEvaluation(workspaceId: string, product: { platform: Platform; category?: string; storeName?: string }): Promise<{ findings: Array<{ code: 'RULE_EXPIRED' | 'RULE_NOT_YET_EFFECTIVE' | 'RULE_PRIORITY_CONFLICT'; severity: 'error' | 'warning'; action: 'block' | 'warn' | 'review' | 'allow'; field: 'rules'; ruleVersionId: string; message: string }>; hits: RuleHit[] }> {
  const repository = ruleRepository()
  if (!repository) return { findings: [] as Array<{ code: 'RULE_EXPIRED' | 'RULE_NOT_YET_EFFECTIVE' | 'RULE_PRIORITY_CONFLICT'; severity: 'error' | 'warning'; action: 'block' | 'warn' | 'review' | 'allow'; field: 'rules'; ruleVersionId: string; message: string }>, hits: [] }
  let rows = await repository.list(workspaceId)
  if (!rows.length) {
    await persistedRules(workspaceId)
    rows = await repository.list(workspaceId)
  }
  const scopeOrder = ['global', 'platform', 'category', 'brand', 'store', 'campaign']
  const context: Record<string, string | undefined> = { platform: product.platform, category: product.category, store: product.storeName }
  const applicable: PersistedRuleVersion[] = []
  const findings: Array<{ code: 'RULE_EXPIRED' | 'RULE_NOT_YET_EFFECTIVE' | 'RULE_PRIORITY_CONFLICT'; severity: 'error' | 'warning'; action: 'block' | 'warn' | 'review' | 'allow'; field: 'rules'; ruleVersionId: string; message: string }> = []
  const now = Date.now()
  for (const row of rows) {
    if (row.status !== 'active' && row.status !== 'expired') continue
    const expected = row.scope === 'global' ? undefined : context[row.scope]
    const target = row.targetId ?? row.scopeValue
    if (row.scope !== 'global' && (!expected || !target || expected !== target)) continue
    const action: 'block' | 'warn' | 'review' | 'allow' = row.action === 'warn' || row.action === 'review' || row.action === 'allow' ? row.action : 'block'
    const severity: 'error' | 'warning' = row.severity === 'warning' ? 'warning' : 'error'
    if (row.status === 'expired') {
      findings.push({ code: 'RULE_EXPIRED', severity: 'error', action, field: 'rules', ruleVersionId: row.id, message: `规则 ${row.version} 已标记为过期，不能用于本次生成` })
      continue
    }
    const from = row.effectiveFrom ? Date.parse(String(row.effectiveFrom)) : Number.NEGATIVE_INFINITY
    const to = row.effectiveTo ? Date.parse(String(row.effectiveTo)) : Number.POSITIVE_INFINITY
    if ((row.effectiveFrom && Number.isNaN(from)) || (row.effectiveTo && Number.isNaN(to))) continue
    if (now < from) {
      findings.push({ code: 'RULE_NOT_YET_EFFECTIVE', severity, action, field: 'rules', ruleVersionId: row.id, message: `规则 ${row.version} 尚未到生效时间 ${row.effectiveFrom}` })
      continue
    }
    if (now >= to) {
      findings.push({ code: 'RULE_EXPIRED', severity: 'error', action, field: 'rules', ruleVersionId: row.id, message: `规则 ${row.version} 已于 ${row.effectiveTo} 过期，不能用于本次生成` })
      continue
    }
    applicable.push(row)
  }
  applicable.sort((left, right) => scopeOrder.indexOf(left.scope) - scopeOrder.indexOf(right.scope))
  for (let higherIndex = 0; higherIndex < applicable.length; higherIndex += 1) {
    const higher = applicable[higherIndex]!
    for (let lowerIndex = higherIndex + 1; lowerIndex < applicable.length; lowerIndex += 1) {
      const lower = applicable[lowerIndex]!
      if ((higher.action ?? 'block') === 'block' && lower.action === 'allow') findings.push({ code: 'RULE_PRIORITY_CONFLICT', severity: 'error', action: 'block', field: 'rules', ruleVersionId: lower.id, message: `低优先级规则 ${lower.version} 不能覆盖 ${higher.scope} 范围的硬阻断规则 ${higher.version}` })
    }
  }
  const hits: RuleHit[] = applicable.map(row => ({ ruleVersionId: row.id, version: row.version, scope: row.scope as RuleHit['scope'], action: row.action === 'warn' || row.action === 'review' || row.action === 'allow' ? row.action : 'block', severity: row.severity === 'warning' ? row.severity : 'error', matchedChecks: [...(Array.isArray(row.checks.forbiddenTerms) ? row.checks.forbiddenTerms : Array.isArray(row.checks.forbidden_terms) ? row.checks.forbidden_terms : []).map(() => 'forbiddenTerms'), ...(Array.isArray(row.checks.requiredFields) ? row.checks.requiredFields : Array.isArray(row.checks.required_fields) ? row.checks.required_fields : []).map(() => 'requiredFields')] }))
  return { findings, hits }
}

async function hydrateDurableRuleSnapshot(workspaceId: string, product: { id: string; platform: Platform; category?: string; storeName?: string }) {
  const durable = await persistedRuleEvaluation(workspaceId, product)
  const repository = ruleRepository()
  if (!repository) return durable
  const hitIds = new Set(durable.hits.map(hit => hit.ruleVersionId))
  const rows = await repository.list(workspaceId)
  const forbiddenTerms = new Set<string>()
  const requiredFields = new Set<string>()
  for (const row of rows) {
    if (!hitIds.has(row.id)) continue
    const checks = row.checks as Record<string, unknown>
    const terms = Array.isArray(checks.forbiddenTerms) ? checks.forbiddenTerms : Array.isArray(checks.forbidden_terms) ? checks.forbidden_terms : []
    const fields = Array.isArray(checks.requiredFields) ? checks.requiredFields : Array.isArray(checks.required_fields) ? checks.required_fields : []
    for (const value of terms) if (typeof value === 'string' && value.trim()) forbiddenTerms.add(value)
    for (const value of fields) if (typeof value === 'string' && value.trim()) requiredFields.add(value)
  }
  service.setDurableRuleSnapshot(workspaceId, product.id, { ruleVersionIds: durable.hits.map(hit => hit.version), ruleChecks: { forbiddenTerms: [...forbiddenTerms], requiredFields: [...requiredFields] } })
  return durable
}

/** Evaluate durable workspace rules for scheduler safety. The application
 * RuleCenter is intentionally fixture-friendly, but production automation
 * must also see rules created through the PostgreSQL rule repository after a
 * process restart. Keep the blocking subset aligned with RuleCenter.evaluate.
 */
async function persistedRuleHasBlockingRisk(workspaceId: string, product: { platform: Platform; category?: string; storeName?: string }) {
  const repository = ruleRepository()
  if (!repository) return false
  let rows = await repository.list(workspaceId)
  if (!rows.length) {
    await persistedRules(workspaceId)
    rows = await repository.list(workspaceId)
  }
  const scopeOrder = ['global', 'platform', 'category', 'brand', 'store', 'campaign']
  const context: Record<string, string | undefined> = { platform: product.platform, category: product.category, store: product.storeName }
  const applicable: PersistedRuleVersion[] = []
  const now = Date.now()
  for (const row of rows) {
    if (row.status !== 'active' && row.status !== 'expired') continue
    const expected = row.scope === 'global' ? undefined : context[row.scope]
    const target = row.targetId ?? row.scopeValue
    if (row.scope !== 'global' && (!expected || !target || expected !== target)) continue
    if (row.status === 'expired') return true
    const from = row.effectiveFrom ? Date.parse(String(row.effectiveFrom)) : Number.NEGATIVE_INFINITY
    const to = row.effectiveTo ? Date.parse(String(row.effectiveTo)) : Number.POSITIVE_INFINITY
    if (row.effectiveTo && !Number.isNaN(to) && now >= to) return true
    if (row.effectiveFrom && !Number.isNaN(from) && now < from && (row.severity ?? 'error') === 'error') return true
    if ((row.effectiveFrom && Number.isNaN(from)) || (row.effectiveTo && Number.isNaN(to))) continue
    applicable.push(row)
  }
  applicable.sort((left, right) => scopeOrder.indexOf(left.scope) - scopeOrder.indexOf(right.scope))
  for (let higherIndex = 0; higherIndex < applicable.length; higherIndex += 1) {
    const higher = applicable[higherIndex]!
    for (let lowerIndex = higherIndex + 1; lowerIndex < applicable.length; lowerIndex += 1) {
      const lower = applicable[lowerIndex]!
      if ((higher.action ?? 'block') === 'block' && lower.action === 'allow') return true
    }
  }
  return false
}

const MAX_ASSET_BYTES = 50 * 1024 * 1024

function configuredAssetLimit(): number {
  const configured = Number(process.env.ASSET_UPLOAD_MAX_BYTES ?? MAX_ASSET_BYTES)
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > MAX_ASSET_BYTES) {
    throw new DomainError('ASSET_STORAGE_CONFIG_INVALID', `ASSET_UPLOAD_MAX_BYTES 必须是 1-${MAX_ASSET_BYTES} 的整数`, 503)
  }
  return configured
}

function getAssetStorage(): ObjectStoragePort {
  if (assetStorage) return assetStorage
  if (isProduction()) {
    const bucket = process.env.ASSET_STORAGE_BUCKET?.trim()
    const region = process.env.ASSET_STORAGE_REGION?.trim()
    const endpoint = process.env.ASSET_STORAGE_ENDPOINT?.trim()
    const kmsKeyId = process.env.ASSET_STORAGE_KMS_KEY_ID?.trim()
    if (!bucket || !region || !endpoint || !kmsKeyId || !/^https:\/\//u.test(endpoint)) throw new DomainError('ASSET_STORAGE_NOT_CONFIGURED', '生产环境对象存储必须配置 bucket、region、HTTPS endpoint 和 KMS key', 503)
    const client = new S3Client({ region, endpoint, forcePathStyle: process.env.ASSET_STORAGE_FORCE_PATH_STYLE === 'true' })
    const request = (key: string) => ({ Bucket: bucket, Key: key })
    const transport: CloudObjectTransport = {
      async head(key) {
        try {
          const result = await client.send(new HeadObjectCommand(request(key)))
          return { contentType: result.ContentType, sizeBytes: result.ContentLength, metadata: result.Metadata }
        } catch (error) {
          if (isS3NotFound(error)) return null
          throw error
        }
      },
      async get(key) {
        const result = await client.send(new GetObjectCommand(request(key)))
        if (!result.Body || typeof result.Body.transformToByteArray !== 'function') throw new Error('S3_OBJECT_BODY_UNAVAILABLE')
        return { body: new Uint8Array(await result.Body.transformToByteArray()), contentType: result.ContentType, metadata: result.Metadata }
      },
      async put(key, input) {
        await client.send(new PutObjectCommand({ ...request(key), Body: input.body, ContentType: input.contentType, Metadata: input.metadata, ...(input.ifAbsent ? { IfNoneMatch: '*' } : {}), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kmsKeyId }))
      },
      async delete(key) { await client.send(new DeleteObjectCommand(request(key))) },
    }
    assetStorage = new S3CompatibleObjectStorage(transport, { keyPrefix: process.env.ASSET_STORAGE_PREFIX?.trim(), maxObjectBytes: configuredAssetLimit() })
    return assetStorage
  }
  const root = process.env.ASSET_STORAGE_ROOT?.trim() || '/tmp/merchant-marketing-codex-assets'
  assetStorage = new LocalObjectStorage(root, { maxObjectBytes: configuredAssetLimit() })
  return assetStorage
}

async function getStoredObjectWithRetry(workspaceId: string, key: string, options?: { includeQuarantine?: boolean }) {
  return withObjectStorageReadRetry(() => getAssetStorage().get(workspaceId, key, options))
}

async function compensateStoredObject(workspaceId: string, objectKey: string, reason: string) {
  try {
    await getAssetStorage().delete(workspaceId, objectKey, { includeQuarantine: true })
  } catch (deleteError) {
    try {
      await (persistence.objectOrphans ?? memoryObjectOrphans).enqueue({ workspaceId, objectKey, reason, lastError: deleteError instanceof Error ? deleteError.message : 'object compensation delete failed' })
    } catch {
      // Preserve the original business failure. Production alerting must treat
      // a simultaneous database outage and compensation failure as P0.
    }
  }
}

async function parseAssetFacts(input: { name: string; mimeType: string; body: Uint8Array; usageContext?: { workspaceId?: string; actionId?: string } }) {
  try {
    return { facts: await parseDocumentFacts(input), source: 'parser' as const }
  } catch (error) {
    const image = input.mimeType.toLowerCase().startsWith('image/')
    if (!(error instanceof DocumentParseError) || !image || !imageFactsExtractor) throw error
    return { facts: await imageFactsExtractor.extract(input), source: 'model_ocr' as const }
  }
}

function isS3NotFound(error: unknown) {
  const candidate = error as { $metadata?: { httpStatusCode?: number }; name?: string }
  return candidate?.$metadata?.httpStatusCode === 404 || candidate?.name === 'NotFound' || candidate?.name === 'NoSuchKey'
}

async function initializePersistence(): Promise<ApiPersistence> {
  // Tests and fixture-only local development intentionally keep the memory
  // service. DATABASE_URL is the explicit switch to the durable adapter.
  if (process.env.NODE_ENV === 'test' || (process.env.VITEST === 'true' && !process.env.DATABASE_URL) || (process.env.NODE_ENV !== 'production' && process.env.CONNECTOR_FIXTURE_MODE === 'true' && process.env.PERSISTENCE_MODE !== 'postgres')) return memoryPersistence
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required outside test runtime; refusing to start with memory persistence')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_MAX ?? 20), connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 3000) })
  try {
    const sqlPool = pool as unknown as SqlPool
    if (process.env.RUN_MIGRATIONS_ON_STARTUP !== 'false') await runMigrations(sqlPool, await loadMigrations())
    const outbox = new PostgresOutboxRepository(sqlPool)
    const business = new PostgresBusinessRepository(sqlPool, { normalizedProjection: true })
    const billing = new PostgresBillingRepository(sqlPool)
    const commercial = new PostgresCommercialRepository(sqlPool)
    const usage = new PostgresUsageRepository(sqlPool)
    const modelUsage = new PostgresModelUsageRepository(sqlPool)
    const actionLedger = new PostgresActionLedgerRepository(sqlPool)
    const entitlements = new PostgresEntitlementRepository(sqlPool)
    const operations = new PostgresOperationsRepository(sqlPool)
    const subscriptions = new PostgresSubscriptionRepository(sqlPool)
    const members = new PostgresMembersRepository(sqlPool)
    const commercialExtensions = new PostgresCommercialExtensionsRepository(sqlPool)
    const growth = new PostgresGrowthRepository(sqlPool)
    const alerts = new PostgresOperationalAlertsRepository(sqlPool)
    const dataLifecycle = new PostgresDataLifecycleRepository(sqlPool)
    const rules = new PostgresRuleRepository(sqlPool)
    const brandUnits = new PostgresBrandUnitRepository(sqlPool)
    const objectOrphans = new PostgresObjectOrphanRepository(sqlPool)
    const contextSnapshots = new PostgresContextSnapshotRepository(sqlPool)
    const identities = new PostgresIdentityLifecycleRepository(sqlPool)
    const ensureWorkspace = async (workspaceId: string) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId])
        await client.query(`INSERT INTO workspaces (id, status) VALUES ($1, 'active') ON CONFLICT (id) DO NOTHING`, [workspaceId])
        await client.query('COMMIT')
      } catch (error) {
        try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
        throw error
      } finally {
        client.release()
      }
    }
    const persistSnapshotAndEvent = async (input: { workspaceId: string; entityType: BusinessEntityType; entityId: string; entityVersion: number; payload: Record<string, unknown>; eventType: string; eventPayload: Record<string, unknown> }) => {
      await ensureWorkspace(input.workspaceId)
      await withWorkspaceTransaction(sqlPool, input.workspaceId, async client => {
        let saved
        try {
          saved = await business.saveInTransaction(client, {
            workspaceId: input.workspaceId,
            entityType: input.entityType,
            entityId: input.entityId,
            entityVersion: input.entityVersion,
            payload: input.payload,
          })
        } catch (error) {
          if (error instanceof BusinessSnapshotVersionConflictError) throw new DomainError(error.code, '业务状态已被其他实例以相同版本更新，请刷新后重试', 409, { entity_type: error.entityType, entity_id: error.entityId, expected_version: error.entityVersion })
          throw error
        }
        if (saved.entityVersion !== input.entityVersion) throw new DomainError('BUSINESS_SNAPSHOT_VERSION_CONFLICT', '业务状态已被其他实例更新，请刷新后重试', 409, { entity_type: input.entityType, entity_id: input.entityId, expected_version: input.entityVersion, current_version: saved.entityVersion })
        await outbox.appendInTransaction(client, {
          workspaceId: input.workspaceId,
          aggregateId: input.entityId,
          eventType: input.eventType,
          sequence: input.entityVersion,
          payload: input.eventPayload,
        })
      })
    }
    const persistSnapshotsAndEvent = async (input: { workspaceId: string; snapshots: SnapshotInput[]; aggregateId: string; eventType: string; sequence: number; eventPayload: Record<string, unknown> }) => {
      await ensureWorkspace(input.workspaceId)
      await withWorkspaceTransaction(sqlPool, input.workspaceId, async client => {
        for (const snapshot of input.snapshots) {
          let saved
          try {
            saved = await business.saveInTransaction(client, { workspaceId: input.workspaceId, ...snapshot })
          } catch (error) {
            if (error instanceof BusinessSnapshotVersionConflictError) throw new DomainError(error.code, '业务状态已被其他实例以相同版本更新，请刷新后重试', 409, { entity_type: error.entityType, entity_id: error.entityId, expected_version: error.entityVersion })
            throw error
          }
          if (saved.entityVersion !== snapshot.entityVersion) throw new DomainError('BUSINESS_SNAPSHOT_VERSION_CONFLICT', '业务状态已被其他实例更新，请刷新后重试', 409, { entity_type: snapshot.entityType, entity_id: snapshot.entityId, expected_version: snapshot.entityVersion, current_version: saved.entityVersion })
        }
        await outbox.appendInTransaction(client, { workspaceId: input.workspaceId, aggregateId: input.aggregateId, eventType: input.eventType, sequence: input.sequence, payload: input.eventPayload })
      })
    }
    const getWorkspaceStatus = async (workspaceId: string): Promise<'active' | 'disabled'> => {
      await ensureWorkspace(workspaceId)
      return readWorkspaceStatusInTransaction(sqlPool, workspaceId)
    }
    const setWorkspaceStatus = async (workspaceId: string, status: 'active' | 'disabled'): Promise<void> => {
      await ensureWorkspace(workspaceId)
      await withWorkspaceTransaction(sqlPool, workspaceId, async client => {
        await client.query('UPDATE workspaces SET status = $2 WHERE id = $1', [workspaceId, status])
      })
    }
    const checkHealth = async () => {
      const client = await pool.connect()
      try { await client.query('SELECT 1') } finally { client.release() }
    }
    const listWorkspaceIds = async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`)
        const result = await client.query<{ id: string }>('SELECT id FROM workspaces ORDER BY created_at DESC, id ASC')
        await client.query('COMMIT')
        return result.rows.map(row => row.id)
      } catch (error) {
        try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
        throw error
      } finally { client.release() }
    }
    return { mode: 'postgres', outbox, business, billing, commercial, usage, modelUsage, actionLedger, entitlements, operations, subscriptions, members, commercialExtensions, growth, alerts, dataLifecycle, rules, brandUnits, objectOrphans, contextSnapshots, identities, persistSnapshotAndEvent, persistSnapshotsAndEvent, ensureWorkspace, listWorkspaceIds, getWorkspaceStatus, setWorkspaceStatus, checkHealth, close: () => pool.end() }
  } catch (error) {
    await pool.end().catch(() => undefined)
    throw error
  }
}

const persistenceReady = initializePersistence().then(value => { persistence = value; return value }).catch(error => { persistenceError = error; throw error })

async function persistEvent(workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) {
  await persistenceReady
  const event = persistence.outbox
    ? (await persistence.ensureWorkspace?.(workspaceId), await persistence.outbox.append({ workspaceId, aggregateId, eventType, sequence, payload }))
    : { id: `evt_${randomUUID()}`, workspaceId, aggregateId, eventType, sequence, payload, createdAt: new Date().toISOString() }
  const local = inMemoryTimelineEvents.get(workspaceId) ?? []
  if (!local.some(item => item.id === event.id)) local.push(event)
  inMemoryTimelineEvents.set(workspaceId, local)
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function assertVideoProviderJobScope(workspaceId: string, providerJobId: string) {
  await persistenceReady
  const events = persistence.outbox?.listWorkspaceEvents
    ? await persistence.outbox.listWorkspaceEvents(workspaceId, 5000)
    : (inMemoryTimelineEvents.get(workspaceId) ?? [])
  const owned = events.some(event => {
    if (event.eventType !== 'multimodal.video_completed' && event.eventType !== 'multimodal.generation.completed') return false
    const rendering = recordValue(event.payload.rendering)
    return rendering?.providerJobId === providerJobId
  })
  if (!owned) throw new DomainError('VIDEO_PROVIDER_SCOPE_DENIED', '视频任务不存在或不属于当前工作区', 403)
}

async function getWorkspaceStatus(workspaceId: string): Promise<'active' | 'disabled'> {
  await persistenceReady
  if (persistence.getWorkspaceStatus) return persistence.getWorkspaceStatus(workspaceId)
  if (!memoryWorkspaceStatuses.has(workspaceId)) memoryWorkspaceStatuses.set(workspaceId, 'active')
  return memoryWorkspaceStatuses.get(workspaceId) ?? 'active'
}

async function setWorkspaceStatus(workspaceId: string, status: 'active' | 'disabled') {
  await persistenceReady
  if (persistence.setWorkspaceStatus) {
    await persistence.setWorkspaceStatus(workspaceId, status)
    return
  }
  memoryWorkspaceStatuses.set(workspaceId, status)
}

async function requireActiveWorkspace(workspaceId: string, method: string) {
  if (method === 'workspace.health' || method === 'workspace.activate' || method === 'workspace.deactivate') return
  if (await getWorkspaceStatus(workspaceId) !== 'active') throw new DomainError('WORKSPACE_DISABLED', '工作区已停用；请先重新启用后再执行商家操作', 423)
}

const ONBOARDING_METHODS = new Set([
  'merchant.start', 'workspace.health', 'platform.connect', 'billing.status', 'billing.recharge.create', 'billing.recharge.get', 'billing.recharge.list', 'billing.transactions', 'billing.reconciliation',
  'subscription.get', 'subscription.orders.list', 'subscription.order.create', 'subscription.change', 'platform.model.status',
  'workspace.commercial.get', 'workspace.commercial.update', 'workspace.usage.get', 'workspace.activate', 'workspace.deactivate', 'workspace.interactive.confirm',
])

function requireStoreOnboarding(workspaceId: string, method: string) {
  // Local fixture workflows intentionally support unbound planning data. The
  // production App flow must bind at least one live store before any catalog,
  // asset, task, sync, generation, or publishing operation is reachable.
  if (!isProduction() || ONBOARDING_METHODS.has(method) || method.startsWith('ops.') || method.startsWith('knowledge.') || method.startsWith('rule.')) return
  const hasBoundStore = service.listPlatformAccounts(workspaceId).some(account => account.tokenState === 'connected')
  if (!hasBoundStore) throw new DomainError('STORE_ONBOARDING_REQUIRED', '请先完成至少一个平台店铺授权绑定，再继续使用商品、素材、任务或生成能力', 428, { onboarding_required: true, next_actions: ['调用 workspace.health 查看六平台授权入口', '选择平台后调用 platform.connect', '授权回调完成后重新调用 workspace.health'] })
}

function isHttpOnboardingExempt(path: string) {
  return path === '/mcp'
    || path === '/v1/platform-accounts'
    || path === '/v1/platform-capabilities'
    || path.startsWith('/v1/rules')
    || path.startsWith('/v1/billing')
    || path.startsWith('/v1/subscriptions')
    || path.startsWith('/v1/ops')
    || /^\/v1\/platform-accounts\/(jd|taobao|tmall|pinduoduo|xiaohongshu|douyin)\/authorize$/u.test(path)
    || /^\/v1\/generation-jobs\/[^/]+\/(defer|result)$/u.test(path)
    || /^\/v1\/sync-jobs\/[^/]+\/progress$/u.test(path)
    || /^\/v1\/publish-jobs\/[^/]+\/observation$/u.test(path)
}

async function hydrateKnowledge(workspaceId: string): Promise<void> {
  if (hydratedKnowledgeWorkspaces.has(workspaceId)) return
  await persistenceReady
  const events = persistence.outbox?.listWorkspaceEvents
    ? await persistence.outbox.listWorkspaceEvents(workspaceId, 5000)
    : (inMemoryTimelineEvents.get(workspaceId) ?? [])
  knowledge.hydrate(events.filter(event => event.eventType.startsWith('knowledge.')).map(event => ({ eventType: event.eventType, payload: event.payload })))
  hydratedKnowledgeWorkspaces.add(workspaceId)
}

function nextWorkspaceEventSequence(workspaceId: string) {
  const candidate = Math.floor(Date.now() / 1000)
  const next = Math.max(candidate, (workspaceEventSequences.get(workspaceId) ?? 0) + 1)
  workspaceEventSequences.set(workspaceId, next)
  return next
}

function timelineEvent(event: OutboxEvent) {
  const delivery = event.unknownAt ? 'unknown' : event.publishedAt ? 'delivered' : 'pending'
  return {
    id: event.id,
    aggregate_id: event.aggregateId,
    event_type: event.eventType,
    sequence: event.sequence,
    occurred_at: event.createdAt,
    delivery,
    ...(event.attempts !== undefined ? { attempts: event.attempts } : {}),
    ...(event.lastError ? { error: event.lastError } : {}),
    payload: event.payload,
  }
}

async function taskTimeline(workspaceId: string, taskId: string, limit = 100) {
  const task = service.getTask(taskId)
  if (task.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该任务', 403)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须是 1 到 200 的整数', 400)
  const aggregateIds = new Set<string>([task.id])
  for (const version of service.contentVersions.values()) if (version.taskId === task.id) aggregateIds.add(version.id)
  for (const job of service.generationJobs.values()) if (job.taskId === task.id) aggregateIds.add(job.id)
  for (const job of service.imageGenerationJobs.values()) if (job.taskId === task.id) aggregateIds.add(job.id)
  for (const job of service.publishJobs.values()) if (job.taskId === task.id) aggregateIds.add(job.id)
  for (const feedback of service.feedback.values()) if (feedback.taskId === task.id) aggregateIds.add(feedback.id)
  const events: OutboxEvent[] = []
  if (persistence.outbox) {
    await persistenceReady
    for (const aggregateId of aggregateIds) events.push(...await persistence.outbox.listAggregateEvents(workspaceId, aggregateId, limit))
  } else {
    events.push(...(inMemoryTimelineEvents.get(workspaceId) ?? []).filter(event => aggregateIds.has(event.aggregateId)))
  }
  const unique = [...new Map(events.map(event => [event.id, event])).values()]
  return unique.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).slice(-limit).map(timelineEvent)
}

async function syncOperationalAlerts(workspaceId: string) {
  const repository = persistence.alerts ?? memoryAlerts
  const alerts: Array<Omit<OperationalAlert, 'id' | 'status' | 'acknowledgedBy' | 'acknowledgedAt' | 'acknowledgementReason' | 'updatedAt'>> = []
  const accounts = service.listPlatformAccounts(workspaceId)
  for (const account of accounts) {
    if (account.tokenState === 'revoked' || account.tokenState === 'refresh_required') alerts.push({ alertKey: `oauth:${account.platform}:${account.id}:${account.tokenState}`, code: 'OAUTH_REAUTH_REQUIRED', severity: 'high', platform: account.platform, accountId: account.id, entityType: 'platform_account', entityId: account.id, title: `${account.platform} 店铺需要重新授权`, observedAt: account.tokenStateUpdatedAt ?? account.lastAuthorizedAt ?? account.createdAt, evidence: { tokenState: account.tokenState }, nextAction: '打开授权流程完成官方 OAuth 重新授权，并重新执行只读同步验证。', workspaceId })
  }
  for (const job of service.listSyncJobs(workspaceId)) {
    if (job.state === 'failed' || job.state === 'partial') alerts.push({ alertKey: `sync:${job.id}:${job.state}`, code: 'SYNC_FAILED', severity: 'medium', platform: job.platform, accountId: job.accountId, entityType: 'sync_job', entityId: job.id, title: `${job.platform} 商品同步${job.state === 'partial' ? '部分失败' : '失败'}`, observedAt: job.updatedAt, evidence: { state: job.state, failureCount: job.failedItems.length }, nextAction: '查看失败项和平台原始错误，确认商品事实后再重试。', workspaceId })
  }
  for (const job of service.listPublishJobs(workspaceId)) {
    if (job.remoteState === 'rejected' || job.state === 'rejected' || job.remoteState === 'unknown' || job.state === 'unknown' || job.state === 'manual_attention') alerts.push({ alertKey: `publish:${job.id}:${job.remoteState ?? job.state}`, code: job.remoteState === 'rejected' || job.state === 'rejected' ? 'PUBLISH_REJECTED' : 'PUBLISH_UNKNOWN', severity: 'high', platform: job.platform, accountId: job.accountId, entityType: 'publish_job', entityId: job.id, title: job.remoteState === 'rejected' || job.state === 'rejected' ? `${job.platform} 发布被平台拒绝` : `${job.platform} 发布结果未知，需要人工核对`, observedAt: job.remoteObservedAt ?? job.createdAt, evidence: { state: job.state, remoteState: job.remoteState, rejectionCode: job.rejection?.rawCode ?? null }, nextAction: '先读取平台回执和任务时间线；拒绝需修正版重新审核，未知状态禁止自动重发。', workspaceId })
  }
  for (const task of service.listTasks(workspaceId)) {
    if (task.state === 'failed_recoverable') alerts.push({ alertKey: `task:${task.id}:${task.state}`, code: 'TASK_FAILED', severity: 'medium', platform: task.platform, accountId: task.accountId, entityType: 'task', entityId: task.id, title: '营销任务失败，需要恢复或人工处理', observedAt: task.createdAt, evidence: { state: task.state }, nextAction: '打开任务时间线确认失败阶段；可恢复任务使用恢复入口，不要重复创建订单或发布。', workspaceId })
  }
  for (const version of service.contentVersions.values()) {
    const versionTask = service.getTask(version.taskId)
    if (versionTask.workspaceId !== workspaceId) continue
    const findings = service.reviewContent(workspaceId, version.id)
    const blocking = findings.filter(finding => finding.severity === 'error')
    if (blocking.length) alerts.push({ alertKey: `content:${version.id}:${version.revision ?? version.version ?? 1}`, code: 'CONTENT_BLOCKING', severity: 'high', platform: versionTask.platform, accountId: versionTask.accountId, entityType: 'content_version', entityId: version.id, title: '内容版本存在 P0 审核阻断', observedAt: versionTask.createdAt, evidence: { findingCount: blocking.length, findingCodes: blocking.map(finding => finding.code) }, nextAction: '修正事实、价格或品牌规则冲突后创建修正版，重新审核并批准。', workspaceId })
  }
  for (const alert of alerts) {
    const persisted = await repository.upsert(alert)
    // Alert persistence is authoritative; a slow or unavailable notification
    // receiver must not delay the API response or hide the alert from Ops.
    void notifyOperationalAlert(persisted).catch(() => undefined)
  }
  return repository
}
async function persistSnapshot(workspaceId: string, entityType: 'product' | 'task' | 'content_version' | 'publish_job' | 'publish_batch' | 'platform_account' | 'generation_job' | 'image_generation_job' | 'brand_profile' | 'asset' | 'feedback' | 'sync_job' | 'automation_policy', entity: { id: string; version?: number; revision?: number }, value: Record<string, unknown>) {
  await persistenceReady
  const entityVersion = entity.version ?? entity.revision ?? 1
  if (persistence.persistSnapshotAndEvent) {
    await persistence.persistSnapshotAndEvent({ workspaceId, entityType: entityType as BusinessEntityType, entityId: entity.id, entityVersion, payload: value, eventType: 'state.snapshot', eventPayload: { entityType, entity: value } })
    return
  }
  await persistence.ensureWorkspace?.(workspaceId)
  await persistence.business?.save({ workspaceId, entityType: entityType as BusinessEntityType, entityId: entity.id, entityVersion, payload: value })
  await persistEvent(workspaceId, entity.id, 'state.snapshot', entityVersion, { entityType, entity: value })
}

async function persistExpiredDeliveryIfNeeded(workspaceId: string, contentVersionId: string) {
  const expired = service.markExpiredDeliveryIfNeeded(workspaceId, contentVersionId)
  if (!expired) return
  await persistSnapshot(workspaceId, 'content_version', expired, expired as unknown as Record<string, unknown>)
  await persistEvent(workspaceId, expired.id, 'content.delivery_expired', expired.revision, { content_version_id: expired.id, reason: expired.deliveryStatusReason ?? '价格或促销有效期已过期', delivery_status: expired.deliveryStatus, updated_at: expired.deliveryStatusUpdatedAt })
}

async function persistAssetReference(workspaceId: string, asset: AssetRegistrationResult) {
  if (asset.deduplication.mode !== 'deduplicated' || !asset.deduplication.referenceAdded) return
  await persistSnapshot(workspaceId, 'asset', asset, asset as unknown as Record<string, unknown>)
  const reference = asset.references.at(-1)
  await persistEvent(workspaceId, asset.id, 'asset.reference_added', asset.revision, { asset_id: asset.id, reference_name: reference?.name, mime_type: reference?.mimeType, reference_count: asset.references.length })
}

async function ensureFixtureAccount(workspaceId: string, platform: Platform, accountId: string) {
  if (!fixtureMode) return
  try {
    service.getPlatformAccount(workspaceId, accountId, platform)
    return
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'PLATFORM_ACCOUNT_NOT_FOUND') throw error
  }
  const account = service.registerPlatformAccount({
    workspaceId,
    platform,
    remoteAccountId: accountId,
    credentialRef: `fixture-secret/${platform}/${accountId}`,
    grantedScopes: ['fixture.product.read', 'fixture.product.write'],
    accessTokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
    credentialRefreshable: true,
  })
  await persistSnapshot(workspaceId, 'platform_account', account, account as unknown as Record<string, unknown>)
}

function grantedScopes(scope?: string) {
  return scope?.split(/[\s,]+/u).map(item => item.trim()).filter(Boolean)
}

async function persistSnapshotsAndEvent(input: { workspaceId: string; snapshots: SnapshotInput[]; aggregateId: string; eventType: string; sequence: number; eventPayload: Record<string, unknown> }) {
  await persistenceReady
  if (persistence.persistSnapshotsAndEvent) return persistence.persistSnapshotsAndEvent(input)
  for (const snapshot of input.snapshots) await persistSnapshot(input.workspaceId, snapshot.entityType, { id: snapshot.entityId, revision: snapshot.entityVersion }, snapshot.payload)
  await persistEvent(input.workspaceId, input.aggregateId, input.eventType, input.sequence, input.eventPayload)
}

function jobWithQueueMetadata<T extends { id: string }>(job: T, workspaceId: string, type: 'generation' | 'publish') {
  return { ...job, ...service.getJobQueueMetadata(workspaceId, { type, jobId: job.id }) }
}

function batchStateFromItems(items: PublishBatchItem[]): PublishBatch['state'] {
  if (items.length && items.every(item => ['published', 'submitted'].includes(item.state))) return 'completed'
  if (items.some(item => item.state === 'failed' || item.state === 'rejected' || item.state === 'unknown')) return items.some(item => ['queued', 'submitted', 'published'].includes(item.state)) ? 'partial' : 'failed'
  if (items.every(item => item.state === 'paused')) return 'paused'
  if (items.some(item => ['queued', 'submitted', 'published'].includes(item.state))) return 'queued'
  return 'prepared'
}

async function savePublishBatch(batch: PublishBatch, eventType = 'publish.batch.updated') {
  const previous = persistedPublishBatches.get(batch.id)
  const next = structuredClone(batch)
  next.updatedAt = new Date().toISOString()
  next.revision += 1
  const eventPayload = { batch_id: next.id, state: next.state, items: next.items.map(item => ({ task_id: item.taskId, state: item.state, job_id: item.jobId ?? null })) }
  try {
    await persistSnapshotsAndEvent({ workspaceId: next.workspaceId, snapshots: [{ entityType: 'publish_batch', entityId: next.id, entityVersion: next.revision, payload: next as unknown as Record<string, unknown> }], aggregateId: next.id, eventType, sequence: next.revision, eventPayload })
  } catch (error) {
    if (previous) {
      for (const key of Object.keys(batch as unknown as Record<string, unknown>)) delete (batch as unknown as Record<string, unknown>)[key]
      Object.assign(batch, structuredClone(previous))
      publishBatches.set(batch.id, batch)
    } else {
      publishBatches.delete(batch.id)
    }
    throw error
  }
  for (const key of Object.keys(batch as unknown as Record<string, unknown>)) delete (batch as unknown as Record<string, unknown>)[key]
  Object.assign(batch, next)
  publishBatches.set(batch.id, batch)
  persistedPublishBatches.set(batch.id, structuredClone(batch))
  return batch
}

/**
 * Bulk publish admission must make the parent batch and child publish job
 * recoverable together. The normalized projections and outbox event are
 * committed in one workspace transaction; a restart can therefore never
 * observe a durable child without its parent batch item.
 */
async function persistPublishJobWithBatch(input: { batch: PublishBatch; task: ReturnType<typeof service.getTask>; job: import('../../../packages/application/src/service.js').PublishJob; itemState: PublishBatchItem['state']; error?: PublishBatchItem['error'] }) {
  const next = structuredClone(input.batch)
  const item = next.items.find(candidate => candidate.taskId === input.task.id)
  if (!item) throw new DomainError('PUBLISH_BATCH_ITEM_NOT_FOUND', `任务 ${input.task.id} 不属于该批次`, 400)
  Object.assign(item, { state: input.itemState, jobId: input.job.id, contentVersionId: input.job.contentVersionId, confirmationHash: input.job.confirmationHash, remoteSnapshotHash: input.job.remoteSnapshotHash, ...(input.job.accountId ? { accountId: input.job.accountId } : {}), ...(input.error ? { error: input.error } : { error: undefined }) })
  next.state = batchStateFromItems(next.items)
  next.updatedAt = new Date().toISOString()
  next.revision += 1
  await persistSnapshotsAndEvent({
    workspaceId: next.workspaceId,
    snapshots: [
      { entityType: 'task', entityId: input.task.id, entityVersion: input.task.version, payload: input.task as unknown as Record<string, unknown> },
      { entityType: 'publish_job', entityId: input.job.id, entityVersion: input.job.revision, payload: input.job as unknown as Record<string, unknown> },
      { entityType: 'publish_batch', entityId: next.id, entityVersion: next.revision, payload: next as unknown as Record<string, unknown> },
    ],
    aggregateId: input.job.id,
    eventType: 'publish.requested',
    sequence: input.job.revision,
    eventPayload: { ...publishEventPayload(input.job), batch_id: next.id, batch_revision: next.revision },
  })
  for (const key of Object.keys(input.batch as unknown as Record<string, unknown>)) delete (input.batch as unknown as Record<string, unknown>)[key]
  Object.assign(input.batch, next)
  publishBatches.set(next.id, input.batch)
  persistedPublishBatches.set(next.id, structuredClone(next))
  return input.batch
}

function automationPolicyKey(workspaceId: string, platform?: Platform, accountId?: string) { return `${workspaceId}:${platform ?? '*'}:${accountId ?? '*'}` }

function normalizeAutomationTime(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const normalized = value.trim()
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(normalized)) throw new DomainError('AUTOMATION_WINDOW_INVALID', `${field} 必须是 HH:mm 格式`, 400)
  return normalized
}

function automationWindowContains(now: Date, start?: string, end?: string) {
  if (!start && !end) return true
  if (!start || !end) return false
  const current = now.getHours() * 60 + now.getMinutes()
  const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
  const from = toMinutes(start); const until = toMinutes(end)
  if (from === until) return true
  return from < until ? current >= from && current < until : current >= from || current < until
}

function nextAutomationWindowStart(now: Date, start?: string, end?: string) {
  if (!start || !end || automationWindowContains(now, start, end)) return now
  const [hours, minutes] = start.split(':').map(Number)
  const next = new Date(now)
  next.setHours(hours!, minutes!, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next
}

function validateAutomationScope(workspaceId: string, platform?: Platform, accountId?: string) {
  if (platform && !SUPPORTED_PLATFORMS.includes(platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
  if (accountId && !platform) throw new DomainError('STORE_PLATFORM_REQUIRED', '使用 account_id 配置店铺自动化时必须同时指定 platform', 400)
  if (platform && accountId) service.getPlatformAccount(workspaceId, accountId, platform)
  return { platform, accountId }
}

async function saveAutomationPolicy(policy: AutomationPolicy, eventType = 'automation.policy.updated') {
  policy.updatedAt = new Date().toISOString()
  automationPolicies.set(automationPolicyKey(policy.workspaceId, policy.platform, policy.accountId), policy)
  await persistSnapshot(policy.workspaceId, 'automation_policy', policy, policy as unknown as Record<string, unknown>)
  await persistEvent(policy.workspaceId, policy.id, eventType, policy.revision, { policy_id: policy.id, platform: policy.platform ?? null, account_id: policy.accountId ?? null, enabled: policy.enabled, mode: policy.mode, frequency_minutes: policy.frequencyMinutes, retry_limit: policy.retryLimit, pause_reason: policy.pauseReason ?? null })
  return policy
}

async function executeAutomationScan(workspaceId: string, platform?: Platform, accountId?: string) {
  const products = service.listProducts(workspaceId, { ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}) })
  const jobs = [...service.publishJobs.values()].filter(job => job.workspaceId === workspaceId && (!platform || job.platform === platform) && (!accountId || job.accountId === accountId))
  const selectedAccounts = service.listPlatformAccounts(workspaceId).filter(account => (!platform || account.platform === platform) && (!accountId || account.id === accountId))
  const ruleRisks = (await Promise.all(products.map(async product => {
    const evaluation = service.ruleCenter.evaluate({ platform: product.platform, ...(product.category ? { category: product.category } : {}), ...(product.storeName ? { store: product.storeName } : {}) })
    const inMemoryBlocking = evaluation.findings.some(finding => finding.severity === 'error' && ['RULE_EXPIRED', 'RULE_NOT_YET_EFFECTIVE', 'RULE_PRIORITY_CONFLICT'].includes(finding.code))
    if (!inMemoryBlocking && !(await persistedRuleHasBlockingRisk(workspaceId, product))) return undefined
    return { kind: 'rule_conflict' as const, product_id: product.id, platform: product.platform, account_id: product.accountId ?? null, message: '适用平台规则存在过期、未生效或优先级冲突' }
  }))).filter((risk): risk is NonNullable<typeof risk> => Boolean(risk))
  const risks: AutomationRisk[] = [
    ...selectedAccounts.filter(account => account.tokenState === 'revoked' || account.tokenState === 'refresh_required').map(account => ({ kind: 'authorization', platform: account.platform, account_id: account.id, message: `店铺授权状态为 ${account.tokenState}，需要重新授权` })),
    ...ruleRisks,
    ...products.filter(product => !product.factsConfirmed).map(product => ({ kind: 'unconfirmed_facts', product_id: product.id, platform: product.platform, account_id: product.accountId ?? null, message: '商品事实尚未确认' })),
    ...products.filter(product => product.stock <= 0).map(product => ({ kind: 'out_of_stock', product_id: product.id, platform: product.platform, account_id: product.accountId ?? null, message: '库存为零' })),
    ...products.filter(product => product.stock > 0 && product.stock <= 10).map(product => ({ kind: 'low_stock', product_id: product.id, platform: product.platform, account_id: product.accountId ?? null, message: `库存偏低：${product.stock}` })),
    ...jobs.filter(job => ['rejected', 'unknown', 'manual_attention'].includes(job.state)).map(job => ({ kind: 'publish_attention', publish_job_id: job.id, platform: job.platform, account_id: job.accountId ?? null, message: `发布状态需要人工处理：${job.state}` })),
  ]
  const alertRepository = persistence.alerts ?? memoryAlerts
  for (const risk of risks) {
    const entityId = risk.product_id ?? risk.publish_job_id ?? `${risk.kind}:${workspaceId}`
    const persisted = await alertRepository.upsert({ alertKey: `automation:${risk.kind}:${entityId}`, code: `AUTOMATION_${risk.kind.toUpperCase()}`, severity: risk.kind === 'publish_attention' ? 'high' : 'medium', ...(risk.platform ? { platform: risk.platform } : {}), ...(risk.account_id ? { accountId: risk.account_id } : {}), entityType: risk.product_id ? 'product' : 'publish_job', entityId, title: risk.message, observedAt: new Date().toISOString(), evidence: { kind: risk.kind, ...(risk.product_id ? { productId: risk.product_id } : {}), ...(risk.publish_job_id ? { publishJobId: risk.publish_job_id } : {}) }, nextAction: '在交互会话中查看详情，修正后再执行人工确认或重试。', workspaceId })
    void notifyOperationalAlert(persisted).catch(() => undefined)
  }
  const recommendations: AutomationRecommendation[] = risks.map((risk, index): AutomationRecommendation => {
    const id = `automation-recommendation:${risk.kind}:${risk.product_id ?? risk.publish_job_id ?? index}`
    if (risk.kind === 'authorization') return { id, kind: risk.kind, priority: 'high', title: '恢复店铺授权', action: '打开官方授权入口并完成重新授权', method: 'platform.connect', parameters: { platform: risk.platform }, execution: 'interactive_confirmation', requiresInteractiveConfirmation: true }
    if (risk.kind === 'unconfirmed_facts') return { id, kind: risk.kind, priority: 'high', title: '确认商品事实', action: '核对价格、库存、SKU、图片和属性后确认', method: 'catalog.facts.confirm', parameters: { product_id: risk.product_id ?? '' }, execution: 'interactive_confirmation', requiresInteractiveConfirmation: true }
    if (risk.kind === 'out_of_stock' || risk.kind === 'low_stock') {
      return risk.account_id
        ? { id, kind: risk.kind, priority: risk.kind === 'out_of_stock' ? 'high' : 'medium', title: risk.kind === 'out_of_stock' ? '处理缺货商品' : '复核低库存商品', action: '同步店铺库存并由运营确认补货、下架或调整推广', method: 'catalog.sync.start', parameters: { platform: risk.platform, account_id: risk.account_id }, execution: 'interactive_confirmation', requiresInteractiveConfirmation: true }
        : { id, kind: risk.kind, priority: 'high', title: '绑定店铺后处理库存', action: '先完成店铺授权，再同步库存', method: 'platform.connect', parameters: { platform: risk.platform }, execution: 'interactive_confirmation', requiresInteractiveConfirmation: true }
    }
    if (risk.kind === 'publish_attention') return { id, kind: risk.kind, priority: 'high', title: '复核发布异常', action: '查看远端状态、差异和失败原因', method: 'publish.get', parameters: { job_id: risk.publish_job_id ?? '' }, execution: 'read_only', requiresInteractiveConfirmation: false }
    return { id, kind: risk.kind, priority: 'medium', title: '检查平台规则', action: '查看当前平台适用规则和冲突项', method: 'rule.list', parameters: { platform: risk.platform }, execution: 'read_only', requiresInteractiveConfirmation: false }
  })
  return { scannedAt: new Date().toISOString(), scope: { platform: platform ?? null, accountId: accountId ?? null }, counts: { products: products.length, publishJobs: jobs.length, risks: risks.length, alertsUpserted: risks.length }, risks, recommendations, actions: ['查看结构化优化建议', '在交互会话中确认后执行建议动作'], humanConfirmationRequired: true as const, unattendedAutoResubmit: false as const }
}

async function scanAutomationAfterOperationalCompletion(workspaceId: string, platform: Platform, accountId: string, trigger: string) {
  const policy = automationPolicies.get(automationPolicyKey(workspaceId, platform, accountId))
  if (!policy?.enabled) return { triggered: false as const, reason: 'automation_policy_disabled' as const }
  try {
    const scan = await executeAutomationScan(workspaceId, platform, accountId)
    await recordOperationAudit({
      workspaceId,
      actorId: 'automation-sync-hook',
      action: 'automation.post_sync_scan',
      resourceType: 'automation_policy',
      resourceId: policy.id,
      before: {},
      after: { platform, accountId, trigger, risks: scan.counts.risks, products: scan.counts.products },
      reason: '商品同步完成后按店铺策略即时执行风险扫描；不自动发布或重试',
    })
    return { triggered: true as const, ...scan }
  } catch (error) {
    return { triggered: false as const, reason: 'automation_scan_failed' as const, error: error instanceof Error ? error.message : '自动化同步后扫描失败' }
  }
}

async function requestCatalogSync(workspaceId: string, req: IncomingMessage, params: JsonObject) {
  const platform = required(params, 'platform') as Platform
  if (!platformConnectorConfigured(platform)) throw new DomainError('NOT_CONFIGURED', `${platform} 官方 API 尚未配置，无法同步商品`, 503)
  const accountId = (typeof params.account_id === 'string' && params.account_id.trim()) || header(req, 'x-account-id')?.trim() || (isProduction() ? '' : defaultFixtureAccountId(workspaceId, platform))
  if (!accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产同步必须指定已授权平台账号', 400)
  const platformAccount = isProduction() || fixtureMode ? requireActivePlatformAccount(workspaceId, accountId, platform) : undefined
  await ensureFixtureAccount(workspaceId, platform, accountId)
  const job = service.createSyncJob({ workspaceId, platform, accountId, mode: params.mode === 'full' ? 'full' : 'incremental', ...(typeof params.cursor === 'string' && params.cursor.trim() ? { cursor: params.cursor } : {}) })
  const syncEntitlementKey = `bulk-sync-job:${job.id}`
  let syncEntitlement: Awaited<ReturnType<typeof consumeEntitlement>>
  try {
    syncEntitlement = await consumeEntitlement({ workspaceId, kind: 'bulk_sync', actionKey: syncEntitlementKey, actionKind: 'catalog_sync', actorId: requestActor(req), description: '商品批量同步权益（可选加购）' })
  } catch (error) {
    service.removeSyncJob(workspaceId, job.id)
    throw error
  }
  try {
    await persistSnapshot(workspaceId, 'sync_job', job, job as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, job.id, 'sync.requested', job.revision, { job_id: job.id, platform, account_id: accountId, mode: job.mode, ...(job.resumeCursor ? { cursor: job.resumeCursor } : {}) })
  } catch (error) {
    const failed = service.updateSyncJob(workspaceId, job.id, { state: 'failed', errorMessage: error instanceof Error ? error.message : '同步任务持久化失败' })
    let failureProjected = false
    try {
      await persistSnapshot(workspaceId, 'sync_job', failed, failed as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, job.id, 'sync.failed', failed.revision, { job_id: job.id, platform, account_id: accountId, error_message: failed.errorMessage ?? '同步任务持久化失败' })
      failureProjected = true
    } catch { /* preserve the original failure; remove the in-memory ghost below */ }
    if (!failureProjected) service.removeSyncJob(workspaceId, job.id)
    if (syncEntitlement) await refundEntitlement({ workspaceId, actionKey: syncEntitlementKey, reason: '同步任务持久化失败' }).catch(() => undefined)
    throw error
  }
  if (fixtureMode) {
    try {
      const synced = await connectorRuntime.sync(platform, { workspaceId, accountId, ...(platformAccount ? { credentialRef: platformAccount.credentialRef } : {}), traceId: requestId(req) }, job.resumeCursor)
      const products = service.upsertSyncedProducts({ workspaceId, platform, accountId, items: synced.items })
      const completed = service.updateSyncJob(workspaceId, job.id, { state: 'succeeded', pages: synced.pages, itemsUpserted: products.length, itemsFailed: 0, failedItems: [], nextCursor: undefined, resumeCursor: undefined })
      for (const product of products) await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
      await persistSnapshot(workspaceId, 'sync_job', completed, completed as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, job.id, 'sync.completed', completed.revision, { job_id: job.id, platform, account_id: accountId, pages: synced.pages, items_upserted: products.length, simulated: true })
      const automation = await scanAutomationAfterOperationalCompletion(workspaceId, platform, accountId, 'catalog.sync.start.completed')
      return { ...completed, products, simulated: true, automation }
    } catch (error) {
      const failed = service.updateSyncJob(workspaceId, job.id, { state: 'failed', errorMessage: error instanceof Error ? error.message : '同步 provider 调用失败' })
      await persistSnapshot(workspaceId, 'sync_job', failed, failed as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, job.id, 'sync.failed', failed.revision, { job_id: job.id, platform, account_id: accountId, error_message: failed.errorMessage ?? '同步 provider 调用失败', simulated: true })
      if (syncEntitlement) await refundEntitlement({ workspaceId, actionKey: syncEntitlementKey, reason: '商品批量同步失败' })
      throw error
    }
  }
  return job
}

async function runAutomationTickUnlocked(workspaceId: string, req: IncomingMessage, actorId: string) {
  const nowMs = Date.now(); const executed: Array<Record<string, unknown>> = []
  for (const policy of [...automationPolicies.values()].filter(item => item.workspaceId === workspaceId && item.enabled)) {
    if (policy.nextRunAt && Date.parse(policy.nextRunAt) > nowMs) continue
    const current = new Date(nowMs)
    if (!automationWindowContains(current, policy.windowStart, policy.windowEnd)) {
      const nextWindow = nextAutomationWindowStart(current, policy.windowStart, policy.windowEnd)
      policy.nextRunAt = nextWindow.toISOString()
      policy.revision += 1
      await saveAutomationPolicy(policy, 'automation.policy.deferred_window')
      await recordOperationAudit({ workspaceId, actorId, action: 'automation.policy.deferred_window', resourceType: 'automation_policy', resourceId: policy.id, before: {}, after: { nextRunAt: policy.nextRunAt, windowStart: policy.windowStart, windowEnd: policy.windowEnd }, reason: '当前时间不在店铺自动化执行窗口内' })
      executed.push({ policyId: policy.id, platform: policy.platform ?? null, accountId: policy.accountId ?? null, deferred: true, reason: 'outside_execution_window', nextRunAt: policy.nextRunAt })
      continue
    }
    const scan = await executeAutomationScan(workspaceId, policy.platform, policy.accountId)
    const blockingRisk = scan.risks.find(risk => risk.kind === 'authorization' || risk.kind === 'rule_conflict')
    if (blockingRisk) {
      const pauseReason = `自动暂停：${blockingRisk.message}`
      const before = { enabled: policy.enabled, pauseReason: policy.pauseReason ?? null, syncEnabled: policy.syncEnabled }
      policy.enabled = false
      policy.pauseReason = pauseReason
      policy.lastRunAt = scan.scannedAt
      policy.nextRunAt = undefined
      policy.revision += 1
      await saveAutomationPolicy(policy, 'automation.policy.auto_paused')
      await recordOperationAudit({ workspaceId, actorId, action: 'automation.policy.auto_paused', resourceType: 'automation_policy', resourceId: policy.id, before, after: { enabled: false, pauseReason, syncEnabled: policy.syncEnabled, risk: blockingRisk }, reason: pauseReason })
      executed.push({ policyId: policy.id, platform: policy.platform ?? null, accountId: policy.accountId ?? null, ...scan, paused: true, pauseReason, syncSkipped: true })
      continue
    }
    let sync: Record<string, unknown> | undefined
    let syncError: Record<string, unknown> | undefined
    // Claim the next execution before creating any external sync work. If the
    // process dies after the job is accepted but before the final audit write,
    // the persisted schedule still prevents an immediate duplicate tick.
    policy.lastRunAt = scan.scannedAt
    policy.nextRunAt = new Date(Date.parse(scan.scannedAt) + policy.frequencyMinutes * 60_000).toISOString()
    policy.claimedAt = scan.scannedAt
    policy.revision += 1
    await saveAutomationPolicy(policy, 'automation.policy.claimed')
    if (policy.syncEnabled && policy.platform && policy.accountId) {
      try { sync = await requestCatalogSync(workspaceId, req, { platform: policy.platform, account_id: policy.accountId }) as unknown as Record<string, unknown> }
      catch (error) { syncError = { code: error instanceof DomainError ? error.code : 'SYNC_REQUEST_FAILED', message: error instanceof Error ? error.message : '同步任务创建失败' } }
    }
    if (typeof sync?.id === 'string') policy.lastSyncJobId = sync.id
    policy.claimedAt = undefined
    await saveAutomationPolicy(policy, 'automation.policy.executed')
    await recordOperationAudit({ workspaceId, actorId, action: 'automation.tick', resourceType: 'automation_policy', resourceId: policy.id, before: {}, after: { lastRunAt: policy.lastRunAt, nextRunAt: policy.nextRunAt, risks: scan.counts.risks, syncJobId: sync?.id ?? null, syncError: syncError?.code ?? null }, reason: policy.syncEnabled ? '自动化调度器执行店铺风险扫描并请求商品同步' : '自动化调度器执行到期店铺风险扫描' })
    executed.push({ policyId: policy.id, platform: policy.platform ?? null, accountId: policy.accountId ?? null, ...scan, ...(sync ? { sync } : {}), ...(syncError ? { syncError } : {}) })
  }
  return { executedAt: new Date().toISOString(), executed, unattendedAutoResubmit: false as const, humanConfirmationRequired: true as const }
}

async function runAutomationTick(workspaceId: string, req: IncomingMessage, actorId: string) {
  const configuredTtl = Number(process.env.AUTOMATION_TICK_LEASE_MS ?? 120_000)
  const ttlMs = Number.isSafeInteger(configuredTtl) ? Math.min(10 * 60_000, Math.max(5_000, configuredTtl)) : 120_000
  const key = `merchant:automation-tick:${createHash('sha256').update(workspaceId).digest('hex')}`
  const token = randomUUID()
  let acquired = false
  if (redisAutomationLease) {
    acquired = await redisAutomationLease.acquire(key, token, ttlMs)
  } else {
    const current = localAutomationLeases.get(key)
    if (!current || current.expiresAt <= Date.now()) {
      localAutomationLeases.set(key, { token, expiresAt: Date.now() + ttlMs })
      acquired = true
    }
  }
  if (!acquired) return { executedAt: new Date().toISOString(), executed: [], skipped: true as const, skipReason: 'automation_tick_lease_held', unattendedAutoResubmit: false as const, humanConfirmationRequired: true as const }
  const renewLease = async () => {
    if (redisAutomationLease) {
      await redisAutomationLease.renew(key, token, ttlMs)
      return
    }
    const current = localAutomationLeases.get(key)
    if (current?.token === token) current.expiresAt = Date.now() + ttlMs
  }
  const heartbeat = setInterval(() => { void renewLease().catch(() => undefined) }, Math.max(1_000, Math.floor(ttlMs / 3)))
  try {
    const testDelayMs = process.env.NODE_ENV === 'test' ? Number(process.env.AUTOMATION_TICK_LEASE_TEST_DELAY_MS ?? 0) : 0
    if (Number.isSafeInteger(testDelayMs) && testDelayMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(testDelayMs, 1_000)))
    return await runAutomationTickUnlocked(workspaceId, req, actorId)
  } finally {
    clearInterval(heartbeat)
    if (redisAutomationLease) await redisAutomationLease.release(key, token)
    else if (localAutomationLeases.get(key)?.token === token) localAutomationLeases.delete(key)
  }
}

async function refreshPublishBatch(batch: PublishBatch) {
  let changed = false
  for (const item of batch.items) {
    if (!item.jobId) continue
    const job = service.publishJobs.get(item.jobId)
    if (!job) continue
    const nextState = (job.state === 'published' ? 'published' : job.state === 'submitted' ? 'submitted' : job.state === 'rejected' ? 'rejected' : job.state === 'unknown' ? 'unknown' : job.state === 'queued' || job.state === 'submitting' ? 'queued' : item.state) as PublishBatchItem['state']
    if (item.state !== nextState || item.error?.message !== job.rejection?.message) {
      item.state = nextState
      if (job.rejection) item.error = { code: job.rejection.rawCode, message: job.rejection.message ?? '平台拒绝发布' }
      changed = true
    }
  }
  const state = batch.state === 'paused' ? 'paused' : batchStateFromItems(batch.items)
  if (batch.state !== state) { batch.state = state; changed = true }
  if (changed) await savePublishBatch(batch, 'publish.batch.reconciled')
  return batch
}

/** Recover a scheduler claim that was persisted immediately before a process
 * crash. A durable sync job proves the claim completed; otherwise requeue the
 * policy immediately instead of waiting for the old future nextRunAt. */
async function reconcileAutomationClaims(workspaceId: string) {
  const policies = [...automationPolicies.values()].filter(policy => policy.workspaceId === workspaceId && policy.enabled && policy.claimedAt)
  for (const policy of policies) {
    const claimedAtMs = Date.parse(policy.claimedAt!)
    const matching = policy.syncEnabled && Number.isFinite(claimedAtMs)
      ? service.listSyncJobs(workspaceId).filter(job => (!policy.platform || job.platform === policy.platform) && (!policy.accountId || job.accountId === policy.accountId)).filter(job => {
        const createdAtMs = Date.parse(job.createdAt)
        return Number.isFinite(createdAtMs) && createdAtMs >= claimedAtMs - 5_000
      }).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      : undefined
    const recovered = structuredClone(policy)
    recovered.claimedAt = undefined
    if (matching) recovered.lastSyncJobId = matching.id
    else if (policy.syncEnabled) recovered.nextRunAt = new Date().toISOString()
    recovered.revision += 1
    await saveAutomationPolicy(recovered, matching ? 'automation.policy.claim.recovered' : 'automation.policy.claim.requeued')
  }
}

type DurableStateSnapshot = { aggregateId: string; sequence: number; payload: Record<string, unknown> }

function hydrateOutboxSnapshot(workspaceId: string, snapshot: DurableStateSnapshot) {
  const payload = snapshot.payload
  if (payload.entityType === 'publish_batch') {
    const entity = payload.entity as (PublishBatch & { id?: string }) | undefined
    if (!entity) return
    const batchId = String(entity.id ?? snapshot.aggregateId)
    publishBatches.set(batchId, entity)
    persistedPublishBatches.set(batchId, structuredClone(entity))
  }
  else if (payload.entityType === 'automation_policy') {
    const policy = payload.entity as AutomationPolicy | undefined
    if (policy) automationPolicies.set(automationPolicyKey(workspaceId, policy.platform, policy.accountId), policy)
  }
  else if (payload.entityType === 'product' || payload.entityType === 'task' || payload.entityType === 'content_version' || payload.entityType === 'publish_job' || payload.entityType === 'platform_account' || payload.entityType === 'generation_job' || payload.entityType === 'image_generation_job' || payload.entityType === 'brand_profile' || payload.entityType === 'asset' || payload.entityType === 'feedback' || payload.entityType === 'sync_job') {
    service.hydrateSnapshot({ entityType: payload.entityType, entity: payload.entity })
  }
}

async function hydrateWorkspace(workspaceId: string) {
  await persistenceReady
  if (!persistence.business) return
  const durable = await persistence.business.loadWorkspace(workspaceId)
  const durableKeys = new Set(durable.map(snapshot => `${snapshot.entityType}:${snapshot.entityId}`))
  for (const snapshot of durable) {
    if (snapshot.entityType === 'publish_batch') {
      const batch = snapshot.payload as unknown as PublishBatch
      publishBatches.set(snapshot.entityId, batch)
      persistedPublishBatches.set(snapshot.entityId, structuredClone(batch))
    }
    else if (snapshot.entityType === 'automation_policy') {
      const policy = snapshot.payload as unknown as AutomationPolicy
      automationPolicies.set(automationPolicyKey(workspaceId, policy.platform, policy.accountId), policy)
    }
    else {
      try { service.hydrateSnapshot({ entityType: snapshot.entityType, entity: snapshot.payload }) }
      catch (error) {
        const candidate = error as { code?: string; details?: { missing?: unknown } }
        if (candidate.code !== 'PUBLISH_JOB_SNAPSHOT_INVALID') throw error
        const missing = Array.isArray(candidate.details?.missing) ? candidate.details.missing.filter((item): item is string => typeof item === 'string') : ['unknown']
        const warnings = invalidDurableSnapshots.get(workspaceId) ?? []
        if (!warnings.some(item => item.entityType === snapshot.entityType && item.entityId === snapshot.entityId)) warnings.push({ entityType: snapshot.entityType, entityId: snapshot.entityId, missing })
        invalidDurableSnapshots.set(workspaceId, warnings)
      }
    }
  }
  const durableOutbox = persistence.outbox as (OutboxRepository & { loadStateSnapshots?: (workspaceId: string) => Promise<DurableStateSnapshot[]> }) | undefined
  if (durableOutbox?.loadStateSnapshots) {
    for (const snapshot of await durableOutbox.loadStateSnapshots(workspaceId)) {
      const entity = snapshot.payload.entity as { id?: unknown } | undefined
      const entityId = typeof entity?.id === 'string' ? entity.id : snapshot.aggregateId
      if (durable.length && typeof snapshot.payload.entityType === 'string' && durableKeys.has(`${snapshot.payload.entityType}:${entityId}`)) continue
      hydrateOutboxSnapshot(workspaceId, snapshot)
    }
  }
  await reconcileAutomationClaims(workspaceId)
}

function publishEventPayload(job: import('../../../packages/application/src/service.js').PublishJob) {
  const payloadSnapshot = job.payloadSnapshot ?? {}
  const fields = structuredClone(payloadSnapshot.fields ?? {})
  return {
    taskId: job.taskId,
    contentVersionId: job.contentVersionId,
    platform: job.platform,
    workspaceId: job.workspaceId,
    idempotencyKey: job.idempotencyKey,
    ...(job.accountId ? { account_id: job.accountId } : {}),
    ...(job.payloadSnapshot?.remoteId || job.remoteId ? { remote_id: job.payloadSnapshot?.remoteId ?? job.remoteId } : {}),
    fields,
    payload_hash: job.payloadHash,
    media_required: job.selectedVisuals.length > 0,
    ...(job.selectionHash ? { selection_hash: job.selectionHash } : {}),
    image_mode: job.payloadSnapshot?.imageMode ?? 'unchanged',
  }
}

async function publishMediaPayload(workspaceId: string, job: import('../../../packages/application/src/service.js').PublishJob) {
  const media = [] as Array<{ visual_ref: string; role: 'main' | 'secondary'; sku_ids?: string[]; mime_type: string; sha256: string; content_base64: string }>
  for (const selected of job.selectedVisuals) {
    const imageJob = service.resolveImageGenerationByVisualRef(workspaceId, selected.visualRef)
    const output = imageJob.outputs?.find(candidate => candidate.visualRef === selected.visualRef)
    if (!output) throw new DomainError('VISUAL_NOT_FOUND', `发布媒体候选 ${selected.visualRef} 不存在`, 404)
    const stored = await getStoredObjectWithRetry(workspaceId, output.storageKey)
    media.push({ visual_ref: selected.visualRef, role: selected.role, ...(selected.skuIds?.length ? { sku_ids: [...selected.skuIds] } : {}), mime_type: output.mimeType, sha256: output.sha256, content_base64: Buffer.from(stored.body).toString('base64') })
  }
  return media
}

function publishReconcileEventPayload(job: import('../../../packages/application/src/service.js').PublishJob) {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    taskId: job.taskId,
    contentVersionId: job.contentVersionId,
    platform: job.platform,
    ...(job.accountId ? { account_id: job.accountId } : {}),
    ...(job.payloadSnapshot?.remoteId || job.remoteId ? { remote_id: job.remoteId ?? job.payloadSnapshot.remoteId } : {}),
    idempotencyKey: job.idempotencyKey,
    payload_hash: job.payloadHash,
    ...(job.selectionHash ? { selection_hash: job.selectionHash } : {}),
  }
}

function creativeBrief(workspaceId: string, product: import('../../../packages/application/src/service.js').Product, params: JsonObject) {
  const assetType = typeof params.asset_type === 'string' ? params.asset_type : ''
  if (!['banner', 'ad', 'video_storyboard'].includes(assetType)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'asset_type 必须是 banner、ad 或 video_storyboard', 400)
  const platform = typeof params.platform === 'string' && SUPPORTED_PLATFORMS.includes(params.platform as Platform) ? params.platform as Platform : product.platform
  const parseJson = (key: string) => {
    const raw = params[key]
    if (typeof raw !== 'string' || !raw.trim()) return undefined
    try { return JSON.parse(raw) as unknown } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是有效 JSON`, 400) }
  }
  const dimensions = parseJson('dimensions_json')
  if (dimensions !== undefined && (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'dimensions_json 必须是对象', 400)
  const requestedSkus = parseJson('sku_ids_json')
  if (requestedSkus !== undefined && (!Array.isArray(requestedSkus) || requestedSkus.some(item => typeof item !== 'string'))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'sku_ids_json 必须是 SKU ID 数组', 400)
  const skuIds = (requestedSkus as string[] | undefined) ?? (product.skus?.map(sku => sku.id) ?? [])
  const knownSkuIds = new Set(product.skus?.map(sku => sku.id) ?? [])
  const unknownSku = skuIds.find(sku => !knownSkuIds.has(sku))
  if (unknownSku) throw new DomainError('SKU_NOT_FOUND', `SKU ${unknownSku} 不属于当前商品，不能进入创意 Brief`, 409, { sku_id: unknownSku })
  const promotion = parseJson('promotion_json')
  if (promotion !== undefined && (!promotion || typeof promotion !== 'object' || Array.isArray(promotion))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'promotion_json 必须是对象', 400)
  if (promotion && typeof promotion === 'object' && !Array.isArray(promotion) && Object.keys(promotion).length > 0 && typeof (promotion as Record<string, unknown>).valid_to !== 'string') {
    throw new DomainError('PROMOTION_VALIDITY_REQUIRED', '促销信息必须包含 valid_to 有效期，避免过期价格进入正式素材', 409)
  }
  const placement = typeof params.placement === 'string' && params.placement.trim() ? params.placement.trim() : assetType === 'banner' ? '店铺首页移动端首屏' : assetType === 'ad' ? '信息流商品广告位' : '商品详情页主图视频'
  const goal = typeof params.goal === 'string' && params.goal.trim() ? params.goal.trim() : '清晰传达已确认商品价值并引导查看商品'
  const audience = typeof params.audience === 'string' && params.audience.trim() ? params.audience.trim() : '以已确认品牌人群为准，未提供时不擅自推断'
  const textDensity = typeof params.text_density === 'string' ? params.text_density : 'title_and_subtitle'
  const dimensionsValue = dimensions ?? (assetType === 'video_storyboard' ? { ratio: '9:16', resolution: '1080x1920' } : assetType === 'banner' ? { ratio: '3:1', resolution: '1200x400' } : { ratio: '1:1', resolution: '1080x1080' })
  const base = { id: `brief_${createHash('sha256').update(canonicalJson({ workspaceId, productId: product.id, assetType, platform, placement, skuIds, promotion })).digest('hex').slice(0, 16)}`, version: 1, workspaceId, productId: product.id, platform, assetType, placement, goal, audience, dimensions: dimensionsValue, textDensity, skuIds, ...(promotion ? { promotion } : {}), factSnapshot: { productVersion: product.version ?? 1, title: product.title, category: product.category, skuIds, source: product.source }, protectedAreas: ['商品本体结构、颜色、材质、Logo/印花、认证标识和 SKU 对应关系'], externallyUnverified: ['真实渲染效果', '尺寸/清晰度', '平台最终审核', ...(assetType === 'ad' ? ['投放效果与预算'] : [])], renderable: false }
  if (assetType === 'banner') return { ...base, layout: { hierarchy: ['商品真实图', '主标题', '核心卖点', 'CTA'], modules: ['品牌区', '主推商品区', '卖点/优惠区', '行动入口'], safeArea: '四边至少保留 5% 安全区', multiSize: true, productBinding: skuIds.map(skuId => ({ skuId, role: '主推商品/SKU' })) } }
  if (assetType === 'ad') return { ...base, matrix: ['主标题+单卖点', '场景利益点', '事实参数+CTA'].map((angle, index) => ({ id: `variant_${index + 1}`, angle, copyScope: '仅使用已确认事实和已提供促销', visual: '真实商品图为主体，背景和装饰可后续制作', dimensions: dimensionsValue })), restrictions: ['不自动上传、不自动投放', '不得使用无证据功效、绝对化或虚假稀缺表达'] }
  const duration = typeof params.duration_seconds === 'string' && /^\d+$/.test(params.duration_seconds) ? Math.min(60, Math.max(3, Number(params.duration_seconds))) : 15
  return { ...base, durationSeconds: duration, scenes: [{ seconds: '0-2', purpose: '建立商品与品牌识别', shot: '真实商品全景', narration: '只读商品已确认名称', subtitle: '商品名来自事实快照' }, { seconds: '2-7', purpose: '展示核心卖点', shot: '真实商品细节/材质特写', narration: '逐条引用已确认卖点', subtitle: textDensity === 'none' ? '无字幕版本' : '卖点字幕需逐条对应事实' }, { seconds: '7-12', purpose: '展示使用场景', shot: '已确认使用场景，禁止臆造功效', narration: '场景说明不得扩展商品事实', subtitle: '场景说明' }, { seconds: `12-${duration}`, purpose: '行动号召', shot: '商品与品牌收束', narration: '查看商品详情', subtitle: 'CTA 与平台版位一致' }], audio: { music: '待确认授权音乐', voiceover: '可选，需单独确认文本与授权' }, storyboardConfirmationRequired: true }
}

function escapeXml(value: string) {
  return value.replace(/[<>&'\"]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[character] ?? character))
}

function creativePreview(workspaceId: string, product: import('../../../packages/application/src/service.js').Product, params: JsonObject) {
  const assetType = typeof params.asset_type === 'string' ? params.asset_type : ''
  if (!['banner', 'ad'].includes(assetType)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'creative.preview 只支持 banner 或 ad；视频请先使用 creative.brief 生成分镜', 400)
  const platform = typeof params.platform === 'string' && SUPPORTED_PLATFORMS.includes(params.platform as Platform) ? params.platform : product.platform
  const count = typeof params.count === 'string' && /^\d+$/.test(params.count) ? Math.min(3, Math.max(1, Number(params.count))) : 1
  const density = typeof params.text_density === 'string' ? params.text_density : 'title_and_subtitle'
  const width = assetType === 'banner' ? 1200 : 1080
  const height = assetType === 'banner' ? 400 : 1080
  const title = escapeXml(product.title)
  const subtitle = density === 'none' ? '' : density === 'single_selling_point' ? '已确认商品卖点' : `${escapeXml(product.category ?? '商品')} · 事实可追溯`
  const images = Array.from({ length: count }, (_, index) => {
    const hue = 214 + index * 24
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="bg" x1="0" x2="1"><stop stop-color="#eff6ff"/><stop offset="1" stop-color="#dbeafe"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#bg)"/><rect x="40" y="40" width="${width - 80}" height="${height - 80}" rx="28" fill="#fff" stroke="#bfdbfe" stroke-width="4"/><circle cx="${Math.round(width * 0.7)}" cy="${Math.round(height * 0.48)}" r="${Math.round(Math.min(width, height) * 0.22)}" fill="hsl(${hue} 65% 78%)"/><text x="80" y="110" font-family="Arial, sans-serif" font-size="26" fill="#2563eb">${escapeXml(platform)} · REVIEW PREVIEW</text><text x="80" y="${Math.round(height * 0.62)}" font-family="Arial, sans-serif" font-size="44" font-weight="700" fill="#111827">${title}</text>${subtitle ? `<text x="80" y="${Math.round(height * 0.7)}" font-family="Arial, sans-serif" font-size="26" fill="#475569">${subtitle}</text>` : ''}<text x="80" y="${height - 75}" font-family="Arial, sans-serif" font-size="18" fill="#64748b">AI 预览 · 不代表已渲染、投放或平台审核通过 · ${escapeXml(product.source)}</text></svg>`
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  })
  return { id: `preview_${createHash('sha256').update(`${workspaceId}:${product.id}:${assetType}:${platform}:${density}`).digest('hex').slice(0, 16)}`, productId: product.id, platform, assetType, width, height, images, renderMode: 'deterministic_review_preview', externallyUnverified: ['真实视觉成片质量', '尺寸/清晰度', 'OCR 与平台最终审核', ...(assetType === 'ad' ? ['投放效果与预算'] : [])] }
}

/**
 * Local Codex acceptance only: there is no external platform worker in the
 * fixture LaunchAgent, so leave a durable, explicit simulated submission
 * observation instead of allowing a demo publish job to remain queued forever.
 * Production is deliberately excluded and still requires a real worker and a
 * verifiable platform receipt before it can become published.
 */
function scheduleFixturePublishObservation(job: import('../../../packages/application/src/service.js').PublishJob) {
  if (!fixtureMode || process.env.CONNECTOR_FIXTURE_PUBLISH_AUTO_OBSERVE === 'false') return
  setTimeout(() => {
    void (async () => {
      try {
        const current = service.getPublishJob(job.id)
        if (current.state !== 'queued') return
        const observed = service.recordPublishObservation({
          workspaceId: job.workspaceId,
          publishJobId: job.id,
          status: { found: true, state: 'submitted', requestId: `fixture-request-${job.id}`, simulated: true },
        })
        await persistSnapshot(job.workspaceId, 'task', service.getTask(job.taskId), service.getTask(job.taskId) as unknown as Record<string, unknown>)
        await persistSnapshot(job.workspaceId, 'publish_job', observed, observed as unknown as Record<string, unknown>)
        await persistEvent(job.workspaceId, job.id, 'publish.observation', observed.revision, {
          job_id: job.id,
          task_id: job.taskId,
          source: 'fixture_worker',
          status: 'submitted',
          request_id: observed.requestId,
          simulated: true,
        })
        // A fixture submission has crossed the local API/connector admission
        // boundary. It intentionally remains `submitted` (never claim a real
        // platform success), but it must not hold a distributed execution
        // slot forever while a local demo waits for an external receipt.
        await releaseDistributedJobSlot(job.workspaceId, `publish:${job.idempotencyKey}`)
      } catch {
        // The normal worker/reconciliation path owns production failures. A
        // local demo callback must never crash or take down the API process.
      }
    })()
  }, 50)
}
const DEFAULT_BODY_LIMIT = 1_048_576
// MCP asset uploads follow the PRD's 50 MB per-file limit. Base64 expands the
// payload, so leave headroom for JSON framing while keeping the normal REST
// request limit unchanged.
const MCP_BODY_LIMIT = 70 * 1024 * 1024
const DEFAULT_RATE_LIMIT = 120

const ASSET_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md', '.json', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ai', '.eps'])
const EXECUTABLE_PREFIXES = [
  new Uint8Array([0x4d, 0x5a]), // PE/Windows executable
  new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), // ELF
  new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]), // Mach-O 64-bit
  new Uint8Array([0xfe, 0xed, 0xfa, 0xcf]), // Mach-O 64-bit swapped
]

function hasPrefix(bytes: Uint8Array, prefix: Uint8Array) {
  return bytes.byteLength >= prefix.byteLength && prefix.every((value, index) => bytes[index] === value)
}

/** Validate the cheap, deterministic part of the upload contract before quarantine. */
function validateAssetContentSignature(name: string, mimeType: string, bytes: Uint8Array) {
  const extension = name.toLowerCase().match(/\.[a-z0-9]+$/u)?.[0] ?? ''
  const mime = mimeType.toLowerCase().split(';', 1)[0]!.trim()
  if (!ASSET_EXTENSIONS.has(extension)) throw new DomainError('ASSET_TYPE_UNSUPPORTED', '素材扩展名不在支持范围内；AI/EPS 仅允许存储，不能完整解析', 415)
  if (EXECUTABLE_PREFIXES.some(prefix => hasPrefix(bytes, prefix)) || new TextDecoder().decode(bytes.slice(0, 2)) === '#!') {
    throw new DomainError('ASSET_EXECUTABLE_REJECTED', '素材内容疑似可执行文件，已拒绝进入隔离区', 415)
  }
  const mismatch = (expected: string[]) => expected.length > 0 && !expected.includes(mime)
  if (extension === '.pdf' && !hasPrefix(bytes, new TextEncoder().encode('%PDF-'))) throw new DomainError('ASSET_SIGNATURE_MISMATCH', 'PDF 内容签名与扩展名不匹配', 415)
  if (extension === '.png' && !hasPrefix(bytes, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new DomainError('ASSET_SIGNATURE_MISMATCH', 'PNG 内容签名与扩展名不匹配', 415)
  if (['.jpg', '.jpeg'].includes(extension) && !hasPrefix(bytes, new Uint8Array([0xff, 0xd8, 0xff]))) throw new DomainError('ASSET_SIGNATURE_MISMATCH', 'JPEG 内容签名与扩展名不匹配', 415)
  if (extension === '.webp' && !(hasPrefix(bytes, new TextEncoder().encode('RIFF')) && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP')) throw new DomainError('ASSET_SIGNATURE_MISMATCH', 'WEBP 内容签名与扩展名不匹配', 415)
  if (extension === '.svg' && !/<svg[\s>]/iu.test(new TextDecoder().decode(bytes.slice(0, 4096)))) throw new DomainError('ASSET_SIGNATURE_MISMATCH', 'SVG 内容签名与扩展名不匹配', 415)
  if (['.docx', '.xlsx'].includes(extension) && !hasPrefix(bytes, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))) throw new DomainError('ASSET_SIGNATURE_MISMATCH', 'Office 文档内容签名与扩展名不匹配', 415)
  if (extension === '.pdf' && mismatch(['application/pdf'])) throw new DomainError('ASSET_MIME_MISMATCH', 'PDF MIME 与扩展名不匹配', 415)
  if (['.png'].includes(extension) && mismatch(['image/png'])) throw new DomainError('ASSET_MIME_MISMATCH', 'PNG MIME 与扩展名不匹配', 415)
  if (['.jpg', '.jpeg'].includes(extension) && mismatch(['image/jpeg'])) throw new DomainError('ASSET_MIME_MISMATCH', 'JPEG MIME 与扩展名不匹配', 415)
  if (extension === '.webp' && mismatch(['image/webp'])) throw new DomainError('ASSET_MIME_MISMATCH', 'WEBP MIME 与扩展名不匹配', 415)
  if (extension === '.svg' && mismatch(['image/svg+xml', 'text/xml', 'application/xml'])) throw new DomainError('ASSET_MIME_MISMATCH', 'SVG MIME 与扩展名不匹配', 415)
  if (['.docx'].includes(extension) && mismatch(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])) throw new DomainError('ASSET_MIME_MISMATCH', 'DOCX MIME 与扩展名不匹配', 415)
  if (['.xlsx'].includes(extension) && mismatch(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])) throw new DomainError('ASSET_MIME_MISMATCH', 'XLSX MIME 与扩展名不匹配', 415)
}
const rateBuckets = new Map<string, { windowStartedAt: number; count: number }>()
const metricsStartedAt = process.hrtime.bigint()
const metricRequests = new Map<string, number>()
let metricRequestCount = 0
let metricRequestDurationSeconds = 0
let metricInFlight = 0

function observeHttpMetric(req: IncomingMessage, res: ServerResponse, startedAt: bigint) {
  const key = `${req.method ?? 'UNKNOWN'}:${res.statusCode}`
  metricRequests.set(key, (metricRequests.get(key) ?? 0) + 1)
  metricRequestCount += 1
  metricRequestDurationSeconds += Number(process.hrtime.bigint() - startedAt) / 1_000_000_000
  metricInFlight = Math.max(0, metricInFlight - 1)
}

function prometheusMetrics() {
  const nowMs = Date.now()
  const ageSeconds = (value: string) => Math.max(0, (nowMs - Date.parse(value)) / 1000)
  const stateCounts = new Map<string, number>()
  for (const job of service.syncJobs.values()) stateCounts.set(`sync:${job.state}`, (stateCounts.get(`sync:${job.state}`) ?? 0) + 1)
  for (const job of service.publishJobs.values()) stateCounts.set(`publish:${job.state}`, (stateCounts.get(`publish:${job.state}`) ?? 0) + 1)
  for (const job of service.generationJobs.values()) stateCounts.set(`generation:${job.state}`, (stateCounts.get(`generation:${job.state}`) ?? 0) + 1)
  const oldest = (prefix: string, states: readonly string[]) => Math.max(0, ...[...service.syncJobs.values()].filter(job => prefix === 'sync' && states.includes(job.state)).map(job => ageSeconds(job.updatedAt)), ...[...service.publishJobs.values()].filter(job => prefix === 'publish' && states.includes(job.state)).map(job => ageSeconds(job.createdAt)), ...[...service.generationJobs.values()].filter(job => prefix === 'generation' && states.includes(job.state)).map(job => ageSeconds(job.updatedAt)))
  const lines = [
    '# HELP merchant_http_requests_total Total HTTP requests handled by status code.',
    '# TYPE merchant_http_requests_total counter',
    ...[...metricRequests.entries()].map(([key, value]) => {
      const [method, status] = key.split(':')
      return `merchant_http_requests_total{method="${method}",status="${status}"} ${value}`
    }),
    '# HELP merchant_http_request_duration_seconds_sum Total HTTP request duration in seconds.',
    '# TYPE merchant_http_request_duration_seconds_sum counter',
    `merchant_http_request_duration_seconds_sum ${metricRequestDurationSeconds}`,
    '# HELP merchant_http_request_duration_seconds_count Total HTTP request count used for the duration summary.',
    '# TYPE merchant_http_request_duration_seconds_count counter',
    `merchant_http_request_duration_seconds_count ${metricRequestCount}`,
    '# HELP merchant_http_inflight_requests Current in-flight HTTP requests.',
    '# TYPE merchant_http_inflight_requests gauge',
    `merchant_http_inflight_requests ${metricInFlight}`,
    '# HELP merchant_process_uptime_seconds Process uptime in seconds.',
    '# TYPE merchant_process_uptime_seconds gauge',
    `merchant_process_uptime_seconds ${Number(process.hrtime.bigint() - metricsStartedAt) / 1_000_000_000}`,
    '# HELP merchant_job_state_count Current durable business jobs by queue and state.',
    '# TYPE merchant_job_state_count gauge',
    ...[...stateCounts.entries()].map(([key, value]) => { const [queue, state] = key.split(':'); return `merchant_job_state_count{queue="${queue}",state="${state}"} ${value}` }),
    '# HELP merchant_queue_oldest_job_age_seconds Age of the oldest active job by queue.',
    '# TYPE merchant_queue_oldest_job_age_seconds gauge',
    `merchant_queue_oldest_job_age_seconds{queue="sync"} ${oldest('sync', ['queued', 'running', 'partial'])}`,
    `merchant_queue_oldest_job_age_seconds{queue="publish"} ${oldest('publish', ['prepared', 'confirmed', 'queued', 'submitting', 'reconciling', 'unknown'])}`,
    `merchant_queue_oldest_job_age_seconds{queue="generation"} ${oldest('generation', ['queued', 'running'])}`,
    '# HELP merchant_publish_unknown_age_seconds Age of the oldest unknown publish job.',
    '# TYPE merchant_publish_unknown_age_seconds gauge',
    `merchant_publish_unknown_age_seconds ${oldest('publish', ['unknown'])}`,
  ]
  return `${lines.join('\n')}\n`
}

function header(req: IncomingMessage, name: string) {
  const value = req?.headers?.[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function requestId(req?: IncomingMessage) {
  const supplied = req && header(req, 'x-request-id')
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : `req_${Date.now()}`
}

function send<T>(res: ServerResponse, status: number, workspaceId: string, data: T | null, error: ApiEnvelope<T>['error'] = null, req?: IncomingMessage) {
  const id = requestId(req)
  const envelope: ApiEnvelope<T> = {
    request_id: id,
    trace_id: `trace_${id.replace(/^req_/, '')}` as never,
    workspace_id: workspaceId as never,
    data: error ? null : data,
    warnings: [],
    next_actions: error && isObject(error.details) && Array.isArray(error.details.next_actions) ? error.details.next_actions : [],
    error,
  }
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  const origin = header(req ?? ({} as IncomingMessage), 'origin')
  const configuredOrigins = (process.env.ALLOWED_ORIGINS ?? process.env.ALLOWED_ORIGIN ?? (requiresStrictAuth() ? '' : '*'))
    .split(',').map(value => value.trim()).filter(Boolean)
  const exactOriginAllowed = Boolean(origin && configuredOrigins.includes(origin))
  if (configuredOrigins.includes('*')) res.setHeader('access-control-allow-origin', '*')
  else if (exactOriginAllowed) {
    res.setHeader('access-control-allow-origin', origin!)
    res.setHeader('access-control-allow-credentials', 'true')
    res.setHeader('vary', 'Origin')
  }
  res.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-workspace-id, x-account-id, x-actor-id, x-request-id, x-role, x-rule-approval-token')
  res.setHeader('access-control-allow-methods', 'DELETE,GET,POST,PUT,OPTIONS')
  res.setHeader('access-control-expose-headers', 'x-request-id')
  res.setHeader('x-request-id', id)
  res.end(JSON.stringify(envelope))
}

function wantsOAuthHtml(req: IncomingMessage) {
  return /^\/v1\/oauth\/callback\//u.test(req.url ?? '') && (header(req, 'accept') ?? '').split(',').some(value => value.trim().toLowerCase() === 'text/html')
}

function sendOAuthCallbackPage(res: ServerResponse, status: number, input: { state: 'success' | 'error'; platform: string; storeLabel?: string; syncState?: string; code?: string; message?: string }, req?: IncomingMessage) {
  const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
  const platform = escapeHtml(PLATFORM_LABELS[input.platform as Platform] ?? input.platform)
  const title = input.state === 'success' ? '店铺授权成功' : '店铺授权未完成'
  const heading = input.state === 'success' ? `已连接${platform}` : '授权失败'
  const body = input.state === 'success'
    ? `<p>店铺已安全绑定到大麦工作区。</p><p>状态：${escapeHtml(input.syncState === 'queued' ? '首轮商品同步已排队' : '等待同步配置')}</p><p>请返回 Codex App，刷新店铺状态后选择具体店铺继续。</p>`
    : `<p>${escapeHtml(input.message ?? '授权回调未完成，请返回 Codex App 重试。')}</p><p>请重新发起授权，不要重复使用当前页面参数。</p>`
  const request = req ? requestId(req) : 'oauth-callback'
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
  res.setHeader('cache-control', 'no-store, max-age=0')
  res.setHeader('pragma', 'no-cache')
  res.setHeader('x-request-id', request)
  res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7fb;color:#172033;margin:0;padding:48px 20px}.card{max-width:560px;margin:auto;background:#fff;border:1px solid #dfe5ef;border-radius:16px;padding:32px;box-shadow:0 10px 30px #17203314}h1{margin:0 0 16px;font-size:24px}p{line-height:1.7;color:#526078}.mark{font-size:32px;margin-bottom:12px}</style></head><body><main class="card"><div class="mark">${input.state === 'success' ? '✓' : '!'}</div><h1>${escapeHtml(heading)}</h1>${body}</main></body></html>`)
}

function sendDownload(res: ServerResponse, content: { fileName: string; contentType: string; body: string; binaryBody?: Uint8Array }, req?: IncomingMessage) {
  const id = requestId(req)
  res.statusCode = 200
  res.setHeader('content-type', content.contentType)
  res.setHeader('content-disposition', `attachment; filename="${content.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
  res.setHeader('cache-control', 'no-store, max-age=0')
  res.setHeader('pragma', 'no-cache')
  res.setHeader('vary', 'Authorization')
  res.setHeader('x-request-id', id)
  res.end(content.binaryBody ?? content.body)
}

function sendAssetDownload(res: ServerResponse, asset: { name: string; mimeType: string; sizeBytes: number }, stored: { body: Uint8Array }, req?: IncomingMessage) {
  const id = requestId(req)
  res.statusCode = 200
  res.setHeader('content-type', asset.mimeType)
  res.setHeader('content-length', String(asset.sizeBytes))
  res.setHeader('content-disposition', `inline; filename="${asset.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
  res.setHeader('cache-control', 'private, no-store, max-age=0')
  res.setHeader('pragma', 'no-cache')
  res.setHeader('x-request-id', id)
  res.end(stored.body)
}

function fail(res: ServerResponse, status: number, workspaceId: string, code: string, message: string, req?: IncomingMessage, details?: Readonly<Record<string, unknown>>) {
  return send(res, status, workspaceId, null, { code, message, ...(details ? { details } : {}) }, req)
}

async function body(req: IncomingMessage, requestedLimit = DEFAULT_BODY_LIMIT): Promise<JsonObject> {
  const configuredLimit = Number(process.env.REQUEST_BODY_LIMIT_BYTES ?? requestedLimit)
  const limit = Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : DEFAULT_BODY_LIMIT
  const declaredLength = Number(req.headers['content-length'] ?? 0)
  if (declaredLength > limit) throw new DomainError(ERROR_CODES.REQUEST_BODY_TOO_LARGE, '请求体超过允许大小', 413)
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    received += buffer.length
    if (received > limit) throw new DomainError(ERROR_CODES.REQUEST_BODY_TOO_LARGE, '请求体超过允许大小', 413)
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as JsonObject
  } catch {
    throw new DomainError(ERROR_CODES.INVALID_JSON_BODY, '请求体必须是合法 JSON 对象', 400)
  }
}

async function binaryBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declaredLength = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new DomainError(ERROR_CODES.REQUEST_BODY_TOO_LARGE, '素材请求体超过允许大小', 413)
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    received += buffer.byteLength
    if (received > limit) throw new DomainError(ERROR_CODES.REQUEST_BODY_TOO_LARGE, '素材请求体超过允许大小', 413)
    chunks.push(buffer)
  }
  if (!chunks.length) throw new DomainError('ASSET_BODY_REQUIRED', '素材请求体不能为空', 400)
  return new Uint8Array(Buffer.concat(chunks))
}

function isProduction() { return process.env.NODE_ENV === 'production' }
function providerSucceededButSettlementPending(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; providerSucceeded?: unknown; details?: Record<string, unknown> }
  return candidate.providerSucceeded === true || candidate.details?.provider_succeeded === true || candidate.code === 'MODEL_USAGE_SETTLEMENT_PENDING' || candidate.code === 'MODEL_USAGE_COST_MISSING'
}
function requiresStrictAuth() {
  if (process.env.AUTH_ENFORCEMENT === 'strict') return true
  if (['staging', 'preview', 'production'].includes(process.env.NODE_ENV ?? '')) return true
  if (process.env.AUTH_ENFORCEMENT === 'local') return !['development', 'test'].includes(process.env.NODE_ENV ?? '') && process.env.VITEST !== 'true'
  return process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true'
}

type RequestPrincipal = {
  actorId: string
  workspaces: string[]
  roles: string[]
  issuer?: string
  sessionSubject?: string
  sessionKind?: 'oidc' | 'api_token'
  sessionIssuedAt?: string
  sessionExpiresAt?: string
  mfaVerified?: boolean
  identityId?: string
  sessionId?: string
  identityStatus?: 'active' | 'suspended'
  riskDecision?: 'allow' | 'step_up' | 'block'
  memberRole?: MemberRole
  memberStatus?: MemberStatus
}
const requestPrincipals = new WeakMap<IncomingMessage, RequestPrincipal>()
const requestMemberChecks = new WeakSet<IncomingMessage>()
const workspaceMemberRoles = new Set<MemberRole>(['workspace_owner', 'merchant_admin', 'operator', 'support', 'finance', 'platform_ops'])

function authorizedRoles(principal?: RequestPrincipal) {
  if (!principal?.memberRole) return principal?.roles ?? []
  const capabilityRoles = ['workspace_owner', 'merchant_admin', 'platform_ops'].includes(principal.memberRole)
    ? principal.roles.filter(role => !workspaceMemberRoles.has(role as MemberRole))
    : []
  return [principal.memberRole, ...capabilityRoles]
}

function requestActor(req: IncomingMessage, fallback = 'merchant') {
  const principal = requestPrincipals.get(req)
  return (requiresStrictAuth() ? principal?.actorId : undefined) || header(req, 'x-actor-id')?.trim() || fallback
}

function safeEqual(leftValue: string, rightValue: string) {
  const left = Buffer.from(leftValue)
  const right = Buffer.from(rightValue)
  return left.length === right.length && timingSafeEqual(left, right)
}

function authenticatedSessionHash(rawSessionId: string) {
  const secret = process.env.SESSION_ID_HASH_SECRET?.trim()
  if (!secret) throw new DomainError('SESSION_HASH_SECRET_MISSING', '严格认证环境必须配置独立的会话指纹密钥', 503)
  return createHmac('sha256', secret).update(rawSessionId).digest('hex')
}

async function observeAuthenticatedPrincipal(req: IncomingMessage, principal: RequestPrincipal) {
  if (!requiresStrictAuth() || !principal.issuer || !principal.sessionSubject || !principal.sessionKind || !principal.sessionIssuedAt) return
  await persistenceReady
  const repository = persistence.identities ?? memoryIdentities
  try {
    const snapshot = await repository.observeAuthenticatedSession({
      issuer: principal.issuer,
      externalSubject: principal.actorId,
      sessionHash: authenticatedSessionHash(principal.sessionSubject),
      kind: principal.sessionKind,
      issuedAt: principal.sessionIssuedAt,
      ...(principal.sessionExpiresAt ? { expiresAt: principal.sessionExpiresAt } : {}),
      mfaVerified: principal.mfaVerified === true,
      userAgentHash: header(req, 'user-agent') ? authenticatedSessionHash(`ua:${header(req, 'user-agent')}`) : undefined,
    })
    principal.identityId = snapshot.identity.id
    principal.sessionId = snapshot.session.id
    principal.identityStatus = snapshot.identity.accessStatus
    principal.riskDecision = snapshot.identity.riskDecision
    if (!snapshot.allowed) throw new DomainError(snapshot.denialReason ?? 'IDENTITY_ACCESS_DENIED', '平台身份、风险或会话状态已拒绝本次访问', 403)
  } catch (error) {
    if (error instanceof DomainError) throw error
    if (error instanceof IdentityLifecycleError) throw new DomainError(error.code, '平台身份或会话状态校验失败', 403)
    throw error
  }
}

function mapIdentityLifecycleError(error: unknown): never {
  if (error instanceof DomainError) throw error
  if (error instanceof IdentityLifecycleError) {
    const status = error.code.endsWith('_NOT_FOUND') ? 404 : error.code.includes('REVISION') || error.code.includes('ALREADY') || error.code.includes('IDEMPOTENCY') ? 409 : 400
    throw new DomainError(error.code, '平台身份生命周期操作失败', status)
  }
  throw error
}

function authenticateOidcGateway(req: IncomingMessage): RequestPrincipal {
  const secret = process.env.OIDC_PROXY_SIGNING_SECRET?.trim()
  if (!secret) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, 'OIDC 网关签名密钥未配置', 503)
  const subject = header(req, 'x-oidc-sub')?.trim() ?? ''
  const issuer = header(req, 'x-oidc-issuer')?.trim() ?? ''
  const sessionId = header(req, 'x-oidc-sid')?.trim() ?? ''
  const workspaceId = header(req, 'x-oidc-workspace')?.trim() ?? ''
  const bootstrapRequested = header(req, 'x-workspace-bootstrap') === 'true'
  const roles = (header(req, 'x-oidc-roles') ?? '').split(',').map(value => value.trim()).filter(Boolean).sort()
  const amr = (header(req, 'x-oidc-amr') ?? '').split(',').map(value => value.trim()).filter(Boolean).sort()
  const authTime = header(req, 'x-oidc-auth-time')?.trim() ?? ''
  const sessionExpiresAt = header(req, 'x-oidc-session-expires-at')?.trim() ?? ''
  const timestamp = header(req, 'x-oidc-timestamp')?.trim() ?? ''
  const signature = header(req, 'x-oidc-signature')?.trim() ?? ''
  const timestampSeconds = Number(timestamp)
  const nowSeconds = Math.floor(Date.now() / 1000)
  const authTimeSeconds = Number(authTime)
  const expiresAtSeconds = Number(sessionExpiresAt)
  if (!issuer || !subject || !sessionId || (!workspaceId && !bootstrapRequested) || !/^\d{10}$/.test(timestamp) || !/^\d{10}$/.test(authTime) || !/^\d{10}$/.test(sessionExpiresAt) || !Number.isSafeInteger(timestampSeconds) || !Number.isSafeInteger(authTimeSeconds) || !Number.isSafeInteger(expiresAtSeconds) || authTimeSeconds > nowSeconds + 60 || expiresAtSeconds <= nowSeconds || Math.abs(nowSeconds - timestampSeconds) > 60 || !/^[a-f0-9]{64}$/i.test(signature)) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, 'OIDC 网关身份断言无效、缺少会话字段或已过期', 401)
  const path = (req.url ?? '/').split('?')[0]
  const canonical = [req.method ?? 'GET', path, workspaceId, issuer, subject, sessionId, roles.join(','), amr.join(','), authTime, sessionExpiresAt, timestamp].join('\n')
  const expected = createHmac('sha256', secret).update(canonical).digest('hex')
  if (!safeEqual(expected, signature)) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, 'OIDC 网关身份签名无效', 401)
  const requested = header(req, 'x-workspace-id')?.trim()
  if (requested && requested !== workspaceId) throw new DomainError(ERROR_CODES.FORBIDDEN, '请求工作区与 OIDC 会话工作区不一致', 403)
  return { actorId: subject, workspaces: workspaceId ? [workspaceId] : [], roles, issuer, sessionSubject: sessionId, sessionKind: 'oidc', sessionIssuedAt: new Date(authTimeSeconds * 1000).toISOString(), sessionExpiresAt: new Date(expiresAtSeconds * 1000).toISOString(), mfaVerified: amr.includes('mfa') }
}

/** Production identity boundary: opaque bearer token -> permitted workspaces. */
async function authenticate(req: IncomingMessage) {
  if (!requiresStrictAuth()) {
    requestPrincipals.set(req, {
      actorId: requestActor(req, 'actor_demo'),
      workspaces: [header(req, 'x-workspace-id')?.trim() || 'ws_demo'],
      roles: (header(req, 'x-role') ?? '').split(',').map(value => value.trim()).filter(Boolean),
    })
    return
  }
  // The merchant UI/plugin and the operations console share this API service
  // in the Kubernetes baseline, but intentionally have different identity
  // boundaries. Only the explicitly configured merchant host may use the
  // bearer-token branch; every other production host remains OIDC-only.
  const merchantBearerHostname = process.env.MERCHANT_BEARER_HOSTNAME?.trim().toLowerCase()
  const requestHostname = (header(req, 'host')?.trim().toLowerCase().split(':')[0] ?? '')
  const merchantBearerRequest = Boolean(merchantBearerHostname && requestHostname === merchantBearerHostname)
  if (process.env.OPS_AUTH_MODE === 'oidc' && !merchantBearerRequest) {
    const principal = authenticateOidcGateway(req)
    requestPrincipals.set(req, principal)
    await observeAuthenticatedPrincipal(req, principal)
    return
  }
  const authorization = header(req, 'authorization')?.trim()
  const token = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1]
  if (!token) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '生产请求必须携带有效 Bearer token', 401)
  let grants: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(process.env.API_AUTH_TOKENS ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid grants')
    grants = parsed as Record<string, unknown>
  } catch {
    throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '服务端认证映射未正确配置', 401)
  }
  const matched = Object.keys(grants).find(known => safeEqual(known, token))
  const permitted = matched ? grants[matched] : undefined
  const grant = permitted && typeof permitted === 'object' && !Array.isArray(permitted) ? permitted as Record<string, unknown> : undefined
  const workspaceValues = Array.isArray(permitted) ? permitted : grant?.workspaces
  const workspaces = Array.isArray(workspaceValues) ? workspaceValues.filter((value): value is string => typeof value === 'string') : []
  const roles = Array.isArray(grant?.roles) ? grant.roles.filter((value): value is string => typeof value === 'string') : []
  const actorId = typeof grant?.actor_id === 'string' && grant.actor_id.trim() ? grant.actor_id.trim() : ''
  const requested = header(req, 'x-workspace-id')?.trim()
  const bootstrapRequested = header(req, 'x-workspace-bootstrap') === 'true'
  const wildcardAllowed = process.env.ALLOW_WILDCARD_WORKSPACE_GRANT === 'true'
  if (!matched || (!requested && !bootstrapRequested) || (!requested && bootstrapRequested && grant?.bootstrap !== true) || (requested && (workspaces.includes('*') ? !wildcardAllowed : !workspaces.includes(requested)))) throw new DomainError(ERROR_CODES.FORBIDDEN, 'Bearer token 无权访问该工作区或创建新工作区', 403)
  const principal: RequestPrincipal = { actorId, workspaces, roles, issuer: typeof grant?.issuer === 'string' && grant.issuer.trim() ? grant.issuer.trim() : 'urn:merchant:api-token', sessionSubject: token, sessionKind: 'api_token', sessionIssuedAt: new Date().toISOString(), mfaVerified: false }
  requestPrincipals.set(req, principal)
  await observeAuthenticatedPrincipal(req, principal)
}

function requireRuleAdmin(req: IncomingMessage): RequestPrincipal {
  const principal = requestPrincipals.get(req)
  const roles = authorizedRoles(principal)
  if (!principal || !roles.includes('rules_admin') || !principal.actorId) throw new DomainError(ERROR_CODES.FORBIDDEN, '规则中心写操作需要绑定 actor_id 的 rules_admin 权限', 403)
  const claimedActor = header(req, 'x-actor-id')?.trim()
  if (requiresStrictAuth() && claimedActor && claimedActor !== principal.actorId) throw new DomainError(ERROR_CODES.FORBIDDEN, 'X-Actor-Id 与认证身份不一致', 403)
  return principal
}

function requireOperationsRole(req: IncomingMessage, allowed: readonly string[]) {
  const principal = requestPrincipals.get(req)
  const roles = authorizedRoles(principal)
  if (requiresStrictAuth() && (!principal?.actorId || !roles.some(role => allowed.includes(role)))) throw new DomainError(ERROR_CODES.FORBIDDEN, '该运营操作需要对应的工作区或平台运营权限', 403)
  return principal?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'actor_demo'
}

function isPlatformOperations(req: IncomingMessage) {
  const principal = requestPrincipals.get(req)
  const roles = authorizedRoles(principal)
  return roles.includes('platform_ops')
}

function scopeCommercialRolloutTarget(req: IncomingMessage, currentWorkspaceId: string, targetWorkspaceId?: string) {
  const target = targetWorkspaceId?.trim() || undefined
  if (isPlatformOperations(req)) return target
  if (!target || target !== currentWorkspaceId) throw new DomainError(ERROR_CODES.FORBIDDEN, '普通工作区运营角色只能管理当前工作区灰度配置', 403)
  return target
}

async function enforceActiveWorkspaceMember(req: IncomingMessage, workspaceId: string) {
  if (!requiresStrictAuth() || requestMemberChecks.has(req)) return
  const principal = requestPrincipals.get(req)
  if (!principal?.actorId) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '生产工作区访问必须绑定可识别的成员身份', 401)
  if (!workspaceId) throw new DomainError(ERROR_CODES.FORBIDDEN, '生产工作区访问缺少工作区范围', 403)
  const member = (await (persistence.members ?? memoryMembers).list(workspaceId)).find(item => item.externalSubject === principal.actorId)
  if (!member) throw new DomainError('WORKSPACE_MEMBERSHIP_REQUIRED', '当前身份不是该工作区的有效成员，请由工作区所有者邀请后重试', 403, { workspace_id: workspaceId })
  principal.memberRole = member.role
  principal.memberStatus = member.status
  if (member.status === 'suspended') throw new DomainError('MEMBER_SUSPENDED', '该运营成员已被暂停，当前工作区访问已撤销', 403)
  if (member.status !== 'active') throw new DomainError('MEMBER_NOT_ACTIVE', '该运营成员尚未激活，当前工作区访问未开放', 403)
  if (principal.identityId && member.identityId !== principal.identityId) {
    try { await (persistence.members ?? memoryMembers).bindIdentity({ workspaceId, externalSubject: principal.actorId, identityId: principal.identityId }) }
    catch (error) { if (String(error).includes('MEMBER_IDENTITY_CONFLICT')) throw new DomainError('MEMBER_IDENTITY_CONFLICT', '成员关系已绑定到其他平台身份，访问已拒绝', 403); throw error }
  }
  const gatewayMemberRoles = principal.roles.filter(role => workspaceMemberRoles.has(role as MemberRole))
  if (gatewayMemberRoles.length > 0 && !gatewayMemberRoles.includes(member.role)) throw new DomainError('MEMBER_ROLE_MISMATCH', '身份网关角色与工作区成员角色不一致，访问已拒绝', 403, { member_role: member.role })
  requestMemberChecks.add(req)
}

function hasWorkspaceWideBrandAccess(req: IncomingMessage) {
  const role = requestPrincipals.get(req)?.memberRole
  return role === 'workspace_owner' || role === 'platform_ops'
}

async function enforceBrandAccess(req: IncomingMessage, workspaceId: string, brandId: string, minimumRole: BrandAccessRole = 'viewer') {
  if (!requiresStrictAuth() || hasWorkspaceWideBrandAccess(req)) return
  const principal = requestPrincipals.get(req)
  if (!principal?.actorId) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '品权限校验缺少成员身份', 401)
  const allowed = await (persistence.brandUnits ?? memoryBrandUnits).hasBrandAccess({ workspaceId, brandId, externalSubject: principal.actorId, minimumRole })
  if (!allowed) throw new DomainError('BRAND_ACCESS_REQUIRED', '当前成员没有该品所需权限', 403, { brand_id: brandId, required_role: minimumRole })
}

function campaignTaskProjection(workspaceId: string, item: CampaignItemRow): { state: CampaignItemState; error?: CampaignItemRow['error'] } {
  if (!item.taskId) return { state: 'pending', error: { code: 'TASK_NOT_CREATED', message: '尚未创建商品内容任务', nextAction: 'campaign.batch.generate' } }
  const task = service.tasks.get(item.taskId)
  if (!task || task.workspaceId !== workspaceId) return { state: 'unknown', error: { code: 'TASK_SNAPSHOT_UNAVAILABLE', message: '任务快照暂不可用，需要恢复后继续', nextAction: 'task.resume' } }
  if (task.state === 'draft') return { state: 'blocked', error: { code: 'PRODUCT_FACTS_CONFIRMATION_REQUIRED', message: '请先确认该商品事实', nextAction: 'catalog.facts.confirm' } }
  if (task.state === 'ready_for_direction') return { state: 'manual_attention', error: { code: 'DIRECTION_CONFIRMATION_REQUIRED', message: '请为该商品选择内容方向', nextAction: 'task.select_direction' } }
  if (task.state === 'direction_selected') return { state: 'manual_attention', error: { code: 'PLAN_CONFIRMATION_REQUIRED', message: '请确认该商品的生产方案', nextAction: 'task.plan.confirm' } }
  if (task.state === 'plan_confirmed') return { state: 'generating', error: { code: 'CONTENT_GENERATION_READY', message: '生产方案已确认，可以生成内容', nextAction: 'content.generate' } }
  if (task.state === 'review_required') return { state: 'review_required', error: { code: 'HUMAN_REVIEW_REQUIRED', message: '内容已生成，等待规则审核和人工批准', nextAction: 'content.review' } }
  if (task.state === 'approved') return { state: 'approved', error: { code: 'PUBLISH_PREPARATION_READY', message: '内容已批准，可以加入批量发布预览', nextAction: 'publish.batch.prepare' } }
  if (task.state === 'publish_prepared') return { state: 'approved', error: { code: 'PUBLISH_CONFIRMATION_REQUIRED', message: '发布预览已冻结，等待逐项确认', nextAction: 'publish.batch.confirm' } }
  if (task.state === 'publishing') {
    const publish = service.listPublishJobs(workspaceId).filter(job => job.taskId === task.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
    if (publish?.state === 'published' || publish?.remoteState === 'published') return { state: 'published' }
    if (publish?.state === 'rejected' || publish?.remoteState === 'rejected') return { state: 'failed', error: { code: publish.rejection?.rawCode ?? 'PLATFORM_REJECTED', message: publish.rejection?.message ?? '平台驳回了该商品', nextAction: 'ops.marketing.revision.create' } }
    if (publish?.state === 'manual_attention') return { state: 'manual_attention', error: { code: 'PUBLISH_MANUAL_ATTENTION', message: '发布任务需要运营处理', nextAction: 'publish.get' } }
    if (publish?.state === 'unknown') return { state: 'unknown', error: { code: 'PUBLISH_STATE_UNKNOWN', message: '平台发布状态未知，等待查单', nextAction: 'publish.get' } }
    return { state: 'publishing', error: { code: 'PUBLISH_IN_PROGRESS', message: '平台正在处理发布任务', nextAction: 'publish.get' } }
  }
  if (task.state === 'delivered') return { state: 'published' }
  return { state: 'failed', error: { code: 'TASK_FAILED_RECOVERABLE', message: '商品任务失败，可修复后重试', nextAction: 'task.resume' } }
}

function campaignAggregateState(states: CampaignItemState[]): CampaignBatchState {
  if (states.length && states.every(state => state === 'published')) return 'completed'
  if (states.some(state => state === 'publishing')) return 'publishing'
  if (states.some(state => state === 'unknown')) return 'unknown'
  if (states.some(state => state === 'manual_attention' || state === 'blocked')) return 'manual_attention'
  if (states.some(state => state === 'review_required' || state === 'approved')) return 'review_required'
  if (states.some(state => state === 'generating')) return 'generating'
  if (states.some(state => state === 'failed') && states.some(state => state === 'published')) return 'partial'
  if (states.some(state => state === 'failed')) return 'failed'
  return 'draft'
}

async function refreshCampaignProgress(campaign: CampaignBatchRow) {
  if (!campaign.items?.length) return campaign
  const items = campaign.items.map(item => ({ ...item, ...campaignTaskProjection(campaign.workspaceId, item) }))
  const state = campaignAggregateState(items.map(item => item.state))
  const changed = state !== campaign.state || items.some((item, index) => item.state !== campaign.items![index]!.state || JSON.stringify(item.error ?? null) !== JSON.stringify(campaign.items![index]!.error ?? null))
  if (!changed) return campaign
  return await (persistence.brandUnits ?? memoryBrandUnits).updateCampaignProgress({ workspaceId: campaign.workspaceId, id: campaign.id, state, items: items.map(item => ({ id: item.id, ...(item.taskId ? { taskId: item.taskId } : {}), state: item.state, ...(item.error ? { error: item.error } : {}) })) })
}

function campaignWorkflow(campaign: CampaignBatchRow) {
  const items = (campaign.items ?? []).map(item => ({ item_id: item.id, product_id: item.productId, platform: item.platform, account_id: item.accountId, task_id: item.taskId ?? null, state: item.state, blocker: item.error ?? null, next_action: item.error?.nextAction ?? (item.state === 'published' ? null : 'campaign.batch.get') }))
  return { items, summary: { total: items.length, planned: items.filter(item => item.state === 'pending').length, published: items.filter(item => item.state === 'published').length, blocked: items.filter(item => ['blocked', 'failed', 'unknown', 'manual_attention'].includes(item.state)).length, review_required: items.filter(item => ['review_required', 'approved'].includes(item.state)).length, in_progress: items.filter(item => ['generating', 'publishing'].includes(item.state)).length } }
}

async function accessibleBrandNavigation(req: IncomingMessage, workspaceId: string) {
  const repository = persistence.brandUnits ?? memoryBrandUnits
  const brands = await repository.listBrands({ workspaceId })
  const visible = !requiresStrictAuth() || hasWorkspaceWideBrandAccess(req)
    ? brands
    : (await Promise.all(brands.map(async brand => await repository.hasBrandAccess({ workspaceId, brandId: brand.id, externalSubject: requestPrincipals.get(req)!.actorId }) ? brand : undefined))).filter((brand): brand is typeof brands[number] => Boolean(brand))
  return visible.map(brand => ({
    id: brand.id,
    title: brand.name,
    action: { method: 'brand-unit.listing.list', arguments: { brand_id: brand.id } },
    platforms: Object.entries(brand.storeBindings.reduce<Record<string, typeof brand.storeBindings>>((groups, store) => { (groups[store.platform] ??= []).push(store); return groups }, {})).map(([platform, stores]) => ({
      id: `${brand.id}:${platform}`,
      platform,
      title: PLATFORM_LABELS[platform as Platform] ?? platform,
      stores: stores.map(store => ({ id: `${brand.id}:${store.platform}:${store.accountId}`, accountId: store.accountId, action: { method: 'brand-unit.listing.list', arguments: { brand_id: brand.id, platform: store.platform, account_id: store.accountId } } })),
    })),
  }))
}

async function requireEnabledPlatform(workspaceId: string, platform: Platform) {
  if (!COMMERCIAL_PLATFORMS.includes(platform as CommercialPlatform)) return
  const setting = (await (persistence.commercial ?? memoryCommercial).listPlatformSettings(workspaceId)).find(item => item.platform === platform)
  if (setting?.enabled === false) throw new DomainError('PLATFORM_DISABLED', `${platform} 平台已被运营后台关闭，不能创建新任务或发布`, 409)
}

async function storeCapacity(workspaceId: string) {
  const subscription = await (persistence.subscriptions ?? memorySubscriptions).get(workspaceId)
  const used = service.listPlatformAccounts(workspaceId).filter(account => account.tokenState !== 'revoked').length
  const included = Math.max(0, subscription.includedStores)
  return { used, included, remaining: Math.max(0, included - used), planCode: subscription.planCode, planName: subscription.planName }
}

function commercialActionCards() {
  return [
    {
      method: 'subscription.change',
      label: '升级套餐增加店铺数',
      required_inputs: ['to_plan_code', 'billing_cycle', 'channel', 'reason', 'idempotency_key'],
      input_schema: { type: 'object', properties: { to_plan_code: { type: 'string' }, billing_cycle: { type: 'string', enum: ['monthly', 'annual'] }, channel: { type: 'string', enum: ['alipay', 'wechat'] }, reason: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['to_plan_code', 'billing_cycle', 'channel', 'reason', 'idempotency_key'] },
      confirmation: 'interactive_confirmation',
    },
    {
      method: 'ops.commercial.addons.list',
      label: '查看店铺加购包',
      arguments: {},
      confirmation: 'none',
    },
  ]
}

function billingActionCards() {
  return [
    {
      method: 'billing.recharge.create',
      label: '创建充值订单',
      required_inputs: ['channel', 'amount_cny', 'idempotency_key'],
      input_schema: { type: 'object', properties: { channel: { type: 'string', enum: ['alipay', 'wechat'] }, amount_cny: { type: 'string', pattern: '^[0-9]+(\\.[0-9]{1,2})?$' }, idempotency_key: { type: 'string' } }, required: ['channel', 'amount_cny', 'idempotency_key'] },
      confirmation: 'interactive_confirmation',
    },
    {
      method: 'subscription.change',
      label: '升级套餐',
      required_inputs: ['to_plan_code', 'billing_cycle', 'channel', 'reason', 'idempotency_key'],
      input_schema: { type: 'object', properties: { to_plan_code: { type: 'string' }, billing_cycle: { type: 'string', enum: ['monthly', 'annual'] }, channel: { type: 'string', enum: ['alipay', 'wechat'] }, reason: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['to_plan_code', 'billing_cycle', 'channel', 'reason', 'idempotency_key'] },
      confirmation: 'interactive_confirmation',
    },
  ]
}

async function requireStoreCapacity(workspaceId: string) {
  // Fixture UX can deliberately exercise multiple stores without a paid
  // subscription. Production, and explicit capacity tests, enforce the plan.
  if (!isProduction() && process.env.ENFORCE_STORE_CAPACITY !== 'true') return
  const capacity = await storeCapacity(workspaceId)
  if (capacity.used >= capacity.included) throw new DomainError('STORE_QUOTA_EXCEEDED', `当前套餐已使用 ${capacity.used}/${capacity.included} 家店铺`, 402, { ...capacity, next_actions: ['升级套餐增加店铺数', '购买店铺加购包'], action_cards: commercialActionCards() })
}

function parseApprovalGrant(req: IncomingMessage, workspaceId: string, actorId: string, input: JsonObject) {
  const approvalValue = input.approval
  if (!approvalValue || typeof approvalValue !== 'object' || Array.isArray(approvalValue)) {
    throw new DomainError('RULE_APPROVAL_REQUIRED', '激活规则必须携带审批证据', 409)
  }
  const approval = approvalValue as JsonObject
  const approvalRef = required(approval, 'approval_ref')
  const approvedAt = required(approval, 'approved_at')
  if (!Number.isFinite(Date.parse(approvedAt))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'approved_at 必须是合法时间', 400)
  let approvedBy = required(approval, 'approved_by')
  if (requiresStrictAuth()) {
    const token = header(req, 'x-rule-approval-token')?.trim()
    if (!token) throw new DomainError('RULE_APPROVAL_REQUIRED', '严格认证环境的激活请求必须携带 X-Rule-Approval-Token', 409)
    let grants: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(process.env.RULE_APPROVAL_TOKENS ?? '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
      grants = parsed as Record<string, unknown>
    } catch { throw new DomainError('RULE_APPROVAL_CONFIG_INVALID', '规则审批令牌配置无效', 503) }
    const matched = Object.keys(grants).find(known => safeEqual(known, token))
    const grant = matched && grants[matched] && typeof grants[matched] === 'object' && !Array.isArray(grants[matched]) ? grants[matched] as Record<string, unknown> : undefined
    const grantWorkspaces = Array.isArray(grant?.workspaces) ? grant.workspaces.filter((value): value is string => typeof value === 'string') : []
    const grantActor = typeof grant?.actor_id === 'string' ? grant.actor_id.trim() : ''
    if (!grantActor || !grantWorkspaces.includes(workspaceId) || grantActor !== approvedBy) throw new DomainError('RULE_APPROVAL_INVALID', '规则审批令牌无效或不属于当前工作区/审批人', 403)
    approvedBy = grantActor
  }
  if (approvedBy === actorId) throw new DomainError('RULE_SEPARATION_OF_DUTIES_REQUIRED', '创建人与审批人必须分离', 409)
  return { approvalRef, approvedAt: new Date(approvedAt).toISOString(), approvedBy }
}

function objectField(input: JsonObject, key: string): Record<string, unknown> {
  const value = input[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是 JSON 对象`, 400)
  return value as Record<string, unknown>
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  return JSON.stringify(value)
}

function fixturePlatformEnabled(_platform: Platform) {
  // The disposable fixture environment intentionally exposes an independent
  // fake connector for every supported platform so the six-platform UI flow
  // can be exercised without mistaking it for production readiness.
  return fixtureMode
}

function platformConnectorConfigured(platform: Platform) {
  return fixturePlatformEnabled(platform) || connectorRuntime.canRead(platform)
}

function platformAuthorizationConfigured(platform: Platform) {
  return fixturePlatformEnabled(platform) || connectorRuntime.isOAuthConfigured(platform)
}

function fixtureAccountId(workspaceId: string, platform: Platform) {
  return `fixture_${workspaceId}_${platform}`
}

function defaultFixtureAccountId(workspaceId: string, platform: Platform) {
  const accounts = service.listPlatformAccounts(workspaceId).filter(account => account.platform === platform)
  const existing = accounts.find(account => account.tokenState === 'connected') ?? accounts.find(account => account.tokenState !== 'revoked')
  return existing?.id ?? fixtureAccountId(workspaceId, platform)
}

function connectedPlatformAccountId(workspaceId: string, platform: Platform) {
  return service.listPlatformAccounts(workspaceId).find(account => account.platform === platform && account.tokenState === 'connected')?.id
}

function requireActivePlatformAccount(workspaceId: string, accountId: string, platform: Platform) {
  try {
    return service.getActivePlatformAccount(workspaceId, accountId, platform)
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PLATFORM_ACCOUNT_NOT_FOUND') {
      throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', `请先在 Codex 中完成${platform}店铺授权，再同步商品`, 400)
    }
    throw error
  }
}

function resolveTaskAccountId(_workspaceId: string, _platform: Platform, requested?: string) {
  // Never select the first connected account. Product-bound context is
  // enforced by the domain service; unbound products remain unbound until the
  // merchant explicitly selects a platform + accountId pair.
  return requested?.trim()
}

function resolveProductTaskAccount(workspaceId: string, platform: Platform, productId: string, requested?: string) {
  const explicit = resolveTaskAccountId(workspaceId, platform, requested)
  const product = service.products.get(productId)
  if (product?.workspaceId === workspaceId && product.platform === platform && product.accountId) return product.accountId
  return explicit
}

function requireProductionTaskStore(platform: Platform, accountId: string | undefined) {
  if (isProduction() && !accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', `生产任务必须绑定已授权的${platform}店铺`, 400, { platform, next_action: '选择 platform + account_id 后重新创建任务' })
}

function requireProductionRequestStores(workspaceId: string, understanding: ReturnType<MerchantService['understandTaskRequest']>) {
  if (!isProduction()) return
  for (const child of understanding.executionPlan.childTasks) {
    const productId = child.candidateProductIds[0]
    const product = productId ? service.products.get(productId) : undefined
    requireProductionTaskStore(child.platform, product?.workspaceId === workspaceId && product.platform === child.platform ? product.accountId : undefined)
  }
}

function platformAccessFlags(platform: Platform, account: { tokenState: string } | undefined) {
  const active = account?.tokenState === 'connected'
  return {
    readEnabled: active && (fixturePlatformEnabled(platform) || platformConnectorConfigured(platform)),
    writeEnabled: active && platformWriteReady(platform),
  }
}

function platformWriteReady(platform: Platform) {
  return platformWriteAllowed({ production: isProduction(), fixtureMode, connectorConfigured: platformConnectorConfigured(platform), pluginWriteEnabled: process.env.PLUGIN_WRITE_ENABLED === 'true', canaryReady: isProductionCanaryReady(connectorRuntime.capabilityEvidence[platform], platform) })
}

function workspaceConnectorReadiness(platform: Platform) {
  const media = connectorRuntime.mediaUploadReadiness(platform)
  const mediaUpload = {
    ...media,
    ...(media.ready ? {} : { reason: !media.configured ? '主图/副图上传路径或回执映射未配置' : !media.evidence ? '主图/副图上传证据未通过门禁' : '主图/副图媒体连接器未就绪' }),
  }
  if (fixturePlatformEnabled(platform)) {
    return { platform, ready: true, reasons: ['FIXTURE_MODE'], verifiedCapabilities: [], mediaUpload: { configured: false, evidence: false, ready: false, reason: 'fixture 模式不计入真实媒体上传证据' } }
  }
  return { ...connectorRuntime.readiness[platform], mediaUpload }
}

function configuredEnv(...keys: string[]) {
  return keys.some(key => Boolean(process.env[key]?.trim()))
}

function requirePlatformModelCostGate(kind: 'text' | 'image' | 'image_edit' | 'ocr' | 'video') {
  if (!isProduction()) return
  const relayGate = evaluatePlatformModelRelayGate(process.env)
  if (!relayGate.ready) throw new DomainError('MODEL_RELAY_NOT_CONFIGURED', `生产环境必须配置平台模型中转站：${relayGate.reasons.join(', ')}`, 503, { reasons: relayGate.reasons })
  const modelGate = evaluatePlatformModelGate(process.env, kind)
  const costGate = evaluatePlatformModelCostGate(process.env)
  const costEvidenceReady = process.env.MODEL_RELAY_COST_EVIDENCE === 'true'
  if (!modelGate.ready || !costGate.ready || !costEvidenceReady) {
    const labels = { text: '文案', image: '图片', image_edit: '图片编辑', ocr: '图片解析', video: '视频' } as const
    throw new DomainError('MODEL_COST_GATE_BLOCKED', `平台${labels[kind]}模型未通过成本与配额门禁；需配置 HTTPS 中转站、模型、RPM、TPM、每日人民币成本上限和真实成本回执证据`, 503)
  }
}

function lifecycleDiagnostics() {
  if (!isProduction()) return { state: 'not_required' as const, configured: true, objectVersioning: true, retentionDays: 90, quarantineRetentionDays: 7, cleanRetentionDays: 30, deletionGraceDays: 7, backupRetentionDays: 30, reasons: [] as string[] }
  const numberValue = (key: string, fallback: number) => { const value = Number(process.env[key] ?? fallback); return Number.isInteger(value) ? value : -1 }
  const retentionDays = numberValue('DATA_RETENTION_DAYS', -1)
  const quarantineRetentionDays = numberValue('ASSET_QUARANTINE_RETENTION_DAYS', -1)
  const cleanRetentionDays = numberValue('ASSET_CLEAN_RETENTION_DAYS', -1)
  const deletionGraceDays = numberValue('DELETION_REQUEST_GRACE_DAYS', -1)
  const backupRetentionDays = numberValue('BACKUP_RETENTION_DAYS', -1)
  const objectVersioning = process.env.OBJECT_STORAGE_VERSIONING === 'true'
  const reasons: string[] = []
  if (retentionDays < 90) reasons.push('DATA_RETENTION_DAYS must be at least 90')
  if (quarantineRetentionDays < 7) reasons.push('ASSET_QUARANTINE_RETENTION_DAYS must be at least 7')
  if (cleanRetentionDays < 30) reasons.push('ASSET_CLEAN_RETENTION_DAYS must be at least 30')
  if (deletionGraceDays < 7 || deletionGraceDays > 30) reasons.push('DELETION_REQUEST_GRACE_DAYS must be between 7 and 30')
  if (backupRetentionDays < 30) reasons.push('BACKUP_RETENTION_DAYS must be at least 30')
  if (!objectVersioning) reasons.push('OBJECT_STORAGE_VERSIONING must be true')
  if (!configuredEnv('LIFECYCLE_POLICY_REF')) reasons.push('LIFECYCLE_POLICY_REF is not configured')
  if (!configuredEnv('ALERT_CHANNEL_SECRET_REF')) reasons.push('ALERT_CHANNEL_SECRET_REF is not configured')
  return { state: reasons.length ? 'blocked' as const : 'ready' as const, configured: reasons.length === 0, objectVersioning, retentionDays, quarantineRetentionDays, cleanRetentionDays, deletionGraceDays, backupRetentionDays, reasons }
}

type EvidenceReadiness = {
  state: 'not_required' | 'blocked' | 'ready'
  configured: boolean
  sourceRef?: string
  schemaVersion?: string
  releaseId?: string
  environment?: string
  verifiedBy?: string
  verifiedAt?: string
  profile?: string
  reasons: string[]
}

function evidenceReadiness(kind: 'capability' | 'capacity'): EvidenceReadiness {
  const pathKey = kind === 'capability' ? 'CAPABILITY_EVIDENCE_PATH' : 'CAPACITY_REPORT_PATH'
  const sourceRef = process.env[pathKey]?.trim()
  const base: EvidenceReadiness = { state: isProduction() ? 'blocked' : 'not_required', configured: false, ...(sourceRef ? { sourceRef: 'configured' } : {}), reasons: [] }
  if (!sourceRef) {
    base.reasons.push(`${pathKey} is not configured`)
    return base
  }
  let document: unknown
  try { document = JSON.parse(readFileSync(sourceRef, 'utf8')) } catch { base.reasons.push(`${pathKey} cannot be read`) ; return base }
  if (!document || typeof document !== 'object' || Array.isArray(document)) { base.reasons.push('evidence document must be a JSON object'); return base }
  const value = document as Record<string, any>
  base.schemaVersion = typeof value.schema_version === 'string' ? value.schema_version : undefined
  base.releaseId = typeof value.release_id === 'string' ? value.release_id : undefined
  base.environment = typeof value.environment === 'string' ? value.environment : undefined
  base.profile = typeof value.profile === 'string' ? value.profile : undefined
  base.verifiedBy = typeof value.sign_off?.verified_by === 'string' ? value.sign_off.verified_by : undefined
  base.verifiedAt = typeof value.sign_off?.verified_at === 'string' ? value.sign_off.verified_at : (typeof value.generated_at === 'string' ? value.generated_at : undefined)
  if (kind === 'capability') {
    const errors = validatePlatformCapabilityEvidence(document, { requireCanary: true, expectedReleaseId: process.env.RELEASE_ID?.trim() || undefined })
    base.reasons.push(...errors)
    if (value.environment !== 'preproduction' && value.environment !== 'production') base.reasons.push('environment must be preproduction or production')
  } else {
    if (value.schema_version !== '1') base.reasons.push('schema_version must be 1')
    if (value.status !== 'pass') base.reasons.push('status must be pass')
    if (value.cloud_gate !== true) base.reasons.push('cloud_gate must be true')
    if (!['preproduction', 'production'].includes(value.environment)) base.reasons.push('environment must be preproduction or production')
    if (value.platform_mock_ratio !== 0 || value.model_mock_ratio !== 0) base.reasons.push('platform/model mock ratio must be 0')
    if (!value.sign_off?.verified_by || !value.sign_off?.verified_at) base.reasons.push('sign_off is incomplete')
  }
  base.configured = base.reasons.length === 0
  base.state = base.configured ? 'ready' : 'blocked'
  return base
}

/** A safe, secret-free setup report for the Codex App. It tells the operator
 * what can run locally and what still needs real credentials/infrastructure,
 * without echoing tokens, keys, endpoints, or bucket names. */
function setupDiagnostics() {
  const production = isProduction()
  const relayGate = evaluatePlatformModelRelayGate(process.env)
  const paymentReadiness = paymentProviderReadiness()
  const contentProviderConfigured = evaluatePlatformModelGate(process.env, 'text').ready
  const imageProviderConfigured = evaluatePlatformModelGate(process.env, 'image').ready
  const imageEditModelGate = evaluatePlatformModelGate(process.env, 'image_edit')
  const ocrModelGate = evaluatePlatformModelGate(process.env, 'ocr')
  const videoModelGate = evaluatePlatformModelGate(process.env, 'video')
  const imageFactsConfigured = Boolean(imageFactsExtractor) && ocrModelGate.ready
  const imageEditProviderConfigured = Boolean(imageEditGenerator) && imageEditModelGate.ready
  const videoProviderConfigured = Boolean(videoGenerator) && videoModelGate.ready
  const modelCostGateConfigured = evaluatePlatformModelCostGate(process.env).ready && process.env.MODEL_RELAY_COST_EVIDENCE === 'true'
  const vaultConfigured = connectorRuntime.credentialProviderConfigured && !fixtureMode
  const objectStorageConfigured = production
    ? configuredEnv('ASSET_STORAGE_BUCKET') && configuredEnv('ASSET_STORAGE_REGION') && configuredEnv('ASSET_STORAGE_ENDPOINT') && configuredEnv('ASSET_STORAGE_KMS_KEY_ID')
    : true
  const dataLifecycle = lifecycleDiagnostics()
  const capabilityEvidence = evidenceReadiness('capability')
  const capacityEvidence = evidenceReadiness('capacity')
  const platformDiagnostics = Object.fromEntries(SUPPORTED_PLATFORMS.map(platform => {
    const readiness = connectorRuntime.readiness[platform]
    return [platform, {
      mode: fixturePlatformEnabled(platform) ? 'fixture' : connectorRuntime.isHttpConfigured(platform) ? 'official_api' : connectorRuntime.isOAuthConfigured(platform) ? 'oauth_only' : 'not_configured',
      oauthConfigured: connectorRuntime.isOAuthConfigured(platform),
      httpConfigured: connectorRuntime.isHttpConfigured(platform),
      credentialProviderConfigured: vaultConfigured,
      ready: fixturePlatformEnabled(platform) || connectorRuntime.canRead(platform),
      reasons: fixturePlatformEnabled(platform) ? [] : readiness.reasons,
    }]
  }))
  const nextActions: string[] = []
  if (fixtureMode) nextActions.push('当前是 Codex 本地 fixture 模式；如要操作真实店铺，请关闭 CONNECTOR_FIXTURE_MODE 并配置六个平台的官方 OAuth、API endpoint、scope 和回调地址；小红书/抖音在 readiness 完成前保持 fixture/API 或只读')
  if (production && !relayGate.ready) nextActions.push('配置 HTTPS MODEL_RELAY_BASE_URL 和平台托管的 MODEL_RELAY_API_KEY；生产模型 token 只允许经自有中转站转发')
  if (!contentProviderConfigured) nextActions.push('配置平台模型中转站、AI_MODEL 和平台密钥后，启用真实商品文案生成；当前文案生成使用本地规则/fixture 回退')
  if (!imageProviderConfigured) nextActions.push('配置平台模型中转站、IMAGE_MODEL 和平台密钥后，启用真实商品主图生成；当前主图生成使用本地规则/fixture 回退')
  if (!imageEditProviderConfigured) nextActions.push('配置 IMAGE_EDIT_MODEL（或复用 IMAGE_MODEL）和图片编辑中转 provider 后启用局部图片编辑；未配置时保留原图并阻断编辑请求')
  if (!imageFactsConfigured) nextActions.push('配置平台模型中转站、MODEL_RELAY_API_KEY 和 OCR_MODEL 后启用图片 OCR 候选；未配置时继续要求商家人工确认图片事实')
  if (!videoProviderConfigured) nextActions.push('配置平台模型中转站、MODEL_RELAY_API_KEY、VIDEO_MODEL 和视频 provider 后启用视频渲染；未配置时只能生成无渲染分镜')
  if (!modelCostGateConfigured) nextActions.push('配置平台模型 RPM、TPM 和每日人民币成本上限；成本门禁未通过时生产模型请求保持阻断')
  if (production && !paymentReadiness.ready) nextActions.push('配置支付宝/微信服务端 checkout provider、商户号、回调验签、对账和退款能力：' + paymentReadiness.reasons.join('、'))
  if (!vaultConfigured) nextActions.push('配置 VAULT_ADDR 和 VAULT_TOKEN（或接入外部凭据服务），让 Codex 安全读取商家授权凭据；不要把平台 token 放进插件参数')
  if (!objectStorageConfigured) nextActions.push('配置生产对象存储 bucket、region、HTTPS endpoint 和 KMS key，素材上传才可切换到云端持久化')
  if (!dataLifecycle.configured) nextActions.push('补齐生产数据生命周期、对象版本化和告警通道配置；缺少删除与告警门禁时禁止接收真实商家数据')
  if (!capabilityEvidence.configured) nextActions.push('运营后台未检测到通过发布门禁的平台 capability 证据（六平台范围）；example、fixture 或 test_e2e 证据不能标记生产可写，社交平台未就绪时必须保持 fixture/API 或只读')
  if (!capacityEvidence.configured) nextActions.push('运营后台未检测到通过真实云门禁的容量报告；必须绑定 release、profile、云环境、零 mock 和签署人')
  if (!production) nextActions.push('当前不是生产模式；上线前还需完成真实平台 canary、TLS/DNS/WAF、备份恢复、监控告警和容量压测')
  return {
    mode: production ? 'production' : fixtureMode ? 'fixture' : 'local',
    ai: { ownership: 'platform', userKeyRequired: false, relay: { configured: relayGate.ready, host: relayGate.endpointHost ?? null }, contentGeneration: contentProviderConfigured ? 'configured' : fixtureMode ? 'fixture_fallback' : 'not_configured', imageGeneration: imageProviderConfigured ? 'configured' : fixtureMode ? 'fixture_fallback' : 'not_configured', imageEditing: imageEditProviderConfigured ? 'configured' : 'blocked', imageFacts: imageFactsConfigured ? 'configured' : 'manual_fallback', videoRendering: videoProviderConfigured ? 'configured' : 'storyboard_only', costGate: modelCostGateConfigured ? 'ready' : 'blocked' },
    modelReadiness: {
      text: { ...evaluatePlatformModelGate(process.env, 'text'), providerConfigured: contentProviderConfigured },
      image: { ...evaluatePlatformModelGate(process.env, 'image'), providerConfigured: imageProviderConfigured },
      image_edit: { ...imageEditModelGate, providerConfigured: imageEditProviderConfigured },
      ocr: { ...ocrModelGate, providerConfigured: imageFactsConfigured },
      video: { ...videoModelGate, providerConfigured: videoProviderConfigured },
    },
    objectStorage: { configured: objectStorageConfigured, mode: production ? 's3_compatible' : 'local' },
    alertNotifications: alertNotificationReadiness(),
    dataLifecycle,
    productionEvidence: { capability: capabilityEvidence, capacity: capacityEvidence },
    credentialProvider: { configured: vaultConfigured, mode: fixtureMode ? 'fixture' : vaultConfigured ? 'vault_or_external' : 'none' },
    platforms: platformDiagnostics,
    payment: { mode: process.env.PAYMENT_MODE === 'provider' ? 'provider' : 'fixture', configured: process.env.PAYMENT_MODE === 'provider' && paymentReadiness.ready, reasons: paymentReadiness.reasons },
    productionGate: production && !fixtureMode && relayGate.ready && paymentReadiness.ready && Object.values(platformDiagnostics).every(item => item.ready) && contentProviderConfigured && imageProviderConfigured && imageEditProviderConfigured && imageFactsConfigured && videoProviderConfigured && modelCostGateConfigured && objectStorageConfigured && vaultConfigured && dataLifecycle.configured && capabilityEvidence.configured && capacityEvidence.configured,
    nextActions,
  }
}

function runtimeHealth() {
  const base = service.health()
  const configuredRateLimit = Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? DEFAULT_RATE_LIMIT)
  const configuredOpsRateLimit = Number(process.env.OPS_API_RATE_LIMIT_PER_MINUTE ?? 600)
  return {
    ...base,
    capacity: { maxActiveJobsPerWorkspace, apiRateLimitPerMinute: Number.isFinite(configuredRateLimit) && configuredRateLimit > 0 ? configuredRateLimit : DEFAULT_RATE_LIMIT, opsApiRateLimitPerMinute: Number.isFinite(configuredOpsRateLimit) && configuredOpsRateLimit > 0 ? configuredOpsRateLimit : 600, rateLimitScope: 'workspace_actor', jobAdmission: redisJobAdmission ? 'redis_atomic' : 'process_local' },
    writesEnabled: SUPPORTED_PLATFORMS.some(platform => platformWriteReady(platform)),
      setup: setupDiagnostics(),
    connectors: {
      ...base.connectors,
      jd: connectorRuntime.isOAuthConfigured('jd') ? 'configured_provider_required' : base.connectors.jd,
      taobao: connectorRuntime.isOAuthConfigured('taobao') ? 'configured_provider_required' : base.connectors.taobao,
      tmall: connectorRuntime.isOAuthConfigured('tmall') ? 'configured_provider_required' : base.connectors.tmall,
      pinduoduo: connectorRuntime.isOAuthConfigured('pinduoduo') ? 'configured_provider_required' : base.connectors.pinduoduo,
    },
  }
}

function workspacePlatformStatus(workspaceId: string) {
  const registered = service.listPlatformAccounts(workspaceId)
  return SUPPORTED_PLATFORMS.flatMap(platform => {
    const accounts = registered.filter(item => item.platform === platform)
    const rows = accounts.length ? accounts : [undefined]
    return rows.map(account => {
      const state = account ? account.tokenState : fixturePlatformEnabled(platform) ? 'fixture_ready' : connectorRuntime.isOAuthConfigured(platform) && !connectorRuntime.credentialProviderConfigured ? 'configured_provider_required' : connectorRuntime.isHttpConfigured(platform) ? 'configured' : connectorRuntime.isOAuthConfigured(platform) ? 'oauth_configured' : 'not_configured'
      return {
        platform,
        state,
        ...(account ? { accountId: account.id, ...(account.storeAlias ? { storeAlias: account.storeAlias } : {}) } : {}),
        ...platformAccessFlags(platform, account),
        readiness: workspaceConnectorReadiness(platform),
        capabilityEvidenceKind: 'application_profile',
        capabilities: connectorRuntime.capabilityMatrix(platform).map(item => ({ capability: item.capability, state: item.state, ...(item.verifiedAt ? { verifiedAt: item.verifiedAt } : {}) })),
      }
    })
  })
}

type PublicPlatformAccount = Omit<PlatformAccount, 'credentialRef'> & { credentialRef?: undefined }

function publicAuthorization(account: PublicPlatformAccount, simulated: boolean) {
  const expiresAt = account.accessTokenExpiresAt
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN
  const lastKnownExpiryState = !Number.isFinite(expiry) ? 'unknown' : expiry <= Date.now() ? 'expired' : 'valid'
  return {
    state: simulated ? 'fixture' : account.tokenState,
    reauthorizationRequired: account.tokenState === 'refresh_required' || account.tokenState === 'revoked',
    grantedScopes: account.grantedScopes ?? [],
    scopeState: account.grantedScopes?.length ? 'reported_by_provider' : 'unknown',
    lastKnownAccessTokenExpiresAt: expiresAt ?? null,
    lastKnownExpiryState,
    renewalMode: account.credentialRefreshable === true ? 'automatic' : account.credentialRefreshable === false ? 'reauthorize' : 'unknown',
    refreshSupported: account.credentialRefreshable ?? null,
    lastAuthorizedAt: account.lastAuthorizedAt ?? null,
    metadataObservedAt: account.credentialMetadataObservedAt ?? null,
    metadataFreshness: account.credentialMetadataObservedAt ? 'last_known' : 'unknown',
    stateChangedAt: account.tokenStateUpdatedAt ?? null,
    revokedAt: account.revokedAt ?? null,
  }
}

function workspaceStoreDirectory(workspaceId: string, platformFilter?: Platform) {
  const products = service.listProducts(workspaceId)
  const syncJobs = service.listSyncJobs(workspaceId)
  return service.listPlatformAccounts(workspaceId)
    .filter(account => !platformFilter || account.platform === platformFilter)
    .map(account => {
      const names = [...new Set(products.filter(product => product.platform === account.platform && product.accountId === account.id).map(product => product.storeName).filter(Boolean))].sort()
      const storeName = names.length === 1 ? names[0]! : names.length > 1 ? `${names[0]} 等 ${names.length} 个店铺名` : undefined
      const state = account.tokenState
      const access = platformAccessFlags(account.platform, account)
      const simulated = fixtureMode || products.some(product => product.platform === account.platform && product.accountId === account.id && product.source === 'fixture')
      const dataMode = simulated ? 'fixture' : access.readEnabled ? 'official_api' : 'account_record_only'
      const storeSync = syncJobs.filter(job => job.platform === account.platform && job.accountId === account.id)
      const latestAttempt = [...storeSync].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
      const lastSuccessful = [...storeSync].filter(job => job.state === 'succeeded').sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
      const lastUsable = [...storeSync].filter(job => job.state === 'succeeded' || job.state === 'partial').sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
      return {
        platform: account.platform,
        accountId: account.id,
        ...(account.storeAlias ? { alias: account.storeAlias } : {}),
        ...(storeName ? { storeName } : {}),
        label: account.storeAlias ?? storeName ?? `${account.platform} 店铺`,
        state,
        dataMode,
        readable: account.tokenState === 'connected' && (access.readEnabled || simulated),
        writeEnabled: access.writeEnabled,
        authorization: publicAuthorization(account, simulated),
        sync: {
          latestState: latestAttempt?.state ?? null,
          lastAttemptAt: latestAttempt?.updatedAt ?? null,
          lastSuccessfulAt: lastSuccessful?.updatedAt ?? null,
          lastUsableAt: lastUsable?.updatedAt ?? null,
          failedItems: latestAttempt?.itemsFailed ?? 0,
        },
        revision: account.revision,
      }
    })
    .sort((left, right) => `${left.platform}:${left.label}:${left.accountId}`.localeCompare(`${right.platform}:${right.label}:${right.accountId}`))
}

function merchantPlatformOptions(workspaceId: string, directory = workspaceStoreDirectory(workspaceId)) {
  return SUPPORTED_PLATFORMS.map(platform => {
    const stores = directory.filter(store => store.platform === platform)
    const readiness = workspaceConnectorReadiness(platform)
    const realStore = stores.find(store => store.state === 'connected' && store.dataMode === 'official_api' && store.readable)
    const demoStore = stores.find(store => store.dataMode === 'fixture')
    const state = realStore ? 'connected' : demoStore ? 'demo' : readiness.ready ? 'available' : 'not_configured'
    const mode = realStore ? '真实授权' : demoStore ? '本地演示' : readiness.ready ? '可授权' : '待配置'
    return {
      platform,
      label: PLATFORM_LABELS[platform],
      state,
      mode,
      storeCount: stores.length,
      action: 'platform.connect',
      cta: state === 'connected' ? `管理${PLATFORM_LABELS[platform]}店铺` : `连接${PLATFORM_LABELS[platform]}`,
      nextAction: state === 'not_configured' ? '等待平台官方接口配置' : `选择${PLATFORM_LABELS[platform]}店铺并授权`,
      readiness: { ready: readiness.ready, reasons: readiness.reasons, mediaUpload: readiness.mediaUpload },
    }
  })
}

function workspaceOnboarding(workspaceId: string, directory = workspaceStoreDirectory(workspaceId)) {
  const products = service.listProducts(workspaceId)
  const selectedStoreKeys = new Set(directory.map(store => `${store.platform}:${store.accountId}`))
  const boundProducts = products.filter(product => product.accountId ? selectedStoreKeys.has(`${product.platform}:${product.accountId}`) : false)
  const assets = service.listAssets(workspaceId)
  const tasks = service.listTasks(workspaceId).filter(task => task.accountId ? selectedStoreKeys.has(`${task.platform}:${task.accountId}`) : false)
  const confirmedProducts = boundProducts.filter(product => product.factsConfirmed)
  const readyAssets = assets.filter(asset => assetReadiness(asset).status === 'ready')
  const deliverableTasks = tasks.filter(task => service.listContentVersions(workspaceId, task.id).some(version => version.state === 'approved' || version.state === 'delivered'))
  const steps = [
    { id: 'bind-store', title: '绑定店铺', summary: directory.length ? `已绑定 ${directory.length} 家店铺` : '先选择平台并完成官方授权', state: directory.length ? 'complete' : 'required', entryMethod: 'platform.connect', nextMethod: 'platform.connect' },
    { id: 'choose-product', title: '选择商品', summary: boundProducts.length ? `已找到 ${boundProducts.length} 个商品，可按店铺选择` : '绑定店铺后同步或导入商品', state: !directory.length ? 'blocked' : boundProducts.length ? 'next' : 'required', entryMethod: 'catalog.search', nextMethod: 'catalog.search' },
    { id: 'add-assets', title: '上传素材与资料', summary: readyAssets.length ? `已确认 ${readyAssets.length} 份可用素材` : assets.length ? '素材已上传，仍需完成扫描、权益和事实确认' : '添加商品图片、品牌资料和知识库文件', state: !boundProducts.length ? 'blocked' : readyAssets.length ? 'complete' : assets.length ? 'next' : 'required', entryMethod: 'asset.upload', nextMethod: 'asset.upload' },
    { id: 'start-content', title: '开始内容任务', summary: deliverableTasks.length ? `已有 ${deliverableTasks.length} 个内容交付` : confirmedProducts.length ? '商品事实已确认，可以开始文案、主图或视频分镜' : '先确认商品、价格、库存和图片事实', state: !boundProducts.length || !confirmedProducts.length ? 'blocked' : deliverableTasks.length ? 'complete' : 'next', entryMethod: 'task.understand', nextMethod: 'task.understand' },
  ] as const
  const current = steps.find(step => step.state === 'required' || step.state === 'next' || step.state === 'blocked') ?? steps.at(-1)!
  return { steps, currentStep: { id: current.id, title: current.title, state: current.state, entryMethod: current.entryMethod }, summary: { stores: directory.length, products: boundProducts.length, unboundProducts: products.length - boundProducts.length, confirmedProducts: confirmedProducts.length, assets: assets.length, readyAssets: readyAssets.length, tasks: tasks.length, deliverableTasks: deliverableTasks.length } }
}

function merchantCapabilityCardAction(card: typeof MERCHANT_CAPABILITY_CARDS[number], onboarding: ReturnType<typeof workspaceOnboarding>, directory: ReturnType<typeof workspaceStoreDirectory>) {
  const { summary } = onboarding
  if (card.id === 'first-value') return { method: 'merchant.first_value', arguments: { example: 'true' }, required_inputs: [], reason: '先查看安全示例预览；如需真实商品，请先选择 platform + account_id + product_id', blocked_by: [] as string[] }
  if (card.id === 'stores-products') {
    if (!directory.length) return { method: 'platform.connect', arguments: {}, required_inputs: ['platform'], reason: '先绑定一个平台店铺', blocked_by: [] as string[] }
    return { method: 'catalog.search', arguments: { scope: 'store' }, required_inputs: ['platform', 'account_id'], reason: '先选择具体平台和店铺，再查看商品', blocked_by: summary.products ? [] : ['product_sync_or_import'] }
  }
  if (card.id === 'knowledge-assets') {
    return { method: 'asset.list', arguments: {}, required_inputs: [], reason: summary.products ? '查看素材状态；没有素材时再上传商品图片或品牌资料' : '先选择店铺商品', blocked_by: summary.products ? [] : ['store_product_selection'] }
  }
  if (card.id === 'content') {
    if (!summary.products) return { method: 'catalog.search', arguments: { scope: 'store' }, required_inputs: ['platform', 'account_id'], reason: '先选择商品', blocked_by: ['store_product_selection'] }
    return { method: 'task.understand', arguments: {}, required_inputs: ['instruction', 'platform', 'account_id'], reason: summary.confirmedProducts ? '输入一句营销目标，开始创建内容任务' : '先确认商品、价格、库存和图片事实', blocked_by: summary.confirmedProducts ? [] : ['product_facts_confirmation'] }
  }
  if (card.id === 'visuals') return { method: 'catalog.image.generate', arguments: {}, required_inputs: ['product_id', 'platform', 'account_id'], reason: '选择商品后生成图片候选；结果仍需审核', blocked_by: summary.products ? [] : ['store_product_selection'] }
  if (card.id === 'review-publish') return { method: summary.tasks ? 'publish.prepare' : 'task.history', arguments: {}, required_inputs: summary.tasks ? ['task_id'] : [], reason: summary.tasks ? '先查看发布前检查和店铺范围' : '先创建内容任务', blocked_by: summary.tasks ? [] : ['content_task'] }
  if (card.id === 'bulk-publish') return { method: 'publish.batch.prepare', arguments: {}, required_inputs: ['task_ids_json'], reason: '批量发布前逐项预检和确认；每个任务仍需独立确认哈希', blocked_by: summary.tasks ? [] : ['content_task'] }
  if (card.id === 'rules') return { method: 'rule.sync.status', arguments: {}, required_inputs: [], reason: '先查看六个平台规则是否新鲜，再按店铺平台查看适用规则；生成和审核会自动执行同一平台预检', blocked_by: [] as string[] }
  return { method: card.entryMethod, arguments: {}, required_inputs: [], reason: '查看套餐、模型成本和充值到账状态', blocked_by: [] as string[] }
}

const JOB_ADMISSION_TTL_SECONDS = 24 * 60 * 60

async function reserveDistributedJobSlot(workspaceId: string, reservationId: string) {
  if (!redisJobAdmission) return false
  try {
    const acquired = await redisJobAdmission.acquire(workspaceId, reservationId, Math.max(1, Math.floor(maxActiveJobsPerWorkspace)), JOB_ADMISSION_TTL_SECONDS)
    if (acquired === 'quota') throw new DomainError('WORKSPACE_JOB_QUOTA_EXCEEDED', '当前工作区已有较多任务排队，请稍后重试', 429, { limit: maxActiveJobsPerWorkspace, retry_after_seconds: 5 })
    if (acquired === 'existing') throw new DomainError('IDEMPOTENCY_IN_PROGRESS', '相同幂等键的任务正在其他服务实例创建，请稍后重试', 409, { retry_after_seconds: 1 })
    return true
  } catch (error) {
    if (error instanceof DomainError) throw error
    // Redis is an acceleration/coordination dependency. The in-process domain
    // quota remains active and health exposes this degraded mode.
    return false
  }
}

async function hydrateDurableIdempotentJob(workspaceId: string, entityType: 'publish_job' | 'generation_job', idempotencyKey: string) {
  await persistenceReady
  const snapshot = await persistence.business?.findByIdempotencyKey(workspaceId, entityType, idempotencyKey)
  if (snapshot) service.hydrateSnapshot({ entityType, entity: snapshot.payload })
  return snapshot?.payload
}

async function waitForDurableIdempotentJob(workspaceId: string, entityType: 'publish_job' | 'generation_job', idempotencyKey: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const payload = await hydrateDurableIdempotentJob(workspaceId, entityType, idempotencyKey)
    if (payload) return payload
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new DomainError('IDEMPOTENCY_IN_PROGRESS', '相同幂等键的任务正在其他服务实例创建，请稍后重试', 409, { retry_after_seconds: 1 })
}

async function releaseDistributedJobSlot(workspaceId: string, reservationId: string) {
  if (!redisJobAdmission) return
  try { await redisJobAdmission.release(workspaceId, reservationId) } catch { /* health/alerts surface Redis degradation */ }
}

/** Shared OAuth initiation path for REST and MCP so both surfaces enforce the
 * same redirect, PKCE, state and connector readiness rules. */
const oauthRedirectEnv: Record<Platform, string> = {
  jd: 'JD_OAUTH_REDIRECT_URI',
  taobao: 'TAOBAO_OAUTH_REDIRECT_URI',
  tmall: 'TMALL_OAUTH_REDIRECT_URI',
  pinduoduo: 'PDD_OAUTH_REDIRECT_URI',
  xiaohongshu: 'XHS_OAUTH_REDIRECT_URI',
  douyin: 'DOUYIN_OAUTH_REDIRECT_URI',
}

export function configuredOAuthRedirectUri(platform: Platform, source: NodeJS.ProcessEnv = process.env): string | undefined {
  const platformUri = source[oauthRedirectEnv[platform]]?.trim()
  if (platformUri) return platformUri
  const shared = source.PUBLIC_OAUTH_REDIRECT_URI?.trim()
  if (!shared) return undefined
  if (shared.includes('{platform}')) return shared.replaceAll('{platform}', platform)
  try {
    const parsed = new URL(shared)
    const path = parsed.pathname.replace(/\/+$/u, '')
    if (path.endsWith('/v1/oauth/callback')) {
      parsed.pathname = `${path}/${platform}`
      return parsed.toString()
    }
  } catch { /* validated by the authorization boundary below */ }
  return shared
}

function validOAuthRedirectUri(platform: Platform, redirectUri: string): boolean {
  try {
    const parsed = new URL(redirectUri)
    return parsed.protocol === 'https:' && parsed.pathname.replace(/\/+$/u, '') === `/v1/oauth/callback/${platform}`
  } catch { return false }
}

async function beginPlatformAuthorization(req: IncomingMessage, platform: Platform, input: JsonObject, workspaceId: string) {
  if (isProduction() && !redisOAuthPort) throw new DomainError('OAUTH_STATE_STORE_UNAVAILABLE', '生产 OAuth 必须配置 Redis 状态存储，禁止使用单副本内存状态', 503)
  const actorId = requestActor(req, typeof input.actor_id === 'string' && input.actor_id.trim() ? input.actor_id.trim() : 'actor_demo')
  const codeVerifier = randomBytes(32).toString('base64url')
  const state = await oauthStateStore.issue({ workspaceId, actorId, platform, codeVerifier, codeChallenge: hashPkceVerifier(codeVerifier) })
  const configuredRedirectUri = configuredOAuthRedirectUri(platform)
  const requestedRedirectUri = typeof input.redirect_uri === 'string' ? input.redirect_uri.trim() : undefined
  const redirectUri = isProduction() ? configuredRedirectUri ?? '' : requestedRedirectUri ?? configuredRedirectUri ?? 'http://127.0.0.1:8787/oauth/callback'
  if (!redirectUri || (isProduction() && (!validOAuthRedirectUri(platform, redirectUri) || (requestedRedirectUri && requestedRedirectUri !== configuredRedirectUri)))) throw new DomainError('OAUTH_REDIRECT_URI_REQUIRED', `生产 OAuth 必须配置匹配 ${platform} 回调路由的 HTTPS ${oauthRedirectEnv[platform]}（或 PUBLIC_OAUTH_REDIRECT_URI 模板）`, 503)
  if (!platformAuthorizationConfigured(platform)) throw new DomainError('NOT_CONFIGURED', `${platform} 官方 OAuth 尚未配置`, 503)
  const result = await connectorRuntime.connector(platform).authorize({ workspaceId, actorId, redirectUri, state, codeVerifier })
  if (!result.ok) throw new DomainError(result.code ?? 'NOT_CONFIGURED', result.message ?? '平台官方 API 尚未配置', 503)
  return result
}

async function enforceRateLimit(req: IncomingMessage, workspaceId: string) {
  if (req.method === 'OPTIONS' || req.url?.startsWith('/healthz')) return
  const principal = requestPrincipals.get(req)
  const operationsPrincipal = Boolean(principal && authorizedRoles(principal).some(role => ['platform_ops', 'finance'].includes(role)))
  const configuredLimit = Number(operationsPrincipal ? process.env.OPS_API_RATE_LIMIT_PER_MINUTE ?? 600 : process.env.API_RATE_LIMIT_PER_MINUTE ?? DEFAULT_RATE_LIMIT)
  const limit = Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : operationsPrincipal ? 600 : DEFAULT_RATE_LIMIT
  const rateScope = `${workspaceId}:${principal?.actorId || 'anonymous'}:${operationsPrincipal ? 'ops' : 'merchant'}`
  const now = Date.now()
  if (redisRateLimit) {
    try {
      const window = Math.floor(now / 60_000)
      const count = await redisRateLimit.increment(`merchant:rate:${rateScope}:${window}`, 120)
      if (count > limit) {
        const retryAfterSeconds = Math.max(1, 60 - Math.floor((now % 60_000) / 1_000))
        throw new DomainError(ERROR_CODES.RATE_LIMITED, '请求频率超过当前工作区限制', 429, { retry_after_seconds: retryAfterSeconds })
      }
      return
    } catch (error) {
      if (error instanceof DomainError) throw error
      // Redis outage falls back to the process bucket so a transient cache
      // failure does not take down the API; production health/alerts must
      // surface this degraded protection state.
    }
  }
  const current = rateBuckets.get(rateScope)
  if (!current || now - current.windowStartedAt >= 60_000) {
    rateBuckets.set(rateScope, { windowStartedAt: now, count: 1 })
    return
  }
  current.count += 1
  if (current.count > limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((60_000 - (now - current.windowStartedAt)) / 1_000))
    throw new DomainError(ERROR_CODES.RATE_LIMITED, '请求频率超过当前工作区限制', 429, { retry_after_seconds: retryAfterSeconds })
  }
}

/** Resolve tenant scope from server identity; body/query values are only consistency checks. */
function resolveWorkspace(req: IncomingMessage, candidate?: unknown): string {
  const fromHeader = header(req, 'x-workspace-id')?.trim()
  if (!fromHeader && requiresStrictAuth()) throw new DomainError(ERROR_CODES.WORKSPACE_SCOPE_REQUIRED, '受控环境请求必须携带 X-Workspace-Id', 401)
  const workspaceId = fromHeader || 'ws_demo'
  knownWorkspaces.add(workspaceId)
  if (candidate !== undefined && candidate !== null && String(candidate) !== '' && String(candidate) !== workspaceId) {
    throw new DomainError(ERROR_CODES.WORKSPACE_SCOPE_MISMATCH, '请求工作区与身份工作区不一致', 403)
  }
  return workspaceId
}

function required(input: JsonObject, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `缺少必填字段: ${key}`, 400)
  return value
}

function requiredOperationalReason(input: JsonObject): string {
  const reason = required(input, 'reason').trim()
  if (reason.length < 4 || reason.length > 500) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'reason 必须是 4 到 500 个字符', 400)
  return reason
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value: unknown, label: string, maxLength: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${label}无效`, 400)
  return value.trim()
}

function readPlatformRejection(value: unknown): PlatformRejection | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '平台拒绝详情无效', 400)
  const fieldsInput = value.fields
  if (!Array.isArray(fieldsInput) || fieldsInput.length > 50) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '平台字段错误必须为不超过 50 项的数组', 400)
  const fields = fieldsInput.map((field, index) => {
    if (!isObject(field)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `平台字段错误 ${index + 1} 无效`, 400)
    return {
      path: boundedText(field.path, `平台字段错误 ${index + 1} 路径`, 256, true)!,
      ...(field.raw_code === undefined ? {} : { rawCode: boundedText(field.raw_code, `平台字段错误 ${index + 1} 代码`, 128, true)! }),
      message: boundedText(field.message, `平台字段错误 ${index + 1} 原因`, 1000, true)!,
    }
  })
  return {
    rawCode: boundedText(value.raw_code, '平台拒绝代码', 128, true)!,
    ...(value.message === undefined ? {} : { message: boundedText(value.message, '平台拒绝原因', 2000, true)! }),
    fields,
  }
}

function readStaticBrief(value: unknown): StaticBrief | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const brief = value as Record<string, unknown>
  const strings = ['platform', 'placement', 'targetDimensions', 'productImageGuidance', 'logoSafety', 'headline', 'subheadline', 'coreSellingPoint', 'cta', 'textDensity', 'safeArea']
  if (strings.some(key => typeof brief[key] !== 'string' || !(brief[key] as string).trim()) || !Array.isArray(brief.visualHierarchy) || !Array.isArray(brief.protectedAreas)) return undefined
  const visualHierarchy = brief.visualHierarchy.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  const protectedAreas = brief.protectedAreas.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (!visualHierarchy.length || !protectedAreas.length) return undefined
  return {
    platform: brief.platform as string, placement: brief.placement as string, targetDimensions: brief.targetDimensions as string,
    visualHierarchy, productImageGuidance: brief.productImageGuidance as string, logoSafety: brief.logoSafety as string,
    headline: brief.headline as string, subheadline: brief.subheadline as string, coreSellingPoint: brief.coreSellingPoint as string,
    ...(typeof brief.priceExpression === 'string' && brief.priceExpression.trim() ? { priceExpression: brief.priceExpression } : {}),
    cta: brief.cta as string, textDensity: brief.textDensity as string, safeArea: brief.safeArea as string, protectedAreas,
  }
}

function readContentModules(value: unknown): ContentModule[] | undefined {
  if (!Array.isArray(value)) return undefined
  const modules = value.filter(isObject).filter(item => typeof item.key === 'string' && typeof item.title === 'string' && typeof item.purpose === 'string' && typeof item.body === 'string' && Array.isArray(item.factSourceIds)).map(item => {
    const referencedSkuIds = Array.isArray(item.referencedSkuIds) ? item.referencedSkuIds.filter((sku): sku is string => typeof sku === 'string' && sku.trim().length > 0).slice(0, 100) : undefined
    const contentKind: import('../../../packages/ai/src/generator.js').ContentModule['contentKind'] = item.contentKind === 'fact' || item.contentKind === 'creative' || item.contentKind === 'pending' ? item.contentKind as import('../../../packages/ai/src/generator.js').ContentModule['contentKind'] : undefined
    const pendingReason = typeof item.pendingReason === 'string' && item.pendingReason.trim() ? item.pendingReason.trim() : undefined
    return { key: (item.key as string).trim(), title: (item.title as string).trim(), purpose: (item.purpose as string).trim(), body: (item.body as string).trim(), factSourceIds: (item.factSourceIds as unknown[]).filter((source): source is string => typeof source === 'string' && source.trim().length > 0), ...(contentKind ? { contentKind } : {}), ...(pendingReason ? { pendingReason } : {}), ...(referencedSkuIds?.length ? { referencedSkuIds } : {}), ...(typeof item.imageGuidance === 'string' && item.imageGuidance.trim() ? { imageGuidance: item.imageGuidance.trim() } : {}) }
  }).filter(item => item.key && item.title && item.body).slice(0, 16)
  return modules.length ? modules : undefined
}

function reviewProductImagesForMcp(images: readonly string[] | undefined) {
  return reviewProductImages(images)
}

function parseImageListForMcp(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const raw = value.trim()
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
      return parsed.map(item => item.trim()).filter(Boolean)
    }
  } catch {
    // Keep accepting the original comma-separated form for ordinary URLs.
  }
  // A data URI contains a comma between its media type and payload. Split only
  // at the boundary between multiple data URIs so Codex cannot turn one image
  // into IMAGE_URL_INVALID fragments during review.
  if (/^data:image\//iu.test(raw)) return raw.split(/,(?=data:image\/)/iu).map(item => item.trim()).filter(Boolean)
  return raw.split(',').map(item => item.trim()).filter(Boolean)
}

const GENERATED_IMAGE_MIME = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'],
])

function generatedImageSignatureMatches(mimeType: string, body: Uint8Array) {
  if (mimeType === 'image/png') return body.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => body[index] === value)
  if (mimeType === 'image/jpeg') return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
  if (mimeType === 'image/webp') return body.length >= 12 && Buffer.from(body.slice(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(body.slice(8, 12)).toString('ascii') === 'WEBP'
  return false
}

async function archiveGeneratedImages(workspaceId: string, jobId: string, images: readonly string[]) {
  const outputs: import('../../../packages/application/src/service.js').VisualGenerationOutput[] = []
  let totalBytes = 0
  try {
    for (const [index, image] of images.entries()) {
    const match = image.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/iu)
    if (!match) continue
    const mimeType = match[1]!.toLowerCase()
    const extension = GENERATED_IMAGE_MIME.get(mimeType)
    if (!extension || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(match[2]!)) throw new DomainError('GENERATED_IMAGE_FORMAT_INVALID', '图片生成服务返回了不支持的图片格式', 502)
    const body = new Uint8Array(Buffer.from(match[2]!, 'base64'))
    if (!generatedImageSignatureMatches(mimeType, body)) throw new DomainError('GENERATED_IMAGE_SIGNATURE_INVALID', '图片生成服务返回的 MIME 类型与文件内容不匹配', 502)
    totalBytes += body.byteLength
    if (!body.byteLength || body.byteLength > 15 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024) throw new DomainError('GENERATED_IMAGE_TOO_LARGE', '生成图片超过归档大小限制', 413)
    const stored = await getAssetStorage().putQuarantine({ workspaceId, assetId: jobId, fileName: `candidate-${index + 1}.${extension}`, contentType: mimeType, body, expectedSizeBytes: body.byteLength })
      outputs.push({ visualRef: `dvis_${randomBytes(18).toString('base64url')}`, ordinal: index + 1, storageKey: stored.key, mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, createdAt: stored.createdAt, reviewStatus: 'unreviewed' })
    }
    const archiveState = outputs.length === images.length ? 'archived' : outputs.length ? 'partial' : 'external_unarchived'
    return service.archiveImageGenerationOutputs(workspaceId, jobId, outputs, archiveState)
  } catch (error) {
    await Promise.all(outputs.map(output => compensateStoredObject(workspaceId, output.storageKey, 'generated image archive failed after object upload')))
    throw error
  }
}

async function readArchivedGeneratedImages(workspaceId: string, job: import('../../../packages/application/src/service.js').ImageGenerationJob) {
  if (job.images?.length) return [...job.images]
  const images: string[] = []
  for (const output of [...(job.outputs ?? [])].sort((left, right) => left.ordinal - right.ordinal)) {
    const stored = await getStoredObjectWithRetry(workspaceId, output.storageKey, { includeQuarantine: true })
    if (stored.metadata.sha256 !== output.sha256 || stored.metadata.sizeBytes !== output.sizeBytes || stored.metadata.contentType !== output.mimeType) throw new DomainError('GENERATED_IMAGE_INTEGRITY_FAILED', '历史生成图片完整性校验失败', 500)
    images.push(`data:${output.mimeType};base64,${Buffer.from(stored.body).toString('base64')}`)
  }
  return images
}

function publicImageJob(job: import('../../../packages/application/src/service.js').ImageGenerationJob) {
  return {
    state: job.state, artifactRole: 'candidate', imageMode: job.imageMode, direction: job.direction, requestedCount: job.count, skuIds: job.skuIds ?? [], sourceAssetIds: job.sourceAssetIds ?? [],
    createdAt: job.createdAt, updatedAt: job.updatedAt, archiveState: job.archiveState,
    binding: job.contentVersionId ? 'exact' : 'unbound', candidateCount: job.outputs?.length ?? job.images?.length ?? 0,
    candidates: (job.outputs ?? []).map(output => ({ visualRef: output.visualRef, ordinal: output.ordinal, mimeType: output.mimeType, sizeBytes: output.sizeBytes, reviewStatus: output.reviewStatus })),
    platformUsage: { status: 'not_submitted', observed: false }, selectionRequired: true,
  }
}

function assetForWorkspace(workspaceId: string, assetId: string) {
  const asset = service.assets.get(assetId)
  if (!asset || asset.workspaceId !== workspaceId) throw new DomainError('ASSET_NOT_FOUND', '素材不存在或不属于当前工作区', 404)
  return asset
}

function requireApprovedAssetForImageGeneration(workspaceId: string, product: { platform: Platform }, requestedAssetIds?: string[]) {
  const platform = product.platform
  if (requestedAssetIds?.length) {
    const invalid: Array<Record<string, unknown>> = []
    for (const assetId of requestedAssetIds) {
      const asset = assetForWorkspace(workspaceId, assetId)
      const valid = asset.mimeType.toLowerCase().startsWith('image/')
        && asset.scanStatus === 'clean'
        && asset.rightsStatus === 'approved'
        && asset.rightsScope !== 'unusable'
        && asset.aiModificationAllowed === true
        && (!asset.applicablePlatforms?.length || asset.applicablePlatforms.includes(platform))
        && (!asset.usageScopes?.length || asset.usageScopes.includes('commercial') || asset.usageScopes.includes('ai_generation'))
        && (!asset.validFrom || Date.parse(asset.validFrom) <= Date.now())
        && (!asset.validTo || Date.parse(asset.validTo) >= Date.now())
      if (!valid) invalid.push({ asset_id: assetId, scan_status: asset.scanStatus, rights_status: asset.rightsStatus, applicable_platforms: asset.applicablePlatforms ?? [], usage_scopes: asset.usageScopes ?? [] })
    }
    if (invalid.length) throw new DomainError('IMAGE_SOURCE_ASSET_INVALID', '指定的商品素材未通过图片生成所需的安全、权益、平台或 AI 修改检查', 409, { platform, invalid_assets: invalid, next_step: '完成 asset.scan，并通过 asset.rights.update 确认商用权益和 AI 修改许可' })
    return
  }
  if (process.env.REQUIRE_APPROVED_ASSET_FOR_GENERATION !== 'true') return
  const candidates = [...service.assets.values()].filter(asset => asset.workspaceId === workspaceId && asset.mimeType.toLowerCase().startsWith('image/'))
  const eligible = candidates.filter(asset => asset.scanStatus === 'clean'
    && asset.rightsStatus === 'approved'
    && asset.aiModificationAllowed === true
    && asset.applicablePlatforms?.includes(platform))
  if (eligible.length) return
  throw new DomainError(
    'APPROVED_ASSET_REQUIRED_FOR_GENERATION',
    `正式商品主图生成前必须提供当前工作区已通过安全扫描、已确认商用权益、允许 AI 修改且适用于 ${platform} 的商品素材`,
    409,
    {
      workspace_id: workspaceId,
      platform,
      required: {
        mime_type: 'image/*',
        scan_status: 'clean',
        rights_status: 'approved',
        ai_modification_allowed: true,
        applicable_platforms: [platform],
      },
      candidate_count: candidates.length,
      next_step: '请先上传商品图片，完成 asset.scan，并通过 asset.rights.update 确认权益和 AI 修改许可',
    },
  )
}

async function uploadAssetForMcp(workspaceId: string, params: JsonObject) {
  const encoded = required(params, 'content_base64')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'content_base64 无效', 400)
  let bytes: Uint8Array
  try { bytes = new Uint8Array(Buffer.from(encoded, 'base64')) } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'content_base64 无效', 400) }
  if (!bytes.byteLength || bytes.byteLength > 50 * 1024 * 1024) throw new DomainError('ASSET_UPLOAD_LIMIT', 'Codex MCP 单个素材上传限制为 50MB', 413)
  const assetName = required(params, 'name')
  const assetMime = required(params, 'mime_type')
  validateAssetContentSignature(assetName, assetMime, bytes)
  let applicablePlatforms: Platform[] | undefined
  if (typeof params.applicable_platforms_json === 'string') {
    try { const parsed = JSON.parse(params.applicable_platforms_json); if (!Array.isArray(parsed) || parsed.some(value => !SUPPORTED_PLATFORMS.includes(String(value) as Platform))) throw new Error('applicable_platforms_json'); applicablePlatforms = parsed as Platform[] } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'applicable_platforms_json 必须是支持平台字符串数组 JSON', 400) }
  }
  const parseAssetList = (key: string, label: string) => {
    if (typeof params[key] !== 'string') return undefined
    try { const parsed = JSON.parse(params[key] as string); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error(key); return parsed as string[] } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是字符串数组 JSON`, 400) }
  }
  const applicableRegions = parseAssetList('applicable_regions_json', '适用地区')
  const usageScopes = parseAssetList('usage_scopes_json', '使用范围')
  const rightsScope = typeof params.rights_scope === 'string' ? params.rights_scope as import('../../../packages/application/src/service.js').AssetMetadata['rightsScope'] : undefined
  if (rightsScope && !['owned', 'commercial_authorized', 'limited_use', 'internal_only', 'unknown', 'unusable'].includes(rightsScope)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'rights_scope 无效', 400)
  const provisional = service.registerAsset({ workspaceId, name: assetName, mimeType: assetMime, sizeBytes: bytes.byteLength, sha256: typeof params.sha256 === 'string' && /^[a-f0-9]{64}$/iu.test(params.sha256) ? params.sha256 : createHash('sha256').update(bytes).digest('hex'), storageKey: `quarantine/${workspaceId}/pending/${randomUUID()}/${assetName}`, ...(rightsScope ? { rightsScope } : {}), ...(applicablePlatforms ? { applicablePlatforms } : {}), ...(applicableRegions ? { applicableRegions } : {}), ...(usageScopes ? { usageScopes } : {}), ...(typeof params.valid_from === 'string' ? { validFrom: params.valid_from } : {}), ...(typeof params.valid_to === 'string' ? { validTo: params.valid_to } : {}), ...(params.ai_modification_allowed === 'true' || params.ai_modification_allowed === 'false' ? { aiModificationAllowed: params.ai_modification_allowed === 'true' } : {}) })
  if (provisional.deduplication.mode === 'deduplicated') { await persistAssetReference(workspaceId, provisional); return provisional }
  let storedKey: string | undefined
  try {
    const stored = await getAssetStorage().putQuarantine({ workspaceId, assetId: provisional.id, fileName: provisional.name, contentType: provisional.mimeType, body: bytes, expectedSizeBytes: bytes.byteLength, expectedSha256: provisional.sha256 })
    storedKey = stored.key
    provisional.storageKey = stored.key
    await persistSnapshot(workspaceId, 'asset', provisional, provisional as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, provisional.id, 'asset.uploaded', provisional.revision, { asset_id: provisional.id, storage_key: stored.key, size_bytes: stored.sizeBytes, sha256: stored.sha256 })
    return provisional
  } catch (error) {
    // Do not leave an in-memory asset that can deduplicate a later retry when
    // the object was never durably stored.
    service.assets.delete(provisional.id)
    if (storedKey) await compensateStoredObject(workspaceId, storedKey, 'asset snapshot or event persistence failed')
    throw error
  }
}

function headerRequired(req: IncomingMessage, name: string): string {
  const value = header(req, name)?.trim()
  if (!value) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `缺少必填请求头: ${name}`, 400)
  return value
}

function isWorkerRoute(method: string | undefined, path: string): boolean {
  if (method === 'POST') {
    return path === '/v1/internal/automation/tick'
      || path === '/v1/internal/model-usage'
      || path === '/v1/ops/data-deletion/complete'
      || path === '/v1/internal/storage/orphans/cleanup'
      || /^\/v1\/sync-jobs\/[^/]+\/(?:progress|result)$/.test(path)
      || /^\/v1\/generation-jobs\/[^/]+\/(?:defer|result)$/.test(path)
      || /^\/v1\/publish-jobs\/[^/]+\/observation$/.test(path)
  }
  if (method === 'GET') {
    return /^\/v1\/sync-jobs\/[^/]+\/execution-context$/.test(path)
      || /^\/v1\/publish-jobs\/[^/]+\/(?:execution-check|media)$/.test(path)
  }
  return false
}

function requireWorkerAuthorization(req: IncomingMessage) {
  if (!requiresStrictAuth()) return
  const expected = process.env.WORKER_API_TOKEN?.trim()
  const authorization = header(req, 'authorization')
  if (!expected || authorization !== `Bearer ${expected}`) throw new DomainError(ERROR_CODES.FORBIDDEN, 'worker internal authorization required', 403)
  const signingSecret = process.env.WORKER_API_SIGNING_SECRET?.trim()
  if (!signingSecret) throw new DomainError('WORKER_AUTH_MISCONFIGURED', '严格认证环境的 Worker 回调必须配置 workspace signing secret', 503)
  const workspaceId = header(req, 'x-workspace-id')?.trim()
  const signature = header(req, 'x-worker-workspace-signature')?.trim()
  const canonical = `${req.method ?? 'GET'}\n${req.url ?? '/'}\n${workspaceId ?? ''}`
  const expectedSignature = createHmac('sha256', signingSecret).update(canonical).digest('hex')
  if (!workspaceId || !signature || !safeEqual(signature, expectedSignature)) throw new DomainError(ERROR_CODES.FORBIDDEN, 'worker workspace binding invalid', 403)
}

function requireWorkerCredentialAuthorization(req: IncomingMessage) {
  const expected = process.env.WORKER_API_TOKEN?.trim()
  const authorization = header(req, 'authorization')
  if (!expected || authorization !== `Bearer ${expected}`) throw new DomainError(ERROR_CODES.FORBIDDEN, 'worker credential access required', 403)
  const signingSecret = process.env.WORKER_API_SIGNING_SECRET?.trim()
  if (requiresStrictAuth() && !signingSecret) throw new DomainError('WORKER_AUTH_MISCONFIGURED', '严格认证环境的 Worker 凭据访问必须配置 workspace signing secret', 503)
  if (signingSecret) {
    const workspaceId = header(req, 'x-workspace-id')?.trim()
    const signature = header(req, 'x-worker-workspace-signature')?.trim()
    const canonical = `${req.method ?? 'GET'}\n${req.url ?? '/'}\n${workspaceId ?? ''}`
    const expectedSignature = createHmac('sha256', signingSecret).update(canonical).digest('hex')
    if (!workspaceId || !signature || !safeEqual(signature, expectedSignature)) throw new DomainError(ERROR_CODES.FORBIDDEN, 'worker workspace binding invalid', 403)
  }
}

function assertPublishIdempotency(workspaceId: string, input: { taskId: string; contentVersionId: string; confirmationHash: string; remoteSnapshotHash: string; idempotencyKey: string }) {
  const existing = [...service.publishJobs.values()].find(job => job.idempotencyKey === input.idempotencyKey)
  if (!existing) return
  if (existing.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '幂等键已属于其他工作区', 403)
  if (existing.taskId !== input.taskId || existing.contentVersionId !== input.contentVersionId || existing.confirmationHash !== input.confirmationHash || existing.remoteSnapshotHash !== input.remoteSnapshotHash) {
    throw new DomainError(ERROR_CODES.IDEMPOTENCY_CONFLICT, '幂等键已绑定其他发布意图', 409)
  }
}

function paramsOf(input: JsonObject): JsonObject {
  const params = input.params
  if (params === undefined) return {}
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'MCP params 必须是 JSON 对象', 400)
  return params as JsonObject
}

function firstValueExecutionLabel(kind: 'content' | 'visual', available: boolean) {
  const subject = kind === 'content' ? '内容' : '视觉候选'
  return {
    mode: 'read_only_preview' as const,
    simulated: false,
    providerExecuted: false,
    modelCalled: false,
    label: available ? `仅读取已有${subject}预览，未调用${subject}模型` : `暂无${subject}预览，未调用${subject}模型`,
    message: available ? `仅读取已有${subject}预览，未调用${subject}模型` : `暂无${subject}预览，未调用${subject}模型`,
  }
}

function firstValueNextActions(product: import('../../../packages/application/src/service.js').Product, contentAvailable: boolean, visualCount: number) {
  const actions = [`先确认商品事实：${product.factsConfirmed ? '已确认，可继续' : '仍需确认价格、库存、SKU 和图片'}`]
  if (!contentAvailable) actions.push('确认商品后调用 task.understand，开始内容任务')
  else actions.push('审阅已有内容预览，确认后再进入 content.review')
  if (!visualCount) actions.push('如需主图，先补齐已授权素材，再在交互确认后调用 catalog.image.generate')
  else actions.push('审阅视觉候选；选择前不要将候选视为已发布图片')
  actions.push('发布前必须人工审核并明确确认，当前预览不会发布任何内容')
  return actions
}

function merchantFirstValuePreview(workspaceId: string, params: JsonObject) {
  const example = params.example === 'true'
  if (example) {
    const nextActions = ['连接一个平台店铺并选择真实商品，查看基于商家事实的预览', '或上传商品资料后确认事实，再开始内容和视觉任务', '示例不会调用模型、写入商品或发布到平台']
    return {
      readOnly: true,
      previewOnly: true,
      example: true,
      product: { id: null, productId: null, facts: { title: '示例商品：轻云防晒外套', platform: null, storeName: null, accountId: null, remoteProductId: null, skuCount: 1, stock: null, price: null, category: '服饰示例', images: [], attributes: { note: '示例内容，不代表商家真实商品事实' }, sellingPoints: [], factsConfirmed: false, source: 'example', updatedAt: new Date().toISOString(), version: 1 }, sourceIds: ['example:first-value'] },
      contentPreview: { id: 'example-content-preview', taskId: null, version: 1, state: 'example', body: { title: '轻云防晒外套｜通勤轻户外详情页示例', detail: '这里展示详情页结构、卖点证据和平台适配方式。真实商品必须先绑定店铺并确认事实。', sellingPoints: ['结构化详情页模块', '卖点需要商家事实支持', '平台规则和 SEO/GEO 建议需单独确认'] }, sourceIds: ['example:first-value'], factSourceIds: [] },
      visualPreviewRefs: [],
      execution: { mode: 'read_only_preview', simulated: true, providerExecuted: false, modelCalled: false, label: '静态示例预览，未调用模型，未发布任何内容', message: '静态示例预览，未调用模型，未发布任何内容', content: firstValueExecutionLabel('content', true), visual: firstValueExecutionLabel('visual', false) },
      nextActions,
      next_actions: nextActions,
    }
  }
  const productId = typeof params.product_id === 'string' && params.product_id.trim() ? params.product_id.trim() : undefined
  const platform = typeof params.platform === 'string' && params.platform.trim() ? params.platform.trim() as Platform : undefined
  const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
  if (accountId && !platform) throw new DomainError('STORE_PLATFORM_REQUIRED', '使用 account_id 选择首个价值预览时必须同时指定 platform', 400)

  if (isProduction() && (!productId || !platform || !accountId)) {
    throw new DomainError('FIRST_VALUE_SELECTION_REQUIRED', '生产首个价值预览必须明确传入已授权店铺的 product_id、platform 和 account_id', 409, {
      next_actions: ['调用 workspace.health 查看已授权店铺', '调用 catalog.search 选择具体店铺商品', '重新调用 merchant.first_value 并传入 product_id、platform 和 account_id'],
    })
  }

  let product: import('../../../packages/application/src/service.js').Product | undefined
  if (productId) {
    product = service.products.get(productId)
    if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404, { next_actions: ['调用 catalog.search 查看当前工作区商品'] })
    if (platform && product.platform !== platform) throw new DomainError('PLATFORM_SCOPE_MISMATCH', '首个价值预览的平台必须与商品所属平台一致', 409, { next_actions: ['重新选择该商品所属 platform'] })
    if (accountId && product.accountId !== accountId) throw new DomainError('STORE_CONTEXT_MISMATCH', '首个价值预览的商品不属于所选店铺', 409, { next_actions: ['重新选择与商品一致的 platform + account_id'] })
    if (isProduction()) {
      if (!product.accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产首个价值预览的商品必须绑定已授权店铺', 409, { next_actions: ['调用 catalog.search 选择已绑定店铺商品'] })
      service.getActivePlatformAccount(workspaceId, product.accountId, product.platform)
    }
  } else if (accountId && platform) {
    service.getPlatformAccount(workspaceId, accountId, platform)
    product = service.listProducts(workspaceId, { platform, accountId })[0]
  } else if (platform) {
    throw new DomainError('STORE_SELECTION_REQUIRED', '请先明确选择 platform + account_id，首个价值预览不能跨店铺猜测商品', 409, { next_actions: ['调用 workspace.health 查看店铺列表', '明确选择 platform + account_id', '调用 catalog.search 查看该店铺商品'] })
  } else {
    // The fallback is deliberately limited to fixture data and the current
    // workspace. It must never turn an unscoped production request into a
    // real-store or cross-workspace preview.
    product = service.listProducts(workspaceId).find(item => item.source === 'fixture')
  }

  if (!product) {
    throw new DomainError('FIRST_VALUE_PRODUCT_REQUIRED', '当前范围没有可安全预览的商品；请先明确选择商品或同步/导入一件商品', 409, {
      next_actions: accountId && platform
        ? ['调用 catalog.sync.start 同步当前店铺商品', '或调用 catalog.import 导入商品资料', '完成后重新调用 merchant.first_value 并传入 product_id']
        : ['调用 catalog.search 选择一个具体店铺商品', '重新调用 merchant.first_value 并传入 product_id、platform 和 account_id'],
    })
  }

  const productVersion = product.version ?? 1
  const productSourceIds = [`product:${product.id}:v${productVersion}`]
  for (const sellingPoint of product.sellingPoints ?? []) productSourceIds.push(...sellingPoint.sourceIds)
  const productFacts = {
    title: product.title,
    platform: product.platform,
    storeName: product.storeName,
    accountId: product.accountId ?? null,
    remoteProductId: product.remoteId ?? null,
    skuCount: product.skuCount,
    stock: product.stock,
    price: product.price ?? null,
    category: product.category ?? null,
    images: product.images ?? [],
    attributes: product.attributes ?? {},
    sellingPoints: product.sellingPoints ?? [],
    factsConfirmed: product.factsConfirmed,
    source: product.source,
    updatedAt: product.updatedAt,
    version: productVersion,
  }

  const scopedTasks = service.listTasks(workspaceId, { productId: product.id, platform: product.platform })
    .filter(task => (task.accountId ?? null) === (product.accountId ?? null))
  const contentCandidates = scopedTasks.flatMap(task => service.listContentVersions(workspaceId, task.id).map(version => ({ task, version })))
    .sort((left, right) => right.version.version - left.version.version || right.task.createdAt.localeCompare(left.task.createdAt))
  const content = contentCandidates[0]
  const contentPreview = content ? {
    id: content.version.id,
    taskId: content.task.id,
    version: content.version.version,
    state: content.version.state,
    body: content.version.body,
    sourceIds: content.version.factVersionIds,
    factSourceIds: content.version.factVersionIds,
  } : null

  const visualPreviewRefs = [...service.imageGenerationJobs.values()]
    .filter(job => job.workspaceId === workspaceId && job.productId === product.id && job.archiveState === 'archived' && job.state === 'succeeded')
    .filter(job => !job.taskId || scopedTasks.some(task => task.id === job.taskId))
    .flatMap(job => (job.outputs ?? []).map(output => output.visualRef))
    .slice(0, 6)
  const execution = {
    mode: 'read_only_preview' as const,
    simulated: false,
    providerExecuted: false,
    modelCalled: false,
    label: '只读预览，未调用真实模型，未发布任何内容',
    message: '只读预览，未调用真实模型，未发布任何内容',
    content: firstValueExecutionLabel('content', Boolean(contentPreview)),
    visual: firstValueExecutionLabel('visual', visualPreviewRefs.length > 0),
  }
  const nextActions = firstValueNextActions(product, Boolean(contentPreview), visualPreviewRefs.length)
  return {
    readOnly: true,
    previewOnly: true,
    product: { id: product.id, productId: product.id, facts: productFacts, sourceIds: [...new Set(productSourceIds)] },
    contentPreview,
    visualPreviewRefs,
    execution,
    nextActions,
    next_actions: nextActions,
  }
}

function scopeTask(req: IncomingMessage, taskId: string) {
  const task = service.getTask(taskId)
  resolveWorkspace(req, task.workspaceId)
  return task
}

async function enforceTaskBrandAccess(req: IncomingMessage, task: { workspaceId: string; brandId?: string }, minimumRole: BrandAccessRole = 'viewer') {
  if (task.brandId) await enforceBrandAccess(req, task.workspaceId, task.brandId, minimumRole)
}

async function filterByTaskBrandAccess<T extends { brandId?: string }>(req: IncomingMessage, workspaceId: string, tasks: T[]) {
  if (!requiresStrictAuth() || hasWorkspaceWideBrandAccess(req)) return tasks
  const actorId = requestPrincipals.get(req)?.actorId
  if (!actorId) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '品权限筛选缺少成员身份', 401)
  const repository = persistence.brandUnits ?? memoryBrandUnits
  const access = new Map<string, boolean>()
  return (await Promise.all(tasks.map(async task => {
    if (!task.brandId) return task
    if (!access.has(task.brandId)) access.set(task.brandId, await repository.hasBrandAccess({ workspaceId, brandId: task.brandId, externalSubject: actorId }))
    return access.get(task.brandId) ? task : undefined
  }))).filter((task): task is T => Boolean(task))
}

function taskRoleForOperation(operation: string, readOnly = false): BrandAccessRole {
  if (readOnly || ['task.history', 'task.timeline', 'content.versions', 'content.diff', 'content.export', 'publish.get'].includes(operation)) return 'viewer'
  if (operation === 'content.approve' || operation.startsWith('publish.')) return 'publisher'
  return 'editor'
}

function scopeContentVersion(req: IncomingMessage, contentVersionId: string) {
  const version = service.contentVersions.get(contentVersionId)
  if (!version) throw new DomainError(ERROR_CODES.CONTENT_VERSION_NOT_FOUND, '内容版本不存在', 404)
  const task = service.getTask(version.taskId)
  resolveWorkspace(req, task.workspaceId)
  return { task, version }
}

function oauthError(error: OAuthStateError): { status: number; code: string } {
  if (error.code === 'STATE_EXPIRED') return { status: 401, code: ERROR_CODES.OAUTH_STATE_EXPIRED }
  if (error.code === 'STATE_SCOPE_MISMATCH') return { status: 403, code: ERROR_CODES.OAUTH_STATE_SCOPE_MISMATCH }
  if (error.code === 'STATE_REPLAYED') return { status: 409, code: ERROR_CODES.OAUTH_STATE_REPLAYED }
  return { status: 400, code: ERROR_CODES.OAUTH_STATE_INVALID }
}

async function consumeTaskUsage(workspaceId: string, taskId: string, idempotencyKey: string, actorId: string) {
  // Recharge is required even when the workspace still has included task
  // quota. This keeps content generation aligned with the plugin's single
  // wallet unlock contract; the quota only determines whether a second debit
  // is needed after the gate passes.
  await assertProviderActionCanStart(workspaceId, `model:${idempotencyKey}`)
  await requirePluginWalletAccess(workspaceId)
  try {
    const charged = await (persistence.usage ?? memoryUsage).consume({ workspaceId, taskId, idempotencyKey, actorId })
    if (charged.charged) {
      try {
        await recordActionSettlement({ workspaceId, actionKey: `model:${idempotencyKey}`, actionKind: 'model_text', settlement: 'included_quota', amountFen: 0, actorId, description: '模型生成调用（套餐行动额度）' })
      } catch (ledgerError) {
        await (persistence.usage ?? memoryUsage).refund({ workspaceId, taskId, idempotencyKey, actorId, reason: '行动账本写入失败，回滚套餐额度' })
        throw ledgerError
      }
      await recordOperationAudit({ workspaceId, actorId, action: 'usage.consume', resourceType: 'task', resourceId: taskId, before: {}, after: charged.snapshot as unknown as Record<string, unknown>, reason: '生成入口额度消费' })
    }
    return { ...charged, settlement: 'included_quota' as const, walletDebited: false }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'QUOTA_EXCEEDED') throw error
    await requirePluginWalletAccess(workspaceId)
    await debitPluginWallet({ workspaceId, idempotencyKey: `model:${idempotencyKey}`, actorId, description: '模型生成调用（套餐额度外）' })
    modelBillingReservations.set(`${workspaceId}:model:${idempotencyKey}`, { debitIdempotencyKey: `model:${idempotencyKey}`, actorId, providerRequests: new Set() })
    await recordOperationAudit({ workspaceId, actorId, action: 'usage.overage.consume', resourceType: 'task', resourceId: taskId, before: {}, after: { idempotency_key: idempotencyKey, settlement: 'wallet_overage' }, reason: '套餐额度用尽后使用钱包余额' })
    return { snapshot: await (persistence.usage ?? memoryUsage).get(workspaceId), charged: false, settlement: 'wallet_overage' as const, walletDebited: true }
  }
}

async function refundTaskUsage(workspaceId: string, taskId: string, idempotencyKey: string, actorId: string, reason: string) {
  modelBillingReservations.delete(`${workspaceId}:model:${idempotencyKey}`)
  const refunded = await (persistence.usage ?? memoryUsage).refund({ workspaceId, taskId, idempotencyKey, actorId, reason })
  await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: `model:${idempotencyKey}`, actorId, reason })
  return refunded
}

async function recordOperationAudit(input: Omit<import('../../../packages/persistence/src/index.js').OperationAudit, 'id' | 'createdAt'>) {
  await (persistence.operations ?? memoryOperations).append(input)
}

async function changeMemberStatusWithAudit(input: { workspaceId: string; externalSubject: string; targetStatus: MemberStatus; actorId: string; action: string; reason: string }) {
  const repository = persistence.members ?? memoryMembers
  const current = (await repository.list(input.workspaceId)).find(item => item.externalSubject === input.externalSubject)
  if (!current) throw new DomainError('MEMBER_NOT_FOUND', '用户在该工作区不存在', 404)
  if (current.status === input.targetStatus) {
    const code = input.targetStatus === 'active' ? 'MEMBER_ALREADY_ACTIVE' : 'MEMBER_ALREADY_SUSPENDED'
    throw new DomainError(code, input.targetStatus === 'active' ? '用户在该工作区已经是激活状态' : '用户在该工作区已经是停用状态', 409)
  }
  const auditInput = { workspaceId: input.workspaceId, actorId: input.actorId, action: input.action, resourceType: 'workspace_member', resourceId: input.externalSubject, before: current as unknown as Record<string, unknown>, reason: input.reason }
  try {
    const changed = await repository.changeStatusWithAudit({ ...input, expectedRevision: current.revision })
    if (repository === memoryMembers) await memoryOperations.append({ ...auditInput, after: changed.member as unknown as Record<string, unknown> })
    return changed.member
  } catch (error) {
    if (error instanceof Error && error.message === 'MEMBER_REVISION_CONFLICT') throw new DomainError('MEMBER_REVISION_CONFLICT', '成员状态已变化，请刷新后重试', 409)
    throw error
  }
}

async function recordGrowthEvent(input: Omit<import('../../../packages/persistence/src/index.js').GrowthEvent, 'id' | 'occurredAt'> & { occurredAt?: string }) {
  await (persistence.growth ?? memoryGrowth).append(input)
}

async function requireActiveCommercialOffer(repository: CommercialExtensionsRepository, code: string, cycle: BillingCycle) {
  const now = Date.now()
  const offer = (await repository.listOffers()).find(item => item.code === code && item.billingCycle === cycle && item.active
    && Date.parse(item.validFrom) <= now
    && (!item.validTo || Date.parse(item.validTo) > now))
  if (!offer) throw new DomainError('COMMERCIAL_OFFER_NOT_AVAILABLE', '套餐不存在、未启用或当前不在销售周期内', 409, { plan_code: code, billing_cycle: cycle })
  return offer
}

async function routeMcp(req: IncomingMessage, res: ServerResponse, input: JsonObject) {
  const request = input as unknown as McpRequest
  const method = typeof request.method === 'string' ? request.method : ''
  const params = paramsOf(input)
  const isPlatformWideUserGovernance = method === 'ops.workspaces.list' || method === 'ops.users.list' || method === 'ops.user.detail' || method === 'ops.user.suspend' || method === 'ops.user.activate' || method === 'ops.user.risk.transition' || method === 'ops.user.session.revoke'
  let workspaceId = method === 'workspace.bootstrap' ? '' : resolveWorkspace(req, isPlatformWideUserGovernance ? undefined : params.workspace_id)
  if (isPlatformWideUserGovernance && typeof params.workspace_id === 'string' && params.workspace_id.trim()) knownWorkspaces.add(params.workspace_id.trim())
  const id = request.id ?? null
  const result = (value: unknown) => send(res, 200, workspaceId, { jsonrpc: '2.0', id, result: value }, null, req)

  // merchant.first_value is kept server-compatible while the shared contract
  // is being extended. Once the contract contains it, this naturally falls
  // through to the normal method/schema validation path.
  const isFirstValueMethod = method === 'merchant.first_value'
  if (!isMcpMethod(method) && !isFirstValueMethod) throw new DomainError(ERROR_CODES.MCP_METHOD_NOT_FOUND, `不支持的 MCP 方法: ${method}`, 404)
  if (isMcpMethod(method)) {
    const validation = validateMcpRequest(input)
    if (!validation.valid) throw new DomainError(ERROR_CODES.INVALID_REQUEST, validation.errors.join('; '), 400)
  }
  if (method !== 'workspace.bootstrap' && !isPlatformWideUserGovernance) {
    await enforceActiveWorkspaceMember(req, workspaceId)
    await requireActiveWorkspace(workspaceId, method)
  }
  if (method !== 'workspace.bootstrap' && !isPlatformWideUserGovernance) requireStoreOnboarding(workspaceId, method)
  if (method !== 'workspace.bootstrap' && !isPlatformWideUserGovernance) await hydrateKnowledge(workspaceId)
  if (typeof params.task_id === 'string' && params.task_id.trim()) {
    const scopedTask = scopeTask(req, params.task_id.trim())
    await enforceTaskBrandAccess(req, scopedTask, taskRoleForOperation(method))
  } else if (typeof params.content_version_id === 'string' && params.content_version_id.trim()) {
    const scoped = scopeContentVersion(req, params.content_version_id.trim())
    await enforceTaskBrandAccess(req, scoped.task, taskRoleForOperation(method))
  }
  switch (method) {
    case 'merchant.first_value':
      return result(merchantFirstValuePreview(workspaceId, params))
    case 'brand-unit.list': {
      const brandId = typeof params.brand_id === 'string' && params.brand_id.trim() ? params.brand_id.trim() : undefined
      const platform = typeof params.platform === 'string' ? params.platform as Platform : undefined
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      if (accountId && !platform) throw new DomainError('STORE_PLATFORM_REQUIRED', '使用 account_id 筛选品时必须同时指定 platform', 400)
      await persistenceReady
      const listed = await (persistence.brandUnits ?? memoryBrandUnits).listBrands({ workspaceId, ...(brandId ? { brandId } : {}), ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}) })
      if (brandId) await enforceBrandAccess(req, workspaceId, brandId)
      const items = !requiresStrictAuth() || hasWorkspaceWideBrandAccess(req)
        ? listed
        : (await Promise.all(listed.map(async item => await (persistence.brandUnits ?? memoryBrandUnits).hasBrandAccess({ workspaceId, brandId: item.id, externalSubject: requestPrincipals.get(req)!.actorId }) ? item : undefined))).filter((item): item is typeof listed[number] => Boolean(item))
      return result({ items, count: items.length, storage: persistence.mode, durable: persistence.mode === 'postgres', ...(persistence.mode === 'memory' ? { message: '当前为本地 fixture 运行；生产环境会写入 PostgreSQL。' } : {}) })
    }
    case 'brand-unit.create': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const name = required(params, 'name').normalize('NFKC').trim()
      if (name.length > 120) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '品名称不能超过 120 个字符', 400)
      const requestedId = typeof params.brand_id === 'string' && params.brand_id.trim() ? params.brand_id.trim() : `brand_unit_${randomUUID().replaceAll('-', '').slice(0, 24)}`
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/u.test(requestedId)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'brand_id 必须是 2 至 64 个字母、数字、下划线或连字符', 400)
      await persistenceReady
      try {
        const unit = await (persistence.brandUnits ?? memoryBrandUnits).createBrand({ workspaceId, id: requestedId, name })
        return result({ ...unit, storage: persistence.mode, durable: persistence.mode === 'postgres', ...(persistence.mode === 'memory' ? { message: '当前为本地 fixture 运行；生产环境会写入 PostgreSQL。' } : {}) })
      } catch (error) {
        if (String(error).includes('BRAND_UNIT_CONFLICT') || (error as { code?: string })?.code === '23505') throw new DomainError('BRAND_UNIT_CONFLICT', 'brand_id 或品名称已存在，请换一个标识', 409, { brand_id: requestedId })
        throw error
      }
    }
    case 'brand-unit.bind-store': {
      const brandId = required(params, 'brand_id')
      await enforceBrandAccess(req, workspaceId, brandId, 'editor')
      const platform = required(params, 'platform') as Platform
      const accountId = required(params, 'account_id')
      await persistenceReady
      const account = isProduction() ? service.getActivePlatformAccount(workspaceId, accountId, platform) : service.getPlatformAccount(workspaceId, accountId, platform)
      if (!account) throw new DomainError('PLATFORM_ACCOUNT_NOT_FOUND', '平台账号不存在或不属于当前工作区', 404)
      try {
        const unit = await (persistence.brandUnits ?? memoryBrandUnits).bindStore({ workspaceId, brandId, platform, accountId })
        return result({ brandUnit: unit, boundStore: { platform: account.platform, accountId: account.id, tokenState: account.tokenState }, storage: persistence.mode, durable: persistence.mode === 'postgres', ...(persistence.mode === 'memory' ? { message: '当前为本地 fixture 运行；生产环境会写入 PostgreSQL。' } : {}) })
      } catch (error) {
        if (String(error).includes('BRAND_UNIT_NOT_FOUND')) throw new DomainError('BRAND_UNIT_NOT_FOUND', '品不存在或不属于当前工作区', 404)
        throw error
      }
    }
    case 'brand-unit.product.create': {
      const brandId = required(params, 'brand_id')
      await enforceBrandAccess(req, workspaceId, brandId, 'editor')
      const title = required(params, 'title').normalize('NFKC').trim()
      if (title.length > 256) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '商品标题不能超过 256 个字符', 400)
      await persistenceReady
      const brands = await (persistence.brandUnits ?? memoryBrandUnits).listBrands({ workspaceId, brandId })
      if (!brands[0]) throw new DomainError('BRAND_UNIT_NOT_FOUND', '品不存在或不属于当前工作区', 404, { brand_id: brandId })
      const id = typeof params.product_id === 'string' && params.product_id.trim() ? params.product_id.trim() : `canonical_product_${randomUUID().replaceAll('-', '').slice(0, 24)}`
      const sourceProductId = typeof params.source_product_id === 'string' && params.source_product_id.trim() ? params.source_product_id.trim() : undefined
      if (sourceProductId) {
        const sourceProduct = service.products.get(sourceProductId)
        if (!sourceProduct || sourceProduct.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', 'source_product_id 不存在或不属于当前工作区', 404, { source_product_id: sourceProductId })
      }
      try {
        const product = await (persistence.brandUnits ?? memoryBrandUnits).createCanonicalProduct({ workspaceId, id, brandId, title, ...(sourceProductId ? { sourceProductId } : {}) })
        return result({ ...product, storage: persistence.mode, durable: persistence.mode === 'postgres' })
      } catch (error) {
        if (String(error).includes('CANONICAL_PRODUCT_CONFLICT') || (error as { code?: string })?.code === '23505') throw new DomainError('CANONICAL_PRODUCT_CONFLICT', 'canonical product_id 已存在，请换一个标识', 409, { product_id: id })
        throw error
      }
    }
    case 'brand-unit.listing.create': {
      const brandId = required(params, 'brand_id')
      await enforceBrandAccess(req, workspaceId, brandId, 'editor')
      const canonicalProductId = required(params, 'canonical_product_id')
      const platform = required(params, 'platform') as Platform
      const accountId = required(params, 'account_id')
      await persistenceReady
      const brands = await (persistence.brandUnits ?? memoryBrandUnits).listBrands({ workspaceId, brandId, platform, accountId })
      if (!brands[0]) throw new DomainError('BRAND_STORE_BINDING_REQUIRED', '创建 listing 前必须先将店铺绑定到该品', 409, { brand_id: brandId, platform, account_id: accountId })
      const account = isProduction() ? service.getActivePlatformAccount(workspaceId, accountId, platform) : service.getPlatformAccount(workspaceId, accountId, platform)
      if (!account) throw new DomainError('PLATFORM_ACCOUNT_NOT_FOUND', '平台账号不存在或不属于当前工作区', 404)
      const id = typeof params.listing_id === 'string' && params.listing_id.trim() ? params.listing_id.trim() : `listing_${randomUUID().replaceAll('-', '').slice(0, 24)}`
      try {
        const listing = await (persistence.brandUnits ?? memoryBrandUnits).createListing({ workspaceId, id, brandId, canonicalProductId, platform, accountId, ...(typeof params.remote_product_id === 'string' && params.remote_product_id.trim() ? { remoteProductId: params.remote_product_id.trim() } : {}) })
        return result({ ...listing, storage: persistence.mode, durable: persistence.mode === 'postgres' })
      } catch (error) {
        if (String(error).includes('LISTING_CONFLICT') || (error as { code?: string })?.code === '23505') throw new DomainError('LISTING_CONFLICT', 'listing_id 已存在，请换一个标识', 409, { listing_id: id })
        if ((error as { code?: string })?.code === '23503' || String(error).includes('PRODUCT_LISTING')) throw new DomainError('CANONICAL_PRODUCT_NOT_FOUND', 'canonical product 不存在或不属于当前工作区', 404, { canonical_product_id: canonicalProductId })
        throw error
      }
    }
    case 'brand-unit.listing.list': {
      await persistenceReady
      const brandId = typeof params.brand_id === 'string' && params.brand_id.trim() ? params.brand_id.trim() : undefined
      if (brandId) await enforceBrandAccess(req, workspaceId, brandId)
      const listed = await (persistence.brandUnits ?? memoryBrandUnits).listListings({ workspaceId, ...(brandId ? { brandId } : {}), ...(typeof params.canonical_product_id === 'string' && params.canonical_product_id.trim() ? { canonicalProductId: params.canonical_product_id.trim() } : {}), ...(typeof params.platform === 'string' ? { platform: params.platform as Platform } : {}), ...(typeof params.account_id === 'string' && params.account_id.trim() ? { accountId: params.account_id.trim() } : {}) })
      const listings = !requiresStrictAuth() || hasWorkspaceWideBrandAccess(req)
        ? listed
        : (await Promise.all(listed.map(async item => await (persistence.brandUnits ?? memoryBrandUnits).hasBrandAccess({ workspaceId, brandId: item.brandId, externalSubject: requestPrincipals.get(req)!.actorId }) ? item : undefined))).filter((item): item is typeof listed[number] => Boolean(item))
      return result({ items: listings, count: listings.length, storage: persistence.mode, durable: persistence.mode === 'postgres' })
    }
    case 'brand-unit.access.grant': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const brandId = required(params, 'brand_id')
      const role = required(params, 'role') as BrandAccessRole
      if (!['viewer', 'editor', 'publisher', 'admin'].includes(role)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '品权限角色无效', 400)
      await enforceBrandAccess(req, workspaceId, brandId, 'admin')
      const externalSubject = required(params, 'external_subject')
      try {
        await (persistence.brandUnits ?? memoryBrandUnits).grantBrandAccess({ workspaceId, brandId, externalSubject, role })
      } catch (error) {
        if (String(error).includes('ACTIVE_MEMBER_NOT_FOUND')) throw new DomainError('ACTIVE_MEMBER_NOT_FOUND', '只能向当前工作区的 active 成员授予品权限', 404)
        if (String(error).includes('BRAND_UNIT_NOT_FOUND') || (error as { code?: string })?.code === '23503') throw new DomainError('BRAND_UNIT_NOT_FOUND', '品不存在或不属于当前工作区', 404)
        throw error
      }
      await recordOperationAudit({ workspaceId, actorId: requestPrincipals.get(req)?.actorId ?? 'actor_demo', action: 'brand.access.grant', resourceType: 'brand', resourceId: brandId, before: {}, after: { externalSubject, role }, reason: typeof params.reason === 'string' ? params.reason : '更新品权限' })
      return result({ brandId, externalSubject, role })
    }
    case 'campaign.batch.create': {
      const brandId = required(params, 'brand_id')
      await enforceBrandAccess(req, workspaceId, brandId, 'editor')
      await persistenceReady
      let targets = params.targets_json !== undefined
        ? parseCampaignTargets(params.targets_json)
        : [{ productId: '', platform: required(params, 'platform') as Platform, accountId: required(params, 'account_id') }]
      const legacyProductIds = params.targets_json === undefined ? parseCampaignProductIds(params.product_ids_json) : targets.filter(target => target.productId).map(target => target.productId)
      if (params.targets_json === undefined) targets.splice(0, 1, ...legacyProductIds.map(productId => ({ productId, platform: targets[0]!.platform, accountId: targets[0]!.accountId })))
      if (params.targets_json !== undefined) {
        targets = await Promise.all(targets.map(async target => {
          if (target.productId) return target
          const canonical = target.canonicalProductId ? await (persistence.brandUnits ?? memoryBrandUnits).getCanonicalProduct({ workspaceId, id: target.canonicalProductId }) : undefined
          if (!canonical) throw new DomainError('CANONICAL_PRODUCT_NOT_FOUND', 'canonical product 不存在或不属于当前工作区', 404, { canonical_product_id: target.canonicalProductId })
          const listing = target.listingId
            ? (await (persistence.brandUnits ?? memoryBrandUnits).listListings({ workspaceId, brandId, listingId: target.listingId, platform: target.platform, accountId: target.accountId }))[0]
            : undefined
          if (target.listingId && (!listing || listing.canonicalProductId !== canonical.id)) throw new DomainError('LISTING_TARGET_MISMATCH', 'listing_id 不属于当前品、平台或店铺', 409, { listing_id: target.listingId, brand_id: brandId, platform: target.platform, account_id: target.accountId })
          const listingProduct = listing?.remoteProductId
            ? service.listProducts(workspaceId, { platform: target.platform, accountId: target.accountId, remoteProductId: listing.remoteProductId })[0]
            : undefined
          if (listingProduct) return { ...target, productId: listingProduct.id }
          const sourceProduct = canonical.sourceProductId ? service.products.get(canonical.sourceProductId) : undefined
          if (sourceProduct?.workspaceId === workspaceId && sourceProduct.platform === target.platform && sourceProduct.accountId === target.accountId) return { ...target, productId: sourceProduct.id }
          throw new DomainError('LISTING_PRODUCT_FACTS_REQUIRED', '该平台店铺的 listing 尚未同步对应商品事实，不能使用其他平台商品替代', 409, {
            canonical_product_id: canonical.id,
            listing_id: listing?.id ?? null,
            platform: target.platform,
            account_id: target.accountId,
            remote_product_id: listing?.remoteProductId ?? null,
            next_actions: ['先同步该店铺商品，并让 listing.remote_product_id 对应平台商品 ID'],
          })
        }))
      }
      for (const target of targets) {
        const units = await (persistence.brandUnits ?? memoryBrandUnits).listBrands({ workspaceId, brandId, platform: target.platform, accountId: target.accountId })
        if (!units[0]) throw new DomainError('BRAND_STORE_BINDING_REQUIRED', '创建批量运营计划前，必须先将该店铺绑定到指定品', 409, { brand_id: brandId, platform: target.platform, account_id: target.accountId, next_actions: ['调用 brand-unit.bind-store 绑定店铺'] })
        if (target.listingId) {
          const listings = await (persistence.brandUnits ?? memoryBrandUnits).listListings({ workspaceId, brandId, listingId: target.listingId, platform: target.platform, accountId: target.accountId })
          if (!listings[0] || (target.canonicalProductId && listings[0].canonicalProductId !== target.canonicalProductId)) throw new DomainError('LISTING_TARGET_MISMATCH', 'listing_id 不属于当前品、平台或店铺', 409, { listing_id: target.listingId, brand_id: brandId, platform: target.platform, account_id: target.accountId })
        }
        const account = isProduction() ? service.getActivePlatformAccount(workspaceId, target.accountId, target.platform) : service.getPlatformAccount(workspaceId, target.accountId, target.platform)
        if (!account) throw new DomainError('PLATFORM_ACCOUNT_NOT_FOUND', '平台账号不存在或不属于当前工作区', 404)
        const productId = target.productId
        const product = service.products.get(productId)
        if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', `商品 ${productId} 不存在或不属于当前工作区`, 404, { product_id: productId })
        if (product.platform !== target.platform || product.accountId !== target.accountId) throw new DomainError('PRODUCT_STORE_CONTEXT_MISMATCH', `商品 ${productId} 不属于所选平台店铺`, 409, { product_id: productId, expected: { platform: target.platform, account_id: target.accountId }, actual: { platform: product.platform, account_id: product.accountId ?? null } })
      }
      const platform = targets[0]!.platform
      const accountId = targets[0]!.accountId
      const productIds = [...new Set(targets.map(target => target.productId))]
      const idempotencyKey = (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) || header(req, 'idempotency-key')?.trim() || undefined
      let created
      try {
        created = await (persistence.brandUnits ?? memoryBrandUnits).createCampaign({ id: `campaign_batch_${randomUUID().replaceAll('-', '').slice(0, 24)}`, workspaceId, brandId, platform, accountId, productIds, targets, state: 'draft', ...(idempotencyKey ? { idempotencyKey } : {}) })
      } catch (error) {
        if ((error as { code?: string })?.code === 'CAMPAIGN_IDEMPOTENCY_CONFLICT' || String(error).includes('CAMPAIGN_IDEMPOTENCY_CONFLICT')) throw new DomainError('CAMPAIGN_IDEMPOTENCY_CONFLICT', '幂等键已绑定到另一份批量运营计划，请换用新的幂等键', 409, { idempotency_key: idempotencyKey })
        throw error
      }
      return result({ ...created.campaign, count: productIds.length, replayed: created.replayed, storage: persistence.mode, durable: persistence.mode === 'postgres', execution: 'plan_only', message: '批量运营计划已持久化；当前仍需通过审核后任务流程生成和发布。' })
    }
    case 'campaign.batch.get': {
      const campaignId = required(params, 'campaign_id')
      await persistenceReady
      let campaign = await (persistence.brandUnits ?? memoryBrandUnits).getCampaign({ workspaceId, id: campaignId })
      if (!campaign) throw new DomainError('CAMPAIGN_BATCH_NOT_FOUND', '批量运营计划不存在或不属于当前工作区', 404, { campaign_id: campaignId })
      await enforceBrandAccess(req, workspaceId, campaign.brandId)
      campaign = await refreshCampaignProgress(campaign)
      return result({ ...campaign, count: campaign.productIds.length, ...campaignWorkflow(campaign), storage: persistence.mode, durable: persistence.mode === 'postgres', execution: campaign.taskIds?.length ? 'workflow_active' : 'plan_only', message: campaign.taskIds?.length ? '批量工作流已激活；每个商品会停在需要事实确认、方向确认、审核或发布确认的安全节点。' : '批量运营计划已持久化；调用 campaign.batch.generate 创建逐商品工作流。' })
    }
    case 'campaign.batch.generate': {
      await requirePluginWalletAccess(workspaceId)
      await persistenceReady
      const campaignId = required(params, 'campaign_id')
      const campaign = await (persistence.brandUnits ?? memoryBrandUnits).getCampaign({ workspaceId, id: campaignId })
      if (!campaign) throw new DomainError('CAMPAIGN_BATCH_NOT_FOUND', '批量运营计划不存在或不属于当前工作区', 404, { campaign_id: campaignId })
      await enforceBrandAccess(req, workspaceId, campaign.brandId, 'editor')
      const priorTaskIds = campaign.taskIds
      if (priorTaskIds) {
        const refreshed = await refreshCampaignProgress(campaign)
        return result({ campaignId, taskIds: priorTaskIds, count: priorTaskIds.length, state: refreshed.state, ...campaignWorkflow(refreshed), replayed: true, execution: 'workflow_active', next_actions: [...new Set((refreshed.items ?? []).map(item => item.error?.nextAction).filter((action): action is string => Boolean(action)))] })
      }
      const requestText = typeof params.request_text === 'string' && params.request_text.trim() ? params.request_text.trim() : undefined
      const taskIds: string[] = []
      const targets: Array<{ productId: string; platform: Platform; accountId: string; canonicalProductId?: string; listingId?: string }> = campaign.targets ?? campaign.productIds.map(productId => ({ productId, platform: campaign.platform, accountId: campaign.accountId }))
      for (const [index, target] of targets.entries()) {
        const productId = target.productId
        const product = service.products.get(productId)
        if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', `商品 ${productId} 不存在或不属于当前工作区`, 404, { product_id: productId })
        const campaignItem = campaign.items?.[index]
        if (!campaignItem) throw new DomainError('CAMPAIGN_ITEM_MISSING', '批量运营计划缺少持久化明细，已停止创建任务', 409, { campaign_id: campaignId, ordinal: index + 1 })
        const deterministicTaskId = `task_campaign_${createHash('sha256').update(`${workspaceId}:${campaignId}:${campaignItem.id}`).digest('hex').slice(0, 32)}`
        const existingTask = service.tasks.has(deterministicTaskId)
        const task = service.createTask({ workspaceId, productId, platform: target.platform, accountId: target.accountId, brandId: campaign.brandId, ...(target.canonicalProductId ? { canonicalProductId: target.canonicalProductId } : {}), ...(target.listingId ? { listingId: target.listingId } : {}), campaignId, campaignItemId: campaignItem.id, taskId: deterministicTaskId, ...(requestText ? { requestText } : {}) })
        taskIds.push(task.id)
        if (!existingTask) {
          await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
          await persistEvent(workspaceId, task.id, 'task.created', task.version, { ...task, campaign_id: campaignId, listing_id: target.listingId ?? null, source: 'campaign.batch.generate' })
        }
      }
      await (persistence.brandUnits ?? memoryBrandUnits).updateCampaignTasks({ workspaceId, id: campaignId, taskIds, state: 'generating' })
      const refreshed = await refreshCampaignProgress((await (persistence.brandUnits ?? memoryBrandUnits).getCampaign({ workspaceId, id: campaignId }))!)
      const workflow = campaignWorkflow(refreshed)
      return result({ campaignId, taskIds, count: taskIds.length, state: refreshed.state, ...workflow, replayed: false, execution: 'workflow_active', message: '已为每个商品创建独立工作流；系统会持久化当前节点，不会越过事实确认、方向确认、内容审核或发布确认。', next_actions: [...new Set((refreshed.items ?? []).map(item => item.error?.nextAction).filter((action): action is string => Boolean(action)))] })
    }
    case 'workspace.bootstrap': {
      const displayName = required(params, 'display_name')
      if (displayName.length > 120) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'display_name 不能超过 120 个字符', 400)
      const actorId = requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant_owner'
      if (!actorId) throw new DomainError(ERROR_CODES.UNAUTHENTICATED, '创建工作区需要可识别的商家身份', 401)
      const externalSubject = typeof params.external_subject === 'string' && params.external_subject.trim() ? params.external_subject.trim() : actorId
      if (requiresStrictAuth() && externalSubject !== actorId) throw new DomainError(ERROR_CODES.FORBIDDEN, '受控环境新工作区 owner 必须绑定当前认证身份', 403)
      workspaceId = `ws_${randomUUID().replaceAll('-', '').slice(0, 24)}`
      knownWorkspaces.add(workspaceId)
      await persistence.ensureWorkspace?.(workspaceId)
      await (persistence.members ?? memoryMembers).upsert({ workspaceId, externalSubject, displayName, role: 'workspace_owner', status: 'active', invitedBy: actorId })
      await recordOperationAudit({ workspaceId, actorId, action: 'workspace.bootstrap', resourceType: 'workspace', resourceId: workspaceId, before: {}, after: { workspaceId, displayName, owner: externalSubject, status: 'active' }, reason: '首次运行创建工作区' })
      return result({ workspaceId, displayName, status: 'active', owner: { externalSubject, actorId }, binding: { environmentVariable: 'MERCHANT_WORKSPACE_ID', requiredValue: workspaceId, nextStep: '将该值绑定到 Codex 插件后重新调用 workspace.health' } })
    }
    case 'workspace.interactive.confirm':
      return result({ enabled: true, scope: 'current_interactive_session', expires_in_seconds: 900, automation: 'read_only', message: '仅当前交互会话开放写操作；钱包、事实、审核、平台能力和发布确认门禁仍然生效' })
    case 'merchant.start': {
      const directory = workspaceStoreDirectory(workspaceId)
      const onboarding = workspaceOnboarding(workspaceId, directory)
      const setup = setupDiagnostics()
      await persistenceReady
      const brandNavigation = await accessibleBrandNavigation(req, workspaceId)
      const startWalletBalanceFen = persistence.billing ? await persistence.billing.balanceFen(workspaceId) : walletBalanceFen(workspaceId)
      // A subscription quota is reported separately, but the plugin's paid
      // capability card must only say "unlocked" after wallet settlement.
      // Generation/publish gates already use the same wallet boundary.
      const walletUnlocked = startWalletBalanceFen > 0
      const current = onboarding.currentStep
      const platformOptions = merchantPlatformOptions(workspaceId, directory)
      const nextPrompt = current.id === 'bind-store'
        ? '选择一个平台连接我的店铺'
        : current.id === 'choose-product'
          ? '查看我当前店铺的商品'
          : current.id === 'add-assets'
            ? '上传我的商品图片和资料'
            : '开始为这个商品制作营销内容'
      return result({
        greeting: '欢迎使用大麦。',
        productName: '大麦商家营销助手',
        workspace: { id: workspaceId, status: (await getWorkspaceStatus(workspaceId)) === 'active' ? 'ready' : 'disabled' },
        currentStep: current,
        nextPrompt,
        nextInstruction: `你可以直接说：“${nextPrompt}”。`,
        onboarding: onboarding.steps,
        summary: onboarding.summary,
        wallet: {
          balance_cny: (startWalletBalanceFen / 100).toFixed(2),
          unlocked: walletUnlocked,
          recharge_channels: ['alipay', 'wechat'],
          status_method: 'billing.status',
          recharge_method: 'billing.recharge.create',
          message: walletUnlocked ? '已解锁生成、图片、视频、OCR、SEO/GEO 和发布能力' : '充值到账后解锁生成、图片、视频、OCR、SEO/GEO 和发布能力',
        },
        stores: directory.map(store => ({ platform: store.platform, label: store.label, state: store.state, dataMode: store.dataMode, readable: store.readable, writeEnabled: store.writeEnabled })),
        availablePlatforms: SUPPORTED_PLATFORMS,
        platformOptions,
        brandNavigation: { title: '我的品', presentation: 'tree', hierarchy: ['brand', 'platform', 'store'], items: brandNavigation, emptyState: '尚未创建品；先创建一个品，再绑定不同平台和店铺。' },
        modelAccess: { ownership: 'platform', userKeyRequired: false, relay: setup.ai.relay, text: setup.ai.contentGeneration, image: setup.ai.imageGeneration, imageEdit: setup.ai.imageEditing, ocr: setup.ai.imageFacts, video: setup.ai.videoRendering },
        cards: MERCHANT_CAPABILITY_CARDS.map(card => {
          const onboardingState = card.id === 'stores-products' ? onboarding.steps.find(step => step.id === 'choose-product')?.state
            : card.id === 'knowledge-assets' ? onboarding.steps.find(step => step.id === 'add-assets')?.state
              : card.id === 'content' ? onboarding.steps.find(step => step.id === 'start-content')?.state
                : card.id === 'first-value' ? 'available'
                : directory.length ? 'available' : 'needs_store'
          const cta = card.id === 'stores-products' ? '选择店铺并查看商品' : card.id === 'knowledge-assets' ? '上传商品图片和资料' : card.id === 'content' ? '开始内容任务' : card.title
          const action = merchantCapabilityCardAction(card, onboarding, directory)
          const paidCapability = ['content', 'visuals', 'review-publish', 'bulk-publish'].includes(card.id)
          const capabilityGate = paidCapability ? { unlocked: walletUnlocked, method: 'billing.status', reason: walletUnlocked ? '钱包已到账；仍需事实、审核和交互确认门禁' : '充值到账后解锁该能力；授权、只读商品查看和创建充值订单仍可继续' } : undefined
          return { id: card.id, title: card.title, summary: card.summary, entryMethod: card.entryMethod, readOnly: card.readOnly, state: onboardingState, cta, requiredScope: card.id === 'stores-products' || card.id === 'content' ? 'platform + accountId' : 'workspace', ...(capabilityGate ? { capabilityGate } : {}), action: { ...action, confirmation: card.readOnly ? 'none' : 'interactive_confirmation' }, blocked_by: action.blocked_by, next_actions: [{ method: action.method, arguments: action.arguments, reason: action.reason, required_inputs: action.required_inputs }] }
        }),
      })
    }
    case 'workspace.health': {
      const directory = workspaceStoreDirectory(workspaceId)
      const onboarding = workspaceOnboarding(workspaceId, directory).steps
      const workspaceRules = await rulePacksForWorkspace(workspaceId)
      const brandNavigation = await accessibleBrandNavigation(req, workspaceId)
      return result({
      ...runtimeHealth(),
      persistence: { mode: persistence.mode, ready: !persistenceError, ...(invalidDurableSnapshots.get(workspaceId)?.length ? { invalidSnapshots: invalidDurableSnapshots.get(workspaceId) } : {}) },
      plugin: { name: 'merchant-marketing', version: '0.1.0' },
      mcp: { status: 'ready', transport: '/mcp' },
      workspace: { id: workspaceId, status: (await getWorkspaceStatus(workspaceId)) === 'active' ? 'ready' : 'disabled' },
      rules: { activeVersions: service.ruleCenter.activeVersionIds() },
      ruleSync: platformRuleSyncStatus(workspaceRules, {
        intervalHours: Number(process.env.PLATFORM_RULE_SYNC_INTERVAL_HOURS ?? 24),
        manifestUrl: process.env.PLATFORM_RULE_SYNC_MANIFEST_URL,
        signingSecretConfigured: Boolean(process.env.PLATFORM_RULE_SYNC_SIGNING_SECRET?.trim()),
      }),
      connectorReadiness: Object.fromEntries(SUPPORTED_PLATFORMS.map(platform => [platform, workspaceConnectorReadiness(platform)])),
      platforms: workspacePlatformStatus(workspaceId),
      commercial: { settings: await (persistence.commercial ?? memoryCommercial).getSettings(workspaceId), platforms: await (persistence.commercial ?? memoryCommercial).listPlatformSettings(workspaceId) },
      storeDirectory: directory,
      storeSelection: { requiredForStoreActions: true, key: 'platform + accountId', warning: '别名和店铺名只用于展示与候选匹配，不能替代账号范围确认' },
      capabilityCards: {
        title: '大麦工作台',
        presentation: 'conversation_cards',
        instruction: '优先展示这些卡片；商家选择卡片后再调用 entryMethod，不要求商家记忆工具名或内部 ID。店铺级操作先展示导航列表并确认平台与账号范围。',
        navigation: {
          title: '平台与店铺',
          presentation: 'grouped_list',
          selectionKey: 'platform + accountId',
          items: [
            { id: 'all-stores', title: '全部店铺', scope: 'workspace', action: { method: 'catalog.search', arguments: { scope: 'workspace' } } },
            ...directory.map(store => ({
              id: `store:${store.platform}:${store.accountId}`,
              title: store.label,
              platform: store.platform,
              accountId: store.accountId,
              state: store.state,
              dataMode: store.dataMode,
              readable: store.readable,
              writeEnabled: store.writeEnabled,
              action: { method: 'catalog.search', arguments: { scope: 'store', platform: store.platform, account_id: store.accountId } },
            })),
          ],
          emptyState: '尚未绑定店铺；先选择平台并完成官方授权，再同步商品。',
        },
        brandNavigation: { title: '我的品', presentation: 'tree', hierarchy: ['brand', 'platform', 'store'], items: brandNavigation, emptyState: '尚未创建品；先调用 brand-unit.create，再调用 brand-unit.bind-store。' },
        onboarding,
        cards: MERCHANT_CAPABILITY_CARDS.map(card => ({ ...card, writeGate: card.readOnly ? 'none' : 'interactive_confirmation' })),
      },
    })
    }
    case 'workspace.commercial.get':
      return result({ settings: await (persistence.commercial ?? memoryCommercial).getSettings(workspaceId), platforms: await (persistence.commercial ?? memoryCommercial).listPlatformSettings(workspaceId), usage: await (persistence.usage ?? memoryUsage).get(workspaceId), subscription: await (persistence.subscriptions ?? memorySubscriptions).get(workspaceId), orders: await (persistence.subscriptions ?? memorySubscriptions).listOrders(workspaceId, 20), entitlements: await (persistence.entitlements ?? memoryEntitlements).list(workspaceId) })
    case 'subscription.get':
      return result({ ...(await (persistence.subscriptions ?? memorySubscriptions).get(workspaceId)), entitlements: await (persistence.entitlements ?? memoryEntitlements).list(workspaceId) })
    case 'subscription.orders.list': {
      const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Number(params.limit) : 50
      return result(await (persistence.subscriptions ?? memorySubscriptions).listOrders(workspaceId, limit))
    }
    case 'subscription.order.create': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'finance'])
      requireProviderPaymentConfigured()
      const channel = paymentChannel(params)
      const cycle = required(params, 'billing_cycle') as BillingCycle
      if (!['monthly', 'annual'].includes(cycle)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'billing_cycle 必须是 monthly 或 annual', 400)
      const subscriptionRepository = persistence.subscriptions ?? memorySubscriptions
      const idempotencyKey = required(params, 'idempotency_key')
      const extensionRepository = persistence.commercialExtensions ?? memoryCommercialExtensions
      const planCode = required(params, 'plan_code')
      const offer = await requireActiveCommercialOffer(extensionRepository, planCode, cycle)
      let addonCodes: string[] = []
      if (typeof params.addon_codes_json === 'string' && params.addon_codes_json.trim()) {
        try { const parsed = JSON.parse(params.addon_codes_json) as unknown; if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('invalid'); addonCodes = [...new Set(parsed)] } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'addon_codes_json 必须是字符串数组', 400) }
      }
      const addons = await extensionRepository.listAddons()
      const selectedAddons = addonCodes.map(code => addons.find(item => item.code === code && item.active))
      if (selectedAddons.some(item => !item)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '存在不可用的加购能力', 400)
      const addonTotal = selectedAddons.reduce((sum, item) => sum + (item?.priceCny ?? 0), 0)
      const subtotal = Number((offer.priceCny + addonTotal).toFixed(2))
      const couponCode = typeof params.coupon_code === 'string' && params.coupon_code.trim() ? params.coupon_code.trim() : undefined
      const sourceChannel = typeof params.source_channel === 'string' ? params.source_channel : undefined
      const intent = JSON.stringify({ planCode: offer.code, planName: offer.name, billingCycle: offer.billingCycle, priceCny: subtotal, couponCode: couponCode ?? null, addonCodes: [...addonCodes].sort(), sourceChannel: sourceChannel ?? null, paymentProvider: channel })
      const existingOrder = (await subscriptionRepository.listOrders(workspaceId, 100)).find(item => item.idempotencyKey === idempotencyKey)
      if (existingOrder) {
        const existingIntent = JSON.stringify({ planCode: existingOrder.planCode, planName: existingOrder.planName, billingCycle: existingOrder.billingCycle, priceCny: existingOrder.priceCny, couponCode: existingOrder.couponCode ?? null, addonCodes: [...existingOrder.addonCodes].sort(), sourceChannel: existingOrder.sourceChannel ?? null, paymentProvider: existingOrder.paymentProvider })
        if (existingIntent !== intent) throw new DomainError('SUBSCRIPTION_ORDER_IDEMPOTENCY_CONFLICT', '订阅订单幂等键已被其他订单意图使用', 409)
        return result(existingOrder)
      }
      const inFlightKey = `${workspaceId}:${idempotencyKey}`
      const inFlight = subscriptionCreationInFlight.get(inFlightKey)
      if (inFlight) {
        if (inFlight.intent !== intent) throw new DomainError('SUBSCRIPTION_ORDER_IDEMPOTENCY_CONFLICT', '订阅订单幂等键已被其他订单意图使用', 409)
        return result(await inFlight.promise)
      }
      const promise = (async () => {
        let paymentAmount = subtotal
        let couponRedeemed = false
        if (couponCode) {
          let coupon
          try { coupon = await extensionRepository.redeemCoupon(couponCode) } catch (error) { if (error instanceof Error && error.message === 'COUPON_NOT_REDEEMABLE') throw new DomainError('COUPON_NOT_REDEEMABLE', '优惠券不存在、已停用、已过期或已达到核销上限', 409); throw error }
          const discount = coupon.discountType === 'percent' ? subtotal * coupon.discountValue / 100 : coupon.discountValue
          paymentAmount = Number(Math.max(0, subtotal - discount).toFixed(2))
          couponRedeemed = true
        }
        const orderNo = `SO${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`
        let checkout: Awaited<ReturnType<typeof createSubscriptionCheckout>>
        try {
          checkout = await createSubscriptionCheckout({ channel, orderId: orderNo, idempotencyKey, workspaceId, amountFen: Math.round(paymentAmount * 100), kind: 'subscriptions' })
        } catch (error) {
          if (couponCode && couponRedeemed) {
            try { await extensionRepository.restoreCoupon(couponCode) } catch { throw new DomainError('COUPON_ROLLBACK_FAILED', '支付下单失败且优惠券回滚失败，请联系运营处理', 503) }
          }
          throw error
        }
        let order
        try {
          order = await subscriptionRepository.createOrder({ workspaceId, orderNo, planCode: offer.code, planName: offer.name, billingCycle: offer.billingCycle, priceCny: subtotal, paymentAmountCny: paymentAmount, includedStores: offer.includedStores, includedTasks: offer.includedTasks, couponCode, addonCodes, sourceChannel, paymentProvider: channel, paymentUrl: checkout.paymentUrl, idempotencyKey })
        } catch (error) {
          if (couponCode) {
            try { await extensionRepository.restoreCoupon(couponCode) } catch { throw new DomainError('COUPON_ROLLBACK_FAILED', '订单创建失败且优惠券回滚失败，请联系运营处理', 503) }
          }
          throw error
        }
        await recordOperationAudit({ workspaceId, actorId: requestPrincipals.get(req)?.actorId ?? 'actor_demo', action: 'subscription.order.create', resourceType: 'subscription_order', resourceId: order.orderNo, before: {}, after: order as unknown as Record<string, unknown>, reason: '创建订阅订单' })
        await recordGrowthEvent({ workspaceId, eventType: 'subscription.order.created', sourceChannel: order.sourceChannel, actorId: requestPrincipals.get(req)?.actorId ?? 'actor_demo', planCode: order.planCode, metadata: { orderNo: order.orderNo, paymentAmountCny: order.paymentAmountCny, couponCode: order.couponCode, addonCodes: order.addonCodes } })
        return { ...order, ...(checkout.providerOrderId ? { provider_order_id: checkout.providerOrderId } : {}), ...(checkout.expiresAt ? { expires_at: checkout.expiresAt } : {}), warning: process.env.PAYMENT_MODE === 'provider' ? '请完成支付，系统只接受支付服务商签名回调后激活订阅' : '当前为本地 fixture，不会产生真实扣款' }
      })()
      subscriptionCreationInFlight.set(inFlightKey, { intent, promise })
      try { return result(await promise) } finally { subscriptionCreationInFlight.delete(inFlightKey) }
    }
    case 'subscription.change': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'finance'])
      const toPlanCode = required(params, 'to_plan_code'); const cycle = required(params, 'billing_cycle') as BillingCycle
      if (!['monthly', 'annual'].includes(cycle)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'billing_cycle 必须是 monthly 或 annual', 400)
      const reason = required(params, 'reason')
      const rawIdempotencyKey = required(params, 'idempotency_key')
      const requestedEffectiveAt = typeof params.effective_at === 'string' && params.effective_at ? params.effective_at : null
      const requestedChannel = params.channel === 'alipay' || params.channel === 'wechat' ? params.channel : null
      const intent = JSON.stringify({ toPlanCode, billingCycle: cycle, effectiveAt: requestedEffectiveAt, reason, paymentProvider: requestedChannel })
      const inFlightKey = `${workspaceId}:${rawIdempotencyKey}`
      const inFlight = subscriptionChangeInFlight.get(inFlightKey)
      if (inFlight) {
        if (inFlight.intent !== intent) throw new DomainError('SUBSCRIPTION_CHANGE_IDEMPOTENCY_CONFLICT', '套餐变更幂等键已被其他变更意图使用', 409)
        return result(await inFlight.promise)
      }
      const promise = (async () => {
        const current = await (persistence.subscriptions ?? memorySubscriptions).get(workspaceId)
        const offer = await requireActiveCommercialOffer(persistence.commercialExtensions ?? memoryCommercialExtensions, toPlanCode, cycle)
        const difference = Number((offer.priceCny - current.priceCny).toFixed(2)); const upgrade = difference > 0
        const effectiveAt = requestedEffectiveAt ?? (upgrade ? new Date().toISOString() : current.currentPeriodEnd)
        if (Number.isNaN(Date.parse(effectiveAt))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'effective_at 必须是有效时间', 400)
        const channel = upgrade ? paymentChannel(params) : undefined
        const changeIdempotencyKey = `change:${workspaceId}:${rawIdempotencyKey}`
        let order: unknown
        if (upgrade) {
          requireProviderPaymentConfigured()
          const subscriptionRepository = persistence.subscriptions ?? memorySubscriptions
          const existingOrder = (await subscriptionRepository.listOrders(workspaceId, 100)).find(item => item.idempotencyKey === changeIdempotencyKey)
          if (existingOrder) {
            if (existingOrder.planCode !== offer.code || existingOrder.planName !== offer.name || existingOrder.billingCycle !== offer.billingCycle || existingOrder.priceCny !== offer.priceCny || existingOrder.paymentAmountCny !== difference || existingOrder.includedStores !== offer.includedStores || existingOrder.includedTasks !== offer.includedTasks || existingOrder.paymentProvider !== channel) throw new DomainError('SUBSCRIPTION_CHANGE_IDEMPOTENCY_CONFLICT', '套餐变更幂等键已被其他变更意图使用', 409)
            order = existingOrder
            const existingChange = await (persistence.commercialExtensions ?? memoryCommercialExtensions).getPendingChange(workspaceId)
            if (existingChange && existingChange.fromPlanCode === current.planCode && existingChange.fromPriceCny === current.priceCny && existingChange.toPlanCode === offer.code && existingChange.toPriceCny === offer.priceCny && existingChange.billingCycle === cycle && existingChange.priceDifferenceCny === difference && (requestedEffectiveAt === null || existingChange.effectiveAt === effectiveAt) && existingChange.reason === reason) {
              return { change: existingChange, order, mode: 'upgrade_payment_required' }
            }
          } else {
            const orderNo = `SO${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`
            const checkout = await createSubscriptionCheckout({ channel: channel!, orderId: orderNo, idempotencyKey: changeIdempotencyKey, workspaceId, amountFen: Math.round(difference * 100), kind: 'subscriptions' })
            order = await subscriptionRepository.createOrder({ workspaceId, orderNo, planCode: offer.code, planName: offer.name, billingCycle: offer.billingCycle, priceCny: offer.priceCny, paymentAmountCny: difference, includedStores: offer.includedStores, includedTasks: offer.includedTasks, paymentProvider: channel!, paymentUrl: checkout.paymentUrl, idempotencyKey: changeIdempotencyKey })
          }
        }
        const change = await (persistence.commercialExtensions ?? memoryCommercialExtensions).scheduleChange({ workspaceId, fromPlanCode: current.planCode, toPlanCode: offer.code, fromPriceCny: current.priceCny, toPriceCny: offer.priceCny, billingCycle: cycle, priceDifferenceCny: difference, effectiveAt, reason, createdBy: actorId })
        await recordOperationAudit({ workspaceId, actorId, action: 'subscription.change', resourceType: 'subscription_change', resourceId: change.id, before: current as unknown as Record<string, unknown>, after: { change, order } as unknown as Record<string, unknown>, reason: change.reason })
        return { change, order, mode: upgrade ? 'upgrade_payment_required' : 'downgrade_next_period' }
      })()
      subscriptionChangeInFlight.set(inFlightKey, { intent, promise })
      try { return result(await promise) } finally { subscriptionChangeInFlight.delete(inFlightKey) }
    }
    case 'workspace.usage.get':
      return result(await (persistence.usage ?? memoryUsage).get(workspaceId))
    case 'ops.members.list':
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'platform_ops'])
      return result(await (persistence.members ?? memoryMembers).list(workspaceId))
    case 'ops.session': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'finance', 'platform_ops', 'rules_admin', 'knowledge_editor', 'knowledge_reader', 'competitor_reviewer'])
      const principal = requestPrincipals.get(req)
      return result({ actor_id: actorId, workspace_id: workspaceId, roles: principal?.roles ?? [], workspace_granted: principal?.workspaces.includes('*') || principal?.workspaces.includes(workspaceId) || !requiresStrictAuth(), identity_id: principal?.identityId ?? null, session_id: principal?.sessionId ?? null, identity_status: principal?.identityStatus ?? null, risk_decision: principal?.riskDecision ?? null, mfa_verified: principal?.mfaVerified ?? false, session_expires_at: principal?.sessionExpiresAt ?? null })
    }
    case 'ops.workspaces.list': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'finance', 'platform_ops'])
      const principal = requestPrincipals.get(req)
      const granted = requiresStrictAuth() ? (principal?.workspaces.filter(id => id !== '*') ?? []) : [...knownWorkspaces]
      const platformWorkspaceIds = isPlatformOperations(req) && persistence.listWorkspaceIds ? await persistence.listWorkspaceIds() : []
      const platformScopeIds = isPlatformOperations(req) ? [...new Set([...platformWorkspaceIds, ...knownWorkspaces])] : []
      const workspaceIds = platformScopeIds.length ? platformScopeIds : granted.length ? [...new Set(granted)] : [workspaceId]
      // Each summary performs five repository reads. Keep only two summaries in
      // flight so a platform-wide directory cannot exhaust the shared SQL pool
      // while the rest of the Ops page is loading.
      const summaries = await mapWithConcurrency(workspaceIds, 2, async id => { const [status, settings, usage, subscription, members] = await Promise.all([getWorkspaceStatus(id), (persistence.commercial ?? memoryCommercial).getSettings(id), (persistence.usage ?? memoryUsage).get(id), (persistence.subscriptions ?? memorySubscriptions).get(id), (persistence.members ?? memoryMembers).list(id)]); return { workspaceId: id, status, planName: settings.planName, monthlyPriceCny: settings.monthlyPriceCny, usedTasks: usage.usedTasks, includedTasks: usage.includedTasks, subscriptionStatus: subscription.status, memberCount: members.length } })
      return result(summaries)
    }
    case 'ops.users.list': {
      requireOperationsRole(req, ['platform_ops'])
      const query = typeof params.query === 'string' ? params.query.trim().toLocaleLowerCase() : ''
      const status = typeof params.status === 'string' && params.status.trim() ? params.status.trim() : undefined
      if (status && !['invited', 'active', 'suspended'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'status 必须是 invited、active 或 suspended', 400)
      const targetWorkspaceId = typeof params.workspace_id === 'string' && params.workspace_id.trim() ? params.workspace_id.trim() : undefined
      const requestedLimit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Number(params.limit) : 20
      const offset = typeof params.offset === 'string' && /^\d+$/u.test(params.offset) ? Number(params.offset) : 0
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须是 1 到 100 的整数', 400)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'offset 必须是 0 到 1000000 的整数', 400)
      const allWorkspaceIds = persistence.listWorkspaceIds ? await persistence.listWorkspaceIds() : [...knownWorkspaces]
      const workspaceIds = targetWorkspaceId ? allWorkspaceIds.filter(id => id === targetWorkspaceId) : allWorkspaceIds
      const memberRepository = persistence.members ?? memoryMembers
      const memberRows = memberRepository.listMany
        ? await memberRepository.listMany(workspaceIds)
        : (await Promise.all(workspaceIds.map(id => memberRepository.list(id)))).flat()
      const workspaceStatuses = new Map(await Promise.all([...new Set(memberRows.map(member => member.workspaceId))].map(async id => [id, await getWorkspaceStatus(id)] as const)))
      const commercialSummaries = await loadPlatformUserCommercialSummaries([...new Set(memberRows.map(member => member.workspaceId))])
      const memberships = memberRows.map(member => ({ ...member, workspaceStatus: workspaceStatuses.get(member.workspaceId) ?? 'active', commercial: commercialSummaries.get(member.workspaceId) }))
      const filtered = memberships.filter(member => (!status || member.status === status) && (!query || [member.externalSubject, member.displayName, member.workspaceId, member.role].some(value => value.toLocaleLowerCase().includes(query))))
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() || left.externalSubject.localeCompare(right.externalSubject))
      return result({ items: filtered.slice(offset, offset + requestedLimit), total: filtered.length, identityCount: new Set(filtered.map(member => member.externalSubject)).size, workspaceCount: new Set(filtered.map(member => member.workspaceId)).size, offset, limit: requestedLimit, truncated: offset + requestedLimit < filtered.length })
    }
    case 'ops.users.export': {
      requireOperationsRole(req, ['platform_ops'])
      const query = typeof params.query === 'string' ? params.query.trim().toLocaleLowerCase() : ''
      const status = typeof params.status === 'string' && params.status.trim() ? params.status.trim() : undefined
      if (status && !['invited', 'active', 'suspended'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'status 必须是 invited、active 或 suspended', 400)
      const targetWorkspaceId = typeof params.workspace_id === 'string' && params.workspace_id.trim() ? params.workspace_id.trim() : undefined
      const requestedLimit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Number(params.limit) : 5000
      if (params.format !== undefined && params.format !== 'csv' && params.format !== 'json') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'format 必须是 csv 或 json', 400)
      const format = params.format === 'json' ? 'json' : 'csv'
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 5000) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须是 1 到 5000 的整数', 400)
      const allWorkspaceIds = persistence.listWorkspaceIds ? await persistence.listWorkspaceIds() : [...knownWorkspaces]
      const workspaceIds = targetWorkspaceId ? allWorkspaceIds.filter(id => id === targetWorkspaceId) : allWorkspaceIds
      const memberRepository = persistence.members ?? memoryMembers
      const memberRows = memberRepository.listMany
        ? await memberRepository.listMany(workspaceIds)
        : (await Promise.all(workspaceIds.map(id => memberRepository.list(id)))).flat()
      const workspaceStatuses = new Map(await Promise.all([...new Set(memberRows.map(member => member.workspaceId))].map(async id => [id, await getWorkspaceStatus(id)] as const)))
      const commercialSummaries = await loadPlatformUserCommercialSummaries([...new Set(memberRows.map(member => member.workspaceId))])
      const filtered = memberRows
        .map(member => ({ ...member, workspaceStatus: workspaceStatuses.get(member.workspaceId) ?? 'active', commercial: commercialSummaries.get(member.workspaceId) }))
        .filter(member => (!status || member.status === status) && (!query || [member.externalSubject, member.displayName, member.workspaceId, member.role].some(value => value.toLocaleLowerCase().includes(query))))
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() || left.externalSubject.localeCompare(right.externalSubject))
        .slice(0, requestedLimit)
      const rows = filtered.map(member => ({ external_subject: member.externalSubject, display_name: member.displayName, workspace_id: member.workspaceId, role: member.role, status: member.status, workspace_status: member.workspaceStatus, plan_code: member.commercial?.planCode ?? null, plan_name: member.commercial?.planName ?? null, subscription_status: member.commercial?.subscriptionStatus ?? null, used_tasks: member.commercial?.usedTasks ?? null, included_tasks: member.commercial?.includedTasks ?? null, remaining_tasks: member.commercial?.remainingTasks ?? null, wallet_balance_cny: member.commercial?.walletBalanceCny ?? null, invited_by: member.invitedBy ?? null, created_at: member.createdAt, updated_at: member.updatedAt }))
      if (format === 'json') return result({ filename: `ops-users-${new Date().toISOString().slice(0, 10)}.json`, content: JSON.stringify(rows, null, 2), count: rows.length, truncated: rows.length === requestedLimit })
      const headers = ['external_subject', 'display_name', 'workspace_id', 'role', 'status', 'workspace_status', 'plan_code', 'plan_name', 'subscription_status', 'used_tasks', 'included_tasks', 'remaining_tasks', 'wallet_balance_cny', 'invited_by', 'created_at', 'updated_at']
      const content = [headers.join(','), ...rows.map(row => headers.map(header => csvCell(String(row[header as keyof typeof row] ?? ''))).join(','))].join('\n')
      return result({ filename: `ops-users-${new Date().toISOString().slice(0, 10)}.csv`, content, count: rows.length, truncated: rows.length === requestedLimit })
    }
    case 'ops.user.detail': {
      requireOperationsRole(req, ['platform_ops'])
      const requestedIdentityId = typeof params.identity_id === 'string' && params.identity_id.trim() ? params.identity_id.trim() : undefined
      const externalSubject = typeof params.external_subject === 'string' && params.external_subject.trim() ? params.external_subject.trim() : undefined
      if (!requestedIdentityId && !externalSubject) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'identity_id 或 external_subject 至少提供一个', 400)
      let identityDetail: IdentityOperationsDetail | undefined
      try {
        const repository = persistence.identities ?? memoryIdentities
        const identity = requestedIdentityId
          ? undefined
          : await repository.resolve({ issuer: typeof params.issuer === 'string' && params.issuer.trim() ? params.issuer.trim() : 'urn:merchant:api-token', externalSubject: externalSubject! })
        if (requestedIdentityId || identity) identityDetail = await repository.detailForOperations(requestedIdentityId ?? identity!.id)
      } catch (error) { mapIdentityLifecycleError(error) }
      const allWorkspaceIds = persistence.listWorkspaceIds ? await persistence.listWorkspaceIds() : [...knownWorkspaces]
      const memberRepository = persistence.members ?? memoryMembers
      const allMembers = memberRepository.listMany
        ? await memberRepository.listMany(allWorkspaceIds)
        : (await Promise.all(allWorkspaceIds.map(id => memberRepository.list(id)))).flat()
      const matchingMembers = allMembers.filter(member => requestedIdentityId ? member.identityId === requestedIdentityId : member.externalSubject === externalSubject)
      if (!matchingMembers.length && !identityDetail) throw new DomainError('USER_IDENTITY_NOT_FOUND', '未找到该平台身份或成员关系', 404)
      const workspaceStatuses = new Map(await Promise.all(matchingMembers.map(async member => [member.workspaceId, await getWorkspaceStatus(member.workspaceId)] as const)))
      const memberships = matchingMembers
        .map(member => ({ ...member, workspaceStatus: workspaceStatuses.get(member.workspaceId) ?? 'active' }))
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
      const auditRepository = persistence.operations ?? memoryOperations
      const audits = (await Promise.all([...new Set(matchingMembers.map(member => member.workspaceId))].map(id => auditRepository.list(id, 200))))
        .flat()
        .filter(audit => audit.resourceType === 'workspace_member' && audit.resourceId === (externalSubject ?? identityDetail?.identity.externalSubject))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 100)
      return result({
        identity: {
          ...(identityDetail?.identity ?? {}),
          externalSubject: identityDetail?.identity.externalSubject ?? externalSubject,
          displayName: identityDetail?.identity.displayName || memberships.find(member => member.displayName)?.displayName || '',
          membershipCount: memberships.length,
          activeMembershipCount: memberships.filter(member => member.status === 'active' && member.workspaceStatus === 'active').length,
          firstSeenAt: identityDetail?.identity.firstSeenAt ?? memberships[0]?.createdAt ?? null,
          lastUpdatedAt: identityDetail?.identity.updatedAt ?? memberships[0]?.updatedAt ?? null,
        },
        memberships,
        audits,
        sessions: identityDetail?.sessions.map(({ providerSessionHash: _providerSessionHash, ipHash: _ipHash, userAgentHash: _userAgentHash, ...session }) => session) ?? [],
        lifecycleEvents: identityDetail?.events ?? [],
      })
    }
    case 'ops.commercial.offers.list':
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'finance', 'platform_ops'])
      return result(await (persistence.commercialExtensions ?? memoryCommercialExtensions).listOffers())
    case 'ops.commercial.offer.upsert': {
      const actorId = requireOperationsRole(req, ['platform_ops'])
      const price = Number(required(params, 'price_cny'))
      const stores = Number(required(params, 'included_stores'))
      const tasks = Number(required(params, 'included_tasks'))
      if (!Number.isFinite(price) || price < 0 || !/^\d+(?:\.\d{1,2})?$/u.test(required(params, 'price_cny')) || !Number.isInteger(stores) || stores < 0 || !Number.isInteger(tasks) || tasks < 0) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '套餐价格和额度参数无效', 400)
      const item = await (persistence.commercialExtensions ?? memoryCommercialExtensions).upsertOffer({ code: required(params, 'code'), name: required(params, 'name'), billingCycle: required(params, 'billing_cycle') as 'monthly' | 'annual', priceCny: Number(price.toFixed(2)), includedStores: stores, includedTasks: tasks, active: params.active !== 'false', validFrom: typeof params.valid_from === 'string' ? params.valid_from : new Date().toISOString(), validTo: typeof params.valid_to === 'string' ? params.valid_to : undefined, updatedBy: actorId, expectedRevision: params.expected_revision ? Number(params.expected_revision) : undefined })
      await recordOperationAudit({ workspaceId, actorId, action: 'commercial.offer.upsert', resourceType: 'commercial_offer', resourceId: item.code, before: {}, after: item as unknown as Record<string, unknown>, reason: typeof params.reason === 'string' ? params.reason : '套餐目录更新' })
      return result(item)
    }
    case 'ops.commercial.addons.list':
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'finance', 'platform_ops'])
      return result(await (persistence.commercialExtensions ?? memoryCommercialExtensions).listAddons())
    case 'ops.commercial.addon.upsert': {
      const actorId = requireOperationsRole(req, ['platform_ops'])
      const price = Number(required(params, 'price_cny')); const units = Number(required(params, 'units'))
      if (!Number.isFinite(price) || price < 0 || !/^\d+(?:\.\d{1,2})?$/u.test(required(params, 'price_cny')) || !Number.isInteger(units) || units < 0) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '加购价格和数量参数无效', 400)
      const item = await (persistence.commercialExtensions ?? memoryCommercialExtensions).upsertAddon({ code: required(params, 'code'), name: required(params, 'name'), kind: required(params, 'kind') as 'platform' | 'image_generation' | 'bulk_sync', priceCny: Number(price.toFixed(2)), units, active: params.active !== 'false', updatedBy: actorId, expectedRevision: params.expected_revision ? Number(params.expected_revision) : undefined })
      await recordOperationAudit({ workspaceId, actorId, action: 'commercial.addon.upsert', resourceType: 'commercial_addon', resourceId: item.code, before: {}, after: item as unknown as Record<string, unknown>, reason: typeof params.reason === 'string' ? params.reason : '加购目录更新' }); return result(item)
    }
    case 'ops.commercial.coupons.list':
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'finance', 'platform_ops'])
      return result(await (persistence.commercialExtensions ?? memoryCommercialExtensions).listCoupons())
    case 'ops.commercial.export': {
      requireOperationsRole(req, ['platform_ops'])
      if (params.format !== undefined && params.format !== 'csv' && params.format !== 'json') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'format 必须是 csv 或 json', 400)
      const extensions = persistence.commercialExtensions ?? memoryCommercialExtensions
      const [offers, addons, coupons, rollouts, markup] = await Promise.all([
        extensions.listOffers(),
        extensions.listAddons(),
        extensions.listCoupons(),
        extensions.listRollouts(),
        extensions.getModelMarkupPolicy(),
      ])
      const payload = { exportedAt: new Date().toISOString(), offers, addons, coupons, rollouts, modelMarkup: markup }
      if (params.format === 'json') return result({ filename: `ops-commercial-${new Date().toISOString().slice(0, 10)}.json`, content: JSON.stringify(payload, null, 2), counts: { offers: offers.length, addons: addons.length, coupons: coupons.length, rollouts: rollouts.length } })
      const headers = ['kind', 'id', 'code', 'name', 'billing_cycle', 'price_cny', 'included_stores', 'included_tasks', 'addon_kind', 'units', 'discount_type', 'discount_value', 'max_redemptions', 'redeemed_count', 'active', 'offer_code', 'workspace_id', 'percentage', 'enabled', 'reason', 'valid_from', 'valid_to', 'revision', 'updated_by', 'updated_at']
      const rows = [
        ...offers.map(item => ({ kind: 'offer', id: item.id, code: item.code, name: item.name, billing_cycle: item.billingCycle, price_cny: item.priceCny, included_stores: item.includedStores, included_tasks: item.includedTasks, active: item.active, valid_from: item.validFrom, valid_to: item.validTo ?? '', revision: item.revision, updated_by: item.updatedBy, updated_at: item.updatedAt })),
        ...addons.map(item => ({ kind: 'addon', id: item.id, code: item.code, name: item.name, price_cny: item.priceCny, addon_kind: item.kind, units: item.units, active: item.active, revision: item.revision, updated_by: item.updatedBy, updated_at: item.updatedAt })),
        ...coupons.map(item => ({ kind: 'coupon', id: item.id, code: item.code, discount_type: item.discountType, discount_value: item.discountValue, max_redemptions: item.maxRedemptions, redeemed_count: item.redeemedCount, active: item.active, valid_from: item.validFrom, valid_to: item.validTo ?? '', revision: item.revision, updated_by: item.updatedBy, updated_at: item.updatedAt })),
        ...rollouts.map(item => ({ kind: 'rollout', id: item.id, offer_code: item.offerCode, workspace_id: item.workspaceId ?? '', percentage: item.percentage, enabled: item.enabled, reason: item.reason, revision: item.revision, updated_by: item.updatedBy, updated_at: item.updatedAt })),
        { kind: 'model_markup', id: 'singleton', price_cny: markup.multiplier, reason: markup.reason, revision: markup.revision, updated_by: markup.updatedBy, updated_at: markup.updatedAt },
      ]
      const content = [headers.join(','), ...rows.map(row => headers.map(header => csvCell(String(row[header as keyof typeof row] ?? ''))).join(','))].join('\n')
      return result({ filename: `ops-commercial-${new Date().toISOString().slice(0, 10)}.csv`, content, counts: { offers: offers.length, addons: addons.length, coupons: coupons.length, rollouts: rollouts.length } })
    }
    case 'ops.commercial.coupon.upsert': {
      const actorId = requireOperationsRole(req, ['platform_ops'])
      const value = Number(required(params, 'discount_value')); const max = Number(required(params, 'max_redemptions')); const type = required(params, 'discount_type') as 'fixed_cny' | 'percent'
      if (!Number.isFinite(value) || value < 0 || !/^\d+(?:\.\d{1,2})?$/u.test(required(params, 'discount_value')) || !Number.isInteger(max) || max < 0 || (type === 'percent' && value > 100)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '优惠券折扣参数无效', 400)
      const item = await (persistence.commercialExtensions ?? memoryCommercialExtensions).upsertCoupon({ code: required(params, 'code'), discountType: type, discountValue: Number(value.toFixed(2)), maxRedemptions: max, active: params.active !== 'false', validFrom: typeof params.valid_from === 'string' ? params.valid_from : new Date().toISOString(), validTo: typeof params.valid_to === 'string' ? params.valid_to : undefined, updatedBy: actorId, expectedRevision: params.expected_revision ? Number(params.expected_revision) : undefined })
      await recordOperationAudit({ workspaceId, actorId, action: 'commercial.coupon.upsert', resourceType: 'commercial_coupon', resourceId: item.code, before: {}, after: item as unknown as Record<string, unknown>, reason: typeof params.reason === 'string' ? params.reason : '优惠券规则更新' }); return result(item)
    }
    case 'ops.commercial.rollouts.list': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const rollouts = await (persistence.commercialExtensions ?? memoryCommercialExtensions).listRollouts()
      return result(isPlatformOperations(req) ? rollouts : rollouts.filter(item => !item.workspaceId || item.workspaceId === workspaceId))
    }
    case 'ops.commercial.model-markup.get':
      requireOperationsRole(req, ['platform_ops'])
      return result(await (persistence.commercialExtensions ?? memoryCommercialExtensions).getModelMarkupPolicy())
    case 'ops.commercial.model-markup.update': {
      const actorId = requireOperationsRole(req, ['platform_ops'])
      const rawMultiplier = required(params, 'multiplier')
      const multiplier = Number(rawMultiplier)
      const expectedRevision = Number(required(params, 'expected_revision'))
      const reason = required(params, 'reason')
      if (!/^\d+(?:\.\d{1,3})?$/u.test(rawMultiplier) || !Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10 || !Number.isInteger(expectedRevision) || expectedRevision < 1) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '模型计费倍率必须在 1.0 至 10.0 之间，最多 3 位小数', 400)
      const repository = persistence.commercialExtensions ?? memoryCommercialExtensions
      const before = await repository.getModelMarkupPolicy()
      let item
      try { item = await repository.updateModelMarkupPolicy({ multiplier, reason, updatedBy: actorId, expectedRevision }) } catch (error) { if (error instanceof Error && error.message.includes('revision conflict')) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '倍率配置已被其他运营人员更新，请刷新后重试', 409); throw error }
      await recordOperationAudit({ workspaceId, actorId, action: 'commercial.model_markup.update', resourceType: 'model_markup_policy', resourceId: 'global', before: before as unknown as Record<string, unknown>, after: item as unknown as Record<string, unknown>, reason })
      return result(item)
    }
    case 'ops.growth.funnel':
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'finance', 'platform_ops'])
      return result(await (persistence.growth ?? memoryGrowth).funnel({ workspaceId, sourceChannel: typeof params.source_channel === 'string' ? params.source_channel : undefined, from: typeof params.date_from === 'string' ? params.date_from : undefined, to: typeof params.date_to === 'string' ? params.date_to : undefined }))
    case 'ops.alerts.list': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'platform_ops'])
      const repository = await syncOperationalAlerts(workspaceId)
      if (params.status !== undefined && params.status !== 'open' && params.status !== 'acknowledged') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'status 必须是 open 或 acknowledged', 400)
      const status = params.status === 'open' || params.status === 'acknowledged' ? params.status : undefined
      const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Number(params.limit) : 100
      const platform = typeof params.platform === 'string' && params.platform.trim() ? params.platform.trim() : undefined
      if (platform && !SUPPORTED_PLATFORMS.includes(platform as Platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 筛选值无效', 400)
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      const code = typeof params.code === 'string' && params.code.trim() ? params.code.trim() : undefined
      const entityType = typeof params.entity_type === 'string' && params.entity_type.trim() ? params.entity_type.trim() : undefined
      const entityId = typeof params.entity_id === 'string' && params.entity_id.trim() ? params.entity_id.trim() : undefined
      const alerts = await repository.list(workspaceId, status, 500)
      return result(alerts.filter(alert => (!platform || alert.platform === platform) && (!accountId || alert.accountId === accountId) && (!code || alert.code === code) && (!entityType || alert.entityType === entityType) && (!entityId || alert.entityId === entityId)).slice(0, Math.min(500, Math.max(1, limit))))
    }
    case 'ops.alert.ack': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'platform_ops'])
      const alert = await (persistence.alerts ?? memoryAlerts).acknowledge({ workspaceId, id: required(params, 'alert_id'), actorId, reason: required(params, 'reason') })
      await recordOperationAudit({ workspaceId, actorId, action: 'ops.alert.ack', resourceType: 'operational_alert', resourceId: alert.id, before: { status: 'open' }, after: alert as unknown as Record<string, unknown>, reason: required(params, 'reason') })
      return result(alert)
    }
    case 'ops.marketing.queue': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'platform_ops'])
      const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(100, Math.max(1, Number(params.limit))) : 50
      const filterPlatform = typeof params.platform === 'string' && params.platform.trim() ? params.platform.trim() as Platform : undefined
      if (filterPlatform && !SUPPORTED_PLATFORMS.includes(filterPlatform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 筛选值无效', 400)
      const filterAccountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      const filterProductId = typeof params.product_id === 'string' && params.product_id.trim() ? params.product_id.trim() : undefined
      const filterTaskId = typeof params.task_id === 'string' && params.task_id.trim() ? params.task_id.trim() : undefined
      const filterState = typeof params.state === 'string' && params.state.trim() ? params.state.trim() : undefined
      const taskForQueue = (taskId: string) => {
        try {
          const task = service.getTask(taskId)
          return task.workspaceId === workspaceId ? task : undefined
        } catch { return undefined }
      }
      const matchesTask = (taskId: string, platform?: Platform, accountId?: string, productId?: string, state?: string) => {
        if (filterTaskId && taskId !== filterTaskId) return false
        if (filterPlatform && platform !== filterPlatform) return false
        if (filterAccountId && accountId !== filterAccountId) return false
        if (filterProductId && productId !== filterProductId) return false
        if (filterState && state !== filterState) return false
        return true
      }
      const generation = [...service.generationJobs.values()].filter(job => {
        if (job.workspaceId !== workspaceId) return false
        const task = taskForQueue(job.taskId)
        return Boolean(task && matchesTask(job.taskId, task.platform, task.accountId, task.productId, job.state))
      }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit).map(job => ({ id: job.id, taskId: job.taskId, state: job.state, attempt: job.attempt, contentVersionId: job.contentVersionId ?? null, errorCode: job.errorCode ?? null, errorMessage: job.errorMessage ?? null, waitingReason: job.waitingReason ?? null, assignedOperatorId: job.assignedOperatorId ?? null, assignedAt: job.assignedAt ?? null, revision: job.revision, createdAt: job.createdAt, updatedAt: job.updatedAt }))
      const publish = service.listPublishJobs(workspaceId).filter(job => {
        const task = taskForQueue(job.taskId)
        return Boolean(task && matchesTask(job.taskId, job.platform, job.accountId, task.productId, job.remoteState ?? job.state))
      }).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit).map(job => ({ id: job.id, taskId: job.taskId, contentVersionId: job.contentVersionId, platform: job.platform, accountId: job.accountId ?? null, state: job.state, remoteState: job.remoteState ?? null, remoteId: job.remoteId ?? null, requestId: job.requestId ?? null, rejection: job.rejection ? { rawCode: job.rejection.rawCode, message: job.rejection.message, fields: job.rejection.fields.map(field => ({ path: field.path, rawCode: field.rawCode ?? null, message: field.message })) } : null, operatorAcknowledgement: job.operatorAcknowledgement ?? null, assignedOperatorId: job.assignedOperatorId ?? null, assignedAt: job.assignedAt ?? null, revision: job.revision, createdAt: job.createdAt, remoteObservedAt: job.remoteObservedAt ?? null }))
      const batches = (await Promise.all([...publishBatches.values()].filter(batch => batch.workspaceId === workspaceId && (!filterPlatform && !filterAccountId && !filterProductId && !filterTaskId && !filterState || batch.items.some(item => {
        const task = taskForQueue(item.taskId)
        return Boolean(task && matchesTask(item.taskId, task.platform, task.accountId, task.productId, item.state))
      }))).map(async batch => {
        await refreshPublishBatch(batch)
        return { id: batch.id, state: batch.state, itemCount: batch.items.length, queuedCount: batch.items.filter(item => ['queued', 'submitted'].includes(item.state)).length, failedCount: batch.items.filter(item => ['failed', 'rejected', 'unknown'].includes(item.state)).length, pauseReason: batch.pauseReason ?? null, updatedAt: batch.updatedAt }
      }))).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit)
      const visuals = [...service.imageGenerationJobs.values()].filter(job => {
        if (job.workspaceId !== workspaceId || job.archiveState !== 'archived' || !job.outputs?.some(output => output.reviewStatus !== 'passed')) return false
        const task = job.taskId ? taskForQueue(job.taskId) : undefined
        const product = !task ? service.listProducts(workspaceId).find(item => item.id === job.productId) : undefined
        return matchesTask(job.taskId ?? '', task?.platform ?? product?.platform, task?.accountId ?? product?.accountId, job.productId, 'visual_review')
      }).flatMap(job => (job.outputs ?? []).filter(output => output.reviewStatus !== 'passed').map(output => ({ jobId: job.id, visualRef: output.visualRef, ordinal: output.ordinal, productId: job.productId, taskId: job.taskId ?? null, contentVersionId: job.contentVersionId ?? null, skuIds: job.skuIds ?? [], reviewStatus: output.reviewStatus, archiveState: job.archiveState, assignedOperatorId: job.assignedOperatorId ?? null, assignedAt: job.assignedAt ?? null, revision: job.revision, updatedAt: job.updatedAt }))).slice(0, limit)
      const uploadedAssetRisks = service.listAssets(workspaceId).filter(asset => asset.readiness.status !== 'ready' && !filterProductId && !filterTaskId && !filterAccountId && (!filterPlatform || !asset.applicablePlatforms?.length || asset.applicablePlatforms.includes(filterPlatform))).slice(0, limit).map(asset => {
        const base = { id: asset.id, name: asset.name, mimeType: asset.mimeType, scanStatus: asset.scanStatus, parseStatus: asset.parseStatus, rightsStatus: asset.rightsStatus, rightsScope: asset.rightsScope ?? null, readiness: asset.readiness, revision: asset.revision, createdAt: asset.createdAt }
        if (asset.scanStatus === 'quarantined') return { ...base, nextAction: { method: 'asset.scan', label: '提交安全扫描结果', requiredInputs: ['asset_id', 'scan_evidence_ref'] } }
        if (asset.scanStatus === 'blocked') return { ...base, nextAction: null, nextStep: '联系安全审核并重新上传或解除安全阻断' }
        if (asset.parseStatus === 'failed') return { ...base, nextAction: { method: 'asset.facts.confirm', label: '人工确认素材事实', requiredInputs: ['asset_id', 'facts_json', 'reason'] } }
        if (asset.parseStatus !== 'succeeded') return { ...base, nextAction: { method: 'asset.parse', label: '解析素材事实', requiredInputs: ['asset_id'] } }
        if (asset.rightsStatus !== 'approved' || asset.rightsScope === 'unusable') return { ...base, nextAction: { method: 'asset.rights.update', label: '确认素材商用权益', requiredInputs: ['asset_id', 'rights_status'] } }
        return { ...base, nextAction: { method: 'asset.facts.confirm', label: '确认素材事实', requiredInputs: ['asset_id', 'facts_json', 'reason'] } }
      })
      return result({ generatedAt: new Date().toISOString(), filters: { platform: filterPlatform ?? null, accountId: filterAccountId ?? null, productId: filterProductId ?? null, taskId: filterTaskId ?? null, state: filterState ?? null }, generation, publish, batches, visuals, learningSuggestions: knowledge.listLearningSuggestions(workspaceId, 'pending'), assetRisks: knowledge.queryAssets({ workspaceId }).filter(asset => asset.approvalStatus !== 'approved' || asset.rightsStatus !== 'cleared').map(asset => ({ id: asset.id, kind: asset.kind, name: asset.name, approvalStatus: asset.approvalStatus, rightsStatus: asset.rightsStatus, source: asset.source ?? null, revision: asset.revision, updatedAt: asset.updatedAt })), uploadedAssetRisks })
    }
    case 'ops.marketing.queue.assign': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      const itemType = required(params, 'item_type')
      if (itemType !== 'generation' && itemType !== 'publish') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'item_type 必须是 generation 或 publish', 400)
      const expectedRevision = typeof params.expected_revision === 'string' && /^\d+$/u.test(params.expected_revision) ? Number(params.expected_revision) : undefined
      if (params.expected_revision !== undefined && expectedRevision === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_revision 必须是非负整数', 400)
      const assigned = service.assignMarketingQueueItem({ workspaceId, itemType, itemId: required(params, 'item_id'), operatorId: required(params, 'operator_id'), ...(expectedRevision !== undefined ? { expectedRevision } : {}) })
      await persistSnapshot(workspaceId, itemType === 'generation' ? 'generation_job' : 'publish_job', assigned, assigned as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, assigned.id, 'marketing.queue_assigned', assigned.revision, { item_type: itemType, item_id: assigned.id, operator_id: assigned.assignedOperatorId, assigned_at: assigned.assignedAt })
      await recordOperationAudit({ workspaceId, actorId, action: 'ops.marketing.queue.assign', resourceType: `${itemType}_job`, resourceId: assigned.id, before: {}, after: { assignedOperatorId: assigned.assignedOperatorId, assignedAt: assigned.assignedAt, revision: assigned.revision }, reason: required(params, 'reason') })
      return result(assigned)
    }
    case 'ops.marketing.visual.review': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      const status = params.status === 'passed' || params.status === 'blocked' ? params.status : undefined
      if (!status) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'status 必须是 passed 或 blocked', 400)
      let visualRefs: string[]
      try {
        const parsed = JSON.parse(required(params, 'visual_refs_json'))
        if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50 || parsed.some(value => typeof value !== 'string' || !value.trim())) throw new Error('visual_refs_json')
        visualRefs = [...new Set(parsed.map(value => value.trim()))]
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'visual_refs_json 必须是 1 至 50 个视觉候选引用的 JSON 数组', 400) }
      const expectedRevision = typeof params.expected_revision === 'string' && /^\d+$/u.test(params.expected_revision) ? Number(params.expected_revision) : undefined
      if (params.expected_revision !== undefined && expectedRevision === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_revision 必须是非负整数', 400)
      const jobs = visualRefs.map(visualRef => service.resolveImageGenerationByVisualRef(workspaceId, visualRef))
      if (expectedRevision !== undefined && jobs.some(job => job.revision !== expectedRevision)) throw new DomainError('QUEUE_ASSIGNMENT_VERSION_CONFLICT', '视觉候选队列项目已变化，请刷新后重试', 409)
      const reviewed = service.reviewImageGenerationOutputs(workspaceId, visualRefs, status)
      for (const job of reviewed) {
        await persistSnapshot(workspaceId, 'image_generation_job', job, job as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, job.id, 'marketing.visual_reviewed', job.revision, { job_id: job.id, visual_refs: visualRefs.filter(ref => job.outputs?.some(output => output.visualRef === ref)), status, actor_id: actorId })
      }
      await recordOperationAudit({ workspaceId, actorId, action: 'ops.marketing.visual.review', resourceType: 'image_generation_job', resourceId: reviewed[0]?.id ?? visualRefs[0]!, before: { visualRefs }, after: { status, jobIds: reviewed.map(job => job.id) }, reason: required(params, 'reason') })
      return result({ status, visualRefs, jobs: reviewed })
    }
    case 'ops.marketing.generation.retry': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      const job = service.retryGeneration({ workspaceId, jobId: required(params, 'job_id') })
      const task = service.getTask(job.taskId)
      const product = service.products.get(task.productId)
      if (!product) throw new DomainError('PRODUCT_NOT_FOUND', '生成任务商品不存在', 404)
      await persistSnapshot(workspaceId, 'generation_job', job, job as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, job.id, 'generation.requested', job.revision, { job_id: job.id, task_id: task.id, platform: task.platform, direction_id: task.selectedDirectionId ?? 'default', retry: true, input: { platform: task.platform, directionId: task.selectedDirectionId ?? 'default', product: { title: product.title, stock: product.stock, skuCount: product.skuCount, ...(product.category ? { category: product.category } : {}), ...(product.attributes ? { attributes: product.attributes } : {}) } } })
      await recordOperationAudit({ workspaceId, actorId, action: 'ops.marketing.generation.retry', resourceType: 'generation_job', resourceId: job.id, before: { state: 'failed' }, after: job as unknown as Record<string, unknown>, reason: required(params, 'reason') })
      return result(jobWithQueueMetadata(job, workspaceId, 'generation'))
    }
    case 'ops.marketing.publish.acknowledge': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      const job = service.acknowledgePublish({ workspaceId, publishJobId: required(params, 'publish_job_id'), actorId, reason: required(params, 'reason') })
      await persistSnapshot(workspaceId, 'publish_job', job, job as unknown as Record<string, unknown>)
      await recordOperationAudit({ workspaceId, actorId, action: 'ops.marketing.publish.acknowledge', resourceType: 'publish_job', resourceId: job.id, before: { operatorAcknowledgement: null }, after: { operatorAcknowledgement: job.operatorAcknowledgement }, reason: job.operatorAcknowledgement?.reason ?? required(params, 'reason') })
      return result(job)
    }
    case 'ops.marketing.revision.create': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      const publishJob = service.getPublishJob(required(params, 'publish_job_id'))
      if (publishJob.workspaceId !== workspaceId) throw new DomainError('TENANT_SCOPE_DENIED', '无权访问该发布任务', 403)
      if (publishJob.remoteState !== 'rejected' && publishJob.state !== 'rejected') throw new DomainError('REVISION_REQUIRES_REJECTED_PUBLISH', '只有平台驳回的发布任务才能创建运营修正版', 409)
      let changes: Partial<import('../../../packages/application/src/service.js').ContentVersion['body']>
      try { const parsed = JSON.parse(required(params, 'changes_json')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('changes_json'); changes = parsed } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'changes_json 必须是 JSON 对象', 400) }
      let lockedFields: string[] | undefined
      if (typeof params.locked_fields_json === 'string') { try { const parsed = JSON.parse(params.locked_fields_json); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error('locked_fields_json'); lockedFields = parsed } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'locked_fields_json 必须是字符串数组', 400) } }
      const source = service.getContentVersion(workspaceId, publishJob.contentVersionId)
      const modified = service.modifyContentVersion({ workspaceId, sourceVersionId: source.id, changes, ...(lockedFields ? { lockedFields } : {}), reason: required(params, 'reason'), ...(typeof params.expected_revision === 'string' && /^\d+$/u.test(params.expected_revision) ? { expectedRevision: Number(params.expected_revision) } : {}) })
      await persistSnapshot(workspaceId, 'content_version', modified.version, modified.version as unknown as Record<string, unknown>)
      await persistSnapshot(workspaceId, 'task', modified.task, modified.task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, modified.version.id, 'content.version_modified', modified.version.revision, { task_id: modified.task.id, source_version_id: source.id, content_version_id: modified.version.id, source_publish_job_id: publishJob.id, reason: required(params, 'reason'), operator_revision: true })
      await recordOperationAudit({ workspaceId, actorId, action: 'ops.marketing.revision.create', resourceType: 'content_version', resourceId: modified.version.id, before: { sourceVersionId: source.id, publishJobId: publishJob.id }, after: modified.version as unknown as Record<string, unknown>, reason: required(params, 'reason') })
      return result({ ...modified, sourcePublishJobId: publishJob.id })
    }
    case 'ops.commercial.rollout.upsert': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops']); const percentage = Number(required(params, 'percentage'))
      if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '灰度百分比必须在 0 到 100 之间', 400)
      const requestedTarget = Object.hasOwn(params, 'target_workspace_id')
        ? (typeof params.target_workspace_id === 'string' ? params.target_workspace_id : undefined)
        : (isPlatformOperations(req) ? undefined : workspaceId)
      const targetWorkspaceId = scopeCommercialRolloutTarget(req, workspaceId, requestedTarget)
      const item = await (persistence.commercialExtensions ?? memoryCommercialExtensions).upsertRollout({ offerCode: required(params, 'offer_code'), ...(targetWorkspaceId ? { workspaceId: targetWorkspaceId } : {}), percentage, enabled: params.enabled === 'true', reason: required(params, 'reason'), updatedBy: actorId, expectedRevision: params.expected_revision ? Number(params.expected_revision) : undefined })
      await recordOperationAudit({ workspaceId, actorId, action: 'commercial.rollout.upsert', resourceType: 'commercial_rollout', resourceId: item.id, before: {}, after: item as unknown as Record<string, unknown>, reason: item.reason }); return result(item)
    }
    case 'ops.member.upsert': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const role = required(params, 'role') as MemberRole
      const repository = persistence.members ?? memoryMembers
      const members = await repository.list(workspaceId)
      const current = members.find(item => item.externalSubject === required(params, 'external_subject'))
      const status = (typeof params.status === 'string' ? params.status : current?.status ?? 'invited') as MemberStatus
      if (!['workspace_owner', 'merchant_admin', 'operator', 'support', 'finance', 'platform_ops'].includes(role) || !['invited', 'active', 'suspended'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '成员角色或状态无效', 400)
      if (role === 'platform_ops' && !isPlatformOperations(req)) throw new DomainError('PLATFORM_ROLE_GRANT_DENIED', '只有平台运营可以授予平台运营角色', 403)
      const actorMemberRole = requestPrincipals.get(req)?.memberRole
      if (role === 'workspace_owner' && !isPlatformOperations(req) && actorMemberRole !== 'workspace_owner') throw new DomainError('WORKSPACE_OWNER_GRANT_DENIED', '只有工作区所有者或平台运营可以授予所有者角色', 403)
      if (current?.role === 'platform_ops' && !isPlatformOperations(req)) throw new DomainError('PLATFORM_ROLE_CHANGE_DENIED', '只有平台运营可以变更平台运营成员', 403)
      if (current?.role === 'workspace_owner' && !isPlatformOperations(req) && actorMemberRole !== 'workspace_owner') throw new DomainError('WORKSPACE_OWNER_CHANGE_DENIED', '只有工作区所有者或平台运营可以变更所有者成员', 403)
      const activeOwnerCount = members.filter(item => item.role === 'workspace_owner' && item.status === 'active').length
      if (!isPlatformOperations(req) && current?.role === 'workspace_owner' && current.status === 'active' && activeOwnerCount <= 1 && (role !== 'workspace_owner' || status !== 'active')) throw new DomainError('LAST_WORKSPACE_OWNER_REQUIRED', '不能降级或停用最后一名有效工作区所有者', 409)
      try {
        const changed = await repository.upsertWithAudit({ workspaceId, externalSubject: required(params, 'external_subject'), displayName: typeof params.display_name === 'string' ? params.display_name : current?.displayName ?? '', role, status, ...(current ? { expectedRevision: current.revision } : {}), actorId, action: 'member.upsert', reason: typeof params.reason === 'string' ? params.reason : '成员信息更新' })
        if (repository === memoryMembers) await memoryOperations.append({ workspaceId, actorId, action: 'member.upsert', resourceType: 'workspace_member', resourceId: changed.member.externalSubject, before: (current ?? {}) as unknown as Record<string, unknown>, after: changed.member as unknown as Record<string, unknown>, reason: typeof params.reason === 'string' ? params.reason : '成员信息更新' })
        return result(changed.member)
      } catch (error) {
        if (error instanceof Error && error.message === 'MEMBER_REVISION_CONFLICT') throw new DomainError('MEMBER_REVISION_CONFLICT', '成员信息已变化，请刷新后重试', 409)
        throw error
      }
    }
    case 'ops.member.suspend': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const externalSubject = required(params, 'external_subject')
      const members = await (persistence.members ?? memoryMembers).list(workspaceId)
      const target = members.find(item => item.externalSubject === externalSubject)
      const actorMemberRole = requestPrincipals.get(req)?.memberRole
      if (target?.role === 'platform_ops' && !isPlatformOperations(req)) throw new DomainError('PLATFORM_ROLE_CHANGE_DENIED', '只有平台运营可以停用平台运营成员', 403)
      if (target?.role === 'workspace_owner' && !isPlatformOperations(req) && actorMemberRole !== 'workspace_owner') throw new DomainError('WORKSPACE_OWNER_CHANGE_DENIED', '只有工作区所有者或平台运营可以停用所有者成员', 403)
      if (!isPlatformOperations(req) && target?.role === 'workspace_owner' && target.status === 'active' && members.filter(item => item.role === 'workspace_owner' && item.status === 'active').length <= 1) throw new DomainError('LAST_WORKSPACE_OWNER_REQUIRED', '不能停用最后一名有效工作区所有者', 409)
      const member = await changeMemberStatusWithAudit({ workspaceId, externalSubject, targetStatus: 'suspended', actorId, action: 'member.suspend', reason: required(params, 'reason') })
      return result(member)
    }
    case 'ops.user.suspend': {
      const actorId = requireOperationsRole(req, ['platform_ops'])
      if (params.scope === 'identity') {
        const identityId = required(params, 'identity_id')
        if (identityId === requestPrincipals.get(req)?.identityId) throw new DomainError('SELF_SUSPENSION_DENIED', '不能停用当前登录账号；请由另一名平台运营人员执行', 409)
        try { return result(await (persistence.identities ?? memoryIdentities).transitionAccess({ identityId, target: 'suspended', expectedRevision: Number(required(params, 'expected_revision')), actorId, reason: required(params, 'reason'), idempotencyKey: required(params, 'idempotency_key') })) }
        catch (error) { mapIdentityLifecycleError(error) }
      }
      const targetWorkspaceId = required(params, 'workspace_id')
      const externalSubject = required(params, 'external_subject')
      const reason = required(params, 'reason')
      if (externalSubject === actorId) throw new DomainError('SELF_SUSPENSION_DENIED', '不能停用当前登录账号；请由另一名平台运营人员执行', 409)
      const member = await changeMemberStatusWithAudit({ workspaceId: targetWorkspaceId, externalSubject, targetStatus: 'suspended', actorId, action: 'user.suspend', reason })
      return result(member)
    }
    case 'ops.user.activate': {
      const actorId = requireOperationsRole(req, ['platform_ops'])
      if (params.scope === 'identity') {
        try { return result(await (persistence.identities ?? memoryIdentities).transitionAccess({ identityId: required(params, 'identity_id'), target: 'active', expectedRevision: Number(required(params, 'expected_revision')), actorId, reason: required(params, 'reason'), idempotencyKey: required(params, 'idempotency_key') })) }
        catch (error) { mapIdentityLifecycleError(error) }
      }
      const targetWorkspaceId = required(params, 'workspace_id')
      const externalSubject = required(params, 'external_subject')
      const reason = required(params, 'reason')
      const member = await changeMemberStatusWithAudit({ workspaceId: targetWorkspaceId, externalSubject, targetStatus: 'active', actorId, action: 'user.activate', reason })
      return result(member)
    }
    case 'ops.user.risk.transition': {
      const actorId = requireOperationsRole(req, ['platform_ops'])
      let evidence: Record<string, unknown> = {}
      if (typeof params.evidence_json === 'string' && params.evidence_json.trim()) {
        try { const parsed: unknown = JSON.parse(params.evidence_json); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid'); evidence = parsed as Record<string, unknown> }
        catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'evidence_json 必须是 JSON 对象', 400) }
      }
      try { return result(await (persistence.identities ?? memoryIdentities).transitionRisk({ identityId: required(params, 'identity_id'), level: required(params, 'risk_level') as import('../../../packages/persistence/src/identity-lifecycle-repository.js').IdentityRiskLevel, decision: required(params, 'risk_decision') as import('../../../packages/persistence/src/identity-lifecycle-repository.js').IdentityRiskDecision, expectedRevision: Number(required(params, 'expected_revision')), actorId, reason: required(params, 'reason'), evidence, idempotencyKey: required(params, 'idempotency_key') })) }
      catch (error) { mapIdentityLifecycleError(error) }
    }
    case 'ops.user.session.revoke': {
      const actorId = requireOperationsRole(req, ['platform_ops'])
      try { return result(await (persistence.identities ?? memoryIdentities).revokeSession({ identityId: required(params, 'identity_id'), sessionId: required(params, 'session_id'), expectedRevision: Number(required(params, 'expected_revision')), actorId, reason: required(params, 'reason'), idempotencyKey: required(params, 'idempotency_key') })) }
      catch (error) { mapIdentityLifecycleError(error) }
    }
    case 'ops.audit.list': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'finance', 'platform_ops'])
      const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Number(params.limit) : 100
      if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须是 1 到 5000 的整数', 400)
      return result(await (persistence.operations ?? memoryOperations).list(workspaceId, limit))
    }
    case 'ops.audit.export': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'finance', 'platform_ops'])
      const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(5000, Math.max(1, Number(params.limit))) : 1000
      if (params.format !== undefined && params.format !== 'csv' && params.format !== 'json') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'format 必须是 csv 或 json', 400)
      const audits = await (persistence.operations ?? memoryOperations).list(workspaceId, limit)
      const alerts = await (persistence.alerts ?? memoryAlerts).list(workspaceId, undefined, limit)
      const rows = [...audits.map(item => ({ recordType: 'operation', id: item.id, createdAt: item.createdAt, actorId: item.actorId, action: item.action, resourceType: item.resourceType, resourceId: item.resourceId, status: '', reason: item.reason })), ...alerts.map(item => ({ recordType: 'alert', id: item.id, createdAt: item.updatedAt, actorId: item.acknowledgedBy ?? '', action: item.code, resourceType: item.entityType, resourceId: item.entityId, status: item.status, reason: item.acknowledgementReason ?? item.nextAction }))].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit)
      if (params.format === 'json') return result({ filename: `operations-${workspaceId}.json`, content: JSON.stringify(rows) })
      const content = ['record_type,id,created_at,actor_id,action,resource_type,resource_id,status,reason', ...rows.map(row => [row.recordType, row.id, row.createdAt, row.actorId, row.action, row.resourceType, row.resourceId, row.status, row.reason].map(value => csvCell(String(value))).join(','))].join('\n')
      return result({ filename: `operations-${workspaceId}.csv`, content })
    }
    case 'ops.data.delete.list': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'platform_ops'])
      const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Number(params.limit) : 100
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须是 1 到 500 的整数', 400)
      return result(await (persistence.dataLifecycle ?? memoryDataLifecycle).list(workspaceId, limit))
    }
    case 'ops.data.delete.cancel': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const reason = requiredOperationalReason(params)
      const request = await (persistence.dataLifecycle ?? memoryDataLifecycle).cancel({ workspaceId, id: required(params, 'request_id'), actorId, reason })
      await recordOperationAudit({ workspaceId, actorId, action: 'data.delete.cancel', resourceType: 'data_deletion_request', resourceId: request.id, before: { status: 'pending' }, after: request as unknown as Record<string, unknown>, reason })
      return result(request)
    }
    case 'ops.data.delete.approve': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const reason = requiredOperationalReason(params)
      const request = await (persistence.dataLifecycle ?? memoryDataLifecycle).approve({ workspaceId, id: required(params, 'request_id'), actorId, reason })
      await recordOperationAudit({ workspaceId, actorId, action: 'data.delete.approve', resourceType: 'data_deletion_request', resourceId: request.id, before: { status: 'pending' }, after: request as unknown as Record<string, unknown>, reason })
      return result(request)
    }
    case 'billing.usage.consume': {
      let charged
      try {
        charged = await (persistence.usage ?? memoryUsage).consume({ workspaceId, taskId: required(params, 'task_id'), idempotencyKey: required(params, 'idempotency_key'), actorId: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'actor_demo' })
      } catch (error) {
        if ((error as { code?: string })?.code === 'USAGE_IDEMPOTENCY_CONFLICT' || String(error).includes('USAGE_IDEMPOTENCY_CONFLICT')) throw new DomainError('USAGE_IDEMPOTENCY_CONFLICT', '用量幂等键已绑定到其他任务，请换用新的幂等键', 409)
        throw error
      }
      if (charged.charged) await recordOperationAudit({ workspaceId, actorId: requestPrincipals.get(req)?.actorId ?? 'actor_demo', action: 'usage.consume', resourceType: 'task', resourceId: required(params, 'task_id'), before: {}, after: charged.snapshot as unknown as Record<string, unknown>, reason: '任务额度消费' })
      return result(charged)
    }
    case 'billing.usage.refund': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'finance', 'platform_ops'])
      const refunded = await (persistence.usage ?? memoryUsage).refund({ workspaceId, taskId: required(params, 'task_id'), idempotencyKey: required(params, 'idempotency_key'), reason: required(params, 'reason'), actorId: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'actor_demo' })
      if (refunded.refunded) await recordOperationAudit({ workspaceId, actorId: requestPrincipals.get(req)?.actorId ?? 'actor_demo', action: 'usage.refund', resourceType: 'task', resourceId: required(params, 'task_id'), before: {}, after: refunded.snapshot as unknown as Record<string, unknown>, reason: required(params, 'reason') })
      return result(refunded)
    }
    case 'workspace.commercial.update': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const current = await (persistence.commercial ?? memoryCommercial).getSettings(workspaceId)
      const money = (name: string, fallback: number) => { const value = typeof params[name] === 'string' ? Number(params[name]) : fallback; if (!Number.isFinite(value) || value < 0 || !/^\d+(\.\d{1,2})?$/u.test(String(params[name] ?? value))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${name} 必须是非负金额，最多两位小数`, 400); return Number(value.toFixed(2)) }
      const integer = (name: string, fallback: number) => { const value = typeof params[name] === 'string' ? Number(params[name]) : fallback; if (!Number.isInteger(value) || value < 0) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${name} 必须是非负整数`, 400); return value }
      const updated = await (persistence.commercial ?? memoryCommercial).updateSettings({ workspaceId, planCode: required(params, 'plan_code'), planName: required(params, 'plan_name'), monthlyPriceCny: money('monthly_price_cny', current.monthlyPriceCny), annualPriceCny: money('annual_price_cny', current.annualPriceCny), includedStores: integer('included_stores', current.includedStores), includedTasks: integer('included_tasks', current.includedTasks), updatedBy: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'actor_demo', expectedRevision: params.expected_revision ? integer('expected_revision', current.revision) : undefined })
      await recordOperationAudit({ workspaceId, actorId: updated.updatedBy, action: 'commercial.settings.update', resourceType: 'commercial_settings', resourceId: workspaceId, before: current as unknown as Record<string, unknown>, after: updated as unknown as Record<string, unknown>, reason: typeof params.reason === 'string' ? params.reason : '运营配置更新' })
      return result(updated)
    }
    case 'platform.settings.get':
      return result({ platforms: await (persistence.commercial ?? memoryCommercial).listPlatformSettings(workspaceId) })
    case 'platform.model.status': {
      const textGate = evaluatePlatformModelGate(process.env, 'text')
      const imageGate = evaluatePlatformModelGate(process.env, 'image')
      const imageEditGate = evaluatePlatformModelGate(process.env, 'image_edit')
      const ocrGate = evaluatePlatformModelGate(process.env, 'ocr')
      const videoGate = evaluatePlatformModelGate(process.env, 'video')
      const relayGate = evaluatePlatformModelRelayGate(process.env)
      const costGate = evaluatePlatformModelCostGate(process.env)
      const releaseMetadataNames = ['PLUGIN_VERSION', 'SKILL_BUNDLE_VERSION', 'MCP_VERSION', 'CONNECTOR_BUILD', 'PROMPT_BUNDLE_VERSION']
      const releaseMetadataMissing = isProduction() ? releaseMetadataNames.filter(name => !process.env[name]?.trim() || process.env[name]!.trim().toLowerCase().includes('fixture') || process.env[name]!.trim().toLowerCase() === 'local') : []
      const releaseMetadataReady = releaseMetadataMissing.length === 0
      const providerUrl = process.env.MODEL_RELAY_BASE_URL?.trim()
      let providerHost: string | undefined
      try { providerHost = providerUrl ? new URL(providerUrl).host : undefined } catch { providerHost = undefined }
      const textReady = textGate.ready
      const imageReady = imageGate.ready
      const rpm = costGate.rpm
      const tpm = costGate.tpm
      const dailyCnyLimit = costGate.dailyCnyLimit
      const costEvidenceReady = !isProduction() || process.env.MODEL_RELAY_COST_EVIDENCE === 'true'
      const costControlReady = costGate.ready && costEvidenceReady
      const ocrReady = ocrGate.ready && Boolean(imageFactsExtractor)
      const imageEditReady = imageEditGate.ready && Boolean(imageEditGenerator)
      const videoReady = videoGate.ready && Boolean(videoGenerator)
      const allModelReady = textReady && imageReady && imageEditReady && ocrReady && videoReady
      return result({
        ownership: 'platform', user_key_binding: false, relay: { configured: relayGate.ready, host: relayGate.endpointHost ?? null, reasons: relayGate.reasons }, state: allModelReady && costControlReady && releaseMetadataReady && (!isProduction() || relayGate.ready) ? 'ready' : !releaseMetadataReady ? 'release_metadata_blocked' : isProduction() && !relayGate.ready ? 'model_relay_blocked' : allModelReady ? 'cost_gate_blocked' : textReady ? 'partial_model_readiness' : 'not_configured',
        provider_host: relayGate.endpointHost ?? textGate.endpointHost ?? providerHost ?? null, image_provider_host: relayGate.endpointHost ?? imageGate.endpointHost ?? null, text_model: process.env.AI_MODEL?.trim() || process.env.MODEL_ID?.trim() || null, image_model: process.env.IMAGE_MODEL?.trim() || process.env.AI_IMAGE_MODEL?.trim() || null, vision_model: process.env.OCR_MODEL?.trim() || process.env.AI_VISION_MODEL?.trim() || null, video_model: process.env.VIDEO_MODEL?.trim() || process.env.AI_VIDEO_MODEL?.trim() || null,
        capabilities: { text_generation: textReady, image_generation: imageReady, image_editing: imageEditReady, image_fact_ocr: ocrReady, video_rendering: videoReady }, endpoints: { text_https: textGate.https, image_https: imageGate.https, image_edit_https: imageEditGate.https, ocr_https: ocrGate.https, video_https: videoGate.https },
        model_readiness: { text: { ...textGate, provider_configured: textReady }, image: { ...imageGate, provider_configured: imageReady }, image_edit: { ...imageEditGate, provider_configured: imageEditReady }, ocr: { ...ocrGate, provider_configured: ocrReady }, video: { ...videoGate, provider_configured: videoReady } },
        quotas: { rpm: rpm || null, tpm: tpm || null, daily_cny_limit: dailyCnyLimit ? dailyCnyLimit.toFixed(2) : null },
        cost_control_ready: costControlReady, cost_evidence_ready: costEvidenceReady,
        release_metadata_ready: releaseMetadataReady, release_metadata_missing: releaseMetadataMissing,
        next_actions: [...(isProduction() && !relayGate.ready ? ['配置平台模型中转站：' + relayGate.reasons.join('、')] : []), ...(!textReady ? ['配置平台文案模型：' + textGate.reasons.join('、')] : []), ...(!imageReady ? ['配置平台图片模型：' + imageGate.reasons.join('、')] : []), ...(!imageEditReady ? ['配置图片编辑模型和中转 provider：' + imageEditGate.reasons.join('、')] : []), ...(!ocrReady ? ['配置 OCR_MODEL 和 OCR 中转 provider：' + ocrGate.reasons.join('、')] : []), ...(!videoReady ? ['配置 VIDEO_MODEL 和视频中转 provider：' + videoGate.reasons.join('、')] : []), ...(!costGate.ready ? ['配置并审批平台模型 RPM、TPM 和每日人民币成本上限'] : []), ...(!costEvidenceReady ? ['验证中转站 cost_cny，或验证价格快照、实际计费分组和人民币汇率后，再开启成本证据开关'] : []), ...(!releaseMetadataReady ? ['注入不可使用 fixture/local 默认值的发布版本、Skill、MCP、连接器和 prompt 元数据'] : []), ...(allModelReady && costControlReady && releaseMetadataReady && (!isProduction() || relayGate.ready) ? [] : ['完成平台模型供应商额度、成本和数据处理条款审批'])],
      })
    }
    case 'platform.settings.update': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const platform = required(params, 'platform') as CommercialPlatform
      if (!COMMERCIAL_PLATFORMS.includes(platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '不支持的平台', 400)
      const existing = (await (persistence.commercial ?? memoryCommercial).listPlatformSettings(workspaceId)).find(item => item.platform === platform)!
      const updated = await (persistence.commercial ?? memoryCommercial).updatePlatform({ workspaceId, platform, enabled: params.enabled === undefined ? existing.enabled : params.enabled === 'true', displayName: typeof params.display_name === 'string' ? params.display_name : existing.displayName, storeAlias: typeof params.store_alias === 'string' ? params.store_alias : existing.storeAlias, updatedBy: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'actor_demo', expectedRevision: params.expected_revision ? Number(params.expected_revision) : undefined })
      await recordOperationAudit({ workspaceId, actorId: updated.updatedBy, action: 'platform.settings.update', resourceType: 'platform_settings', resourceId: platform, before: existing as unknown as Record<string, unknown>, after: updated as unknown as Record<string, unknown>, reason: typeof params.reason === 'string' ? params.reason : '平台配置更新' })
      return result(updated)
    }
    case 'workspace.metrics': {
      const selectedPlatform = typeof params.platform === 'string' ? params.platform as Platform : undefined
      const selectedAccountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      if (selectedAccountId && !selectedPlatform) throw new DomainError('STORE_PLATFORM_REQUIRED', '使用 account_id 选择店铺时必须同时指定 platform', 400)
      const selectedAccount = selectedAccountId ? service.getPlatformAccount(workspaceId, selectedAccountId, selectedPlatform) : undefined
      const allProducts = service.listProducts(workspaceId)
      const allTasks = service.listTasks(workspaceId)
      const allSyncJobs = service.listSyncJobs(workspaceId)
      const allPublishJobs = service.listPublishJobs(workspaceId)
      const productByIdAll = new Map(allProducts.map(product => [product.id, product]))
      const taskAccount = (task: typeof allTasks[number]) => task.accountId ?? productByIdAll.get(task.productId)?.accountId
      const selected = (platform: Platform, accountId: string | undefined) => (!selectedPlatform || platform === selectedPlatform) && (!selectedAccountId || accountId === selectedAccountId)
      const products = allProducts.filter(product => selected(product.platform, product.accountId))
      const tasks = allTasks.filter(task => selected(task.platform, taskAccount(task)))
      const selectedTaskIds = new Set(tasks.map(task => task.id))
      const syncJobs = allSyncJobs.filter(job => selected(job.platform, job.accountId))
      const publishJobs = allPublishJobs.filter(job => selected(job.platform, job.accountId ?? (allTasks.find(task => task.id === job.taskId) ? taskAccount(allTasks.find(task => task.id === job.taskId)!) : undefined)))
      const generationJobs = [...service.generationJobs.values()].filter(job => job.workspaceId === workspaceId && selectedTaskIds.has(job.taskId))
      const contentVersions = [...service.contentVersions.values()].filter(version => selectedTaskIds.has(version.taskId))
      const parsePeriodBoundary = (key: 'date_from' | 'date_to') => {
        if (typeof params[key] !== 'string' || !params[key]!.trim()) return undefined
        const value = params[key]!.trim()
        if (!Number.isFinite(Date.parse(value))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是合法 ISO 时间`, 400)
        return new Date(value).toISOString()
      }
      const dateFrom = parsePeriodBoundary('date_from')
      const dateTo = parsePeriodBoundary('date_to')
      if (dateFrom && dateTo && dateFrom > dateTo) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'date_from 不能晚于 date_to', 400)
      if (typeof params.risk_limit === 'string' && params.risk_limit.trim() && !/^[1-9]\d*$/u.test(params.risk_limit.trim())) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'risk_limit 必须是正整数', 400)
      const requestedRiskLimit = typeof params.risk_limit === 'string' && params.risk_limit.trim() ? Number(params.risk_limit) : 50
      const riskLimit = Math.min(100, Math.max(1, requestedRiskLimit))
      const inPeriod = (at: string | undefined) => Boolean(at) && (!dateFrom || at! >= dateFrom) && (!dateTo || at! <= dateTo)
      const contentReviews = contentVersions.map(version => ({ version, findings: service.reviewContent(workspaceId, version.id) }))
      const p0FindingCount = contentReviews.reduce((count, item) => count + item.findings.filter(finding => finding.severity === 'error').length, 0)
      const recoveredTasks = tasks.filter(task => task.state === 'failed_recoverable').length
      const lowStockProducts = products.filter(product => typeof product.stock === 'number' && product.stock <= 10)
      const missingImageProducts = products.filter(product => !product.images?.length)
      const latestSyncByStore = new Map<string, typeof syncJobs[number]>()
      for (const job of [...syncJobs].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))) latestSyncByStore.set(`${job.platform}:${job.accountId}`, job)
      const failedSyncJobs = [...latestSyncByStore.values()].filter(job => job.state === 'failed' || job.state === 'partial')
      const recommendations = [
        ...(lowStockProducts.length ? [{ code: 'LOW_STOCK', priority: 'high', title: '检查低库存商品', action: `有 ${lowStockProducts.length} 个商品库存低于安全线，建议先确认补货或调整投放。`, evidence: lowStockProducts.slice(0, 5).map(product => product.title) }] : []),
        ...(missingImageProducts.length ? [{ code: 'MISSING_IMAGES', priority: 'high', title: '补齐商品主图', action: `有 ${missingImageProducts.length} 个商品没有可审阅主图，建议先从素材库上传并完成权益/安全扫描。`, evidence: missingImageProducts.slice(0, 5).map(product => product.title) }] : []),
        ...(failedSyncJobs.length ? [{ code: 'SYNC_RISK', priority: 'medium', title: '处理同步异常', action: `有 ${failedSyncJobs.length} 个同步任务失败或部分失败，建议查看失败项并重试，不要直接发布旧数据。`, evidence: failedSyncJobs.slice(0, 5).map(job => job.id) }] : []),
        ...(p0FindingCount ? [{ code: 'CONTENT_BLOCKING', priority: 'high', title: '处理内容审核阻断', action: `有 ${p0FindingCount} 个内容审核阻断项，建议先修正文案或素材，再进入发布预览。`, evidence: [`${p0FindingCount} 个阻断项`] }] : []),
      ]
      if (!recommendations.length) recommendations.push({ code: 'NEXT_BEST_ACTION', priority: 'low', title: '继续优化重点商品', action: '当前没有发现阻断风险，可以选择一个已确认商品生成详情和主图，并在发布前完成人工复核。', evidence: [] })
      const platformMetrics = Object.fromEntries(SUPPORTED_PLATFORMS.map(platform => {
        const accounts = service.listPlatformAccounts(workspaceId).filter(account => account.platform === platform && (!selectedAccountId || account.id === selectedAccountId))
        const sync = syncJobs.filter(job => job.platform === platform)
        const publish = publishJobs.filter(job => job.platform === platform)
        return [platform, {
          accounts: { total: accounts.length, connected: accounts.filter(account => account.tokenState === 'connected').length, revoked: accounts.filter(account => account.tokenState === 'revoked').length, refreshRequired: accounts.filter(account => account.tokenState === 'refresh_required').length },
          sync: { total: sync.length, succeeded: sync.filter(job => job.state === 'succeeded').length, partial: sync.filter(job => job.state === 'partial').length, failed: sync.filter(job => job.state === 'failed').length },
          publish: { total: publish.length, submitted: publish.filter(job => job.remoteState === 'submitted').length, published: publish.filter(job => job.remoteState === 'published' || job.state === 'published').length, rejected: publish.filter(job => job.remoteState === 'rejected' || job.state === 'rejected').length, unknown: publish.filter(job => job.remoteState === 'unknown' || job.state === 'unknown' || job.state === 'manual_attention').length },
        }]
      }))

      const accounts = service.listPlatformAccounts(workspaceId).filter(account => selected(account.platform, account.id))
      const productById = new Map(products.map(product => [product.id, product]))
      const taskById = new Map(tasks.map(task => [task.id, task]))
      const resolvedTaskAccount = (task: typeof tasks[number]) => task.accountId ?? productById.get(task.productId)?.accountId
      const resolvedPublishAccount = (job: typeof publishJobs[number]) => job.accountId ?? (taskById.get(job.taskId) ? resolvedTaskAccount(taskById.get(job.taskId)!) : undefined)
      const storeKeys = new Map<string, { platform: Platform; accountId: string }>()
      const addStoreKey = (platform: Platform, accountId: string | undefined) => { if (accountId) storeKeys.set(`${platform}:${accountId}`, { platform, accountId }) }
      for (const account of accounts) addStoreKey(account.platform, account.id)
      for (const product of products) addStoreKey(product.platform, product.accountId)
      for (const task of tasks) addStoreKey(task.platform, resolvedTaskAccount(task))
      for (const job of syncJobs) addStoreKey(job.platform, job.accountId)
      for (const job of publishJobs) addStoreKey(job.platform, resolvedPublishAccount(job))

      type RiskItem = { key: string; type: string; severity: 'high' | 'medium'; platform: Platform; accountId?: string; storeName?: string; entityType: string; entityId: string; title: string; status: string; observedAt?: string; evidence: Record<string, unknown>; nextAction: string }
      const riskItems: RiskItem[] = []
      const pushRisk = (item: RiskItem) => riskItems.push(item)
      const latestPublishByTask = new Map<string, typeof publishJobs[number]>()
      for (const job of [...publishJobs].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) latestPublishByTask.set(job.taskId, job)

      const stores = [...storeKeys.values()].sort((left, right) => `${left.platform}:${left.accountId}`.localeCompare(`${right.platform}:${right.accountId}`)).map(({ platform, accountId }) => {
        const account = accounts.find(item => item.platform === platform && item.id === accountId)
        const storeProducts = products.filter(product => product.platform === platform && product.accountId === accountId)
        const storeTasks = tasks.filter(task => task.platform === platform && resolvedTaskAccount(task) === accountId)
        const storeSync = syncJobs.filter(job => job.platform === platform && job.accountId === accountId)
        const storePublish = publishJobs.filter(job => job.platform === platform && resolvedPublishAccount(job) === accountId)
        const periodTasks = storeTasks.filter(task => inPeriod(task.createdAt))
        const periodSync = storeSync.filter(job => inPeriod(job.createdAt))
        const periodPublish = storePublish.filter(job => inPeriod(job.createdAt))
        const latestSync = [...storeSync].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
        const lastSuccessfulSync = [...storeSync].filter(job => job.state === 'succeeded').sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
        const lastUsableSync = [...storeSync].filter(job => job.state === 'succeeded' || job.state === 'partial').sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
        const latestPublish = [...storePublish].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
        const storeNames = [...new Set(storeProducts.map(product => product.storeName).filter(Boolean))].sort()
        const platformStoreName = storeNames.length === 1 ? storeNames[0]! : storeNames.length > 1 ? `${storeNames[0]} 等 ${storeNames.length} 个店铺名` : `${platform} 店铺`
        const storeAlias = account?.storeAlias
        const storeName = storeAlias ?? platformStoreName
        const connectionState = account?.tokenState ?? 'account_not_registered'
        const simulated = fixtureMode || storeProducts.some(product => product.source === 'fixture')
        const officialReadable = !simulated && account?.tokenState === 'connected' && connectorRuntime.canRead(platform)
        const dataMode = simulated ? 'fixture' : officialReadable ? 'official_api' : account ? 'account_record_only' : 'unavailable'
        const readable = Boolean(account && account.tokenState === 'connected' && (simulated || officialReadable))
        const currentVersions = contentReviews.filter(item => {
          const task = taskById.get(item.version.taskId)
          return task?.contentVersionId === item.version.id && task.platform === platform && resolvedTaskAccount(task) === accountId
        })
        const blockingFindings = currentVersions.reduce((count, item) => count + item.findings.filter(finding => finding.severity === 'error').length, 0)

        if (account && account.tokenState !== 'connected') pushRisk({ key: `AUTH_RECONNECT:${platform}:${accountId}`, type: 'AUTH_RECONNECT', severity: 'high', platform, accountId, storeName, entityType: 'platform_account', entityId: accountId, title: '店铺授权需重新连接', status: account.tokenState, observedAt: account.revokedAt ?? account.tokenStateUpdatedAt, evidence: { tokenState: account.tokenState, accountRevision: account.authRevision ?? account.revision, dataMode }, nextAction: '在交互会话中重新发起官方授权' })
        if (latestSync && (latestSync.state === 'failed' || latestSync.state === 'partial')) pushRisk({ key: `SYNC_RISK:${platform}:${accountId}`, type: latestSync.state === 'failed' ? 'SYNC_FAILED' : 'SYNC_PARTIAL', severity: latestSync.state === 'failed' ? 'high' : 'medium', platform, accountId, storeName, entityType: 'sync_job', entityId: latestSync.id, title: latestSync.state === 'failed' ? '最新商品同步失败' : '最新商品同步部分失败', status: latestSync.state, observedAt: latestSync.updatedAt, evidence: { jobId: latestSync.id, itemsFailed: latestSync.itemsFailed, pages: latestSync.pages }, nextAction: '在交互会话中查看失败项并确认是否重试' })
        for (const product of storeProducts) {
          if (product.stock <= 10) pushRisk({ key: `LOW_STOCK:${product.id}`, type: 'LOW_STOCK', severity: 'high', platform, accountId, storeName, entityType: 'product', entityId: product.id, title: product.title, status: 'low_stock', observedAt: product.updatedAt, evidence: { stock: product.stock, threshold: 10 }, nextAction: '确认补货、下架或调整推广计划' })
          if (!product.images?.length) pushRisk({ key: `MISSING_IMAGES:${product.id}`, type: 'MISSING_IMAGES', severity: 'high', platform, accountId, storeName, entityType: 'product', entityId: product.id, title: product.title, status: 'missing', observedAt: product.updatedAt, evidence: { imageCount: 0 }, nextAction: '在交互会话中补齐主图并完成权益与安全审查' })
        }
        for (const item of currentVersions) {
          const errors = item.findings.filter(finding => finding.severity === 'error')
          if (!errors.length) continue
          const task = taskById.get(item.version.taskId)!
          pushRisk({ key: `CONTENT_BLOCKING:${item.version.id}`, type: 'CONTENT_BLOCKING', severity: 'high', platform, accountId, storeName, entityType: 'content_version', entityId: item.version.id, title: `任务 ${task.id} 存在内容阻断`, status: item.version.state, evidence: { taskId: task.id, findingCount: errors.length, findingCodes: [...new Set(errors.map(finding => finding.code))].sort() }, nextAction: '在交会话中修正内容并重新审核' })
        }
        for (const job of storePublish.filter(job => latestPublishByTask.get(job.taskId)?.id === job.id)) {
          const state = job.remoteState ?? job.state
          if (state !== 'rejected' && state !== 'unknown' && state !== 'manual_attention') continue
          const rejected = state === 'rejected'
          pushRisk({ key: `PUBLISH_STATUS:${job.taskId}`, type: rejected ? 'PUBLISH_REJECTED' : 'PUBLISH_UNKNOWN', severity: 'high', platform, accountId, storeName, entityType: 'publish_job', entityId: job.id, title: rejected ? '平台发布被驳回' : '平台发布状态未知', status: state, observedAt: job.remoteObservedAt ?? job.createdAt, evidence: rejected ? { taskId: job.taskId, jobId: job.id, rawCode: job.rejection?.rawCode, fields: job.rejection?.fields.map(field => ({ path: field.path, rawCode: field.rawCode, message: field.message })) ?? [] } : { taskId: job.taskId, jobId: job.id }, nextAction: rejected ? '在交互会话中根据驳回原因创建修正版，重新审核和确认' : '在交互会话中核对平台回执，不要自动重发' })
        }

        return {
          platform, accountId, storeName, storeAlias: storeAlias ?? null, platformStoreName, storeNames,
          connection: { state: connectionState, dataMode, readable, simulated },
          authorization: account ? publicAuthorization(account, simulated) : null,
          product: { total: storeProducts.length, onSale: storeProducts.filter(product => product.listingStatus === 'on_sale').length, lowStock: storeProducts.filter(product => product.stock <= 10).length, missingImages: storeProducts.filter(product => !product.images?.length).length, mappingWarnings: storeProducts.filter(product => product.mappingWarnings?.length).length, unconfirmedFacts: storeProducts.filter(product => !product.factsConfirmed).length, lastUpdatedAt: [...storeProducts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.updatedAt ?? null },
          sync: { total: periodSync.length, succeeded: periodSync.filter(job => job.state === 'succeeded').length, partial: periodSync.filter(job => job.state === 'partial').length, failed: periodSync.filter(job => job.state === 'failed').length, latestJobId: latestSync?.id ?? null, latestState: latestSync?.state ?? null, latestAt: latestSync?.updatedAt ?? null, lastAttemptAt: latestSync?.updatedAt ?? null, lastSuccessfulAt: lastSuccessfulSync?.updatedAt ?? null, lastUsableAt: lastUsableSync?.updatedAt ?? null, failedItems: latestSync?.itemsFailed ?? 0 },
          tasks: { created: periodTasks.length, byState: Object.fromEntries([...new Set(periodTasks.map(task => task.state))].sort().map(state => [state, periodTasks.filter(task => task.state === state).length])) },
          publish: { total: periodPublish.length, submitted: periodPublish.filter(job => job.remoteState === 'submitted' || job.state === 'submitted').length, published: periodPublish.filter(job => job.remoteState === 'published' || job.state === 'published').length, rejected: periodPublish.filter(job => job.remoteState === 'rejected' || job.state === 'rejected').length, unknown: periodPublish.filter(job => job.remoteState === 'unknown' || job.state === 'unknown' || job.state === 'manual_attention').length, latestJobId: latestPublish?.id ?? null, latestState: latestPublish ? latestPublish.remoteState ?? latestPublish.state : null, latestAt: latestPublish ? latestPublish.remoteObservedAt ?? latestPublish.createdAt : null },
          quality: { blockingFindings },
        }
      })

      // Local imports and legacy snapshots can legitimately exist before a
      // platform account is bound. Keep their risks visible, but never place
      // them in stores[] or imply that they came from a real authorized shop.
      for (const product of products.filter(item => !item.accountId)) {
        if (product.stock <= 10) pushRisk({ key: `LOW_STOCK:${product.id}`, type: 'LOW_STOCK', severity: 'high', platform: product.platform, entityType: 'product', entityId: product.id, title: product.title, status: 'low_stock', observedAt: product.updatedAt, evidence: { stock: product.stock, threshold: 10, unboundLocalData: true }, nextAction: '先在交互会话中确认商品所属店铺，再处理补货、下架或推广计划' })
        if (!product.images?.length) pushRisk({ key: `MISSING_IMAGES:${product.id}`, type: 'MISSING_IMAGES', severity: 'high', platform: product.platform, entityType: 'product', entityId: product.id, title: product.title, status: 'missing', observedAt: product.updatedAt, evidence: { imageCount: 0, unboundLocalData: true }, nextAction: '先在交互会话中确认商品所属店铺，再补齐主图并完成权益与安全审查' })
      }
      for (const item of contentReviews) {
        const task = taskById.get(item.version.taskId)
        if (!task || task.contentVersionId !== item.version.id || resolvedTaskAccount(task)) continue
        const errors = item.findings.filter(finding => finding.severity === 'error')
        if (!errors.length) continue
        pushRisk({ key: `CONTENT_BLOCKING:${item.version.id}`, type: 'CONTENT_BLOCKING', severity: 'high', platform: task.platform, entityType: 'content_version', entityId: item.version.id, title: `任务 ${task.id} 存在内容阻断`, status: item.version.state, evidence: { taskId: task.id, findingCount: errors.length, findingCodes: [...new Set(errors.map(finding => finding.code))].sort(), unboundLocalData: true }, nextAction: '先在交互会话中确认任务所属店铺，再修正内容并重新审核' })
      }
      for (const job of publishJobs.filter(item => !resolvedPublishAccount(item) && latestPublishByTask.get(item.taskId)?.id === item.id)) {
        const state = job.remoteState ?? job.state
        if (state !== 'rejected' && state !== 'unknown' && state !== 'manual_attention') continue
        const rejected = state === 'rejected'
        pushRisk({ key: `PUBLISH_STATUS:${job.taskId}`, type: rejected ? 'PUBLISH_REJECTED' : 'PUBLISH_UNKNOWN', severity: 'high', platform: job.platform, entityType: 'publish_job', entityId: job.id, title: rejected ? '未绑定店铺的发布被驳回' : '未绑定店铺的发布状态未知', status: state, observedAt: job.remoteObservedAt ?? job.createdAt, evidence: rejected ? { taskId: job.taskId, jobId: job.id, rawCode: job.rejection?.rawCode, fields: job.rejection?.fields.map(field => ({ path: field.path, rawCode: field.rawCode, message: field.message })) ?? [], unboundLocalData: true } : { taskId: job.taskId, jobId: job.id, unboundLocalData: true }, nextAction: '先在交互会话中确认发布所属店铺并核对平台回执，不要自动重发' })
      }

      const severityOrder = { high: 0, medium: 1 } as const
      riskItems.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity] || left.key.localeCompare(right.key))
      const metricDates = [...products.map(product => product.updatedAt), ...syncJobs.map(job => job.updatedAt), ...tasks.map(task => task.createdAt), ...publishJobs.map(job => job.remoteObservedAt ?? job.createdAt)].filter(Boolean).sort()
      const unboundProducts = products.filter(product => !product.accountId)
      const unboundTasks = tasks.filter(task => !resolvedTaskAccount(task))
      const unboundPublish = publishJobs.filter(job => !resolvedPublishAccount(job))
      const operationalStores = stores.map(({ platform, accountId, connection, product, sync, tasks: storeTasks, publish, quality }) => ({ platform, accountId, connection, product, sync, tasks: storeTasks, publish, quality }))
      const snapshotHash = createHash('sha256').update(canonicalJson({ stores: operationalStores, risks: riskItems.map(item => ({ key: item.key, status: item.status, observedAt: item.observedAt, evidence: item.evidence })), unbound: { products: unboundProducts.map(item => item.id).sort(), tasks: unboundTasks.map(item => item.id).sort(), publishJobs: unboundPublish.map(item => item.id).sort() } })).digest('hex')
      const warnings = [
        '指标来自当前工作区可持久化业务状态；平台外部吞吐和最终审核不在本地统计中，模型中转 usage/cost 以 model_usage_ledger 为准',
        'quality.recoveryRate 是历史兼容字段，实际表示可恢复失败任务占比；新客户端请使用 quality.recoverableTaskRate',
        '新增、升级和已恢复风险需由 Codex App 原生运行历史根据稳定 risk key 比较，当前响应不伪造历史基线',
      ]
      await persistenceReady
      const modelUsage = persistence.modelUsage ? await persistence.modelUsage.list(workspaceId, 1000) : []
      const modelChargeCny = modelUsage.reduce((sum, item) => sum + (item.customerChargeCny ?? 0), 0)
      const modelTokens = modelUsage.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0)
      return result({
        generatedAt: new Date().toISOString(),
        selection: { mode: selectedAccountId ? 'single_store' : selectedPlatform ? 'platform' : 'workspace', platform: selectedPlatform ?? null, accountId: selectedAccountId ?? null, alias: selectedAccount?.storeAlias ?? null, matchedStores: stores.length },
        period: { from: dateFrom ?? null, to: dateTo ?? null, activityFiltered: Boolean(dateFrom || dateTo), productRisksAreCurrentSnapshot: true },
        comparisonAvailable: false,
        comparisonReason: 'baseline_unavailable',
        dataCoverage: { firstObservedAt: metricDates[0] ?? null, lastObservedAt: metricDates.at(-1) ?? null, products: products.length, tasks: tasks.length, syncJobs: syncJobs.length, publishJobs: publishJobs.length, fixtureDataPresent: fixtureMode || products.some(product => product.source === 'fixture') },
        stores,
        unboundLocalData: { products: unboundProducts.length, tasks: unboundTasks.length, publishJobs: unboundPublish.length, risks: riskItems.filter(item => !item.accountId).length, note: '这些本地数据没有 accountId，不归入任何真实店铺聚合' },
        riskItems: riskItems.slice(0, riskLimit),
        riskSummary: { total: riskItems.length, returned: Math.min(riskItems.length, riskLimit), truncated: riskItems.length > riskLimit, limit: riskLimit },
        snapshotHash,
        productSummary: { total: products.length, lowStock: lowStockProducts.length, missingImages: missingImageProducts.length }, recommendations, platformMetrics,
        taskFunnel: Object.fromEntries([...new Set(tasks.map(task => task.state))].map(state => [state, tasks.filter(task => task.state === state).length])),
        quality: { p0FindingCount, recoverableTaskRate: tasks.length ? recoveredTasks / tasks.length : 0, recoveryRate: tasks.length ? recoveredTasks / tasks.length : 0, modelFailureRate: generationJobs.length ? generationJobs.filter(job => job.state === 'failed').length / generationJobs.length : 0 },
        jobs: { sync: syncJobs.length, generation: generationJobs.length, generationFailed: generationJobs.filter(job => job.state === 'failed').length, publish: publishJobs.length },
        cost: { available: true, source: 'model_usage_ledger', model_usage_records: modelUsage.length, total_tokens: modelTokens, model_charge_cny: modelChargeCny.toFixed(6), note: '仅展示当前工作区已结算的模型使用费；内部成本和定价策略不对商家端暴露' }, warnings,
      })
    }
    case 'billing.status': {
      await persistenceReady
      const balanceFen = persistence.billing ? await persistence.billing.balanceFen(workspaceId) : walletBalanceFen(workspaceId)
      const usage = persistence.usage ? await persistence.usage.get(workspaceId) : undefined
      const stores = await storeCapacity(workspaceId)
      const actions = persistence.actionLedger ? await persistence.actionLedger.list(workspaceId, 1000) : []
      const pendingActions = actions.filter(item => ['authorized', 'pending_receipt', 'manual_attention'].includes(item.settlementStatus ?? ''))
      const pendingAuthorizationFen = pendingActions.reduce((sum, item) => sum + (item.reservedAmountFen ?? item.amountFen), 0)
      return result({
        currency: 'CNY',
        balance_cny: (balanceFen / 100).toFixed(2),
        available_balance_cny: (balanceFen / 100).toFixed(2),
        pending_authorization_cny: (pendingAuthorizationFen / 100).toFixed(2),
        wallet_total_cny: ((balanceFen + pendingAuthorizationFen) / 100).toFixed(2),
        settlement_pending_count: pendingActions.length,
        settlement_message: pendingAuthorizationFen > 0 ? `¥${(pendingAuthorizationFen / 100).toFixed(2)} 正在等待模型成本确认，暂未作为最终消费` : null,
        billing_mode: process.env.PAYMENT_MODE === 'provider' ? 'provider' : 'fixture',
        model_access: { ownership: 'platform', user_key_required: false, access_state: balanceFen > 0 && usage && usage.remainingTasks > 0 ? 'included_quota_available' : balanceFen > 0 ? 'wallet_overage_available' : 'recharge_required', message: balanceFen <= 0 ? '请先充值插件钱包，到账后开放生成、图片、OCR、SEO/GEO、视频和发布能力' : usage && usage.remainingTasks > 0 ? `当前套餐剩余 ${usage.remainingTasks} 次模型行动额度，优先消耗套餐额度` : '套餐额度已用尽，将从插件钱包余额扣除套餐外模型行动' },
        action_entitlement: usage ? { included_tasks: usage.includedTasks, used_tasks: usage.usedTasks, remaining_tasks: usage.remainingTasks, overage_policy: 'wallet' } : { overage_policy: 'wallet' },
        plugin_access: { unlocked: balanceFen > 0, balance_cny: (balanceFen / 100).toFixed(2), unlocks: ['内容生成', '图片生成', '图片/OCR解析', '创意Brief与预览', 'SEO/GEO标题', '视频请求', '发布任务'] },
        recharge_channels: ['alipay', 'wechat'],
        store_capacity: { ...stores, upgrade_actions: ['升级套餐增加店铺数', '购买店铺加购包'], action_cards: commercialActionCards() },
        provider_ready: process.env.PAYMENT_MODE === 'provider' && paymentProviderReadiness().ready,
        next_actions: balanceFen <= 0 ? ['选择支付宝或微信创建充值订单'] : [],
        action_cards: billingActionCards(),
      })
    }
    case 'billing.recharge.create': {
      const channel = params.channel === 'alipay' || params.channel === 'wechat' ? params.channel : undefined
      if (!channel) throw new DomainError('BILLING_CHANNEL_INVALID', '充值渠道必须是支付宝或微信', 400)
      const amountFen = parseCnyToFen(params.amount_cny)
      const idempotencyKey = typeof params.idempotency_key === 'string' && params.idempotency_key.trim() ? params.idempotency_key.trim() : `recharge-${workspaceId}-${channel}-${amountFen}`
      const rechargeKey = `${workspaceId}:${idempotencyKey}`
      const existingId = rechargeIdempotency.get(rechargeKey)
      if (existingId) {
        const existing = rechargeOrders.get(existingId)
        if (!existing) rechargeIdempotency.delete(rechargeKey)
        else {
          if (existing.channel !== channel || existing.amountFen !== amountFen) throw new DomainError('BILLING_ORDER_IDEMPOTENCY_CONFLICT', '充值订单幂等键已被其他支付意图使用', 409)
          return result(publicMoneyRecord(existing))
        }
      }
      const inFlight = rechargeCreationInFlight.get(rechargeKey)
      if (inFlight) {
        if (inFlight.channel !== channel || inFlight.amountFen !== amountFen) throw new DomainError('BILLING_ORDER_IDEMPOTENCY_CONFLICT', '充值订单幂等键已被其他支付意图使用', 409)
        return result(await inFlight.promise)
      }
      const providerMode = process.env.PAYMENT_MODE === 'provider'
      const creation = (async () => {
      if (persistence.billing) {
        const durableExisting = await persistence.billing.getOrderByIdempotencyKey(workspaceId, idempotencyKey)
        if (durableExisting) {
          if (durableExisting.channel !== channel || durableExisting.amountFen !== amountFen || durableExisting.paymentMode !== (providerMode ? 'provider' : 'fixture')) throw new DomainError('BILLING_ORDER_IDEMPOTENCY_CONFLICT', '充值订单幂等键已被其他支付意图使用', 409)
          return { ...publicMoneyRecord(durableExisting), warning: durableExisting.paymentMode === 'provider' ? '请完成支付，系统只接受支付服务商签名回调后入账' : '当前为本地 fixture，不会产生真实扣款' }
        }
      }
      const localFixturePayment = fixturePaymentAllowed()
      if (isProduction() && !providerMode && !localFixturePayment) throw new DomainError('PAYMENT_NOT_CONFIGURED', '生产环境未配置支付宝/微信支付服务商', 503)
      if (providerMode) {
        const readiness = paymentProviderReadiness()
        if (!readiness.ready) throw new DomainError('PAYMENT_NOT_CONFIGURED', `生产环境支付 provider 未就绪：${readiness.reasons.join(', ')}`, 503, { reasons: readiness.reasons })
      }
      // Keep the provider-side order id stable across retries of the same
      // idempotency key, preventing duplicate provider checkouts.
      const orderId = `recharge_${createHash('sha256').update(`${workspaceId}:${idempotencyKey}`).digest('hex').slice(0, 32)}`
      let paymentUrl: string
      if (providerMode) {
        if (!paymentProvider) throw new DomainError('PAYMENT_NOT_CONFIGURED', '支付 provider adapter 未装配', 503)
        const callbackBase = process.env.PAYMENT_CALLBACK_BASE_URL!.replace(/\/$/u, '')
        try {
          const checkout = await paymentProvider.createCheckout({ channel, orderId, idempotencyKey, workspaceId, amountFen, callbackUrl: `${callbackBase}/billing/callback/${channel}`, description: `merchant-marketing 插件钱包充值 ${amountFen} 分` })
          paymentUrl = checkout.paymentUrl
        } catch (error) {
          throw new DomainError('PAYMENT_PROVIDER_CHECKOUT_FAILED', error instanceof Error ? error.message : '支付服务商下单失败', 503)
        }
      } else paymentUrl = `fixture://${channel}/${workspaceId}/${amountFen}?order_id=${encodeURIComponent(orderId)}`
      const order: RechargeOrder = { id: orderId, workspaceId, channel, amountFen, state: 'pending', paymentMode: providerMode ? 'provider' : 'fixture', paymentUrl, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      if (persistence.billing) {
        const durable = await persistence.billing.createOrder({ ...order, idempotencyKey })
        return { ...publicMoneyRecord(durable), warning: providerMode ? '请完成支付，系统只接受支付服务商签名回调后入账' : '当前为本地 fixture，不会产生真实扣款' }
      }
      rechargeOrders.set(order.id, order)
      rechargeIdempotency.set(rechargeKey, order.id)
      return { ...publicMoneyRecord(order), warning: providerMode ? '请完成支付，系统只接受支付服务商签名回调后入账' : '当前为本地 fixture，不会产生真实扣款' }
      })()
      rechargeCreationInFlight.set(rechargeKey, { channel, amountFen, promise: creation })
      try {
        return result(await creation)
      } finally {
        if (rechargeCreationInFlight.get(rechargeKey)?.promise === creation) rechargeCreationInFlight.delete(rechargeKey)
      }
    }
    case 'billing.recharge.get': {
      await persistenceReady
      const orderId = required(params, 'order_id')
      const order = persistence.billing ? await persistence.billing.getOrder(workspaceId, orderId) : rechargeOrders.get(orderId)
      if (!order || order.workspaceId !== workspaceId) throw new DomainError('BILLING_ORDER_NOT_FOUND', '充值订单不存在或不属于当前工作区', 404)
      if (params.confirm_test_payment === 'true') {
        if (!fixturePaymentAllowed() || order.paymentMode !== 'fixture') throw new DomainError('PAYMENT_TEST_MODE_DISABLED', '当前环境不允许确认测试支付；正式订单必须等待支付服务商回调', 403)
        const replayed = order.state === 'paid'
        const providerTradeId = `local-test-${order.id}`
        const paid = replayed ? order : await markRechargePaid({ workspaceId, orderId: order.id, providerTradeId, amountFen: order.amountFen })
        if (!paid) throw new DomainError('BILLING_ORDER_NOT_FOUND', '充值订单不存在或不属于当前工作区', 404)
        if (!replayed) {
          await persistEvent(workspaceId, order.id, 'billing.recharge.paid', 1, { order_id: order.id, provider_trade_id: providerTradeId, amount_fen: order.amountFen, channel: order.channel, source: 'local_test_checkout' })
          await recordOperationAudit({ workspaceId, actorId: 'local_test_checkout', action: 'billing.recharge.paid', resourceType: 'billing_order', resourceId: order.id, before: order as unknown as Record<string, unknown>, after: paid as unknown as Record<string, unknown>, reason: '本地测试收银台确认支付' })
        }
        return result({ ...publicMoneyRecord(paid), test_payment_confirmed: true, replayed })
      }
      let providerStatus: import('../../../packages/billing/src/payment-provider.js').PaymentStatusResult | undefined
      if (order.paymentMode === 'provider' && order.state === 'pending' && paymentProvider?.queryStatus) {
        try {
          providerStatus = await paymentProvider.queryStatus({ channel: order.channel, orderId: order.id, workspaceId })
          if (providerStatus.state === 'paid') {
            if (providerStatus.amountFen !== order.amountFen) throw new DomainError('PAYMENT_QUERY_AMOUNT_MISMATCH', '支付服务商查单金额缺失或与充值订单不一致', 409, { order_id: order.id, expected_amount_fen: order.amountFen, observed_amount_fen: providerStatus.amountFen ?? null })
            if (!providerStatus.providerTradeId) throw new DomainError('PAYMENT_QUERY_TRADE_ID_MISSING', '支付服务商已支付但未返回交易号，暂不入账', 409, { order_id: order.id })
            const paid = await markRechargePaid({ workspaceId, orderId: order.id, providerTradeId: providerStatus.providerTradeId, amountFen: order.amountFen })
            if (paid) {
              await persistEvent(workspaceId, order.id, 'billing.recharge.paid', 1, { order_id: order.id, provider_trade_id: providerStatus.providerTradeId, amount_fen: order.amountFen, channel: order.channel, source: 'provider_query' })
              await recordOperationAudit({ workspaceId, actorId: 'payment_provider_query', action: 'billing.recharge.paid', resourceType: 'billing_order', resourceId: order.id, before: order as unknown as Record<string, unknown>, after: paid as unknown as Record<string, unknown>, reason: '支付服务商查单确认到账' })
              return result({ ...publicMoneyRecord(paid), providerStatus })
            }
          }
        } catch (error) {
          if (error instanceof DomainError) throw error
          throw new DomainError('PAYMENT_PROVIDER_QUERY_FAILED', error instanceof Error ? error.message : '支付服务商查单失败', 503)
        }
      }
      return result({ ...publicMoneyRecord(order), ...(providerStatus ? { providerStatus } : {}) })
    }
    case 'billing.recharge.list': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'finance', 'platform_ops'])
      const allowedStates: RechargeState[] = ['pending', 'paid', 'closed', 'failed']
      const requestedStates = typeof params.states === 'string' && params.states.trim() ? [...new Set(params.states.split(',').map(value => value.trim()).filter(Boolean))] : allowedStates
      if (requestedStates.some(state => !allowedStates.includes(state as RechargeState))) throw new DomainError('BILLING_ORDER_STATE_INVALID', '充值订单状态只能是 pending、paid、closed 或 failed', 400)
      const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(100, Math.max(1, Number(params.limit))) : 100
      if (persistence.billing) {
        const [orders, summary] = await Promise.all([
          persistence.billing.listOrders(workspaceId, requestedStates as RechargeState[], limit),
          persistence.billing.countOrdersByState(workspaceId),
        ])
        const total = Object.values(summary).reduce((sum, count) => sum + count, 0)
        return result({ orders: orders.map(publicRechargeOrder), summary, returned: orders.length, total })
      }
      const allOrders = [...rechargeOrders.values()]
        .filter(order => order.workspaceId === workspaceId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      const orders = allOrders.filter(order => requestedStates.includes(order.state)).slice(0, limit)
      const summary = Object.fromEntries(allowedStates.map(state => [state, allOrders.filter(order => order.state === state).length]))
      return result({ orders: orders.map(publicRechargeOrder), summary, returned: orders.length, total: allOrders.length })
    }
    case 'billing.transactions': {
      const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(100, Math.max(1, Number(params.limit))) : 20
      await persistenceReady
      if (persistence.billing) {
        const [balanceFen, transactions] = await Promise.all([persistence.billing.balanceFen(workspaceId), persistence.billing.listTransactions(workspaceId, limit)])
        return result({ balance_cny: (balanceFen / 100).toFixed(2), transactions: transactions.map(publicMoneyRecord) })
      }
      return result({ balance_cny: (walletBalanceFen(workspaceId) / 100).toFixed(2), transactions: walletTransactions.filter(item => item.workspaceId === workspaceId).slice(-limit).reverse().map(publicMoneyRecord) })
    }
    case 'billing.refund': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'finance'])
      const orderId = required(params, 'order_id')
      await persistenceReady
      const order = persistence.billing ? await persistence.billing.getOrder(workspaceId, orderId) : rechargeOrders.get(orderId)
      if (!order || order.workspaceId !== workspaceId) throw new DomainError('BILLING_ORDER_NOT_FOUND', '充值订单不存在', 404)
      const transactions = persistence.billing ? await persistence.billing.listTransactions(workspaceId, 5000) : walletTransactions.filter(item => item.workspaceId === workspaceId)
      const existingRefund = transactions.find(item => item.orderId === orderId && item.type === 'refund')
      if (existingRefund) return result(publicMoneyRecord(existingRefund))
      let providerRefundId: string | undefined
      if (order.paymentMode === 'provider') {
        requireProviderPaymentConfigured()
        if (order.state !== 'paid') throw new DomainError('BILLING_ORDER_NOT_REFUNDABLE', '支付服务商订单尚未到账，不能退款', 409)
        if (!order.providerTradeId) throw new DomainError('PAYMENT_REFUND_PROVIDER_TRADE_MISSING', '订单缺少支付服务商交易号，不能退款', 409)
        if (!paymentProvider) throw new DomainError('PAYMENT_NOT_CONFIGURED', '支付 provider adapter 未装配', 503)
        try {
          const providerRefund = await paymentProvider.refund({ channel: order.channel, orderId: order.id, providerTradeId: order.providerTradeId, workspaceId, amountFen: order.amountFen, reason: required(params, 'reason') })
          const state = providerRefund.state?.trim().toLowerCase()
          if (state && !['accepted', 'success', 'succeeded', 'completed'].includes(state)) throw new Error(`payment provider refund was not accepted: ${providerRefund.state}`)
          providerRefundId = providerRefund.providerRefundId
        } catch (error) { throw new DomainError('PAYMENT_PROVIDER_REFUND_FAILED', error instanceof Error ? error.message : '支付服务商退款失败', 503) }
      }
      const refund = await refundRecharge({ workspaceId, orderId, actorId, reason: required(params, 'reason'), ...(providerRefundId ? { providerRefundId } : {}) })
      await recordOperationAudit({ workspaceId, actorId, action: 'billing.refund', resourceType: 'billing_order', resourceId: refund.orderId ?? required(params, 'order_id'), before: {}, after: refund as unknown as Record<string, unknown>, reason: required(params, 'reason') })
      return result(publicMoneyRecord(refund))
    }
    case 'billing.reconciliation': {
      const principal = requestPrincipals.get(req)
      const canViewProviderCosts = principal?.memberRole === 'finance' || principal?.memberRole === 'platform_ops' || principal?.roles.includes('finance') || principal?.roles.includes('platform_ops')
      const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(100, Math.max(1, Number(params.limit))) : 100
      const transactions = persistence.billing ? await persistence.billing.listTransactions(workspaceId, limit) : walletTransactions.filter(item => item.workspaceId === workspaceId).slice(-limit).reverse()
      const modelUsage = persistence.modelUsage ? await persistence.modelUsage.list(workspaceId, limit) : []
      const actionLedger = persistence.actionLedger ? await persistence.actionLedger.list(workspaceId, limit) : []
      const actionSummary = actionLedger.reduce((acc, item) => { const key = `${item.actionKind}:${item.settlement}:${item.settlementStatus ?? item.state}`; acc[key] = (acc[key] ?? 0) + 1; return acc }, {} as Record<string, number>)
      const modelUsageTotals = modelUsage.reduce((acc, item) => {
        acc.totalTokens += item.totalTokens ?? 0
        acc.costCny += item.costCny ?? 0
        acc.customerChargeCny += item.customerChargeCny ?? 0
        acc.byModality[item.modality] = (acc.byModality[item.modality] ?? 0) + 1
        return acc
      }, { totalTokens: 0, costCny: 0, customerChargeCny: 0, byModality: {} as Record<string, number> })
      const totals = transactions.reduce((acc, item) => { acc[item.type] = (acc[item.type] ?? 0) + item.amountFen; return acc }, {} as Record<string, number>)
      const balanceFen = persistence.billing ? await persistence.billing.balanceFen(workspaceId) : walletBalanceFen(workspaceId)
      const provider = paymentProviderReadiness()
      const unsettledModelUsage = modelUsage.filter(item => !['settled', 'waived'].includes(item.settlementStatus))
      return result({ currency: 'CNY', balance_cny: (balanceFen / 100).toFixed(2), recharge_cny: ((totals.recharge ?? 0) / 100).toFixed(2), debit_cny: ((totals.debit ?? 0) / 100).toFixed(2), refund_cny: ((totals.refund ?? 0) / 100).toFixed(2), transaction_count: transactions.length, transactions: transactions.map(publicMoneyRecord), model_usage: { record_count: modelUsage.length, total_tokens: modelUsageTotals.totalTokens, provider_cost_cny: canViewProviderCosts ? modelUsageTotals.costCny.toFixed(6) : null, customer_charge_cny: modelUsageTotals.customerChargeCny.toFixed(6), unsettled_records: unsettledModelUsage.length, unsettled: unsettledModelUsage.slice(0, 100).map(item => ({ id: item.id, revision: item.revision, action_id: item.actionId ?? null, modality: item.modality, model: item.model, settlement_status: item.settlementStatus, allowed_decisions: allowedModelUsageSettlementDecisions(item), attempt_count: item.attemptCount, provider_request_id: canViewProviderCosts ? item.providerRequestId ?? null : null, observed_at: item.observedAt, next_attempt_at: item.nextAttemptAt ?? null, last_error: item.lastError ?? null, settlement_reason: typeof item.metadata?.settlement_reason === 'string' ? item.metadata.settlement_reason : item.settlementStatus })), by_modality: modelUsageTotals.byModality }, action_ledger: { record_count: actionLedger.length, by_kind_settlement_state: actionSummary }, provider: { mode: process.env.PAYMENT_MODE === 'provider' ? 'provider' : 'fixture', ready: process.env.PAYMENT_MODE === 'provider' && provider.ready, reasons: provider.reasons } })
    }
    case 'billing.reconciliation.run': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'finance', 'platform_ops'])
      const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(100, Math.max(1, Number(params.limit))) : 50
      await persistenceReady
      if (!paymentProvider?.queryStatus) {
        if (isProduction()) throw new DomainError('PAYMENT_RECONCILIATION_UNAVAILABLE', '生产支付 provider 未配置查单能力', 503)
        return result({ state: 'not_configured', checked: 0, settled: [], pending: [], failed: [], next_action: '配置支付 provider query endpoint 后再运行对账' })
      }
      const orders = persistence.billing
        ? await persistence.billing.listOrders(workspaceId, ['pending'], limit)
        : [...rechargeOrders.values()].filter(order => order.workspaceId === workspaceId && order.state === 'pending').slice(0, limit)
      const settled: Array<{ order_id: string; provider_trade_id: string }> = []
      const pending: Array<{ order_id: string; state: string }> = []
      const failed: Array<{ order_id: string; code: string; message: string }> = []
      for (const order of orders.filter(item => item.paymentMode === 'provider')) {
        try {
          const providerStatus = await paymentProvider.queryStatus({ channel: order.channel, orderId: order.id, workspaceId })
          if (providerStatus.state !== 'paid') {
            if (providerStatus.state === 'closed' || providerStatus.state === 'failed') {
              const terminal = await markRechargeProviderState({ workspaceId, orderId: order.id, state: providerStatus.state })
              if (!terminal) {
                failed.push({ order_id: order.id, code: 'BILLING_ORDER_NOT_FOUND', message: '充值订单在对账期间不可见' })
                continue
              }
              const code = providerStatus.state === 'closed' ? 'PAYMENT_PROVIDER_ORDER_CLOSED' : 'PAYMENT_PROVIDER_ORDER_FAILED'
              await persistEvent(workspaceId, order.id, 'billing.recharge.reconciled', 1, { order_id: order.id, state: providerStatus.state, source: 'provider_reconciliation' })
              await recordOperationAudit({ workspaceId, actorId, action: 'billing.reconciliation.run', resourceType: 'billing_order', resourceId: order.id, before: order as unknown as Record<string, unknown>, after: terminal as unknown as Record<string, unknown>, reason: '支付服务商查单确认订单终态' })
              failed.push({ order_id: order.id, code, message: providerStatus.state === 'closed' ? '支付服务商已关闭该充值订单' : '支付服务商报告该充值订单失败' })
            } else {
              pending.push({ order_id: order.id, state: providerStatus.state })
            }
            continue
          }
          if (providerStatus.amountFen !== order.amountFen) {
            failed.push({ order_id: order.id, code: 'PAYMENT_QUERY_AMOUNT_MISMATCH', message: '支付服务商查单金额缺失或与充值订单不一致' })
            continue
          }
          if (!providerStatus.providerTradeId) {
            failed.push({ order_id: order.id, code: 'PAYMENT_QUERY_TRADE_ID_MISSING', message: '支付服务商已支付但未返回交易号' })
            continue
          }
          const paid = await markRechargePaid({ workspaceId, orderId: order.id, providerTradeId: providerStatus.providerTradeId, amountFen: order.amountFen })
          if (!paid) {
            failed.push({ order_id: order.id, code: 'BILLING_ORDER_NOT_FOUND', message: '充值订单在对账期间不可见' })
            continue
          }
          await persistEvent(workspaceId, order.id, 'billing.recharge.paid', 1, { order_id: order.id, provider_trade_id: providerStatus.providerTradeId, amount_fen: order.amountFen, channel: order.channel, source: 'provider_reconciliation' })
          await recordOperationAudit({ workspaceId, actorId, action: 'billing.reconciliation.run', resourceType: 'billing_order', resourceId: order.id, before: order as unknown as Record<string, unknown>, after: paid as unknown as Record<string, unknown>, reason: '运营人员执行支付服务商查单对账' })
          settled.push({ order_id: order.id, provider_trade_id: providerStatus.providerTradeId })
        } catch (error) {
          failed.push({ order_id: order.id, code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'PAYMENT_RECONCILIATION_FAILED', message: error instanceof Error ? error.message : '支付服务商查单失败' })
        }
      }
      return result({ state: failed.length ? 'attention_required' : 'completed', checked: orders.length, provider_orders: orders.filter(item => item.paymentMode === 'provider').length, settled, pending, failed, actor_id: actorId, idempotent_settlement: true })
    }
    case 'billing.model-usage.reconciliation.run': {
      const actorId = requireOperationsRole(req, ['finance', 'platform_ops'])
      if (!persistence.modelUsage) throw new DomainError('MODEL_USAGE_LEDGER_NOT_CONFIGURED', '模型用量结算台账未配置', 503)
      const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(100, Math.max(1, Number(params.limit))) : 50
      const owner = `ops-model-reconciliation:${actorId}:${randomUUID()}`
      const claimed = await persistence.modelUsage.claimPending({ workspaceId, owner, limit, leaseSeconds: 120, now: new Date().toISOString() })
      const settled: string[] = []
      const pending: Array<{ usage_id: string; status: string; code: string }> = []
      for (const usage of claimed) {
        try {
          const completed = await settlePendingModelUsage({ workspaceId, usageId: usage.id, actorId, expectedRevision: usage.revision })
          settled.push(completed.id)
        } catch (error) {
          const code = (error as { code?: string })?.code ?? (error instanceof Error ? error.message : 'MODEL_USAGE_RECONCILIATION_FAILED')
          const terminal = usage.attemptCount >= 5
          const status = terminal ? 'manual_attention' as const : usage.costCny === undefined ? 'pending_cost' as const : 'pending_wallet' as const
          try {
            if (usage.actionId) await persistence.actionLedger?.transitionSettlementStatus({ workspaceId, actionKey: usage.actionId, from: ['authorized', 'pending_receipt'], to: terminal ? 'manual_attention' : 'pending_receipt' })
            await persistence.modelUsage.resolve({ workspaceId, id: usage.id, expectedRevision: usage.revision, status, actorId, reason: terminal ? '自动重试达到上限，转人工核对' : '自动对账尚未完成', lastError: { code, message: error instanceof Error ? error.message : String(error) }, ...(terminal ? {} : { nextAttemptAt: new Date(Date.now() + Math.min(3600, 60 * 2 ** Math.min(usage.attemptCount, 5)) * 1000).toISOString() }) })
          } catch { /* another reconciler won the optimistic lock */ }
          pending.push({ usage_id: usage.id, status, code })
        }
      }
      await recordOperationAudit({ workspaceId, actorId, action: 'billing.model-usage.reconciliation.run', resourceType: 'model_usage', resourceId: workspaceId, before: {}, after: { checked: claimed.length, settled, pending }, reason: '运营人员执行模型用量结算重试' })
      return result({ state: pending.length ? 'attention_required' : 'completed', checked: claimed.length, settled, pending, actor_id: actorId })
    }
    case 'billing.model-usage.resolve': {
      const actorId = requireOperationsRole(req, ['finance', 'platform_ops'])
      if (!persistence.modelUsage) throw new DomainError('MODEL_USAGE_LEDGER_NOT_CONFIGURED', '模型用量结算台账未配置', 503)
      const usageId = required(params, 'usage_id')
      const revisionText = required(params, 'revision')
      if (!/^\d+$/u.test(revisionText)) throw new DomainError('MODEL_USAGE_REVISION_INVALID', 'revision 必须是正整数', 400)
      const revision = Number(revisionText)
      const decision = required(params, 'decision') as ModelUsageSettlementDecision
      if (!['retry', 'waive', 'manual_attention'].includes(decision)) throw new DomainError('MODEL_USAGE_DECISION_INVALID', 'decision 必须是 retry、waive 或 manual_attention', 400)
      const reason = required(params, 'reason').trim()
      const evidenceRef = required(params, 'evidence_ref').trim()
      const before = (await persistence.modelUsage.list(workspaceId, 1000)).find(item => item.id === usageId)
      if (!before) throw new DomainError('MODEL_USAGE_NOT_FOUND', '模型用量记录不存在', 404)
      const allowedDecisions = allowedModelUsageSettlementDecisions(before)
      if (!allowedDecisions.includes(decision)) throw new DomainError('MODEL_USAGE_DECISION_NOT_ALLOWED', '当前结算状态不允许该人工处理动作', 409, { settlement_status: before.settlementStatus, allowed_decisions: allowedDecisions })
      let after
      if (decision === 'retry') after = await settlePendingModelUsage({ workspaceId, usageId, actorId, expectedRevision: revision, reason, evidenceRef })
      else if (decision === 'waive') {
        if (before.actionId) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: before.actionId, actorId, reason: `模型成本缺失豁免：${reason}` })
        after = await persistence.modelUsage.resolve({ workspaceId, id: usageId, expectedRevision: revision, status: 'waived', actorId, reason, evidenceRef })
      } else if (decision === 'manual_attention') {
        if (before.actionId) await persistence.actionLedger?.transitionSettlementStatus({ workspaceId, actionKey: before.actionId, from: ['authorized', 'pending_receipt', 'manual_attention'], to: 'manual_attention' })
        after = await persistence.modelUsage.resolve({ workspaceId, id: usageId, expectedRevision: revision, status: 'manual_attention', actorId, reason, evidenceRef })
      }
      else throw new DomainError('MODEL_USAGE_DECISION_INVALID', 'decision 必须是 retry、waive 或 manual_attention', 400)
      await recordOperationAudit({ workspaceId, actorId, action: 'billing.model-usage.resolve', resourceType: 'model_usage', resourceId: usageId, before: before as unknown as Record<string, unknown>, after: after as unknown as Record<string, unknown>, reason })
      return result({ id: after.id, settlement_status: after.settlementStatus, allowed_decisions: allowedModelUsageSettlementDecisions(after), revision: after.revision, resolved_by: after.resolvedBy ?? null, resolution_reason: after.resolutionReason ?? null, resolution_evidence_ref: after.resolutionEvidenceRef ?? null, resolved_at: after.resolvedAt ?? null })
    }
    case 'billing.export': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'finance', 'platform_ops'])
      const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(1000, Math.max(1, Number(params.limit))) : 1000
      const format = params.format === 'json' ? 'json' : 'csv'
      const transactions = persistence.billing ? await persistence.billing.listTransactions(workspaceId, limit) : walletTransactions.filter(item => item.workspaceId === workspaceId).slice(-limit).reverse()
      const rows = transactions.map(item => ({ id: item.id, type: item.type, amount_cny: (item.amountFen / 100).toFixed(2), order_id: item.orderId ?? '', description: item.description, created_at: item.createdAt }))
      if (format === 'json') return result({ filename: `billing-${workspaceId}.json`, contentType: 'application/json', content: JSON.stringify(rows) })
      const content = ['id,type,amount_cny,order_id,description,created_at', ...rows.map(row => [row.id, row.type, row.amount_cny, row.order_id, row.description, row.created_at].map(csvCell).join(','))].join('\n')
      return result({ filename: `billing-${workspaceId}.csv`, contentType: 'text/csv; charset=utf-8', content })
    }
    case 'workspace.deactivate': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const reason = required(params, 'reason')
      const before = await getWorkspaceStatus(workspaceId)
      if (before !== 'disabled') {
        await setWorkspaceStatus(workspaceId, 'disabled')
        await persistEvent(workspaceId, `workspace:${workspaceId}`, 'workspace.deactivated', nextWorkspaceEventSequence(workspaceId), { workspace_id: workspaceId, reason })
      }
      await recordOperationAudit({ workspaceId, actorId, action: 'workspace.deactivate', resourceType: 'workspace', resourceId: workspaceId, before: { status: before }, after: { status: 'disabled', dataRetained: true }, reason })
      return result({ workspaceId, status: 'disabled', dataRetained: true, reason })
    }
    case 'workspace.activate': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const before = await getWorkspaceStatus(workspaceId)
      if (before !== 'active') {
        await setWorkspaceStatus(workspaceId, 'active')
        await persistEvent(workspaceId, `workspace:${workspaceId}`, 'workspace.activated', nextWorkspaceEventSequence(workspaceId), { workspace_id: workspaceId, dataRetained: true })
      }
      await recordOperationAudit({ workspaceId, actorId, action: 'workspace.activate', resourceType: 'workspace', resourceId: workspaceId, before: { status: before }, after: { status: 'active', dataRetained: true }, reason: '恢复工作区' })
      return result({ workspaceId, status: 'active', dataRetained: true })
    }
    case 'workspace.data.delete.request': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin'])
      const scope = required(params, 'scope') as DataDeletionScope
      if (!['workspace', 'assets', 'business'].includes(scope)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '删除范围无效', 400)
      const reason = requiredOperationalReason(params)
      const gracePeriodDays = Number(process.env.DELETION_REQUEST_GRACE_DAYS ?? 7)
      if (!Number.isInteger(gracePeriodDays) || gracePeriodDays < 7 || gracePeriodDays > 30) throw new DomainError('DATA_LIFECYCLE_NOT_CONFIGURED', '生产删除宽限期未配置为 7 到 30 天', 503)
      let request
      try {
        request = await (persistence.dataLifecycle ?? memoryDataLifecycle).request({ workspaceId, scope, reason, requestedBy: actorId, gracePeriodDays, idempotencyKey: required(params, 'idempotency_key') })
      } catch (error) {
        if ((error as { code?: string })?.code === 'DATA_DELETION_IDEMPOTENCY_CONFLICT' || String(error).includes('DATA_DELETION_IDEMPOTENCY_CONFLICT')) throw new DomainError('DATA_DELETION_IDEMPOTENCY_CONFLICT', '删除幂等键已绑定到另一份申请，请换用新的幂等键', 409, { idempotency_key: required(params, 'idempotency_key') })
        throw error
      }
      await recordOperationAudit({ workspaceId, actorId, action: 'data.delete.request', resourceType: 'data_deletion_request', resourceId: request.id, before: {}, after: request as unknown as Record<string, unknown>, reason: request.reason })
      return result({ ...request, execution: 'pending_external_approval', message: '删除申请已登记；宽限期和双人审批完成前不会删除数据。' })
    }
    case 'platform.connect': {
      const platform = required(params, 'platform') as Platform
      await requireStoreCapacity(workspaceId)
      const platformEntitlementKey = `platform-connect:${workspaceId}:${platform}:${typeof params.store_key === 'string' ? params.store_key.trim() : 'default'}`
      // Authorization is the activation/readiness step. It remains available
      // before wallet recharge; an optional platform add-on can still settle
      // the action when present, but it must not gate first-run onboarding.
      const platformEntitlement = await consumeEntitlement({ workspaceId, kind: 'platform', actionKey: platformEntitlementKey, actionKind: 'platform_connect', actorId: requestActor(req), description: '平台连接权益（可选加购）' })
      let authorization: Awaited<ReturnType<typeof beginPlatformAuthorization>>
      try {
        authorization = await beginPlatformAuthorization(req, platform, params, workspaceId)
      } catch (error) {
        if (platformEntitlement) await refundEntitlement({ workspaceId, actionKey: platformEntitlementKey, reason: '平台授权入口创建失败' })
        throw error
      }
      if (!fixtureMode || authorization.ok !== true) return result(authorization)
      // Explicit local演练 shortcut: production still requires the official OAuth
      // callback and never creates an account from an authorization URL alone.
      // Exchange a disposable fixture code as well as updating the account
      // snapshot. This resets a previously revoked fake credential, matching a
      // real reauthorization instead of merely changing local account state.
      const fixtureCredential = await connectorRuntime.connector(platform).exchangeCode({ code: `fixture-code-${platform}`, state: `fixture-state-${workspaceId}-${platform}`, workspaceId })
      const storeKey = typeof params.store_key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(params.store_key.trim()) ? params.store_key.trim() : undefined
      const account = service.registerPlatformAccount({
        workspaceId,
        platform,
        remoteAccountId: `fixture-store-${workspaceId}-${platform}${storeKey ? `-${storeKey}` : ''}`,
        credentialRef: fixtureCredential.credentialRef,
        grantedScopes: grantedScopes(fixtureCredential.scope),
        accessTokenExpiresAt: fixtureCredential.expiresAt,
        credentialRefreshable: fixtureCredential.refreshable,
      })
      await persistSnapshot(workspaceId, 'platform_account', account, account as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, account.id, 'platform.connected', account.revision, { platform, account_id: account.id, simulated: true })
      const store = workspaceStoreDirectory(workspaceId, platform).find(item => item.accountId === account.id)
      return result({
        ...authorization,
        simulated: true,
        account: {
          id: account.id,
          workspaceId: account.workspaceId,
          platform: account.platform,
          tokenState: account.tokenState,
          authRevision: account.authRevision,
          createdAt: account.createdAt,
          revision: account.revision,
        },
        store,
      })
    }
    case 'platform.store.alias.set': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const platform = required(params, 'platform') as Platform
      const accountId = required(params, 'account_id')
      const expectedRevision = Number(required(params, 'expected_revision'))
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new DomainError('STORE_ALIAS_VERSION_INVALID', 'expected_revision 必须是正整数', 400)
      const account = service.setPlatformAccountAlias({ workspaceId, platform, accountId, alias: required(params, 'alias'), expectedRevision })
      await persistSnapshot(workspaceId, 'platform_account', account, account as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, account.id, 'platform_account.alias_changed', account.revision, { platform, account_id: account.id, alias: account.storeAlias })
      const store = workspaceStoreDirectory(workspaceId, platform).find(item => item.accountId === account.id)
      return result({ store, selectionKey: { platform, accountId: account.id } })
    }
    case 'catalog.search': {
      const scope = params.scope === 'workspace' ? 'workspace' : params.scope === 'store' ? 'store' : undefined
      const platform = typeof params.platform === 'string' ? params.platform as Platform : undefined
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      if (scope === 'store' && (!platform || !accountId)) throw new DomainError('STORE_SELECTION_REQUIRED', '查看指定店铺商品时，请同时选择平台和店铺', 409, { next_actions: ['选择一个平台店铺', '或明确使用全部店铺只读汇总'] })
      if (accountId && !platform) throw new DomainError('STORE_PLATFORM_REQUIRED', '使用 account_id 查询商品时必须同时指定 platform', 400)
      if (scope !== 'workspace' && (!platform || !accountId)) throw new DomainError('STORE_SELECTION_REQUIRED', '请先选择要查看的具体平台店铺；如需汇总全部店铺，请明确传入 scope=workspace', 409, { next_actions: ['调用 workspace.health 查看店铺列表', '选择 platform + account_id', '或明确使用 scope=workspace 查看全部店铺'] })
      if (scope === 'workspace' && accountId) throw new DomainError('CATALOG_SCOPE_CONFLICT', '全部店铺汇总不能同时指定 account_id，请改用 scope=store', 400)
      if (accountId) service.getPlatformAccount(workspaceId, accountId, platform)
      const directory = new Map(workspaceStoreDirectory(workspaceId).map(store => [`${store.platform}:${store.accountId}`, store]))
      const products = service.listProducts(workspaceId, {
        ...(typeof params.query === 'string' ? { query: params.query } : {}),
        ...(platform ? { platform } : {}),
        ...(accountId ? { accountId } : {}),
        ...(typeof params.store_name === 'string' ? { storeName: params.store_name } : {}),
        ...(typeof params.brand_name === 'string' ? { brandName: params.brand_name } : {}),
        ...(typeof params.sku_id === 'string' ? { skuId: params.sku_id } : {}),
        ...(typeof params.remote_product_id === 'string' ? { remoteProductId: params.remote_product_id } : {}),
        ...(typeof params.listing_status === 'string' ? { listingStatus: params.listing_status as import('../../../packages/application/src/service.js').Product['listingStatus'] } : {}),
        ...(typeof params.product_state === 'string' ? { productState: params.product_state as 'active' | 'disabled' } : {}),
        ...(typeof params.sync_status === 'string' ? { syncStatus: params.sync_status as import('../../../packages/application/src/service.js').SyncJobState } : {}),
        ...(typeof params.date_from === 'string' ? { dateFrom: params.date_from } : {}),
        ...(typeof params.date_to === 'string' ? { dateTo: params.date_to } : {}),
      }).map(product => ({ ...product, product_id: product.id, storeContext: product.accountId ? directory.get(`${product.platform}:${product.accountId}`) ?? { platform: product.platform, accountId: product.accountId } : null }))
      const product_actions = products.map(product => {
        const base = { product_id: product.id, title: product.title, platform: product.platform, account_id: product.accountId ?? null, facts_confirmed: product.factsConfirmed }
        if (!product.accountId) return { ...base, action: { method: 'platform.connect', label: '绑定商品所属店铺', required_inputs: ['platform'], confirmation: 'interactive_confirmation' } }
        if (!product.factsConfirmed) return { ...base, action: { method: 'catalog.facts.confirm', label: '确认商品、SKU、价格和图片事实', required_inputs: ['product_id'], confirmation: 'interactive_confirmation' } }
        return { ...base, action: null, next_step: '商品事实已确认，可创建内容任务' }
      })
      return result({
        scope: scope === 'workspace' ? 'workspace' : 'store',
        selection: accountId && platform ? { platform, accountId } : null,
        products,
        product_actions,
        emptyState: products.length ? null : {
          title: '暂时没有找到商品',
          reason: scope === 'workspace' ? '当前工作区还没有可见商品，或筛选条件没有匹配结果' : '该店铺还没有同步或导入商品，或筛选条件没有匹配结果',
          nextActions: scope === 'workspace' ? ['选择具体店铺后重新查询', '同步或导入商品'] : ['同步当前店铺商品', '导入商品资料', '更换筛选条件'],
        },
      })
    }
    case 'catalog.categories': {
      const query = typeof params.query === 'string' ? params.query.trim().toLocaleLowerCase() : ''
      return result((query ? catalogCategories.filter(item => `${item.code}${item.name}${item.fields.join('')}`.toLocaleLowerCase().includes(query)) : catalogCategories).map(item => ({ ...item, category_code: item.code, required_fields: item.fields })))
    }
    case 'catalog.title.optimize': {
      await requirePluginWalletAccess(workspaceId)
      const productId = required(params, 'product_id')
      const product = service.products.get(productId)
      if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
      const requestedPlatform = typeof params.platform === 'string' ? params.platform as Platform : product.platform
      if (!SUPPORTED_PLATFORMS.includes(requestedPlatform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
      if (requestedPlatform !== product.platform) throw new DomainError('TITLE_PLATFORM_SCOPE_MISMATCH', '标题优化的平台必须与当前商品平台一致', 409, { product_platform: product.platform, requested_platform: requestedPlatform })
      const rulePreflight = await requireGenerationRulePreflight(workspaceId, product.id, '标题优化前平台规则校验未通过')
      requireRuleSafeGenerationText(rulePreflight, [product.title, params.keyword, params.objective])
      const suggestions = generateSeoGeoSuggestions({ platform: requestedPlatform, productId: product.id, title: product.title, ...(product.category ? { category: product.category } : {}), ...(product.attributes ? { attributes: product.attributes } : {}), ...(product.sellingPoints ? { sellingPoints: product.sellingPoints.filter(item => item.proofStatus === 'confirmed').map(item => item.text) } : {}), ...(typeof params.keyword === 'string' ? { keyword: params.keyword } : {}), ...(typeof params.objective === 'string' ? { objective: params.objective } : {}) })
      requireRuleSafeGenerationText(rulePreflight, [suggestions], '标题优化结果命中当前平台规则禁用表达')
      const seoKey = createHash('sha256').update(JSON.stringify({ productId: product.id, requestedPlatform, keyword: params.keyword ?? '', objective: params.objective ?? '' })).digest('hex')
      const seoDebitKey = `seo-geo:${seoKey}`
      const seoActor = requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant'
      await debitPluginWallet({ workspaceId, idempotencyKey: seoDebitKey, actorId: seoActor, description: 'SEO/GEO 标题建议调用' })
      try {
        await persistEvent(workspaceId, product.id, 'catalog.title.optimized', product.version ?? 1, { product_id: product.id, platform: requestedPlatform, suggestion_id: suggestions[0]?.id ?? null, ranking_guarantee: false })
      } catch (error) {
        await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: seoDebitKey, actorId: seoActor, reason: 'SEO/GEO 结果记录失败' })
        throw error
      }
      return result({ product_id: product.id, platform: requestedPlatform, suggestions, rule_preflight: rulePreflight, humanConfirmationRequired: true, rankingGuarantee: false })
    }
    case 'catalog.title.accept': {
      const productId = required(params, 'product_id')
      const platform = required(params, 'platform') as Platform
      const suggestionId = required(params, 'suggestion_id')
      const title = required(params, 'title')
      const expectedVersion = typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined
      if (params.expected_version !== undefined && expectedVersion === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_version 必须是非负整数', 400)
      const product = service.acceptSeoGeoTitle({ workspaceId, productId, platform, suggestionId, title, actorId: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant', ...(expectedVersion !== undefined ? { expectedVersion } : {}) })
      await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, product.id, 'catalog.title.accepted', product.version ?? 1, { product_id: product.id, platform, suggestion_id: suggestionId, facts_confirmed: false })
      return result({ ...product, product_id: product.id, factsConfirmationRequired: true, humanConfirmed: true })
    }
    case 'catalog.import': {
      const platform = required(params, 'platform') as Platform
      const numeric = (key: string) => typeof params[key] === 'string' && params[key]!.trim() ? Number(params[key]) : undefined
      const images = typeof params.images === 'string' && params.images.trim() ? params.images.split(',').map(item => item.trim()).filter(Boolean) : undefined
      let sourceAssetIds: string[] | undefined
      if (typeof params.asset_ids_json === 'string' && params.asset_ids_json.trim()) {
        try {
          const parsed = JSON.parse(params.asset_ids_json)
          if (!Array.isArray(parsed) || parsed.length > 50 || parsed.some(value => typeof value !== 'string' || !value.trim())) throw new Error('asset_ids_json')
          sourceAssetIds = [...new Set(parsed.map(value => value.trim()))]
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'asset_ids_json 必须是最多 50 个素材 ID 的字符串数组 JSON', 400) }
      }
      let skus: import('../../../packages/application/src/service.js').ProductSku[] | undefined
      if (typeof params.skus_json === 'string' && params.skus_json.trim()) {
        try {
          const parsed = JSON.parse(params.skus_json)
          if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.price !== 'number' || typeof item.stock !== 'number')) throw new Error('skus_json')
          skus = parsed.map((item: Record<string, any>) => ({ id: item.id.trim(), name: item.name.trim(), price: item.price, stock: item.stock, ...(Array.isArray(item.images) ? { images: item.images.filter((value: unknown): value is string => typeof value === 'string') } : {}), ...(item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes) ? { attributes: Object.fromEntries(Object.entries(item.attributes).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value as string])) } : {}) }))
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'skus_json 必须是包含 id、name、price、stock 的 SKU 数组', 400) }
      }
      let attributes: Record<string, string> | undefined
      if (typeof params.attributes_json === 'string' && params.attributes_json.trim()) {
        try {
          const parsed = JSON.parse(params.attributes_json)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('attributes_json must be an object')
          attributes = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value as string]))
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'attributes_json 必须是 JSON 对象', 400) }
      }
      let sellingPoints: import('../../../packages/application/src/service.js').ProductSellingPoint[] | undefined
      if (typeof params.selling_points_json === 'string' && params.selling_points_json.trim()) {
        try {
          const parsed = JSON.parse(params.selling_points_json)
          if (!Array.isArray(parsed)) throw new Error('selling_points_json')
          sellingPoints = parsed.map((item: any, index: number) => ({ id: typeof item.id === 'string' ? item.id : `sp_${index + 1}`, text: typeof item.text === 'string' ? item.text : '', proofStatus: item.proof_status === 'confirmed' || item.proof_status === 'rejected' ? item.proof_status : 'pending', sourceIds: Array.isArray(item.source_ids) ? item.source_ids.filter((value: unknown): value is string => typeof value === 'string') : [] }))
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'selling_points_json 必须是卖点对象数组', 400) }
      }
      const price = numeric('price'); const skuCount = numeric('sku_count'); const stock = numeric('stock')
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      if (!SUPPORTED_PLATFORMS.includes(platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
      if (isProduction() && !accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产商品导入必须绑定已授权平台账号', 400)
      if (accountId) service.getActivePlatformAccount(workspaceId, accountId, platform)
      const product = service.importProduct({
        workspaceId, platform, ...(accountId ? { accountId } : {}),
        ...(typeof params.remote_id === 'string' && params.remote_id.trim() ? { remoteId: params.remote_id } : {}),
        ...(typeof params.local_product_key === 'string' ? { localProductKey: params.local_product_key } : {}),
        title: required(params, 'title'),
        ...(skus ? { skus } : {}),
        ...(typeof price === 'number' && Number.isFinite(price) ? { price } : {}),
        ...(typeof skuCount === 'number' && Number.isFinite(skuCount) ? { skuCount } : {}),
        ...(typeof stock === 'number' && Number.isFinite(stock) ? { stock } : {}),
        ...(typeof params.category === 'string' && params.category.trim() ? { category: params.category } : {}),
        ...(images ? { images } : {}), ...(sourceAssetIds ? { sourceAssetIds } : {}), ...(attributes ? { attributes } : {}), ...(sellingPoints ? { sellingPoints } : {}),
        ...(typeof params.store_name === 'string' ? { storeName: params.store_name } : {}),
        ...(typeof params.store_differentiation === 'string' ? { storeDifferentiation: params.store_differentiation } : {}),
      })
      await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
      return result({ ...product, product_id: product.id })
    }
    case 'catalog.import.batch': {
      let rawItems: unknown
      try {
        rawItems = JSON.parse(required(params, 'products_json'))
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'products_json 必须是商品对象数组 JSON', 400) }
      if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 50 || rawItems.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
        throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'products_json 必须是 1 至 50 个商品对象的 JSON 数组', 400)
      }
      type BatchImportItem = { platform: Platform; accountId?: string; remoteId?: string; localProductKey?: string; title: string; skuCount?: number; skus?: import('../../../packages/application/src/service.js').ProductSku[]; stock?: number; price?: number; category?: string; images?: string[]; sourceAssetIds?: string[]; attributes?: Record<string, string>; sellingPoints?: import('../../../packages/application/src/service.js').ProductSellingPoint[]; storeName?: string; storeDifferentiation?: string }
      const numeric = (value: unknown, field: string, index: number) => {
        if (value === undefined || value === null || value === '') return undefined
        const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
        if (!Number.isFinite(parsed) || parsed < 0) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 ${field} 必须是非负数字`, 400)
        return parsed
      }
      const items: BatchImportItem[] = rawItems.map((raw, index) => {
        const item = raw as Record<string, unknown>
        const platform = typeof item.platform === 'string' ? item.platform as Platform : '' as Platform
        if (!SUPPORTED_PLATFORMS.includes(platform)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 platform 无效`, 400)
        const accountId = typeof item.account_id === 'string' && item.account_id.trim() ? item.account_id.trim() : undefined
        if (isProduction() && !accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', `第 ${index + 1} 项生产导入必须绑定已授权平台账号`, 400)
        if (accountId) service.getActivePlatformAccount(workspaceId, accountId, platform)
        const title = typeof item.title === 'string' ? item.title.trim() : ''
        if (!title) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 title 不能为空`, 400)
        const images = Array.isArray(item.images) ? item.images.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(value => value.trim()) : typeof item.images === 'string' ? item.images.split(',').map(value => value.trim()).filter(Boolean) : undefined
        const sourceAssetIds = Array.isArray(item.asset_ids) ? item.asset_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(value => value.trim()) : undefined
        if (sourceAssetIds && (sourceAssetIds.length > 50 || new Set(sourceAssetIds).size !== sourceAssetIds.length)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 asset_ids 必须是最多 50 个不重复素材 ID`, 400)
        let skus: import('../../../packages/application/src/service.js').ProductSku[] | undefined
        if (item.skus !== undefined) {
          if (!Array.isArray(item.skus)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 skus 必须是数组`, 400)
          skus = item.skus.map((value, skuIndex) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 SKU ${skuIndex + 1} 格式无效`, 400)
            const sku = value as Record<string, unknown>
            if (typeof sku.id !== 'string' || typeof sku.name !== 'string') throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 SKU ${skuIndex + 1} 缺少 id/name`, 400)
            const price = numeric(sku.price, 'SKU price', index); const stock = numeric(sku.stock, 'SKU stock', index)
            if (price === undefined || stock === undefined || !Number.isInteger(stock)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 SKU ${skuIndex + 1} 的 price/stock 无效`, 400)
            const attributes = sku.attributes && typeof sku.attributes === 'object' && !Array.isArray(sku.attributes) ? Object.fromEntries(Object.entries(sku.attributes).filter(([, candidate]) => typeof candidate === 'string').map(([key, candidate]) => [key, candidate as string])) : undefined
            return { id: sku.id.trim(), name: sku.name.trim(), price, stock, ...(Array.isArray(sku.images) ? { images: sku.images.filter((value): value is string => typeof value === 'string') } : {}), ...(attributes ? { attributes } : {}) }
          })
        }
        const attributes = item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes) ? Object.fromEntries(Object.entries(item.attributes).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value as string])) : undefined
        const sellingPoints = Array.isArray(item.selling_points) ? item.selling_points.map((value, pointIndex) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项卖点 ${pointIndex + 1} 格式无效`, 400)
          const point = value as Record<string, unknown>
          return { id: typeof point.id === 'string' ? point.id : `sp_${pointIndex + 1}`, text: typeof point.text === 'string' ? point.text : '', proofStatus: (point.proof_status === 'confirmed' || point.proof_status === 'rejected' ? point.proof_status : 'pending') as 'pending' | 'confirmed' | 'rejected', sourceIds: Array.isArray(point.source_ids) ? point.source_ids.filter((source): source is string => typeof source === 'string') : [] }
        }) : undefined
        return { platform, ...(accountId ? { accountId } : {}), ...(typeof item.remote_id === 'string' && item.remote_id.trim() ? { remoteId: item.remote_id.trim() } : {}), ...(typeof item.local_product_key === 'string' ? { localProductKey: item.local_product_key } : {}), title, ...(typeof item.category === 'string' ? { category: item.category } : {}), ...(typeof item.store_name === 'string' ? { storeName: item.store_name } : {}), ...(typeof item.store_differentiation === 'string' ? { storeDifferentiation: item.store_differentiation } : {}), ...(images ? { images } : {}), ...(sourceAssetIds ? { sourceAssetIds } : {}), ...(attributes ? { attributes } : {}), ...(sellingPoints ? { sellingPoints } : {}), ...(skus ? { skus, skuCount: skus.length } : {}), ...(numeric(item.price, 'price', index) !== undefined ? { price: numeric(item.price, 'price', index) } : {}), ...(numeric(item.stock, 'stock', index) !== undefined ? { stock: numeric(item.stock, 'stock', index) } : {}), ...(numeric(item.sku_count, 'sku_count', index) !== undefined ? { skuCount: numeric(item.sku_count, 'sku_count', index) } : {}) }
      })
      const created: ReturnType<typeof service.importProduct>[] = []
      const writes: BatchProductWrite[] = []
      const beforeProducts = new Map([...service.products.entries()]
        .filter(([, product]) => product.workspaceId === workspaceId)
        .map(([id, product]) => [id, structuredClone(product)] as const))
      try {
        for (const item of items) {
          const product = service.importProduct({ workspaceId, ...item })
          created.push(product)
          writes.push({ product, version: product.version ?? 0 })
        }
        const batchId = `catalog_import_batch_${randomUUID()}`
        await persistSnapshotsAndEvent({ workspaceId, snapshots: created.map(product => ({ entityType: 'product' as const, entityId: product.id, entityVersion: product.version ?? 1, payload: product as unknown as Record<string, unknown> })), aggregateId: batchId, eventType: 'catalog.import.batch.completed', sequence: 1, eventPayload: { batch_id: batchId, count: created.length, product_ids: created.map(product => product.id) } })
        return result({ batchId, count: created.length, products: created.map(product => ({ ...product, product_id: product.id })), atomic: true, factsConfirmationRequired: true })
      } catch (error) {
        rollbackBatchProducts(service.products, workspaceId, writes, beforeProducts)
        throw error
      }
    }
    case 'catalog.facts.confirm': {
      const productId = required(params, 'product_id')
      const product = service.confirmProductFacts(workspaceId, productId)
      const resumedTasks = service.refreshTasksAfterProductFacts(workspaceId, productId)
      await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, product.id, 'product.facts_confirmed', product.version ?? 1, { product_id: product.id, version: product.version ?? 1 })
      for (const task of resumedTasks) {
        await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, task.id, 'task.facts_unblocked', task.version, { task_id: task.id, product_id: product.id, state: task.state })
      }
      return result({ ...product, product_id: product.id, resumed_task_ids: resumedTasks.map(task => task.id) })
    }
    case 'catalog.sku.update': {
      const productId = required(params, 'product_id')
      const skuId = required(params, 'sku_id')
      const parseJsonObject = (key: string) => {
        if (typeof params[key] !== 'string') return undefined
        try { const parsed = JSON.parse(params[key] as string); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error(key); return parsed as Record<string, string> } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是字符串到字符串的 JSON 对象`, 400) }
      }
      const parseImages = () => {
        if (typeof params.images_json !== 'string') return undefined
        try { const parsed = JSON.parse(params.images_json); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error('images_json'); return parsed as string[] } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'images_json 必须是图片引用字符串数组 JSON', 400) }
      }
      const priceProvided = typeof params.price === 'string' && params.price.trim().length > 0
      const stockProvided = typeof params.stock === 'string' && params.stock.trim().length > 0
      const price = priceProvided ? Number(params.price) : undefined
      const stock = stockProvided ? Number(params.stock) : undefined
      if ((priceProvided && !Number.isFinite(price)) || (stockProvided && !Number.isFinite(stock))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'price 和 stock 必须是有效数字', 400)
      const images = parseImages()
      const attributes = parseJsonObject('attributes_json')
      if (!priceProvided && !stockProvided && typeof params.name !== 'string' && images === undefined && attributes === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '至少提供一个 SKU 修改字段', 400)
      const expectedVersion = typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined
      if (params.expected_version !== undefined && expectedVersion === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_version 必须是非负整数', 400)
      const product = service.updateProductSku({ workspaceId, productId, skuId, ...(typeof params.name === 'string' ? { name: params.name } : {}), ...(priceProvided ? { price } : {}), ...(stockProvided ? { stock } : {}), ...(images !== undefined ? { images } : {}), ...(attributes !== undefined ? { attributes } : {}), ...(expectedVersion !== undefined ? { expectedVersion } : {}) })
      await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, product.id, 'product.sku_updated', product.version ?? 1, { product_id: product.id, sku_id: skuId, version: product.version ?? 1, facts_confirmed: false })
      return result({ ...product, product_id: product.id, sku_id: skuId, factsConfirmationRequired: true })
    }
    case 'catalog.product.update': {
      const productId = required(params, 'product_id')
      const parseJsonObject = (key: string) => {
        if (typeof params[key] !== 'string') return undefined
        try { const parsed = JSON.parse(params[key] as string); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error(key); return parsed as Record<string, string> } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是字符串到字符串的 JSON 对象`, 400) }
      }
      const parseImages = () => {
        if (typeof params.images_json !== 'string') return undefined
        try { const parsed = JSON.parse(params.images_json); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error('images_json'); return parsed as string[] } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'images_json 必须是图片引用字符串数组 JSON', 400) }
      }
      const parseSellingPoints = () => {
        if (typeof params.selling_points_json !== 'string') return undefined
        try {
          const parsed = JSON.parse(params.selling_points_json)
          if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== 'object' || typeof item.text !== 'string')) throw new Error('selling_points_json')
          return parsed.map((item: Record<string, unknown>, index: number) => ({ id: typeof item.id === 'string' ? item.id : `sp_${index + 1}`, text: (item.text as string).trim(), proofStatus: (item.proof_status === 'confirmed' || item.proof_status === 'rejected' ? item.proof_status : 'pending') as import('../../../packages/application/src/service.js').SellingPointProofStatus, sourceIds: Array.isArray(item.source_ids) ? item.source_ids.filter((value): value is string => typeof value === 'string') : [] }))
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'selling_points_json 必须是卖点对象数组', 400) }
      }
      const images = parseImages(); const attributes = parseJsonObject('attributes_json'); const sellingPoints = parseSellingPoints()
      const priceProvided = typeof params.price === 'string' && params.price.trim().length > 0
      const price = priceProvided ? Number(params.price) : undefined
      if (priceProvided && (!Number.isFinite(price) || price! < 0)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'price 必须是有效的非负数字', 400)
      const expectedVersion = typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined
      if (params.expected_version !== undefined && expectedVersion === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_version 必须是非负整数', 400)
      if (typeof params.title !== 'string' && typeof params.category !== 'string' && images === undefined && attributes === undefined && sellingPoints === undefined && typeof params.store_differentiation !== 'string' && !priceProvided) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '至少提供一个商品事实修改字段', 400)
      const product = service.updateProductFacts({ workspaceId, productId, ...(typeof params.title === 'string' ? { title: params.title } : {}), ...(typeof params.category === 'string' ? { category: params.category } : {}), ...(images !== undefined ? { images } : {}), ...(attributes !== undefined ? { attributes } : {}), ...(sellingPoints !== undefined ? { sellingPoints } : {}), ...(typeof params.store_differentiation === 'string' ? { storeDifferentiation: params.store_differentiation } : {}), ...(priceProvided ? { price } : {}), ...(expectedVersion !== undefined ? { expectedVersion } : {}) })
      await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, product.id, 'product.facts_updated', product.version ?? 1, { product_id: product.id, version: product.version ?? 1, facts_confirmed: false })
      return result({ ...product, product_id: product.id, factsConfirmationRequired: true })
    }
    case 'catalog.product.disable': {
      const productId = required(params, 'product_id')
      const product = service.disableProduct({ workspaceId, productId, reason: required(params, 'reason') })
      await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, product.id, 'product.disabled', product.version ?? 1, { product_id: product.id, reason: product.disabledReason })
      return result(product)
    }
    case 'catalog.product.enable': {
      const product = service.enableProduct(workspaceId, required(params, 'product_id'))
      await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, product.id, 'product.enabled', product.version ?? 1, { product_id: product.id })
      return result(product)
    }
    case 'catalog.image.generate': {
      requirePlatformModelCostGate('image')
      const productId = required(params, 'product_id')
      const product = service.products.get(productId)
      if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
      if (!product.factsConfirmed) throw new DomainError('PRODUCT_FACTS_CONFIRMATION_REQUIRED', '请先确认商品、SKU、价格和图片事实，再生成主图', 409)
      const requestedPlatform = typeof params.platform === 'string' && params.platform.trim() ? params.platform.trim() as Platform : undefined
      const requestedAccountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      if (requestedPlatform && requestedPlatform !== product.platform) throw new DomainError('IMAGE_PLATFORM_SCOPE_MISMATCH', '图片生成的平台必须与当前商品平台一致', 409, { product_platform: product.platform, requested_platform: requestedPlatform })
      if (requestedAccountId && product.accountId && requestedAccountId !== product.accountId) throw new DomainError('IMAGE_ACCOUNT_SCOPE_MISMATCH', '图片生成的店铺必须与当前商品绑定店铺一致', 409, { product_account_id: product.accountId, requested_account_id: requestedAccountId })
      const rulePreflight = await requireGenerationRulePreflight(workspaceId, product.id, '主图生成前平台规则校验未通过')
      requireRuleSafeGenerationText(rulePreflight, [product.title, params.direction], '主图生成方向命中当前平台规则禁用表达')
      const imageTask = typeof params.task_id === 'string' && params.task_id.trim() ? service.getTask(params.task_id.trim()) : undefined
      if (imageTask && imageTask.workspaceId !== workspaceId) throw new DomainError('TENANT_SCOPE_DENIED', '图片任务不属于当前工作区', 403)
      service.assertBrandVisualGenerationReady(workspaceId, product.platform, imageTask?.region)
      let sourceAssetIds: string[] | undefined
      if (typeof params.asset_ids_json === 'string' && params.asset_ids_json.trim()) {
        try {
          const parsed = JSON.parse(params.asset_ids_json)
          if (!Array.isArray(parsed) || !parsed.length || parsed.some(value => typeof value !== 'string' || !value.trim())) throw new Error('invalid asset_ids_json')
          sourceAssetIds = [...new Set(parsed.map(value => value.trim()))]
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'asset_ids_json 必须是非空的素材 ID 字符串数组 JSON', 400) }
      }
      const imageMode = params.mode === undefined
        ? (sourceAssetIds?.length || product.sourceAssetIds?.length ? 'optimize' : 'create')
        : params.mode === 'create' || params.mode === 'optimize' ? params.mode : undefined
      if (!imageMode) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'mode 必须是 create 或 optimize', 400)
      const effectiveSourceAssetIds = sourceAssetIds ?? (imageMode === 'optimize' ? product.sourceAssetIds : undefined)
      if (imageMode === 'optimize' && !effectiveSourceAssetIds?.length) throw new DomainError('IMAGE_OPTIMIZATION_SOURCE_REQUIRED', '素材优化模式必须提供至少一个已授权商品素材', 400)
      requireApprovedAssetForImageGeneration(workspaceId, product, effectiveSourceAssetIds)
      let skuIds: string[] | undefined
      if (typeof params.sku_ids_json === 'string' && params.sku_ids_json.trim()) {
        try {
          const parsed = JSON.parse(params.sku_ids_json)
          if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string' || !value.trim())) throw new Error('invalid sku_ids_json')
          skuIds = [...new Set(parsed.map(value => value.trim()))]
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'sku_ids_json 必须是 SKU ID 字符串数组 JSON', 400) }
      }
      const idempotencyKey = (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) || header(req, 'idempotency-key')?.trim() || `image-${workspaceId}-${productId}-${typeof params.direction === 'string' ? params.direction : 'default'}`
      const existingImageJob = [...service.imageGenerationJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === idempotencyKey)
      const walletDebitKey = `image:${idempotencyKey}`
      const entitlementKey = `image-addon:${idempotencyKey}`
      let entitlementConsumed = false
      if (!existingImageJob) {
        entitlementConsumed = Boolean(await consumeEntitlement({ workspaceId, kind: 'image_generation', actionKey: entitlementKey, actionKind: 'model_image', actorId: requestActor(req), description: '商品主图生成权益' }))
        if (!entitlementConsumed) await requirePluginWalletAccess(workspaceId)
        if (!entitlementConsumed) await debitPluginWallet({ workspaceId, idempotencyKey: walletDebitKey, actorId: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant', description: '商品主图生成调用' })
      }
      let job: ReturnType<typeof service.enqueueImageGeneration>
      try {
        job = service.enqueueImageGeneration({ workspaceId, productId, idempotencyKey, imageMode, ...(skuIds ? { skuIds } : {}), ...(effectiveSourceAssetIds ? { sourceAssetIds: effectiveSourceAssetIds } : {}), ...(typeof params.task_id === 'string' && params.task_id.trim() ? { taskId: params.task_id.trim() } : {}), ...(typeof params.content_version_id === 'string' && params.content_version_id.trim() ? { contentVersionId: params.content_version_id.trim() } : {}), ...(typeof params.direction === 'string' ? { direction: params.direction } : {}), ...(typeof params.count === 'string' && /^\d+$/u.test(params.count) ? { count: Number(params.count) } : {}) })
      } catch (error) {
        if (entitlementConsumed) await refundEntitlement({ workspaceId, actionKey: entitlementKey, reason: '图片任务创建失败' })
        else if (!existingImageJob) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant', reason: '图片任务创建失败' })
        throw error
      }
      // The local Codex fixture completes immediately so merchants can exercise
      // the entire workflow. Production uses the same handle with an image worker
      // and object-storage provider before exposing the result.
      const imageExecution = executionContract('image', Boolean(imageGenerator))
      if (job.state === 'succeeded') {
        const images = await readArchivedGeneratedImages(workspaceId, job)
        return result({ job_id: job.id, product_id: product.id, execution: imageExecution, rule_preflight: rulePreflight, job: publicImageJob(job), ...(images.length ? { images, review: reviewProductImagesForMcp(images) } : {}), ...(job.archiveState === 'external_unarchived' ? { availabilityWarning: '图片提供方仅返回外部地址，本批次未形成可持久读取的归档文件' } : {}) })
      }
      await persistSnapshot(workspaceId, 'image_generation_job', job, job as unknown as Record<string, unknown>)
      let completed: Awaited<ReturnType<typeof service.completeImageGeneration>>
      try {
        completed = await service.completeImageGeneration({ workspaceId, jobId: job.id })
      } catch (error) {
        if (!providerSucceededButSettlementPending(error)) {
          if (entitlementConsumed) await refundEntitlement({ workspaceId, actionKey: entitlementKey, reason: '图片生成失败' })
          else if (!existingImageJob) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant', reason: '图片生成失败' })
        }
        await persistSnapshot(workspaceId, 'image_generation_job', job, job as unknown as Record<string, unknown>)
        throw error
      }
      const archived = await archiveGeneratedImages(workspaceId, job.id, completed.images)
      await persistSnapshot(workspaceId, 'image_generation_job', archived, archived as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, job.id, 'product.image_candidates_generated', archived.revision, { job_id: job.id, product_id: productId, task_id: archived.taskId ?? null, content_version_id: archived.contentVersionId ?? null, candidate_count: archived.outputs?.length ?? 0, archive_state: archived.archiveState, direction: archived.direction, artifact_role: 'candidate' })
      return result({ job_id: archived.id, product_id: completed.product.id, execution: imageExecution, rule_preflight: rulePreflight, job: publicImageJob(archived), product: completed.product, images: completed.images, review: reviewProductImagesForMcp(completed.images) })
    }
    case 'catalog.image.get': {
      const jobId = typeof params.job_id === 'string' && params.job_id.trim() ? params.job_id.trim() : undefined
      const visualRef = typeof params.visual_ref === 'string' && params.visual_ref.trim() ? params.visual_ref.trim() : undefined
      if (Boolean(jobId) === Boolean(visualRef)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'job_id 与 visual_ref 必须且只能提供一个', 400)
      const job = jobId ? service.getImageGenerationJob(workspaceId, jobId) : service.resolveImageGenerationByVisualRef(workspaceId, visualRef!)
      const images = await readArchivedGeneratedImages(workspaceId, job)
      const selectedImages = visualRef && job.outputs?.length ? [images[job.outputs.findIndex(output => output.visualRef === visualRef)]!].filter(Boolean) : images
      return result({ job_id: job.id, execution: executionContract('image', Boolean(imageGenerator)), ...(selectedImages.length ? { images: selectedImages, review: reviewProductImagesForMcp(selectedImages) } : {}), job: publicImageJob(job), historicalCandidate: true, platformPublished: false })
    }
    case 'catalog.image.review': {
      const productId = required(params, 'product_id')
      const product = service.products.get(productId)
      if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
      let visualRefs: string[] | undefined
      if (typeof params.visual_refs_json === 'string' && params.visual_refs_json.trim()) {
        try {
          const parsed = JSON.parse(params.visual_refs_json)
          if (!Array.isArray(parsed) || !parsed.length || parsed.length > 6 || parsed.some(value => typeof value !== 'string') || new Set(parsed).size !== parsed.length) throw new Error('invalid')
          visualRefs = parsed
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'visual_refs_json 必须是 1 至 6 个不重复候选引用的 JSON 数组', 400) }
      }
      let images = parseImageListForMcp(params.images) ?? product.images
      if (visualRefs) {
        images = []
        for (const visualRef of visualRefs) {
          const job = service.resolveImageGenerationByVisualRef(workspaceId, visualRef)
          if (job.productId !== product.id) throw new DomainError('VISUAL_SELECTION_SCOPE_MISMATCH', '图片候选不属于当前商品', 409)
          const archived = await readArchivedGeneratedImages(workspaceId, job)
          const index = job.outputs?.findIndex(output => output.visualRef === visualRef) ?? -1
          if (index < 0 || !archived[index]) throw new DomainError('VISUAL_NOT_READY', '图片候选不可读取', 409)
          images.push(archived[index]!)
        }
      }
      const findings = reviewProductImagesForMcp(images)
      if (visualRefs) {
        const jobs = service.reviewImageGenerationOutputs(workspaceId, visualRefs, findings.some(finding => finding.severity === 'error') ? 'blocked' : 'passed')
        for (const job of jobs) await persistSnapshot(workspaceId, 'image_generation_job', job, job as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, jobs[0]!.id, 'product.image_candidates_reviewed', Math.max(...jobs.map(job => job.revision)), { product_id: product.id, visual_refs: visualRefs, review_status: findings.some(finding => finding.severity === 'error') ? 'blocked' : 'passed', finding_count: findings.length })
      }
      return result({ productId, images: images ?? [], findings, ...(visualRefs ? { visualRefs, persistedReviewStatus: findings.some(finding => finding.severity === 'error') ? 'blocked' : 'passed' } : {}), externallyUnverified: ['尺寸/清晰度', '主体占比', 'OCR 文字合规', '平台最终审核'] })
    }
    case 'content.visual.select': {
      const scoped = scopeContentVersion(req, required(params, 'content_version_id'))
      let visualRefs: string[]
      try {
        const parsed = JSON.parse(required(params, 'visual_refs_json'))
        if (!Array.isArray(parsed) || !parsed.length || parsed.length > 6 || parsed.some(value => typeof value !== 'string') || new Set(parsed).size !== parsed.length) throw new Error('invalid')
        visualRefs = parsed
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'visual_refs_json 必须是 1 至 6 个不重复候选引用的 JSON 数组', 400) }
      const expectedRevision = Number(required(params, 'expected_revision'))
      const idempotencyKey = (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) || header(req, 'idempotency-key')?.trim()
      if (!idempotencyKey) throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, '选图必须提供幂等键', 400)
      const selected = service.selectVisuals({ workspaceId, contentVersionId: scoped.version.id, visualRefs, expectedRevision, idempotencyKey, selectedBy: requestActor(req), reason: required(params, 'reason') })
      await persistSnapshotsAndEvent({ workspaceId, snapshots: [
        { entityType: 'content_version', entityId: selected.version.id, entityVersion: selected.version.revision, payload: selected.version as unknown as Record<string, unknown> },
        { entityType: 'task', entityId: selected.task.id, entityVersion: selected.task.version, payload: selected.task as unknown as Record<string, unknown> },
      ], aggregateId: selected.version.id, eventType: 'content.visual_selected', sequence: selected.version.revision, eventPayload: { source_content_version_id: selected.source.id, content_version_id: selected.version.id, visual_refs: visualRefs, selected_count: visualRefs.length, reason: required(params, 'reason') } })
      return result({ content_version_id: selected.version.id, parent_content_version_id: selected.source.id, version: selected.version.version, revision: selected.version.revision, state: selected.version.state, visualSelection: { state: 'selected', count: selected.version.visualSelection!.items.length, items: selected.version.visualSelection!.items.map(item => ({ visualRef: item.visualRef, ordinal: item.ordinal, mimeType: item.mimeType, reviewStatus: item.reviewStatus, publishable: false })) }, reviewRequired: true, approvalRequired: true })
    }
    case 'sync.retry_failed': {
      let failureIds: string[] | undefined
      if (typeof params.failure_ids_json === 'string' && params.failure_ids_json.trim()) {
        try {
          const parsed = JSON.parse(params.failure_ids_json)
          if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('failure_ids_json must be an array')
          failureIds = parsed
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'failure_ids_json 必须是字符串数组 JSON', 400) }
      }
      const sourceJobId = required(params, 'job_id')
      const sourceJob = service.getSyncJob(workspaceId, sourceJobId)
      const policy = automationPolicies.get(automationPolicyKey(workspaceId, sourceJob.platform, sourceJob.accountId))
      if (policy && (sourceJob.retryCount ?? 0) >= policy.retryLimit) throw new DomainError('AUTOMATION_RETRY_LIMIT_REACHED', `该店铺同步失败重试次数已达到自动化策略上限（${policy.retryLimit} 次）`, 409, { platform: sourceJob.platform, account_id: sourceJob.accountId, retry_count: sourceJob.retryCount ?? 0, retry_limit: policy.retryLimit, next_step: '调整自动化策略 retry_limit 或由运营人员确认后重新发起同步' })
      const jobs = service.retrySyncFailures(workspaceId, sourceJobId, failureIds)
      for (const job of jobs) {
        await persistSnapshot(workspaceId, 'sync_job', job, job as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, job.id, 'sync.requested', job.revision, { job_id: job.id, platform: job.platform, account_id: job.accountId, mode: job.mode, ...(job.resumeCursor ? { cursor: job.resumeCursor } : {}), retry_of: sourceJobId })
      }
      return result({ jobs })
    }
    case 'rule.list': {
      const repository = ruleRepository()
      const requestedPlatform = typeof params.platform === 'string' && params.platform.trim() ? params.platform.trim() : undefined
      const requestedCategory = typeof params.category === 'string' && params.category.trim() ? params.category.trim() : undefined
      const requestedBrand = typeof params.brand === 'string' && params.brand.trim() ? params.brand.trim() : undefined
      const requestedStore = typeof params.store === 'string' && params.store.trim() ? params.store.trim() : undefined
      const requestedCampaign = typeof params.campaign === 'string' && params.campaign.trim() ? params.campaign.trim() : undefined
      if (requestedPlatform && !SUPPORTED_PLATFORMS.includes(requestedPlatform as Platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
      const requestedContext: Record<string, string | undefined> = { platform: requestedPlatform, category: requestedCategory, brand: requestedBrand, store: requestedStore, campaign: requestedCampaign }
      const hasContext = Object.values(requestedContext).some(Boolean)
      const matchesContext = (rule: { scope: string; targetId?: string; scopeValue?: string }) => {
        if (!hasContext) return true
        if (rule.scope === 'global') return true
        const expected = requestedContext[rule.scope]
        const target = rule.targetId ?? rule.scopeValue
        return Boolean(expected && target === expected)
      }
      const filterRules = <T extends { status: string; scope: string; targetId?: string; scopeValue?: string }>(rules: T[]) => rules.filter(rule => rule.status === 'active' && matchesContext(rule))
      if (repository) return result(filterRules(await rulePacksForWorkspace(workspaceId)))
      if (isProduction()) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '生产规则仓储未配置', 503)
      return result(filterRules(service.ruleCenter.list({ includeInactive: false })))
    }
    case 'rule.sync.status': {
      const intervalHours = typeof params.interval_hours === 'string' && Number.isFinite(Number(params.interval_hours)) ? Number(params.interval_hours) : Number(process.env.PLATFORM_RULE_SYNC_INTERVAL_HOURS ?? 24)
      return result(platformRuleSyncStatus(await rulePacksForWorkspace(workspaceId), { intervalHours, manifestUrl: process.env.PLATFORM_RULE_SYNC_MANIFEST_URL, signingSecretConfigured: Boolean(process.env.PLATFORM_RULE_SYNC_SIGNING_SECRET?.trim()) }))
    }
    case 'rule.history': {
      const packId = required(params, 'pack_id')
      const repository = ruleRepository()
      if (repository) return result(await repository.list(workspaceId, packId).then(rows => rows.map(publicRule)))
      if (isProduction()) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '生产规则仓储未配置', 503)
      return result(service.listRuleHistory(packId))
    }
    case 'rule.audit': {
      const packId = typeof params.pack_id === 'string' && params.pack_id.trim() ? params.pack_id.trim() : undefined
      requireRuleAdmin(req)
      const repository = ruleRepository()
      if (repository) return result(await repository.listAudit(workspaceId, packId))
      if (isProduction()) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '生产规则仓储未配置', 503)
      return result(service.listRuleAudit(packId))
    }
    case 'rule.publish': {
      const principal = requireRuleAdmin(req)
      const packId = required(params, 'pack_id')
      const name = required(params, 'name')
      const versionValue = required(params, 'version')
      const scope = required(params, 'scope')
      const sourceKind = required(params, 'source_kind')
      const sourceReference = required(params, 'source_reference')
      const sourceCheckedAt = required(params, 'source_checked_at')
      const reason = required(params, 'reason')
      const status = typeof params.status === 'string' ? params.status : 'draft'
      if (!['global', 'platform', 'category', 'brand', 'store', 'campaign'].includes(scope) || !['official', 'internal', 'legal_review'].includes(sourceKind) || !['draft', 'active'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则发布参数无效', 400)
      if (!Number.isFinite(Date.parse(sourceCheckedAt))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'source_checked_at 必须是合法时间', 400)
      let checks: Record<string, unknown>
      try { const parsed = JSON.parse(required(params, 'checks_json')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('checks_json'); checks = parsed as Record<string, unknown> } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'checks_json 必须是 JSON 对象', 400) }
      const effectiveFromRaw = typeof params.effective_from === 'string' && params.effective_from.trim() ? params.effective_from.trim() : undefined
      const effectiveToRaw = typeof params.effective_to === 'string' && params.effective_to.trim() ? params.effective_to.trim() : undefined
      if ((effectiveFromRaw && Number.isNaN(Date.parse(effectiveFromRaw))) || (effectiveToRaw && Number.isNaN(Date.parse(effectiveToRaw))) || (effectiveFromRaw && effectiveToRaw && Date.parse(effectiveFromRaw) >= Date.parse(effectiveToRaw))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则有效期必须是合法时间，且 effective_from 早于 effective_to', 400)
      const effectiveFrom = effectiveFromRaw ? new Date(effectiveFromRaw).toISOString() : undefined
      const effectiveTo = effectiveToRaw ? new Date(effectiveToRaw).toISOString() : undefined
      const severity = params.severity === 'warning' ? 'warning' : params.severity === 'error' || params.severity === undefined ? 'error' : undefined
      const action = ['block', 'warn', 'review', 'allow'].includes(String(params.action)) ? String(params.action) : params.action === undefined ? 'block' : undefined
      if (!severity || !action) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则 severity/action 无效', 400)
      const input: JsonObject = { approval: typeof params.approval_json === 'string' ? JSON.parse(params.approval_json) : undefined }
      const approval = status === 'active' ? parseApprovalGrant(req, workspaceId, principal.actorId, input) : undefined
      const at = new Date().toISOString()
      const checksum = createHash('sha256').update(canonicalJson(checks)).digest('hex')
      const repository = ruleRepository()
      if (repository) {
        await persistence.ensureWorkspace?.(workspaceId)
        const versionInput = { id: `rule_${randomBytes(12).toString('hex')}`, workspaceId, packId, name, version: versionValue, scope, status, sourceKind, sourceReference, sourceCheckedAt: new Date(sourceCheckedAt).toISOString(), checksum, checks, severity, action, ...(effectiveFrom ? { effectiveFrom } : {}), ...(effectiveTo ? { effectiveTo } : {}), ...(typeof params.target_id === 'string' && params.target_id.trim() ? { targetId: params.target_id.trim() } : {}), ...(typeof params.scope_value === 'string' && params.scope_value.trim() ? { scopeValue: params.scope_value.trim() } : {}), createdBy: principal.actorId, revision: 1, createdAt: at, updatedAt: at, ...(status === 'active' ? { activatedAt: at } : {}) }
        const audit = { id: `rule_audit_${randomBytes(12).toString('hex')}`, workspaceId, rulePackId: packId, ruleVersionId: versionInput.id, version: versionValue, action: status === 'active' ? 'activated' : 'created', actorId: principal.actorId, reason, occurredAt: at, data: { checksum, ...(approval ? { approval } : {}) } }
        if (repository.insertVersionWithAudit) return result((await repository.insertVersionWithAudit({ version: versionInput, audit })).version)
        const created = await repository.insertVersion(versionInput)
        return result({ version: created, audit: await repository.appendAudit({ ...audit, ruleVersionId: created.id, version: created.version }) })
      }
      if (isProduction()) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '生产规则仓储未配置', 503)
      const published = service.publishRuleVersion({ packId, name, version: versionValue, scope: scope as 'global' | 'platform' | 'category' | 'brand' | 'store' | 'campaign', source: { kind: sourceKind as 'official' | 'internal' | 'legal_review', reference: sourceReference, checkedAt: new Date(sourceCheckedAt).toISOString() }, checks: checks as { forbiddenTerms?: string[]; requiredFields?: string[] }, actorId: principal.actorId, reason })
      if (status === 'active') return result(service.setRuleStatus({ packId, version: versionValue, status: 'active', actorId: principal.actorId, reason }))
      return result(published)
    }
    case 'rule.status': {
      const principal = requireRuleAdmin(req)
      const packId = required(params, 'pack_id'); const versionValue = required(params, 'version'); const status = required(params, 'status'); const reason = required(params, 'reason')
      if (!['active', 'inactive', 'expired'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则状态无效', 400)
      const approval = status === 'active' ? parseApprovalGrant(req, workspaceId, principal.actorId, { approval: typeof params.approval_json === 'string' ? JSON.parse(params.approval_json) : undefined }) : undefined
      const repository = ruleRepository()
      if (repository) {
        const rows = await repository.list(workspaceId, packId); const target = rows.find(row => row.version === versionValue)
        if (!target) throw new DomainError('RULE_VERSION_NOT_FOUND', '规则版本不存在', 404)
        const current = rows.find(row => row.status === 'active' && row.id !== target.id); const at = new Date().toISOString()
        if (repository.transitionStatusWithAudit) return result(publicRule((await repository.transitionStatusWithAudit({ workspaceId, packId, targetId: target.id, status, actorId: principal.actorId, reason, occurredAt: at, targetAuditId: `rule_audit_${randomBytes(12).toString('hex')}`, ...(current ? { currentAuditId: `rule_audit_${randomBytes(12).toString('hex')}` } : {}), auditData: approval ? { approval_ref: approval.approvalRef, approved_by: approval.approvedBy, approved_at: approval.approvedAt } : {} })).version))
        return result(publicRule(await repository.updateStatus({ workspaceId, id: target.id, status, revision: target.revision + 1, updatedAt: at, activatedAt: status === 'active' ? at : null, deactivatedAt: status === 'active' ? null : at })))
      }
      if (isProduction()) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '生产规则仓储未配置', 503)
      return result(service.setRuleStatus({ packId, version: versionValue, status: status as 'active' | 'inactive' | 'expired', actorId: principal.actorId, reason }))
    }
    case 'asset.list': {
      const assets = service.listAssets(workspaceId)
      const pendingScan = assets.some(asset => asset.scanStatus === 'quarantined')
      const failedParse = assets.some(asset => asset.scanStatus === 'clean' && asset.parseStatus === 'failed')
      const pendingParse = assets.some(asset => asset.scanStatus === 'clean' && asset.parseStatus !== 'succeeded' && asset.parseStatus !== 'failed')
      const action_cards = assets.length === 0
        ? [
            { method: 'asset.upload', label: '上传商品图片', required_inputs: ['name', 'mime_type', 'content_base64'], confirmation: 'interactive_confirmation' },
            { method: 'asset.upload', label: '上传品牌资料', required_inputs: ['name', 'mime_type', 'content_base64'], confirmation: 'interactive_confirmation' },
          ]
        : pendingScan
          ? [{ method: 'asset.scan', label: '提交安全扫描结果', required_inputs: ['asset_id', 'scan_evidence_ref'], confirmation: 'interactive_confirmation' }]
          : failedParse
            ? [{ method: 'asset.facts.confirm', label: '人工确认素材事实', required_inputs: ['asset_id', 'facts_json', 'reason'], confirmation: 'interactive_confirmation' }]
            : pendingParse
            ? [{ method: 'asset.parse', label: '解析素材事实', required_inputs: ['asset_id'], confirmation: 'interactive_confirmation' }]
            : [{ method: 'asset.facts.confirm', label: '确认素材事实与商用权益', required_inputs: ['asset_id', 'facts_json', 'reason'], confirmation: 'interactive_confirmation' }]
      const readiness = assets.reduce((summary, asset) => { summary[asset.readiness.status] += 1; return summary }, { draft: 0, ready: 0, blocked: 0 })
      const asset_actions = assets.map(asset => {
        const base = { asset_id: asset.id, asset_name: asset.name, status: asset.readiness.status, reasons: asset.readiness.reasons }
        if (asset.scanStatus === 'quarantined') return { ...base, action: { method: 'asset.scan', label: '提交安全扫描结果', required_inputs: ['asset_id', 'scan_evidence_ref'], confirmation: 'interactive_confirmation' } }
        if (asset.scanStatus === 'blocked') return { ...base, action: null, next_step: '联系安全审核并重新上传或解除安全阻断' }
        if (asset.parseStatus === 'failed') return { ...base, action: { method: 'asset.facts.confirm', label: '人工确认素材事实', required_inputs: ['asset_id', 'facts_json', 'reason'], confirmation: 'interactive_confirmation' } }
        if (asset.parseStatus !== 'succeeded') return { ...base, action: { method: 'asset.parse', label: '解析素材事实', required_inputs: ['asset_id'], confirmation: 'interactive_confirmation' } }
        if (asset.rightsStatus !== 'approved' || asset.rightsScope === 'unusable') return { ...base, action: { method: 'asset.rights.update', label: '确认素材商用权益', required_inputs: ['asset_id', 'rights_status'], confirmation: 'interactive_confirmation' } }
        if (!asset.factsConfirmedBy || !asset.factsConfirmedAt) return { ...base, action: { method: 'asset.facts.confirm', label: '确认素材事实', required_inputs: ['asset_id', 'facts_json', 'reason'], confirmation: 'interactive_confirmation' } }
        return { ...base, action: null, next_step: '素材已满足当前 readiness 条件' }
      })
      return result({ assets, readiness: { ...readiness, total: assets.length }, asset_actions, empty_state: assets.length ? null : { title: '还没有素材', message: '先上传商品图片或品牌资料；上传后还要完成扫描、解析和事实确认。' }, action_cards })
    }
    case 'asset.parse': {
      // Structured documents are parsed locally, but image parsing can fall
      // back to the platform-owned OCR relay. Keep this entry point behind
      // the same wallet gate in MCP and REST so a relay call cannot bypass
      // the merchant paywall.
      await requirePluginWalletAccess(workspaceId)
      const asset = assetForWorkspace(workspaceId, required(params, 'asset_id'))
      if (asset.scanStatus !== 'clean') throw new DomainError('ASSET_PARSE_SCAN_REQUIRED', '素材必须完成安全扫描后才能解析', 409)
      const ocrDebitKey = `asset-parse:${asset.id}`
      const ocrCandidate = asset.mimeType.toLowerCase().startsWith('image/')
      if (ocrCandidate && imageFactsExtractor) requirePlatformModelCostGate('ocr')
      if (ocrCandidate) await debitPluginWallet({ workspaceId, idempotencyKey: ocrDebitKey, actorId: requestActor(req), description: '图片 OCR/素材解析调用' })
      service.updateAssetParse({ workspaceId, assetId: asset.id, state: 'processing', source: 'parser' })
      try {
        const stored = await getStoredObjectWithRetry(workspaceId, asset.storageKey)
        const extracted = await parseAssetFacts({ name: asset.name, mimeType: asset.mimeType, body: stored.body, usageContext: { workspaceId, actionId: ocrDebitKey } })
        if (ocrCandidate && extracted.source !== 'model_ocr') await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: ocrDebitKey, actorId: requestActor(req), reason: '本次图片由本地解析器完成，未产生 OCR 中转调用' })
        const parsed = service.updateAssetParse({ workspaceId, assetId: asset.id, state: 'succeeded', facts: extracted.facts, source: extracted.source })
        await persistSnapshot(workspaceId, 'asset', parsed, parsed as unknown as Record<string, unknown>)
        const execution = executionContract('ocr', extracted.source === 'model_ocr')
        await persistEvent(workspaceId, asset.id, 'asset.parsed', parsed.revision, { asset_id: asset.id, parse_status: parsed.parseStatus, fact_keys: Object.keys(extracted.facts), source: extracted.source, execution })
        return result({ ...parsed, execution })
      } catch (error) {
        if (ocrCandidate && !providerSucceededButSettlementPending(error)) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: ocrDebitKey, actorId: requestActor(req), reason: '素材解析失败' })
        const parseError = error instanceof Error ? error.message : '素材解析失败'
        const errorContext = error instanceof DocumentParseError ? error.context : { code: 'parser_failure' as const, message: parseError, manualAction: 'asset.facts.confirm' as const }
        const failed = service.updateAssetParse({ workspaceId, assetId: asset.id, state: 'failed', error: parseError, errorContext })
        await persistSnapshot(workspaceId, 'asset', failed, failed as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, asset.id, 'asset.parse_failed', failed.revision, { asset_id: asset.id, error: failed.parseError ?? '素材解析失败' })
        throw new DomainError('ASSET_PARSE_FAILED', failed.parseError ?? '素材解析失败', 422)
      }
    }
    case 'asset.facts.confirm': {
      const asset = assetForWorkspace(workspaceId, required(params, 'asset_id'))
      let facts: Record<string, unknown>
      try {
        const parsed = JSON.parse(required(params, 'facts_json'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) throw new Error('empty')
        facts = parsed as Record<string, unknown>
      } catch {
        throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'facts_json 必须是非空 JSON 对象', 400)
      }
      const reason = required(params, 'reason').trim()
      if (!reason) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '人工补录原因不能为空', 400)
      const confirmed = service.updateAssetParse({ workspaceId, assetId: asset.id, state: 'succeeded', facts, source: 'manual', confirmedBy: requestActor(req) })
      await persistSnapshot(workspaceId, 'asset', confirmed, confirmed as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, asset.id, 'asset.facts_manually_confirmed', confirmed.revision, { asset_id: asset.id, fact_keys: Object.keys(facts), source: 'manual', confirmed_by: confirmed.factsConfirmedBy, reason })
      return result(confirmed)
    }
    case 'asset.preference.update': {
      const verdict = required(params, 'verdict')
      if (!['excellent', 'disliked', 'unrated'].includes(verdict)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'verdict 必须是 excellent、disliked 或 unrated', 400)
      let reasons: string[] | undefined
      if (typeof params.reasons_json === 'string') {
        try { const parsed = JSON.parse(params.reasons_json); if (!Array.isArray(parsed) || parsed.some(reason => typeof reason !== 'string')) throw new Error('reasons_json'); reasons = parsed } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'reasons_json 必须是字符串数组 JSON', 400) }
      }
      const updated = service.updateAssetPreference({ workspaceId, assetId: required(params, 'asset_id'), verdict: verdict as 'excellent' | 'disliked' | 'unrated', ...(reasons ? { reasons } : {}), ...(typeof params.note === 'string' ? { note: params.note } : {}), actorId: requestActor(req), ...(typeof params.expected_revision === 'string' && /^\d+$/u.test(params.expected_revision) ? { expectedRevision: Number(params.expected_revision) } : {}) })
      await persistSnapshot(workspaceId, 'asset', updated, updated as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, updated.id, 'asset.preference_updated', updated.revision, { asset_id: updated.id, verdict, reasons: updated.preference?.reasons ?? [], actor_id: updated.preference?.updatedBy ?? requestActor(req) })
      return result(updated)
    }
    case 'brand.get': return result(service.getBrandProfile(workspaceId) ?? null)
    case 'brand.extract': {
      let assetIds: string[] | undefined
      if (typeof params.asset_ids_json === 'string') {
        try {
          const parsed = JSON.parse(params.asset_ids_json)
          if (!Array.isArray(parsed) || !parsed.length || parsed.length > 50 || parsed.some(value => typeof value !== 'string' || !value.trim())) throw new Error('asset_ids_json')
          assetIds = parsed.map(value => String(value).trim())
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'asset_ids_json 必须是 1～50 个素材 ID 的字符串数组 JSON', 400) }
      }
      return result(service.extractBrandProfile(workspaceId, assetIds))
    }
    case 'brand.upsert': {
      const parseStringArray = (key: string) => {
        const value = params[key]
        if (value === undefined) return undefined
        if (typeof value !== 'string') throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是 JSON 数组`, 400)
        try { const parsed = JSON.parse(value); if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('invalid array'); return parsed as string[] } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是字符串数组 JSON`, 400) }
      }
      let details: Record<string, unknown> | undefined
      if (typeof params.details_json === 'string') {
        try { const parsed = JSON.parse(params.details_json); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('details_json'); details = parsed as Record<string, unknown> } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'details_json 必须是 JSON 对象', 400) }
      }
      let visualRules: BrandVisualRules | undefined
      if (typeof params.visual_rules_json === 'string') {
        try { const parsed = JSON.parse(params.visual_rules_json); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('visual_rules_json'); visualRules = parsed as BrandVisualRules } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'visual_rules_json 必须是 JSON 对象', 400) }
      }
      let resolutions: Record<string, 'existing' | 'candidate'> | undefined
      if (typeof params.conflict_resolutions_json === 'string') {
        try {
          const parsed = JSON.parse(params.conflict_resolutions_json)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => value !== 'existing' && value !== 'candidate')) throw new Error('conflict_resolutions_json')
          resolutions = parsed as Record<string, 'existing' | 'candidate'>
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'conflict_resolutions_json 必须是字段到 existing/candidate 的 JSON 对象', 400) }
      }
      const profile = service.upsertBrandProfile({ workspaceId, name: required(params, 'name'), ...(typeof params.positioning === 'string' ? { positioning: params.positioning } : {}), ...(typeof params.audience === 'string' ? { audience: params.audience } : {}), ...(parseStringArray('tone_json') ? { tone: parseStringArray('tone_json') } : {}), ...(parseStringArray('forbidden_terms_json') ? { forbiddenTerms: parseStringArray('forbidden_terms_json') } : {}), ...(details ? { details } : {}), ...(visualRules ? { visualRules } : {}), ...(typeof params.source === 'string' ? { source: params.source } : {}), ...(resolutions ? { resolutions } : {}) })
      await persistSnapshot(workspaceId, 'brand_profile', profile, profile as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, profile.id, 'brand_profile.updated', profile.revision, { brand_profile_id: profile.id, revision: profile.revision })
      return result(profile)
    }
    case 'brand.tone.preview': {
      return result(service.previewBrandTone(workspaceId, { ...(typeof params.topic === 'string' ? { topic: params.topic } : {}), ...(typeof params.product_id === 'string' ? { productId: params.product_id } : {}) }))
    }
    case 'asset.upload': {
      const encoded = required(params, 'content_base64')
      let bytes: Uint8Array
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'content_base64 无效', 400)
      try { bytes = new Uint8Array(Buffer.from(encoded, 'base64')) } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'content_base64 无效', 400) }
      if (!bytes.byteLength || bytes.byteLength > 50 * 1024 * 1024) throw new DomainError('ASSET_UPLOAD_LIMIT', 'Codex MCP 单次素材上传限制为 50MB', 413)
      const assetName = required(params, 'name')
      const assetMime = required(params, 'mime_type')
      validateAssetContentSignature(assetName, assetMime, bytes)
      let applicablePlatforms: Platform[] | undefined
      if (typeof params.applicable_platforms_json === 'string') {
        try {
          const parsed = JSON.parse(params.applicable_platforms_json)
          if (!Array.isArray(parsed) || parsed.some(value => !SUPPORTED_PLATFORMS.includes(String(value) as Platform))) throw new Error('applicable_platforms_json')
          applicablePlatforms = parsed as Platform[]
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'applicable_platforms_json 必须是首发平台字符串数组 JSON', 400) }
      }
      const parseAssetList = (key: string) => {
        if (typeof params[key] !== 'string') return undefined
        try { const parsed = JSON.parse(params[key] as string); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error(key); return parsed as string[] } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是字符串数组 JSON`, 400) }
      }
      const applicableRegions = parseAssetList('applicable_regions_json')
      const usageScopes = parseAssetList('usage_scopes_json')
      const rightsScope = typeof params.rights_scope === 'string' ? params.rights_scope as import('../../../packages/application/src/service.js').AssetMetadata['rightsScope'] : undefined
      if (rightsScope && !['owned', 'commercial_authorized', 'limited_use', 'internal_only', 'unknown', 'unusable'].includes(rightsScope)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'rights_scope 无效', 400)
      const provisional = service.registerAsset({ workspaceId, name: assetName, mimeType: assetMime, sizeBytes: bytes.byteLength, sha256: typeof params.sha256 === 'string' && /^[a-f0-9]{64}$/iu.test(params.sha256) ? params.sha256 : createHash('sha256').update(bytes).digest('hex'), storageKey: `quarantine/${workspaceId}/pending/${randomUUID()}/${assetName}`, ...(rightsScope ? { rightsScope } : {}), ...(applicablePlatforms ? { applicablePlatforms } : {}), ...(applicableRegions ? { applicableRegions } : {}), ...(usageScopes ? { usageScopes } : {}), ...(typeof params.valid_from === 'string' ? { validFrom: params.valid_from } : {}), ...(typeof params.valid_to === 'string' ? { validTo: params.valid_to } : {}), ...(params.ai_modification_allowed === 'true' || params.ai_modification_allowed === 'false' ? { aiModificationAllowed: params.ai_modification_allowed === 'true' } : {}) })
      if (provisional.deduplication.mode === 'deduplicated') { await persistAssetReference(workspaceId, provisional); return result(provisional) }
      let storedKey: string | undefined
      try {
        const stored = await getAssetStorage().putQuarantine({ workspaceId, assetId: provisional.id, fileName: provisional.name, contentType: provisional.mimeType, body: bytes, expectedSizeBytes: bytes.byteLength, expectedSha256: provisional.sha256 })
        storedKey = stored.key
        provisional.storageKey = stored.key
        await persistSnapshot(workspaceId, 'asset', provisional, provisional as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, provisional.id, 'asset.uploaded', provisional.revision, { asset_id: provisional.id, storage_key: stored.key, size_bytes: stored.sizeBytes, sha256: stored.sha256 })
        return result(provisional)
      } catch (error) {
        service.assets.delete(provisional.id)
        if (storedKey) await compensateStoredObject(workspaceId, storedKey, 'asset snapshot or event persistence failed')
        throw error
      }
    }
    case 'asset.upload.batch': {
      const raw = required(params, 'assets_json')
      let entries: unknown
      try { entries = JSON.parse(raw) } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'assets_json 必须是 JSON 数组', 400) }
      if (!Array.isArray(entries) || entries.length === 0 || entries.length > 20 || entries.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new DomainError('ASSET_BATCH_LIMIT', '单批素材数量必须在 1 到 20 个之间', 413)
      const items = entries as JsonObject[]
      const totalBytes = items.reduce((sum, item) => {
        const value = typeof item.content_base64 === 'string' ? item.content_base64 : ''
        return sum + Math.floor(value.replace(/=+$/u, '').length * 3 / 4)
      }, 0)
      if (totalBytes > 250 * 1024 * 1024) throw new DomainError('ASSET_BATCH_LIMIT', '单批素材总大小不能超过 250MB', 413)
      const assets = []
      for (const item of items) assets.push(await uploadAssetForMcp(workspaceId, item))
      return result({ assets, count: assets.length, totalBytes })
    }
    case 'asset.scan': {
      const asset = assetForWorkspace(workspaceId, required(params, 'asset_id'))
      if (asset.scanStatus !== 'quarantined' || !asset.storageKey.startsWith('quarantine/')) throw new DomainError('ASSET_SCAN_STATE_INVALID', '素材当前不在待扫描隔离状态', 409)
      const promoted = await getAssetStorage().promoteClean({ workspaceId, quarantineKey: asset.storageKey, scanEvidenceRef: required(params, 'scan_evidence_ref') })
      asset.storageKey = promoted.key; asset.scanStatus = 'clean'; asset.revision += 1
      await persistSnapshot(workspaceId, 'asset', asset, asset as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, asset.id, 'asset.scan_promoted', asset.revision, { asset_id: asset.id, scan_evidence_ref: promoted.scanEvidenceRef, storage_key: promoted.key })
      return result({ ...asset, scanEvidenceRef: promoted.scanEvidenceRef })
    }
    case 'asset.rights.update': {
      const asset = assetForWorkspace(workspaceId, required(params, 'asset_id'))
      const rightsStatus = required(params, 'rights_status')
      if (!['approved', 'rejected', 'pending'].includes(rightsStatus)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'rights_status 无效', 400)
      let applicablePlatforms: Platform[] | undefined
      if (typeof params.applicable_platforms_json === 'string') {
        try {
          const parsed = JSON.parse(params.applicable_platforms_json)
          if (!Array.isArray(parsed) || parsed.some(value => !SUPPORTED_PLATFORMS.includes(String(value) as Platform))) throw new Error('applicable_platforms_json')
          applicablePlatforms = parsed as Platform[]
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'applicable_platforms_json 必须是首发平台字符串数组 JSON', 400) }
      }
      const parseAssetList = (key: string) => {
        if (typeof params[key] !== 'string') return undefined
        try { const parsed = JSON.parse(params[key] as string); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error(key); return parsed as string[] } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是字符串数组 JSON`, 400) }
      }
      const applicableRegions = parseAssetList('applicable_regions_json')
      const usageScopes = parseAssetList('usage_scopes_json')
      const rightsScope = typeof params.rights_scope === 'string' ? params.rights_scope as import('../../../packages/application/src/service.js').AssetMetadata['rightsScope'] : undefined
      if (rightsScope && !['owned', 'commercial_authorized', 'limited_use', 'internal_only', 'unknown', 'unusable'].includes(rightsScope)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'rights_scope 无效', 400)
      const updated = service.updateAssetRights({ workspaceId, assetId: asset.id, rightsStatus: rightsStatus as 'approved' | 'rejected' | 'pending', ...(rightsScope ? { rightsScope } : {}), ...(applicablePlatforms ? { applicablePlatforms } : {}), ...(applicableRegions ? { applicableRegions } : {}), ...(usageScopes ? { usageScopes } : {}), ...(typeof params.valid_from === 'string' ? { validFrom: params.valid_from } : {}), ...(typeof params.valid_to === 'string' ? { validTo: params.valid_to } : {}), ...(params.ai_modification_allowed === 'true' || params.ai_modification_allowed === 'false' ? { aiModificationAllowed: params.ai_modification_allowed === 'true' } : {}) })
      await persistSnapshot(workspaceId, 'asset', updated, updated as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, updated.id, 'asset.rights_updated', updated.revision, { asset_id: updated.id, rights_status: updated.rightsStatus })
      return result(updated)
    }
    case 'catalog.sync': {
      const platform = required(params, 'platform') as Platform
      if (!platformConnectorConfigured(platform)) throw new DomainError('NOT_CONFIGURED', `${platform} 官方 API 尚未配置，无法同步商品`, 503)
      const accountId = (typeof params.account_id === 'string' && params.account_id.trim()) || header(req, 'x-account-id')?.trim() || (isProduction() ? '' : defaultFixtureAccountId(workspaceId, platform))
      if (!accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产同步必须指定已授权平台账号', 400)
      const platformAccount = isProduction() || fixtureMode ? requireActivePlatformAccount(workspaceId, accountId, platform) : undefined
      await ensureFixtureAccount(workspaceId, platform, accountId)
      const syncEntitlementKey = `bulk-sync:${workspaceId}:${platform}:${accountId}:${typeof params.cursor === 'string' ? params.cursor : 'full'}:${header(req, 'idempotency-key')?.trim() ?? 'default'}`
      const syncEntitlement = await consumeEntitlement({ workspaceId, kind: 'bulk_sync', actionKey: syncEntitlementKey, actionKind: 'catalog_sync', actorId: requestActor(req), description: '商品批量同步权益（可选加购）' })
      try {
        const synced = await connectorRuntime.sync(platform, { workspaceId, accountId, ...(platformAccount ? { credentialRef: platformAccount.credentialRef } : {}), traceId: requestId(req) }, typeof params.cursor === 'string' ? params.cursor : undefined)
        const products = service.upsertSyncedProducts({ workspaceId, platform, accountId, items: synced.items })
        for (const product of products) await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
        const automation = await scanAutomationAfterOperationalCompletion(workspaceId, platform, accountId, 'catalog.sync.completed')
        return result({ ...synced, products, automation })
      } catch (error) {
        if (syncEntitlement) await refundEntitlement({ workspaceId, actionKey: syncEntitlementKey, reason: '商品批量同步失败' })
        throw error
      }
    }
    case 'catalog.sync.start': {
      return result(await requestCatalogSync(workspaceId, req, params))
    }
    case 'catalog.sync.get': return result(service.getSyncJob(workspaceId, required(params, 'job_id')))
    case 'deliverable.list': {
      const deliverables = service.listDeliverables(workspaceId, {
      ...(typeof params.query === 'string' ? { query: params.query } : {}),
      ...(typeof params.platform === 'string' ? { platform: params.platform as Platform } : {}),
      ...(typeof params.account_id === 'string' ? { accountId: params.account_id } : {}),
      ...(typeof params.product_id === 'string' ? { productId: params.product_id } : {}),
      ...(typeof params.task_id === 'string' ? { taskId: params.task_id } : {}),
      ...(typeof params.state === 'string' ? { state: params.state as import('../../../packages/application/src/service.js').ContentVersion['state'] } : {}),
      ...(typeof params.date_from === 'string' ? { dateFrom: params.date_from } : {}),
      ...(typeof params.date_to === 'string' ? { dateTo: params.date_to } : {}),
      ...(typeof params.limit === 'string' ? { limit: Number(params.limit) } : {}),
      ...(typeof params.cursor === 'string' ? { cursor: params.cursor } : {}),
      })
      const visibleTasks = await filterByTaskBrandAccess(req, workspaceId, service.listTasks(workspaceId))
      const visibleTaskIds = new Set(visibleTasks.map(task => task.id))
      const items = deliverables.items.filter(item => visibleTaskIds.has(item.task.id))
      return result({
        ...deliverables,
        items,
        empty_state: items.length ? null : { title: '还没有内容交付', message: '先创建内容任务，完成方案、审核和批准后，这里会出现可导出的交付物。' },
        action_cards: items.length ? [{ method: 'content.versions', label: '查看内容版本', required_inputs: ['task_id'], confirmation: 'none' }] : [{ method: 'task.understand', label: '创建内容任务', required_inputs: ['instruction', 'platform', 'account_id'], confirmation: 'interactive_confirmation' }],
      })
    }
    case 'task.history': {
      const items = await filterByTaskBrandAccess(req, workspaceId, service.listTasks(workspaceId, {
      ...(typeof params.query === 'string' ? { query: params.query } : {}),
      ...(typeof params.platform === 'string' ? { platform: params.platform as Platform } : {}),
      ...(typeof params.state === 'string' ? { state: params.state as import('../../../packages/application/src/service.js').TaskState } : {}),
      ...(typeof params.product_id === 'string' ? { productId: params.product_id } : {}),
      ...(typeof params.account_id === 'string' ? { accountId: params.account_id } : {}),
      ...(typeof params.brand_name === 'string' ? { brandName: params.brand_name } : {}),
      ...(typeof params.store_name === 'string' ? { storeName: params.store_name } : {}),
      ...(typeof params.remote_product_id === 'string' ? { remoteProductId: params.remote_product_id } : {}),
      ...(typeof params.publish_status === 'string' ? { publishStatus: params.publish_status as import('../../../packages/application/src/service.js').PublishState } : {}),
      ...(typeof params.date_from === 'string' ? { dateFrom: params.date_from } : {}),
      ...(typeof params.date_to === 'string' ? { dateTo: params.date_to } : {}),
      }))
      return result({
        items,
        empty_state: items.length ? null : { title: '还没有营销任务', message: '用一句话告诉我商品、平台和营销目标，就可以创建第一条任务。' },
        action_cards: items.length ? [{ method: 'task.resume', label: '继续最近任务', required_inputs: ['task_id'], confirmation: 'none' }] : [{ method: 'task.understand', label: '开始第一条任务', required_inputs: ['instruction', 'platform', 'account_id'], confirmation: 'interactive_confirmation' }],
      })
    }
    case 'task.resume': {
      const task = scopeTask(req, required(params, 'task_id'))
      return result(service.resumeTask(workspaceId, task.id))
    }
    case 'task.clone': {
      const source = scopeTask(req, required(params, 'task_id'))
      const targetProductId = typeof params.target_product_id === 'string' && params.target_product_id.trim() ? params.target_product_id.trim() : undefined
      const targetPlatform = typeof params.target_platform === 'string' && SUPPORTED_PLATFORMS.includes(params.target_platform as Platform) ? params.target_platform as Platform : undefined
      if (typeof params.target_platform === 'string' && !targetPlatform) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'target_platform 不是支持的平台', 400)
      if (targetPlatform && !targetProductId) throw new DomainError('TARGET_PRODUCT_REQUIRED', '跨平台复制必须指定目标商品 ID，以重新加载目标平台商品事实和规则', 400)
      const targetAccountId = typeof params.target_account_id === 'string' && params.target_account_id.trim() ? params.target_account_id.trim() : undefined
      const cloned = service.cloneTask(workspaceId, source.id, typeof params.request_text === 'string' ? params.request_text : undefined, { ...(targetProductId ? { productId: targetProductId } : {}), ...(targetPlatform ? { platform: targetPlatform } : {}), ...(targetAccountId ? { accountId: targetAccountId } : {}), ...(typeof params.region === 'string' && params.region.trim() ? { region: params.region.trim() } : {}) })
      await persistSnapshot(workspaceId, 'task', cloned, cloned as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, cloned.id, 'task.cloned', cloned.version, { task_id: cloned.id, source_task_id: source.id, source_platform: source.platform, target_platform: cloned.platform, target_product_id: cloned.productId, rule_reload_required: cloned.platform !== source.platform })
      return result({ task: cloned, sourceTaskId: source.id, copyMode: cloned.platform === source.platform ? 'same_platform_fresh_task' : 'cross_platform_fresh_task', ruleReloadRequired: cloned.platform !== source.platform, staleContentCopied: false, stalePromotionCopied: false })
    }
    case 'task.timeline': return result(await taskTimeline(workspaceId, required(params, 'task_id'), typeof params.limit === 'string' ? Number(params.limit) : 100))
    case 'feedback.list': {
      const task = scopeTask(req, required(params, 'task_id'))
      return result(service.listFeedback(workspaceId, task.id))
    }
    case 'feedback.submit': {
      const task = scopeTask(req, required(params, 'task_id'))
      const rating = required(params, 'rating')
      if (!['liked', 'neutral', 'needs_improvement'].includes(rating)) throw new DomainError('FEEDBACK_RATING_INVALID', '反馈评级无效', 400)
      const feedback = service.submitFeedback({
        workspaceId, taskId: task.id, rating: rating as 'liked' | 'neutral' | 'needs_improvement',
        ...(typeof params.content_version_id === 'string' ? { contentVersionId: params.content_version_id } : {}),
        ...(typeof params.reason === 'string' ? { reason: params.reason } : {}),
        ...(typeof params.comment === 'string' ? { comment: params.comment } : {}),
        actorId: requestActor(req, 'actor_demo'),
      })
      await persistSnapshot(workspaceId, 'feedback', feedback, feedback as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, feedback.id, 'task_feedback_submitted', feedback.revision, feedback as unknown as Record<string, unknown>)
      return result(feedback)
    }
    case 'platform.revoke': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const platform = required(params, 'platform') as Platform
      const accountId = required(params, 'account_id')
      const account = service.revokePlatformAccount(workspaceId, accountId, platform)
      await persistSnapshot(workspaceId, 'platform_account', account, account as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, account.id, 'platform_account.revoked', account.revision, { account_id: account.id, platform, remote_revoked: false })
      try {
        await connectorRuntime.connector(platform).revoke({ accountId: account.remoteAccountId, credentialRef: account.credentialRef })
      } catch (error) {
        throw new DomainError('PLATFORM_REVOKE_REMOTE_FAILED', error instanceof Error ? error.message : '平台远端凭证撤销失败，本地账号已停止使用', 503)
      }
      return result({ platform, accountId: account.id, state: account.tokenState, remoteRevoked: true })
    }
    case 'task.create': {
      const taskPlatform = required(params, 'platform') as Platform
      await requireEnabledPlatform(workspaceId, taskPlatform)
      const productId = required(params, 'product_id')
      const product = service.products.get(productId)
      const taskAccountId = resolveTaskAccountId(workspaceId, taskPlatform, typeof params.account_id === 'string' ? params.account_id : undefined) ?? (product?.workspaceId === workspaceId && product.platform === taskPlatform ? product.accountId : undefined)
      requireProductionTaskStore(taskPlatform, taskAccountId)
      if ((isProduction() || fixtureMode) && taskAccountId) service.getActivePlatformAccount(workspaceId, taskAccountId, taskPlatform)
      const task = service.createTask({ workspaceId, productId, platform: taskPlatform, ...(taskAccountId ? { accountId: taskAccountId } : {}), ...(typeof params.region === 'string' ? { region: params.region } : {}) })
      await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, task.id, 'task.created', task.version, task as unknown as Record<string, unknown>)
      const storeContext = task.accountId ? workspaceStoreDirectory(workspaceId, taskPlatform).find(store => store.accountId === task.accountId) : undefined
      return result({ ...task, task_id: task.id, product_id: task.productId, storeContext: storeContext ?? null, selectionSource: product?.accountId ? 'product_binding' : task.accountId ? 'explicit_request' : 'unbound' })
    }
    case 'task.answer': {
      const task = scopeTask(req, required(params, 'task_id'))
      const raw = required(params, 'answers_json')
      let answers: Record<string, string | number | boolean | string[]>
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('answers_json must be an object')
        answers = parsed as Record<string, string | number | boolean | string[]>
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'answers_json 必须是 JSON 对象', 400) }
      const answered = service.answerTask(workspaceId, task.id, answers, typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined)
      await persistSnapshot(workspaceId, 'task', answered, answered as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, task.id, 'task.answers_submitted', answered.version, { task_id: task.id, input_snapshot_id: answered.inputSnapshotId, answers: answered.answers, missing_questions: answered.missingQuestions })
      return result(answered)
    }
    case 'task.understand': return result(service.understandTaskRequest(workspaceId, required(params, 'request_text')))
    case 'task.request.create': {
      const requestText = required(params, 'request_text')
      const understanding = service.understandTaskRequest(workspaceId, requestText)
      requireProductionRequestStores(workspaceId, understanding)
      for (const platform of understanding.platformCandidates) await requireEnabledPlatform(workspaceId, platform)
      const idempotencyKey = (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) || header(req, 'idempotency-key')?.trim()
      const created = service.createTaskFromRequest({ workspaceId, requestText, ...(idempotencyKey ? { idempotencyKey } : {}) })
      if (!created.replayed) for (const task of created.tasks) {
        await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, task.id, 'task.created', task.version, { ...task, ...(created.taskGroupId ? { task_group_id: created.taskGroupId } : {}), source: 'natural_language_request' })
      }
      return result(created)
    }
    case 'task.sku.split': {
      const source = scopeTask(req, required(params, 'task_id'))
      const idempotencyKey = (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) || header(req, 'idempotency-key')?.trim()
      const split = service.splitTaskBySku({ workspaceId, taskId: source.id, ...(idempotencyKey ? { idempotencyKey } : {}) })
      if (!split.replayed) for (const task of split.tasks) {
        await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, task.id, 'task.created', task.version, { ...task, task_group_id: split.taskGroupId, source: 'sku_split' })
      }
      await persistEvent(workspaceId, split.sourceTaskId, 'task.sku_split', source.version, { source_task_id: split.sourceTaskId, task_group_id: split.taskGroupId, sku_ids: split.skuIds, replayed: split.replayed })
      return result(split)
    }
    case 'task.group.create': {
      let entries: Array<{ productId: string; platform: Platform; accountId?: string; region?: string; skuId?: string }>
      try {
        const parsed = JSON.parse(required(params, 'entries_json'))
        if (!Array.isArray(parsed)) throw new Error('entries_json must be an array')
        entries = parsed.map(entry => {
          if (!entry || typeof entry !== 'object' || typeof entry.product_id !== 'string' || !SUPPORTED_PLATFORMS.includes(String(entry.platform) as Platform)) throw new Error('invalid task group entry')
          const platform = entry.platform as Platform
          const product = service.products.get(entry.product_id)
          const accountId = resolveTaskAccountId(workspaceId, platform, typeof entry.account_id === 'string' ? entry.account_id : undefined) ?? (product?.workspaceId === workspaceId && product.platform === platform ? product.accountId : undefined)
          requireProductionTaskStore(platform, accountId)
          if ((isProduction() || fixtureMode) && accountId) service.getActivePlatformAccount(workspaceId, accountId, platform)
          return { productId: entry.product_id, platform, ...(accountId ? { accountId } : {}), ...(typeof entry.region === 'string' && entry.region.trim() ? { region: entry.region.trim() } : {}), ...(typeof entry.sku_id === 'string' && entry.sku_id.trim() ? { skuId: entry.sku_id.trim() } : {}) }
        })
      } catch (error) {
        // Preserve actionable business gates (for example an unbound or
        // revoked store). Only malformed JSON/entry shape is an invalid
        // request; collapsing all DomainErrors here hides the recovery step.
        if (error instanceof DomainError) throw error
        throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'entries_json 必须是有效的任务组数组', 400)
      }
      for (const entry of entries) await requireEnabledPlatform(workspaceId, entry.platform)
      const idempotencyKey = (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) || header(req, 'idempotency-key')?.trim()
      const group = service.createTaskGroup({ workspaceId, entries, ...(typeof params.request_text === 'string' ? { requestText: params.request_text } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) })
      if (!group.replayed) for (const task of group.tasks) {
        await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, task.id, 'task.created', task.version, { ...task, task_group_id: group.id })
      }
      return result(group)
    }
    case 'creative.directions': {
      const task = scopeTask(req, required(params, 'task_id'))
      return result(service.listCreativeDirections(workspaceId, task.id))
    }
    case 'creative.brief': {
      await requirePluginWalletAccess(workspaceId)
      const productId = required(params, 'product_id')
      const product = service.products.get(productId)
      if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
      if (!product.factsConfirmed) throw new DomainError('PRODUCT_FACTS_CONFIRMATION_REQUIRED', '请先确认商品、SKU、价格和图片事实，再生成创意 Brief', 409)
      service.assertBrandVisualGenerationReady(workspaceId, product.platform)
      const brief = creativeBrief(workspaceId, product, params)
      const briefDebitKey = `creative-brief:${brief.id}`
      const briefActor = requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant'
      await debitPluginWallet({ workspaceId, idempotencyKey: briefDebitKey, actorId: briefActor, description: '创意 Brief 生成调用' })
      try {
        await persistEvent(workspaceId, brief.id, 'creative.brief_created', brief.version, { brief_id: brief.id, product_id: product.id, asset_type: brief.assetType, platform: brief.platform, sku_ids: brief.skuIds })
      } catch (error) {
        await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: briefDebitKey, actorId: briefActor, reason: '创意 Brief 结果记录失败' })
        throw error
      }
      return result(brief)
    }
    case 'creative.preview': {
      await requirePluginWalletAccess(workspaceId)
      const productId = required(params, 'product_id')
      const product = service.products.get(productId)
      if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
      if (!product.factsConfirmed) throw new DomainError('PRODUCT_FACTS_CONFIRMATION_REQUIRED', '请先确认商品事实，再生成创意预览', 409)
      service.assertBrandVisualGenerationReady(workspaceId, product.platform)
      const preview = creativePreview(workspaceId, product, params)
      const previewDebitKey = `creative-preview:${preview.id}`
      const previewActor = requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant'
      await debitPluginWallet({ workspaceId, idempotencyKey: previewDebitKey, actorId: previewActor, description: '创意预览生成调用' })
      try {
        await persistEvent(workspaceId, preview.id, 'creative.preview_created', 1, { preview_id: preview.id, product_id: product.id, asset_type: preview.assetType, platform: preview.platform })
      } catch (error) {
        await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: previewDebitKey, actorId: previewActor, reason: '创意预览结果记录失败' })
        throw error
      }
      return result(preview)
    }
    case 'creative.directions.update': {
      const task = scopeTask(req, required(params, 'task_id'))
      let directionIds: string[] | undefined
      let changes: Record<string, string> | undefined
      try {
        if (typeof params.direction_ids_json === 'string') {
          const parsed = JSON.parse(params.direction_ids_json)
          if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error('invalid direction ids')
          directionIds = parsed
        }
        if (typeof params.changes_json === 'string') {
          const parsed = JSON.parse(params.changes_json)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid changes')
          changes = parsed as Record<string, string>
        }
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, '方向参数 JSON 无效', 400) }
      const updated = service.updateCreativeDirections({ workspaceId, taskId: task.id, action: required(params, 'action') as 'regenerate' | 'merge' | 'modify', ...(directionIds ? { directionIds } : {}), ...(typeof params.direction_id === 'string' ? { directionId: params.direction_id } : {}), ...(changes ? { changes } : {}), ...(typeof params.feedback === 'string' ? { feedback: params.feedback } : {}), ...(typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? { expectedVersion: Number(params.expected_version) } : {}) })
      await persistSnapshot(workspaceId, 'task', updated.task, updated.task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, updated.task.id, 'task.directions_updated', updated.task.version, { task_id: updated.task.id, action: params.action, direction_id: updated.newDirection?.id ?? null })
      return result(updated)
    }
    case 'task.select_direction': {
      const task = scopeTask(req, required(params, 'task_id'))
      const selected = service.selectDirection(task.id, required(params, 'direction_id'), typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined)
      await persistSnapshot(workspaceId, 'task', selected, selected as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, selected.id, 'task.direction_selected', selected.version, { task_id: selected.id, direction_id: selected.selectedDirectionId ?? null })
      return result({ ...selected, task_id: selected.id, expected_version: selected.version })
    }
    case 'task.plan.confirm': {
      const task = scopeTask(req, required(params, 'task_id'))
      const priceImpactConfirmed = params.price_impact_confirmed === true || params.price_impact_confirmed === 'true'
      const planProduct = service.products.get(task.productId)
      if (planProduct) await hydrateDurableRuleSnapshot(workspaceId, planProduct)
      const confirmed = service.confirmProductionPlan(workspaceId, task.id, requestActor(req, typeof params.actor_id === 'string' && params.actor_id.trim() ? params.actor_id.trim() : 'merchant'), typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined, priceImpactConfirmed)
      await persistSnapshot(workspaceId, 'task', confirmed, confirmed as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, confirmed.id, 'task.plan_confirmed', confirmed.version, { task_id: confirmed.id, plan_id: confirmed.productionPlan?.id ?? null, actor_id: confirmed.productionPlan?.confirmedBy ?? null })
      return result({ ...confirmed, task_id: confirmed.id, expected_version: confirmed.version })
    }
    case 'content.generate': {
      const task = scopeTask(req, required(params, 'task_id'))
      await requirePluginWalletAccess(workspaceId)
      await requireGenerationRulePreflight(workspaceId, task.productId)
      if (isProduction()) {
        requirePlatformModelCostGate('text')
        const idempotencyKey = header(req, 'idempotency-key')?.trim() || (typeof params.idempotency_key === 'string' ? params.idempotency_key.trim() : '')
        if (!idempotencyKey) throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, '生产内容生成必须携带 Idempotency-Key', 400)
        const product = service.products.get(task.productId)
        if (!product || product.workspaceId !== task.workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品快照不存在或不属于当前工作区', 404)
        let existing = [...service.generationJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === idempotencyKey)
        if (!existing) {
          await hydrateDurableIdempotentJob(workspaceId, 'generation_job', idempotencyKey)
          existing = [...service.generationJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === idempotencyKey)
        }
        const reservationId = `generation:${idempotencyKey}`
        const reserved = existing ? false : await reserveDistributedJobSlot(workspaceId, reservationId)
        const usageKey = `generation:${idempotencyKey}`
        const usage = await consumeTaskUsage(workspaceId, task.id, usageKey, requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant')
        try {
          const prepared = await service.prepareGenerationContext(task.id, `model:${usageKey}`)
          const job = service.enqueueGeneration({ workspaceId, taskId: task.id, idempotencyKey })
          await persistSnapshot(workspaceId, 'generation_job', job, job as unknown as Record<string, unknown>)
          if (job.state === 'queued' && job.revision === 1) await persistEvent(workspaceId, job.id, 'generation.requested', 1, { job_id: job.id, task_id: task.id, campaign_item_id: task.campaignItemId ?? null, platform: task.platform, direction_id: task.selectedDirectionId ?? 'default', action_id: `model:${usageKey}`, context_link_id: prepared.contextRef?.id ?? null, context_hash: prepared.contextRef?.contextHash ?? contextEnvelopeHash(prepared.input as unknown as Record<string, unknown>), input_tokens_estimate: prepared.inputTokensEstimate, max_input_tokens: prepared.maxInputTokens, input: prepared.input })
          return result(jobWithQueueMetadata(job, workspaceId, 'generation'))
        } catch (error) {
          if ((usage.charged || usage.walletDebited) && !existing) await refundTaskUsage(workspaceId, task.id, usageKey, requestPrincipals.get(req)?.actorId ?? 'merchant', '异步生成任务创建失败')
          if (reserved) await releaseDistributedJobSlot(workspaceId, reservationId)
          throw error
        }
      }
      const usageKey = `content.generate:${task.id}`
      const usage = await consumeTaskUsage(workspaceId, task.id, usageKey, requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant')
      let draft
      try { draft = await service.generateDraft(task.id, undefined, `model:${usageKey}`) } catch (error) { if ((usage.charged || usage.walletDebited) && !providerSucceededButSettlementPending(error)) await refundTaskUsage(workspaceId, task.id, usageKey, requestPrincipals.get(req)?.actorId ?? 'merchant', '内容生成失败'); throw error }
      await persistSnapshot(workspaceId, 'content_version', draft, draft as unknown as Record<string, unknown>)
      await persistSnapshot(workspaceId, 'task', service.getTask(task.id), service.getTask(task.id) as unknown as Record<string, unknown>)
      const execution = executionContract('content', Boolean(contentGenerator))
      const rulePreflight = service.reviewContentReport(workspaceId, draft.id, await evaluationRules(workspaceId, ruleContextForTask(task)))
      await persistEvent(workspaceId, draft.id, 'content.generated', draft.revision, { task_id: task.id, content_version_id: draft.id, version: draft.version, execution, rule_preflight: { blocking: rulePreflight.blocking, finding_count: rulePreflight.findings.length, rule_hits: rulePreflight.ruleHits ?? [] } })
      return result({ ...draft, execution, rule_preflight: rulePreflight })
    }
    case 'content.codex.prepare': {
      const task = scopeTask(req, required(params, 'task_id'))
      return result(service.prepareCodexDraft(task.id))
    }
    case 'content.codex.commit': {
      const task = scopeTask(req, required(params, 'task_id'))
      await requirePluginWalletAccess(workspaceId)
      let body: import('../../../packages/application/src/service.js').ContentVersion['body']
      try {
        const parsed = JSON.parse(required(params, 'body_json')) as Record<string, unknown>
        if (typeof parsed.title !== 'string' || typeof parsed.detail !== 'string' || !Array.isArray(parsed.sellingPoints) || !parsed.sellingPoints.every(value => typeof value === 'string')) throw new Error('content body schema invalid')
        body = { title: parsed.title, detail: parsed.detail, sellingPoints: parsed.sellingPoints as string[], ...(Array.isArray(parsed.modules) ? { modules: parsed.modules as import('../../../packages/ai/src/generator.js').ContentModule[] } : {}), ...(parsed.brief && typeof parsed.brief === 'object' && !Array.isArray(parsed.brief) ? { brief: parsed.brief as import('../../../packages/ai/src/generator.js').StaticBrief } : {}) }
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'body_json 必须包含合法的 title、detail、sellingPoints', 400) }
      const usageKey = `content.codex.commit:${task.id}:${typeof params.expected_version === 'string' ? params.expected_version : 'latest'}`
      const usage = await consumeTaskUsage(workspaceId, task.id, usageKey, requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant')
      let draft
      try { draft = service.commitCodexDraft({ taskId: task.id, body, ...(typeof params.reason === 'string' && params.reason.trim() ? { reason: params.reason.trim() } : {}) }) } catch (error) { if (usage.charged || usage.walletDebited) await refundTaskUsage(workspaceId, task.id, usageKey, requestPrincipals.get(req)?.actorId ?? 'merchant', 'Codex 内容提交失败'); throw error }
      await persistSnapshot(workspaceId, 'content_version', draft, draft as unknown as Record<string, unknown>)
      await persistSnapshot(workspaceId, 'task', service.getTask(task.id), service.getTask(task.id) as unknown as Record<string, unknown>)
      const rulePreflight = service.reviewContentReport(workspaceId, draft.id, await evaluationRules(workspaceId, ruleContextForTask(task)))
      await persistEvent(workspaceId, draft.id, 'content.generated', draft.revision, { task_id: task.id, content_version_id: draft.id, version: draft.version, generation_mode: 'codex_native', rule_preflight: { blocking: rulePreflight.blocking, finding_count: rulePreflight.findings.length, rule_hits: rulePreflight.ruleHits ?? [] } })
      return result({ ...draft, rule_preflight: rulePreflight })
    }
    case 'generation.get': {
      const job = service.getGenerationJob(workspaceId, required(params, 'job_id'))
      if (job.workspaceId !== workspaceId) throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '无权访问该生成任务', 403)
      return result(jobWithQueueMetadata(job, workspaceId, 'generation'))
    }
    case 'content.review': {
      const scoped = scopeContentVersion(req, required(params, 'content_version_id'))
      return result(service.reviewContentReport(workspaceId, scoped.version.id, await evaluationRules(workspaceId, ruleContextForTask(scoped.task))))
    }
    case 'content.review.decide': {
      const scoped = scopeContentVersion(req, required(params, 'content_version_id'))
      const status = required(params, 'status')
      if (!['acknowledged', 'waived'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'status 必须是 acknowledged 或 waived', 400)
      const decided = service.setReviewFindingDecision({ workspaceId, contentVersionId: scoped.version.id, code: required(params, 'code'), field: required(params, 'field'), status: status as 'acknowledged' | 'waived', ...(typeof params.reason === 'string' ? { reason: params.reason } : {}), actorId: requestActor(req), ...(typeof params.expected_revision === 'string' && /^\d+$/u.test(params.expected_revision) ? { expectedRevision: Number(params.expected_revision) } : {}) }, await evaluationRules(workspaceId, ruleContextForTask(scoped.task)))
      await persistSnapshot(workspaceId, 'content_version', decided.version, decided.version as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, decided.version.id, 'content.review_decided', decided.version.revision, { content_version_id: decided.version.id, finding_key: decided.decision.key, status: decided.decision.status, reason: decided.decision.reason, actor_id: decided.decision.actorId })
      return result(decided)
    }
    case 'content.versions': {
      const task = scopeTask(req, required(params, 'task_id'))
      return result(service.listContentVersions(workspaceId, task.id))
    }
    case 'content.diff': {
      const scoped = scopeContentVersion(req, required(params, 'content_version_id'))
      const against = typeof params.against_version_id === 'string' ? params.against_version_id : undefined
      return result(service.diffContentVersions(workspaceId, scoped.version.id, against))
    }
    case 'content.export': {
      const contentVersionId = typeof params.content_version_id === 'string' && params.content_version_id.trim() ? params.content_version_id.trim() : undefined
      const deliverableRef = typeof params.deliverable_ref === 'string' && params.deliverable_ref.trim() ? params.deliverable_ref.trim() : undefined
      if (Boolean(contentVersionId) === Boolean(deliverableRef)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '必须且只能指定 content_version_id 或 deliverable_ref 其中一个', 400)
      const scoped = contentVersionId ? scopeContentVersion(req, contentVersionId) : { version: service.resolveDeliverableReference(workspaceId, deliverableRef!) }
      const format = typeof params.format === 'string' ? params.format : 'bundle'
      if (!['manifest', 'json', 'markdown', 'bundle'].includes(format)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'format 必须是 manifest、json、markdown 或 bundle', 400)
      await persistExpiredDeliveryIfNeeded(workspaceId, scoped.version.id)
      const exported = service.exportContent(workspaceId, scoped.version.id, format as 'manifest' | 'json' | 'markdown' | 'bundle')
      const exportBytes = exported.binaryBody?.byteLength ?? Buffer.byteLength(exported.body, 'utf8')
      if (!exportBytes || exportBytes > MAX_MCP_EXPORT_BYTES) throw new DomainError('CONTENT_EXPORT_SIZE_LIMIT', '内容导出文件为空或超过 25MB 限制', 413)
      if (!exported.binaryBody) return result(exported)
      const { binaryBody, ...textExport } = exported
      return result({ ...textExport, binary_base64: Buffer.from(binaryBody).toString('base64') })
    }
    case 'content.approve': {
      const taskId = required(params, 'task_id')
      const task = scopeTask(req, taskId)
      const approved = service.approveContent(taskId, required(params, 'content_version_id'), await evaluationRules(workspaceId, ruleContextForTask(task)), typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined)
      await persistSnapshot(workspaceId, 'content_version', approved.version, approved.version as unknown as Record<string, unknown>)
      await persistSnapshot(workspaceId, 'task', approved.task, approved.task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, approved.version.id, 'content.approved', approved.version.revision, { task_id: approved.task.id, content_version_id: approved.version.id, version: approved.version.version })
      return result(approved)
    }
    case 'content.modify': {
      const scoped = scopeContentVersion(req, required(params, 'content_version_id'))
      let lockedFields: string[] | undefined
      if (typeof params.locked_fields_json === 'string') {
        try { const parsed = JSON.parse(params.locked_fields_json); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error('locked_fields_json must be array'); lockedFields = parsed } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'locked_fields_json 必须是字符串数组', 400) }
      }
      const expectedRevision = typeof params.expected_revision === 'string' && /^\d+$/u.test(params.expected_revision) ? Number(params.expected_revision) : undefined
      const modified = typeof params.module_key === 'string' && params.module_key.trim()
        ? service.regenerateContentModule({ workspaceId, sourceVersionId: scoped.version.id, moduleKey: params.module_key, ...(lockedFields ? { lockedFields } : {}), reason: required(params, 'reason'), ...(expectedRevision !== undefined ? { expectedRevision } : {}) })
        : (() => {
          let changes: Partial<import('../../../packages/application/src/service.js').ContentVersion['body']>
          try {
            const parsed = JSON.parse(required(params, 'changes_json'))
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('changes_json must be object')
            changes = parsed
          } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'changes_json 必须是 JSON 对象', 400) }
          return service.modifyContentVersion({ workspaceId, sourceVersionId: scoped.version.id, changes, ...(lockedFields ? { lockedFields } : {}), reason: required(params, 'reason'), ...(expectedRevision !== undefined ? { expectedRevision } : {}) })
        })()
      await persistSnapshot(workspaceId, 'content_version', modified.version, modified.version as unknown as Record<string, unknown>)
      await persistSnapshot(workspaceId, 'task', modified.task, modified.task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, modified.version.id, 'content.version_modified', modified.version.revision, { task_id: modified.task.id, source_version_id: modified.source.id, content_version_id: modified.version.id, reason: modified.version.versionVector?.reason, locked_fields: modified.version.lockedFields ?? [], ...(typeof params.module_key === 'string' && params.module_key.trim() ? { regenerated_module: params.module_key.trim() } : {}) })
      return result(modified)
    }
    case 'content.restore': {
      const scoped = scopeContentVersion(req, required(params, 'content_version_id'))
      const restored = service.restoreContentVersion(workspaceId, scoped.version.id, typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined)
      await persistSnapshot(workspaceId, 'content_version', restored.version, restored.version as unknown as Record<string, unknown>)
      await persistSnapshot(workspaceId, 'task', restored.task, restored.task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, restored.version.id, 'content.version_restored', restored.version.revision, { task_id: restored.task.id, source_version_id: restored.source.id, content_version_id: restored.version.id })
      return result(restored)
    }
    case 'publish.prepare': {
      const taskId = required(params, 'task_id')
      const task = scopeTask(req, taskId)
      await requireEnabledPlatform(workspaceId, task.platform)
      if ((isProduction() || fixtureMode) && !task.accountId) throw new DomainError('STORE_SELECTION_REQUIRED', '发布前必须明确选择商品所属店铺', 409)
      const currentRuleReview = await requireCurrentPublishReview(workspaceId, task)
      const preview = service.preparePublish(taskId)
      await persistSnapshot(workspaceId, 'task', preview.task, preview.task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, preview.task.id, 'publish.prepared', preview.task.version, { task_id: preview.task.id, content_version_id: preview.version.id, confirmation_hash: preview.confirmationHash, remote_snapshot_hash: preview.remoteSnapshotHash, payload_hash: preview.payloadHash, selection_hash: preview.selectionHash, selected_count: preview.visualPreview.count, image_mode: preview.visualPreview.imageMode })
      return result({ ...preview, currentRuleReview })
    }
    case 'publish.batch.prepare': {
      const rawTaskIds = required(params, 'task_ids_json')
      let taskIds: string[]
      try {
        const parsed = JSON.parse(rawTaskIds)
        if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50 || parsed.some(item => typeof item !== 'string' || !item.trim()) || new Set(parsed).size !== parsed.length) throw new Error('invalid')
        taskIds = parsed.map(item => String(item).trim())
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'task_ids_json 必须是 1 至 50 个不重复任务 ID 的 JSON 数组', 400) }
      const taskRefs: Array<{ task: ReturnType<typeof service.getTask>; before: ReturnType<typeof structuredClone> }> = []
      const batchId = 'batch_' + randomUUID()
      for (const taskId of taskIds) {
        const task = scopeTask(req, taskId)
        await enforceTaskBrandAccess(req, task, 'publisher')
        await requireEnabledPlatform(workspaceId, task.platform)
        if ((isProduction() || fixtureMode) && !task.accountId) throw new DomainError('STORE_SELECTION_REQUIRED', `任务 ${taskId} 未绑定店铺`, 409)
        await requireCurrentPublishReview(workspaceId, task)
        taskRefs.push({ task, before: structuredClone(task) })
      }
      let previews: Array<ReturnType<typeof service.preparePublish>>
      try {
        previews = taskRefs.map(({ task }) => service.preparePublish(task.id))
      } catch (error) {
        // preparePublish updates only the task pointer/state. Restore every
        // task before returning so a failed batch leaves no partial prepared
        // children in memory or in the next persistence transaction.
        for (const { task, before } of taskRefs) {
          for (const key of Object.keys(task)) delete (task as unknown as Record<string, unknown>)[key]
          Object.assign(task, before)
        }
        throw error
      }
      for (const preview of previews) {
        await persistSnapshot(workspaceId, 'task', preview.task, preview.task as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, preview.task.id, 'publish.prepared', preview.task.version, { task_id: preview.task.id, content_version_id: preview.version.id, confirmation_hash: preview.confirmationHash, remote_snapshot_hash: preview.remoteSnapshotHash, payload_hash: preview.payloadHash, selection_hash: preview.selectionHash, selected_count: preview.visualPreview.count, image_mode: preview.visualPreview.imageMode, batch: true })
      }
      const timestamp = new Date().toISOString()
      const batch: PublishBatch = {
        id: batchId,
        workspaceId,
        state: 'prepared',
        items: previews.map(preview => ({ taskId: preview.task.id, platform: preview.task.platform, ...(preview.task.accountId ? { accountId: preview.task.accountId } : {}), contentVersionId: preview.version.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, state: 'prepared' as const })),
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 1,
      }
      publishBatches.set(batch.id, batch)
      await persistSnapshot(workspaceId, 'publish_batch', batch, batch as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, batch.id, 'publish.batch.prepared', batch.revision, { batch_id: batch.id, item_count: batch.items.length })
      persistedPublishBatches.set(batch.id, structuredClone(batch))
      return result({ isBatch: true, batchId, batch, count: previews.length, items: previews, confirmationRequiredPerItem: true, executionMode: 'confirm_each_item' })
    }
    case 'publish.batch.confirm': {
      await requirePluginWalletAccess(workspaceId)
      const requestedBatchId = required(params, 'batch_id')
      let batch = publishBatches.get(requestedBatchId)
      if (!batch || batch.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该批量发布批次', 403)
      if (batch?.state === 'paused') throw new DomainError('PUBLISH_BATCH_PAUSED', '该批次已暂停，请先恢复后再确认或重试', 409)
      let confirmations: Array<Record<string, unknown>>
      try {
        const parsed = JSON.parse(required(params, 'confirmations_json'))
        if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50 || parsed.some(item => !item || typeof item !== 'object')) throw new Error('invalid')
        confirmations = parsed as Array<Record<string, unknown>>
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'confirmations_json 必须是 1 至 50 个确认对象的 JSON 数组', 400) }
      const items: Array<Record<string, unknown>> = []
      for (const confirmation of confirmations) {
        const taskId = typeof confirmation.task_id === 'string' ? confirmation.task_id.trim() : ''
        const itemKey = typeof confirmation.idempotency_key === 'string' ? confirmation.idempotency_key.trim() : ''
        try {
          if (!taskId || !itemKey) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '每个批量发布项都必须有 task_id 和 idempotency_key', 400)
          const task = scopeTask(req, taskId)
          await enforceTaskBrandAccess(req, task, 'publisher')
          await requireEnabledPlatform(workspaceId, task.platform)
          if (batch) {
            const batchItem = batch.items.find(item => item.taskId === taskId)
            if (!batchItem) throw new DomainError('PUBLISH_BATCH_ITEM_NOT_FOUND', `任务 ${taskId} 不属于该批次`, 400)
            if (['published', 'submitted', 'queued'].includes(batchItem.state)) throw new DomainError('PUBLISH_BATCH_ITEM_ALREADY_QUEUED', `任务 ${taskId} 已经排队`, 409)
          }
          const contentVersionId = typeof confirmation.content_version_id === 'string' ? confirmation.content_version_id : ''
          const confirmationHash = typeof confirmation.confirmation_hash === 'string' ? confirmation.confirmation_hash : ''
          const remoteSnapshotHash = typeof confirmation.remote_snapshot_hash === 'string' ? confirmation.remote_snapshot_hash : ''
          if (!contentVersionId || !confirmationHash || !remoteSnapshotHash) throw new DomainError(ERROR_CODES.CONFIRMATION_REQUIRED, `任务 ${taskId} 缺少新鲜确认哈希`, 400)
          const accountId = resolveTaskPublishAccount(task, typeof confirmation.account_id === 'string' ? confirmation.account_id : undefined)
          if ((isProduction() || fixtureMode) && !accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', `任务 ${taskId} 未绑定店铺`, 400)
          if (isProduction() || fixtureMode) service.getActivePlatformAccount(workspaceId, accountId!, task.platform)
          if (!task.contentVersionId || task.contentVersionId !== contentVersionId) throw new DomainError(ERROR_CODES.CONFIRMATION_REQUIRED, `任务 ${taskId} 内容版本已变化`, 400)
          assertPublishIdempotency(workspaceId, { taskId, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: itemKey })
          let existing = [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === itemKey)
          if (!existing) await hydrateDurableIdempotentJob(workspaceId, 'publish_job', itemKey)
          existing = existing ?? [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === itemKey)
          const reservationId = `publish:${itemKey}`
          let reserved = false
          let walletDebited = false
          try {
            if (!existing) {
              await debitPluginWallet({ workspaceId, idempotencyKey: reservationId, actorId: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant', description: '批量商品发布调用' })
              walletDebited = true
            }
            reserved = existing ? false : await reserveDistributedJobSlot(workspaceId, reservationId)
            const job = service.confirmPublish({ workspaceId, taskId, batchId: batch.id, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: itemKey, ...(accountId ? { accountId } : {}), mediaAdapterReady: connectorRuntime.mediaUploadReady(task.platform) })
            await persistPublishJobWithBatch({ batch, task, job, itemState: 'queued' })
            scheduleFixturePublishObservation(job)
            items.push({ task_id: taskId, state: 'queued', job: jobWithQueueMetadata(job, workspaceId, 'publish') })
          } catch (error) {
            if (reserved) await releaseDistributedJobSlot(workspaceId, reservationId)
            if (walletDebited) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: reservationId, actorId: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant', reason: '批量商品发布任务创建失败' })
            throw error
          }
        } catch (error) {
          if (!batch && taskId) batch = { id: `batch_${randomUUID()}`, workspaceId, state: 'prepared', items: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 0 }
          if (batch && taskId) {
            const batchItem = batch.items.find(item => item.taskId === taskId)
            if (batchItem) Object.assign(batchItem, { state: 'failed' as const, error: error instanceof DomainError ? { code: error.code, message: error.message } : { code: 'BATCH_ITEM_FAILED', message: error instanceof Error ? error.message : '批量项目失败' } })
          }
          items.push({ task_id: taskId || null, state: 'failed', error: error instanceof DomainError ? { code: error.code, message: error.message } : { code: 'BATCH_ITEM_FAILED', message: error instanceof Error ? error.message : '批量项目失败' } })
        }
      }
      if (!batch) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '批量确认未产生有效项目', 400)
      batch.state = batchStateFromItems(batch.items)
      await savePublishBatch(batch, 'publish.batch.confirmed')
      return result({ batch: true, batchId: batch.id, batchState: batch.state, count: items.length, succeeded: items.filter(item => item.state === 'queued').length, failed: items.filter(item => item.state === 'failed').length, items, atomic: false, retryFailedItems: true })
    }
    case 'publish.batch.get': {
      const batch = publishBatches.get(required(params, 'batch_id'))
      if (!batch || batch.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该批量发布批次', 403)
      await refreshPublishBatch(batch)
      return result(batch)
    }
    case 'publish.batch.pause': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      const batch = publishBatches.get(required(params, 'batch_id'))
      if (!batch || batch.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该批量发布批次', 403)
      if (['completed', 'failed'].includes(batch.state)) throw new DomainError('PUBLISH_BATCH_TERMINAL', '终态批次不能暂停', 409)
      const reason = required(params, 'reason')
      batch.state = 'paused'
      batch.pauseReason = reason
      for (const item of batch.items) if (item.state === 'prepared' || item.state === 'failed') item.state = 'paused'
      await savePublishBatch(batch, 'publish.batch.paused')
      await recordOperationAudit({ workspaceId, actorId, action: 'publish.batch.pause', resourceType: 'publish_batch', resourceId: batch.id, before: { state: 'active' }, after: { state: batch.state, pauseReason: reason, revision: batch.revision }, reason })
      return result({ ...batch, alreadyQueuedContinue: batch.items.some(item => item.state === 'queued' || item.state === 'submitted') })
    }
    case 'publish.batch.resume': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      const batch = publishBatches.get(required(params, 'batch_id'))
      if (!batch || batch.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该批量发布批次', 403)
      if (batch.state !== 'paused') return result(batch)
      const previousState = batch.state
      for (const item of batch.items) if (item.state === 'paused') item.state = 'failed'
      batch.pauseReason = undefined
      batch.state = batchStateFromItems(batch.items)
      await savePublishBatch(batch, 'publish.batch.resumed')
      await recordOperationAudit({ workspaceId, actorId, action: 'publish.batch.resume', resourceType: 'publish_batch', resourceId: batch.id, before: { state: previousState }, after: { state: batch.state, revision: batch.revision }, reason: '运营台恢复批量发布' })
      return result(batch)
    }
    case 'publish.batch.retry_failed': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      await requirePluginWalletAccess(workspaceId)
      const batch = publishBatches.get(required(params, 'batch_id'))
      if (!batch || batch.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该批量发布批次', 403)
      if (batch.state === 'paused') throw new DomainError('PUBLISH_BATCH_PAUSED', '该批次已暂停，请先恢复后再重试', 409)
      let confirmations: Array<Record<string, unknown>>
      try {
        const parsed = JSON.parse(required(params, 'confirmations_json'))
        if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50 || parsed.some(item => !item || typeof item !== 'object')) throw new Error('invalid')
        confirmations = parsed as Array<Record<string, unknown>>
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'confirmations_json 必须是 1 至 50 个确认对象的 JSON 数组', 400) }
      const failedTaskIds = new Set(batch.items.filter(item => item.state === 'failed' || item.state === 'rejected' || item.state === 'unknown').map(item => item.taskId))
      const submittedTaskIds = confirmations.filter(item => typeof item.task_id === 'string').map(item => String(item.task_id))
      const invalid = submittedTaskIds.filter(taskId => !failedTaskIds.has(taskId))
      if (invalid.length) throw new DomainError('PUBLISH_BATCH_RETRY_SCOPE_INVALID', `只能重试失败项: ${invalid.join(', ')}`, 400)
      const items: Array<Record<string, unknown>> = []
      for (const confirmation of confirmations) {
        const taskId = typeof confirmation.task_id === 'string' ? confirmation.task_id.trim() : ''
        const itemKey = typeof confirmation.idempotency_key === 'string' ? confirmation.idempotency_key.trim() : ''
        try {
          if (!taskId || !itemKey) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '每个重试项都必须有 task_id 和新的 idempotency_key', 400)
          const task = scopeTask(req, taskId)
          await enforceTaskBrandAccess(req, task, 'publisher')
          const batchItem = batch.items.find(item => item.taskId === taskId)
          if (!batchItem || !failedTaskIds.has(taskId)) throw new DomainError('PUBLISH_BATCH_RETRY_SCOPE_INVALID', `任务 ${taskId} 不是失败项`, 400)
          const contentVersionId = typeof confirmation.content_version_id === 'string' ? confirmation.content_version_id : ''
          const confirmationHash = typeof confirmation.confirmation_hash === 'string' ? confirmation.confirmation_hash : ''
          const remoteSnapshotHash = typeof confirmation.remote_snapshot_hash === 'string' ? confirmation.remote_snapshot_hash : ''
          if (!contentVersionId || !confirmationHash || !remoteSnapshotHash) throw new DomainError(ERROR_CODES.CONFIRMATION_REQUIRED, `任务 ${taskId} 缺少新的确认哈希`, 400)
          const accountId = resolveTaskPublishAccount(task, typeof confirmation.account_id === 'string' ? confirmation.account_id : undefined)
          await requireEnabledPlatform(workspaceId, task.platform)
          if ((isProduction() || fixtureMode) && !accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', `任务 ${taskId} 未绑定店铺`, 400)
          if (isProduction() || fixtureMode) service.getActivePlatformAccount(workspaceId, accountId!, task.platform)
          if (!task.contentVersionId || task.contentVersionId !== contentVersionId) throw new DomainError(ERROR_CODES.CONFIRMATION_REQUIRED, `任务 ${taskId} 内容版本已变化`, 400)
          assertPublishIdempotency(workspaceId, { taskId, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: itemKey })
          let existing = [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === itemKey)
          if (!existing) await hydrateDurableIdempotentJob(workspaceId, 'publish_job', itemKey)
          existing = existing ?? [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === itemKey)
          const reservationId = `publish:${itemKey}`
          let reserved = false
          let walletDebited = false
          try {
            if (!existing) {
              await debitPluginWallet({ workspaceId, idempotencyKey: reservationId, actorId: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant', description: '批量失败项重试发布调用' })
              walletDebited = true
            }
            reserved = existing ? false : await reserveDistributedJobSlot(workspaceId, reservationId)
            const job = service.confirmPublish({ workspaceId, taskId, batchId: batch.id, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: itemKey, ...(accountId ? { accountId } : {}), mediaAdapterReady: connectorRuntime.mediaUploadReady(task.platform) })
            await persistPublishJobWithBatch({ batch, task, job, itemState: 'queued' })
            scheduleFixturePublishObservation(job)
            items.push({ task_id: taskId, state: 'queued', job: jobWithQueueMetadata(job, workspaceId, 'publish') })
          } catch (error) {
            if (reserved) await releaseDistributedJobSlot(workspaceId, reservationId)
            if (walletDebited) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: reservationId, actorId: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant', reason: '批量失败项重试任务创建失败' })
            throw error
          }
        } catch (error) {
          const failure = error instanceof DomainError ? { code: error.code, message: error.message } : { code: 'BATCH_RETRY_FAILED', message: error instanceof Error ? error.message : '批量重试失败' }
          const batchItem = batch.items.find(item => item.taskId === taskId)
          if (batchItem) Object.assign(batchItem, { state: 'failed' as const, error: failure })
          items.push({ task_id: taskId || null, state: 'failed', error: failure })
        }
      }
      batch.state = batchStateFromItems(batch.items)
      await savePublishBatch(batch, 'publish.batch.retried')
      await recordOperationAudit({ workspaceId, actorId, action: 'publish.batch.retry_failed', resourceType: 'publish_batch', resourceId: batch.id, before: { state: 'failed_or_partial' }, after: { state: batch.state, succeeded: items.filter(item => item.state === 'queued').length, failed: items.filter(item => item.state === 'failed').length, revision: batch.revision }, reason: '运营台重试批量发布失败项' })
      return result({ batch: true, batchId: batch.id, batchState: batch.state, count: items.length, succeeded: items.filter(item => item.state === 'queued').length, failed: items.filter(item => item.state === 'failed').length, items, retry: true, atomic: false })
    }
    case 'publish.confirm': {
      await requirePluginWalletAccess(workspaceId)
      const key = header(req, 'idempotency-key')?.trim()
      if (!key) throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, '发布确认必须携带 Idempotency-Key', 400)
      const taskId = required(params, 'task_id')
      const task = scopeTask(req, taskId)
      await requireEnabledPlatform(workspaceId, task.platform)
      const contentVersionId = required(params, 'content_version_id')
      const confirmationHash = required(params, 'confirmation_hash')
      const remoteSnapshotHash = required(params, 'remote_snapshot_hash')
      if (!task.contentVersionId || task.contentVersionId !== contentVersionId) throw new DomainError(ERROR_CODES.CONFIRMATION_REQUIRED, '缺少有效的一次性发布确认 token', 400)
      if (isProduction() && !((typeof params.account_id === 'string' && params.account_id.trim()) || task.accountId)) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产发布必须绑定已授权平台账号', 400)
      const publishAccountId = resolveTaskPublishAccount(task, typeof params.account_id === 'string' ? params.account_id : undefined)
      if (isProduction() || fixtureMode) service.getActivePlatformAccount(workspaceId, publishAccountId!, task.platform)
      assertPublishIdempotency(workspaceId, { taskId, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: key })
      let existing = [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === key)
      if (!existing) {
        await hydrateDurableIdempotentJob(workspaceId, 'publish_job', key)
        existing = [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === key)
      }
      const reservationId = `publish:${key}`
      let reserved = false
      let walletDebited = false
      try {
        if (!existing) {
          await debitPluginWallet({ workspaceId, idempotencyKey: reservationId, actorId: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant', description: '商品发布调用' })
          walletDebited = true
        }
        reserved = existing ? false : await reserveDistributedJobSlot(workspaceId, reservationId)
        const job = service.confirmPublish({ workspaceId, taskId, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: key, ...(publishAccountId ? { accountId: publishAccountId } : {}), mediaAdapterReady: connectorRuntime.mediaUploadReady(task.platform) })
        await persistSnapshotsAndEvent({ workspaceId, snapshots: [
          { entityType: 'task', entityId: task.id, entityVersion: task.version, payload: task as unknown as Record<string, unknown> },
          { entityType: 'publish_job', entityId: job.id, entityVersion: job.revision, payload: job as unknown as Record<string, unknown> },
        ], aggregateId: job.id, eventType: 'publish.requested', sequence: 1, eventPayload: publishEventPayload(job) })
        scheduleFixturePublishObservation(job)
        return result(jobWithQueueMetadata(job, workspaceId, 'publish'))
      } catch (error) {
        if (reserved) await releaseDistributedJobSlot(workspaceId, reservationId)
        if (walletDebited) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: reservationId, actorId: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant', reason: '商品发布任务创建失败' })
        throw error
      }
    }
    case 'publish.get': {
      const job = service.getPublishJob(required(params, 'publish_job_id'))
      if (job.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该发布任务', 403)
      return result(jobWithQueueMetadata(job, workspaceId, 'publish'))
    }
    case 'automation.policy.get': {
      const platform = typeof params.platform === 'string' ? params.platform as Platform : undefined
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      validateAutomationScope(workspaceId, platform, accountId)
      const key = automationPolicyKey(workspaceId, platform, accountId)
      const policy = automationPolicies.get(key) ?? { workspaceId, id: `automation_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`, ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}), enabled: false, mode: 'scan_alert_manual_retry' as const, syncEnabled: false, frequencyMinutes: 60, retryLimit: 2, revision: 1, updatedAt: new Date().toISOString(), pauseReason: '默认关闭，需商家明确开启' }
      return result({ policy, unattendedAutoResubmit: false, humanConfirmationRequired: true })
    }
    case 'automation.policy.list': {
      const policies = [...automationPolicies.values()]
        .filter(policy => policy.workspaceId === workspaceId)
        .sort((left, right) => `${left.platform ?? ''}:${left.accountId ?? ''}`.localeCompare(`${right.platform ?? ''}:${right.accountId ?? ''}`))
      const stores = new Map(workspaceStoreDirectory(workspaceId).map(store => [`${store.platform}:${store.accountId}`, store]))
      return result({
        policies: policies.map(policy => ({
          ...policy,
          store: policy.platform && policy.accountId ? stores.get(`${policy.platform}:${policy.accountId}`) ?? null : null,
          unattendedAutoResubmit: false,
          humanConfirmationRequired: true,
        })),
        count: policies.length,
        unattendedAutoResubmit: false,
        humanConfirmationRequired: true,
      })
    }
    case 'automation.policy.update': {
      const platform = typeof params.platform === 'string' ? params.platform as Platform : undefined
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      validateAutomationScope(workspaceId, platform, accountId)
      const key = automationPolicyKey(workspaceId, platform, accountId)
      const previous = automationPolicies.get(key)
      const enabled = required(params, 'enabled') === 'true'
      const frequencyMinutes = typeof params.frequency_minutes === 'string' && /^\d+$/u.test(params.frequency_minutes) ? Math.min(1440, Math.max(5, Number(params.frequency_minutes))) : previous?.frequencyMinutes ?? 60
      const retryLimit = typeof params.retry_limit === 'string' && /^\d+$/u.test(params.retry_limit) ? Math.min(5, Math.max(0, Number(params.retry_limit))) : previous?.retryLimit ?? 2
      const syncEnabled = params.sync_enabled === 'true' ? true : params.sync_enabled === 'false' ? false : previous?.syncEnabled ?? false
      if (syncEnabled && (!platform || !accountId)) throw new DomainError('AUTOMATION_SYNC_SCOPE_REQUIRED', '自动同步必须绑定一个明确的平台店铺，不能对工作区内所有店铺隐式执行', 400)
      const clearWindow = params.clear_window === 'true'
      const hasWindowStart = Object.prototype.hasOwnProperty.call(params, 'window_start')
      const hasWindowEnd = Object.prototype.hasOwnProperty.call(params, 'window_end')
      const windowStart = clearWindow ? undefined : hasWindowStart
        ? (typeof params.window_start === 'string' && params.window_start.trim() ? normalizeAutomationTime(params.window_start, 'window_start') : undefined)
        : previous?.windowStart
      const windowEnd = clearWindow ? undefined : hasWindowEnd
        ? (typeof params.window_end === 'string' && params.window_end.trim() ? normalizeAutomationTime(params.window_end, 'window_end') : undefined)
        : previous?.windowEnd
      if (Boolean(windowStart) !== Boolean(windowEnd)) throw new DomainError('AUTOMATION_WINDOW_INVALID', 'window_start 和 window_end 必须同时提供', 400)
      const actorId = requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant'
      if (requiresStrictAuth()) requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      const policy: AutomationPolicy = { workspaceId, id: previous?.id ?? `automation_${randomUUID()}`, ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}), enabled, mode: syncEnabled ? 'scan_sync_alert_manual_retry' : 'scan_alert_manual_retry', syncEnabled, frequencyMinutes, retryLimit, ...(windowStart ? { windowStart } : {}), ...(windowEnd ? { windowEnd } : {}), ...(previous?.lastRunAt ? { lastRunAt: previous.lastRunAt } : {}), ...(enabled ? { nextRunAt: previous?.nextRunAt ?? new Date().toISOString() } : { pauseReason: required(params, 'reason') }), revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }
      await saveAutomationPolicy(policy)
      await recordOperationAudit({ workspaceId, actorId, action: 'automation.policy.update', resourceType: 'automation_policy', resourceId: policy.id, before: previous ?? {}, after: policy as unknown as Record<string, unknown>, reason: required(params, 'reason') })
      return result({ policy, unattendedAutoResubmit: false, humanConfirmationRequired: true })
    }
    case 'automation.scan': {
      const platform = typeof params.platform === 'string' ? params.platform as Platform : undefined
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      validateAutomationScope(workspaceId, platform, accountId)
      return result(await executeAutomationScan(workspaceId, platform, accountId))
    }
    case 'automation.tick': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      return result(await runAutomationTick(workspaceId, req, actorId))
    }
    case 'automation.pause': {
      const reason = required(params, 'reason')
      const platform = typeof params.platform === 'string' ? params.platform as Platform : undefined
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      validateAutomationScope(workspaceId, platform, accountId)
      const actorId = requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant'
      if (requiresStrictAuth()) requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      const key = automationPolicyKey(workspaceId, platform, accountId)
      const previous = automationPolicies.get(key)
      const policy: AutomationPolicy = { workspaceId, id: previous?.id ?? `automation_${randomUUID()}`, ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}), enabled: false, mode: previous?.mode ?? 'scan_alert_manual_retry', syncEnabled: previous?.syncEnabled ?? false, frequencyMinutes: previous?.frequencyMinutes ?? 60, retryLimit: previous?.retryLimit ?? 2, ...(previous?.windowStart ? { windowStart: previous.windowStart } : {}), ...(previous?.windowEnd ? { windowEnd: previous.windowEnd } : {}), pauseReason: reason, revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }
      await saveAutomationPolicy(policy, 'automation.policy.paused')
      await recordOperationAudit({ workspaceId, actorId, action: 'automation.policy.pause', resourceType: 'automation_policy', resourceId: policy.id, before: previous ?? {}, after: policy as unknown as Record<string, unknown>, reason })
      return result({ policy, paused: true, reason, unattendedAutoResubmit: false })
    }
    case 'knowledge.rule.create': {
      try {
        const actorId = requireRuleAdmin(req).actorId
        const target = Object.fromEntries(['platform', 'category', 'brand', 'store', 'campaign'].filter(key => typeof params[key] === 'string' && String(params[key]).trim()).map(key => [key, String(params[key]).trim()]))
        const rule = knowledge.createRule({
          workspaceId, name: required(params, 'name'), content: required(params, 'content'), scope: required(params, 'scope') as import('../../../packages/knowledge/src/index.js').RuleScope,
          ...(typeof params.scope_value === 'string' ? { scopeValue: params.scope_value } : {}), target,
          source: { kind: required(params, 'source_kind') as import('../../../packages/knowledge/src/index.js').RuleSourceKind, reference: required(params, 'source_reference'), checkedAt: required(params, 'source_checked_at') },
          version: required(params, 'version'), status: required(params, 'status') as import('../../../packages/knowledge/src/index.js').RuleStatus,
          ...(typeof params.severity === 'string' ? { severity: params.severity as import('../../../packages/knowledge/src/index.js').RuleSeverity } : {}), ...(typeof params.action === 'string' ? { action: params.action as import('../../../packages/knowledge/src/index.js').RuleAction } : {}), ...(typeof params.owner_id === 'string' ? { ownerId: params.owner_id } : {}),
          ...(typeof params.effective_from === 'string' ? { effectiveFrom: params.effective_from } : {}), ...(typeof params.effective_to === 'string' ? { effectiveTo: params.effective_to } : {}),
          ...(typeof params.tags_json === 'string' ? { tags: JSON.parse(params.tags_json) as string[] } : {}),
        })
        await persistEvent(workspaceId, rule.id, 'knowledge.rule.created', rule.revision, rule as unknown as Record<string, unknown>)
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.rule.create', resourceType: 'knowledge_rule', resourceId: rule.id, before: {}, after: rule as unknown as Record<string, unknown>, reason: '运营知识规则创建' })
        return result(rule)
      } catch (error) {
        if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400)
        throw error
      }
    }
    case 'knowledge.rule.list': {
      try {
        requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'platform_ops', 'rules_admin'])
        return result(knowledge.queryRules({
          workspaceId,
          ...(typeof params.scope === 'string' ? { scope: params.scope as import('../../../packages/knowledge/src/index.js').RuleScope } : {}),
          ...(typeof params.scope_value === 'string' ? { scopeValue: params.scope_value } : {}), ...(typeof params.status === 'string' ? { status: params.status as import('../../../packages/knowledge/src/index.js').RuleStatus } : {}),
          ...(typeof params.as_of === 'string' ? { asOf: params.as_of } : {}), ...(typeof params.platform === 'string' ? { platform: params.platform } : {}), ...(typeof params.category === 'string' ? { category: params.category } : {}), ...(typeof params.brand === 'string' ? { brand: params.brand } : {}), ...(typeof params.store === 'string' ? { store: params.store } : {}), ...(typeof params.campaign === 'string' ? { campaign: params.campaign } : {}), ...(typeof params.text === 'string' ? { text: params.text } : {}),
        }))
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.asset.create': {
      try {
        const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops', 'knowledge_editor'])
        const content = JSON.parse(required(params, 'content_json')) as string | Record<string, unknown>
        const asset = knowledge.createAsset({ workspaceId, kind: required(params, 'kind') as 'brand' | 'customer', name: required(params, 'name'), content, ...(typeof params.source === 'string' ? { source: params.source } : {}), ...(typeof params.tags_json === 'string' ? { tags: JSON.parse(params.tags_json) as string[] } : {}), ...(typeof params.approval_status === 'string' ? { approvalStatus: params.approval_status as import('../../../packages/knowledge/src/index.js').AssetApprovalStatus } : {}), ...(typeof params.rights_status === 'string' ? { rightsStatus: params.rights_status as import('../../../packages/knowledge/src/index.js').AssetRightsStatus } : {}) })
        await persistEvent(workspaceId, asset.id, 'knowledge.asset.created', asset.revision, asset as unknown as Record<string, unknown>)
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.asset.create', resourceType: 'knowledge_asset', resourceId: asset.id, before: {}, after: asset as unknown as Record<string, unknown>, reason: '运营知识资产录入' })
        return result(asset)
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.asset.update': {
      try {
        const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops', 'knowledge_editor'])
        const assetId = required(params, 'asset_id')
        let content: string | Record<string, unknown> | undefined
        if (typeof params.content_json === 'string') content = JSON.parse(params.content_json) as string | Record<string, unknown>
        const updated = knowledge.updateAsset(workspaceId, assetId, {
          ...(typeof params.name === 'string' ? { name: params.name } : {}), ...(content !== undefined ? { content } : {}), ...(typeof params.source === 'string' ? { source: params.source } : {}),
          ...(typeof params.approval_status === 'string' ? { approvalStatus: params.approval_status as import('../../../packages/knowledge/src/index.js').AssetApprovalStatus } : {}), ...(typeof params.rights_status === 'string' ? { rightsStatus: params.rights_status as import('../../../packages/knowledge/src/index.js').AssetRightsStatus } : {}),
          ...(typeof params.tags_json === 'string' ? { tags: JSON.parse(params.tags_json) as string[] } : {}),
        })
        await persistEvent(workspaceId, updated.id, 'knowledge.asset.updated', updated.revision, updated as unknown as Record<string, unknown>)
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.asset.update', resourceType: 'knowledge_asset', resourceId: updated.id, before: {}, after: updated as unknown as Record<string, unknown>, reason: '运营知识资产审批/权益调整' })
        return result(updated)
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.asset.list': {
      try {
        requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'platform_ops', 'knowledge_reader'])
        let tags: string[] | undefined
        if (typeof params.tags_json === 'string') tags = JSON.parse(params.tags_json) as string[]
        return result(knowledge.queryAssets({ workspaceId, ...(typeof params.kind === 'string' ? { kind: params.kind as 'brand' | 'customer' } : {}), ...(typeof params.text === 'string' ? { text: params.text } : {}), ...(tags ? { tags } : {}) }))
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.feedback.record': {
      try {
        const feedback = knowledge.recordFeedback({ workspaceId, kind: required(params, 'kind') as 'feedback' | 'platform_rejection', ...(typeof params.platform === 'string' ? { platform: params.platform } : {}), ...(typeof params.content_id === 'string' ? { contentId: params.content_id } : {}), reason: required(params, 'reason'), ...(typeof params.details === 'string' ? { details: params.details } : {}), ...(typeof params.metadata_json === 'string' ? { metadata: JSON.parse(params.metadata_json) as Record<string, string> } : {}) })
        await persistEvent(workspaceId, feedback.id, 'knowledge.feedback.recorded', 1, feedback as unknown as Record<string, unknown>)
        return result({ feedback, suggestions: knowledge.listLearningSuggestions(workspaceId).filter(item => item.feedbackId === feedback.id) })
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.learning.list': {
      try { requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'platform_ops', 'knowledge_reader']); return result(knowledge.listLearningSuggestions(workspaceId, typeof params.status === 'string' ? params.status as 'pending' | 'confirmed' | 'dismissed' : undefined)) }
      catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.learning.confirm': {
      try {
        const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops', 'rules_admin', 'knowledge_editor'])
        const suggestion = knowledge.confirmLearningSuggestion({ workspaceId, suggestionId: required(params, 'suggestion_id'), confirmedBy: actorId, ...(typeof params.note === 'string' ? { note: params.note } : {}) })
        await persistEvent(workspaceId, suggestion.id, 'knowledge.learning.confirmed', 1, suggestion as unknown as Record<string, unknown>)
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.learning.confirm', resourceType: 'learning_suggestion', resourceId: suggestion.id, before: { status: 'pending' }, after: suggestion as unknown as Record<string, unknown>, reason: typeof params.note === 'string' ? params.note : '运营确认学习建议' })
        return result(suggestion)
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.learning.dismiss': {
      try {
        const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops', 'rules_admin', 'knowledge_editor'])
        const suggestionId = required(params, 'suggestion_id')
        const suggestion = knowledge.dismissLearningSuggestion(workspaceId, suggestionId, typeof params.note === 'string' ? params.note : undefined)
        await persistEvent(workspaceId, suggestion.id, 'knowledge.learning.dismissed', 1, suggestion as unknown as Record<string, unknown>)
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.learning.dismiss', resourceType: 'learning_suggestion', resourceId: suggestion.id, before: { status: 'pending' }, after: suggestion as unknown as Record<string, unknown>, reason: typeof params.note === 'string' ? params.note : '运营驳回学习建议' })
        return result(suggestion)
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.competitor.create': {
      try {
        const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops', 'competitor_reviewer'])
        const analysis = knowledge.createCompetitorAnalysis({ workspaceId, competitorName: required(params, 'competitor_name'), source: JSON.parse(required(params, 'source_json')), summary: required(params, 'summary'), structure: JSON.parse(required(params, 'structure_json')), sellingPoints: JSON.parse(required(params, 'selling_points_json')), expression: JSON.parse(required(params, 'expression_json')) })
        await persistEvent(workspaceId, analysis.id, 'knowledge.competitor.created', 1, analysis as unknown as Record<string, unknown>)
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.competitor.create', resourceType: 'competitor_analysis', resourceId: analysis.id, before: {}, after: analysis as unknown as Record<string, unknown>, reason: '运营竞品公开信息录入' })
        return result(analysis)
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.competitor.list': {
      try { requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'platform_ops', 'competitor_reviewer']); return result(knowledge.queryCompetitorAnalyses({ workspaceId, ...(typeof params.competitor_name === 'string' ? { competitorName: params.competitor_name } : {}), ...(typeof params.text === 'string' ? { text: params.text } : {}) })) }
      catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.competitor.reference': {
      try {
        const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops', 'competitor_reviewer'])
        const reference = knowledge.buildDifferentiationReference({ workspaceId, competitorId: required(params, 'competitor_id'), ownBrandName: required(params, 'own_brand_name'), ownSellingPoints: JSON.parse(required(params, 'own_selling_points_json')) })
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.competitor.reference', resourceType: 'competitor_analysis', resourceId: required(params, 'competitor_id'), before: {}, after: reference as unknown as Record<string, unknown>, reason: '运营生成差异化竞品参考' })
        return result(reference)
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'multimodal.image.edit': {
      requirePlatformModelCostGate('image_edit')
      await requirePluginWalletAccess(workspaceId)
      let request: unknown
      try { request = JSON.parse(required(params, 'request_json')) } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'request_json 必须是合法 JSON', 400) }
      const candidate = createImageEditCandidate(request as never)
      if (!candidate.ok) throw new DomainError(ERROR_CODES.INVALID_REQUEST, candidate.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '), 400)
      const sourceAsset = assetForWorkspace(workspaceId, candidate.value.sourceImageId)
      const sourceReady = sourceAsset.mimeType.toLowerCase().startsWith('image/')
        && sourceAsset.scanStatus === 'clean'
        && sourceAsset.rightsStatus === 'approved'
        && sourceAsset.rightsScope !== 'unusable'
        && sourceAsset.aiModificationAllowed === true
        && (!sourceAsset.usageScopes?.length || sourceAsset.usageScopes.includes('commercial') || sourceAsset.usageScopes.includes('ai_generation'))
        && (!sourceAsset.validFrom || Date.parse(sourceAsset.validFrom) <= Date.now())
        && (!sourceAsset.validTo || Date.parse(sourceAsset.validTo) >= Date.now())
      if (!sourceReady) throw new DomainError('IMAGE_SOURCE_ASSET_INVALID', '图片编辑必须使用当前工作区内已通过扫描、权益和 AI 修改许可的素材', 409, { asset_id: sourceAsset.id, scan_status: sourceAsset.scanStatus, rights_status: sourceAsset.rightsStatus, next_step: '完成 asset.scan 和 asset.rights.update 后重试' })
      const sourceStored = await getStoredObjectWithRetry(workspaceId, sourceAsset.storageKey)
      const contextProduct = service.products.get(candidate.value.context.product.id)
      if (contextProduct && contextProduct.workspaceId === workspaceId && !contextProduct.factsConfirmed) throw new DomainError('PRODUCT_FACTS_CONFIRMATION_REQUIRED', '图片编辑需要先确认商品事实', 409)
      const rulePreflight = await requireGenerationRulePreflight(workspaceId, candidate.value.context.product.id, '图片编辑前平台规则校验未通过')
      requireRuleSafeGenerationText(rulePreflight, [candidate.value.prompt], '图片编辑指令命中当前平台规则禁用表达')
      const walletDebitKey = `image-edit:${candidate.value.id}`
      await debitPluginWallet({ workspaceId, idempotencyKey: walletDebitKey, actorId: requestActor(req), description: '图片编辑调用' })
      let walletRefunded = false
      const refundEditWallet = async (reason: string) => {
        if (walletRefunded) return
        walletRefunded = true
        await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: requestActor(req), reason })
      }
      try {
        await persistEvent(workspaceId, candidate.value.id, 'multimodal.image.edit_requested', 1, candidate.value as unknown as Record<string, unknown>)
        if (!imageEditGenerator) {
          if (isProduction()) {
            await refundEditWallet('图片编辑 provider 未配置')
            throw new DomainError('IMAGE_EDIT_NOT_CONFIGURED', '生产环境未配置图片编辑中转服务', 503)
          }
          return result({ ...candidate.value, execution: executionContract('image_edit', false) })
        }
        let images: string[]
        images = await imageEditGenerator.generate({ prompt: candidate.value.prompt, sourceImages: [{ bytes: sourceStored.body, mimeType: sourceStored.metadata.contentType }], region: candidate.value.region.rect, usageContext: { workspaceId, actionId: walletDebitKey } })
        if (!contextProduct || contextProduct.workspaceId !== workspaceId) return result({ ...candidate.value, images, rendering: 'candidate', platformPublished: false, execution: executionContract('image_edit', true) })
        const editJob = service.enqueueImageGeneration({ workspaceId, productId: contextProduct.id, sourceAssetIds: [sourceAsset.id], direction: `局部编辑：${candidate.value.prompt}`, count: 1, idempotencyKey: `image-edit:${candidate.value.id}` })
        editJob.state = 'succeeded'
        const archived = await archiveGeneratedImages(workspaceId, editJob.id, images)
        await persistSnapshot(workspaceId, 'image_generation_job', archived, archived as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, archived.id, 'product.image_edit_candidate_generated', archived.revision, { job_id: archived.id, product_id: contextProduct.id, source_asset_id: sourceAsset.id, visual_refs: archived.outputs?.map(output => output.visualRef) ?? [], artifact_role: 'candidate' })
        return result({ ...candidate.value, images, rendering: 'candidate', platformPublished: false, execution: executionContract('image_edit', true), job: publicImageJob(archived) })
      } catch (error) {
        if (!providerSucceededButSettlementPending(error)) await refundEditWallet('图片编辑任务或 provider 失败')
        throw error
      }
    }
    case 'multimodal.generate': {
      await requirePluginWalletAccess(workspaceId)
      let context: GenerationContext
      try { context = JSON.parse(required(params, 'context_json')) as GenerationContext } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'context_json 必须是合法 JSON', 400) }
      const rulePreflight = await generationRulePreflight(workspaceId, context.product.id)
      if (rulePreflight.blocking) throw new DomainError('PLATFORM_RULE_PREFLIGHT_BLOCKED', '当前店铺平台规则存在阻断项，不能继续生成', 409, { rule_preflight: rulePreflight })
      const modality = required(params, 'modality') as 'text' | 'image' | 'video'
      requireRuleSafeGenerationText(rulePreflight, [params.prompt], '多模态生成指令命中当前平台规则禁用表达')
      const request = createOneSentenceGenerationRequest(modality === 'video'
        ? { modality, prompt: required(params, 'prompt'), output: typeof params.output === 'string' ? params.output as 'script' | 'storyboard' | 'rendering' : 'script', context }
        : { modality, prompt: required(params, 'prompt'), context })
      if (!request.ok) throw new DomainError(ERROR_CODES.INVALID_REQUEST, request.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '), 400)
      if (request.value.modality === 'image') requirePlatformModelCostGate('image')
      if (request.value.modality === 'text' || (request.value.modality === 'video' && request.value.output !== 'rendering')) requirePlatformModelCostGate('text')
      const multimodalKey = createHash('sha256').update(JSON.stringify(request.value)).digest('hex')
      const walletDebitKey = `multimodal:${multimodalKey}`
      await debitPluginWallet({ workspaceId, idempotencyKey: walletDebitKey, actorId: requestActor(req), description: `${modality}生成调用` })
      let rendering: Awaited<ReturnType<NonNullable<typeof videoGenerator>['generate']>> | undefined
      let generatedImages: string[] | undefined
      let imageJob: ReturnType<typeof service.enqueueImageGeneration> | undefined
      let generatedText: Awaited<ReturnType<typeof service.generateOneSentenceText>> | undefined
      try {
        if (request.value.modality === 'text') {
          generatedText = await service.generateOneSentenceText({ workspaceId, productId: request.value.context.product.id, prompt: request.value.prompt, actionId: walletDebitKey })
        }
        if (request.value.modality === 'video' && request.value.output !== 'rendering') {
          generatedText = await service.generateOneSentenceText({ workspaceId, productId: request.value.context.product.id, prompt: `${request.value.output}：${request.value.prompt}`, actionId: walletDebitKey })
        }
        if (request.value.modality === 'image') {
          const product = service.products.get(request.value.context.product.id)
          if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '多模态图片请求引用的商品不存在或不属于当前工作区', 404)
          if (!product.factsConfirmed) throw new DomainError('PRODUCT_FACTS_CONFIRMATION_REQUIRED', '多模态图片生成需要先确认商品事实', 409)
          service.assertBrandVisualGenerationReady(workspaceId, product.platform)
          imageJob = service.enqueueImageGeneration({ workspaceId, productId: product.id, direction: request.value.prompt, count: 1, idempotencyKey: `multimodal-image:${multimodalKey}` })
          const completed = await service.completeImageGeneration({ workspaceId, jobId: imageJob.id })
          generatedImages = completed.images
          await persistSnapshot(workspaceId, 'image_generation_job', completed.job, completed.job as unknown as Record<string, unknown>)
        }
        if (request.value.modality === 'video' && (request.value.output as string) === 'rendering') {
          requirePlatformModelCostGate('video')
          if (!videoGenerator) throw new DomainError('VIDEO_GENERATION_NOT_CONFIGURED', '生产环境未配置视频生成中转服务', 503)
          rendering = await videoGenerator.generate({ prompt: request.value.prompt, output: 'rendering', context: request.value.context, usageContext: { workspaceId, actionId: walletDebitKey } })
        }
        if (generatedText) requireRuleSafeGenerationText(rulePreflight, [generatedText], '多模态生成结果命中当前平台规则禁用表达')
      } catch (error) {
        if (!providerSucceededButSettlementPending(error)) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: requestActor(req), reason: '多模态生成 provider 调用失败' })
        throw error
      }
      const providerExecuted = request.value.modality === 'text' || (request.value.modality === 'video' && request.value.output !== 'rendering')
        ? Boolean(contentGenerator)
        : request.value.modality === 'image' ? Boolean(imageGenerator) : Boolean(rendering)
      const execution = { status: rendering ? rendering.status : generatedImages || generatedText ? 'completed' as const : 'requested' as const, ...executionContract(request.value.modality === 'text' ? 'content' : request.value.modality, providerExecuted) }
      try {
        await persistEvent(workspaceId, `multimodal_${randomUUID()}`, rendering || generatedImages || generatedText ? 'multimodal.generation.completed' : 'multimodal.generation.requested', 1, { ...request.value as unknown as Record<string, unknown>, execution, rule_preflight: rulePreflight, ...(imageJob ? { image_job_id: imageJob.id } : {}), ...(generatedText ? { content: generatedText } : {}), ...(generatedImages ? { images: generatedImages } : {}), ...(rendering ? { rendering } : {}) })
      } catch (error) {
        await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: requestActor(req), reason: '多模态结果记录失败' })
        throw error
      }
      return result({ ...request.value, execution, rule_preflight: rulePreflight, ...(generatedText ? { content: generatedText } : {}), ...(imageJob ? { image_job_id: imageJob.id } : {}), ...(generatedImages ? { images: generatedImages } : {}), ...(rendering ? { rendering } : {}) })
    }
    case 'multimodal.video.request': {
      await requirePluginWalletAccess(workspaceId)
      let context: GenerationContext
      try { context = JSON.parse(required(params, 'context_json')) as GenerationContext } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'context_json 必须是合法 JSON', 400) }
      const rulePreflight = await generationRulePreflight(workspaceId, context.product.id)
      if (rulePreflight.blocking) throw new DomainError('PLATFORM_RULE_PREFLIGHT_BLOCKED', '当前店铺平台规则存在阻断项，不能继续生成视频', 409, { rule_preflight: rulePreflight })
      const output = required(params, 'output') as 'script' | 'storyboard' | 'rendering'
      requireRuleSafeGenerationText(rulePreflight, [params.prompt], '视频生成指令命中当前平台规则禁用表达')
      if (output !== 'rendering') requirePlatformModelCostGate('text')
      const request = output === 'rendering'
        ? createVideoRenderingRequest({ prompt: required(params, 'prompt'), context })
        : createVideoGenerationRequest({ prompt: required(params, 'prompt'), output, context })
      if (!request.ok) throw new DomainError(ERROR_CODES.INVALID_REQUEST, request.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '), 400)
      const videoRequestKey = (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) || header(req, 'idempotency-key')?.trim() || randomUUID()
      const walletDebitKey = `video:${videoRequestKey}`
      await debitPluginWallet({ workspaceId, idempotencyKey: walletDebitKey, actorId: requestActor(req), description: '视频生成调用' })
      let rendering: Awaited<ReturnType<NonNullable<typeof videoGenerator>['generate']>> | undefined
      let generatedPlan: Awaited<ReturnType<typeof service.generateOneSentenceText>> | undefined
      try {
        if (request.value.output !== 'rendering') generatedPlan = await service.generateOneSentenceText({ workspaceId, productId: request.value.context.product.id, prompt: `${request.value.output}：${request.value.prompt}`, actionId: walletDebitKey })
        if ((request.value.output as string) === 'rendering') {
          if (!videoGenerator) throw new DomainError('VIDEO_GENERATION_NOT_CONFIGURED', '生产环境未配置视频生成中转服务', 503)
          rendering = await videoGenerator.generate({ prompt: request.value.prompt, output: 'rendering', context: request.value.context, usageContext: { workspaceId, actionId: walletDebitKey } })
        }
        if (generatedPlan) requireRuleSafeGenerationText(rulePreflight, [generatedPlan], '视频脚本或分镜命中当前平台规则禁用表达')
      } catch (error) {
        if (!providerSucceededButSettlementPending(error)) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: requestActor(req), reason: '视频生成 provider 调用失败' })
        throw error
      }
      const execution = { status: rendering ? rendering.status : generatedPlan ? 'completed' as const : 'requested' as const, ...executionContract('video', Boolean(rendering ? videoGenerator : contentGenerator), generatedPlan && contentGenerator ? 'text-relay' : undefined) }
      try {
        await persistEvent(workspaceId, `video_${randomUUID()}`, rendering || generatedPlan ? 'multimodal.video_completed' : 'multimodal.video.requested', 1, { ...request.value as unknown as Record<string, unknown>, execution, rule_preflight: rulePreflight, ...(generatedPlan ? { plan: generatedPlan } : {}), ...(rendering ? { rendering } : {}) })
      } catch (error) {
        await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: walletDebitKey, actorId: requestActor(req), reason: '视频结果记录失败' })
        throw error
      }
      return result({ ...request.value, execution, rule_preflight: rulePreflight, ...(generatedPlan ? { plan: generatedPlan } : {}), ...(rendering ? { rendering } : {}) })
    }
    case 'multimodal.video.get': {
      if (!videoGenerator) throw new DomainError('VIDEO_GENERATION_NOT_CONFIGURED', '生产环境未配置视频生成中转服务', 503)
      const providerJobId = required(params, 'provider_job_id')
      try {
        await assertVideoProviderJobScope(workspaceId, providerJobId)
        const rendering = await videoGenerator.getStatus(providerJobId)
        await persistEvent(workspaceId, `video_${providerJobId}`, 'multimodal.video_status_observed', 1, { provider_job_id: providerJobId, ...rendering })
        return result({ provider_job_id: providerJobId, execution: executionContract('video', true), ...rendering })
      } catch (error) {
        if (error instanceof DomainError) throw error
        throw new DomainError('VIDEO_PROVIDER_STATUS_FAILED', error instanceof Error ? error.message : '视频 provider 状态查询失败', 503)
      }
    }
  }
}

export async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  if (req.method === 'GET' && path === '/metrics') {
    res.statusCode = 200
    res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(prometheusMetrics())
    return
  }
  if (req.method === 'OPTIONS') return send(res, 204, isProduction() ? 'unknown' : 'ws_demo', null, null, req)
  const isOAuthCallback = /^\/v1\/oauth\/callback\/(jd|taobao|tmall|pinduoduo|xiaohongshu|douyin)$/.test(path)
  const paymentCallbackMatch = path.match(/^\/v1\/(billing|subscriptions)\/callback\/(alipay|wechat)$/)
  const isWorkerAutomationTick = req.method === 'POST' && path === '/v1/internal/automation/tick'
  const workerRoute = isWorkerRoute(req.method, path)
  // Health probes are infrastructure-scoped and intentionally unauthenticated;
  // all merchant and MCP routes still pass the production identity boundary.
  // OAuth callbacks are the exception: the platform redirects a browser and
  // cannot attach the merchant API Bearer token. The one-time state and PKCE
  // verifier are the callback's authentication boundary.
  if (workerRoute) requireWorkerAuthorization(req)
  else if (path !== '/healthz' && !isOAuthCallback && !paymentCallbackMatch) await authenticate(req)
  const hydrateRequestWorkspace = header(req, 'x-workspace-id')?.trim() || (!requiresStrictAuth() ? 'ws_demo' : undefined)
  if (hydrateRequestWorkspace && path !== '/healthz' && !isOAuthCallback && !paymentCallbackMatch && !isWorkerAutomationTick) await hydrateWorkspace(hydrateRequestWorkspace)
  // Health probes are infrastructure-scoped, not merchant-scoped. Requiring
  // X-Workspace-Id here would make the production container fail its own
  // liveness/readiness check with 401.
  if (req.method === 'GET' && path === '/healthz') {
    if (persistenceError) return send(res, 503, 'system', { ...runtimeHealth(), persistence: { mode: 'postgres', ready: false } }, { code: ERROR_CODES.DATABASE_UNAVAILABLE, message: '数据库未就绪' }, req)
    try {
      await persistenceReady
      await persistence.checkHealth?.()
    } catch {
      return send(res, 503, 'system', { ...runtimeHealth(), persistence: { mode: persistence.mode, ready: false } }, { code: ERROR_CODES.DATABASE_UNAVAILABLE, message: '数据库未就绪' }, req)
    }
    return send(res, 200, 'system', { ...runtimeHealth(), persistence: { mode: persistence.mode, ready: true } }, null, req)
  }
  try {
    await persistenceReady
  } catch {
    return fail(res, 503, 'system', ERROR_CODES.DATABASE_UNAVAILABLE, '数据库未就绪', req)
  }
  if (hydrateRequestWorkspace && path !== '/mcp' && path !== '/healthz' && !isOAuthCallback && !paymentCallbackMatch && !workerRoute) {
    await enforceActiveWorkspaceMember(req, hydrateRequestWorkspace)
  }
  if (!workerRoute) {
    const taskPath = path.match(/^\/v1\/tasks\/([^/]+)(?:\/|$)/u)
    if (taskPath) {
      const task = scopeTask(req, decodeURIComponent(taskPath[1]!))
      const privileged = /\/(?:approve|publish)(?:\/|$)/u.test(path)
      await enforceTaskBrandAccess(req, task, taskRoleForOperation(path, req.method === 'GET' && !privileged))
    }
    const contentPath = path.match(/^\/v1\/content-versions\/([^/]+)(?:\/|$)/u)
    if (contentPath) {
      const scoped = scopeContentVersion(req, decodeURIComponent(contentPath[1]!))
      const privileged = /\/(?:approve|publish)(?:\/|$)/u.test(path)
      await enforceTaskBrandAccess(req, scoped.task, taskRoleForOperation(path, req.method === 'GET' && !privileged))
    }
  }
  if (req.method === 'POST' && path === '/v1/internal/automation/tick') {
    requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    await hydrateWorkspace(workspaceId)
    const automation = await runAutomationTick(workspaceId, req, 'worker-automation')
    const ruleSync = await syncSignedPlatformRules(workspaceId)
    return send(res, 200, workspaceId, { ...automation, rule_sync: ruleSync }, null, req)
  }
  if (req.method === 'POST' && path === '/v1/internal/model-usage') {
    requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    const input = await body(req)
    const modality = input.modality
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    const actionId = typeof input.actionId === 'string' ? input.actionId.trim() : undefined
    const providerRequestId = typeof input.providerRequestId === 'string' ? input.providerRequestId.trim() : undefined
    const number = (value: unknown, name: string) => {
      if (value === undefined) return undefined
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${name} 必须是非负数`, 400)
      return value
    }
    if (!['text', 'image', 'image_edit', 'ocr', 'video'].includes(String(modality)) || !model) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '模型用量回执缺少合法 modality 或 model', 400)
    if (input.workspaceId !== undefined && input.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '模型用量回执工作区不匹配', 403)
    await recordRelayUsage({ workspaceId, ...(actionId ? { actionId } : {}), modality: modality as RelayUsageRecord['modality'], model, ...(providerRequestId ? { providerRequestId } : {}), ...(input.inputTokens !== undefined ? { inputTokens: number(input.inputTokens, 'inputTokens')! } : {}), ...(input.outputTokens !== undefined ? { outputTokens: number(input.outputTokens, 'outputTokens')! } : {}), ...(input.totalTokens !== undefined ? { totalTokens: number(input.totalTokens, 'totalTokens')! } : {}), ...(input.costCny !== undefined ? { costCny: number(input.costCny, 'costCny')! } : {}), observedAt: typeof input.observedAt === 'string' && Number.isFinite(Date.parse(input.observedAt)) ? input.observedAt : new Date().toISOString(), ...(input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? { metadata: input.metadata as Record<string, unknown> } : {}) })
    return send(res, 200, workspaceId, { recorded: true, action_id: actionId ?? null, provider_request_id: providerRequestId ?? null }, null, req)
  }
  if (req.method === 'POST' && paymentCallbackMatch) {
    const input = await body(req)
    const orderId = required(input, 'order_id')
    const providerTradeId = required(input, 'provider_trade_id')
    const amountFen = Number(input.amount_fen)
    const state = typeof input.state === 'string' ? input.state : ''
    const workspaceId = typeof input.workspace_id === 'string' && input.workspace_id.trim() ? input.workspace_id.trim() : ''
    if (!workspaceId || !Number.isSafeInteger(amountFen) || amountFen < 0) throw new DomainError('PAYMENT_CALLBACK_INVALID', '支付回调缺少有效订单、工作区或金额', 400)
    verifyPaymentCallback(req, { order_id: orderId, provider_trade_id: providerTradeId, amount_fen: amountFen, state })
    if (state !== 'paid' && state !== 'SUCCESS') return send(res, 200, workspaceId, { accepted: true, state }, null, req)
    if (paymentCallbackMatch[1] === 'subscriptions') {
      const orders = await (persistence.subscriptions ?? memorySubscriptions).listOrders(workspaceId, 100)
      const order = orders.find(item => item.orderNo === orderId)
      if (!order) throw new DomainError('SUBSCRIPTION_ORDER_NOT_FOUND', '支付回调对应的订阅订单不存在', 404)
      if (order.paymentProvider !== paymentCallbackMatch[2]) throw new DomainError('PAYMENT_CALLBACK_CHANNEL_MISMATCH', '支付回调渠道与订阅订单渠道不一致', 400)
      if (Math.round(order.paymentAmountCny * 100) !== amountFen) throw new DomainError('SUBSCRIPTION_CALLBACK_AMOUNT_MISMATCH', '支付回调金额与订阅订单支付金额快照不一致', 400)
      if (order.status === 'paid') {
        if (order.providerTradeId !== providerTradeId) throw new DomainError('SUBSCRIPTION_CALLBACK_REPLAY_CONFLICT', '已支付订阅订单不能使用不同的支付交易号重复入账', 409)
        await synchronizeCommercialQuotaFromSubscription(order)
        const entitlements = await grantSubscriptionEntitlements({ workspaceId, orderNo: order.orderNo, addonCodes: order.addonCodes, extensions: persistence.commercialExtensions ?? memoryCommercialExtensions, entitlements: persistence.entitlements ?? memoryEntitlements })
        return send(res, 200, workspaceId, { accepted: true, order_id: orderId, state: 'paid', replayed: true, entitlements_granted: entitlements.map(item => ({ addon_code: item.addonCode, kind: item.kind, units: item.grantedUnits })) }, null, req)
      }
      const paid = await (persistence.subscriptions ?? memorySubscriptions).markPaid({ workspaceId, orderNo: orderId, providerTradeId })
      await synchronizeCommercialQuotaFromSubscription(paid)
      const entitlements = await grantSubscriptionEntitlements({ workspaceId, orderNo: paid.orderNo, addonCodes: paid.addonCodes, extensions: persistence.commercialExtensions ?? memoryCommercialExtensions, entitlements: persistence.entitlements ?? memoryEntitlements })
      await recordOperationAudit({ workspaceId, actorId: 'payment_provider', action: 'subscription.order.paid', resourceType: 'subscription_order', resourceId: orderId, before: order as unknown as Record<string, unknown>, after: paid as unknown as Record<string, unknown>, reason: `支付服务商回调（${paymentCallbackMatch[2]}）` })
      await recordGrowthEvent({ workspaceId, eventType: 'subscription.order.paid', actorId: 'payment_provider', planCode: paid.planCode, sourceChannel: paid.sourceChannel, metadata: { orderNo: paid.orderNo, paymentAmountCny: paid.paymentAmountCny } })
      return send(res, 200, workspaceId, { accepted: true, order_id: orderId, state: 'paid', entitlements_granted: entitlements.map(item => ({ addon_code: item.addonCode, kind: item.kind, units: item.grantedUnits })) }, null, req)
    }
    const rechargeOrder = persistence.billing ? await persistence.billing.getOrder(workspaceId, orderId) : rechargeOrders.get(orderId)
    if (!rechargeOrder || rechargeOrder.workspaceId !== workspaceId) throw new DomainError('BILLING_ORDER_NOT_FOUND', '支付回调对应的充值订单不存在', 404)
    if (rechargeOrder.channel !== paymentCallbackMatch[2]) throw new DomainError('PAYMENT_CALLBACK_CHANNEL_MISMATCH', '支付回调渠道与充值订单渠道不一致', 400)
    if (isProduction() && rechargeOrder.paymentMode !== 'provider') throw new DomainError('PAYMENT_ORDER_MODE_MISMATCH', '生产环境不能为 fixture 充值订单入账', 409)
    if (rechargeOrder.state === 'paid' && rechargeOrder.providerTradeId && rechargeOrder.providerTradeId !== providerTradeId) throw new DomainError('PAYMENT_CALLBACK_REPLAY_CONFLICT', '已到账订单不能使用不同的支付交易号重复入账', 409)
    const paid = await markRechargePaid({ workspaceId, orderId, providerTradeId, amountFen })
    if (!paid) throw new DomainError('BILLING_ORDER_NOT_FOUND', '支付回调对应的充值订单不存在', 404)
    await persistEvent(workspaceId, orderId, 'billing.recharge.paid', 1, { order_id: orderId, provider_trade_id: providerTradeId, amount_fen: amountFen, channel: paymentCallbackMatch[2] })
    return send(res, 200, workspaceId, { accepted: true, order_id: orderId, state: 'paid' }, null, req)
  }
  const requestWorkspace = (() => {
    try { return resolveWorkspace(req) } catch { return isProduction() ? 'unknown' : 'ws_demo' }
  })()
  if (requestWorkspace !== 'unknown' && !isHttpOnboardingExempt(path) && !/^\/v1\/oauth\/callback\//u.test(path)) requireStoreOnboarding(requestWorkspace, `http:${path}`)
  await enforceRateLimit(req, requestWorkspace ?? 'unknown')
  if (req.method === 'GET' && path === '/v1/products') {
    const workspaceId = resolveWorkspace(req, url.searchParams.get('workspace_id') ?? undefined)
    return send(res, 200, workspaceId, service.listProducts(workspaceId, {
      ...(url.searchParams.get('query') ? { query: url.searchParams.get('query')! } : {}),
      ...(url.searchParams.get('platform') ? { platform: url.searchParams.get('platform') as Platform } : {}),
      ...(url.searchParams.get('account_id') ? { accountId: url.searchParams.get('account_id')! } : {}),
      ...(url.searchParams.get('store_name') ? { storeName: url.searchParams.get('store_name')! } : {}),
    }), null, req)
  }
  const productImageReviewMatch = path.match(/^\/v1\/products\/([^/]+)\/image-review$/)
  if (req.method === 'GET' && productImageReviewMatch) {
    const workspaceId = resolveWorkspace(req)
    return send(res, 200, workspaceId, service.reviewProductImages(workspaceId, decodeURIComponent(productImageReviewMatch[1]!)), null, req)
  }
  if (req.method === 'GET' && path === '/v1/tasks') {
    const workspaceId = resolveWorkspace(req, url.searchParams.get('workspace_id') ?? undefined)
    return send(res, 200, workspaceId, service.listTasks(workspaceId, {
      ...(url.searchParams.get('query') ? { query: url.searchParams.get('query')! } : {}),
      ...(url.searchParams.get('platform') ? { platform: url.searchParams.get('platform') as Platform } : {}),
      ...(url.searchParams.get('state') ? { state: url.searchParams.get('state') as import('../../../packages/application/src/service.js').TaskState } : {}),
      ...(url.searchParams.get('product_id') ? { productId: url.searchParams.get('product_id')! } : {}),
    }), null, req)
  }
  if (req.method === 'GET' && path === '/v1/platform-capabilities') {
    const workspaceId = resolveWorkspace(req, url.searchParams.get('workspace_id') ?? undefined)
    return send(res, 200, workspaceId, {
      items: SUPPORTED_PLATFORMS.map(platform => ({
        platform,
        readiness: connectorRuntime.readiness[platform],
        capabilities: connectorRuntime.capabilityMatrix(platform),
      })),
    }, null, req)
  }
  if (req.method === 'GET' && path === '/v1/rules') {
    const workspaceId = resolveWorkspace(req)
    const requestedPlatform = url.searchParams.get('platform')?.trim()
    if (requestedPlatform && !SUPPORTED_PLATFORMS.includes(requestedPlatform as Platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
    const appliesToPlatform = (rule: { status: string; scope?: string; targetId?: string; scopeValue?: string }) => rule.status === 'active' && (!requestedPlatform || rule.scope === 'global' || (rule.scope === 'platform' && (rule.targetId ?? rule.scopeValue) === requestedPlatform))
    const repository = ruleRepository()
    if (repository) {
      const packId = url.searchParams.get('pack_id')?.trim() || undefined
      const rows = await repository.list(workspaceId, packId)
      if (rows.length || packId) return send(res, 200, workspaceId, rows.map(publicRule).filter(appliesToPlatform), null, req)
      return send(res, 200, workspaceId, (await persistedRules(workspaceId) ?? []).filter(appliesToPlatform), null, req)
    }
    if (isProduction()) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '生产规则仓储未配置', 503)
    return send(res, 200, workspaceId, service.listRulePacks().filter(appliesToPlatform), null, req)
  }
  if (req.method === 'GET' && path === '/v1/catalog/categories') {
    const workspaceId = resolveWorkspace(req)
    const query = url.searchParams.get('query')?.trim().toLocaleLowerCase()
    const items = query ? catalogCategories.filter(item => `${item.code}${item.name}${item.fields.join('')}`.toLocaleLowerCase().includes(query)) : catalogCategories
    return send(res, 200, workspaceId, items, null, req)
  }
  if (req.method === 'GET' && path === '/v1/rules/audit') {
    const workspaceId = resolveWorkspace(req)
    requireRuleAdmin(req)
    const repository = ruleRepository()
    if (!repository) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '规则审计仅在持久化仓储可用时开放', 503)
    return send(res, 200, workspaceId, await repository.listAudit(workspaceId, url.searchParams.get('pack_id')?.trim() || undefined), null, req)
  }
  const createRuleVersionMatch = path.match(/^\/v1\/rules\/([^/]+)\/versions$/)
  if (req.method === 'POST' && createRuleVersionMatch) {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const principal = requireRuleAdmin(req)
    const repository = ruleRepository()
    if (!repository) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '规则写入仅允许使用持久化仓储', 503)
    const packId = decodeURIComponent(createRuleVersionMatch[1]!)
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(packId)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则包 ID 格式无效', 400)
    if (input.pack_id !== undefined && String(input.pack_id) !== packId) throw new DomainError(ERROR_CODES.WORKSPACE_SCOPE_MISMATCH, '路径规则包与请求体不一致', 403)
    const name = required(input, 'name')
    const versionValue = required(input, 'version')
    const scope = required(input, 'scope')
    const sourceKind = required(input, 'source_kind')
    const sourceReference = required(input, 'source_reference')
    const sourceCheckedAt = required(input, 'source_checked_at')
    const reason = required(input, 'reason')
    const status = typeof input.status === 'string' ? input.status : 'draft'
    if (!['global', 'platform', 'category', 'brand', 'store', 'campaign'].includes(scope)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则 scope 无效', 400)
    if (!['official', 'internal', 'legal_review'].includes(sourceKind)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则 source_kind 无效', 400)
    if (!['draft', 'active'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '新规则状态仅支持 draft 或 active', 400)
    if (!Number.isFinite(Date.parse(sourceCheckedAt))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'source_checked_at 必须是合法时间', 400)
    const checks = objectField(input, 'checks')
    const effectiveFromRaw = typeof input.effective_from === 'string' && input.effective_from.trim() ? input.effective_from.trim() : undefined
    const effectiveToRaw = typeof input.effective_to === 'string' && input.effective_to.trim() ? input.effective_to.trim() : undefined
    if ((effectiveFromRaw && Number.isNaN(Date.parse(effectiveFromRaw))) || (effectiveToRaw && Number.isNaN(Date.parse(effectiveToRaw))) || (effectiveFromRaw && effectiveToRaw && Date.parse(effectiveFromRaw) >= Date.parse(effectiveToRaw))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则有效期必须是合法时间，且 effective_from 早于 effective_to', 400)
    const effectiveFrom = effectiveFromRaw ? new Date(effectiveFromRaw).toISOString() : undefined
    const effectiveTo = effectiveToRaw ? new Date(effectiveToRaw).toISOString() : undefined
    const severity = input.severity === 'warning' ? 'warning' : input.severity === 'error' || input.severity === undefined ? 'error' : undefined
    const action = ['block', 'warn', 'review', 'allow'].includes(String(input.action)) ? String(input.action) : input.action === undefined ? 'block' : undefined
    if (!severity || !action) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则 severity/action 无效', 400)
    const checksum = createHash('sha256').update(canonicalJson(checks)).digest('hex')
    if (typeof input.checksum === 'string' && input.checksum.toLowerCase() !== checksum) throw new DomainError('RULE_CHECKSUM_MISMATCH', '规则校验和与 checks 内容不一致', 409)
    const approval = status === 'active' ? parseApprovalGrant(req, workspaceId, principal.actorId, input) : undefined
    const now = new Date().toISOString()
    await persistence.ensureWorkspace?.(workspaceId)
    const versionInput = {
      id: `rule_${randomBytes(12).toString('hex')}`, workspaceId, packId, name, version: versionValue, scope, status,
      sourceKind, sourceReference, sourceCheckedAt: new Date(sourceCheckedAt).toISOString(), checksum, checks,
      createdBy: principal.actorId, revision: 1, createdAt: now, updatedAt: now, severity, action,
      ...(effectiveFrom ? { effectiveFrom } : {}), ...(effectiveTo ? { effectiveTo } : {}),
      ...(typeof input.target_id === 'string' && input.target_id.trim() ? { targetId: input.target_id.trim() } : {}), ...(typeof input.scope_value === 'string' && input.scope_value.trim() ? { scopeValue: input.scope_value.trim() } : {}),
      ...(status === 'active' ? { activatedAt: now } : {}),
    }
    if (repository.insertVersionWithAudit) {
      try {
        const result = await repository.insertVersionWithAudit({ version: versionInput, audit: { id: `rule_audit_${randomBytes(12).toString('hex')}`, workspaceId, rulePackId: packId, ruleVersionId: versionInput.id, version: versionValue, action: status === 'active' ? 'activated' : 'created', actorId: principal.actorId, reason, occurredAt: now, data: { source_kind: sourceKind, source_reference: sourceReference, checksum, ...(approval ? { approval } : {}) } } })
        return send(res, 201, workspaceId, result, null, req)
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new DomainError('RULE_VERSION_CONFLICT', '规则版本已存在，或该规则包已有激活版本', 409)
        throw error
      }
    }
    let created: PersistedRuleVersion
    try {
      created = await repository.insertVersion(versionInput)
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new DomainError('RULE_VERSION_CONFLICT', '规则版本已存在，或该规则包已有激活版本', 409)
      throw error
    }
    let audit: PersistedRuleAudit
    try {
      audit = await repository.appendAudit({
        id: `rule_audit_${randomBytes(12).toString('hex')}`, workspaceId, rulePackId: packId, ruleVersionId: created.id,
        version: created.version, action: status === 'active' ? 'activated' : 'created', actorId: principal.actorId,
        reason, occurredAt: now, data: { source_kind: sourceKind, source_reference: sourceReference, checksum, ...(approval ? { approval } : {}) },
      })
    } catch {
      // The current repository contract exposes separate transactions. Surface
      // the partial write explicitly so operators can repair it; never report
      // success for an unaudited administrative mutation.
      throw new DomainError('RULE_AUDIT_WRITE_FAILED', '规则版本已写入，但审计追加失败；需暂停该工作区规则变更并人工核对', 503)
    }
    return send(res, 201, workspaceId, { version: publicRule(created), audit }, null, req)
  }
  const ruleStatusMatch = path.match(/^\/v1\/rules\/([^/]+)\/versions\/([^/]+)\/status$/)
  if (req.method === 'POST' && ruleStatusMatch) {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const principal = requireRuleAdmin(req)
    const repository = ruleRepository()
    if (!repository) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '规则写入仅允许使用持久化仓储', 503)
    const packId = decodeURIComponent(ruleStatusMatch[1]!)
    const versionName = decodeURIComponent(ruleStatusMatch[2]!)
    const status = required(input, 'status')
    const reason = required(input, 'reason')
    if (!['active', 'inactive', 'expired'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则状态无效', 400)
    const rows = await repository.list(workspaceId, packId)
    const target = rows.find(row => row.version === versionName)
    if (!target) throw new DomainError('RULE_VERSION_NOT_FOUND', '规则版本不存在', 404)
    const approval = status === 'active' ? parseApprovalGrant(req, workspaceId, principal.actorId, input) : undefined
    const at = new Date().toISOString()
    const current = rows.find(row => row.status === 'active' && row.id !== target.id)
    if (status === 'active' && current && !repository.transitionStatusWithAudit) throw new DomainError('RULE_ACTIVE_VERSION_EXISTS', '该规则包已有激活版本，请先显式停用后再激活新版本', 409)
    if (repository.transitionStatusWithAudit) {
      try {
        const result = await repository.transitionStatusWithAudit({ workspaceId, packId, targetId: target.id, status, actorId: principal.actorId, reason, occurredAt: at, targetAuditId: `rule_audit_${randomBytes(12).toString('hex')}`, ...(current ? { currentAuditId: `rule_audit_${randomBytes(12).toString('hex')}` } : {}), auditData: approval ? { approval_ref: approval.approvalRef, approved_by: approval.approvedBy, approved_at: approval.approvedAt } : {} })
        return send(res, 200, workspaceId, publicRule(result.version), null, req)
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new DomainError('RULE_ACTIVE_VERSION_EXISTS', '该规则包已有激活版本', 409)
        throw error
      }
    }
    let updated: PersistedRuleVersion
    try {
      updated = await repository.updateStatus({ workspaceId, id: target.id, status, revision: target.revision + 1, updatedAt: at, activatedAt: status === 'active' ? at : null, deactivatedAt: status === 'active' ? null : at })
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new DomainError('RULE_ACTIVE_VERSION_EXISTS', '该规则包已有激活版本', 409)
      throw error
    }
    try {
      await repository.appendAudit({ id: `rule_audit_${randomBytes(12).toString('hex')}`, workspaceId, rulePackId: packId, ruleVersionId: updated.id, version: updated.version, action: status === 'active' ? 'activated' : status === 'expired' ? 'expired' : 'deactivated', actorId: principal.actorId, reason, occurredAt: at, data: approval ? { approval_ref: approval.approvalRef, approved_by: approval.approvedBy, approved_at: approval.approvedAt } : {} })
    } catch {
      throw new DomainError('RULE_AUDIT_WRITE_FAILED', '规则状态已变更，但审计追加失败；需暂停该工作区规则变更并人工核对', 503)
    }
    return send(res, 200, workspaceId, publicRule(updated), null, req)
  }
  if (req.method === 'GET' && path === '/v1/brand-profile') {
    const workspaceId = resolveWorkspace(req)
    return send(res, 200, workspaceId, { profile: service.getBrandProfile(workspaceId) ?? null }, null, req)
  }
  if (req.method === 'POST' && path === '/v1/brand-profile/extract') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const assetIds = input.asset_ids === undefined ? undefined : Array.isArray(input.asset_ids) && input.asset_ids.length > 0 && input.asset_ids.length <= 50 && input.asset_ids.every(value => typeof value === 'string' && value.trim()) ? input.asset_ids.map(value => String(value).trim()) : null
    if (assetIds === null) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'asset_ids 必须是 1～50 个素材 ID 的字符串数组', 400)
    return send(res, 200, workspaceId, service.extractBrandProfile(workspaceId, assetIds), null, req)
  }
  if (req.method === 'PUT' && path === '/v1/brand-profile') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const tone = Array.isArray(input.tone) ? input.tone.filter((value): value is string => typeof value === 'string') : undefined
    const forbiddenTerms = Array.isArray(input.forbidden_terms) ? input.forbidden_terms.filter((value): value is string => typeof value === 'string') : undefined
    const details = isObject(input.details) ? input.details : undefined
    const visualRules = isObject(input.visual_rules) ? input.visual_rules as unknown as BrandVisualRules : undefined
    if (input.visual_rules !== undefined && !visualRules) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'visual_rules 必须是对象', 400)
    const resolutions = isObject(input.conflict_resolutions) && Object.values(input.conflict_resolutions).every(value => value === 'existing' || value === 'candidate') ? input.conflict_resolutions as Record<string, 'existing' | 'candidate'> : undefined
    if (input.conflict_resolutions !== undefined && !resolutions) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'conflict_resolutions 必须是字段到 existing/candidate 的对象', 400)
    const profile = service.upsertBrandProfile({ workspaceId, name: required(input, 'name'), ...(typeof input.positioning === 'string' ? { positioning: input.positioning } : {}), ...(typeof input.audience === 'string' ? { audience: input.audience } : {}), ...(tone ? { tone } : {}), ...(forbiddenTerms ? { forbiddenTerms } : {}), ...(details ? { details } : {}), ...(visualRules ? { visualRules } : {}), ...(typeof input.source === 'string' ? { source: input.source } : {}), ...(resolutions ? { resolutions } : {}) })
    await persistSnapshot(workspaceId, 'brand_profile', profile, profile as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, profile.id, 'brand_profile.updated', profile.revision, { brand_profile_id: profile.id, revision: profile.revision, source: typeof input.source === 'string' ? input.source : 'merchant_studio' })
    return send(res, 200, workspaceId, profile, null, req)
  }
  if (req.method === 'GET' && path === '/v1/assets') {
    const workspaceId = resolveWorkspace(req)
    return send(res, 200, workspaceId, service.listAssets(workspaceId), null, req)
  }
  const assetPreferenceMatch = path.match(/^\/v1\/assets\/([^/]+)\/preference$/)
  if (req.method === 'PUT' && assetPreferenceMatch) {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const verdict = required(input, 'verdict')
    if (!['excellent', 'disliked', 'unrated'].includes(verdict)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'verdict 必须是 excellent、disliked 或 unrated', 400)
    const reasons = input.reasons === undefined ? undefined : Array.isArray(input.reasons) && input.reasons.every(reason => typeof reason === 'string') ? input.reasons as string[] : null
    if (reasons === null) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'reasons 必须是字符串数组', 400)
    const updated = service.updateAssetPreference({ workspaceId, assetId: decodeURIComponent(assetPreferenceMatch[1]!), verdict: verdict as 'excellent' | 'disliked' | 'unrated', ...(reasons ? { reasons } : {}), ...(typeof input.note === 'string' ? { note: input.note } : {}), actorId: requestActor(req), ...(typeof input.expected_revision === 'number' ? { expectedRevision: input.expected_revision } : {}) })
    await persistSnapshot(workspaceId, 'asset', updated, updated as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, updated.id, 'asset.preference_updated', updated.revision, { asset_id: updated.id, verdict, reasons: updated.preference?.reasons ?? [], actor_id: updated.preference?.updatedBy ?? requestActor(req) })
    return send(res, 200, workspaceId, updated, null, req)
  }
  const assetDownloadMatch = path.match(/^\/v1\/assets\/([^/]+)\/download$/)
  if (req.method === 'GET' && assetDownloadMatch) {
    const workspaceId = resolveWorkspace(req)
    const asset = assetForWorkspace(workspaceId, assetDownloadMatch[1]!)
    const stored = await getStoredObjectWithRetry(workspaceId, asset.storageKey)
    return sendAssetDownload(res, asset, stored, req)
  }
  const assetScanMatch = path.match(/^\/v1\/assets\/([^/]+)\/scan$/)
  if (req.method === 'POST' && assetScanMatch) {
    const workspaceId = resolveWorkspace(req)
    const input = await body(req)
    const asset = assetForWorkspace(workspaceId, assetScanMatch[1]!)
    if (asset.scanStatus !== 'quarantined' || !asset.storageKey.startsWith('quarantine/')) {
      throw new DomainError('ASSET_SCAN_STATE_INVALID', '素材当前不在待扫描隔离状态', 409)
    }
    const evidence = required(input, 'scan_evidence_ref')
    const promoted = await getAssetStorage().promoteClean({ workspaceId, quarantineKey: asset.storageKey, scanEvidenceRef: evidence })
    asset.storageKey = promoted.key
    asset.scanStatus = 'clean'
    asset.revision += 1
    await persistSnapshot(workspaceId, 'asset', asset, asset as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, asset.id, 'asset.scan_promoted', asset.revision, { asset_id: asset.id, scan_evidence_ref: evidence, storage_key: promoted.key })
    return send(res, 200, workspaceId, { ...asset, scanEvidenceRef: promoted.scanEvidenceRef }, null, req)
  }
  const assetParseMatch = path.match(/^\/v1\/assets\/([^/]+)\/parse$/)
  if (req.method === 'POST' && assetParseMatch) {
    const workspaceId = resolveWorkspace(req)
    await requirePluginWalletAccess(workspaceId)
    const asset = assetForWorkspace(workspaceId, assetParseMatch[1]!)
    if (asset.scanStatus !== 'clean') throw new DomainError('ASSET_PARSE_SCAN_REQUIRED', '素材必须完成安全扫描后才能解析', 409)
    const ocrDebitKey = `asset-parse:${asset.id}`
    const ocrCandidate = asset.mimeType.toLowerCase().startsWith('image/')
    if (ocrCandidate && imageFactsExtractor) requirePlatformModelCostGate('ocr')
    if (ocrCandidate) await debitPluginWallet({ workspaceId, idempotencyKey: ocrDebitKey, actorId: requestActor(req), description: '图片 OCR/素材解析调用' })
    service.updateAssetParse({ workspaceId, assetId: asset.id, state: 'processing', source: 'parser' })
    try {
      const stored = await getStoredObjectWithRetry(workspaceId, asset.storageKey)
      const extracted = await parseAssetFacts({ name: asset.name, mimeType: asset.mimeType, body: stored.body, usageContext: { workspaceId, actionId: ocrDebitKey } })
      if (ocrCandidate && extracted.source !== 'model_ocr') await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: ocrDebitKey, actorId: requestActor(req), reason: '本次图片由本地解析器完成，未产生 OCR 中转调用' })
      const parsed = service.updateAssetParse({ workspaceId, assetId: asset.id, state: 'succeeded', facts: extracted.facts, source: extracted.source })
      await persistSnapshot(workspaceId, 'asset', parsed, parsed as unknown as Record<string, unknown>)
      const execution = executionContract('ocr', extracted.source === 'model_ocr')
      await persistEvent(workspaceId, asset.id, 'asset.parsed', parsed.revision, { asset_id: asset.id, parse_status: parsed.parseStatus, fact_keys: Object.keys(extracted.facts), source: extracted.source, execution })
      return send(res, 200, workspaceId, { ...parsed, execution }, null, req)
    } catch (error) {
      if (ocrCandidate && !providerSucceededButSettlementPending(error)) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: ocrDebitKey, actorId: requestActor(req), reason: '素材解析失败' })
      const failed = service.updateAssetParse({ workspaceId, assetId: asset.id, state: 'failed', error: error instanceof Error ? error.message : '素材解析失败' })
      await persistSnapshot(workspaceId, 'asset', failed, failed as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, asset.id, 'asset.parse_failed', failed.revision, { asset_id: asset.id, error: failed.parseError ?? '素材解析失败' })
      return send(res, 200, workspaceId, failed, null, req)
    }
  }
  if (req.method === 'POST' && path === '/v1/assets/upload') {
    const workspaceId = resolveWorkspace(req)
    const limit = configuredAssetLimit()
    const contentType = headerRequired(req, 'content-type')
    const encodedName = headerRequired(req, 'x-asset-name')
    let name = encodedName
    try { name = decodeURIComponent(encodedName) } catch { /* Preserve legacy raw header names. */ }
    const expectedSha256 = header(req, 'x-asset-sha256')?.trim()
    const bytes = await binaryBody(req, limit)
    validateAssetContentSignature(name, contentType, bytes)
    const actualSha256 = createHash('sha256').update(bytes).digest('hex')
    if (expectedSha256 && !/^[a-f0-9]{64}$/iu.test(expectedSha256)) throw new DomainError('ASSET_DIGEST_INVALID', 'x-asset-sha256 必须是 SHA-256 摘要', 400)
    if (expectedSha256 && expectedSha256.toLowerCase() !== actualSha256) throw new DomainError('ASSET_DIGEST_MISMATCH', 'x-asset-sha256 与上传内容不一致', 400)
    const pendingKey = `quarantine/${workspaceId}/pending_${randomBytes(12).toString('hex')}/upload.bin`
    const provisional = service.registerAsset({ workspaceId, name, mimeType: contentType, sizeBytes: bytes.byteLength, sha256: actualSha256, storageKey: pendingKey })
    if (provisional.deduplication.mode === 'deduplicated') { await persistAssetReference(workspaceId, provisional); return send(res, 200, workspaceId, provisional, null, req) }
    let storedKey: string | undefined
    try {
      const stored = await getAssetStorage().putQuarantine({ workspaceId, assetId: provisional.id, fileName: name, contentType, body: bytes, ...(expectedSha256 ? { expectedSha256 } : {}), expectedSizeBytes: bytes.byteLength })
      storedKey = stored.key
      provisional.storageKey = stored.key
      provisional.sha256 = stored.sha256
      provisional.sizeBytes = stored.sizeBytes
      await persistSnapshot(workspaceId, 'asset', provisional, provisional as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, provisional.id, 'asset.uploaded', provisional.revision, { asset_id: provisional.id, storage_key: stored.key, size_bytes: stored.sizeBytes, sha256: stored.sha256 })
      return send(res, 201, workspaceId, { ...provisional, scanStatus: 'quarantined' }, null, req)
    } catch (error) {
      service.assets.delete(provisional.id)
      if (storedKey) await compensateStoredObject(workspaceId, storedKey, 'asset snapshot or event persistence failed')
      throw error
    }
  }
  const assetRightsMatch = path.match(/^\/v1\/assets\/([^/]+)\/rights$/)
  if (req.method === 'PUT' && assetRightsMatch) {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const asset = assetForWorkspace(workspaceId, decodeURIComponent(assetRightsMatch[1]!))
    const rightsStatus = required(input, 'rights_status')
    if (!['approved', 'rejected', 'pending'].includes(rightsStatus)) throw new DomainError('ASSET_RIGHTS_STATUS_INVALID', 'rights_status 无效', 400)
    const rightsScope = typeof input.rights_scope === 'string' ? input.rights_scope : undefined
    const applicablePlatforms = Array.isArray(input.applicable_platforms) && input.applicable_platforms.every(value => SUPPORTED_PLATFORMS.includes(String(value) as Platform)) ? input.applicable_platforms as Platform[] : input.applicable_platforms === undefined ? undefined : (() => { throw new DomainError('ASSET_PLATFORM_SCOPE_INVALID', 'applicable_platforms 必须是支持平台数组', 400) })()
    const stringArray = (key: string) => input[key] === undefined ? undefined : Array.isArray(input[key]) && input[key].every(value => typeof value === 'string') ? input[key] as string[] : (() => { throw new DomainError('ASSET_RIGHTS_INPUT_INVALID', `${key} 必须是字符串数组`, 400) })()
    const updated = service.updateAssetRights({ workspaceId, assetId: asset.id, rightsStatus: rightsStatus as 'approved' | 'rejected' | 'pending', ...(rightsScope ? { rightsScope: rightsScope as import('../../../packages/application/src/service.js').AssetMetadata['rightsScope'] } : {}), ...(applicablePlatforms ? { applicablePlatforms } : {}), ...((stringArray('applicable_regions')) ? { applicableRegions: stringArray('applicable_regions') } : {}), ...((stringArray('usage_scopes')) ? { usageScopes: stringArray('usage_scopes') } : {}), ...(typeof input.ai_modification_allowed === 'boolean' ? { aiModificationAllowed: input.ai_modification_allowed } : {}) })
    await persistSnapshot(workspaceId, 'asset', updated, updated as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, updated.id, 'asset.rights_updated', updated.revision, { asset_id: updated.id, rights_status: updated.rightsStatus })
    return send(res, 200, workspaceId, updated, null, req)
  }
  const assetFactsMatch = path.match(/^\/v1\/assets\/([^/]+)\/facts$/)
  if (req.method === 'POST' && assetFactsMatch) {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const asset = assetForWorkspace(workspaceId, decodeURIComponent(assetFactsMatch[1]!))
    if (asset.scanStatus !== 'clean') throw new DomainError('ASSET_FACTS_SCAN_REQUIRED', '素材完成安全扫描后才能人工确认事实', 409)
    if (!isObject(input.facts) || Object.keys(input.facts).length === 0) throw new DomainError('ASSET_FACTS_EMPTY', 'facts 必须是非空对象', 400)
    const reason = required(input, 'reason').trim()
    if (!reason) throw new DomainError('ASSET_FACTS_REASON_REQUIRED', '人工确认原因不能为空', 400)
    const confirmed = service.updateAssetParse({ workspaceId, assetId: asset.id, state: 'succeeded', facts: input.facts, source: 'manual', confirmedBy: requestActor(req) })
    await persistSnapshot(workspaceId, 'asset', confirmed, confirmed as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, confirmed.id, 'asset.facts_manually_confirmed', confirmed.revision, { asset_id: confirmed.id, fact_keys: Object.keys(confirmed.extractedFacts ?? {}), source: 'manual', reason })
    return send(res, 200, workspaceId, confirmed, null, req)
  }
  if (req.method === 'POST' && path === '/v1/assets') {
    if (isProduction()) throw new DomainError('ASSET_BINARY_UPLOAD_REQUIRED', '生产环境必须通过二进制上传与扫描流程登记素材', 409)
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const asset = service.registerAsset({ workspaceId, name: required(input, 'name'), mimeType: required(input, 'mime_type'), sizeBytes: typeof input.size_bytes === 'number' ? input.size_bytes : -1, sha256: required(input, 'sha256'), storageKey: required(input, 'storage_key'), rightsStatus: input.rights_status === 'approved' || input.rights_status === 'rejected' ? input.rights_status : 'pending' })
    await persistSnapshot(workspaceId, 'asset', asset, asset as unknown as Record<string, unknown>)
    return send(res, 201, workspaceId, asset, null, req)
  }
  if (req.method === 'POST' && path === '/v1/products/import/batch') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    if (!Array.isArray(input.products) || input.products.length < 1 || input.products.length > 50 || input.products.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'products 必须是 1 至 50 个商品对象的数组', 400)
    type RestBatchItem = Parameters<MerchantService['importProduct']>[0]
    const items: RestBatchItem[] = input.products.map((raw: Record<string, unknown>, index: number) => {
      const platform = typeof raw.platform === 'string' ? raw.platform as Platform : '' as Platform
      if (!SUPPORTED_PLATFORMS.includes(platform)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 platform 无效`, 400)
      const accountId = typeof raw.account_id === 'string' && raw.account_id.trim() ? raw.account_id.trim() : undefined
      if (isProduction() && !accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', `第 ${index + 1} 项生产导入必须绑定已授权平台账号`, 400)
      if (accountId) service.getActivePlatformAccount(workspaceId, accountId, platform)
      const title = typeof raw.title === 'string' ? raw.title.trim() : ''
      if (!title) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 title 不能为空`, 400)
      const sourceAssetIds = Array.isArray(raw.asset_ids) ? raw.asset_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(value => value.trim()) : undefined
      if (sourceAssetIds && (sourceAssetIds.length > 50 || new Set(sourceAssetIds).size !== sourceAssetIds.length)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 asset_ids 必须是最多 50 个不重复素材 ID`, 400)
      const skus = Array.isArray(raw.skus) ? raw.skus.map((sku: any, skuIndex: number) => {
        if (!sku || typeof sku !== 'object' || typeof sku.id !== 'string' || typeof sku.name !== 'string' || typeof sku.price !== 'number' || typeof sku.stock !== 'number') throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 SKU ${skuIndex + 1} 格式无效`, 400)
        return { id: sku.id.trim(), name: sku.name.trim(), price: sku.price, stock: sku.stock, ...(Array.isArray(sku.images) ? { images: sku.images.filter((value: unknown): value is string => typeof value === 'string') } : {}), ...(sku.attributes && typeof sku.attributes === 'object' && !Array.isArray(sku.attributes) ? { attributes: Object.fromEntries(Object.entries(sku.attributes).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value as string])) } : {}) }
      }) : undefined
      const sellingPoints = Array.isArray(raw.selling_points) ? raw.selling_points.map((point: any, pointIndex: number) => ({ id: typeof point?.id === 'string' ? point.id : `sp_${pointIndex + 1}`, text: typeof point?.text === 'string' ? point.text : '', proofStatus: point?.proof_status === 'confirmed' || point?.proof_status === 'rejected' ? point.proof_status : 'pending', sourceIds: Array.isArray(point?.source_ids) ? point.source_ids.filter((value: unknown): value is string => typeof value === 'string') : [] })) : undefined
      return { workspaceId, platform, ...(accountId ? { accountId } : {}), ...(typeof raw.remote_id === 'string' && raw.remote_id.trim() ? { remoteId: raw.remote_id.trim() } : {}), ...(typeof raw.local_product_key === 'string' ? { localProductKey: raw.local_product_key } : {}), title, ...(typeof raw.sku_count === 'number' ? { skuCount: raw.sku_count } : {}), ...(skus ? { skus } : {}), ...(typeof raw.stock === 'number' ? { stock: raw.stock } : {}), ...(typeof raw.price === 'number' ? { price: raw.price } : {}), ...(typeof raw.category === 'string' ? { category: raw.category } : {}), ...(Array.isArray(raw.images) ? { images: raw.images.filter((value): value is string => typeof value === 'string') } : {}), ...(sourceAssetIds ? { sourceAssetIds } : {}), ...(raw.attributes && typeof raw.attributes === 'object' && !Array.isArray(raw.attributes) ? { attributes: Object.fromEntries(Object.entries(raw.attributes).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value as string])) } : {}), ...(sellingPoints ? { sellingPoints } : {}), ...(typeof raw.store_name === 'string' ? { storeName: raw.store_name } : {}), ...(typeof raw.store_differentiation === 'string' ? { storeDifferentiation: raw.store_differentiation } : {}) }
    })
    const beforeProducts = new Map([...service.products.entries()].filter(([, product]) => product.workspaceId === workspaceId).map(([id, product]) => [id, structuredClone(product)] as const))
    const created: ReturnType<typeof service.importProduct>[] = []
    const writes: BatchProductWrite[] = []
    try {
      for (const item of items) {
        const product = service.importProduct(item)
        created.push(product)
        writes.push({ product, version: product.version ?? 0 })
      }
      const batchId = `catalog_import_batch_${randomUUID()}`
      await persistSnapshotsAndEvent({ workspaceId, snapshots: created.map(product => ({ entityType: 'product' as const, entityId: product.id, entityVersion: product.version ?? 1, payload: product as unknown as Record<string, unknown> })), aggregateId: batchId, eventType: 'catalog.import.batch.completed', sequence: 1, eventPayload: { batch_id: batchId, count: created.length, product_ids: created.map(product => product.id), transport: 'rest' } })
      return send(res, 201, workspaceId, { batchId, count: created.length, products: created, atomic: true, factsConfirmationRequired: true }, null, req)
    } catch (error) {
      rollbackBatchProducts(service.products, workspaceId, writes, beforeProducts)
      throw error
    }
  }
  if (req.method === 'POST' && path === '/v1/products/import') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const rawSkus = Array.isArray(input.skus) ? input.skus : undefined
    const skus = rawSkus?.map((item: any) => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.price !== 'number' || typeof item.stock !== 'number') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'skus 必须包含 id、name、price、stock', 400)
      return { id: item.id.trim(), name: item.name.trim(), price: item.price, stock: item.stock, ...(Array.isArray(item.images) ? { images: item.images.filter((value: unknown): value is string => typeof value === 'string') } : {}) }
    })
    const rawSellingPoints = Array.isArray(input.selling_points) ? input.selling_points : undefined
    const sellingPoints = rawSellingPoints?.map((item: any, index: number) => ({ id: typeof item.id === 'string' ? item.id : `sp_${index + 1}`, text: typeof item.text === 'string' ? item.text : '', proofStatus: item.proof_status === 'confirmed' || item.proof_status === 'rejected' ? item.proof_status : 'pending', sourceIds: Array.isArray(item.source_ids) ? item.source_ids.filter((value: unknown): value is string => typeof value === 'string') : [] }))
    const rawAssetIds = input.asset_ids
    const sourceAssetIds = rawAssetIds === undefined ? undefined : Array.isArray(rawAssetIds) && rawAssetIds.length > 0 && rawAssetIds.length <= 50 && rawAssetIds.every(value => typeof value === 'string' && value.trim()) ? [...new Set(rawAssetIds.map(value => String(value).trim()))] : null
    if (sourceAssetIds === null || (sourceAssetIds && Array.isArray(rawAssetIds) && sourceAssetIds.length !== rawAssetIds.length)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'asset_ids 必须是最多 50 个不重复素材 ID 的数组', 400)
    const platform = required(input, 'platform') as Platform
    const accountId = typeof input.account_id === 'string' && input.account_id.trim() ? input.account_id.trim() : undefined
    if (!SUPPORTED_PLATFORMS.includes(platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
    if (isProduction() && !accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产商品导入必须绑定已授权平台账号', 400)
    if (accountId) service.getActivePlatformAccount(workspaceId, accountId, platform)
    const product = service.importProduct({ workspaceId, platform, ...(accountId ? { accountId } : {}), ...(typeof input.remote_id === 'string' && input.remote_id.trim() ? { remoteId: input.remote_id } : {}), ...(typeof input.local_product_key === 'string' ? { localProductKey: input.local_product_key } : {}), title: required(input, 'title'), skuCount: typeof input.sku_count === 'number' ? input.sku_count : undefined, ...(skus ? { skus } : {}), stock: typeof input.stock === 'number' ? input.stock : undefined, price: typeof input.price === 'number' ? input.price : undefined, category: typeof input.category === 'string' ? input.category : undefined, images: Array.isArray(input.images) ? input.images.filter((item): item is string => typeof item === 'string') : undefined, ...(sourceAssetIds ? { sourceAssetIds } : {}), attributes: input.attributes && typeof input.attributes === 'object' && !Array.isArray(input.attributes) ? Object.fromEntries(Object.entries(input.attributes).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value as string])) : undefined, ...(sellingPoints ? { sellingPoints } : {}), storeName: typeof input.store_name === 'string' ? input.store_name : undefined, storeDifferentiation: typeof input.store_differentiation === 'string' ? input.store_differentiation : undefined })
    await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
    return send(res, 201, workspaceId, product, null, req)
  }
  const productConfirmMatch = path.match(/^\/v1\/products\/([^/]+)\/confirm$/)
  if (req.method === 'POST' && productConfirmMatch) {
    const workspaceId = resolveWorkspace(req)
    const product = service.confirmProductFacts(workspaceId, productConfirmMatch[1]!)
    await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
    return send(res, 200, workspaceId, product, null, req)
  }
  if (req.method === 'GET' && path === '/v1/platform-accounts') {
    const workspaceId = resolveWorkspace(req)
    const registered = service.listPlatformAccounts(workspaceId)
    const directory = new Map(workspaceStoreDirectory(workspaceId).map(store => [`${store.platform}:${store.accountId}`, store]))
    const items = SUPPORTED_PLATFORMS.flatMap(platform => {
      const accounts = registered.filter(item => item.platform === platform)
      const rows = accounts.length ? accounts : [undefined]
      return rows.map(account => {
        if (account) return { ...directory.get(`${platform}:${account.id}`), ...platformAccessFlags(platform, account), readiness: workspaceConnectorReadiness(platform) }
        return { platform, state: fixturePlatformEnabled(platform) ? 'fixture_ready' : connectorRuntime.isOAuthConfigured(platform) && !connectorRuntime.credentialProviderConfigured ? 'configured_provider_required' : connectorRuntime.isHttpConfigured(platform) ? 'configured' : connectorRuntime.isOAuthConfigured(platform) ? 'oauth_configured' : 'not_configured', ...platformAccessFlags(platform, account), readiness: workspaceConnectorReadiness(platform) }
      })
    })
    return send(res, 200, workspaceId, { items }, null, req)
  }

  const authorizeMatch = path.match(/^\/v1\/platform-accounts\/(jd|taobao|tmall|pinduoduo|xiaohongshu|douyin)\/authorize$/)
  if (req.method === 'POST' && authorizeMatch) {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const actorId = requestActor(req, typeof input.actor_id === 'string' && input.actor_id.trim() ? input.actor_id.trim() : 'actor_demo')
    const codeVerifier = randomBytes(32).toString('base64url')
    const state = await oauthStateStore.issue({ workspaceId, actorId, platform: authorizeMatch[1]!, codeVerifier, codeChallenge: hashPkceVerifier(codeVerifier) })
    const platform = authorizeMatch[1] as Platform
    const configuredRedirectUri = configuredOAuthRedirectUri(platform)
    const requestedRedirectUri = typeof input.redirect_uri === 'string' ? input.redirect_uri.trim() : undefined
    const redirectUri = isProduction() ? configuredRedirectUri ?? '' : requestedRedirectUri ?? configuredRedirectUri ?? 'http://127.0.0.1:8787/oauth/callback'
    if (!redirectUri || (isProduction() && (!validOAuthRedirectUri(platform, redirectUri) || (requestedRedirectUri && requestedRedirectUri !== configuredRedirectUri)))) throw new DomainError('OAUTH_REDIRECT_URI_REQUIRED', `生产 OAuth 必须配置匹配 ${platform} 回调路由的 HTTPS ${oauthRedirectEnv[platform]}（或 PUBLIC_OAUTH_REDIRECT_URI 模板）`, 503)
    if (!platformAuthorizationConfigured(platform)) throw new DomainError('NOT_CONFIGURED', `${platform} 官方 OAuth 尚未配置`, 503)
    if (isProduction() && !redisOAuthPort) throw new DomainError('OAUTH_STATE_STORE_UNAVAILABLE', '生产 OAuth 必须配置 Redis 状态存储，禁止使用单副本内存状态', 503)
    const result = await connectorRuntime.connector(platform).authorize({ workspaceId, actorId, redirectUri, state, codeVerifier })
    if (!result.ok) throw new DomainError(result.code ?? 'NOT_CONFIGURED', result.message ?? '平台官方 API 尚未配置', 503)
    return send(res, 200, workspaceId, result, null, req)
  }

  const syncMatch = path.match(/^\/v1\/platform-accounts\/(jd|taobao|tmall|pinduoduo|xiaohongshu|douyin)\/sync$/)
  if (req.method === 'POST' && syncMatch) {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const platform = syncMatch[1] as Platform
    if (!platformConnectorConfigured(platform)) throw new DomainError('NOT_CONFIGURED', `${platform} 官方 API 尚未配置，无法同步商品`, 503)
    const accountId = header(req, 'x-account-id')?.trim() || (typeof input.account_id === 'string' && input.account_id.trim()) || (isProduction() ? '' : defaultFixtureAccountId(workspaceId, platform))
    if (!accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产同步必须指定已授权平台账号', 400)
    const platformAccount = isProduction() || fixtureMode ? requireActivePlatformAccount(workspaceId, accountId, platform) : undefined
    const result = await connectorRuntime.sync(platform, { workspaceId, accountId, ...(platformAccount ? { credentialRef: platformAccount.credentialRef } : {}), traceId: requestId(req) }, typeof input.cursor === 'string' ? input.cursor : undefined)
    const products = service.upsertSyncedProducts({ workspaceId, platform, accountId, items: result.items })
    for (const product of products) await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
    const automation = await scanAutomationAfterOperationalCompletion(workspaceId, platform, accountId, 'platform-account.sync.completed')
    return send(res, 200, workspaceId, { ...result, products, automation }, null, req)
  }

  const revokeMatch = path.match(/^\/v1\/platform-accounts\/(jd|taobao|tmall|pinduoduo|xiaohongshu|douyin)$/)
  if (req.method === 'DELETE' && revokeMatch) {
    const workspaceId = resolveWorkspace(req)
    const platform = revokeMatch[1] as Platform
    const accountId = header(req, 'x-account-id')?.trim() || new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams.get('account_id')?.trim()
    if (!accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '撤销授权必须指定平台账号', 400)
    const account = service.revokePlatformAccount(workspaceId, accountId, platform)
    await persistSnapshot(workspaceId, 'platform_account', account, account as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, account.id, 'platform_account.revoked', account.revision, { account_id: account.id, platform, remote_revoked: false })
    try {
      await connectorRuntime.connector(platform).revoke({ accountId: account.remoteAccountId, credentialRef: account.credentialRef })
    } catch (error) {
      throw new DomainError('PLATFORM_REVOKE_REMOTE_FAILED', error instanceof Error ? error.message : '平台远端凭证撤销失败，本地账号已停止使用', 503)
    }
    return send(res, 200, workspaceId, { platform, accountId: account.id, state: account.tokenState, remoteRevoked: true }, null, req)
  }

  const callbackMatch = path.match(/^\/v1\/oauth\/callback\/(jd|taobao|tmall|pinduoduo|xiaohongshu|douyin)$/)
  if (req.method === 'GET' && callbackMatch) {
    if (isProduction() && !redisOAuthPort) throw new DomainError('OAUTH_STATE_STORE_UNAVAILABLE', '生产 OAuth 必须配置 Redis 状态存储，禁止使用单副本内存状态', 503)
    const state = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code') ?? ''
    if (!code) throw new DomainError(ERROR_CODES.OAUTH_CODE_REQUIRED, 'OAuth callback code is required', 400)
    const suppliedWorkspace = header(req, 'x-workspace-id')?.trim()
    const callback = suppliedWorkspace
      ? await oauthStateStore.consume(state, { workspaceId: suppliedWorkspace, platform: callbackMatch[1]! })
      : await oauthStateStore.consumeCallback(state, callbackMatch[1]!)
    const credential = await connectorRuntime.connector(callbackMatch[1] as Platform).exchangeCode({ code, state, workspaceId: callback.workspaceId, ...(callback.codeVerifier ? { codeVerifier: callback.codeVerifier } : {}) })
    // credentialRef/secret remains inside the connector/vault boundary.
    const account = service.registerPlatformAccount({
      workspaceId: callback.workspaceId,
      platform: callback.platform as Platform,
      remoteAccountId: credential.accountId,
      credentialRef: credential.credentialRef,
      grantedScopes: grantedScopes(credential.scope),
      accessTokenExpiresAt: credential.expiresAt,
      credentialRefreshable: credential.refreshable,
    })
    await persistSnapshot(callback.workspaceId, 'platform_account', account, account as unknown as Record<string, unknown>)
    let initialSync: Record<string, unknown> = { state: 'not_started', reason: 'connector_not_ready' }
    if (platformConnectorConfigured(callback.platform as Platform)) {
      const job = service.createSyncJob({ workspaceId: callback.workspaceId, platform: callback.platform as Platform, accountId: account.id, mode: 'full' })
      await persistSnapshot(callback.workspaceId, 'sync_job', job, job as unknown as Record<string, unknown>)
      await persistEvent(callback.workspaceId, job.id, 'sync.requested', job.revision, { job_id: job.id, platform: callback.platform, account_id: account.id, mode: job.mode })
      initialSync = { state: 'queued', jobId: job.id }
    }
    const store = workspaceStoreDirectory(callback.workspaceId, callback.platform as Platform).find(item => item.accountId === account.id)
    if (wantsOAuthHtml(req)) return sendOAuthCallbackPage(res, 200, { state: 'success', platform: callback.platform, ...(store?.label ? { storeLabel: store.label } : {}), syncState: String(initialSync.state) }, req)
    return send(res, 200, callback.workspaceId, {
      platform: callback.platform,
      accountId: account.id,
      remoteAccountId: account.remoteAccountId,
      connected: true,
      tokenState: 'stored_in_vault',
      ...(store ? { store } : {}),
      initialSync,
      nextActions: [
        'refresh_workspace_health',
        'select_store_by_platform_and_account_id',
        ...(initialSync.state === 'queued' ? [] : ['start_catalog_sync_with_account_id']),
      ],
    }, null, req)
  }
  if (path === '/v1/sync-jobs' && req.method === 'POST') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const platform = String(input.platform ?? '') as Platform
    if (!SUPPORTED_PLATFORMS.includes(platform as Platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
    if (!platformConnectorConfigured(platform)) throw new DomainError('NOT_CONFIGURED', `${platform} 官方 API 尚未配置，无法同步商品`, 503)
    const accountId = (typeof input.account_id === 'string' && input.account_id.trim()) || header(req, 'x-account-id')?.trim() || (isProduction() ? '' : defaultFixtureAccountId(workspaceId, platform))
    if (!accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产同步必须指定已授权平台账号', 400)
    if (isProduction()) service.getActivePlatformAccount(workspaceId, accountId, platform)
    // REST worker acceptance flows may enqueue before a worker starts. In the
    // local fixture, materialize the same logical account used by the MCP
    // path so normalized product rows satisfy their account foreign key.
    await ensureFixtureAccount(workspaceId, platform, accountId)
    const job = service.createSyncJob({ workspaceId, platform, accountId, mode: input.mode === 'full' ? 'full' : 'incremental', ...(typeof input.cursor === 'string' && input.cursor.trim() ? { cursor: input.cursor } : {}) })
    await persistSnapshot(workspaceId, 'sync_job', job, job as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, job.id, 'sync.requested', job.revision, { job_id: job.id, platform, account_id: accountId, mode: job.mode, ...(job.resumeCursor ? { cursor: job.resumeCursor } : {}) })
    return send(res, 202, workspaceId, job, null, req)
  }
  if (path === '/v1/ops/data-deletion/complete' && req.method === 'POST') {
    requireWorkerAuthorization(req)
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const workerId = headerRequired(req, 'x-worker-id')
    const proofRef = typeof input.execution_proof_ref === 'string' ? input.execution_proof_ref.trim() : ''
    if (!proofRef || proofRef.length > 500 || /[\r\n]/u.test(proofRef)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'execution_proof_ref 必须是单行、非空的外部证据引用', 400)
    await persistenceReady
    const completed = await (persistence.dataLifecycle ?? memoryDataLifecycle).complete({ workspaceId, id: required(input, 'request_id'), workerId, proofRef })
    await recordOperationAudit({ workspaceId, actorId: workerId, action: 'data.delete.complete', resourceType: 'data_deletion_request', resourceId: completed.id, before: { status: 'approved' }, after: completed as unknown as Record<string, unknown>, reason: `外部删除证明：${proofRef}` })
    return send(res, 200, workspaceId, { ...completed, execution: 'external_proof_recorded' }, null, req)
  }
  if (path === '/v1/internal/storage/orphans/cleanup' && req.method === 'POST') {
    requireWorkerAuthorization(req)
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    await persistenceReady
    const cleanup = await cleanObjectStorageOrphans({ workspaceId, repository: persistence.objectOrphans ?? memoryObjectOrphans, limit: typeof input.limit === 'number' ? input.limit : 100, deleteObject: objectKey => getAssetStorage().delete(workspaceId, objectKey, { includeQuarantine: true }) })
    if (cleanup.manualAttention > 0) {
      const alert = await (persistence.alerts ?? memoryAlerts).upsert({ workspaceId, alertKey: `storage-orphans:${workspaceId}`, code: 'OBJECT_STORAGE_ORPHAN_MANUAL_ATTENTION', severity: 'high', entityType: 'object_storage', entityId: workspaceId, title: `${cleanup.manualAttention} 个对象清理失败，需人工处理`, observedAt: new Date().toISOString(), evidence: cleanup as unknown as Record<string, unknown>, nextAction: '在运营后台核对对象键和存储服务状态，人工删除后关闭告警。' })
      void notifyOperationalAlert(alert).catch(() => undefined)
    }
    return send(res, 200, workspaceId, cleanup, null, req)
  }
  const syncProgressMatch = path.match(/^\/v1\/sync-jobs\/([^/]+)\/progress$/)
  if (req.method === 'POST' && syncProgressMatch) {
    requireWorkerAuthorization(req)
    const workspaceId = resolveWorkspace(req)
    const input = await body(req)
    const job = service.getSyncJob(workspaceId, syncProgressMatch[1]!)
    const pageNumber = Number(input.page_number)
    if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'page_number 无效', 400)
    if (pageNumber <= job.pages) return send(res, 200, workspaceId, job, null, req)
    if (!Array.isArray(input.items)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'items 必须是数组', 400)
    const mappedItems = input.items.filter(isObject).map(item => ({
      remoteId: typeof item.remoteId === 'string' ? item.remoteId : typeof item.remote_id === 'string' ? item.remote_id : '',
      title: typeof item.title === 'string' ? item.title : '',
      sku: Array.isArray(item.sku) ? item.sku : [],
      stock: typeof item.stock === 'number' ? item.stock : 0,
      source: item.source === 'fixture' ? 'fixture' as const : 'official_api' as const,
      ...(typeof item.price === 'number' ? { price: item.price } : {}),
      ...(typeof item.category === 'string' ? { category: item.category } : {}),
      ...(Array.isArray(item.images) ? { images: item.images.filter((value): value is string => typeof value === 'string') } : {}),
      ...(isObject(item.attributes) ? { facts: Object.fromEntries(Object.entries(item.attributes).filter(([, value]) => typeof value === 'string' || typeof value === 'number').map(([key, value]) => [key, value as string | number])) } : {}),
      raw: item,
    }))
    const invalidItems = mappedItems.filter(item => !item.remoteId || !item.title)
    const items = mappedItems.filter(item => item.remoteId && item.title)
    const failures = invalidItems.map(item => ({ id: `sync-failure-${job.id}-${pageNumber}-${item.remoteId || 'unknown'}`, ...(item.remoteId ? { remoteId: item.remoteId } : {}), ...(typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}), pageNumber, code: 'PRODUCT_REQUIRED_FIELD_MISSING', message: !item.remoteId ? '平台商品缺少 remote_id' : '平台商品缺少 title', raw: item.raw, retryable: true, createdAt: new Date().toISOString() }))
    const products = service.upsertSyncedProducts({ workspaceId, platform: job.platform, accountId: job.accountId, items })
    const updated = service.updateSyncJob(workspaceId, job.id, { state: 'running', pages: pageNumber, itemsUpserted: job.itemsUpserted + products.length, itemsFailed: job.itemsFailed + failures.length, failedItems: [...job.failedItems, ...failures], ...(typeof input.next_cursor === 'string' && input.next_cursor ? { nextCursor: input.next_cursor, resumeCursor: input.next_cursor } : {}) })
    await persistSnapshotsAndEvent({
      workspaceId,
      snapshots: [
        ...products.map(product => ({ entityType: 'product' as const, entityId: product.id, entityVersion: product.version ?? 1, payload: product as unknown as Record<string, unknown> })),
        { entityType: 'sync_job', entityId: updated.id, entityVersion: updated.revision, payload: updated as unknown as Record<string, unknown> },
      ],
      aggregateId: updated.id,
      eventType: 'sync.progress',
      sequence: pageNumber,
      eventPayload: { job_id: updated.id, page_number: pageNumber, items_upserted: products.length, items_failed: failures.length, failed_items: failures, ...(updated.nextCursor ? { next_cursor: updated.nextCursor } : {}) },
    })
    return send(res, 200, workspaceId, updated, null, req)
  }
  const syncResultMatch = path.match(/^\/v1\/sync-jobs\/([^/]+)\/result$/)
  if (req.method === 'POST' && syncResultMatch) {
    requireWorkerAuthorization(req)
    const workspaceId = resolveWorkspace(req)
    const input = await body(req)
    const job = service.getSyncJob(workspaceId, syncResultMatch[1]!)
    const state = input.state === 'failed' || input.state === 'partial' ? input.state : 'succeeded'
    const updated = service.updateSyncJob(workspaceId, job.id, { state, ...(state === 'succeeded' ? { nextCursor: undefined, resumeCursor: undefined } : {}), ...(typeof input.error_message === 'string' ? { errorMessage: input.error_message } : {}) })
    if (state === 'failed') {
      const syncEntitlementKey = `bulk-sync-job:${job.id}`
      const entitlement = await refundEntitlement({ workspaceId, actionKey: syncEntitlementKey, reason: '异步商品批量同步失败' })
      if (!entitlement.refunded && isProduction()) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: `sync:${syncEntitlementKey}`, actorId: 'worker', reason: '异步商品批量同步失败' })
    }
    await persistSnapshot(workspaceId, 'sync_job', updated, updated as unknown as Record<string, unknown>)
    const automation = state === 'succeeded' || state === 'partial'
      ? await scanAutomationAfterOperationalCompletion(workspaceId, job.platform, job.accountId, `sync-job.result.${state}`)
      : { triggered: false as const, reason: 'sync_failed' as const }
    return send(res, 200, workspaceId, { ...updated, automation }, null, req)
  }
  const syncExecutionContextMatch = path.match(/^\/v1\/sync-jobs\/([^/]+)\/execution-context$/)
  if (req.method === 'GET' && syncExecutionContextMatch) {
    requireWorkerCredentialAuthorization(req)
    const workspaceId = resolveWorkspace(req)
    const job = service.getSyncJob(workspaceId, syncExecutionContextMatch[1]!)
    const account = service.getActivePlatformAccount(workspaceId, job.accountId, job.platform)
    return send(res, 200, workspaceId, { job_id: job.id, account_id: account.id, credential_ref: account.credentialRef }, null, req)
  }
  const syncJobMatch = path.match(/^\/v1\/sync-jobs\/([^/]+)$/)
  const syncRetryMatch = path.match(/^\/v1\/sync-jobs\/([^/]+)\/retry-failed$/)
  if (req.method === 'POST' && syncRetryMatch) {
    const workspaceId = resolveWorkspace(req)
    const input = await body(req)
    const failureIds = Array.isArray(input.failure_ids) ? input.failure_ids.filter((value): value is string => typeof value === 'string') : undefined
    const jobs = service.retrySyncFailures(workspaceId, syncRetryMatch[1]!, failureIds)
    for (const job of jobs) {
      await persistSnapshot(workspaceId, 'sync_job', job, job as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, job.id, 'sync.requested', job.revision, { job_id: job.id, platform: job.platform, account_id: job.accountId, mode: job.mode, ...(job.resumeCursor ? { cursor: job.resumeCursor } : {}), retry_of: syncRetryMatch[1] })
    }
    return send(res, 202, workspaceId, { jobs }, null, req)
  }
  if (req.method === 'GET' && path === '/v1/sync-jobs') {
    const workspaceId = resolveWorkspace(req, url.searchParams.get('workspace_id') ?? undefined)
    return send(res, 200, workspaceId, service.listSyncJobs(workspaceId), null, req)
  }
  if (req.method === 'GET' && syncJobMatch) {
    const workspaceId = resolveWorkspace(req)
    return send(res, 200, workspaceId, service.getSyncJob(workspaceId, syncJobMatch[1]!), null, req)
  }
  if (req.method === 'GET' && path === '/v1/publish-jobs') {
    const workspaceId = resolveWorkspace(req, url.searchParams.get('workspace_id') ?? undefined)
    return send(res, 200, workspaceId, service.listPublishJobs(workspaceId), null, req)
  }
  if (req.method === 'POST' && path === '/v1/tasks/understand') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    return send(res, 200, workspaceId, service.understandTaskRequest(workspaceId, required(input, 'request_text')), null, req)
  }
  if (req.method === 'POST' && path === '/v1/task-groups') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    if (!Array.isArray(input.entries)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'entries 必须是数组', 400)
    const entries = input.entries.map(entry => {
      if (!isObject(entry) || typeof entry.product_id !== 'string' || typeof entry.platform !== 'string') throw new DomainError(ERROR_CODES.INVALID_REQUEST, '每个子任务必须包含 product_id 和 platform', 400)
      if (!SUPPORTED_PLATFORMS.includes(entry.platform as Platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '子任务平台无效', 400)
      const platform = entry.platform as Platform
      const accountId = resolveProductTaskAccount(workspaceId, platform, entry.product_id, typeof entry.account_id === 'string' ? entry.account_id : undefined)
      requireProductionTaskStore(platform, accountId)
      if ((isProduction() || fixtureMode) && accountId) service.getActivePlatformAccount(workspaceId, accountId, platform)
      return { productId: entry.product_id, platform, ...(accountId ? { accountId } : {}), ...(typeof entry.region === 'string' && entry.region.trim() ? { region: entry.region.trim() } : {}), ...(typeof entry.sku_id === 'string' && entry.sku_id.trim() ? { skuId: entry.sku_id.trim() } : {}) }
    })
    for (const entry of entries) await requireEnabledPlatform(workspaceId, entry.platform)
    const idempotencyKey = header(req, 'idempotency-key')?.trim() || (typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : '')
    const group = service.createTaskGroup({ workspaceId, entries, ...(typeof input.request_text === 'string' ? { requestText: input.request_text } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) })
    if (!group.replayed) for (const task of group.tasks) {
      await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, task.id, 'task.created', task.version, { ...task, task_group_id: group.id })
    }
    return send(res, 201, workspaceId, group, null, req)
  }
  if (req.method === 'POST' && path === '/v1/task-requests') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const requestText = required(input, 'request_text')
    const understanding = service.understandTaskRequest(workspaceId, requestText)
    requireProductionRequestStores(workspaceId, understanding)
    for (const platform of understanding.platformCandidates) await requireEnabledPlatform(workspaceId, platform)
    const idempotencyKey = header(req, 'idempotency-key')?.trim() || (typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : '')
    const created = service.createTaskFromRequest({ workspaceId, requestText, ...(idempotencyKey ? { idempotencyKey } : {}) })
    if (!created.replayed) for (const task of created.tasks) {
      await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, task.id, 'task.created', task.version, { ...task, ...(created.taskGroupId ? { task_group_id: created.taskGroupId } : {}), source: 'natural_language_request' })
    }
    return send(res, 201, workspaceId, created, null, req)
  }
  const skuSplitMatch = path.match(/^\/v1\/tasks\/([^/]+)\/sku-split$/)
  if (req.method === 'POST' && skuSplitMatch) {
    const source = scopeTask(req, skuSplitMatch[1]!)
    const input = await body(req)
    const idempotencyKey = header(req, 'idempotency-key')?.trim() || (typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : '')
    const split = service.splitTaskBySku({ workspaceId: source.workspaceId, taskId: source.id, ...(idempotencyKey ? { idempotencyKey } : {}) })
    if (!split.replayed) for (const task of split.tasks) {
      await persistSnapshot(source.workspaceId, 'task', task, task as unknown as Record<string, unknown>)
      await persistEvent(source.workspaceId, task.id, 'task.created', task.version, { ...task, task_group_id: split.taskGroupId, source: 'sku_split' })
    }
    await persistEvent(source.workspaceId, split.sourceTaskId, 'task.sku_split', source.version, { source_task_id: split.sourceTaskId, task_group_id: split.taskGroupId, sku_ids: split.skuIds, replayed: split.replayed })
    return send(res, 201, source.workspaceId, split, null, req)
  }
  if (req.method === 'POST' && path === '/v1/tasks') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const taskPlatform = required(input, 'platform') as Platform
    await requireEnabledPlatform(workspaceId, taskPlatform)
    const productId = required(input, 'product_id')
    const taskAccountId = resolveProductTaskAccount(workspaceId, taskPlatform, productId, typeof input.account_id === 'string' ? input.account_id : undefined)
    requireProductionTaskStore(taskPlatform, taskAccountId)
    if ((isProduction() || fixtureMode) && taskAccountId) service.getActivePlatformAccount(workspaceId, taskAccountId, taskPlatform)
    const createdTask = service.createTask({ workspaceId, productId, platform: taskPlatform, ...(taskAccountId ? { accountId: taskAccountId } : {}), ...(typeof input.region === 'string' ? { region: input.region } : {}), ...(typeof input.request_text === 'string' && input.request_text.trim() ? { requestText: input.request_text.trim() } : {}) })
    const task = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers)
      ? service.answerTask(workspaceId, createdTask.id, input.answers as Record<string, string | number | boolean | string[]>, createdTask.version)
      : createdTask
    await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, task.id, 'task.created', task.version, task as unknown as Record<string, unknown>)
    return send(res, 201, workspaceId, task, null, req)
  }
  const taskAnswersMatch = path.match(/^\/v1\/tasks\/([^/]+)\/answers$/)
  if (req.method === 'POST' && taskAnswersMatch) {
    const task = scopeTask(req, taskAnswersMatch[1]!)
    const input = await body(req)
    if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'answers 必须是对象', 400)
    const answered = service.answerTask(task.workspaceId, task.id, input.answers as Record<string, string | number | boolean | string[]>, typeof input.expected_version === 'number' ? input.expected_version : undefined)
    await persistSnapshot(task.workspaceId, 'task', answered, answered as unknown as Record<string, unknown>)
    await persistEvent(task.workspaceId, task.id, 'task.answers_submitted', answered.version, { task_id: task.id, input_snapshot_id: answered.inputSnapshotId, answers: answered.answers, missing_questions: answered.missingQuestions })
    return send(res, 200, task.workspaceId, answered, null, req)
  }
  const taskVersionsMatch = path.match(/^\/v1\/tasks\/([^/]+)\/content-versions$/)
  if (req.method === 'GET' && taskVersionsMatch) {
    const task = scopeTask(req, taskVersionsMatch[1]!)
    return send(res, 200, task.workspaceId, service.listContentVersions(task.workspaceId, task.id), null, req)
  }
  const taskTimelineMatch = path.match(/^\/v1\/tasks\/([^/]+)\/timeline$/)
  if (req.method === 'GET' && taskTimelineMatch) {
    const task = scopeTask(req, taskTimelineMatch[1]!)
    const requestedLimit = url.searchParams.get('limit')
    return send(res, 200, task.workspaceId, await taskTimeline(task.workspaceId, task.id, requestedLimit ? Number(requestedLimit) : 100), null, req)
  }
  const feedbackMatch = path.match(/^\/v1\/tasks\/([^/]+)\/feedback$/)
  if (req.method === 'GET' && feedbackMatch) {
    const task = scopeTask(req, feedbackMatch[1]!)
    return send(res, 200, task.workspaceId, service.listFeedback(task.workspaceId, task.id), null, req)
  }
  if (req.method === 'POST' && feedbackMatch) {
    const task = scopeTask(req, feedbackMatch[1]!)
    const input = await body(req)
    const rating = required(input, 'rating')
    if (!['liked', 'neutral', 'needs_improvement'].includes(rating)) throw new DomainError('FEEDBACK_RATING_INVALID', '反馈评级无效', 400)
    const feedback = service.submitFeedback({
      workspaceId: task.workspaceId, taskId: task.id, rating: rating as 'liked' | 'neutral' | 'needs_improvement',
      ...(typeof input.content_version_id === 'string' ? { contentVersionId: input.content_version_id } : {}),
      ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
      ...(typeof input.comment === 'string' ? { comment: input.comment } : {}),
      actorId: requestActor(req, 'actor_demo'),
    })
    await persistSnapshot(task.workspaceId, 'feedback', feedback, feedback as unknown as Record<string, unknown>)
    await persistEvent(task.workspaceId, feedback.id, 'task_feedback_submitted', feedback.revision, feedback as unknown as Record<string, unknown>)
    return send(res, 201, task.workspaceId, feedback, null, req)
  }
  const taskGetMatch = path.match(/^\/v1\/tasks\/([^/]+)$/)
  if (req.method === 'GET' && taskGetMatch) {
    const task = scopeTask(req, taskGetMatch[1]!)
    return send(res, 200, task.workspaceId, task, null, req)
  }
  const directionMatch = path.match(/^\/v1\/tasks\/([^/]+)\/directions$/)
  if (req.method === 'GET' && directionMatch) {
    const task = scopeTask(req, directionMatch[1]!)
    return send(res, 200, task.workspaceId, service.listCreativeDirections(task.workspaceId, task.id), null, req)
  }
  if (req.method === 'POST' && directionMatch) {
    const task = scopeTask(req, directionMatch[1]!)
    const input = await body(req)
    const selected = service.selectDirection(directionMatch[1]!, required(input, 'direction_id'), typeof input.expected_version === 'number' ? input.expected_version : undefined)
    await persistSnapshot(task.workspaceId, 'task', selected, selected as unknown as Record<string, unknown>)
    await persistEvent(task.workspaceId, selected.id, 'task.direction_selected', selected.version, { task_id: selected.id, direction_id: selected.selectedDirectionId ?? null })
    return send(res, 200, task.workspaceId, selected, null, req)
  }
  const planConfirmMatch = path.match(/^\/v1\/tasks\/([^/]+)\/plan\/confirm$/)
  if (req.method === 'POST' && planConfirmMatch) {
    const task = scopeTask(req, planConfirmMatch[1]!)
    const input = await body(req)
    const priceImpactConfirmed = input.price_impact_confirmed === true || input.price_impact_confirmed === 'true'
    const confirmed = service.confirmProductionPlan(task.workspaceId, task.id, requestActor(req, typeof input.actor_id === 'string' && input.actor_id.trim() ? input.actor_id.trim() : 'merchant'), typeof input.expected_version === 'number' ? input.expected_version : undefined, priceImpactConfirmed)
    await persistSnapshot(task.workspaceId, 'task', confirmed, confirmed as unknown as Record<string, unknown>)
    await persistEvent(task.workspaceId, confirmed.id, 'task.plan_confirmed', confirmed.version, { task_id: confirmed.id, plan_id: confirmed.productionPlan?.id ?? null, actor_id: confirmed.productionPlan?.confirmedBy ?? null })
    return send(res, 200, task.workspaceId, confirmed, null, req)
  }
  async function runFixtureGenerationJob(workspaceId: string, jobId: string) {
    try {
      const job = service.getGenerationJob(workspaceId, jobId)
      if (job.state !== 'queued') return
      const task = service.getTask(job.taskId)
      const rulePreflightBeforeWrite = await requireGenerationRulePreflight(workspaceId, task.productId, '生成前平台规则校验未通过')
      const completed = service.completeGeneration({ workspaceId, jobId, body: service.fixtureDraftBody(task.id) })
      const completedTask = service.getTask(completed.job.taskId)
      const rulePreflight = service.reviewContentReport(workspaceId, completed.version.id, { ...(await evaluationRules(workspaceId, ruleContextForTask(completedTask)) ?? { availableRuleVersionIds: [], forbiddenTerms: [], ruleHits: [] }), ruleHits: rulePreflightBeforeWrite.rule_hits })
      await persistSnapshot(workspaceId, 'content_version', completed.version, completed.version as unknown as Record<string, unknown>)
      await persistSnapshot(workspaceId, 'task', completedTask, completedTask as unknown as Record<string, unknown>)
      await persistSnapshot(workspaceId, 'generation_job', completed.job, completed.job as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, completed.job.id, 'generation.completed', completed.job.revision, { job_id: completed.job.id, task_id: completed.job.taskId, content_version_id: completed.version.id, version: completed.version.version, execution: executionContract('content', false), rule_preflight: { blocking: rulePreflight.blocking, finding_count: rulePreflight.findings.length, rule_hits: rulePreflight.ruleHits ?? [] } })
      await releaseDistributedJobSlot(workspaceId, `generation:${completed.job.idempotencyKey}`)
    } catch (error) {
      const job = service.getGenerationJob(workspaceId, jobId)
      if (job.state === 'succeeded' || job.state === 'failed') return
      const failed = service.failGeneration({ workspaceId, jobId, code: error instanceof DomainError ? error.code : 'FIXTURE_GENERATION_FAILED', message: error instanceof Error ? error.message : '本地演示生成失败' })
      await persistSnapshot(workspaceId, 'generation_job', failed, failed as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, failed.id, 'generation.failed', failed.revision, { job_id: failed.id, task_id: failed.taskId, error_code: failed.errorCode ?? 'FIXTURE_GENERATION_FAILED', error_message: failed.errorMessage ?? '本地演示生成失败' })
      await refundTaskUsage(workspaceId, failed.taskId, `generation:${failed.idempotencyKey}`, 'fixture-worker', '本地演示内容生成失败')
      await releaseDistributedJobSlot(workspaceId, `generation:${failed.idempotencyKey}`)
    }
  }

  const generationJobCreateMatch = path.match(/^\/v1\/tasks\/([^/]+)\/content-jobs$/)
  if (req.method === 'POST' && generationJobCreateMatch) {
    const task = scopeTask(req, generationJobCreateMatch[1]!)
    const input = await body(req)
    const idempotencyKey = header(req, 'idempotency-key')?.trim() || (typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : '')
    if (!idempotencyKey) throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, '生成任务必须携带 Idempotency-Key', 400)
    const product = service.products.get(task.productId)
    if (!product || product.workspaceId !== task.workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品快照不存在或不属于当前工作区', 404)
    await requirePluginWalletAccess(task.workspaceId)
    const rulePreflight = await requireGenerationRulePreflight(task.workspaceId, product.id)
    requirePlatformModelCostGate('text')
    let existing = [...service.generationJobs.values()].find(candidate => candidate.workspaceId === task.workspaceId && candidate.idempotencyKey === idempotencyKey)
    if (!existing) {
      await hydrateDurableIdempotentJob(task.workspaceId, 'generation_job', idempotencyKey)
      existing = [...service.generationJobs.values()].find(candidate => candidate.workspaceId === task.workspaceId && candidate.idempotencyKey === idempotencyKey)
    }
    if (existing) return send(res, 202, task.workspaceId, { ...jobWithQueueMetadata(existing, task.workspaceId, 'generation'), rule_preflight: rulePreflight }, null, req)
    const reservationId = `generation:${idempotencyKey}`
    const reserved = await reserveDistributedJobSlot(task.workspaceId, reservationId)
    const usageKey = `generation:${idempotencyKey}`
    const usage = await consumeTaskUsage(task.workspaceId, task.id, usageKey, requestActor(req))
    try {
      const prepared = await service.prepareGenerationContext(task.id, `model:${usageKey}`)
      const job = service.enqueueGeneration({ workspaceId: task.workspaceId, taskId: task.id, idempotencyKey })
      await persistSnapshot(task.workspaceId, 'generation_job', job, job as unknown as Record<string, unknown>)
      if (job.state === 'queued' && job.revision === 1) {
        await persistEvent(task.workspaceId, job.id, 'generation.requested', 1, {
          job_id: job.id, task_id: task.id, campaign_item_id: task.campaignItemId ?? null, platform: task.platform, direction_id: task.selectedDirectionId ?? 'default', action_id: `model:${usageKey}`,
          context_link_id: prepared.contextRef?.id ?? null, context_hash: prepared.contextRef?.contextHash ?? contextEnvelopeHash(prepared.input as unknown as Record<string, unknown>), input_tokens_estimate: prepared.inputTokensEstimate, max_input_tokens: prepared.maxInputTokens, input: prepared.input,
        })
      }
      if ((fixtureMode || process.env.CONNECTOR_FIXTURE_MODE === 'true') && job.state === 'queued' && job.revision === 1) setTimeout(() => void runFixtureGenerationJob(task.workspaceId, job.id), 0)
      return send(res, 202, task.workspaceId, { ...jobWithQueueMetadata(job, task.workspaceId, 'generation'), rule_preflight: rulePreflight }, null, req)
    } catch (error) {
      if ((usage.charged || usage.walletDebited) && !existing) await refundTaskUsage(task.workspaceId, task.id, usageKey, requestActor(req), '异步生成任务创建失败')
      if (reserved) await releaseDistributedJobSlot(task.workspaceId, reservationId)
      throw error
    }
  }
  const generationJobGetMatch = path.match(/^\/v1\/generation-jobs\/([^/]+)$/)
  if (req.method === 'GET' && generationJobGetMatch) {
    const job = service.getGenerationJob(resolveWorkspace(req), generationJobGetMatch[1]!)
    return send(res, 200, job.workspaceId, jobWithQueueMetadata(job, job.workspaceId, 'generation'), null, req)
  }
  const generationJobDeferMatch = path.match(/^\/v1\/generation-jobs\/([^/]+)\/defer$/)
  if (req.method === 'POST' && generationJobDeferMatch) {
    requireWorkerAuthorization(req)
    const workspaceId = resolveWorkspace(req)
    const input = await body(req)
    const retryAfterSeconds = typeof input.retry_after_seconds === 'number' && Number.isFinite(input.retry_after_seconds) ? Math.max(1, Math.ceil(input.retry_after_seconds)) : 60
    const deferred = service.deferGeneration({ workspaceId, jobId: generationJobDeferMatch[1]!, code: typeof input.code === 'string' ? input.code : 'QUOTA_EXHAUSTED', message: typeof input.message === 'string' ? input.message : '模型/平台配额暂满，任务将在配额窗口恢复后重试', retryAfterSeconds })
    await persistSnapshot(workspaceId, 'generation_job', deferred, deferred as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, deferred.id, 'generation.deferred', deferred.revision, { job_id: deferred.id, task_id: deferred.taskId, code: deferred.errorCode ?? 'QUOTA_EXHAUSTED', retry_after_seconds: retryAfterSeconds, next_attempt_at: deferred.nextAttemptAt })
    return send(res, 200, workspaceId, jobWithQueueMetadata(deferred, workspaceId, 'generation'), null, req)
  }
  const generationJobResultMatch = path.match(/^\/v1\/generation-jobs\/([^/]+)\/result$/)
  if (req.method === 'POST' && generationJobResultMatch) {
    requireWorkerAuthorization(req)
    const workspaceId = resolveWorkspace(req)
    const input = await body(req)
    const job = service.getGenerationJob(workspaceId, generationJobResultMatch[1]!)
    if (input.error && typeof input.error === 'object' && !Array.isArray(input.error)) {
      const error = input.error as Record<string, unknown>
      const failed = service.failGeneration({ workspaceId, jobId: job.id, code: typeof error.code === 'string' ? error.code : 'AI_GENERATION_FAILED', message: typeof error.message === 'string' ? error.message : '内容生成失败' })
      await persistSnapshot(workspaceId, 'generation_job', failed, failed as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, failed.id, 'generation.failed', failed.revision, { job_id: failed.id, task_id: failed.taskId, error_code: failed.errorCode ?? 'AI_GENERATION_FAILED', error_message: failed.errorMessage ?? '内容生成失败' })
      if (!providerSucceededButSettlementPending(error)) await refundTaskUsage(workspaceId, failed.taskId, `generation:${failed.idempotencyKey}`, header(req, 'x-actor-id')?.trim() || 'worker', '异步内容生成失败')
      await releaseDistributedJobSlot(workspaceId, `generation:${failed.idempotencyKey}`)
      return send(res, 200, workspaceId, failed, null, req)
    }
    if (!input.content || typeof input.content !== 'object' || Array.isArray(input.content)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '缺少生成内容', 400)
    const content = input.content as Record<string, unknown>
    const sellingPoints = Array.isArray(content.sellingPoints) ? content.sellingPoints.filter((value): value is string => typeof value === 'string') : []
    if (typeof content.title !== 'string' || typeof content.detail !== 'string' || !sellingPoints.length) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '生成内容结构无效', 400)
    const brief = readStaticBrief(content.brief)
    const modules = readContentModules(content.modules)
    const completedTaskBeforeWrite = service.getTask(job.taskId)
    let rulePreflightBeforeWrite: Awaited<ReturnType<typeof generationRulePreflight>>
    try {
      rulePreflightBeforeWrite = await requireGenerationRulePreflight(workspaceId, completedTaskBeforeWrite.productId, '排队期间平台规则已发生变化，不能提交该生成结果')
    } catch (error) {
      const failed = service.failGeneration({ workspaceId, jobId: job.id, code: error instanceof DomainError ? error.code : 'PLATFORM_RULE_PREFLIGHT_BLOCKED', message: error instanceof Error ? error.message : '排队期间平台规则已发生变化，不能提交该生成结果' })
      await persistSnapshot(workspaceId, 'generation_job', failed, failed as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, failed.id, 'generation.failed', failed.revision, { job_id: failed.id, task_id: failed.taskId, error_code: failed.errorCode ?? 'PLATFORM_RULE_PREFLIGHT_BLOCKED', error_message: failed.errorMessage ?? '排队期间平台规则已发生变化，不能提交该生成结果' })
      await refundTaskUsage(workspaceId, failed.taskId, `generation:${failed.idempotencyKey}`, header(req, 'x-actor-id')?.trim() || 'worker', '排队期间平台规则变化导致生成阻断')
      await releaseDistributedJobSlot(workspaceId, `generation:${failed.idempotencyKey}`)
      throw error
    }
    const completed = service.completeGeneration({ workspaceId, jobId: job.id, body: { title: content.title, detail: content.detail, sellingPoints, ...(modules ? { modules } : {}), ...(brief ? { brief } : {}) } })
    const completedTask = service.getTask(completed.job.taskId)
    const rulePreflight = service.reviewContentReport(workspaceId, completed.version.id, { ...(await evaluationRules(workspaceId, ruleContextForTask(completedTask)) ?? { availableRuleVersionIds: [], forbiddenTerms: [], ruleHits: [] }), ruleHits: rulePreflightBeforeWrite.rule_hits })
    await persistSnapshot(workspaceId, 'content_version', completed.version, completed.version as unknown as Record<string, unknown>)
    await persistSnapshot(workspaceId, 'task', completedTask, completedTask as unknown as Record<string, unknown>)
    await persistSnapshot(workspaceId, 'generation_job', completed.job, completed.job as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, completed.job.id, 'generation.completed', completed.job.revision, { job_id: completed.job.id, task_id: completed.job.taskId, content_version_id: completed.version.id, version: completed.version.version, rule_preflight: { blocking: rulePreflight.blocking, finding_count: rulePreflight.findings.length, rule_hits: rulePreflight.ruleHits ?? [] } })
    await releaseDistributedJobSlot(workspaceId, `generation:${completed.job.idempotencyKey}`)
    return send(res, 200, workspaceId, { ...jobWithQueueMetadata(completed.job, workspaceId, 'generation'), rule_preflight: rulePreflight }, null, req)
  }
  const contentMatch = path.match(/^\/v1\/tasks\/([^/]+)\/content$/)
  if (req.method === 'POST' && contentMatch) {
    const task = scopeTask(req, contentMatch[1]!)
    const idempotencyKey = header(req, 'idempotency-key')?.trim() || ''
    await requirePluginWalletAccess(task.workspaceId)
    if (isProduction() && !idempotencyKey) throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, '生产内容生成必须携带 Idempotency-Key', 400)
    const rulePreflight = await requireGenerationRulePreflight(task.workspaceId, task.productId)
    requirePlatformModelCostGate('text')
    const actorId = requestActor(req)
    const usageKey = `content.rest.generate:${idempotencyKey || task.id}`
    const usage = await consumeTaskUsage(task.workspaceId, task.id, usageKey, actorId)
    let draft
    try { draft = await service.generateDraft(contentMatch[1]!, idempotencyKey || undefined, `model:${usageKey}`) } catch (error) { if ((usage.charged || usage.walletDebited) && !providerSucceededButSettlementPending(error)) await refundTaskUsage(task.workspaceId, task.id, usageKey, actorId, 'REST 内容生成失败'); throw error }
    await persistSnapshot(task.workspaceId, 'content_version', draft, draft as unknown as Record<string, unknown>)
    await persistSnapshot(task.workspaceId, 'task', service.getTask(task.id), service.getTask(task.id) as unknown as Record<string, unknown>)
    const execution = executionContract('content', Boolean(contentGenerator))
    const report = service.reviewContentReport(task.workspaceId, draft.id, await evaluationRules(task.workspaceId, ruleContextForTask(task)))
    await persistEvent(task.workspaceId, draft.id, 'content.generated', draft.revision, { task_id: task.id, content_version_id: draft.id, version: draft.version, execution, rule_preflight: { blocking: report.blocking, finding_count: report.findings.length, rule_hits: report.ruleHits ?? [] } })
    return send(res, 201, task.workspaceId, { ...draft, execution, rule_preflight: report }, null, req)
  }
  const approvalMatch = path.match(/^\/v1\/tasks\/([^/]+)\/approve$/)
  if (req.method === 'POST' && approvalMatch) {
    const task = scopeTask(req, approvalMatch[1]!)
    const input = await body(req)
    const approved = service.approveContent(approvalMatch[1]!, required(input, 'content_version_id'), await evaluationRules(task.workspaceId, ruleContextForTask(task)), typeof input.expected_version === 'number' ? input.expected_version : undefined)
    await persistSnapshot(task.workspaceId, 'content_version', approved.version, approved.version as unknown as Record<string, unknown>)
    await persistSnapshot(task.workspaceId, 'task', approved.task, approved.task as unknown as Record<string, unknown>)
    await persistEvent(task.workspaceId, approved.version.id, 'content.approved', approved.version.revision, { task_id: approved.task.id, content_version_id: approved.version.id, version: approved.version.version })
    return send(res, 200, task.workspaceId, approved, null, req)
  }
  const versionDiffMatch = path.match(/^\/v1\/content-versions\/([^/]+)\/diff$/)
  if (req.method === 'GET' && versionDiffMatch) {
    const scoped = scopeContentVersion(req, versionDiffMatch[1]!)
    const against = url.searchParams.get('against') ?? url.searchParams.get('against_version_id') ?? undefined
    return send(res, 200, scoped.task.workspaceId, service.diffContentVersions(scoped.task.workspaceId, scoped.version.id, against), null, req)
  }
  const versionModifyMatch = path.match(/^\/v1\/content-versions\/([^/]+)\/modify$/)
  if (req.method === 'POST' && versionModifyMatch) {
    const scoped = scopeContentVersion(req, versionModifyMatch[1]!)
    const input = await body(req)
    const lockedFields = Array.isArray(input.locked_fields) ? input.locked_fields.filter((value): value is string => typeof value === 'string') : undefined
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : 'user_edit'
    const modified = typeof input.module_key === 'string' && input.module_key.trim()
      ? service.regenerateContentModule({ workspaceId: scoped.task.workspaceId, sourceVersionId: scoped.version.id, moduleKey: input.module_key, ...(lockedFields ? { lockedFields } : {}), reason, ...(typeof input.expected_revision === 'number' ? { expectedRevision: input.expected_revision } : {}) })
      : (() => {
        if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'changes 必须是对象', 400)
        return service.modifyContentVersion({ workspaceId: scoped.task.workspaceId, sourceVersionId: scoped.version.id, changes: input.changes as Partial<import('../../../packages/application/src/service.js').ContentVersion['body']>, ...(lockedFields ? { lockedFields } : {}), reason, ...(typeof input.expected_revision === 'number' ? { expectedRevision: input.expected_revision } : {}) })
      })()
    await persistSnapshot(scoped.task.workspaceId, 'content_version', modified.version, modified.version as unknown as Record<string, unknown>)
    await persistSnapshot(scoped.task.workspaceId, 'task', modified.task, modified.task as unknown as Record<string, unknown>)
    await persistEvent(scoped.task.workspaceId, modified.version.id, 'content.version_modified', modified.version.revision, { task_id: modified.task.id, source_version_id: modified.source.id, content_version_id: modified.version.id, reason: modified.version.versionVector?.reason, locked_fields: modified.version.lockedFields ?? [] })
    return send(res, 201, scoped.task.workspaceId, modified, null, req)
  }
  const versionReviewMatch = path.match(/^\/v1\/content-versions\/([^/]+)\/review$/)
  if (req.method === 'GET' && versionReviewMatch) {
    const scoped = scopeContentVersion(req, versionReviewMatch[1]!)
    return send(res, 200, scoped.task.workspaceId, service.reviewContentReport(scoped.task.workspaceId, scoped.version.id, await evaluationRules(scoped.task.workspaceId, ruleContextForTask(scoped.task))), null, req)
  }
  const versionReviewDecisionMatch = path.match(/^\/v1\/content-versions\/([^/]+)\/review-decisions$/)
  if (req.method === 'POST' && versionReviewDecisionMatch) {
    const scoped = scopeContentVersion(req, versionReviewDecisionMatch[1]!)
    const input = await body(req)
    const status = required(input, 'status')
    if (!['acknowledged', 'waived'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'status 必须是 acknowledged 或 waived', 400)
    const decided = service.setReviewFindingDecision({ workspaceId: scoped.task.workspaceId, contentVersionId: scoped.version.id, code: required(input, 'code'), field: required(input, 'field'), status: status as 'acknowledged' | 'waived', ...(typeof input.reason === 'string' ? { reason: input.reason } : {}), actorId: requestActor(req), ...(typeof input.expected_revision === 'number' ? { expectedRevision: input.expected_revision } : {}) }, await evaluationRules(scoped.task.workspaceId, ruleContextForTask(scoped.task)))
    await persistSnapshot(scoped.task.workspaceId, 'content_version', decided.version, decided.version as unknown as Record<string, unknown>)
    await persistEvent(scoped.task.workspaceId, decided.version.id, 'content.review_decided', decided.version.revision, { content_version_id: decided.version.id, finding_key: decided.decision.key, status: decided.decision.status, reason: decided.decision.reason, actor_id: decided.decision.actorId })
    return send(res, 200, scoped.task.workspaceId, decided, null, req)
  }
  const versionRestoreMatch = path.match(/^\/v1\/content-versions\/([^/]+)\/restore$/)
  if (req.method === 'POST' && versionRestoreMatch) {
    const scoped = scopeContentVersion(req, versionRestoreMatch[1]!)
    const input = await body(req)
    const restored = service.restoreContentVersion(scoped.task.workspaceId, scoped.version.id, typeof input.expected_version === 'number' ? input.expected_version : undefined)
    await persistSnapshot(scoped.task.workspaceId, 'content_version', restored.version, restored.version as unknown as Record<string, unknown>)
    await persistSnapshot(scoped.task.workspaceId, 'task', restored.task, restored.task as unknown as Record<string, unknown>)
    await persistEvent(scoped.task.workspaceId, restored.version.id, 'content.version_restored', restored.version.revision, { task_id: restored.task.id, source_version_id: restored.source.id, content_version_id: restored.version.id, version: restored.version.version })
    return send(res, 201, scoped.task.workspaceId, restored, null, req)
  }
  const versionExportMatch = path.match(/^\/v1\/content-versions\/([^/]+)\/export$/)
  if (req.method === 'GET' && versionExportMatch) {
    const scoped = scopeContentVersion(req, versionExportMatch[1]!)
    const requestedFormat = url.searchParams.get('format') ?? 'bundle'
    if (!['manifest', 'json', 'markdown', 'bundle'].includes(requestedFormat)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'format 必须是 manifest、json、markdown 或 bundle', 400)
    await persistExpiredDeliveryIfNeeded(scoped.task.workspaceId, scoped.version.id)
    return sendDownload(res, service.exportContent(scoped.task.workspaceId, scoped.version.id, requestedFormat as 'manifest' | 'json' | 'markdown' | 'bundle'), req)
  }
  const prepareMatch = path.match(/^\/v1\/tasks\/([^/]+)\/publish-preview$/)
  if (req.method === 'POST' && prepareMatch) {
    const task = scopeTask(req, prepareMatch[1]!)
    await requireEnabledPlatform(task.workspaceId, task.platform)
    const preview = service.preparePublish(prepareMatch[1]!)
    await persistSnapshot(task.workspaceId, 'task', preview.task, preview.task as unknown as Record<string, unknown>)
    await persistEvent(task.workspaceId, preview.task.id, 'publish.prepared', preview.task.version, { task_id: preview.task.id, content_version_id: preview.version.id, confirmation_hash: preview.confirmationHash, remote_snapshot_hash: preview.remoteSnapshotHash, payload_hash: preview.payloadHash, selection_hash: preview.selectionHash, selected_count: preview.visualPreview.count, image_mode: preview.visualPreview.imageMode })
    return send(res, 200, task.workspaceId, preview, null, req)
  }
  if (req.method === 'POST' && path === '/v1/publish-jobs') {
    const input = await body(req)
    const key = header(req, 'idempotency-key')?.trim()
    if (!key) throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, '发布确认必须携带 Idempotency-Key', 400)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const taskId = required(input, 'task_id')
    const contentVersionId = required(input, 'content_version_id')
    const confirmationHash = required(input, 'confirmation_hash')
    const remoteSnapshotHash = required(input, 'remote_snapshot_hash')
    const task = service.getTask(taskId)
    if (task.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该任务', 403)
    await requireEnabledPlatform(workspaceId, task.platform)
    if (isProduction() && !((typeof input.account_id === 'string' && input.account_id.trim()) || task.accountId)) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产发布必须绑定已授权平台账号', 400)
    const publishAccountId = resolveTaskPublishAccount(task, typeof input.account_id === 'string' ? input.account_id : undefined)
    if (isProduction()) {
      service.getActivePlatformAccount(workspaceId, publishAccountId!, task.platform)
      if (!platformWriteReady(task.platform)) throw new DomainError('PLATFORM_WRITE_NOT_READY', '平台尚未完成生产写入能力验证，当前不会创建发布任务', 503)
    }
    await requirePluginWalletAccess(workspaceId)
    assertPublishIdempotency(workspaceId, { taskId, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: key })
    let existing = [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === key)
    if (!existing) {
      await hydrateDurableIdempotentJob(workspaceId, 'publish_job', key)
      existing = [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === key)
    }
    const reservationId = `publish:${key}`
    let reserved = false
    let walletDebited = false
    try {
      if (!existing) {
        await debitPluginWallet({ workspaceId, idempotencyKey: reservationId, actorId: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant', description: '商品发布调用' })
        walletDebited = true
      }
      reserved = existing ? false : await reserveDistributedJobSlot(workspaceId, reservationId)
      const job = service.confirmPublish({ workspaceId, taskId, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: key, ...(publishAccountId ? { accountId: publishAccountId } : {}), mediaAdapterReady: connectorRuntime.mediaUploadReady(task.platform) })
      const currentTask = service.getTask(taskId)
      await persistSnapshotsAndEvent({ workspaceId, snapshots: [
        { entityType: 'task', entityId: currentTask.id, entityVersion: currentTask.version, payload: currentTask as unknown as Record<string, unknown> },
        { entityType: 'publish_job', entityId: job.id, entityVersion: job.revision, payload: job as unknown as Record<string, unknown> },
      ], aggregateId: job.id, eventType: 'publish.requested', sequence: 1, eventPayload: publishEventPayload(job) })
      scheduleFixturePublishObservation(job)
      return send(res, 202, workspaceId, jobWithQueueMetadata(job, workspaceId, 'publish'), null, req)
    } catch (error) {
      if (reserved) await releaseDistributedJobSlot(workspaceId, reservationId)
      if (walletDebited) await refundPluginWalletDebit({ workspaceId, debitIdempotencyKey: reservationId, actorId: requestPrincipals.get(req)?.actorId ?? header(req, 'x-actor-id')?.trim() ?? 'merchant', reason: '发布任务创建失败' })
      throw error
    }
  }
  const publishGetMatch = path.match(/^\/v1\/publish-jobs\/([^/]+)$/)
  const publishExecutionCheckMatch = path.match(/^\/v1\/publish-jobs\/([^/]+)\/execution-check$/)
  const publishObservationMatch = path.match(/^\/v1\/publish-jobs\/([^/]+)\/observation$/)
  if (req.method === 'GET' && publishExecutionCheckMatch) {
    requireWorkerCredentialAuthorization(req)
    const workspaceId = resolveWorkspace(req)
    const job = service.assertPublishExecutionAllowed({ workspaceId, publishJobId: publishExecutionCheckMatch[1]! })
    const account = service.getActivePlatformAccount(workspaceId, job.accountId!, job.platform)
    return send(res, 200, workspaceId, { allowed: true, job_id: job.id, account_id: job.accountId, account_revision: job.accountRevision, credential_ref: account.credentialRef, payload_hash: job.payloadHash, media_required: job.selectedVisuals.length > 0 }, null, req)
  }
  const publishMediaMatch = path.match(/^\/v1\/publish-jobs\/([^/]+)\/media$/)
  if (req.method === 'GET' && publishMediaMatch) {
    requireWorkerCredentialAuthorization(req)
    const workspaceId = resolveWorkspace(req)
    const job = service.assertPublishExecutionAllowed({ workspaceId, publishJobId: publishMediaMatch[1]! })
    if (!job.selectedVisuals.length) return send(res, 200, workspaceId, { job_id: job.id, media: [] }, null, req)
    return send(res, 200, workspaceId, { job_id: job.id, media: await publishMediaPayload(workspaceId, job) }, null, req)
  }
  if (req.method === 'POST' && publishObservationMatch) {
    requireWorkerAuthorization(req)
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const statusInput = input.status
    if (!statusInput || typeof statusInput !== 'object' || Array.isArray(statusInput)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '缺少平台状态观测', 400)
    const status = statusInput as Record<string, unknown>
    const source = input.source === 'reconcile' ? 'reconcile' : 'publish'
    const state = status.state
    if (!['submitted', 'published', 'rejected', 'unknown'].includes(String(state))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '平台状态观测值无效', 400)
    const rejection = readPlatformRejection(status.platform_rejection)
    if (rejection && state !== 'rejected') throw new DomainError(ERROR_CODES.INVALID_REQUEST, '只有平台驳回状态可以携带拒绝详情', 400)
    const job = service.recordPublishObservation({
      workspaceId,
      publishJobId: publishObservationMatch[1]!,
      status: {
        found: status.found === true,
        state: state as 'submitted' | 'published' | 'rejected' | 'unknown',
        ...(typeof status.remote_id === 'string' ? { remoteId: status.remote_id } : {}),
        ...(typeof status.request_id === 'string' ? { requestId: status.request_id } : {}),
        ...(typeof status.simulated === 'boolean' ? { simulated: status.simulated } : {}),
        ...(rejection ? { rejection } : {}),
      },
      ...(typeof input.observed_at === 'string' ? { observedAt: input.observed_at } : {}),
    })
    let boundProduct
    if (job.remoteId) {
      boundProduct = service.bindProductRemoteId(workspaceId, job.taskId, job.remoteId)
      await persistSnapshot(workspaceId, 'product', boundProduct, boundProduct as unknown as Record<string, unknown>)
    }
    await persistSnapshot(workspaceId, 'task', service.getTask(job.taskId), service.getTask(job.taskId) as unknown as Record<string, unknown>)
    await persistSnapshot(workspaceId, 'content_version', service.getContentVersion(workspaceId, job.contentVersionId), service.getContentVersion(workspaceId, job.contentVersionId) as unknown as Record<string, unknown>)
    await persistSnapshot(workspaceId, 'publish_job', job, job as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, job.id, 'publish.observation', job.revision, {
      job_id: job.id,
      task_id: job.taskId,
      source,
      status: job.remoteState ?? job.state,
      ...(job.remoteId ? { remote_id: job.remoteId } : {}),
      ...(job.requestId ? { request_id: job.requestId } : {}),
      ...(job.rejection ? { platform_rejection: { raw_code: job.rejection.rawCode, ...(job.rejection.message ? { message: job.rejection.message } : {}), fields: job.rejection.fields.map(field => ({ path: field.path, ...(field.rawCode ? { raw_code: field.rawCode } : {}), message: field.message })) } } : {}),
    })
    if (job.remoteState === 'published' || job.remoteState === 'rejected') await releaseDistributedJobSlot(workspaceId, `publish:${job.idempotencyKey}`)
    if (source === 'publish' && job.remoteState === 'submitted') {
      await persistEvent(workspaceId, job.id, 'publish.reconcile_requested', 1, publishReconcileEventPayload(job))
    }
    const automation = job.remoteState === 'published' && job.accountId
      ? await scanAutomationAfterOperationalCompletion(workspaceId, job.platform, job.accountId, `publish.observation.${source}.published`)
      : undefined
    return send(res, 200, workspaceId, { ...jobWithQueueMetadata(job, workspaceId, 'publish'), ...(automation ? { automation } : {}) }, null, req)
  }
  if (req.method === 'GET' && publishGetMatch) {
    const job = service.getPublishJob(publishGetMatch[1]!)
    const workspaceId = resolveWorkspace(req, job.workspaceId)
    return send(res, 200, workspaceId, jobWithQueueMetadata(job, workspaceId, 'publish'), null, req)
  }
  if (req.method === 'POST' && path === '/mcp') return routeMcp(req, res, await body(req, MCP_BODY_LIMIT))
  throw new DomainError(ERROR_CODES.NOT_FOUND, '路由不存在', 404)
}

const server = createServer((req, res) => {
  const startedAt = process.hrtime.bigint()
  metricInFlight += 1
  res.once('finish', () => observeHttpMetric(req, res, startedAt))
  route(req, res).catch(error => {
    const workspaceId = (() => { try { return resolveWorkspace(req) } catch { return isProduction() ? 'unknown' : 'ws_demo' } })()
    if (wantsOAuthHtml(req)) {
      const fallback = { status: 500, code: ERROR_CODES.INTERNAL_ERROR, message: '授权回调失败' }
      const mapped = error instanceof OAuthStateError
        ? oauthError(error)
        : error instanceof ConnectorFailure
          ? { status: error.normalized.code === 'UNAUTHORIZED' ? 401 : error.normalized.code === 'NOT_CONFIGURED' ? 503 : error.normalized.code === 'RATE_LIMITED' ? 429 : error.normalized.code === 'NOT_FOUND' ? 404 : 502, code: error.normalized.code, message: error.normalized.message }
          : error instanceof DomainError ? { status: error.status, code: error.code, message: error.message } : fallback
      return sendOAuthCallbackPage(res, mapped.status, { state: 'error', platform: (req.url ?? '').split('/').at(-1)?.split('?')[0] ?? 'store', code: mapped.code, message: 'message' in mapped ? mapped.message : error instanceof Error ? error.message : fallback.message }, req)
    }
    if (error instanceof OAuthStateError) {
      const mapped = oauthError(error)
      return fail(res, mapped.status, workspaceId, mapped.code, error.message, req)
    }
    if (error instanceof ConnectorFailure) {
      const status = error.normalized.code === 'UNAUTHORIZED' ? 401 : error.normalized.code === 'NOT_CONFIGURED' ? 503 : error.normalized.code === 'RATE_LIMITED' ? 429 : error.normalized.code === 'NOT_FOUND' ? 404 : 502
      return fail(res, status, workspaceId, error.normalized.code, error.normalized.message, req)
    }
    if (error instanceof ObjectStorageError) return fail(res, error.status, workspaceId, error.code, error.message, req)
    const typed = error instanceof DomainError ? error : new DomainError(ERROR_CODES.INTERNAL_ERROR, '内部错误', 500)
    const retryAfter = typeof typed.details?.retry_after_seconds === 'number' ? typed.details.retry_after_seconds : undefined
    if (retryAfter !== undefined) res.setHeader('retry-after', String(Math.max(1, Math.ceil(retryAfter))))
    return fail(res, typed.status, workspaceId, typed.code, typed.message, req, typed.details)
  })
})

if (process.env.NODE_ENV !== 'test') {
  persistenceReady.then(() => server.listen(port, () => console.log(`merchant API listening on http://127.0.0.1:${port} (${persistence.mode})`))).catch(error => {
    console.error('merchant API startup failed: database migration/connection unavailable', error)
    // Do not leave a live Node process with no listener.  Orchestrators can
    // only recover this startup failure when the container actually exits;
    // otherwise the pod stays Running but can never answer its health probe.
    process.exit(1)
  })
}

export { server, service, persistenceReady, memoryMembers as workspaceMembers }
