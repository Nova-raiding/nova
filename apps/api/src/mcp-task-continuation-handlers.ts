import type { IncomingMessage } from 'node:http'
import { DomainError, type MerchantService, type Platform, type Product, type Task } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { OperationAudit } from '../../../packages/persistence/src/index.js'

type JsonObject = Record<string, unknown>
type CanonicalScope = { brandId: string; canonicalProductId: string; listingId: string } | undefined

export interface McpTaskContinuationDependencies {
  service: MerchantService
  required: (params: JsonObject, name: string) => string
  scopeTask: (req: IncomingMessage, taskId: string) => Task
  taskWriteBrandForProduct: (req: IncomingMessage, workspaceId: string, productId: string) => Promise<string | undefined>
  supportedPlatforms: readonly Platform[]
  assertCanonicalTaskScopeForAction: (task: Task) => Promise<unknown>
  resolveCanonicalTaskScope: (input: { workspaceId: string; productId: string; platform: Platform; accountId?: string; brandId?: string; requireListing?: boolean }) => Promise<CanonicalScope>
  persistSnapshot: (workspaceId: string, entityType: 'task', entity: Task, value: Record<string, unknown>) => Promise<void>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<void>
  requestActor: (req: IncomingMessage, fallback?: string) => string
  hydrateDurableRuleSnapshot: (workspaceId: string, product: Product) => Promise<unknown>
  recordOperationAudit: (input: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
}

export async function handleMcpTaskContinuation(method: string, params: JsonObject, req: IncomingMessage, workspaceId: string, deps: McpTaskContinuationDependencies): Promise<unknown> {
  const { service, required, scopeTask, taskWriteBrandForProduct, supportedPlatforms: SUPPORTED_PLATFORMS, assertCanonicalTaskScopeForAction, resolveCanonicalTaskScope, persistSnapshot, persistEvent, requestActor, hydrateDurableRuleSnapshot, recordOperationAudit } = deps
  switch (method) {
    case 'task.clone': {
      const source = scopeTask(req, required(params, 'task_id'))
      const targetProductId = typeof params.target_product_id === 'string' && params.target_product_id.trim() ? params.target_product_id.trim() : undefined
      const targetBrandId = targetProductId ? await taskWriteBrandForProduct(req, workspaceId, targetProductId) : undefined
      const targetPlatform = typeof params.target_platform === 'string' && SUPPORTED_PLATFORMS.includes(params.target_platform as Platform) ? params.target_platform as Platform : undefined
      if (typeof params.target_platform === 'string' && !targetPlatform) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'target_platform 不是支持的平台', 400)
      if (targetPlatform && !targetProductId) throw new DomainError('TARGET_PRODUCT_REQUIRED', '跨平台复制必须指定目标商品 ID，以重新加载目标平台商品事实和规则', 400)
      const targetAccountId = typeof params.target_account_id === 'string' && params.target_account_id.trim() ? params.target_account_id.trim() : undefined
      if (source.candidateOnly === true && (targetAccountId || (targetProductId && targetProductId !== source.productId))) {
        throw new DomainError('CANDIDATE_TASK_SCOPE_INVALID', '候选任务不能复制到其他商品或绑定店铺', 409, { task_id: source.id })
      }
      const targetProduct = targetProductId ? service.listProducts(workspaceId).find(product => product.id === targetProductId) : service.listProducts(workspaceId).find(product => product.id === source.productId)
      const effectiveTargetPlatform = targetPlatform ?? targetProduct?.platform ?? source.platform
      const effectiveTargetAccountId = targetAccountId ?? targetProduct?.accountId
      // An explicit account-only clone is also a scope rebind.  Without this
      // branch, a historical task whose account drifted from the product would
      // re-run the source-task canonical assertion and could never be safely
      // carried forward into a fresh task.
      const requiresScopeRebind = Boolean(
        (targetProductId && (targetProductId !== source.productId || effectiveTargetPlatform !== source.platform || effectiveTargetAccountId !== source.accountId))
        || (targetAccountId && targetAccountId !== source.accountId),
      )
      if (!requiresScopeRebind) await assertCanonicalTaskScopeForAction(source)
      const reboundScope = requiresScopeRebind && targetProduct
        ? await resolveCanonicalTaskScope({ workspaceId, productId: targetProduct.id, platform: effectiveTargetPlatform, ...(effectiveTargetAccountId ? { accountId: effectiveTargetAccountId } : {}), ...(targetBrandId ? { brandId: targetBrandId } : {}), requireListing: true })
        : undefined
      const cloned = service.cloneTask(workspaceId, source.id, typeof params.request_text === 'string' ? params.request_text : undefined, { ...(targetProductId ? { productId: targetProductId } : {}), ...(targetPlatform ? { platform: targetPlatform } : {}), ...(targetAccountId ? { accountId: targetAccountId } : {}), ...(reboundScope ? { brandId: reboundScope.brandId, canonicalProductId: reboundScope.canonicalProductId, listingId: reboundScope.listingId } : {}), ...(typeof params.region === 'string' && params.region.trim() ? { region: params.region.trim() } : {}) })
      if (targetBrandId) cloned.brandId = targetBrandId
      await persistSnapshot(workspaceId, 'task', cloned, cloned as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, cloned.id, 'task.cloned', cloned.version, { task_id: cloned.id, source_task_id: source.id, source_platform: source.platform, target_platform: cloned.platform, target_product_id: cloned.productId, rule_reload_required: cloned.platform !== source.platform })
      return ({ task: cloned, sourceTaskId: source.id, copyMode: cloned.platform === source.platform ? 'same_platform_fresh_task' : 'cross_platform_fresh_task', ruleReloadRequired: cloned.platform !== source.platform, staleContentCopied: false, stalePromotionCopied: false })
    }
    case 'task.select_direction': {
      const task = scopeTask(req, required(params, 'task_id'))
      const selected = service.selectDirection(task.id, required(params, 'direction_id'), typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined)
      await persistSnapshot(workspaceId, 'task', selected, selected as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, selected.id, 'task.direction_selected', selected.version, { task_id: selected.id, direction_id: selected.selectedDirectionId ?? null })
      return ({ ...selected, task_id: selected.id, expected_version: selected.version })
    }
    case 'task.plan.confirm': {
      const task = scopeTask(req, required(params, 'task_id'))
      await assertCanonicalTaskScopeForAction(task)
      const priceImpactConfirmed = params.price_impact_confirmed === true || params.price_impact_confirmed === 'true'
      const planProduct = service.products.get(task.productId)
      if (planProduct) await hydrateDurableRuleSnapshot(workspaceId, planProduct)
      const confirmed = service.confirmProductionPlan(workspaceId, task.id, requestActor(req, typeof params.actor_id === 'string' && params.actor_id.trim() ? params.actor_id.trim() : 'merchant'), typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined, priceImpactConfirmed)
      await persistSnapshot(workspaceId, 'task', confirmed, confirmed as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, confirmed.id, 'task.plan_confirmed', confirmed.version, { task_id: confirmed.id, plan_id: confirmed.productionPlan?.id ?? null, actor_id: confirmed.productionPlan?.confirmedBy ?? null })
      await recordOperationAudit({ workspaceId, actorId: confirmed.productionPlan?.confirmedBy ?? requestActor(req), action: 'task.plan_confirmed', resourceType: 'task', resourceId: confirmed.id, before: { state: task.state, version: task.version }, after: { state: confirmed.state, version: confirmed.version, plan_id: confirmed.productionPlan?.id ?? null }, reason: '确认生产方案' })
      return ({ ...confirmed, task_id: confirmed.id, expected_version: confirmed.version })
    }
    default: throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知任务延续 MCP 方法: ${method}`, 400)
  }
}
