import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { DomainError, type MerchantService, type Platform, type Task } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { CampaignDeliveryLifecycleOperation } from '../../../packages/application/src/campaign-delivery-orchestrator.js'
import type { BrandUnitRepository, CampaignBatchRow, CampaignTargetRow } from '../../../packages/persistence/src/brand-unit-repository.js'
import type { OperationAudit } from '../../../packages/persistence/src/index.js'

type JsonObject = Record<string, unknown>
type CanonicalScope = { brandId: string; canonicalProductId: string; listingId: string }
type DeliveryManifest = { state?: string; validation?: { valid?: boolean; code?: string | null; path?: string | null } }
type CampaignWorkflow = { items: unknown[]; readiness: 'ready' | 'blocked'; summary: unknown }

export interface CampaignWriteDependencies {
  repository: BrandUnitRepository
  persistenceMode: string
  persistenceReady: Promise<unknown>
  service: MerchantService
  fixtureMode: boolean
  isProduction: () => boolean
  required: (params: JsonObject, key: string) => string
  header: (request: IncomingMessage, key: string) => string | undefined
  result: (value: unknown) => unknown
  parseCampaignTargets: (value: unknown) => CampaignTargetRow[]
  parseCampaignProductIds: (value: unknown) => string[]
  parseJsonArrayParameter: (params: JsonObject, key: string) => unknown[]
  resolveCanonicalTaskScope: (input: { workspaceId: string; productId: string; platform: Platform; accountId?: string; brandId?: string; canonicalProductId?: string; listingId?: string; requireListing?: boolean; requireCanonical?: boolean }) => Promise<CanonicalScope | undefined>
  enforceBrandAccess: (request: IncomingMessage, workspaceId: string, brandId: string, minimumRole: 'editor') => Promise<unknown>
  enforceProductBrandBinding: (request: IncomingMessage, workspaceId: string, productId: string, brandId: string) => Promise<unknown>
  validateCampaignDelivery: (operation: CampaignDeliveryLifecycleOperation, workspaceId: string, campaign: CampaignBatchRow, itemIds?: readonly string[]) => Promise<DeliveryManifest>
  campaignWorkflow: (campaign: CampaignBatchRow, deliveryManifest: DeliveryManifest) => CampaignWorkflow
  refreshCampaignProgress: (campaign: CampaignBatchRow) => Promise<CampaignBatchRow>
  observeLegacyWalletShadow: (workspaceId: string) => Promise<unknown>
  canonicalProductReadControl: (workspaceId: string) => Promise<{ mode: string }>
  persistSnapshot: (workspaceId: string, entityType: 'task', entity: Task, value: Record<string, unknown>) => Promise<unknown>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<unknown>
  campaignLifecycleError: (error: unknown) => never
  recordOperationAudit: (input: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
  requestActor: (request: IncomingMessage) => string
}

export async function createCampaignBatch(req: IncomingMessage, workspaceId: string, params: JsonObject, dependencies: CampaignWriteDependencies) {
  const { repository, persistenceMode, persistenceReady, service, fixtureMode, isProduction, required, header, result, parseCampaignTargets, parseCampaignProductIds, parseJsonArrayParameter, resolveCanonicalTaskScope, enforceBrandAccess, enforceProductBrandBinding, validateCampaignDelivery, campaignWorkflow, refreshCampaignProgress, observeLegacyWalletShadow, canonicalProductReadControl, persistSnapshot, persistEvent, campaignLifecycleError, recordOperationAudit, requestActor } = dependencies
  const brandId = required(params, 'brand_id')
  await enforceBrandAccess(req, workspaceId, brandId, 'editor')
  await persistenceReady
  let targets = params.targets_json !== undefined
    ? parseCampaignTargets(params.targets_json)
    : [{ productId: '', platform: required(params, 'platform') as Platform, accountId: required(params, 'account_id') }]
  const legacyProductIds = params.targets_json === undefined ? parseCampaignProductIds(params.product_ids_json) : targets.filter(target => target.productId).map(target => target.productId)
  if (params.targets_json === undefined) targets.splice(0, 1, ...legacyProductIds.map(productId => ({ productId, platform: targets[0]!.platform, accountId: targets[0]!.accountId })))
  // Both the structured target API and the legacy product_ids_json API
  // must pass through the same canonical resolver. Otherwise an old
  // request can recreate a campaign that splits the execution graph.
  if (targets.length) {
    targets = await Promise.all(targets.map(async target => {
      if (target.productId) {
        const scope = await resolveCanonicalTaskScope({ workspaceId, productId: target.productId, platform: target.platform, accountId: target.accountId, brandId, ...(target.canonicalProductId ? { canonicalProductId: target.canonicalProductId } : {}), ...(target.listingId ? { listingId: target.listingId } : {}) })
        if (!scope) {
          // An explicit canonical target may intentionally point at a
          // platform-specific product different from canonical.sourceProductId
          // (one canonical product can have several platform listings). The
          // later product/store checks still validate the concrete target;
          // validate the supplied canonical/listing pair here instead of
          // treating it as a legacy mapping failure.
          if (target.canonicalProductId) {
            const canonical = await repository.getCanonicalProduct({ workspaceId, id: target.canonicalProductId })
            if (!canonical || canonical.brandId !== brandId) throw new DomainError('CANONICAL_PRODUCT_SCOPE_MISMATCH', 'canonical product 不属于当前品或工作区', 409, { product_id: target.productId, canonical_product_id: target.canonicalProductId })
            if (!target.listingId) throw new DomainError('CANONICAL_LISTING_REQUIRED', '标准批量任务必须同时绑定 canonical_product_id 和 listing_id', 409, { canonical_product_id: canonical.id, platform: target.platform, account_id: target.accountId, next_step: '先创建当前平台店铺 listing，再创建批量计划' })
            const listing = (await repository.listListings({ workspaceId, brandId, canonicalProductId: canonical.id, listingId: target.listingId, platform: target.platform, accountId: target.accountId }))[0]
            if (!listing) throw new DomainError('LISTING_TARGET_MISMATCH', 'listing_id 不属于当前品、平台或店铺', 409, { listing_id: target.listingId, canonical_product_id: canonical.id, platform: target.platform, account_id: target.accountId })
            return target
          }
          if (target.canonicalProductId || target.listingId) throw new DomainError('CANONICAL_PRODUCT_SCOPE_MISMATCH', 'legacy 商品没有对应的规范化商品链，不能混用 canonical_product_id 或 listing_id', 409, { product_id: target.productId, canonical_product_id: target.canonicalProductId ?? null, listing_id: target.listingId ?? null })
          return target
        }
        if (target.canonicalProductId && target.canonicalProductId !== scope.canonicalProductId) throw new DomainError('CANONICAL_PRODUCT_SCOPE_MISMATCH', '商品与规范化商品绑定不一致', 409, { product_id: target.productId, expected: scope.canonicalProductId, provided: target.canonicalProductId })
        if (target.listingId && target.listingId !== scope.listingId) throw new DomainError('LISTING_TARGET_MISMATCH', 'listing_id 不属于当前商品、平台或店铺', 409, { listing_id: target.listingId, expected: scope.listingId })
        return { ...target, ...scope }
      }
      const canonical = target.canonicalProductId ? await repository.getCanonicalProduct({ workspaceId, id: target.canonicalProductId }) : undefined
      if (!canonical) throw new DomainError('CANONICAL_PRODUCT_NOT_FOUND', 'canonical product 不存在或不属于当前工作区', 404, { canonical_product_id: target.canonicalProductId })
      if (canonical.brandId !== brandId) throw new DomainError('CANONICAL_PRODUCT_NOT_FOUND', 'canonical product 不存在或不属于当前品', 404, { canonical_product_id: target.canonicalProductId, brand_id: brandId })
      const listing = target.listingId
        ? (await repository.listListings({ workspaceId, brandId, listingId: target.listingId, platform: target.platform, accountId: target.accountId }))[0]
        : undefined
      if (target.listingId && (!listing || listing.canonicalProductId !== canonical.id)) throw new DomainError('LISTING_TARGET_MISMATCH', 'listing_id 不属于当前品、平台或店铺', 409, { listing_id: target.listingId, brand_id: brandId, platform: target.platform, account_id: target.accountId })
      if (!target.listingId && !fixtureMode) throw new DomainError('CANONICAL_LISTING_REQUIRED', '标准批量任务必须同时绑定 canonical_product_id 和 listing_id', 409, { canonical_product_id: canonical.id, platform: target.platform, account_id: target.accountId, next_step: '先创建当前平台店铺 listing，再创建批量计划' })
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
    const units = await repository.listBrands({ workspaceId, brandId, platform: target.platform, accountId: target.accountId })
    if (!units[0]) throw new DomainError('BRAND_STORE_BINDING_REQUIRED', '创建批量运营计划前，必须先将该店铺绑定到指定品', 409, { brand_id: brandId, platform: target.platform, account_id: target.accountId, next_actions: ['调用 brand-unit.bind-store 绑定店铺'] })
    if (target.listingId) {
      const listings = await repository.listListings({ workspaceId, brandId, listingId: target.listingId, platform: target.platform, accountId: target.accountId })
      if (!listings[0] || (target.canonicalProductId && listings[0].canonicalProductId !== target.canonicalProductId)) throw new DomainError('LISTING_TARGET_MISMATCH', 'listing_id 不属于当前品、平台或店铺', 409, { listing_id: target.listingId, brand_id: brandId, platform: target.platform, account_id: target.accountId })
    }
    const account = isProduction() ? service.getActionablePlatformAccount(workspaceId, target.accountId, target.platform) : service.getPlatformAccount(workspaceId, target.accountId, target.platform)
    if (!account) throw new DomainError('PLATFORM_ACCOUNT_NOT_FOUND', '平台账号不存在或不属于当前工作区', 404)
    const productId = target.productId
    const product = service.products.get(productId)
    if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', `商品 ${productId} 不存在或不属于当前工作区`, 404, { product_id: productId })
    await enforceProductBrandBinding(req, workspaceId, productId, brandId)
    if (product.platform !== target.platform || product.accountId !== target.accountId) throw new DomainError('PRODUCT_STORE_CONTEXT_MISMATCH', `商品 ${productId} 不属于所选平台店铺`, 409, { product_id: productId, expected: { platform: target.platform, account_id: target.accountId }, actual: { platform: product.platform, account_id: product.accountId ?? null } })
  }
  const platform = targets[0]!.platform
  const accountId = targets[0]!.accountId
  const productIds = [...new Set(targets.map(target => target.productId))]
  const idempotencyKey = (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) || header(req, 'idempotency-key')?.trim() || undefined
  let created
  try {
    created = await repository.createCampaign({ id: `campaign_batch_${randomUUID().replaceAll('-', '').slice(0, 24)}`, workspaceId, brandId, platform, accountId, productIds, targets, state: 'draft', ...(idempotencyKey ? { idempotencyKey } : {}) })
  } catch (error) {
    if ((error as { code?: string })?.code === 'CAMPAIGN_IDEMPOTENCY_CONFLICT' || String(error).includes('CAMPAIGN_IDEMPOTENCY_CONFLICT')) throw new DomainError('CAMPAIGN_IDEMPOTENCY_CONFLICT', '幂等键已绑定到另一份批量运营计划，请换用新的幂等键', 409, { idempotency_key: idempotencyKey })
    throw error
  }
  const durableCampaign = await repository.getCampaign({ workspaceId, id: created.campaign.id })
  if (!durableCampaign) throw new DomainError('CAMPAIGN_BATCH_NOT_FOUND', '批量运营计划持久化后无法回读', 500, { campaign_id: created.campaign.id })
  const deliveryManifest = await validateCampaignDelivery('create', workspaceId, durableCampaign)
  return result({ ...durableCampaign, count: productIds.length, replayed: created.replayed, delivery_manifest: deliveryManifest, storage: persistenceMode, durable: persistenceMode === 'postgres', execution: 'plan_only', message: '批量运营计划已持久化；当前仍需通过审核后任务流程生成和发布。' })
}

export async function generateCampaignBatch(req: IncomingMessage, workspaceId: string, params: JsonObject, dependencies: CampaignWriteDependencies) {
  const { repository, persistenceMode, persistenceReady, service, fixtureMode, isProduction, required, header, result, parseCampaignTargets, parseCampaignProductIds, parseJsonArrayParameter, resolveCanonicalTaskScope, enforceBrandAccess, enforceProductBrandBinding, validateCampaignDelivery, campaignWorkflow, refreshCampaignProgress, observeLegacyWalletShadow, canonicalProductReadControl, persistSnapshot, persistEvent, campaignLifecycleError, recordOperationAudit, requestActor } = dependencies
  await observeLegacyWalletShadow(workspaceId)
  await persistenceReady
  const campaignId = required(params, 'campaign_id')
  const campaign = await repository.getCampaign({ workspaceId, id: campaignId })
  if (!campaign) throw new DomainError('CAMPAIGN_BATCH_NOT_FOUND', '批量运营计划不存在或不属于当前工作区', 404, { campaign_id: campaignId })
  await enforceBrandAccess(req, workspaceId, campaign.brandId, 'editor')
  const generationIdempotencyKey = typeof params.idempotency_key === 'string' && params.idempotency_key.trim()
    ? params.idempotency_key.trim()
    : `campaign-generate:${campaignId}`
  const priorTaskIds = campaign.taskIds
  if (priorTaskIds) {
    if (campaign.generationIdempotencyKey && campaign.generationIdempotencyKey !== generationIdempotencyKey) {
      throw new DomainError('CAMPAIGN_GENERATE_IDEMPOTENCY_CONFLICT', '批量生成幂等键已绑定到另一项生成意图，请先查询当前批次状态', 409, { campaign_id: campaignId, idempotency_key: campaign.generationIdempotencyKey })
    }
    const refreshed = await refreshCampaignProgress(campaign)
    const deliveryManifest = await validateCampaignDelivery('generate', workspaceId, refreshed)
    return result({ campaignId, taskIds: priorTaskIds, count: priorTaskIds.length, state: refreshed.state, ...campaignWorkflow(refreshed, deliveryManifest), delivery_manifest: deliveryManifest, replayed: true, idempotency_key: generationIdempotencyKey, execution: 'workflow_active', next_actions: [...new Set((refreshed.items ?? []).map(item => item.error?.nextAction).filter((action): action is string => Boolean(action)))] })
  }
  const requestText = typeof params.request_text === 'string' && params.request_text.trim() ? params.request_text.trim() : undefined
  const taskIds: string[] = []
  const rawTargets: Array<{ productId: string; platform: Platform; accountId: string; canonicalProductId?: string; listingId?: string }> = campaign.targets
    ?? campaign.items?.map(item => ({ productId: item.productId, platform: item.platform, accountId: item.accountId, ...(item.canonicalProductId ? { canonicalProductId: item.canonicalProductId } : {}), ...(item.listingId ? { listingId: item.listingId } : {}) }))
    ?? campaign.productIds.map(productId => ({ productId, platform: campaign.platform, accountId: campaign.accountId }))
  const targets = await Promise.all(rawTargets.map(async (target, index) => {
    const product = service.products.get(target.productId)
    if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', `商品 ${target.productId} 不存在或不属于当前工作区`, 404, { product_id: target.productId, ordinal: index + 1 })
    if (product.platform !== target.platform || product.accountId !== target.accountId) throw new DomainError('PRODUCT_STORE_CONTEXT_MISMATCH', `商品 ${target.productId} 不属于所选平台店铺`, 409, { product_id: target.productId, ordinal: index + 1, expected: { platform: target.platform, account_id: target.accountId }, actual: { platform: product.platform, account_id: product.accountId ?? null } })
    if (!product.factsConfirmed) throw new DomainError('PRODUCT_FACTS_CONFIRMATION_REQUIRED', '批量生成前必须先确认全部商品事实，已停止创建任务', 409, { product_id: target.productId, ordinal: index + 1, next_action: 'catalog.facts.confirm', read_mode: (await canonicalProductReadControl(workspaceId)).mode })
    if (!campaign.items?.[index]) throw new DomainError('CAMPAIGN_ITEM_MISSING', '批量运营计划缺少持久化明细，已停止创建任务', 409, { campaign_id: campaignId, ordinal: index + 1 })
    const scope = await resolveCanonicalTaskScope({ workspaceId, productId: target.productId, platform: target.platform, accountId: target.accountId, brandId: campaign.brandId, ...(target.canonicalProductId ? { canonicalProductId: target.canonicalProductId } : {}), ...(target.listingId ? { listingId: target.listingId } : {}), requireListing: true, requireCanonical: true })
    if (!scope) throw new DomainError('CANONICAL_PRODUCT_MAPPING_REQUIRED', '批量生成要求所有目标先完成标准商品链绑定，已停止创建任务', 409, { product_id: target.productId, ordinal: index + 1, next_action: 'canonical.product.consistency', read_mode: (await canonicalProductReadControl(workspaceId)).mode })
    if (target.canonicalProductId && target.canonicalProductId !== scope.canonicalProductId) throw new DomainError('CANONICAL_PRODUCT_SCOPE_MISMATCH', '批量计划商品与规范化商品绑定不一致', 409, { product_id: target.productId, expected: scope.canonicalProductId, provided: target.canonicalProductId })
    if (target.listingId && target.listingId !== scope.listingId) throw new DomainError('LISTING_TARGET_MISMATCH', '批量计划 listing 与商品、平台或店铺不一致', 409, { listing_id: target.listingId, expected: scope.listingId })
    return { ...target, ...scope }
  }))
  for (const [index, target] of targets.entries()) {
    const productId = target.productId
    const product = service.products.get(productId)
    if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', `商品 ${productId} 不存在或不属于当前工作区`, 404, { product_id: productId })
    const campaignItem = campaign.items?.[index]
    if (!campaignItem) throw new DomainError('CAMPAIGN_ITEM_MISSING', '批量运营计划缺少持久化明细，已停止创建任务', 409, { campaign_id: campaignId, ordinal: index + 1 })
    const deterministicTaskId = `task_campaign_${createHash('sha256').update(`${workspaceId}:${campaignId}:${campaignItem.id}`).digest('hex').slice(0, 32)}`
    const existingTask = service.tasks.has(deterministicTaskId)
    const task = service.createTask({ workspaceId, productId, platform: target.platform, accountId: target.accountId, brandId: campaign.brandId, canonicalProductId: target.canonicalProductId, listingId: target.listingId, campaignId, campaignItemId: campaignItem.id, taskId: deterministicTaskId, ...(requestText ? { requestText } : {}) })
    taskIds.push(task.id)
    if (!existingTask) {
      await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, task.id, 'task.created', task.version, { ...task, campaign_id: campaignId, listing_id: target.listingId ?? null, idempotency_key: generationIdempotencyKey, source: 'campaign.batch.generate' })
    }
  }
  await repository.updateCampaignTasks({ workspaceId, id: campaignId, taskIds, state: 'generating', generationIdempotencyKey })
  const refreshed = await refreshCampaignProgress((await repository.getCampaign({ workspaceId, id: campaignId }))!)
  const deliveryManifest = await validateCampaignDelivery('generate', workspaceId, refreshed)
  const workflow = campaignWorkflow(refreshed, deliveryManifest)
  return result({ campaignId, taskIds, count: taskIds.length, state: refreshed.state, ...workflow, delivery_manifest: deliveryManifest, replayed: false, idempotency_key: generationIdempotencyKey, execution: 'workflow_active', message: '已为每个商品创建独立工作流；系统会持久化当前节点，不会越过事实确认、方向确认、内容审核或发布确认。', next_actions: [...new Set((refreshed.items ?? []).map(item => item.error?.nextAction).filter((action): action is string => Boolean(action)))] })
}

export async function transitionCampaignBatch(method: 'campaign.batch.pause' | 'campaign.batch.resume' | 'campaign.batch.retry_failed', req: IncomingMessage, workspaceId: string, params: JsonObject, dependencies: CampaignWriteDependencies) {
  const { repository, persistenceMode, persistenceReady, service, fixtureMode, isProduction, required, header, result, parseCampaignTargets, parseCampaignProductIds, parseJsonArrayParameter, resolveCanonicalTaskScope, enforceBrandAccess, enforceProductBrandBinding, validateCampaignDelivery, campaignWorkflow, refreshCampaignProgress, observeLegacyWalletShadow, canonicalProductReadControl, persistSnapshot, persistEvent, campaignLifecycleError, recordOperationAudit, requestActor } = dependencies
  await persistenceReady
  const campaignId = required(params, 'campaign_id')
  const current = await repository.getCampaign({ workspaceId, id: campaignId })
  if (!current) throw new DomainError('CAMPAIGN_BATCH_NOT_FOUND', '批量运营计划不存在或不属于当前工作区', 404, { campaign_id: campaignId })
  await enforceBrandAccess(req, workspaceId, current.brandId, 'editor')
  const operation = method === 'campaign.batch.pause' ? 'pause' as const : method === 'campaign.batch.resume' ? 'resume' as const : 'retry_failed' as const
  let itemIds: string[] | undefined
  if (operation === 'retry_failed' && params.item_ids_json !== undefined) {
    const parsed = parseJsonArrayParameter(params, 'item_ids_json')
    if (!parsed.length || parsed.length > 50 || parsed.some(value => typeof value !== 'string' || !value.trim()) || new Set(parsed).size !== parsed.length) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'item_ids_json 必须是 1 到 50 个不重复 item ID', 400)
    itemIds = parsed.map(value => String(value).trim())
  }
  const transitioned = await repository.transitionCampaignLifecycle({ workspaceId, id: campaignId, operation, expectedRevision: Number(required(params, 'expected_revision')), idempotencyKey: required(params, 'idempotency_key'), reason: required(params, 'reason').trim(), ...(itemIds ? { itemIds } : {}) }).catch(error => campaignLifecycleError(error))
  if (operation === 'retry_failed' && !transitioned.replayed) {
    const selected = new Set(itemIds?.length ? itemIds : (current.items ?? []).filter(item => item.state === 'failed').map(item => item.id))
    for (const item of current.items ?? []) {
      if (!selected.has(item.id) || !item.taskId) continue
      const task = service.tasks.get(item.taskId)
      if (task?.workspaceId === workspaceId && task.state === 'failed_recoverable') {
        service.resumeTask(workspaceId, task.id)
        const resumed = service.tasks.get(task.id)!
        await persistSnapshot(workspaceId, 'task', resumed, resumed as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, resumed.id, 'task.resumed', resumed.version, { source: 'campaign.batch.retry_failed', campaign_id: campaignId, campaign_item_id: item.id })
      }
    }
  }
  if (!transitioned.replayed) await recordOperationAudit({ workspaceId, actorId: requestActor(req), action: `campaign.batch.${operation}`, resourceType: 'campaign', resourceId: campaignId, before: { state: current.state, revision: current.revision ?? 1 }, after: { state: transitioned.campaign.state, revision: transitioned.campaign.revision ?? null, item_ids: itemIds ?? null }, reason: required(params, 'reason').trim() })
  const deliveryManifest = await validateCampaignDelivery(operation, workspaceId, transitioned.campaign, itemIds)
  return result({ ...transitioned.campaign, ...campaignWorkflow(transitioned.campaign, deliveryManifest), delivery_manifest: deliveryManifest, replayed: transitioned.replayed, storage: persistenceMode, durable: persistenceMode === 'postgres' })
}
