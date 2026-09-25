import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type MerchantService, type Platform, type PlatformRejection, type PublishJob } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { WorkerAuthorizationSnapshot, CriticalWorkerOperation } from '../../../packages/workers/src/execution-authorization.js'

type JsonObject = Record<string, unknown>
interface HttpPublishObservationDependencies {
  service: MerchantService
  requireWorkerAuthorization: (req: IncomingMessage) => Promise<unknown>
  body: (req: IncomingMessage) => Promise<JsonObject>
  resolveWorkspace: (req: IncomingMessage, workspaceId?: unknown) => string
  enrichRequestObservation: (req: IncomingMessage, details: { jobId: string }) => void
  readPlatformRejection: (value: unknown) => PlatformRejection | undefined
  persistSnapshot: (workspaceId: string, entityType: 'product' | 'task' | 'content_version' | 'publish_job', entity: { id: string; version?: number; revision?: number }, value: Record<string, unknown>) => Promise<unknown>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<unknown>
  publishRejectionKnowledgeObservation: (job: PublishJob) => Record<string, unknown> | undefined
  releaseDistributedJobSlot: (workspaceId: string, reservationId: string) => Promise<unknown>
  requiresStrictAuth: () => boolean
  deriveWorkerContinuationAuthorizationSnapshot: (source: WorkerAuthorizationSnapshot, workspaceId: string, resourceId: string, capability: CriticalWorkerOperation, binding: Record<string, unknown>) => Promise<WorkerAuthorizationSnapshot>
  publishReconcileEventPayload: (job: PublishJob, authorization?: WorkerAuthorizationSnapshot) => Record<string, unknown>
  scanAutomationAfterOperationalCompletion: (workspaceId: string, platform: Platform, accountId: string, trigger: string) => Promise<unknown>
  jobWithQueueMetadata: (job: PublishJob, workspaceId: string, type: 'publish') => Record<string, unknown>
  send: (res: ServerResponse, status: number, workspaceId: string, data: unknown, error: null, req: IncomingMessage) => true
}

export async function handleHttpPublishObservationRoute(req: IncomingMessage, res: ServerResponse, path: string, deps: HttpPublishObservationDependencies): Promise<boolean> {
  const publishObservationMatch = path.match(/^\/v1\/publish-jobs\/([^/]+)\/observation$/)
  const { service, requireWorkerAuthorization, body, resolveWorkspace, enrichRequestObservation, readPlatformRejection, persistSnapshot, persistEvent, publishRejectionKnowledgeObservation, releaseDistributedJobSlot, requiresStrictAuth, deriveWorkerContinuationAuthorizationSnapshot, publishReconcileEventPayload, scanAutomationAfterOperationalCompletion, jobWithQueueMetadata, send } = deps
  if (req.method === 'POST' && publishObservationMatch) {
    await requireWorkerAuthorization(req)
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const statusInput = input.status
    if (!statusInput || typeof statusInput !== 'object' || Array.isArray(statusInput)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '缺少平台状态观测', 400)
    const status = statusInput as Record<string, unknown>
    const source = input.source === 'reconcile' ? 'reconcile' : 'publish'
    // The ops runbook requires job_id alongside task_id so a stuck publish can be
    // traced from the log line to the durable row. This route is where a
    // publish outcome first becomes observable.
    enrichRequestObservation(req, { jobId: publishObservationMatch[1]! })

    const state = status.state
    if (!['submitted', 'published', 'rejected', 'unknown'].includes(String(state))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '平台状态观测值无效', 400)
    const rejection = readPlatformRejection(status.platform_rejection)
    if (rejection && state !== 'rejected') throw new DomainError(ERROR_CODES.INVALID_REQUEST, '只有平台驳回状态可以携带拒绝详情', 400)
    const job = service.recordPublishObservation({
      workspaceId,
      publishJobId: publishObservationMatch[1]!,
      status: {
        found: status.found === true,
        state: state as 'submitted' | 'published' | 'rejected' | 'unknown',
        ...(typeof status.remote_id === 'string' ? { remoteId: status.remote_id } : {}),
        ...(typeof status.request_id === 'string' ? { requestId: status.request_id } : {}),
        ...(typeof status.simulated === 'boolean' ? { simulated: status.simulated } : {}),
        ...(rejection ? { rejection } : {}),
      },
      ...(typeof input.observed_at === 'string' ? { observedAt: input.observed_at } : {}),
    })
    let boundProduct
    if (job.remoteId) {
      boundProduct = service.bindProductRemoteId(workspaceId, job.taskId, job.remoteId)
      await persistSnapshot(workspaceId, 'product', boundProduct, boundProduct as unknown as Record<string, unknown>)
    }
    await persistSnapshot(workspaceId, 'task', service.getTask(job.taskId), service.getTask(job.taskId) as unknown as Record<string, unknown>)
    await persistSnapshot(workspaceId, 'content_version', service.getContentVersion(workspaceId, job.contentVersionId), service.getContentVersion(workspaceId, job.contentVersionId) as unknown as Record<string, unknown>)
    await persistSnapshot(workspaceId, 'publish_job', job, job as unknown as Record<string, unknown>)
    const knowledgeObservation = publishRejectionKnowledgeObservation(job)
    await persistEvent(workspaceId, job.id, 'publish.observation', job.revision, {
      job_id: job.id,
      task_id: job.taskId,
      source,
      status: job.remoteState ?? job.state,
      ...(job.remoteId ? { remote_id: job.remoteId } : {}),
      ...(job.requestId ? { request_id: job.requestId } : {}),
      ...(job.rejection ? { platform_rejection: { raw_code: job.rejection.rawCode, ...(job.rejection.message ? { message: job.rejection.message } : {}), fields: job.rejection.fields.map(field => ({ path: field.path, ...(field.rawCode ? { raw_code: field.rawCode } : {}), message: field.message })) } } : {}),
      ...(knowledgeObservation ? { knowledge_observation: knowledgeObservation } : {}),
    })
    if (job.remoteState === 'published' || job.remoteState === 'rejected') await releaseDistributedJobSlot(workspaceId, `publish:${job.idempotencyKey}`)
    // A write can be accepted by the provider and still lose its response
    // before the first status query. Preserve the same durable reconciliation
    // path for UNKNOWN outcomes, including repeated reconcile observations;
    // this never retries the write. The job revision gives each observation
    // a monotonic event sequence so a later query remains durable.
    if (['publish', 'reconcile'].includes(source) && ['submitted', 'unknown'].includes(job.remoteState ?? '')) {
      if (requiresStrictAuth() && !job.authorizationSnapshot) throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_REQUIRED', '发布对账缺少原始发布授权快照，已拒绝入队', 503)
      const reconciliationAuthorization = job.authorizationSnapshot
        ? await deriveWorkerContinuationAuthorizationSnapshot(job.authorizationSnapshot, workspaceId, job.id, 'publish.reconcile', { event: 'publish.reconcile_requested', publish_job_id: job.id, payload_hash: job.payloadHash })
        : undefined
      await persistEvent(workspaceId, job.id, 'publish.reconcile_requested', Math.max(1, job.revision), publishReconcileEventPayload(job, reconciliationAuthorization))
    }
    const automation = job.remoteState === 'published' && job.accountId
      ? await scanAutomationAfterOperationalCompletion(workspaceId, job.platform, job.accountId, `publish.observation.${source}.published`)
      : undefined
    return send(res, 200, workspaceId, { ...jobWithQueueMetadata(job, workspaceId, 'publish'), ...(automation ? { automation } : {}) }, null, req)
  }
  return false
}
