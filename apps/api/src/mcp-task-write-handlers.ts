import type { IncomingMessage } from 'node:http'
import { DomainError, type MerchantService, type Platform, type Task } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

type JsonObject = Record<string, unknown>
type Understanding = ReturnType<MerchantService['understandTaskRequest']>
type TaskEntry = { productId: string; platform: Platform; accountId?: string; region?: string; skuId?: string; brandId?: string }
type CanonicalScope = { brandId: string; canonicalProductId: string; listingId: string } | undefined

export interface McpTaskWriteDependencies {
  service: MerchantService
  required: (params: JsonObject, name: string) => string
  supportedPlatforms: readonly Platform[]
  fixtureMode: boolean
  isProduction: () => boolean
  requireEnabledPlatform: (workspaceId: string, platform: Platform) => Promise<void>
  resolveTaskAccountId: (workspaceId: string, platform: Platform, requested?: string) => string | undefined
  taskCreationBrand: (req: IncomingMessage, workspaceId: string, value: unknown) => Promise<string | undefined>
  enforceProductBrandAccess: (req: IncomingMessage, workspaceId: string, productId: string) => Promise<void>
  requireProductionTaskStore: (platform: Platform, accountId: string | undefined) => void
  resolveCanonicalTaskScope: (input: { workspaceId: string; productId: string; platform: Platform; accountId?: string; brandId?: string; requireListing?: boolean }) => Promise<CanonicalScope>
  persistSnapshot: (workspaceId: string, entityType: 'task', entity: Task, value: Record<string, unknown>) => Promise<void>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<void>
  workspaceStoreDirectory: (workspaceId: string, platform?: Platform) => Array<{ accountId: string }>
  scopeTask: (req: IncomingMessage, taskId: string) => Task
  persistTaskAnswerFactConfirmation: (input: { workspaceId: string; productId: string; factsConfirmedBefore: boolean; confirmationRequested: boolean }) => Promise<void>
  enforceTaskRequestCandidates: (req: IncomingMessage, workspaceId: string, understanding: Understanding) => Promise<Understanding>
  taskUnderstandingProductIds: (understanding: Understanding) => string[]
  resolveTaskWriteBrands: (req: IncomingMessage, workspaceId: string, productIds: readonly string[]) => Promise<ReadonlyMap<string, string | undefined>>
  assignTaskWriteBrands: (tasks: Array<{ productId: string; brandId?: string }>, resolved: ReadonlyMap<string, string | undefined>) => void
  requireProductionRequestStores: (workspaceId: string, understanding: Understanding) => void
  header: (req: IncomingMessage, name: string) => string | undefined
  resolveCanonicalTaskEntries: (workspaceId: string, entries: TaskEntry[]) => Promise<TaskEntry[]>
  assertCanonicalTaskScopeForAction: (task: Task) => Promise<unknown>
}

export async function handleMcpTaskWrite(method: string, params: JsonObject, req: IncomingMessage, workspaceId: string, deps: McpTaskWriteDependencies): Promise<unknown> {
  const { service, required, supportedPlatforms: SUPPORTED_PLATFORMS, fixtureMode, isProduction, requireEnabledPlatform, resolveTaskAccountId, taskCreationBrand, enforceProductBrandAccess, requireProductionTaskStore, resolveCanonicalTaskScope, persistSnapshot, persistEvent, workspaceStoreDirectory, scopeTask, persistTaskAnswerFactConfirmation, enforceTaskRequestCandidates, taskUnderstandingProductIds, resolveTaskWriteBrands, assignTaskWriteBrands, requireProductionRequestStores, header, resolveCanonicalTaskEntries, assertCanonicalTaskScopeForAction } = deps
  switch (method) {
    case 'task.create': {
      const taskPlatform = required(params, 'platform') as Platform
      await requireEnabledPlatform(workspaceId, taskPlatform)
      const productId = required(params, 'product_id')
      const product = service.products.get(productId)
      const taskAccountId = resolveTaskAccountId(workspaceId, taskPlatform, typeof params.account_id === 'string' ? params.account_id : undefined) ?? (product?.workspaceId === workspaceId && product.platform === taskPlatform ? product.accountId : undefined)
      const brandId = await taskCreationBrand(req, workspaceId, params.brand_id)
      await enforceProductBrandAccess(req, workspaceId, productId)
      requireProductionTaskStore(taskPlatform, taskAccountId)
      if ((isProduction() || fixtureMode) && taskAccountId) service.getActionablePlatformAccount(workspaceId, taskAccountId, taskPlatform)
      const canonicalScope = await resolveCanonicalTaskScope({ workspaceId, productId, platform: taskPlatform, ...(taskAccountId ? { accountId: taskAccountId } : {}), ...(brandId ? { brandId } : {}), requireListing: true })
      const task = service.createTask({ workspaceId, productId, platform: taskPlatform, ...(taskAccountId ? { accountId: taskAccountId } : {}), ...(canonicalScope ?? (brandId ? { brandId } : {})), ...(typeof params.region === 'string' ? { region: params.region } : {}) })
      await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, task.id, 'task.created', task.version, task as unknown as Record<string, unknown>)
      const storeContext = task.accountId ? workspaceStoreDirectory(workspaceId, taskPlatform).find(store => store.accountId === task.accountId) : undefined
      return ({ ...task, task_id: task.id, product_id: task.productId, storeContext: storeContext ?? null, selectionSource: product?.accountId ? 'product_binding' : task.accountId ? 'explicit_request' : 'unbound' })
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
      const answeredProductId = typeof answers.product_id === 'string' && answers.product_id.trim() ? answers.product_id.trim() : task.productId
      const factsConfirmedBefore = service.products.get(answeredProductId)?.factsConfirmed === true
      const answered = service.answerTask(workspaceId, task.id, answers, typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined)
      await persistSnapshot(workspaceId, 'task', answered, answered as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, task.id, 'task.answers_submitted', answered.version, { task_id: task.id, input_snapshot_id: answered.inputSnapshotId, answers: answered.answers, missing_questions: answered.missingQuestions })
      await persistTaskAnswerFactConfirmation({ workspaceId, productId: answered.productId, factsConfirmedBefore, confirmationRequested: answers.confirm_facts === true })
      return (answered)
    }
    case 'task.understand': return (await enforceTaskRequestCandidates(req, workspaceId, service.understandTaskRequest(workspaceId, required(params, 'request_text'))))
    case 'task.request.create': {
      const requestText = required(params, 'request_text')
      const understanding = await enforceTaskRequestCandidates(req, workspaceId, service.understandTaskRequest(workspaceId, requestText))
      const taskBrandIds = await resolveTaskWriteBrands(req, workspaceId, taskUnderstandingProductIds(understanding))
      requireProductionRequestStores(workspaceId, understanding)
      for (const platform of understanding.platformCandidates) await requireEnabledPlatform(workspaceId, platform)
      const idempotencyKey = (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) || header(req, 'idempotency-key')?.trim()
      const canonicalScopes = await resolveCanonicalTaskEntries(workspaceId, understanding.executionPlan.childTasks.flatMap(child => {
        const productId = child.candidateProductIds[0]
        const product = productId ? service.products.get(productId) : undefined
        return product ? [{ productId: product.id, platform: child.platform, ...(product.accountId ? { accountId: product.accountId } : {}) }] : []
      }))
      const created = service.createTaskFromRequest({ workspaceId, requestText, canonicalScopes, ...(idempotencyKey ? { idempotencyKey } : {}) })
      assignTaskWriteBrands(created.tasks, taskBrandIds)
      if (!created.replayed) for (const task of created.tasks) {
        await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, task.id, 'task.created', task.version, { ...task, ...(created.taskGroupId ? { task_group_id: created.taskGroupId } : {}), source: 'natural_language_request' })
      }
      return (created)
    }
    case 'task.sku.split': {
      const source = scopeTask(req, required(params, 'task_id'))
      await assertCanonicalTaskScopeForAction(source)
      const idempotencyKey = (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) || header(req, 'idempotency-key')?.trim()
      const split = service.splitTaskBySku({ workspaceId, taskId: source.id, ...(idempotencyKey ? { idempotencyKey } : {}) })
      if (!split.replayed) for (const task of split.tasks) {
        await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, task.id, 'task.created', task.version, { ...task, task_group_id: split.taskGroupId, source: 'sku_split' })
      }
      await persistEvent(workspaceId, split.sourceTaskId, 'task.sku_split', source.version, { source_task_id: split.sourceTaskId, task_group_id: split.taskGroupId, sku_ids: split.skuIds, replayed: split.replayed })
      return (split)
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
          if ((isProduction() || fixtureMode) && accountId) service.getActionablePlatformAccount(workspaceId, accountId, platform)
          return { productId: entry.product_id, platform, ...(accountId ? { accountId } : {}), ...(typeof entry.region === 'string' && entry.region.trim() ? { region: entry.region.trim() } : {}), ...(typeof entry.sku_id === 'string' && entry.sku_id.trim() ? { skuId: entry.sku_id.trim() } : {}) }
        })
      } catch (error) {
        // Preserve actionable business gates (for example an unbound or
        // revoked store). Only malformed JSON/entry shape is an invalid
        // request; collapsing all DomainErrors here hides the recovery step.
        if (error instanceof DomainError) throw error
        throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'entries_json 必须是有效的任务组数组', 400)
      }
      const entryBrandIds = await resolveTaskWriteBrands(req, workspaceId, entries.map(entry => entry.productId))
      for (const entry of entries) await requireEnabledPlatform(workspaceId, entry.platform)
      const idempotencyKey = (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) || header(req, 'idempotency-key')?.trim()
      const canonicalEntries = await resolveCanonicalTaskEntries(workspaceId, entries)
      const group = service.createTaskGroup({ workspaceId, entries: canonicalEntries, ...(typeof params.request_text === 'string' ? { requestText: params.request_text } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) })
      assignTaskWriteBrands(group.tasks, entryBrandIds)
      if (!group.replayed) for (const task of group.tasks) {
        await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, task.id, 'task.created', task.version, { ...task, task_group_id: group.id })
      }
      return (group)
    }
    default: throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知任务写入 MCP 方法: ${method}`, 400)
  }
}
