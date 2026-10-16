import type { IncomingMessage } from 'node:http'
import type { MerchantService } from '../../../packages/application/src/service.js'
import type { PostgresBusinessRepository } from '../../../packages/persistence/src/business-repository.js'

type Assets = ReturnType<MerchantService['listAssets']>
export interface WorkspaceContentSummaryDependencies {
  service: Pick<MerchantService, 'listProducts' | 'listTasks' | 'listAssets'>
  business?: Pick<PostgresBusinessRepository, 'listProductsPage' | 'listTasksPage'>
  accessibleTaskBrandIds: (req: IncomingMessage, workspaceId: string) => Promise<readonly string[] | undefined>
  accessibleProductIds: (req: IncomingMessage, workspaceId: string) => Promise<ReadonlySet<string> | undefined>
  accessibleAssetIds: (req: IncomingMessage, workspaceId: string) => Promise<ReadonlySet<string> | undefined>
  filterActiveAssets: (workspaceId: string, assets: Assets) => Promise<Assets>
}

// Match catalog.search(scope=workspace), task.history and asset.list. Store
// onboarding is a separate projection and excludes unbound candidate work.
export async function workspaceContentSummary(req: IncomingMessage, workspaceId: string, deps: WorkspaceContentSummaryDependencies) {
  const brandIds = await deps.accessibleTaskBrandIds(req, workspaceId)
  const page = { limit: 1, offset: 0, ...(brandIds !== undefined ? { accessibleBrandIds: brandIds } : {}) }
  const counts = deps.business
    ? await Promise.all([
      deps.business.listProductsPage(workspaceId, page).then(result => result.total),
      deps.business.listTasksPage(workspaceId, page).then(result => result.total),
    ])
    : await (async () => {
      const productIds = await deps.accessibleProductIds(req, workspaceId)
      return [
        deps.service.listProducts(workspaceId).filter(product => productIds === undefined || productIds.has(product.id)).length,
        deps.service.listTasks(workspaceId).filter(task => brandIds === undefined || Boolean(task.brandId && brandIds.includes(task.brandId))).length,
      ]
    })()
  const assetIds = await deps.accessibleAssetIds(req, workspaceId)
  const activeAssets = await deps.filterActiveAssets(workspaceId, deps.service.listAssets(workspaceId))
  const assets = activeAssets.filter(asset => assetIds === undefined || assetIds.has(asset.id))
  return {
    scope: 'visible_workspace' as const,
    products: counts[0]!,
    assets: assets.length,
    // listAssets already applies the environment's scan/readiness policy.
    readyAssets: assets.filter(asset => asset.readiness.status === 'ready').length,
    tasks: counts[1]!,
  }
}
