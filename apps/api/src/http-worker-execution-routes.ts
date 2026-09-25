import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type MerchantService, type PublishJob, type Task } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { CUSTOMER_DELIVERY_SCAN_OPERATION, type DeliveryScanAdmission } from '../../../packages/workers/src/customer-delivery-scan-admission.js'
import { parseWorkerAuthorizationSnapshot, type CriticalWorkerOperation, type WorkerAuthorizationSnapshot } from '../../../packages/workers/src/execution-authorization.js'
import { parseWorkerCommercialAccessSnapshot, type WorkerCommercialAccessSnapshot, type WorkerCommercialAccessRecheck } from '../../../packages/workers/src/commercial-access.js'
import type { OutboxEvent } from '../../../packages/persistence/src/repository.js'
import type { ApiPersistence } from './server.js'

interface HttpWorkerExecutionDependencies {
  service: MerchantService
  persistence: () => ApiPersistence
  requireWorkerCredentialAuthorization: (req: IncomingMessage) => Promise<unknown>
  resolveWorkspace: (req: IncomingMessage, workspaceId?: unknown) => string
  workerRole: (req: IncomingMessage) => string | undefined
  recheckCustomerDeliveryScan: (event: OutboxEvent, requireQuarantine?: boolean) => Promise<DeliveryScanAdmission>
  workerEventOperations: Record<string, CriticalWorkerOperation>
  requiresStrictAuth: () => boolean
  recheckWorkerGenerationKnowledge: (event: OutboxEvent, attempt: { number: number; key: string; bodyHash: string; nonce: string }) => Promise<unknown>
  requiresWorkerActorAuthorization: (eventType: string, operation: CriticalWorkerOperation) => boolean
  recheckWorkerCommercialAccess: (event: OutboxEvent, snapshot: WorkerCommercialAccessSnapshot) => Promise<WorkerCommercialAccessRecheck>
  serializedWorkerCommercialRecheck: (recheck: WorkerCommercialAccessRecheck) => unknown
  recheckWorkerAuthorizationSnapshot: (snapshot: WorkerAuthorizationSnapshot, workspaceId: string, resourceId: string, execution?: { eventId: string }) => Promise<unknown>
  enrichRequestObservation: (req: IncomingMessage, details: { jobId: string }) => void
  assertCanonicalTaskScopeForAction: (task: Task) => Promise<{ readMode?: string; canonicalReadRevision?: string } | undefined>
  isProduction: () => boolean
  serializedWorkerAuthorizationSnapshot: (snapshot: WorkerAuthorizationSnapshot) => Record<string, unknown>
  publishMediaPayload: (workspaceId: string, job: PublishJob) => Promise<unknown>
  send: (res: ServerResponse, status: number, workspaceId: string, data: unknown, error: null, req: IncomingMessage) => true
}

export async function handleHttpWorkerExecutionRoute(req: IncomingMessage, res: ServerResponse, path: string, url: URL, deps: HttpWorkerExecutionDependencies): Promise<boolean> {
  const { service, requireWorkerCredentialAuthorization, resolveWorkspace, recheckCustomerDeliveryScan, workerEventOperations, requiresStrictAuth, recheckWorkerGenerationKnowledge, requiresWorkerActorAuthorization, recheckWorkerCommercialAccess, serializedWorkerCommercialRecheck, recheckWorkerAuthorizationSnapshot, enrichRequestObservation, assertCanonicalTaskScopeForAction, isProduction, serializedWorkerAuthorizationSnapshot, publishMediaPayload, send } = deps
  const persistence = deps.persistence()
  const workerExecutionCheckMatch = path.match(/^\/v1\/worker-events\/([^/]+)\/execution-check$/)
  const publishExecutionCheckMatch = path.match(/^\/v1\/publish-jobs\/([^/]+)\/execution-check$/)
  if (req.method === 'GET' && workerExecutionCheckMatch) {
    await requireWorkerCredentialAuthorization(req)
    const workspaceId = resolveWorkspace(req)
    const aggregateId = url.searchParams.get('aggregate_id')?.trim() ?? ''
    if (url.searchParams.get('operation')?.trim() === CUSTOMER_DELIVERY_SCAN_OPERATION) {
      if (deps.workerRole(req) !== 'scan') throw new DomainError(ERROR_CODES.FORBIDDEN, '交付扫描只允许已验证签名的 scan worker', 403)
      if (!aggregateId) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'aggregate_id 无效', 400)
      if (!persistence.outbox || !persistence.business || !persistence.customerDeliveries) throw new DomainError('CUSTOMER_DELIVERY_SCAN_REPOSITORY_UNAVAILABLE', '交付扫描持久仓储不可用', 503)
      const event = (await persistence.outbox.listAggregateEvents(workspaceId, aggregateId, 1000)).find(candidate => candidate.id === workerExecutionCheckMatch[1])
      if (!event) throw new DomainError('AUTHORIZATION_EVENT_NOT_FOUND', '交付扫描事件不存在或不属于当前工作区', 404)
      const admission = await recheckCustomerDeliveryScan(event, false)
      return send(res, 200, workspaceId, { delivery_scan_recheck: { ...admission, recheck_id: `delivery_recheck_${randomUUID()}`, event_id: event.id, allowed: true, ready: true, checked_at: new Date().toISOString() } }, null, req)
    }
    const requestedOperation = url.searchParams.get('operation')?.trim() as CriticalWorkerOperation
    if (!aggregateId || !Object.values(workerEventOperations).includes(requestedOperation)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'aggregate_id 或 operation 无效', 400)
    if (requestedOperation === 'generation.execute' && requiresStrictAuth() && deps.workerRole(req) !== 'generation') throw new DomainError(ERROR_CODES.FORBIDDEN, '知识生成执行复核只允许已验证签名的 generation worker', 403)
    if (!persistence.outbox) throw new DomainError('AUTHORIZATION_EVENT_REPOSITORY_UNAVAILABLE', '持久事件仓储不可用，已拒绝执行', 503)
    const event = (await persistence.outbox.listAggregateEvents(workspaceId, aggregateId, 1000)).find(candidate => candidate.id === workerExecutionCheckMatch[1])
    if (!event) throw new DomainError('AUTHORIZATION_EVENT_NOT_FOUND', '执行授权事件不存在或不属于当前工作区', 404)
    const expectedOperation = workerEventOperations[event.eventType]
    if (!expectedOperation || expectedOperation !== requestedOperation) throw new DomainError('AUTHZ_EXECUTION_OPERATION_MISMATCH', '事件类型与执行操作不匹配', 403)
    const knowledgeRecheck = requestedOperation === 'generation.execute'
      ? await recheckWorkerGenerationKnowledge(event, {
        number: Number(url.searchParams.get('attempt')),
        key: url.searchParams.get('provider_attempt_key') ?? '',
        bodyHash: url.searchParams.get('request_body_sha256') ?? '',
        nonce: url.searchParams.get('request_nonce') ?? '',
      })
      : undefined
    const commercialOnlySystemScan = !requiresWorkerActorAuthorization(event.eventType, requestedOperation)
    let commercialSnapshot: WorkerCommercialAccessSnapshot
    try {
      commercialSnapshot = parseWorkerCommercialAccessSnapshot(event, requestedOperation)
    } catch {
      throw new DomainError('COMMERCIAL_EXECUTION_SNAPSHOT_INVALID', '持久事件缺少有效且精确绑定的商业访问快照', 403)
    }
    if (commercialOnlySystemScan) {
      const commercialRecheck = await recheckWorkerCommercialAccess(event, commercialSnapshot)
      return send(res, 200, workspaceId, { commercial_access_recheck: serializedWorkerCommercialRecheck(commercialRecheck) }, null, req)
    }
    let snapshot: WorkerAuthorizationSnapshot
    try {
      snapshot = parseWorkerAuthorizationSnapshot(event, requestedOperation)
    } catch {
      throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_INVALID', '持久事件缺少有效且精确绑定的授权快照', 403)
    }
    const [authorizationRecheck, commercialRecheck] = await Promise.all([
      recheckWorkerAuthorizationSnapshot(snapshot, workspaceId, event.aggregateId, { eventId: event.id }),
      recheckWorkerCommercialAccess(event, commercialSnapshot),
    ])
    return send(res, 200, workspaceId, { authorization_recheck: authorizationRecheck, commercial_access_recheck: serializedWorkerCommercialRecheck(commercialRecheck), ...(knowledgeRecheck ? { knowledge_recheck: knowledgeRecheck } : {}) }, null, req)
  }
  if (req.method === 'GET' && publishExecutionCheckMatch) {
    await requireWorkerCredentialAuthorization(req)
    const workspaceId = resolveWorkspace(req)
    const job = service.assertPublishExecutionAllowed({ workspaceId, publishJobId: publishExecutionCheckMatch[1]! })
    enrichRequestObservation(req, { jobId: job.id })
    const eventId = url.searchParams.get('event_id')?.trim() ?? ''
    if (!eventId) throw new DomainError('AUTHZ_EXECUTION_EVENT_REQUIRED', '发布执行缺少持久事件标识，已拒绝释放凭据', 400)
    if (!persistence.outbox) throw new DomainError('AUTHORIZATION_EVENT_REPOSITORY_UNAVAILABLE', '持久事件仓储不可用，已拒绝发布执行', 503)
    const publishEvent = (await persistence.outbox.listAggregateEvents(workspaceId, job.id, 1000)).find(candidate => candidate.id === eventId)
    if (!publishEvent || publishEvent.eventType !== 'publish.requested' || publishEvent.aggregateId !== job.id) throw new DomainError('AUTHORIZATION_EVENT_NOT_FOUND', '发布执行事件不存在或不属于当前发布任务', 404)
    // The durable publish binding protects the task snapshot, but it is not a
    // substitute for checking the current canonical product/listing chain.
    // Re-read it immediately before releasing the credential to the worker so
    // a post-prepare mapping, facts, listing, or read-mode change fails closed.
    const canonicalProof = await assertCanonicalTaskScopeForAction(service.getTask(job.taskId))
    if (canonicalProof?.readMode === 'canonical_read' && (!job.canonicalReadRevision || job.canonicalReadRevision !== canonicalProof.canonicalReadRevision)) throw new DomainError('CANONICAL_EXECUTION_REVISION_STALE', '发布任务引用的标准商品一致性证据已过期，禁止释放发布凭证', 409, { expected_revision: canonicalProof.canonicalReadRevision ?? null, provided_revision: job.canonicalReadRevision ?? null })
    if (isProduction()) {
      const currentTask = service.getTask(job.taskId)
      const preparedTaskRevision: number | null = typeof job.preparedTaskRevision === 'number' ? job.preparedTaskRevision : null
      const expectedTaskRevision = preparedTaskRevision === null ? null : preparedTaskRevision + 1
      if (preparedTaskRevision === null || !Number.isSafeInteger(preparedTaskRevision) || currentTask.state !== 'publishing' || currentTask.version !== expectedTaskRevision) throw new DomainError('AUTHZ_EXECUTION_RESOURCE_STALE', '发布任务引用的任务版本已变化，禁止释放发布凭证', 409, { expected_revision: Number.isSafeInteger(expectedTaskRevision) ? expectedTaskRevision : null, current_revision: currentTask.version })
    }
    // Strict on purpose: like the sync execution context above, this endpoint
    // releases a stored credential to the worker, and a manual store record has
    // none. See `getActionablePlatformAccount`.
    const account = service.getActivePlatformAccount(workspaceId, job.accountId!, job.platform)
    const snapshot = job.authorizationSnapshot
    if (!snapshot) throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_REQUIRED', '发布执行缺少入队授权快照，已拒绝释放凭据', 403)
    let eventSnapshot: WorkerAuthorizationSnapshot
    try { eventSnapshot = parseWorkerAuthorizationSnapshot(publishEvent, 'publish.execute') } catch { throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_INVALID', '发布事件缺少有效且精确绑定的授权快照', 403) }
    if (JSON.stringify(serializedWorkerAuthorizationSnapshot(eventSnapshot)) !== JSON.stringify(serializedWorkerAuthorizationSnapshot(snapshot))) throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_INVALID', '发布任务与持久事件的授权快照不一致', 403)
    const authorizationRecheck = await recheckWorkerAuthorizationSnapshot(snapshot, workspaceId, job.id, { eventId: publishEvent.id })
    let commercialSnapshot: WorkerCommercialAccessSnapshot
    try { commercialSnapshot = parseWorkerCommercialAccessSnapshot(publishEvent, 'publish.execute') } catch { throw new DomainError('COMMERCIAL_EXECUTION_SNAPSHOT_INVALID', '发布事件缺少有效且精确绑定的商业访问快照', 403) }
    const commercialRecheck = await recheckWorkerCommercialAccess(publishEvent, commercialSnapshot)
    return send(res, 200, workspaceId, { allowed: true, job_id: job.id, account_id: job.accountId, account_revision: job.accountRevision, credential_ref: account.credentialRef, payload_hash: job.payloadHash, media_required: job.selectedVisuals.length > 0, authorization_snapshot: { ...serializedWorkerAuthorizationSnapshot(snapshot), resource_id: job.id }, authorization_recheck: authorizationRecheck, commercial_access_recheck: serializedWorkerCommercialRecheck(commercialRecheck) }, null, req)
  }
  const publishMediaMatch = path.match(/^\/v1\/publish-jobs\/([^/]+)\/media$/)
  if (req.method === 'GET' && publishMediaMatch) {
    await requireWorkerCredentialAuthorization(req)
    const workspaceId = resolveWorkspace(req)
    const job = service.assertPublishExecutionAllowed({ workspaceId, publishJobId: publishMediaMatch[1]! })
    await assertCanonicalTaskScopeForAction(service.getTask(job.taskId))
    if (!job.selectedVisuals.length) return send(res, 200, workspaceId, { job_id: job.id, media: [] }, null, req)
    return send(res, 200, workspaceId, { job_id: job.id, media: await publishMediaPayload(workspaceId, job) }, null, req)
  }
  return false
}
