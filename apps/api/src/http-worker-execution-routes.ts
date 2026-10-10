import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type MerchantService, type PublishJob, type Task } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { CUSTOMER_DELIVERY_SCAN_OPERATION, type DeliveryScanAdmission } from '../../../packages/workers/src/customer-delivery-scan-admission.js'
import { parseWorkerAuthorizationSnapshot, type CriticalWorkerOperation, type WorkerAuthorizationSnapshot } from '../../../packages/workers/src/execution-authorization.js'
import { parseWorkerCommercialAccessSnapshot, type WorkerCommercialAccessSnapshot, type WorkerCommercialAccessRecheck } from '../../../packages/workers/src/commercial-access.js'
import type { OutboxEvent } from '../../../packages/persistence/src/repository.js'
import { PublishMediaLifecycleConflictError } from '../../../packages/persistence/src/publish-media-orphan-repository.js'
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
  readBody: () => Promise<Record<string, unknown>>
  send: (res: ServerResponse, status: number, workspaceId: string, data: unknown, error: null, req: IncomingMessage) => true
}

function isPlainPayload(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function mediaReadWorkerRole(req: IncomingMessage, url: URL, deps: HttpWorkerExecutionDependencies) {
  const strict = deps.requiresStrictAuth()
  const verifiedRole = deps.workerRole(req)
  if (strict || verifiedRole) return { strict, role: verifiedRole }
  // Legacy local API tokens are not role-bound. Keep their old publish read
  // behavior, while reconciliation must be explicitly declared in the URL.
  if (!url.searchParams.has('worker_role')) return { strict, role: 'publish' }
  const declaredRole = url.searchParams.get('worker_role')?.trim()
  return { strict, role: ['publish', 'all', 'reconcile'].includes(declaredRole ?? '') ? declaredRole : undefined }
}

export async function handleHttpWorkerExecutionRoute(req: IncomingMessage, res: ServerResponse, path: string, url: URL, deps: HttpWorkerExecutionDependencies): Promise<boolean> {
  const { service, requireWorkerCredentialAuthorization, resolveWorkspace, recheckCustomerDeliveryScan, workerEventOperations, requiresStrictAuth, recheckWorkerGenerationKnowledge, requiresWorkerActorAuthorization, recheckWorkerCommercialAccess, serializedWorkerCommercialRecheck, recheckWorkerAuthorizationSnapshot, enrichRequestObservation, assertCanonicalTaskScopeForAction, isProduction, serializedWorkerAuthorizationSnapshot, publishMediaPayload, readBody, send } = deps
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
    // Generation's generic authorization check runs before the worker has
    // serialized the provider request body, so it cannot yet supply the
    // proof-bound attempt key and body hash required by the knowledge fence.
    // The worker performs that exact recheck immediately before claiming the
    // provider attempt. Direct calls without either proof or this explicit
    // deferral marker remain fail-closed.
    const knowledgeRecheck = requestedOperation === 'generation.execute' && url.searchParams.get('knowledge_recheck') !== 'deferred'
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
    const reconcile = deps.workerRole(req) === 'reconcile'
    if (!['publish', 'all', 'reconcile'].includes(deps.workerRole(req) ?? '')) throw new DomainError(ERROR_CODES.FORBIDDEN, '发布凭据复核只允许已验证签名的 publish/reconcile worker', 403)
    const workspaceId = resolveWorkspace(req)
    const job = service.assertPublishExecutionAllowed({ workspaceId, publishJobId: publishExecutionCheckMatch[1]! })
    enrichRequestObservation(req, { jobId: job.id })
    const eventId = url.searchParams.get('event_id')?.trim() ?? ''
    if (!eventId) throw new DomainError('AUTHZ_EXECUTION_EVENT_REQUIRED', '发布执行缺少持久事件标识，已拒绝释放凭据', 400)
    if (!persistence.outbox) throw new DomainError('AUTHORIZATION_EVENT_REPOSITORY_UNAVAILABLE', '持久事件仓储不可用，已拒绝发布执行', 503)
    const publishEvent = (await persistence.outbox.listAggregateEvents(workspaceId, job.id, 1000)).find(candidate => candidate.id === eventId)
    const expectedEventType = reconcile ? 'publish.reconcile_requested' : 'publish.requested'
    if (!publishEvent || publishEvent.eventType !== expectedEventType || publishEvent.aggregateId !== job.id || publishEvent.workspaceId !== workspaceId) throw new DomainError('AUTHORIZATION_EVENT_NOT_FOUND', '发布执行事件不存在或不属于当前发布任务', 404)
    if (!isPlainPayload(publishEvent.payload)) throw new DomainError('AUTHORIZATION_EVENT_SCOPE_INVALID', '持久发布事件快照格式无效', 403)
    if (publishEvent.payload.payload_hash !== job.payloadHash || publishEvent.payload.platform !== job.platform || publishEvent.payload.account_id !== job.accountId) throw new DomainError('AUTHORIZATION_EVENT_SCOPE_INVALID', '持久发布事件与当前任务快照不匹配', 403)
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
    const operation = reconcile ? 'publish.reconcile' : 'publish.execute'
    let eventSnapshot: WorkerAuthorizationSnapshot
    try { eventSnapshot = parseWorkerAuthorizationSnapshot(publishEvent, operation) } catch { throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_INVALID', '发布事件缺少有效且精确绑定的授权快照', 403) }
    if (!reconcile && JSON.stringify(serializedWorkerAuthorizationSnapshot(eventSnapshot)) !== JSON.stringify(serializedWorkerAuthorizationSnapshot(snapshot))) throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_INVALID', '发布任务与持久事件的授权快照不一致', 403)
    if (eventSnapshot.resourceId !== job.id || eventSnapshot.workspaceId !== workspaceId) throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_INVALID', '发布事件授权快照与当前任务不匹配', 403)
    const authorizationRecheck = await recheckWorkerAuthorizationSnapshot(eventSnapshot, workspaceId, job.id, { eventId: publishEvent.id })
    let commercialSnapshot: WorkerCommercialAccessSnapshot
    try { commercialSnapshot = parseWorkerCommercialAccessSnapshot(publishEvent, operation) } catch { throw new DomainError('COMMERCIAL_EXECUTION_SNAPSHOT_INVALID', '发布事件缺少有效且精确绑定的商业访问快照', 403) }
    const commercialRecheck = await recheckWorkerCommercialAccess(publishEvent, commercialSnapshot)
    return send(res, 200, workspaceId, { allowed: true, job_id: job.id, account_id: job.accountId, account_revision: job.accountRevision, credential_ref: account.credentialRef, payload_hash: job.payloadHash, media_required: job.selectedVisuals.length > 0, authorization_snapshot: serializedWorkerAuthorizationSnapshot(eventSnapshot), authorization_recheck: authorizationRecheck, commercial_access_recheck: serializedWorkerCommercialRecheck(commercialRecheck) }, null, req)
  }
  const publishMediaMatch = path.match(/^\/v1\/publish-jobs\/([^/]+)\/media(?:\/lifecycle)?$/)
  if (req.method === 'GET' && publishMediaMatch) {
    await requireWorkerCredentialAuthorization(req)
    if (path.endsWith('/lifecycle')) {
      const reconcile = deps.workerRole(req) === 'reconcile'
      if (!['publish','all','reconcile'].includes(deps.workerRole(req) ?? '')) throw new DomainError(ERROR_CODES.FORBIDDEN, '媒体生命周期读取只允许已验证签名的 publish/reconcile worker', 403)
      const workspaceId = resolveWorkspace(req)
      const job = service.assertPublishExecutionAllowed({ workspaceId, publishJobId: publishMediaMatch[1]! })
      const key = url.searchParams.get('media_idempotency_key') ?? ''
      const eventId = url.searchParams.get('event_id') ?? ''
      if (!persistence.publishMediaOrphans || !key || !eventId) throw new DomainError('PUBLISH_MEDIA_LIFECYCLE_UNAVAILABLE', '媒体恢复记录或绑定参数不可用', 503)
      const event = persistence.outbox && (await persistence.outbox.listAggregateEvents(workspaceId, job.id, 1000)).find(item => item.id === eventId)
      if (!event || event.eventType !== (reconcile ? 'publish.reconcile_requested' : 'publish.requested') || event.aggregateId !== job.id) throw new DomainError('PUBLISH_MEDIA_EVENT_INVALID', '媒体回执未绑定当前发布或对账事件', 403)
      if (!isPlainPayload(event.payload)) throw new DomainError('PUBLISH_MEDIA_EVENT_SCOPE_INVALID', '媒体回执事件快照格式无效', 403)
      if (event.workspaceId !== workspaceId || event.payload.payload_hash !== job.payloadHash || event.payload.platform !== job.platform || event.payload.account_id !== job.accountId) throw new DomainError('PUBLISH_MEDIA_EVENT_SCOPE_INVALID', '媒体回执事件与当前工作区或冻结发布任务快照不匹配', 403)
      const selected = job.selectedVisuals.find(item => key === `${job.id}:media:${item.visualRef}`)
      if (!selected) throw new DomainError('PUBLISH_MEDIA_SELECTION_MISMATCH', '媒体幂等键与已选视觉不匹配', 403)
      const record = await persistence.publishMediaOrphans.getByKey(workspaceId, job.id, key)
      if (record && (record.sha256 !== selected.sha256 || record.role !== selected.role || record.visualRef !== selected.visualRef)) throw new DomainError('PUBLISH_MEDIA_RECEIPT_SCOPE_INVALID', '保存的媒体回执与当前视觉快照不匹配', 409)
      if (reconcile && record) {
        const originalEvent = persistence.outbox && (await persistence.outbox.listAggregateEvents(workspaceId, job.id, 1000)).find(item => item.id === record.eventId)
        if (!originalEvent || !isPlainPayload(originalEvent.payload) || originalEvent.eventType !== 'publish.requested' || originalEvent.aggregateId !== job.id || originalEvent.workspaceId !== workspaceId || originalEvent.payload.payload_hash !== job.payloadHash || originalEvent.payload.platform !== job.platform || originalEvent.payload.account_id !== job.accountId) throw new DomainError('PUBLISH_MEDIA_RECEIPT_SCOPE_INVALID', '媒体回执缺少与当前任务匹配的原始发布事件绑定', 409)
      } else if (!reconcile && record && record.eventId !== eventId) throw new DomainError('PUBLISH_MEDIA_RECEIPT_SCOPE_INVALID', '保存的媒体回执与当前发布事件不匹配', 409)
      return send(res, 200, workspaceId, { media_lifecycle: record ?? null }, null, req)
    }
    const workspaceId = resolveWorkspace(req)
    const job = service.assertPublishExecutionAllowed({ workspaceId, publishJobId: publishMediaMatch[1]! })
    const { strict, role } = mediaReadWorkerRole(req, url, deps)
    if (!['publish', 'all', 'reconcile'].includes(role ?? '')) throw new DomainError(ERROR_CODES.FORBIDDEN, '发布媒体读取只允许 publish/reconcile worker', 403)
    const reconcile = role === 'reconcile'
    const eventId = url.searchParams.get('event_id')?.trim() ?? ''
    if (!eventId) throw new DomainError('PUBLISH_MEDIA_EVENT_REQUIRED', '发布媒体读取缺少持久事件标识', 400)
    if (!persistence.outbox) throw new DomainError('AUTHORIZATION_EVENT_REPOSITORY_UNAVAILABLE', '持久事件仓储不可用，已拒绝读取发布媒体', 503)
    const publishEvent = (await persistence.outbox.listAggregateEvents(workspaceId, job.id, 1000)).find(candidate => candidate.id === eventId)
    const expectedEventType = reconcile ? 'publish.reconcile_requested' : 'publish.requested'
    if (!publishEvent || publishEvent.eventType !== expectedEventType || publishEvent.aggregateId !== job.id || publishEvent.workspaceId !== workspaceId) throw new DomainError('PUBLISH_MEDIA_EVENT_INVALID', '媒体读取事件未绑定当前发布任务', 403)
    if (!isPlainPayload(publishEvent.payload)) throw new DomainError('PUBLISH_MEDIA_EVENT_SCOPE_INVALID', '媒体读取事件快照格式无效', 403)
    if (publishEvent.payload.payload_hash !== job.payloadHash || publishEvent.payload.platform !== job.platform || publishEvent.payload.account_id !== job.accountId) throw new DomainError('PUBLISH_MEDIA_EVENT_SCOPE_INVALID', '媒体读取事件与当前工作区或冻结发布任务快照不匹配', 403)
    const hasAuthorizationSnapshot = Object.hasOwn(publishEvent.payload, 'authorization_snapshot')
    const hasCommercialSnapshot = Object.hasOwn(publishEvent.payload, 'commercial_access_snapshot')
    if (strict || hasAuthorizationSnapshot || hasCommercialSnapshot) {
      const operation = reconcile ? 'publish.reconcile' : 'publish.execute'
      let authorizationSnapshot: WorkerAuthorizationSnapshot
      try { authorizationSnapshot = parseWorkerAuthorizationSnapshot(publishEvent, operation) }
      catch { throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_INVALID', '发布媒体读取缺少有效且精确绑定的授权快照', 403) }
      let commercialSnapshot: WorkerCommercialAccessSnapshot
      try { commercialSnapshot = parseWorkerCommercialAccessSnapshot(publishEvent, operation) }
      catch { throw new DomainError('COMMERCIAL_EXECUTION_SNAPSHOT_INVALID', '发布媒体读取缺少有效且精确绑定的商业访问快照', 403) }
      const authorizationRecheck = await recheckWorkerAuthorizationSnapshot(authorizationSnapshot, workspaceId, job.id, { eventId: publishEvent.id })
      if (!authorizationRecheck || typeof authorizationRecheck !== 'object' || (authorizationRecheck as { authorized?: unknown }).authorized !== true) throw new DomainError('AUTHZ_EXECUTION_REVOKED', '发布媒体读取授权已撤销或无法确认', 403)
      const commercialRecheck = await recheckWorkerCommercialAccess(publishEvent, commercialSnapshot)
      if (!commercialRecheck.allowed || !commercialRecheck.ready) throw new DomainError(commercialRecheck.denialCode ?? 'COMMERCIAL_EXECUTION_RECHECK_DENIED', '发布媒体读取商业权限未就绪', commercialRecheck.allowed ? 409 : 403)
    }
    await assertCanonicalTaskScopeForAction(service.getTask(job.taskId))
    if (!job.selectedVisuals.length) return send(res, 200, workspaceId, { job_id: job.id, media: [] }, null, req)
    return send(res, 200, workspaceId, { job_id: job.id, media: await publishMediaPayload(workspaceId, job) }, null, req)
  }
  if (req.method === 'POST' && publishMediaMatch && path.endsWith('/media/lifecycle')) {
    await requireWorkerCredentialAuthorization(req)
    const reconcile = deps.workerRole(req) === 'reconcile'
    if (!['publish','all','reconcile'].includes(deps.workerRole(req) ?? '')) throw new DomainError(ERROR_CODES.FORBIDDEN, '媒体生命周期回执只允许已验证签名的 publish/reconcile worker', 403)
    const workspaceId = resolveWorkspace(req)
    const job = service.assertPublishExecutionAllowed({ workspaceId, publishJobId: publishMediaMatch[1]! })
    const body = await readBody()
    const eventId = typeof body.event_id === 'string' ? body.event_id : ''
    const key = typeof body.media_idempotency_key === 'string' ? body.media_idempotency_key : ''
    const event = persistence.outbox && eventId ? (await persistence.outbox.listAggregateEvents(workspaceId, job.id, 1000)).find(item => item.id === eventId) : undefined
    if (!event || event.eventType !== (reconcile ? 'publish.reconcile_requested' : 'publish.requested') || event.aggregateId !== job.id) throw new DomainError('PUBLISH_MEDIA_EVENT_INVALID', '媒体回执未绑定当前发布或对账事件', 403)
    if (event.workspaceId !== workspaceId || event.payload.payload_hash !== job.payloadHash || event.payload.platform !== job.platform || event.payload.account_id !== job.accountId) throw new DomainError('PUBLISH_MEDIA_EVENT_SCOPE_INVALID', '媒体回执事件与当前工作区或冻结发布任务快照不匹配', 403)
    if (!persistence.publishMediaOrphans) throw new DomainError('PUBLISH_MEDIA_LIFECYCLE_UNAVAILABLE', '发布媒体恢复记录仓储不可用', 503)
    const selected = job.selectedVisuals.find(item => item.visualRef === body.visual_ref)
    if (!selected || selected.sha256 !== body.sha256 || selected.role !== body.role || !job.accountId || !job.platform || body.platform !== job.platform || body.account_id !== job.accountId) throw new DomainError('PUBLISH_MEDIA_SELECTION_MISMATCH', '媒体回执与当前发布任务的已选视觉不匹配', 403)
    if (key !== `${job.id}:media:${selected.visualRef}`) throw new DomainError('PUBLISH_MEDIA_IDEMPOTENCY_KEY_INVALID', '媒体幂等键与已选视觉不匹配', 400)
    const state = body.state
    if (!['intent','uploaded','orphaned','retained','unknown','deleted'].includes(String(state))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '媒体生命周期状态无效', 400)
    const receipt = body.receipt && typeof body.receipt === 'object' && !Array.isArray(body.receipt) ? body.receipt as Record<string, unknown> : undefined
    if (state === 'uploaded' && (!receipt || receipt.platform !== job.platform || receipt.visualRef !== selected.visualRef || receipt.role !== selected.role || receipt.sha256 !== selected.sha256 || typeof receipt.mediaId !== 'string' || !receipt.mediaId.trim() || (receipt.url !== undefined && (typeof receipt.url !== 'string' || !receipt.url.trim())) || typeof receipt.simulated !== 'boolean' || (process.env.NODE_ENV === 'production' && receipt.simulated))) throw new DomainError('PUBLISH_MEDIA_RECEIPT_INVALID', '上传回执缺少平台、视觉、SHA 或有效媒体标识证据，生产环境也不接受模拟媒体', 400)
    let transitionEventId = eventId
    if (reconcile) {
      if (state !== 'retained' && state !== 'orphaned') throw new DomainError(ERROR_CODES.FORBIDDEN, 'reconcile worker只能将已存在媒体迁移为 retained 或 orphaned', 403)
      const current = await persistence.publishMediaOrphans.getByKey(workspaceId, job.id, key)
      if (!current) throw new DomainError('PUBLISH_MEDIA_LIFECYCLE_NOT_FOUND', '对账事件不能创建媒体生命周期记录', 409)
      const originalEvent = persistence.outbox && (await persistence.outbox.listAggregateEvents(workspaceId, job.id, 1000)).find(item => item.id === current.eventId)
      if (!originalEvent || originalEvent.eventType !== 'publish.requested' || originalEvent.aggregateId !== job.id || originalEvent.workspaceId !== workspaceId || originalEvent.payload.payload_hash !== job.payloadHash || originalEvent.payload.platform !== job.platform || originalEvent.payload.account_id !== job.accountId) throw new DomainError('PUBLISH_MEDIA_RECEIPT_SCOPE_INVALID', '媒体回执缺少与当前任务匹配的原始发布事件绑定', 409)
      if (current.sha256 !== selected.sha256 || current.role !== selected.role || current.visualRef !== selected.visualRef) throw new DomainError('PUBLISH_MEDIA_RECEIPT_SCOPE_INVALID', '保存的媒体回执与当前视觉快照不匹配', 409)
      if (current.state !== 'unknown' && current.state !== 'uploaded' && current.state !== state) throw new DomainError('PUBLISH_MEDIA_LIFECYCLE_CONFLICT', '媒体当前状态不允许由对账事件修改', 409)
      transitionEventId = current.eventId
    }
    let record: import('../../../packages/persistence/src/publish-media-orphan-repository.js').PublishMediaLifecycleRecord
    try {
      record = await persistence.publishMediaOrphans.transition({ workspaceId, publishJobId: job.id, eventId: transitionEventId, mediaIdempotencyKey: key, platform: job.platform, accountId: job.accountId, visualRef: selected.visualRef, role: selected.role, sha256: selected.sha256, state: state as import('../../../packages/persistence/src/publish-media-orphan-repository.js').PublishMediaState, ...(receipt ? { receipt } : {}), ...(typeof body.reason === 'string' ? { reason: body.reason.slice(0, 256) } : {}) })
    } catch (error) {
      if (error instanceof PublishMediaLifecycleConflictError) throw new DomainError('PUBLISH_MEDIA_LIFECYCLE_CONFLICT', '媒体生命周期记录已变化或状态迁移无效，请先读取当前记录再恢复', 409)
      throw error
    }
    return send(res, 200, workspaceId, { media_lifecycle: record }, null, req)
  }
  return false
}
