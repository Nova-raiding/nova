import {
  CampaignDeliveryManifestMachine,
  CampaignManifestError,
  type CampaignDeliveryManifestInput,
  type CampaignDeliveryItemInput,
  type CampaignDeliveryManifestSnapshot,
} from './campaign-delivery-manifest.js'

export type CampaignDeliveryLifecycleOperation = 'create' | 'generate' | 'get' | 'pause' | 'resume' | 'retry_failed'

export interface CampaignDeliveryLifecycleRequest {
  workspaceId: string
  campaignId?: string
  idempotencyKey?: string
  itemIds?: readonly string[]
  reason?: string
  [key: string]: unknown
}

export type DurableCampaignItemState = 'pending' | 'blocked' | 'generating' | 'review_required' | 'approved' | 'publishing' | 'published' | 'failed' | 'unknown' | 'paused' | 'manual_attention'
export type DurableCampaignState = 'draft' | 'preflighting' | 'ready' | 'blocked' | 'generating' | 'review_required' | 'publishing' | 'partial' | 'completed' | 'failed' | 'paused' | 'unknown' | 'manual_attention'

/** Structural subset of the persistence CampaignBatchRow. */
export interface DurableCampaignRowInput {
  id: string
  workspaceId: string
  brandId: string
  state: DurableCampaignState
  revision?: number
  items?: ReadonlyArray<{
    id: string
    workspaceId: string
    campaignId: string
    brandId: string
    productId: string
    platform: CampaignDeliveryItemInput['platform']
    accountId: string
    listingId?: string
    state: DurableCampaignItemState
    ordinal: number
  }>
}

/**
 * The durable row owns lifecycle state and scope. Rich immutable delivery
 * evidence is supplied separately because it is stored by the task/content
 * repositories rather than on batch_campaign_items.
 */
export interface DurableCampaignDeliveryProjection {
  row: DurableCampaignRowInput
  deliveryItems: readonly CampaignDeliveryItemInput[]
  manifestId?: string
  pauseReason?: string
}

export type CampaignDeliveryLifecycleOutput = CampaignDeliveryManifestInput | DurableCampaignDeliveryProjection

/**
 * Persistence/server-facing port. Existing campaign.batch handlers can expose
 * their durable row as a complete delivery-manifest input without importing
 * MerchantService or moving campaign ownership into the application service.
 */
export interface CampaignDeliveryLifecyclePort {
  execute(operation: CampaignDeliveryLifecycleOperation, request: CampaignDeliveryLifecycleRequest): Promise<CampaignDeliveryLifecycleOutput>
}

export interface CampaignDeliveryLifecycleResult {
  operation: CampaignDeliveryLifecycleOperation
  manifest: CampaignDeliveryManifestSnapshot
}

/**
 * Validates every durable campaign lifecycle result through the manifest state
 * machine. It also rejects cross-workspace replacement and regressing durable
 * revisions, so create/generate/get/pause/resume/retry cannot return unrelated
 * or stale state under the same campaign key. Identical revisions are accepted
 * only as byte-equivalent idempotent replays.
 */
export class CampaignDeliveryOrchestratorAdapter {
  private readonly snapshots = new Map<string, CampaignDeliveryManifestSnapshot>()

  constructor(private readonly port: CampaignDeliveryLifecyclePort) {}

  create(request: CampaignDeliveryLifecycleRequest) { return this.execute('create', request) }
  generate(request: CampaignDeliveryLifecycleRequest) { return this.execute('generate', request) }
  get(request: CampaignDeliveryLifecycleRequest) { return this.execute('get', request) }
  pause(request: CampaignDeliveryLifecycleRequest) { return this.execute('pause', request) }
  resume(request: CampaignDeliveryLifecycleRequest) { return this.execute('resume', request) }
  retryFailed(request: CampaignDeliveryLifecycleRequest) { return this.execute('retry_failed', request) }

  private materialize(output: CampaignDeliveryLifecycleOutput, operation: CampaignDeliveryLifecycleOperation, request: CampaignDeliveryLifecycleRequest): CampaignDeliveryManifestInput {
    if (!('row' in output)) return output
    const { row } = output
    if (!Number.isInteger(row.revision) || (row.revision ?? 0) < 1) throw new CampaignManifestError('CAMPAIGN_MANIFEST_INVALID', 'durable campaign revision 必须是正整数', 'revision')
    if (!row.items?.length) throw new CampaignManifestError('CAMPAIGN_MANIFEST_INVALID', 'durable campaign 缺少 items', 'items')
    if (row.items.length !== output.deliveryItems.length) throw new CampaignManifestError('CAMPAIGN_VERSION_SCOPE_LEAK', 'durable campaign item 与 delivery evidence 数量不一致', 'items')
    const evidenceById = new Map(output.deliveryItems.map(item => [item.id, item]))
    if (evidenceById.size !== output.deliveryItems.length) throw new CampaignManifestError('CAMPAIGN_ITEM_DUPLICATE', 'delivery evidence item ID 重复', 'items')
    const deliveryItems = row.items.map((durableItem, index) => {
      const evidence = evidenceById.get(durableItem.id)
      if (!evidence) throw new CampaignManifestError('CAMPAIGN_VERSION_SCOPE_LEAK', `durable item ${durableItem.id} 缺少 delivery evidence`, `items[${index}]`)
      const scopeMatches = durableItem.workspaceId === row.workspaceId
        && durableItem.campaignId === row.id
        && durableItem.brandId === row.brandId
        && durableItem.productId === evidence.productId
        && durableItem.listingId === evidence.listingId
        && durableItem.platform === evidence.platform
        && durableItem.accountId === evidence.accountId
      if (!scopeMatches) throw new CampaignManifestError('CAMPAIGN_VERSION_SCOPE_LEAK', `durable item ${durableItem.id} 与 delivery evidence scope 不一致`, `items[${index}]`)
      const stateMatches = durableItem.state === 'published' ? evidence.publish.status === 'published'
        : durableItem.state === 'publishing' ? evidence.publish.status === 'publishing'
          : durableItem.state === 'failed' ? evidence.publish.status === 'failed'
            : durableItem.state === 'approved' ? evidence.review.status === 'approved'
              : durableItem.state === 'blocked' ? evidence.review.status === 'blocked'
                : true
      if (!stateMatches) throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', `durable item ${durableItem.id} 状态与 delivery evidence 不一致`, `items[${index}].state`)
      return structuredClone(evidence)
    })
    const paused = row.state === 'paused'
    if (operation === 'retry_failed') {
      const selected = request.itemIds?.length ? new Set(request.itemIds) : undefined
      for (const [index, durableItem] of row.items.entries()) {
        if ((!selected || selected.has(durableItem.id)) && (durableItem.state === 'failed' || durableItem.state === 'paused' || deliveryItems[index]!.publish.status === 'failed')) {
          throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', `retry_failed 未推进 item ${durableItem.id}`, `items[${index}].state`)
        }
      }
    }
    return {
      id: output.manifestId?.trim() || `campaign-delivery:${row.id}`,
      workspaceId: row.workspaceId,
      campaignId: row.id,
      brandId: row.brandId,
      items: deliveryItems,
      paused,
      ...(paused && (output.pauseReason?.trim() || request.reason?.trim()) ? { pauseReason: output.pauseReason?.trim() || request.reason!.trim() } : {}),
      revision: row.revision,
    }
  }

  private async execute(operation: CampaignDeliveryLifecycleOperation, request: CampaignDeliveryLifecycleRequest): Promise<CampaignDeliveryLifecycleResult> {
    const workspaceId = request.workspaceId.normalize('NFKC').trim()
    if (!workspaceId) throw new CampaignManifestError('CAMPAIGN_MANIFEST_INVALID', 'workspaceId 不能为空', 'workspaceId')
    const input = this.materialize(await this.port.execute(operation, request), operation, request)
    if (input.workspaceId !== workspaceId) throw new CampaignManifestError('CAMPAIGN_VERSION_SCOPE_LEAK', 'campaign 生命周期结果不属于请求工作区', 'workspaceId')
    if (request.campaignId && input.campaignId !== request.campaignId) throw new CampaignManifestError('CAMPAIGN_VERSION_SCOPE_LEAK', 'campaign 生命周期结果与请求 campaign 不一致', 'campaignId')
    const manifest = new CampaignDeliveryManifestMachine(input).snapshot()
    if (operation === 'pause' && !manifest.paused) throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', 'pause 操作必须返回 paused manifest', 'paused')
    if ((operation === 'resume' || operation === 'retry_failed') && manifest.paused) throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', `${operation} 操作不能返回 paused manifest`, 'paused')
    const key = `${manifest.workspaceId}:${manifest.campaignId}`
    const previous = this.snapshots.get(key)
    if (previous && manifest.revision < previous.revision) throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', 'campaign 生命周期返回了旧 revision', 'revision')
    if (previous && manifest.revision === previous.revision && JSON.stringify(manifest) !== JSON.stringify(previous)) throw new CampaignManifestError('CAMPAIGN_INVALID_TRANSITION', '相同 campaign revision 返回了不同状态', 'revision')
    this.snapshots.set(key, structuredClone(manifest))
    return { operation, manifest }
  }
}
