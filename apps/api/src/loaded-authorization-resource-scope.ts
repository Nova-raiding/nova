import type { MerchantService } from '../../../packages/application/src/service.js'
import { getMcpMethodPolicy } from '../../../packages/contracts/src/index.js'
import { resolveAuthorizationResourceScope } from './authorization-projection-helpers.js'

interface LoadedAuthorizationScopeDependencies {
  service: MerchantService
  getTaskSnapshot?: (workspaceId: string, taskId: string) => Promise<{ payload: Record<string, unknown> }>
  listCanonicalProducts: (input: { workspaceId: string; sourceProductIds: string[] }) => Promise<Array<{ brandId: string }>>
}

export async function resolveLoadedAuthorizationResourceScopeWithDependencies(policy: NonNullable<ReturnType<typeof getMcpMethodPolicy>>, workspaceId: string, params: Record<string, unknown>, principal: { actorId: string } | undefined, deps: LoadedAuthorizationScopeDependencies) {
  const direct = resolveAuthorizationResourceScope(policy, workspaceId, params, principal)
  const taskId = typeof params.task_id === 'string' && params.task_id.trim() ? params.task_id.trim() : undefined
  const contentVersionId = typeof params.content_version_id === 'string' && params.content_version_id.trim() ? params.content_version_id.trim() : undefined
  // For task-bound account/brand operations, resolve the authoritative task
  // scope before accepting caller-supplied account_id or brand_id.  The input
  // remains available for the handler's explicit conflict check; it must not
  // be able to make the authorization decision target a different store.
  const taskBound = Boolean(taskId || contentVersionId)
  if ((direct?.id && !taskBound) || (direct?.type !== 'brand' && direct?.type !== 'account')) return direct
  const contentVersion = contentVersionId ? deps.service.contentVersions.get(contentVersionId) : undefined
  let requestedTask = taskId ? deps.service.tasks.get(taskId) : undefined
  // Authorization runs before the route handler and may be the first request
  // after an API restart. Load the exact task snapshot from the tenant-scoped
  // repository so a durable task is not mistaken for an unresolved brand
  // resource merely because the compatibility map is still cold.
  if (!requestedTask && taskId && deps.getTaskSnapshot) {
    try {
      const snapshot = await deps.getTaskSnapshot(workspaceId, taskId)
      deps.service.hydrateSnapshot({ entityType: 'task', entity: snapshot.payload })
      requestedTask = deps.service.tasks.get(taskId)
    } catch { /* the route-level scope check remains the final not-found boundary */ }
  }
  const contentTask = contentVersion ? deps.service.tasks.get(contentVersion.taskId) : undefined
  const requestedProductId = typeof params.product_id === 'string' && params.product_id.trim() ? params.product_id.trim() : undefined
  const requestedProduct = requestedProductId ? deps.service.products.get(requestedProductId) : undefined
  if (taskId && (!requestedTask || requestedTask.workspaceId !== workspaceId)) return unresolvedLoadedResourceScope(direct)
  if (contentVersionId && (!contentVersion || !contentTask || contentTask.workspaceId !== workspaceId)) return unresolvedLoadedResourceScope(direct)
  if (requestedProductId && (!requestedProduct || requestedProduct.workspaceId !== workspaceId)) return unresolvedLoadedResourceScope(direct)
  if (requestedTask && contentTask && requestedTask.id !== contentTask.id) return unresolvedLoadedResourceScope(direct)
  const resourceTask = requestedTask ?? contentTask
  if (resourceTask && requestedProduct && resourceTask.productId !== requestedProduct.id) return unresolvedLoadedResourceScope(direct)
  const generationJobId = policy.method === 'generation.get' && typeof params.job_id === 'string' && params.job_id.trim() ? params.job_id.trim() : undefined
  const generationJob = generationJobId ? deps.service.generationJobs.get(generationJobId) : undefined
  const publishJobId = policy.method === 'publish.get' && typeof params.publish_job_id === 'string' && params.publish_job_id.trim() ? params.publish_job_id.trim() : undefined
  const publishJob = publishJobId ? deps.service.publishJobs.get(publishJobId) : undefined
  const task = requestedTask
    ? requestedTask
    : contentTask
      ? contentTask
      : generationJob?.workspaceId === workspaceId
        ? deps.service.tasks.get(generationJob.taskId)
        : publishJob?.workspaceId === workspaceId
          ? deps.service.tasks.get(publishJob.taskId)
        : undefined
  if (task?.workspaceId === workspaceId) {
    if (direct.type === 'brand') {
      // Authorization only needs the canonical rows bound to this task's legacy
      // product; reading the whole catalog made every resource-scoped request
      // pay for catalog size.
      const canonical = await deps.listCanonicalProducts({ workspaceId, sourceProductIds: [task.productId] })
      const canonicalBrandIds = [...new Set(canonical.map(item => item.brandId))]
      if (task.brandId && canonicalBrandIds.length === 1 && canonicalBrandIds[0] === task.brandId) return { type: 'brand' as const, id: task.brandId }
      // A historical task may retain an explicit frozen brand scope while its
      // canonical mapping is not available yet. Preserve that narrow scope
      // for authorization; do not downgrade it to workspace access.
      if (task.brandId && canonicalBrandIds.length === 0) return { type: 'brand' as const, id: task.brandId }
      // Legacy/fixture tasks may be intentionally unbranded. Keep the
      // operation task-bound and auditable instead of treating a missing
      // brand as an arbitrary caller-selected scope.
      if (!task.brandId && canonicalBrandIds.length === 0) return { type: 'brand' as const, id: `task:${task.id}` }
      return { type: 'brand' as const, id: undefined }
    }
    return { type: 'account' as const, id: task.accountId }
  }
  const productId = typeof params.product_id === 'string' && params.product_id.trim() ? params.product_id.trim() : undefined
  const imageJobId = typeof params.job_id === 'string' && params.job_id.trim() ? params.job_id.trim() : undefined
  const visualRef = typeof params.visual_ref === 'string' && params.visual_ref.trim() ? params.visual_ref.trim() : undefined
  const imageJob = imageJobId
    ? deps.service.imageGenerationJobs.get(imageJobId)
    : visualRef
      ? [...deps.service.imageGenerationJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.outputs?.some(output => output.visualRef === visualRef))
      : undefined
  const product = productId
    ? deps.service.products.get(productId)
    : imageJob?.workspaceId === workspaceId
      ? deps.service.products.get(imageJob.productId)
      : undefined
  if (!product || product.workspaceId !== workspaceId) return direct
  if (direct.type === 'account') return { type: 'account' as const, id: product.accountId }
  const canonical = await deps.listCanonicalProducts({ workspaceId, sourceProductIds: [product.id] })
  const brandIds = [...new Set(canonical.map(item => item.brandId))]
  return { type: 'brand' as const, id: brandIds.length === 1 ? brandIds[0] : undefined }
}

function unresolvedLoadedResourceScope(scope: ReturnType<typeof resolveAuthorizationResourceScope>) {
  return scope?.type === 'brand' || scope?.type === 'account' ? { type: scope.type, id: undefined } : scope
}

