import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type ContentVersion, type GenerationJob, type MerchantService, type Task } from '../../../packages/application/src/service.js'
import { ERROR_CODES, generationJobWriteRefused } from '../../../packages/contracts/src/index.js'
import type { ContentModule, StaticBrief } from '../../../packages/ai/src/generator.js'
import type { RuleHit } from '../../../packages/review/src/rule-center.js'

type JsonObject = Record<string, unknown>
type RulePreflight = { rule_hits: RuleHit[] }
type ReviewRules = Parameters<MerchantService['reviewContentReport']>[2]
type SnapshotInput = { entityType: 'content_version' | 'task' | 'generation_job'; entityId: string; entityVersion: number; payload: Record<string, unknown> }

export interface HttpGenerationJobWorkerDependencies {
  service: MerchantService
  requireWorkerAuthorization: (req: IncomingMessage) => Promise<unknown>
  resolveWorkspace: (req: IncomingMessage) => string
  body: (req: IncomingMessage) => Promise<JsonObject>
  enrichRequestObservation: (req: IncomingMessage, observation: { jobId: string }) => void
  persistSnapshot: (workspaceId: string, entityType: 'generation_job', entity: GenerationJob, value: Record<string, unknown>) => Promise<void>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<void>
  jobWithQueueMetadata: (job: GenerationJob, workspaceId: string, kind: 'generation') => GenerationJob & { queue_state: string; queue_position: number; estimated_wait_seconds: number; retry_after_seconds?: number }
  providerSucceededButSettlementPending: (error: unknown) => boolean
  refundTaskUsage: (workspaceId: string, taskId: string, usageKey: string, actorId: string, reason: string) => Promise<unknown>
  releaseDistributedJobSlot: (workspaceId: string, reservationId: string) => Promise<unknown>
  header: (req: IncomingMessage, name: string) => string | undefined
  readStaticBrief: (value: unknown) => StaticBrief | undefined
  readContentModules: (value: unknown) => ContentModule[] | undefined
  requireGenerationRulePreflight: (workspaceId: string, productId: string, message?: string) => Promise<RulePreflight>
  contentExecutionEvidence: (workspaceId: string, actionId: string) => Promise<{ providerExecuted: boolean } & Record<string, unknown>>
  rulesForTask: (workspaceId: string, task: Task) => Promise<ReviewRules>
  persistSnapshotsAndEvent: (input: { workspaceId: string; snapshots: SnapshotInput[]; aggregateId: string; eventType: string; sequence: number; eventPayload: Record<string, unknown> }) => Promise<void>
  rollbackGenerationCompletion: (previous: { job: GenerationJob; task: Task }, contentVersionId: string) => void
  respond: (res: ServerResponse, status: number, workspaceId: string, payload: unknown, req: IncomingMessage) => true
}

export async function handleHttpGenerationJobWorker(req: IncomingMessage, res: ServerResponse, path: string, deps: HttpGenerationJobWorkerDependencies): Promise<boolean> {
  const { service, requireWorkerAuthorization, resolveWorkspace, body, enrichRequestObservation, persistSnapshot, persistEvent, jobWithQueueMetadata, providerSucceededButSettlementPending, refundTaskUsage, releaseDistributedJobSlot, header, readStaticBrief, readContentModules, requireGenerationRulePreflight, contentExecutionEvidence, rulesForTask, persistSnapshotsAndEvent, rollbackGenerationCompletion, respond } = deps
  const generationJobDeferMatch = path.match(/^\/v1\/generation-jobs\/([^/]+)\/defer$/)
  if (req.method === 'POST' && generationJobDeferMatch) {
    await requireWorkerAuthorization(req)
    const workspaceId = resolveWorkspace(req)
    const input = await body(req)
    const retryAfterSeconds = typeof input.retry_after_seconds === 'number' && Number.isFinite(input.retry_after_seconds) ? Math.max(1, Math.ceil(input.retry_after_seconds)) : 60
    const deferred = service.deferGeneration({ workspaceId, jobId: generationJobDeferMatch[1]!, code: typeof input.code === 'string' ? input.code : 'QUOTA_EXHAUSTED', message: typeof input.message === 'string' ? input.message : '模型/平台配额暂满，任务将在配额窗口恢复后重试', retryAfterSeconds })
    enrichRequestObservation(req, { jobId: deferred.id })
    // Same terminal-state guard as the two `failGeneration` branches below: a
    // late or redelivered `/defer` for a delivered job must not write a phantom
    // `generation.deferred` event after `generation.completed`. The worker outbox
    // redelivers non-2xx posts, so this branch is reachable after success.
    if (!generationJobWriteRefused(deferred)) {
      await persistSnapshot(workspaceId, 'generation_job', deferred, deferred as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, deferred.id, 'generation.deferred', deferred.revision, { job_id: deferred.id, task_id: deferred.taskId, code: deferred.errorCode ?? 'QUOTA_EXHAUSTED', retry_after_seconds: retryAfterSeconds, next_attempt_at: deferred.nextAttemptAt })
    }
    return respond(res, 200, workspaceId, jobWithQueueMetadata(deferred, workspaceId, 'generation'), req)
  }
  const generationJobResultMatch = path.match(/^\/v1\/generation-jobs\/([^/]+)\/result$/)
  if (req.method === 'POST' && generationJobResultMatch) {
    await requireWorkerAuthorization(req)
    const workspaceId = resolveWorkspace(req)
    const input = await body(req)
    const job = service.getGenerationJob(workspaceId, generationJobResultMatch[1]!)
    enrichRequestObservation(req, { jobId: job.id })
    if (input.error && typeof input.error === 'object' && !Array.isArray(input.error)) {
      const error = input.error as Record<string, unknown>
      const failed = service.failGeneration({ workspaceId, jobId: job.id, code: typeof error.code === 'string' ? error.code : 'AI_GENERATION_FAILED', message: typeof error.message === 'string' ? error.message : '内容生成失败' })
      // `failGeneration` is monotonic: a job that already succeeded is returned
      // unchanged. A late failure report for such a job used to fall through and
      // still write a `generation.failed` outbox event and refund the task's
      // usage — a phantom failure that both under-charged the merchant and made
      // the event stream disagree with the job record.
      if (generationJobWriteRefused(failed)) return respond(res, 200, workspaceId, failed, req)
      await persistSnapshot(workspaceId, 'generation_job', failed, failed as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, failed.id, 'generation.failed', failed.revision, { job_id: failed.id, task_id: failed.taskId, error_code: failed.errorCode ?? 'AI_GENERATION_FAILED', error_message: failed.errorMessage ?? '内容生成失败' })
      if (!providerSucceededButSettlementPending(error)) await refundTaskUsage(workspaceId, failed.taskId, `generation:${failed.idempotencyKey}`, header(req, 'x-actor-id')?.trim() || 'worker', '异步内容生成失败')
      await releaseDistributedJobSlot(workspaceId, `generation:${failed.idempotencyKey}`)
      return respond(res, 200, workspaceId, failed, req)
    }
    if (!input.content || typeof input.content !== 'object' || Array.isArray(input.content)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '缺少生成内容', 400)
    const content = input.content as Record<string, unknown>
    const sellingPoints = Array.isArray(content.sellingPoints) ? content.sellingPoints.filter((value): value is string => typeof value === 'string') : []
    if (typeof content.title !== 'string' || typeof content.detail !== 'string' || !sellingPoints.length) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '生成内容结构无效', 400)
    const brief = readStaticBrief(content.brief)
    const modules = readContentModules(content.modules)
    const completedTaskBeforeWrite = service.getTask(job.taskId)
    let rulePreflightBeforeWrite: Awaited<RulePreflight>
    try {
      rulePreflightBeforeWrite = await requireGenerationRulePreflight(workspaceId, completedTaskBeforeWrite.productId, '排队期间平台规则已发生变化，不能提交该生成结果')
    } catch (error) {
      const failed = service.failGeneration({ workspaceId, jobId: job.id, code: error instanceof DomainError ? error.code : 'PLATFORM_RULE_PREFLIGHT_BLOCKED', message: error instanceof Error ? error.message : '排队期间平台规则已发生变化，不能提交该生成结果' })
      // Same terminal-state guard as the `input.error` branch above: a job that
      // already succeeded is returned unchanged, so a late (or redelivered)
      // failure report must not write a phantom `generation.failed` event,
      // refund the settled usage or free the slot of a delivered job. The worker
      // outbox redelivers non-2xx result posts, so this branch is reachable
      // after success whenever the queued-time rule preflight starts failing.
      if (generationJobWriteRefused(failed)) return respond(res, 200, workspaceId, failed, req)
      await persistSnapshot(workspaceId, 'generation_job', failed, failed as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, failed.id, 'generation.failed', failed.revision, { job_id: failed.id, task_id: failed.taskId, error_code: failed.errorCode ?? 'PLATFORM_RULE_PREFLIGHT_BLOCKED', error_message: failed.errorMessage ?? '排队期间平台规则已发生变化，不能提交该生成结果' })
      await refundTaskUsage(workspaceId, failed.taskId, `generation:${failed.idempotencyKey}`, header(req, 'x-actor-id')?.trim() || 'worker', '排队期间平台规则变化导致生成阻断')
      await releaseDistributedJobSlot(workspaceId, `generation:${failed.idempotencyKey}`)
      throw error
    }
    const execution = await contentExecutionEvidence(workspaceId, 'model:generation:' + job.idempotencyKey)
    if (['staging', 'preview', 'production'].includes(process.env.NODE_ENV ?? '') && execution.providerExecuted !== true) {
      throw new DomainError('MODEL_RELAY_EVIDENCE_REQUIRED', '中转模型回执尚未完成，内容暂不能交付', 409, {
        operation_status: 'pending_receipt',
        action_id: 'model:generation:' + job.idempotencyKey,
        missing: ['provider_request_id', 'usage', 'cost_cny', 'settlement'],
      })
    }
    const previous = { job: structuredClone(job), task: structuredClone(completedTaskBeforeWrite) }
    const completed = service.completeGeneration({ workspaceId, jobId: job.id, body: { title: content.title, detail: content.detail, sellingPoints, ...(modules ? { modules } : {}), ...(brief ? { brief } : {}) } })
    const completedTask = service.getTask(completed.job.taskId)
    let rulePreflight!: ReturnType<typeof service.reviewContentReport>
    try {
      rulePreflight = service.reviewContentReport(workspaceId, completed.version.id, { ...(await rulesForTask(workspaceId, completedTask) ?? { availableRuleVersionIds: [], forbiddenTerms: [], requiredFields: [], ruleHits: [] }), ruleHits: rulePreflightBeforeWrite.rule_hits })
      await persistSnapshotsAndEvent({ workspaceId, snapshots: [
        { entityType: 'content_version', entityId: completed.version.id, entityVersion: completed.version.revision, payload: completed.version as unknown as Record<string, unknown> },
        { entityType: 'task', entityId: completedTask.id, entityVersion: completedTask.version, payload: completedTask as unknown as Record<string, unknown> },
        { entityType: 'generation_job', entityId: completed.job.id, entityVersion: completed.job.revision, payload: completed.job as unknown as Record<string, unknown> },
      ], aggregateId: completed.job.id, eventType: 'generation.completed', sequence: completed.job.revision, eventPayload: { job_id: completed.job.id, task_id: completed.job.taskId, content_version_id: completed.version.id, version: completed.version.version, execution, rule_preflight: { blocking: rulePreflight.blocking, finding_count: rulePreflight.findings.length, rule_hits: rulePreflight.ruleHits ?? [] } } })
    } catch (error) {
      rollbackGenerationCompletion(previous, completed.version.id)
      throw error
    }
    await releaseDistributedJobSlot(workspaceId, `generation:${completed.job.idempotencyKey}`)
    return respond(res, 200, workspaceId, { ...jobWithQueueMetadata(completed.job, workspaceId, 'generation'), execution, rule_preflight: rulePreflight }, req)
  }
  return false
}
