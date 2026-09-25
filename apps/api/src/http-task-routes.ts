import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type MerchantService, type Platform, type Task, type TaskFeedback } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { contextEnvelopeHash, type OperationAudit } from '../../../packages/persistence/src/index.js'

type JsonObject = Record<string, unknown>
type Page = { limit: number; offset: number }
type TaskUnderstanding = ReturnType<MerchantService['understandTaskRequest']>
type TaskEntry = { productId: string; platform: Platform; accountId?: string; brandId?: string; region?: string; skuId?: string }
type CanonicalScope = { brandId: string; canonicalProductId: string; listingId: string }

export interface HttpTaskRouteDependencies {
  service: MerchantService
  body: (request: IncomingMessage) => Promise<JsonObject>
  resolveWorkspace: (request: IncomingMessage, candidate?: unknown) => string
  send: (response: ServerResponse, status: number, workspaceId: string, data: unknown, error: null, request: IncomingMessage) => void
  required: (input: JsonObject, key: string) => string
  header: (request: IncomingMessage, name: string) => string | undefined
  supportedPlatforms: readonly Platform[]
  resolveProductTaskAccount: (workspaceId: string, platform: Platform, productId: string, requested?: string) => string | undefined
  requireProductionTaskStore: (platform: Platform, accountId: string | undefined) => void
  isProduction: () => boolean
  fixtureMode: boolean
  resolveTaskWriteBrands: (request: IncomingMessage, workspaceId: string, productIds: readonly string[]) => Promise<ReadonlyMap<string, string | undefined>>
  requireEnabledPlatform: (workspaceId: string, platform: Platform) => Promise<unknown>
  resolveCanonicalTaskEntries: (workspaceId: string, entries: TaskEntry[]) => Promise<Array<TaskEntry & Partial<CanonicalScope>>>
  assignTaskWriteBrands: (tasks: Array<{ productId: string; brandId?: string }>, resolved: ReadonlyMap<string, string | undefined>) => void
  persistSnapshot: (workspaceId: string, entityType: 'task' | 'feedback', entity: Task | TaskFeedback, value: Record<string, unknown>) => Promise<unknown>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<unknown>
  enforceTaskRequestCandidates: (request: IncomingMessage, workspaceId: string, understanding: TaskUnderstanding) => Promise<TaskUnderstanding>
  taskUnderstandingProductIds: (understanding: TaskUnderstanding) => string[]
  requireProductionRequestStores: (workspaceId: string, understanding: TaskUnderstanding) => void
  scopeTask: (request: IncomingMessage, taskId: string) => Task
  taskCreationBrand: (request: IncomingMessage, workspaceId: string, value: unknown) => Promise<string | undefined>
  enforceProductBrandAccess: (request: IncomingMessage, workspaceId: string, productId: string) => Promise<unknown>
  resolveCanonicalTaskScope: (input: { workspaceId: string; productId: string; platform: Platform; accountId?: string; brandId?: string; requireListing: true }) => Promise<CanonicalScope | undefined>
  persistTaskAnswerFactConfirmation: (input: { workspaceId: string; productId: string; factsConfirmedBefore: boolean; confirmationRequested: boolean }) => Promise<unknown>
  paginationRequest: (url: URL) => Page
  taskTimeline: (workspaceId: string, taskId: string, limit: number) => Promise<unknown>
  requestActor: (request: IncomingMessage, fallback?: string) => string
  taskFeedbackEventPayload: (feedback: TaskFeedback) => Record<string, unknown>
  projectCanonicalTaskForRead: (task: Task) => Promise<unknown>
  assertCanonicalTaskScopeForAction: (task: Task) => Promise<unknown>
  recordOperationAudit: (input: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export async function handleHttpTaskRoutes(req: IncomingMessage, res: ServerResponse, path: string, url: URL, dependencies: HttpTaskRouteDependencies): Promise<boolean> {
  const { service, body, resolveWorkspace, required, header, supportedPlatforms: SUPPORTED_PLATFORMS, resolveProductTaskAccount, requireProductionTaskStore, isProduction, fixtureMode, resolveTaskWriteBrands, requireEnabledPlatform, resolveCanonicalTaskEntries, assignTaskWriteBrands, persistSnapshot, persistEvent, enforceTaskRequestCandidates, taskUnderstandingProductIds, requireProductionRequestStores, scopeTask, taskCreationBrand, enforceProductBrandAccess, resolveCanonicalTaskScope, persistTaskAnswerFactConfirmation, paginationRequest, taskTimeline, requestActor, taskFeedbackEventPayload, projectCanonicalTaskForRead, assertCanonicalTaskScopeForAction, recordOperationAudit } = dependencies
  const send = (response: ServerResponse, status: number, workspaceId: string, data: unknown, error: null, request: IncomingMessage) => {
    dependencies.send(response, status, workspaceId, data, error, request)
    return true
  }
  if (req.method === 'POST' && path === '/v1/tasks/understand') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const understanding = await enforceTaskRequestCandidates(req, workspaceId, service.understandTaskRequest(workspaceId, required(input, 'request_text')))
    return send(res, 200, workspaceId, understanding, null, req)
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
      if ((isProduction() || fixtureMode) && accountId) service.getActionablePlatformAccount(workspaceId, accountId, platform)
      return { productId: entry.product_id, platform, ...(accountId ? { accountId } : {}), ...(typeof entry.region === 'string' && entry.region.trim() ? { region: entry.region.trim() } : {}), ...(typeof entry.sku_id === 'string' && entry.sku_id.trim() ? { skuId: entry.sku_id.trim() } : {}) }
    })
    const entryBrandIds = await resolveTaskWriteBrands(req, workspaceId, entries.map(entry => entry.productId))
    for (const entry of entries) await requireEnabledPlatform(workspaceId, entry.platform)
    const idempotencyKey = header(req, 'idempotency-key')?.trim() || (typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : '')
    const canonicalEntries = await resolveCanonicalTaskEntries(workspaceId, entries)
    const group = service.createTaskGroup({ workspaceId, entries: canonicalEntries, ...(typeof input.request_text === 'string' ? { requestText: input.request_text } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) })
    assignTaskWriteBrands(group.tasks, entryBrandIds)
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
    const understanding = await enforceTaskRequestCandidates(req, workspaceId, service.understandTaskRequest(workspaceId, requestText))
    const taskBrandIds = await resolveTaskWriteBrands(req, workspaceId, taskUnderstandingProductIds(understanding))
    requireProductionRequestStores(workspaceId, understanding)
    for (const platform of understanding.platformCandidates) await requireEnabledPlatform(workspaceId, platform)
    const idempotencyKey = header(req, 'idempotency-key')?.trim() || (typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : '')
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
    const idempotencyKey = header(req, 'idempotency-key')?.trim() || (typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : '')
    if (idempotencyKey.length > 200) throw new DomainError('IDEMPOTENCY_KEY_INVALID', '幂等键不能超过 200 个字符', 400)
    const taskPlatform = required(input, 'platform') as Platform
    await requireEnabledPlatform(workspaceId, taskPlatform)
    const productId = required(input, 'product_id')
    const brandId = await taskCreationBrand(req, workspaceId, input.brand_id)
    await enforceProductBrandAccess(req, workspaceId, productId)
    const taskAccountId = resolveProductTaskAccount(workspaceId, taskPlatform, productId, typeof input.account_id === 'string' ? input.account_id : undefined)
    requireProductionTaskStore(taskPlatform, taskAccountId)
    if ((isProduction() || fixtureMode) && taskAccountId) service.getActionablePlatformAccount(workspaceId, taskAccountId, taskPlatform)
    const taskId = idempotencyKey ? `task_request_${createHash('sha256').update(`${workspaceId}:${idempotencyKey}`).digest('hex').slice(0, 32)}` : undefined
    const keyHash = idempotencyKey ? createHash('sha256').update(idempotencyKey).digest('hex') : undefined
    const intentHash = idempotencyKey ? contextEnvelopeHash({ productId, brandId: brandId ?? null, platform: taskPlatform, accountId: taskAccountId ?? null, region: typeof input.region === 'string' ? input.region.trim() : '', requestText: typeof input.request_text === 'string' ? input.request_text.trim() : '', answers: input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers) ? input.answers : null }) : undefined
    const replayedTask = taskId ? service.tasks.get(taskId) : undefined
    if (replayedTask) {
      if (replayedTask.taskRequestKeyHash !== keyHash || replayedTask.taskRequestIntentHash !== intentHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', '相同幂等键已用于不同的任务创建意图', 409)
      return send(res, 200, workspaceId, replayedTask, null, req)
    }
    const canonicalScope = await resolveCanonicalTaskScope({ workspaceId, productId, platform: taskPlatform, ...(taskAccountId ? { accountId: taskAccountId } : {}), ...(brandId ? { brandId } : {}), requireListing: true })
    const createdTask = service.createTask({ workspaceId, productId, platform: taskPlatform, ...(taskAccountId ? { accountId: taskAccountId } : {}), ...(canonicalScope ?? (brandId ? { brandId } : {})), ...(taskId ? { taskId } : {}), ...(typeof input.region === 'string' ? { region: input.region } : {}), ...(typeof input.request_text === 'string' && input.request_text.trim() ? { requestText: input.request_text.trim() } : {}) })
    if (keyHash && intentHash) { createdTask.taskRequestKeyHash = keyHash; createdTask.taskRequestIntentHash = intentHash }
    const taskAnswers = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers)
      ? input.answers as Record<string, string | number | boolean | string[]>
      : undefined
    const answeredProductId = taskAnswers && typeof taskAnswers.product_id === 'string' && taskAnswers.product_id.trim() ? taskAnswers.product_id.trim() : createdTask.productId
    const factsConfirmedBefore = taskAnswers ? service.products.get(answeredProductId)?.factsConfirmed === true : false
    const task = taskAnswers
      ? service.answerTask(workspaceId, createdTask.id, taskAnswers, createdTask.version)
      : createdTask
    await persistSnapshot(workspaceId, 'task', task, task as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, task.id, 'task.created', task.version, task as unknown as Record<string, unknown>)
    await persistTaskAnswerFactConfirmation({ workspaceId, productId: task.productId, factsConfirmedBefore, confirmationRequested: taskAnswers?.confirm_facts === true })
    return send(res, 201, workspaceId, task, null, req)
  }
  const taskAnswersMatch = path.match(/^\/v1\/tasks\/([^/]+)\/answers$/)
  if (req.method === 'POST' && taskAnswersMatch) {
    const task = scopeTask(req, taskAnswersMatch[1]!)
    const input = await body(req)
    if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'answers 必须是对象', 400)
    const taskAnswers = input.answers as Record<string, string | number | boolean | string[]>
    const answeredProductId = typeof taskAnswers.product_id === 'string' && taskAnswers.product_id.trim() ? taskAnswers.product_id.trim() : task.productId
    const factsConfirmedBefore = service.products.get(answeredProductId)?.factsConfirmed === true
    const answered = service.answerTask(task.workspaceId, task.id, taskAnswers, typeof input.expected_version === 'number' ? input.expected_version : undefined)
    await persistSnapshot(task.workspaceId, 'task', answered, answered as unknown as Record<string, unknown>)
    await persistEvent(task.workspaceId, task.id, 'task.answers_submitted', answered.version, { task_id: task.id, input_snapshot_id: answered.inputSnapshotId, answers: answered.answers, missing_questions: answered.missingQuestions })
    await persistTaskAnswerFactConfirmation({ workspaceId: task.workspaceId, productId: answered.productId, factsConfirmedBefore, confirmationRequested: taskAnswers.confirm_facts === true })
    return send(res, 200, task.workspaceId, answered, null, req)
  }
  const taskVersionsMatch = path.match(/^\/v1\/tasks\/([^/]+)\/content-versions$/)
  if (req.method === 'GET' && taskVersionsMatch) {
    const task = scopeTask(req, taskVersionsMatch[1]!)
    const page = paginationRequest(url)
    return send(res, 200, task.workspaceId, url.searchParams.has('limit') || url.searchParams.has('offset') ? service.listContentVersionsPage(task.workspaceId, task.id, page) : service.listContentVersions(task.workspaceId, task.id), null, req)
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
    const page = paginationRequest(url)
    return send(res, 200, task.workspaceId, url.searchParams.has('limit') || url.searchParams.has('offset') ? service.listFeedbackPage(task.workspaceId, task.id, page) : service.listFeedback(task.workspaceId, task.id), null, req)
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
    await persistEvent(task.workspaceId, feedback.id, 'task_feedback_submitted', feedback.revision, taskFeedbackEventPayload(feedback))
    return send(res, 201, task.workspaceId, feedback, null, req)
  }
  const taskGetMatch = path.match(/^\/v1\/tasks\/([^/]+)$/)
  if (req.method === 'GET' && taskGetMatch) {
    const task = scopeTask(req, taskGetMatch[1]!)
    return send(res, 200, task.workspaceId, await projectCanonicalTaskForRead(task), null, req)
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
    await assertCanonicalTaskScopeForAction(task)
    const input = await body(req)
    const priceImpactConfirmed = input.price_impact_confirmed === true || input.price_impact_confirmed === 'true'
    const confirmed = service.confirmProductionPlan(task.workspaceId, task.id, requestActor(req, typeof input.actor_id === 'string' && input.actor_id.trim() ? input.actor_id.trim() : 'merchant'), typeof input.expected_version === 'number' ? input.expected_version : undefined, priceImpactConfirmed)
    await persistSnapshot(task.workspaceId, 'task', confirmed, confirmed as unknown as Record<string, unknown>)
    await persistEvent(task.workspaceId, confirmed.id, 'task.plan_confirmed', confirmed.version, { task_id: confirmed.id, plan_id: confirmed.productionPlan?.id ?? null, actor_id: confirmed.productionPlan?.confirmedBy ?? null })
    await recordOperationAudit({ workspaceId: task.workspaceId, actorId: confirmed.productionPlan?.confirmedBy ?? requestActor(req), action: 'task.plan_confirmed', resourceType: 'task', resourceId: confirmed.id, before: { state: task.state, version: task.version }, after: { state: confirmed.state, version: confirmed.version, plan_id: confirmed.productionPlan?.id ?? null }, reason: '确认生产方案' })
    return send(res, 200, task.workspaceId, confirmed, null, req)
  }
  return false
}
