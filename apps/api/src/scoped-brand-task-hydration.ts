import { DomainError, type MerchantService, type Task } from '../../../packages/application/src/service.js'
import { parseScopedBrandSettings, resolveScopedBrandValues } from '../../../packages/application/src/scoped-brand-settings.js'
import { PostgresScopedBrandSettingsRepository, ScopedBrandBindingError } from '../../../packages/persistence/src/scoped-brand-settings-repository.js'

/** Freeze the current tenant-checked hierarchy before confirming a task plan. */
export async function hydrateScopedBrandForTask(input: {
  workspaceId: string
  task: Task
  service: MerchantService
  repository?: PostgresScopedBrandSettingsRepository
  requireRepository: boolean
}): Promise<void> {
  const { workspaceId, task, service, repository } = input
  if (task.workspaceId !== workspaceId) throw new DomainError('TENANT_SCOPE_DENIED', '任务不属于当前工作区', 403)
  if (!repository) {
    if (input.requireRepository) throw new DomainError('BRAND_SCOPES_NOT_CONFIGURED', '品牌配置服务尚未启用', 503)
    return
  }
  const product = service.products.get(task.productId)
  if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
  if (task.accountId) service.getActionablePlatformAccount(workspaceId, task.accountId, task.platform)
  const selected = Array.isArray(task.answers.asset_ids)
    ? task.answers.asset_ids.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : []
  const assetIds = selected.length ? selected : product.sourceAssetIds ?? []
  try {
    const frozen = await repository.resolveForTask({ workspaceId, accountId: task.accountId, selectedAssetIds: assetIds, validate: parseScopedBrandSettings })
    service.setScopedBrandForTask(workspaceId, task.id, frozen ? {
      revision: frozen.revision,
      context: frozen.context,
      values: resolveScopedBrandValues(frozen.settings, frozen.context),
    } : null)
  } catch (error) {
    if (error instanceof ScopedBrandBindingError) throw new DomainError(error.code, error.message, 409)
    throw error
  }
}
