import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type GenerationJob, type MerchantService, type Task } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

type JsonObject = Record<string, unknown>

export interface HttpGenerationJobCreateDependencies {
  service: MerchantService
  resolveWorkspace: (req: IncomingMessage) => string
  scopeTask: (req: IncomingMessage, taskId: string) => Task
  assertCanonicalTaskScopeForAction: (task: Task) => Promise<unknown>
  enforceRestGenerationProtocol: (req: IncomingMessage, workspaceId: string, operation: string | undefined, action: 'content-jobs') => Promise<unknown>
  httpOperation?: string
  hydrateDurableKnowledgeForGeneration: (task: Task) => Promise<unknown>
  body: (req: IncomingMessage) => Promise<JsonObject>
  header: (req: IncomingMessage, name: string) => string | undefined
  observeLegacyWalletShadow: (workspaceId: string) => Promise<unknown>
  requireGenerationRulePreflight: (workspaceId: string, productId: string) => Promise<unknown>
  requirePlatformModelCostGate: (modality: 'text') => unknown
  hydrateDurableIdempotentJob: (workspaceId: string, entityType: 'generation_job', idempotencyKey: string) => Promise<unknown>
  enrichRequestObservation: (req: IncomingMessage, observation: { jobId: string }) => void
  jobWithQueueMetadata: (job: GenerationJob, workspaceId: string, kind: 'generation') => GenerationJob & { queue_state: string; queue_position: number; estimated_wait_seconds: number; retry_after_seconds?: number }
  reserveDistributedJobSlot: (workspaceId: string, reservationId: string) => Promise<boolean>
  observeLegacyTaskUsage: (workspaceId: string, taskId: string, usageKey: string, actorId: string) => Promise<{ charged?: boolean; walletDebited?: boolean }>
  requestActor: (req: IncomingMessage) => string
  reserveDailyModelBudget: (workspaceId: string, actionId: string, runKey: string, modality: 'text') => Promise<unknown>
  getAuthorizationSnapshot: (req: IncomingMessage, task: Task, jobId: string) => Record<string, unknown> | undefined
  isProduction: () => boolean
  persistSnapshot: (workspaceId: string, entityType: 'generation_job', entity: GenerationJob, value: Record<string, unknown>) => Promise<void>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<void>
  contextEnvelopeHash: (input: Record<string, unknown>) => string
  fixtureMode: boolean
  runFixtureGenerationJob: (workspaceId: string, jobId: string) => Promise<unknown>
  refundTaskUsage: (workspaceId: string, taskId: string, usageKey: string, actorId: string, reason: string) => Promise<unknown>
  releaseDistributedJobSlot: (workspaceId: string, reservationId: string) => Promise<unknown>
  respond: (res: ServerResponse, status: number, workspaceId: string, payload: unknown, req: IncomingMessage) => true
}

export async function handleHttpGenerationJobCreate(req: IncomingMessage, res: ServerResponse, path: string, deps: HttpGenerationJobCreateDependencies): Promise<boolean> {
  const { service, resolveWorkspace, scopeTask, assertCanonicalTaskScopeForAction, enforceRestGenerationProtocol, httpOperation, hydrateDurableKnowledgeForGeneration, body, header, observeLegacyWalletShadow, requireGenerationRulePreflight, requirePlatformModelCostGate, hydrateDurableIdempotentJob, enrichRequestObservation, jobWithQueueMetadata, reserveDistributedJobSlot, observeLegacyTaskUsage, requestActor, reserveDailyModelBudget, getAuthorizationSnapshot, isProduction, persistSnapshot, persistEvent, contextEnvelopeHash, fixtureMode, runFixtureGenerationJob, refundTaskUsage, releaseDistributedJobSlot, respond } = deps
  const generationJobCreateMatch = path.match(/^\/v1\/tasks\/([^/]+)\/content-jobs$/)
  if (req.method === 'POST' && generationJobCreateMatch) {
    const task = scopeTask(req, generationJobCreateMatch[1]!)
    await assertCanonicalTaskScopeForAction(task)
    await enforceRestGenerationProtocol(req, task.workspaceId, httpOperation, 'content-jobs')
    await hydrateDurableKnowledgeForGeneration(task)
    const input = await body(req)
    const idempotencyKey = header(req, 'idempotency-key')?.trim() || (typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : '')
    if (!idempotencyKey) throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, '生成任务必须携带 Idempotency-Key', 400)
    const product = service.products.get(task.productId)
    if (!product || product.workspaceId !== task.workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品快照不存在或不属于当前工作区', 404)
    await observeLegacyWalletShadow(task.workspaceId)
    const rulePreflight = await requireGenerationRulePreflight(task.workspaceId, product.id)
    requirePlatformModelCostGate('text')
    let existing = [...service.generationJobs.values()].find(candidate => candidate.workspaceId === task.workspaceId && candidate.idempotencyKey === idempotencyKey)
    if (!existing) {
      await hydrateDurableIdempotentJob(task.workspaceId, 'generation_job', idempotencyKey)
      existing = [...service.generationJobs.values()].find(candidate => candidate.workspaceId === task.workspaceId && candidate.idempotencyKey === idempotencyKey)
    }
    // An idempotency key is bound to the task that first used it. Returning
    // another task's job here told the caller its own generation was queued —
    // and its creative points reserved — while nothing ever ran for it. The MCP
    // path already rejects this in `enqueueGeneration`; the HTTP entry point did
    // not, so the same key reuse produced a 409 on one surface and a silent 202
    // on the other.
    if (existing && existing.taskId !== task.id) throw new DomainError('IDEMPOTENCY_KEY_REUSED', '该 Idempotency-Key 已绑定到另一个任务的生成作业', 409, { job_id: existing.id, existing_task_id: existing.taskId, requested_task_id: task.id })
    if (existing) enrichRequestObservation(req, { jobId: existing.id })
    if (existing) return respond(res, 202, task.workspaceId, { ...jobWithQueueMetadata(existing, task.workspaceId, 'generation'), rule_preflight: rulePreflight }, req)
    const reservationId = `generation:${idempotencyKey}`
    const reserved = await reserveDistributedJobSlot(task.workspaceId, reservationId)
      const usageKey = `generation:${idempotencyKey}`
      const usage = await observeLegacyTaskUsage(task.workspaceId, task.id, usageKey, requestActor(req))
      try {
        await reserveDailyModelBudget(task.workspaceId, `model:${usageKey}`, task.id, 'text')
        const prepared = await service.prepareGenerationContext(task.id, `model:${usageKey}`)
      const job = service.enqueueGeneration({ workspaceId: task.workspaceId, taskId: task.id, idempotencyKey })
      enrichRequestObservation(req, { jobId: job.id })
      const authorizationSnapshot = getAuthorizationSnapshot(req, task, job.id)
      if (!authorizationSnapshot && isProduction()) throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_REQUIRED', '内容生成缺少持久身份授权快照，已拒绝入队', 503)
      await persistSnapshot(task.workspaceId, 'generation_job', job, job as unknown as Record<string, unknown>)
      if (job.state === 'queued' && job.revision === 1) {
        await persistEvent(task.workspaceId, job.id, 'generation.requested', 1, {
          job_id: job.id, task_id: task.id, campaign_item_id: task.campaignItemId ?? null, platform: task.platform, direction_id: task.selectedDirectionId ?? 'default', action_id: `model:${usageKey}`, run_key: task.id,
          context_link_id: prepared.contextRef?.id ?? null, context_hash: prepared.contextRef?.contextHash ?? contextEnvelopeHash(prepared.input as unknown as Record<string, unknown>), input_tokens_estimate: prepared.inputTokensEstimate, max_input_tokens: prepared.maxInputTokens, input: prepared.input, ...(authorizationSnapshot ? { authorization_snapshot: authorizationSnapshot } : {}),
        })
      }
      if ((fixtureMode || process.env.CONNECTOR_FIXTURE_MODE === 'true') && job.state === 'queued' && job.revision === 1) setTimeout(() => void runFixtureGenerationJob(task.workspaceId, job.id), 0)
      return respond(res, 202, task.workspaceId, { ...jobWithQueueMetadata(job, task.workspaceId, 'generation'), rule_preflight: rulePreflight }, req)
    } catch (error) {
      if ((usage.charged || usage.walletDebited) && !existing) await refundTaskUsage(task.workspaceId, task.id, usageKey, requestActor(req), '异步生成任务创建失败')
      if (reserved) await releaseDistributedJobSlot(task.workspaceId, reservationId)
      throw error
    }
  }
  const generationJobGetMatch = path.match(/^\/v1\/generation-jobs\/([^/]+)$/)
  if (req.method === 'GET' && generationJobGetMatch) {
    const job = service.getGenerationJob(resolveWorkspace(req), generationJobGetMatch[1]!)
    enrichRequestObservation(req, { jobId: job.id })
    return respond(res, 200, job.workspaceId, jobWithQueueMetadata(job, job.workspaceId, 'generation'), req)
  }
  return false
}
