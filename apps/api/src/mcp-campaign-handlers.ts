import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import type { BrandUnitPlatform, BrandUnitRepository, CampaignBatchRow } from '../../../packages/persistence/src/brand-unit-repository.js'

type CampaignRepository = Pick<BrandUnitRepository, 'listCampaigns' | 'getCampaign'>
type DeliveryManifest = Awaited<ReturnType<CampaignHandlerDependencies['validateCampaignDelivery']>>

export interface CampaignHandlerDependencies {
  repository: CampaignRepository
  persistenceMode: string
  persistenceReady: Promise<unknown>
  enforceBrandAccess: (request: IncomingMessage, workspaceId: string, brandId: string) => Promise<unknown>
  validateCampaignDelivery: (operation: 'get', workspaceId: string, campaign: CampaignBatchRow) => Promise<{ state?: string; validation?: { valid?: boolean; code?: string | null; path?: string | null } }>
  campaignWorkflow: (campaign: CampaignBatchRow, deliveryManifest: DeliveryManifest) => { readiness: 'ready' | 'blocked'; items: unknown[]; summary: unknown }
  refreshCampaignProgress: (campaign: CampaignBatchRow) => Promise<CampaignBatchRow>
}

export async function listCampaignBatches(
  request: IncomingMessage,
  workspaceId: string,
  params: Record<string, unknown>,
  dependencies: CampaignHandlerDependencies,
) {
  const platform = typeof params.platform === 'string' && params.platform.trim() ? params.platform as BrandUnitPlatform : undefined
  const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
  const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(Math.max(Number(params.limit), 1), 100) : 50
  if (accountId && !platform) throw new DomainError('STORE_PLATFORM_REQUIRED', '使用 account_id 筛选批量计划时必须同时指定 platform', 400)
  await dependencies.persistenceReady
  const listed = await dependencies.repository.listCampaigns({ workspaceId, ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}), limit })
  const visible = []
  for (const campaign of listed) {
    try { await dependencies.enforceBrandAccess(request, workspaceId, campaign.brandId) } catch { continue }
    const deliveryManifest = await dependencies.validateCampaignDelivery('get', workspaceId, campaign)
    const workflow = dependencies.campaignWorkflow(campaign, deliveryManifest)
    const validation = 'validation' in deliveryManifest ? deliveryManifest.validation : undefined
    visible.push({
      id: campaign.id,
      state: campaign.state,
      revision: campaign.revision ?? 1,
      platform: campaign.platform,
      accountId: campaign.accountId,
      brandId: campaign.brandId,
      productIds: campaign.productIds,
      targets: (campaign.targets ?? campaign.items?.map(item => ({ productId: item.productId, platform: item.platform, accountId: item.accountId, brandId: item.brandId, ...(item.canonicalProductId ? { canonicalProductId: item.canonicalProductId } : {}), ...(item.listingId ? { listingId: item.listingId } : {}), ...(item.taskId ? { taskId: item.taskId } : {}), state: item.state })) ?? campaign.productIds.map(productId => ({ productId, platform: campaign.platform, accountId: campaign.accountId, brandId: campaign.brandId }))).map(target => ({ ...target, brandId: ('brandId' in target && target.brandId) ? target.brandId : campaign.brandId })),
      itemCount: campaign.items?.length ?? campaign.productIds.length,
      failedCount: campaign.items?.filter(item => item.state === 'failed').length ?? 0,
      readiness: workflow.readiness,
      delivery: { state: deliveryManifest.state ?? null, valid: validation?.valid ?? null, code: validation?.code ?? null, path: validation?.path ?? null },
      nextAction: validation?.valid === false ? 'canonical.product.consistency' : null,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
    })
  }
  return { items: visible, count: visible.length, storage: dependencies.persistenceMode, durable: dependencies.persistenceMode === 'postgres' }
}

export async function getCampaignBatch(
  request: IncomingMessage,
  workspaceId: string,
  campaignId: string,
  dependencies: CampaignHandlerDependencies,
) {
  await dependencies.persistenceReady
  let campaign = await dependencies.repository.getCampaign({ workspaceId, id: campaignId })
  if (!campaign) throw new DomainError('CAMPAIGN_BATCH_NOT_FOUND', '批量运营计划不存在或不属于当前工作区', 404, { campaign_id: campaignId })
  await dependencies.enforceBrandAccess(request, workspaceId, campaign.brandId)
  campaign = await dependencies.refreshCampaignProgress(campaign)
  const deliveryManifest = await dependencies.validateCampaignDelivery('get', workspaceId, campaign)
  const targets = campaign.targets?.map(target => ({ ...target, brandId: campaign.brandId }))
  return { ...campaign, ...(targets ? { targets } : {}), count: campaign.productIds.length, ...dependencies.campaignWorkflow(campaign, deliveryManifest), delivery_manifest: deliveryManifest, storage: dependencies.persistenceMode, durable: dependencies.persistenceMode === 'postgres', execution: campaign.taskIds?.length ? 'workflow_active' : 'plan_only', message: campaign.taskIds?.length ? '批量工作流已激活；每个商品会停在需要事实确认、方向确认、审核或发布确认的安全节点。' : '批量运营计划已持久化；调用 campaign.batch.generate 创建逐商品工作流。' }
}
