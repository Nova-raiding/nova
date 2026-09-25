import type { IncomingMessage } from 'node:http'
import { DomainError, type MerchantService, type Platform, type Task, type TaskFeedback } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { PostgresBusinessRepository } from '../../../packages/persistence/src/business-repository.js'

type JsonObject = Record<string, unknown>

export interface McpTaskReadFeedbackDependencies {
  service: MerchantService
  business?: Pick<PostgresBusinessRepository, 'listTasksPage'>
  required: (params: JsonObject, name: string) => string
  mcpPagination: (params: JsonObject) => { limit: number; offset: number }
  filterByTaskBrandAccess: <T extends { brandId?: string }>(req: IncomingMessage, workspaceId: string, tasks: T[]) => Promise<T[]>
  accessibleTaskBrandIds: (req: IncomingMessage, workspaceId: string) => Promise<readonly string[] | undefined>
  scopeTask: (req: IncomingMessage, taskId: string) => Task
  taskWorkflowProjections: (workspaceId: string, taskId: string) => Array<{ next_action?: unknown }>
  taskTimeline: (workspaceId: string, taskId: string, limit?: number) => Promise<unknown>
  requestActor: (req: IncomingMessage, fallback?: string) => string
  persistSnapshot: (workspaceId: string, entityType: 'feedback', entity: TaskFeedback, value: Record<string, unknown>) => Promise<void>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<void>
  taskFeedbackEventPayload: (feedback: TaskFeedback) => Record<string, unknown>
}

export async function handleMcpTaskReadFeedback(method: string, params: JsonObject, req: IncomingMessage, workspaceId: string, deps: McpTaskReadFeedbackDependencies): Promise<unknown> {
  const { service, business, required, mcpPagination, filterByTaskBrandAccess, accessibleTaskBrandIds, scopeTask, taskWorkflowProjections, taskTimeline, requestActor, persistSnapshot, persistEvent, taskFeedbackEventPayload } = deps
  switch (method) {
    case 'deliverable.list': {
      const deliverables = service.listDeliverables(workspaceId, {
      ...(typeof params.query === 'string' ? { query: params.query } : {}),
      ...(typeof params.platform === 'string' ? { platform: params.platform as Platform } : {}),
      ...(typeof params.account_id === 'string' ? { accountId: params.account_id } : {}),
      ...(typeof params.product_id === 'string' ? { productId: params.product_id } : {}),
      ...(typeof params.task_id === 'string' ? { taskId: params.task_id } : {}),
      ...(typeof params.state === 'string' ? { state: params.state as import('../../../packages/application/src/service.js').ContentVersion['state'] } : {}),
      ...(typeof params.date_from === 'string' ? { dateFrom: params.date_from } : {}),
      ...(typeof params.date_to === 'string' ? { dateTo: params.date_to } : {}),
      ...(typeof params.limit === 'string' ? { limit: Number(params.limit) } : {}),
      ...(typeof params.cursor === 'string' ? { cursor: params.cursor } : {}),
      })
      const visibleTasks = await filterByTaskBrandAccess(req, workspaceId, service.listTasks(workspaceId))
      const visibleTaskIds = new Set(visibleTasks.map(task => task.id))
      const items = deliverables.items.filter(item => visibleTaskIds.has(item.task.id))
      return ({
        ...deliverables,
        items,
        empty_state: items.length ? null : { title: '还没有内容交付', message: '先创建内容任务，完成方案、审核和批准后，这里会出现可导出的交付物。' },
        action_cards: items.length ? [{ method: 'content.versions', label: '查看内容版本', required_inputs: ['task_id'], confirmation: 'none' }] : [{ method: 'task.understand', label: '创建内容任务', required_inputs: ['instruction', 'platform', 'account_id'], confirmation: 'interactive_confirmation' }],
      })
    }
    case 'task.history': {
      const pageRequest = mcpPagination(params)
      const filters = {
      ...(typeof params.query === 'string' ? { query: params.query } : {}),
      ...(typeof params.platform === 'string' ? { platform: params.platform as Platform } : {}),
      ...(typeof params.state === 'string' ? { state: params.state as import('../../../packages/application/src/service.js').TaskState } : {}),
      ...(typeof params.product_id === 'string' ? { productId: params.product_id } : {}),
      ...(typeof params.account_id === 'string' ? { accountId: params.account_id } : {}),
      ...(typeof params.brand_name === 'string' ? { brandName: params.brand_name } : {}),
      ...(typeof params.store_name === 'string' ? { storeName: params.store_name } : {}),
      ...(typeof params.remote_product_id === 'string' ? { remoteProductId: params.remote_product_id } : {}),
      ...(typeof params.publish_status === 'string' ? { publishStatus: params.publish_status as import('../../../packages/application/src/service.js').PublishState } : {}),
      ...(typeof params.date_from === 'string' ? { dateFrom: params.date_from } : {}),
      ...(typeof params.date_to === 'string' ? { dateTo: params.date_to } : {}),
      }
      const accessibleBrandIds = await accessibleTaskBrandIds(req, workspaceId)
      const page = business
        ? await business.listTasksPage(workspaceId, { ...pageRequest, ...filters, ...(accessibleBrandIds !== undefined ? { accessibleBrandIds } : {}) })
        : await (async () => { const all = await filterByTaskBrandAccess(req, workspaceId, service.listTasks(workspaceId, filters)); return { items: all.slice(pageRequest.offset, pageRequest.offset + pageRequest.limit), total: all.length, ...pageRequest } })()
      const items = page.items as unknown as Task[]
      return ({
        items: items.map(task => ({ ...task, workflows: taskWorkflowProjections(workspaceId, task.id) })),
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        empty_state: items.length ? null : { title: '还没有营销任务', message: '用一句话告诉我商品、平台和营销目标，就可以创建第一条任务。' },
        action_cards: items.length ? [{ method: 'task.resume', label: '继续最近任务', required_inputs: ['task_id'], confirmation: 'none' }] : [{ method: 'task.understand', label: '开始第一条任务', required_inputs: ['instruction', 'platform', 'account_id'], confirmation: 'interactive_confirmation' }],
      })
    }
    case 'task.resume': {
      const task = scopeTask(req, required(params, 'task_id'))
      const resumed = service.resumeTask(workspaceId, task.id)
      return ({ ...resumed, workflows: taskWorkflowProjections(workspaceId, task.id) })
    }
    case 'task.timeline': {
      const taskId = required(params, 'task_id')
      const events = await taskTimeline(workspaceId, taskId, typeof params.limit === 'string' ? Number(params.limit) : 100)
      return ({ events, workflows: taskWorkflowProjections(workspaceId, taskId), next_action: taskWorkflowProjections(workspaceId, taskId)[0]?.next_action ?? { label: '查看任务状态', allowed: true } })
    }
    case 'feedback.list': {
      const task = scopeTask(req, required(params, 'task_id'))
      return (service.listFeedback(workspaceId, task.id))
    }
    case 'feedback.submit': {
      const task = scopeTask(req, required(params, 'task_id'))
      const rating = required(params, 'rating')
      if (!['liked', 'neutral', 'needs_improvement'].includes(rating)) throw new DomainError('FEEDBACK_RATING_INVALID', '反馈评级无效', 400)
      const feedback = service.submitFeedback({
        workspaceId, taskId: task.id, rating: rating as 'liked' | 'neutral' | 'needs_improvement',
        ...(typeof params.content_version_id === 'string' ? { contentVersionId: params.content_version_id } : {}),
        ...(typeof params.reason === 'string' ? { reason: params.reason } : {}),
        ...(typeof params.comment === 'string' ? { comment: params.comment } : {}),
        actorId: requestActor(req, 'actor_demo'),
      })
      await persistSnapshot(workspaceId, 'feedback', feedback, feedback as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, feedback.id, 'task_feedback_submitted', feedback.revision, taskFeedbackEventPayload(feedback))
      return (feedback)
    }
    default: throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知任务读取或反馈 MCP 方法: ${method}`, 400)
  }
}
