import { createHash } from 'node:crypto'
import { DomainError, type MerchantService } from '../../../packages/application/src/service.js'
import { CampaignDeliveryOrchestratorAdapter, type CampaignDeliveryLifecycleOperation } from '../../../packages/application/src/campaign-delivery-orchestrator.js'
import { CampaignManifestError, type CampaignDeliveryManifestInput } from '../../../packages/application/src/campaign-delivery-manifest.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { BrandUnitRepository, CampaignBatchRow, CampaignBatchState, CampaignItemRow, CampaignItemState } from '../../../packages/persistence/src/brand-unit-repository.js'

type JsonObject = Record<string, unknown>

export function createCampaignRuntime(deps: {
  service: Pick<MerchantService, 'tasks' | 'listPublishJobs'>
  repository: () => Pick<BrandUnitRepository, 'updateCampaignProgress'>
}) {
  function campaignTaskProjection(workspaceId: string, item: CampaignItemRow): { state: CampaignItemState; error?: CampaignItemRow['error'] } {
    if (!item.taskId) return { state: 'pending', error: { code: 'TASK_NOT_CREATED', message: '尚未创建商品内容任务', nextAction: 'campaign.batch.generate' } }
    const task = deps.service.tasks.get(item.taskId)
    if (!task || task.workspaceId !== workspaceId) return { state: 'unknown', error: { code: 'TASK_SNAPSHOT_UNAVAILABLE', message: '任务快照暂不可用，需要恢复后继续', nextAction: 'task.resume' } }
    if (task.state === 'draft') return { state: 'blocked', error: { code: 'PRODUCT_FACTS_CONFIRMATION_REQUIRED', message: '请先确认该商品事实', nextAction: 'catalog.facts.confirm' } }
    if (task.state === 'ready_for_direction') return { state: 'manual_attention', error: { code: 'DIRECTION_CONFIRMATION_REQUIRED', message: '请为该商品选择内容方向', nextAction: 'task.select_direction' } }
    if (task.state === 'direction_selected') return { state: 'manual_attention', error: { code: 'PLAN_CONFIRMATION_REQUIRED', message: '请确认该商品的生产方案', nextAction: 'task.plan.confirm' } }
    if (task.state === 'plan_confirmed') return { state: 'generating', error: { code: 'CONTENT_GENERATION_READY', message: '生产方案已确认，可以生成内容', nextAction: 'content.generate' } }
    if (task.state === 'review_required') return { state: 'review_required', error: { code: 'HUMAN_REVIEW_REQUIRED', message: '内容已生成，等待规则审核和人工批准', nextAction: 'content.review' } }
    if (task.state === 'approved') return { state: 'approved', error: { code: 'PUBLISH_PREPARATION_READY', message: '内容已批准，可以加入批量发布预览', nextAction: 'publish.batch.prepare' } }
    if (task.state === 'publish_prepared') return { state: 'approved', error: { code: 'PUBLISH_CONFIRMATION_REQUIRED', message: '发布预览已冻结，等待逐项确认', nextAction: 'publish.batch.confirm' } }
    if (task.state === 'publishing') {
      const publish = deps.service.listPublishJobs(workspaceId).filter(job => job.taskId === task.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
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
    if (campaign.state === 'paused') return campaign
    if (!campaign.items?.length) return campaign
    const items = campaign.items.map(item => ({ ...item, ...campaignTaskProjection(campaign.workspaceId, item) }))
    const state = campaignAggregateState(items.map(item => item.state))
    const changed = state !== campaign.state || items.some((item, index) => item.state !== campaign.items![index]!.state || JSON.stringify(item.error ?? null) !== JSON.stringify(campaign.items![index]!.error ?? null))
    if (!changed) return campaign
    return await deps.repository().updateCampaignProgress({ workspaceId: campaign.workspaceId, id: campaign.id, state, items: items.map(item => ({ id: item.id, ...(item.taskId ? { taskId: item.taskId } : {}), state: item.state, ...(item.error ? { error: item.error } : {}) })) })
  }

  function campaignWorkflow(campaign: CampaignBatchRow, deliveryManifest?: { state?: string; validation?: { valid?: boolean } }) {
    const items = (campaign.items ?? []).map(item => ({ item_id: item.id, product_id: item.productId, platform: item.platform, account_id: item.accountId, task_id: item.taskId ?? null, state: item.state, blocker: item.error ?? null, next_action: item.error?.nextAction ?? (item.state === 'published' ? null : 'campaign.batch.get') }))
    const deliveryIsBlocked = deliveryManifest?.validation?.valid === false || deliveryManifest?.state === 'blocked'
    const deliveryBlocked = deliveryIsBlocked ? Math.max(1, items.length) : 0
    return { items, readiness: deliveryBlocked > 0 ? 'blocked' as const : 'ready' as const, summary: { total: items.length, planned: items.filter(item => item.state === 'pending').length, published: items.filter(item => item.state === 'published').length, blocked: items.filter(item => ['blocked', 'failed', 'unknown', 'manual_attention'].includes(item.state)).length, delivery_blocked: deliveryBlocked, review_required: items.filter(item => ['review_required', 'approved'].includes(item.state)).length, in_progress: items.filter(item => ['generating', 'publishing'].includes(item.state)).length } }
  }

  /**
   * The delivery evidence a durable campaign item state proves.
   *
   * `CampaignDeliveryOrchestratorAdapter.materialize` refuses a durable row whose
   * item state contradicts its delivery evidence: `approved` requires
   * `review.status === 'approved'`, `publishing`/`published` require the matching
   * `publish.status`, and `failed` requires `publish.status === 'failed'`. A
   * projection that answered `blocked`/`not_ready` for *every* item therefore
   * contradicted every campaign that had moved past review, and because
   * `CAMPAIGN_INVALID_TRANSITION` is not one of the codes the evidence gate below
   * degrades to a blocked manifest, each `campaign.batch.*` call on such a
   * campaign answered a hard 409 — for a state the campaign workflow itself
   * produces.
   *
   * The mapping states what the durable row proves and nothing more. An item that
   * reached `approved`/`publishing`/`published` did pass review, so its review
   * status is `approved`; the approval, confirmation and receipt *records* are not
   * on the campaign row, so they stay absent. That absence is the missing evidence
   * this projection already refuses to invent, and the manifest machine reports it
   * as `CAMPAIGN_ITEM_EVIDENCE_REQUIRED` — an actionable blocked manifest, not a
   * contradiction. States that prove nothing about review keep the previous
   * `blocked`/`not_ready` reading (no approval may be carried unless the review
   * status is `approved`).
   */
  function campaignItemEvidence(item: CampaignItemRow) {
    switch (item.state) {
      case 'approved':
        return { review: { status: 'approved' as const }, publish: { status: 'not_ready' as const, attempts: 0 } }
      case 'publishing':
        return { review: { status: 'approved' as const }, publish: { status: 'publishing' as const, attempts: 1 } }
      case 'published':
        return { review: { status: 'approved' as const }, publish: { status: 'published' as const, attempts: 1 } }
      case 'failed':
        return { review: { status: 'blocked' as const, reason: item.error?.message ?? 'campaign item failed' }, publish: { status: 'failed' as const, attempts: 1, error: { code: item.error?.code ?? 'CAMPAIGN_ITEM_FAILED', message: item.error?.message ?? 'campaign item failed' } } }
      default:
        return { review: { status: 'blocked' as const, reason: ['blocked', 'failed', 'unknown', 'manual_attention'].includes(item.state) ? item.error?.message ?? 'campaign item blocked' : 'platform specification and rule evidence are externally unverified' }, publish: { status: 'not_ready' as const, attempts: 0 } }
    }
  }

  function campaignDeliveryInput(campaign: CampaignBatchRow): CampaignDeliveryManifestInput {
    const manifestHash = campaign.manifestHash ?? createHash('sha256').update(JSON.stringify({ workspaceId: campaign.workspaceId, campaignId: campaign.id, brandId: campaign.brandId, productIds: campaign.productIds })).digest('hex')
    const items = (campaign.items ?? []).map(item => {
      const task = item.taskId ? deps.service.tasks.get(item.taskId) : undefined
      if (task && (task.workspaceId !== campaign.workspaceId || task.campaignId !== campaign.id || task.campaignItemId !== item.id || task.productId !== item.productId || task.platform !== item.platform || task.accountId !== item.accountId || (item.canonicalProductId && task.canonicalProductId !== item.canonicalProductId) || (item.listingId && task.listingId !== item.listingId))) {
        throw new CampaignManifestError('CAMPAIGN_TASK_SCOPE_MISMATCH', `task ${task.id} 与 campaign item ${item.id} 的 workspace、campaign、商品或店铺 scope 不一致`, `items.${item.id}.taskId`)
      }
      // A campaign intent is not proof of a canonical listing. Never invent a
      // production identity for an unbound item; validation below must surface
      // the missing scope as an actionable blocked manifest.
      const listingId = item.listingId ?? ''
      const contentVersionId = task?.contentVersionId ?? `planned-content:${item.id}`
      const contentHash = createHash('sha256').update(JSON.stringify({ campaignId: campaign.id, itemId: item.id, taskId: task?.id ?? null, taskVersion: task?.version ?? 0, contentVersionId })).digest('hex')
      const visualVersion = { id: `planned-visual:${item.id}`, hash: createHash('sha256').update(`${manifestHash}:${item.id}:visual`).digest('hex') }
      // A campaign row proves durable intent, not an external platform canary or
      // rule capture. Keep these inputs explicitly unverified until repositories
      // provide applicable immutable evidence for this exact listing scope.
      const specification = { id: `unverified-campaign-spec:${campaign.id}:${item.id}`, hash: createHash('sha256').update(`${manifestHash}:${item.platform}:${item.accountId}:unverified`).digest('hex'), evidenceState: 'unverified' as const }
      const ruleSnapshot = { id: `unverified-campaign-rules:${campaign.id}:${item.id}`, hash: createHash('sha256').update(`${manifestHash}:${campaign.workspaceId}:${item.id}:rules:unverified`).digest('hex'), checkedAt: campaign.updatedAt, evidenceRef: '' }
      const visualVersions = [visualVersion]
      const versionVector = { campaignId: campaign.id, brandId: campaign.brandId, productId: item.productId, listingId, skuIds: [`planned-sku:${item.productId}`], platform: item.platform, accountId: item.accountId, contentVersionId, visualVersionIds: visualVersions.map(version => version.id), specificationId: specification.id, ruleSnapshotId: ruleSnapshot.id }
      return {
        id: item.id,
        productId: item.productId,
        listingId,
        skuIds: versionVector.skuIds,
        platform: item.platform,
        accountId: item.accountId,
        contentVersion: { id: contentVersionId, hash: contentHash },
        visualVersions,
        specification,
        ruleSnapshot,
        versionVector,
        ...campaignItemEvidence(item),
      }
    })
    return { id: `delivery-manifest:${campaign.id}`, workspaceId: campaign.workspaceId, campaignId: campaign.id, brandId: campaign.brandId, items, paused: campaign.state === 'paused', ...(campaign.state === 'paused' ? { pauseReason: 'durable campaign state is paused' } : {}), revision: campaign.revision ?? Math.max(1, Math.floor(Date.parse(campaign.updatedAt) / 1_000)) }
  }

  async function validateCampaignDelivery(operation: CampaignDeliveryLifecycleOperation, workspaceId: string, campaign: CampaignBatchRow, itemIds?: readonly string[]) {
    // This adapter is intentionally request-scoped. Its in-memory replay guard is
    // only a consistency check; the durable campaign row remains the source of truth.
    const input = campaignDeliveryInput(campaign)
    const durableProjection = { ...campaign, items: campaign.items?.map((item, index) => ({ ...item, listingId: item.listingId ?? input.items[index]!.listingId })) }
    const adapter = new CampaignDeliveryOrchestratorAdapter({ execute: async () => ({ row: durableProjection, deliveryItems: input.items, manifestId: input.id, pauseReason: input.pauseReason }) })
    try {
      // `itemIds` must reach the adapter: a partial `retry_failed` commits the
      // durable transition for the selected items first, so validating *every*
      // item afterwards saw the unselected ones still `failed` and threw
      // CAMPAIGN_INVALID_TRANSITION — returning 409 for work that was already
      // committed, with no way to retry the same key.
      const request = { workspaceId, campaignId: campaign.id, ...(itemIds?.length ? { itemIds } : {}) }
      if (operation === 'create') return (await adapter.create(request)).manifest
      if (operation === 'generate') return (await adapter.generate(request)).manifest
      if (operation === 'pause') return (await adapter.pause(request)).manifest
      if (operation === 'resume') return (await adapter.resume(request)).manifest
      if (operation === 'retry_failed') return (await adapter.retryFailed(request)).manifest
      return (await adapter.get(request)).manifest
    } catch (error) {
      if (error instanceof CampaignManifestError && ['CAMPAIGN_ITEM_EVIDENCE_REQUIRED', 'CAMPAIGN_MANIFEST_INVALID', 'CAMPAIGN_TASK_SCOPE_MISMATCH'].includes(error.code)) {
        const missingListing = error.code === 'CAMPAIGN_MANIFEST_INVALID'
        const items = (campaign.items ?? []).map(item => ({ id: item.id, productId: item.productId, platform: item.platform, accountId: item.accountId, state: 'blocked' as const, nextAction: missingListing ? 'canonical.product.consistency' as const : 'resolve_review' as const, blockers: [{ code: error.code, message: missingListing ? '缺少唯一规范 listing，不能伪造 planned-listing 身份' : '缺少与当前平台、店铺和商品范围绑定的真实规格或规则证据', path: error.path ?? null }] }))
        return { id: `delivery-manifest:${campaign.id}`, workspaceId, campaignId: campaign.id, brandId: campaign.brandId, state: campaign.state === 'paused' ? 'paused' as const : 'blocked' as const, paused: campaign.state === 'paused', revision: campaign.revision ?? 1, externallyUnverified: true, validation: { valid: false, code: error.code, path: error.path ?? null }, progress: { total: items.length, reviewed: 0, confirmed: 0, publishing: 0, published: 0, failed: 0, blocked: items.length, percent: 0 }, items }
      }
      if (error instanceof CampaignManifestError) throw new DomainError(error.code, error.message, 409, { path: error.path ?? null })
      throw error
    }
  }

  const CAMPAIGN_LIFECYCLE_METHODS = new Set(['campaign.batch.pause', 'campaign.batch.resume', 'campaign.batch.retry_failed'])

  function assertCampaignLifecycleParams(method: string, params: JsonObject) {
    for (const key of ['campaign_id', 'expected_revision', 'reason', 'idempotency_key']) if (typeof params[key] !== 'string' || !params[key].trim()) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 为必填字符串`, 400)
    if (!/^[1-9]\d*$/u.test(String(params.expected_revision))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_revision 必须是正整数', 400)
    if (String(params.reason).trim().length < 3 || String(params.reason).length > 1_000) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'reason 长度必须为 3 到 1000', 400)
    if (!/^[A-Za-z0-9._:-]{8,200}$/u.test(String(params.idempotency_key))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'idempotency_key 格式无效', 400)
    if (method === 'campaign.batch.retry_failed' && params.item_ids_json !== undefined && typeof params.item_ids_json !== 'string') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'item_ids_json 必须是 JSON 字符串数组', 400)
  }
  return { refreshCampaignProgress, campaignWorkflow, validateCampaignDelivery, CAMPAIGN_LIFECYCLE_METHODS, assertCampaignLifecycleParams }
}
