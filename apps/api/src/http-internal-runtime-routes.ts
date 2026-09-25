import type { InternalRuntimeContext } from './server.js'
import { createHash } from 'node:crypto'
import { DomainError, type ImageGenerationJob } from '../../../packages/application/src/service.js'
import { ERROR_CODES, validateImageGenerationCallbackResult } from '../../../packages/contracts/src/index.js'
import { evaluatePlatformModelGate } from '../../../packages/ai/src/platform-model-gate.js'
import type { RelayUsageRecord } from '../../../packages/ai/src/relay-usage.js'
import { contextEnvelopeHash } from '../../../packages/persistence/src/context-snapshot-repository.js'
import { ReconciliationEvidenceIdempotencyConflictError, type ReconciliationEvidenceRepository } from '../../../packages/persistence/src/reconciliation-evidence-repository.js'
import { ImageGenerationExecutionError } from '../../../packages/persistence/src/image-generation-execution-repository.js'
import { parseWorkerAuthorizationSnapshot, type WorkerAuthorizationSnapshot } from '../../../packages/workers/src/execution-authorization.js'
import { requiredStringValue } from './ops-params.js'

/** Internal worker callbacks share the server's signed worker identity gate. */
export async function handleInternalRuntimeRoute(context: InternalRuntimeContext): Promise<boolean> {
  const { req, res, path } = context
  const postPath = req.method === 'POST' && (
    ['/v1/internal/automation/tick', '/v1/internal/knowledge-embeddings/admission', '/v1/internal/knowledge-embeddings/outcome',
      '/v1/internal/knowledge/generation-claims', '/v1/internal/model-usage', '/v1/internal/image-generation-jobs/reconciliation',
      '/v1/internal/billing/reconciliation', '/v1/internal/model-usage/reconciliation'].includes(path)
    || /^\/v1\/internal\/image-generation-jobs\/[^/]+\/(?:result|execution|reconciliation-evidence)$/u.test(path)
    || /^\/v1\/internal\/image-generation-continuations\/[^/]+\/execute$/u.test(path)
  )
  const patchClaim = req.method === 'PATCH' && /^\/v1\/internal\/knowledge\/generation-claims\/[^/]+$/u.test(path)
  if (!postPath && !patchClaim) return false
  const { send, requireWorkerAuthorization, headerRequired, hydrateWorkspace,
    runAutomationTick, syncSignedPlatformRules, enrichRequestObservation, body,
    service, persistence, persistenceReady, requireChargedImageDeliveryEvidence,
    persistImageGenerationCompletion, imageJobOutputsAreClean, archiveGeneratedImages,
    recheckWorkerAuthorizationSnapshot, executeReadyImageContinuation,
    imageGenerationReconciliationIdempotencyKey, verifiedWorkerRequestRoles,
    durableKnowledgeRepository, requiresStrictAuth, memoryKnowledge,
    inMemoryTimelineEvents, recordActionSettlement, requestActor, reserveDailyModelBudget,
    recordRelayUsage, runModelUsageReconciliation, recordOperationAudit,
    runPaymentReconciliation } = context
  async function respond(): Promise<void> {
  if (req.method === 'POST' && path === '/v1/internal/automation/tick') {
    await requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    await hydrateWorkspace(workspaceId)
    const automation = await runAutomationTick(workspaceId, req, 'worker-automation')
    const ruleSync = automation.skipReason === 'codex_native_automations_only'
      ? { skipped: true, reason: 'codex_native_automations_only' as const }
      : await syncSignedPlatformRules(workspaceId)
    return send(res, 200, workspaceId, { ...automation, rule_sync: ruleSync }, null, req)
  }
  const imageGenerationResultMatch = path.match(/^\/v1\/internal\/image-generation-jobs\/([^/]+)\/result$/u)
  if (req.method === 'POST' && imageGenerationResultMatch) {
    await requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    const jobId = decodeURIComponent(imageGenerationResultMatch[1]!)
    enrichRequestObservation(req, { jobId })
    await hydrateWorkspace(workspaceId)
    const input = await body(req)
    let callback: ReturnType<typeof validateImageGenerationCallbackResult>
    try {
      callback = validateImageGenerationCallbackResult(input, { allowEventId: true })
    } catch (error) {
      throw new DomainError(ERROR_CODES.INVALID_REQUEST, error instanceof Error ? error.message : '图片生成回执 schema 无效', 400)
    }
    const eventId = callback.event_id!
    const ownerToken = callback.owner_token ?? ''
    const intentHash = callback.intent_hash
    let job = service.getImageGenerationJob(workspaceId, jobId)
    // A callback may be redelivered to a different API process, or after the
    // local hydration cache was populated before the first callback completed.
    // Resolve the current durable job before deciding whether its outputs need
    // archiving; the in-memory projection alone is not a replay fence.
    if (persistence.business) {
      const snapshot = await persistence.business.get(workspaceId, 'image_generation_job', jobId)
      const durableJob = snapshot.payload as unknown as import('../../../packages/application/src/service.js').ImageGenerationJob
      if (durableJob.id !== jobId || durableJob.workspaceId !== workspaceId) throw new DomainError('IMAGE_GENERATION_JOB_SNAPSHOT_INVALID', '持久化图片任务与回执工作区不匹配', 409)
      service.hydrateSnapshot({ entityType: 'image_generation_job', entity: durableJob })
      job = service.getImageGenerationJob(workspaceId, jobId)
    }
    if (job.intentHash !== intentHash) throw new DomainError('IMAGE_GENERATION_INTENT_MISMATCH', '图片生成回执与任务意图不匹配', 409)
    const requestedEvents = persistence.outbox ? await persistence.outbox.listAggregateEvents(workspaceId, jobId, 100) : []
    const requested = requestedEvents.find(event => event.id === eventId && event.eventType === 'image.generation.requested')
    if (!requested) throw new DomainError('IMAGE_GENERATION_EVENT_INVALID', '图片生成回执未绑定有效的请求事件', 409)
    if (requested.payload.intent_hash !== intentHash) throw new DomainError('IMAGE_GENERATION_EVENT_INVALID', '图片生成回执的请求事件意图不匹配', 409)
    const execution = persistence.imageGenerationExecutions ? await persistence.imageGenerationExecutions.get({ workspaceId, jobId }) : undefined
    // A successful provider callback can leave archived assets pending their
    // scan. The job is not yet `succeeded`, but its outputs already belong to
    // this callback and must not be archived a second time on replay.
    if (job.outputs?.length) {
      if (callback.error || !ownerToken || execution?.eventId !== eventId || execution.ownerToken !== ownerToken
        || !callback.provider_request_id || callback.provider_request_id !== execution.providerRequestId) {
        throw new DomainError('IMAGE_GENERATION_CALLBACK_REPLAY_MISMATCH', '重复图片回执与已接受的执行身份或 Provider 请求不一致', 409)
      }
      await requireChargedImageDeliveryEvidence(workspaceId, job.id, requested, callback.provider_request_id)
      await persistImageGenerationCompletion(workspaceId, job)
      if (execution.state === 'provider_started' && job.archiveState === 'archived' && imageJobOutputsAreClean(job)) await persistence.imageGenerationExecutions!.markCompleted({ workspaceId, jobId, ownerToken })
      return send(res, 200, workspaceId, { job_id: job.id, state: job.state, archive_state: job.archiveState, already_completed: true, reconciliation_required: job.archiveState !== 'archived' || !imageJobOutputsAreClean(job) }, null, req)
    }
    if (!ownerToken || !execution || execution.eventId !== eventId || execution.ownerToken !== ownerToken || execution.state !== 'provider_started') throw new DomainError('IMAGE_GENERATION_EXECUTION_LEASE_LOST', '图片生成回执没有有效的 provider 执行租约', 409, { retryable: false, reconciliation_required: true })
    const providerRequestId = callback.provider_request_id ?? ''
    if (!providerRequestId || !execution.providerRequestId || providerRequestId !== execution.providerRequestId) throw new DomainError('IMAGE_GENERATION_PROVIDER_REQUEST_ID_MISMATCH', '图片生成回执必须携带与执行租约一致的真实 provider request id', 409, { retryable: false, reconciliation_required: true })
    const callbackError = callback.error
    if (callbackError) {
      job.state = 'failed'
      job.archiveState = 'external_unarchived'
      job.errorCode = callbackError.code
      job.errorMessage = callbackError.message
      job.revision += 1
      job.updatedAt = new Date().toISOString()
      await persistence.persistSnapshotAndEvent?.({ workspaceId, entityType: 'image_generation_job', entityId: job.id, entityVersion: job.revision, payload: job as unknown as Record<string, unknown>, eventType: 'image.generation.failed', eventPayload: { job_id: job.id, intent_hash: intentHash, error_code: job.errorCode, error_message: job.errorMessage } })
      await persistence.imageGenerationExecutions!.markFailed({ workspaceId, jobId, ownerToken, errorCode: job.errorCode, errorMessage: job.errorMessage })
      return send(res, 200, workspaceId, { job_id: job.id, state: job.state, archive_state: job.archiveState, accepted: true }, null, req)
    }
    const images = callback.images!
    await requireChargedImageDeliveryEvidence(workspaceId, job.id, requested, providerRequestId)
    const archived = await archiveGeneratedImages(workspaceId, job.id, images)
    await persistImageGenerationCompletion(workspaceId, archived)
    if (archived.archiveState === 'archived' && imageJobOutputsAreClean(archived)) await persistence.imageGenerationExecutions!.markCompleted({ workspaceId, jobId, ownerToken })
    return send(res, 200, workspaceId, { job_id: archived.id, state: archived.state, archive_state: archived.archiveState, candidate_count: archived.outputs?.length ?? 0, accepted: true, reconciliation_required: archived.archiveState !== 'archived' || !imageJobOutputsAreClean(archived) }, null, req)
  }
  const imageGenerationExecutionMatch = path.match(/^\/v1\/internal\/image-generation-jobs\/([^/]+)\/execution$/u)
  if (req.method === 'POST' && imageGenerationExecutionMatch) {
    await requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    const jobId = decodeURIComponent(imageGenerationExecutionMatch[1]!)
    enrichRequestObservation(req, { jobId })
    const input = await body(req)
    const repository = persistence.imageGenerationExecutions
    if (!repository) throw new DomainError('IMAGE_GENERATION_DURABLE_NOT_CONFIGURED', '图片生成执行租约存储未配置', 503)
    const operation = typeof input.operation === 'string' ? input.operation.trim() : ''
    try {
      if (operation === 'claim') {
        const eventId = typeof input.event_id === 'string' ? input.event_id.trim() : ''
        if (!eventId) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '执行租约缺少 event_id', 400)
        const job = service.getImageGenerationJob(workspaceId, jobId)
        const requestedEvents = persistence.outbox ? await persistence.outbox.listAggregateEvents(workspaceId, jobId, 100) : []
        const requested = requestedEvents.find(event => event.id === eventId && event.eventType === 'image.generation.requested')
        if (!requested || requested.payload.intent_hash !== job.intentHash) {
          throw new DomainError('IMAGE_GENERATION_EVENT_INVALID', '执行租约的 event_id 未绑定当前图片任务请求或意图已漂移', 409, { reconciliation_required: true })
        }
        const lease = await repository.claim({ workspaceId, jobId, eventId, leaseMs: 15 * 60 * 1000 })
        return send(res, 200, workspaceId, { execution: lease }, null, req)
      }
      const ownerToken = typeof input.owner_token === 'string' ? input.owner_token.trim() : ''
      if (!ownerToken) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '执行租约操作缺少 owner_token', 400)
      if (operation === 'reserve_provider_operation') {
        const execution = await repository.reserveProviderOperation({ workspaceId, jobId, ownerToken })
        return send(res, 200, workspaceId, { execution }, null, req)
      }
      if (operation === 'begin_provider_dispatch') {
        const current = await repository.get({ workspaceId, jobId })
        const event = current && persistence.outbox ? (await persistence.outbox.listAggregateEvents(workspaceId, jobId, 1000)).find(candidate => candidate.id === current.eventId && candidate.eventType === 'image.generation.requested') : undefined
        if (!event) throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_INVALID', '图片调用缺少持久请求及授权证据', 403)
        let snapshot: WorkerAuthorizationSnapshot
        try { snapshot = parseWorkerAuthorizationSnapshot(event, 'image_generation.execute') }
        catch { throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_INVALID', '图片调用的持久身份授权证据无效', 403) }
        await recheckWorkerAuthorizationSnapshot(snapshot, workspaceId, jobId, { eventId: event.id })
        const execution = await repository.beginProviderDispatch({ workspaceId, jobId, ownerToken })
        return send(res, 200, workspaceId, { execution }, null, req)
      }
      if (operation === 'fail_before_provider') {
        const eventId = requiredStringValue(input, 'event_id')
        const execution = await repository.failBeforeProvider({ workspaceId, jobId, eventId, ownerToken, errorCode: requiredStringValue(input, 'error_code'), errorMessage: requiredStringValue(input, 'error_message') })
        return send(res, 200, workspaceId, { execution }, null, req)
      }
      if (operation === 'provider_started') {
        const providerRequestId = typeof input.provider_request_id === 'string' ? input.provider_request_id.trim() : ''
        if (!providerRequestId) throw new DomainError('IMAGE_GENERATION_PROVIDER_REQUEST_ID_REQUIRED', 'Provider 已启动状态必须绑定真实 provider request id', 400)
        return send(res, 200, workspaceId, { execution: await repository.markProviderStarted({ workspaceId, jobId, ownerToken, providerRequestId }) }, null, req)
      }
      if (operation === 'completed') return send(res, 200, workspaceId, { execution: await repository.markCompleted({ workspaceId, jobId, ownerToken }) }, null, req)
      if (operation === 'failed' || operation === 'outcome_unknown') {
        const errorCode = typeof input.error_code === 'string' ? input.error_code : 'IMAGE_GENERATION_FAILED'
        const errorMessage = typeof input.error_message === 'string' ? input.error_message : 'image generation execution failed'
        const execution = operation === 'failed' ? await repository.markFailed({ workspaceId, jobId, ownerToken, errorCode, errorMessage }) : await repository.markOutcomeUnknown({ workspaceId, jobId, ownerToken, errorCode, errorMessage })
        return send(res, 200, workspaceId, { execution }, null, req)
      }
      throw new DomainError(ERROR_CODES.INVALID_REQUEST, '不支持的图片执行租约操作', 400)
    } catch (error) {
      if (error instanceof ImageGenerationExecutionError) {
        const status = error.code === 'IMAGE_GENERATION_EXECUTION_BUSY' ? 409 : error.code === 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' ? 409 : 409
        throw new DomainError(error.code, '图片生成执行租约状态不允许当前操作', status, { execution: error.execution ?? null, retryable: false, reconciliation_required: error.code === 'IMAGE_GENERATION_PROVIDER_OUTCOME_UNKNOWN' })
      }
      throw error
    }
  }
  const imageContinuationMatch = path.match(/^\/v1\/internal\/image-generation-continuations\/([^/]+)\/execute$/u)
  if (req.method === 'POST' && imageContinuationMatch) {
    await requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    const jobId = decodeURIComponent(imageContinuationMatch[1]!)
    enrichRequestObservation(req, { jobId })
    const executed = await executeReadyImageContinuation(workspaceId, jobId)
    return send(res, 200, workspaceId, { job_id: executed.job.id, state: executed.job.state, continuation_state: executed.job.continuation?.state, already_completed: executed.alreadyCompleted }, null, req)
  }
  const imageGenerationEvidenceMatch = path.match(/^\/v1\/internal\/image-generation-jobs\/([^/]+)\/reconciliation-evidence$/u)
  if (req.method === 'POST' && imageGenerationEvidenceMatch) {
    // Provider credentials and network calls belong to the Worker adapter. The
    // API accepts only a signed-in-at-the-worker observation and owns the
    // tenant/job/execution checks plus durable state transitions.
    await requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    const jobId = decodeURIComponent(imageGenerationEvidenceMatch[1]!)
    enrichRequestObservation(req, { jobId })
    await hydrateWorkspace(workspaceId)
    const input = await body(req)
    const repository = persistence.imageGenerationExecutions
    const evidenceRepository = persistence.reconciliationEvidence
    if (!repository || !evidenceRepository) throw new DomainError('IMAGE_GENERATION_DURABLE_NOT_CONFIGURED', '图片生成对账持久化未配置', 503)
    const job = service.getImageGenerationJob(workspaceId, jobId)
    const execution = await repository.get({ workspaceId, jobId })
    const eventId = typeof input.event_id === 'string' ? input.event_id.trim() : ''
    const intentHash = typeof input.intent_hash === 'string' ? input.intent_hash.trim() : ''
    const providerRequestId = typeof input.provider_request_id === 'string' ? input.provider_request_id.trim() : ''
    const idempotencyKey = typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : ''
    const observedAt = typeof input.observed_at === 'string' ? input.observed_at.trim() : ''
    const providerState = input.provider_state
    const executionAttempt = input.execution_attempt
    const queryAttempt = input.query_attempt
    if (!execution || !eventId || !intentHash || !providerRequestId || !idempotencyKey || !observedAt || !/^[a-f0-9]{64}$/u.test(intentHash)) {
      throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'Provider 对账证据缺少合法 event_id、intent_hash、request_id、幂等键或 observed_at', 400)
    }
    if (input.workspace_id !== undefined && input.workspace_id !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, 'Provider 对账证据工作区不匹配', 403)
    const existingEvidenceForReplay = idempotencyKey ? await evidenceRepository.getByIdempotencyKey({ workspaceId, idempotencyKey }) : undefined
    if (!['provider_started', 'outcome_unknown'].includes(execution.state) && !existingEvidenceForReplay) throw new DomainError('IMAGE_GENERATION_EXECUTION_NOT_RECONCILABLE', '当前图片执行租约不在可对账状态', 409, { reconciliation_required: false, execution_state: execution.state })
    const canonicalInstant = (value: string, field: string) => {
      if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${field} 必须是规范 UTC 时间`, 400)
      return value
    }
    canonicalInstant(observedAt, 'observed_at')
    if (!['processing', 'succeeded', 'failed', 'unknown'].includes(String(providerState))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'Provider 对账证据状态无效', 400)
    if (typeof executionAttempt !== 'number' || !Number.isSafeInteger(executionAttempt) || executionAttempt !== execution.attempt || typeof queryAttempt !== 'number' || !Number.isSafeInteger(queryAttempt) || queryAttempt < 1) {
      throw new DomainError('IMAGE_GENERATION_EXECUTION_ATTEMPT_MISMATCH', 'Provider 对账证据的执行次数与服务端租约不匹配', 409, { reconciliation_required: true })
    }
    const expectedIdempotencyKey = imageGenerationReconciliationIdempotencyKey({
      workspaceId, jobId, eventId, intentHash, executionAttempt: executionAttempt as number, providerRequestId, queryAttempt: queryAttempt as number,
    })
    if (idempotencyKey !== expectedIdempotencyKey) throw new DomainError('IMAGE_GENERATION_EVIDENCE_IDEMPOTENCY_KEY_INVALID', 'Provider 对账证据幂等键必须由当前工作区、任务、事件、执行次数、Provider request id 和查询次数稳定生成', 400, { reconciliation_required: true })
    if (job.intentHash !== intentHash) throw new DomainError('IMAGE_GENERATION_INTENT_MISMATCH', 'Provider 对账证据与任务意图不匹配', 409, { reconciliation_required: true })
    const requestedEvents = persistence.outbox ? await persistence.outbox.listAggregateEvents(workspaceId, jobId, 100) : []
    const requested = requestedEvents.find(event => event.id === eventId && event.eventType === 'image.generation.requested')
    if (!requested || requested.payload.intent_hash !== intentHash || execution.eventId !== eventId) {
      throw new DomainError('IMAGE_GENERATION_EVENT_INVALID', 'Provider 对账证据未绑定当前任务的请求事件', 409, { reconciliation_required: true })
    }
    const expectedActionId = typeof requested.payload.action_id === 'string' && requested.payload.action_id.trim() ? requested.payload.action_id.trim() : undefined
    const actionLedgerId = typeof input.action_ledger_id === 'string' && input.action_ledger_id.trim() ? input.action_ledger_id.trim() : undefined
    if (expectedActionId && actionLedgerId !== expectedActionId) throw new DomainError('IMAGE_GENERATION_ACTION_ID_MISMATCH', '图片对账证据的 action ledger 引用与原始扣费授权不匹配', 409, { reconciliation_required: true })
    const actionAuthorization = expectedActionId ? await persistence.actionLedger?.get(workspaceId, expectedActionId) : undefined
    const usageRows = expectedActionId && persistence.modelUsage ? await persistence.modelUsage.listByAction(workspaceId, expectedActionId) : []
    const billingEvidenceReady = !expectedActionId || Boolean(actionAuthorization && ['settled', 'waived'].includes(actionAuthorization.settlementStatus ?? actionAuthorization.state)) && usageRows.length > 0 && usageRows.every(row => ['settled', 'waived'].includes(row.settlementStatus ?? ''))
    if (!execution.providerRequestId || execution.providerRequestId !== providerRequestId) {
      throw new DomainError('IMAGE_GENERATION_PROVIDER_REQUEST_ID_MISMATCH', 'Provider 对账证据的 request id 与执行租约不匹配', 409, { reconciliation_required: true })
    }
    const parseRecord = (value: unknown, field: string) => {
      if (value === undefined) return undefined
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${field} 必须是 JSON 对象`, 400)
      if (JSON.stringify(value).length > 32_768) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${field} 超过大小限制`, 400)
      return value as Record<string, unknown>
    }
    const images = input.images === undefined ? undefined : Array.isArray(input.images) && input.images.every(item => typeof item === 'string') ? input.images as string[] : (() => { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'Provider 成功证据的 images 必须是字符串数组', 400) })()
    if (images && images.length > 6) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'Provider 成功证据最多包含 6 张图片', 400)
    const responseDigest = typeof input.response_digest === 'string' ? input.response_digest.trim() : ''
    if (!/^[a-f0-9]{64}$/u.test(responseDigest)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'Provider 对账证据缺少合法 response_digest', 400)
    const artifactDigest = input.artifact_digest === undefined ? undefined : typeof input.artifact_digest === 'string' && /^[a-f0-9]{64}$/u.test(input.artifact_digest.trim()) ? input.artifact_digest.trim() : (() => { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'artifact_digest 必须是 SHA-256 摘要', 400) })()
    const providerStatus = input.provider_status === undefined ? undefined : typeof input.provider_status === 'string' && input.provider_status.trim() ? input.provider_status.trim() : (() => { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'provider_status 无效', 400) })()
    const errorCode = input.error_code === undefined ? undefined : typeof input.error_code === 'string' && input.error_code.trim() ? input.error_code.trim() : (() => { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'error_code 无效', 400) })()
    const errorMessage = input.error_message === undefined ? undefined : typeof input.error_message === 'string' && input.error_message.trim() ? input.error_message.trim() : (() => { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'error_message 无效', 400) })()
    const providerStateValue = providerState as 'processing' | 'succeeded' | 'failed' | 'unknown'
    if ((providerStateValue === 'failed' || providerStateValue === 'unknown') !== Boolean(errorCode && errorMessage)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'failed/unknown 证据必须同时提供 error_code 和 error_message', 400)
    if ((providerStateValue === 'processing' || providerStateValue === 'succeeded') && (errorCode || errorMessage)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'processing/succeeded 证据不能包含错误详情', 400)
    const usageRecord = parseRecord(input.usage, 'usage')
    const costRecord = parseRecord(input.cost, 'cost')
    const previousEvidence = existingEvidenceForReplay
    let evidence: Awaited<ReturnType<ReconciliationEvidenceRepository['append']>>
    try {
      evidence = await evidenceRepository.append({
      workspaceId, jobId, executionAttempt: Number(executionAttempt), providerRequestId, queryAttempt: Number(queryAttempt), idempotencyKey,
      providerState: providerStateValue, ...(providerStatus ? { providerStatus } : {}), responseDigest, ...(artifactDigest ? { artifactDigest } : {}),
      ...(typeof input.usage_ledger_id === 'string' && input.usage_ledger_id.trim() ? { usageLedgerId: input.usage_ledger_id.trim() } : {}),
      ...(typeof input.action_ledger_id === 'string' && input.action_ledger_id.trim() ? { actionLedgerId: input.action_ledger_id.trim() } : {}),
      ...(usageRecord ? { usage: usageRecord } : {}), ...(costRecord ? { cost: costRecord } : {}),
      observedAt, ...(typeof input.next_attempt_at === 'string' ? { nextAttemptAt: canonicalInstant(input.next_attempt_at.trim(), 'next_attempt_at') } : {}), ...(errorCode ? { errorCode } : {}), ...(errorMessage ? { errorMessage } : {}),
      })
    } catch (error) {
      if (error instanceof ReconciliationEvidenceIdempotencyConflictError) throw new DomainError('IMAGE_GENERATION_EVIDENCE_IDEMPOTENCY_CONFLICT', 'Provider 对账证据幂等键已绑定到不同内容', 409, { reconciliation_required: true })
      if (error instanceof Error && error.message.startsWith('RECONCILIATION_EVIDENCE_')) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'Provider 对账证据未通过持久化校验', 400)
      throw error
    }
    if (previousEvidence) return send(res, 200, workspaceId, { job_id: job.id, provider_request_id: providerRequestId, provider_state: providerStateValue, evidence_id: evidence.id, replayed: true, reconciliation_required: providerStateValue !== 'failed' }, null, req)
    const repaired: Record<string, unknown> = { job_id: job.id, provider_request_id: providerRequestId, provider_state: providerStateValue, evidence_id: evidence.id }
    if (providerStateValue === 'failed') {
      const settled = await repository.reconcileFailed({ workspaceId, jobId: job.id, errorCode: errorCode!, errorMessage: errorMessage! })
      return send(res, 200, workspaceId, { ...repaired, execution: settled, reconciliation_required: false }, null, req)
    }
    if (providerStateValue === 'succeeded' && images?.length) {
      try {
        await requireChargedImageDeliveryEvidence(workspaceId, job.id, requested, providerRequestId)
      } catch (error) {
        if (!(error instanceof DomainError) || !['IMAGE_GENERATION_COMMERCIAL_SNAPSHOT_INVALID', 'IMAGE_GENERATION_COMMERCIAL_BINDING_INVALID', 'IMAGE_GENERATION_SETTLEMENT_REPOSITORY_UNAVAILABLE', 'IMAGE_GENERATION_SETTLEMENT_EVIDENCE_PENDING'].includes(error.code)) throw error
        return send(res, 200, workspaceId, { ...repaired, archive_state: 'pending', candidate_count: 0, reconciliation_required: true, settlement_error_code: error.code, next_action: 'Provider 成功证据已保存；等待原始图片用量、成本与创意点扣费双回执核对，禁止自动重试或交付候选' }, null, req)
      }
      const archived = await archiveGeneratedImages(workspaceId, job.id, images)
      if (archived.archiveState === 'archived' && imageJobOutputsAreClean(archived) && billingEvidenceReady) {
        const settled = await repository.reconcileCompleted({ workspaceId, jobId: job.id })
        return send(res, 200, workspaceId, { ...repaired, execution: settled, archive_state: archived.archiveState, candidate_count: archived.outputs?.length ?? 0, reconciliation_required: false }, null, req)
      }
      return send(res, 200, workspaceId, { ...repaired, archive_state: archived.archiveState, candidate_count: archived.outputs?.length ?? 0, reconciliation_required: true, next_action: billingEvidenceReady ? '等待产物归档与安全扫描完成' : '等待图片用量/成本与原始扣费授权完成结算' }, null, req)
    }
    return send(res, 200, workspaceId, { ...repaired, reconciliation_required: true, next_action: providerStateValue === 'processing' ? 'Provider 仍在处理中，等待下一次查询' : 'Provider 状态或产物尚不足以完成交付，保持对账状态' }, null, req)
  }
  if (req.method === 'POST' && (path === '/v1/internal/knowledge-embeddings/admission' || path === '/v1/internal/knowledge-embeddings/outcome')) {
    await requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    const input = await body(req)
    const documentId = typeof input.document_id === 'string' ? input.document_id.trim() : ''
    const documentRevision = Number(input.document_revision)
    const contentHash = typeof input.content_hash === 'string' ? input.content_hash.trim().toLowerCase() : ''
    const actionId = typeof input.action_id === 'string' ? input.action_id.trim() : ''
    const runKey = typeof input.run_key === 'string' ? input.run_key.trim() : ''
    if (!documentId || !Number.isSafeInteger(documentRevision) || documentRevision < 1 || !/^[a-f0-9]{64}$/u.test(contentHash)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '知识向量准入缺少合法 document_id、document_revision 或 content_hash', 400)
    const expectedActionId = `knowledge-embedding:${documentId}:${documentRevision}`
    const expectedRunKey = `knowledge-index:${documentId}:${documentRevision}`
    if (actionId !== expectedActionId || runKey !== expectedRunKey) throw new DomainError('KNOWLEDGE_EMBEDDING_BINDING_INVALID', '知识向量动作标识未绑定文档版本', 409, { expected_action_id: expectedActionId, expected_run_key: expectedRunKey })
    await persistenceReady
    const repository = persistence.knowledge ?? durableKnowledgeRepository ?? (!requiresStrictAuth() ? memoryKnowledge : undefined)
    if (!repository) throw new DomainError('KNOWLEDGE_DURABLE_NOT_CONFIGURED', '知识库持久化仓储未配置，已阻断向量调用', 503)
    const document = (await repository.listDocuments(workspaceId)).find(candidate => candidate.id === documentId)
    if (!document) throw new DomainError('KNOWLEDGE_DOCUMENT_NOT_FOUND', '知识文档不存在', 404)
    if (document.revision !== documentRevision || document.contentHash !== contentHash) throw new DomainError('KNOWLEDGE_EMBEDDING_DOCUMENT_STALE', '知识文档版本或内容摘要已变化，已阻断向量调用', 409)
    if (document.approvalStatus !== 'approved' || document.rightsStatus !== 'cleared' || !['queued', 'indexing'].includes(document.indexState)) throw new DomainError('KNOWLEDGE_EMBEDDING_DOCUMENT_NOT_ELIGIBLE', '知识文档未完成审批、权利确认或不在待索引状态', 409, { approval_status: document.approvalStatus, rights_status: document.rightsStatus, index_state: document.indexState })
    if (path.endsWith('/admission')) {
      const embeddingGate = evaluatePlatformModelGate(process.env, 'embedding')
      if (!embeddingGate.ready || process.env.KNOWLEDGE_VECTOR_INDEX_ENABLED !== 'true') throw new DomainError('KNOWLEDGE_EMBEDDING_PROVIDER_NOT_READY', '知识向量中转配置未通过生产门禁', 503, { reasons: embeddingGate.reasons, vector_index_enabled: process.env.KNOWLEDGE_VECTOR_INDEX_ENABLED === 'true' })
      const existingAuthorization = await persistence.actionLedger?.get(workspaceId, actionId)
      if (existingAuthorization && ['released', 'refunded', 'manual_attention'].includes(existingAuthorization.settlementStatus ?? existingAuthorization.state ?? '')) throw new DomainError('KNOWLEDGE_EMBEDDING_AUTHORIZATION_INACTIVE', '知识向量动作授权已失效，禁止再次调用上游', 409)
      if (!existingAuthorization) await recordActionSettlement({ workspaceId, actionKey: actionId, actionKind: 'other', settlement: 'included_quota', amountFen: 0, actorId: requestActor(req), description: '知识向量索引模型调用', settlementStatus: 'authorized' })
      const budget = await reserveDailyModelBudget(workspaceId, actionId, runKey, 'embedding')
      return send(res, 200, workspaceId, { admitted: true, reused: budget?.reused ?? false, action_id: actionId, run_key: runKey, reservation: budget ? { reservation_key: budget.reservation.reservationKey, run_key: budget.reservation.runKey, status: budget.reservation.status, estimate_cny: budget.reservation.estimateCny, estimate_version: budget.reservation.estimateVersion, daily_limit_cny: budget.reservation.dailyLimitCny, run_limit_cny: budget.reservation.runLimitCny, revision: budget.reservation.revision } : null }, null, req)
    }
    const outcome = input.outcome
    if (outcome !== 'failed_before_provider' && outcome !== 'unknown') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'outcome 必须是 failed_before_provider 或 unknown', 400)
    const authorization = await persistence.actionLedger?.get(workspaceId, actionId)
    if (!authorization) throw new DomainError('KNOWLEDGE_EMBEDDING_AUTHORIZATION_NOT_FOUND', '知识向量动作授权不存在', 409)
    if (outcome === 'failed_before_provider') {
      const released = await persistence.modelUsage?.releaseDailyBudget({ workspaceId, reservationKey: actionId })
      if (authorization.settlementStatus === 'authorized') await persistence.actionLedger?.transitionSettlementStatus({ workspaceId, actionKey: actionId, from: ['authorized'], to: 'released' })
      return send(res, 200, workspaceId, { outcome, action_id: actionId, reservation_status: released?.status ?? 'released', reconciliation_required: false }, null, req)
    }
    return send(res, 202, workspaceId, { outcome, action_id: actionId, reservation_status: 'active', reconciliation_required: true, next_action: '按 provider idempotency key 查询真实结果；确认成功后提交 /v1/internal/model-usage，确认调用前失败后提交 failed_before_provider' }, null, req)
  }
  const knowledgeClaimTransitionMatch = path.match(/^\/v1\/internal\/knowledge\/generation-claims\/([^/]+)$/u)
  if ((req.method === 'POST' && path === '/v1/internal/knowledge/generation-claims') || (req.method === 'PATCH' && knowledgeClaimTransitionMatch)) {
    await requireWorkerAuthorization(req)
    if (verifiedWorkerRequestRoles.get(req) && verifiedWorkerRequestRoles.get(req) !== 'generation') {
      throw new DomainError(ERROR_CODES.FORBIDDEN, 'knowledge generation claims require the generation worker role', 403)
    }
    const workspaceId = headerRequired(req, 'x-workspace-id')
    const repository = persistence.knowledge ?? durableKnowledgeRepository ?? (!requiresStrictAuth() ? memoryKnowledge : undefined)
    if (!repository || (requiresStrictAuth() && process.env.NODE_ENV !== 'test' && !persistence.outbox)) throw new DomainError('KNOWLEDGE_GENERATION_CLAIM_NOT_CONFIGURED', '持久知识资料与生成事件仓储未配置，已阻断模型派发', 503)
    const input = await body(req, 64 * 1024)
    const textField = (key: string) => typeof input[key] === 'string' && (input[key] as string).trim() ? (input[key] as string).trim() : undefined
    if (textField('workspace_id') !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '知识生成 claim 工作区不匹配', 403)
    const eventId = textField('event_id')
    const aggregateId = textField('aggregate_id')
    const taskId = textField('task_id')
    const providerAttemptId = textField('provider_attempt_id')
    const providerAttemptKey = textField('provider_attempt_key')
    const requestBodySha256 = textField('request_body_sha256')?.toLowerCase()
    const requestNonce = textField('request_nonce')
    const productId = textField('product_id')
    const contextHash = textField('context_hash')?.toLowerCase()
    const logicalAttempt = input.logical_attempt
    const transportAttempt = input.transport_attempt
    const rawExpected = input.expected_documents
    if (!eventId || !aggregateId || !taskId || !providerAttemptId || !providerAttemptKey || !requestBodySha256 || !requestNonce || !productId || !contextHash
      || !Number.isSafeInteger(logicalAttempt) || (logicalAttempt as number) < 1
      || !Number.isSafeInteger(transportAttempt) || (transportAttempt as number) < 1
      || !/^mm-[a-f0-9]{64}$/u.test(providerAttemptKey) || !/^[a-f0-9]{64}$/u.test(requestBodySha256)
      || !/^[0-9a-f-]{36}$/iu.test(requestNonce) || !/^[a-f0-9]{64}$/u.test(contextHash)
      || !Array.isArray(rawExpected) || rawExpected.length > 8) {
      throw new DomainError(ERROR_CODES.INVALID_REQUEST, '知识生成 claim 缺少有效且有界的请求身份或知识快照', 400)
    }
    const attemptSeed = JSON.stringify([workspaceId, eventId, aggregateId, taskId, logicalAttempt, transportAttempt, providerAttemptKey, requestBodySha256])
    const deterministicUuid = (domain: string) => {
      const hex = createHash('sha256').update(`${domain}\0${attemptSeed}`, 'utf8').digest('hex')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    }
    if (providerAttemptId !== deterministicUuid('knowledge-provider-attempt-v1')
      || requestNonce !== deterministicUuid('knowledge-provider-nonce-v1')) {
      throw new DomainError('KNOWLEDGE_GENERATION_ATTEMPT_IDENTITY_MISMATCH', '知识生成 claim 的 Provider attempt 身份未绑定到该事件和物理请求', 409)
    }
    const expectedDocuments: Array<{ documentId: string; revision: number; contentSha256: string }> = []
    for (const raw of rawExpected) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '知识生成 claim 文档格式无效', 400)
      const document = raw as Record<string, unknown>
      if (typeof document.document_id !== 'string' || !document.document_id.trim() || !Number.isSafeInteger(document.revision) || (document.revision as number) < 1
        || typeof document.content_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(document.content_sha256)) {
        throw new DomainError(ERROR_CODES.INVALID_REQUEST, '知识生成 claim 文档身份无效', 400)
      }
      expectedDocuments.push({ documentId: document.document_id.trim(), revision: document.revision as number, contentSha256: document.content_sha256 })
    }
    if (new Set(expectedDocuments.map(document => document.documentId)).size !== expectedDocuments.length) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '知识生成 claim 不可重复引用文档', 400)

    // Bind the signed worker claim to the durable event snapshot so a worker
    // cannot turn this internal endpoint into an arbitrary product lock.
    const aggregateEvents = persistence.outbox
      ? await persistence.outbox.listAggregateEvents(workspaceId, aggregateId, 100)
      : (inMemoryTimelineEvents.get(workspaceId) ?? []).filter(candidate => candidate.aggregateId === aggregateId)
    const event = aggregateEvents.find(candidate => candidate.id === eventId)
    const payload = event?.payload
    const frozenInput = payload?.input && typeof payload.input === 'object' && !Array.isArray(payload.input) ? payload.input as Record<string, unknown> : undefined
    const frozenProduct = frozenInput?.product && typeof frozenInput.product === 'object' && !Array.isArray(frozenInput.product) ? frozenInput.product as Record<string, unknown> : undefined
    const frozenKnowledge = frozenInput?.knowledgeContext && typeof frozenInput.knowledgeContext === 'object' && !Array.isArray(frozenInput.knowledgeContext) ? frozenInput.knowledgeContext as Record<string, unknown> : undefined
    const frozenDocuments = Array.isArray(frozenKnowledge?.documents) ? frozenKnowledge.documents : []
    const frozenExpected = frozenDocuments.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const document = raw as Record<string, unknown>
      if (typeof document.id !== 'string' || typeof document.content !== 'string' || !Number.isSafeInteger(document.revision)) return null
      return { documentId: document.id, revision: document.revision as number, contentSha256: createHash('sha256').update(document.content, 'utf8').digest('hex') }
    })
    const normalizedExpected = (documents: typeof expectedDocuments) => [...documents].sort((left, right) => left.documentId.localeCompare(right.documentId))
    if (!event || event.workspaceId !== workspaceId || event.aggregateId !== aggregateId || event.eventType !== 'generation.requested'
      || payload?.job_id !== aggregateId || payload?.task_id !== taskId || payload?.context_hash !== contextHash
      || frozenProduct?.id !== productId || !frozenInput || contextEnvelopeHash(frozenInput) !== contextHash
      || frozenExpected.some(document => !document)
      || JSON.stringify(normalizedExpected(expectedDocuments)) !== JSON.stringify(normalizedExpected(frozenExpected.filter((document): document is NonNullable<typeof document> => document !== null)))) {
      throw new DomainError('KNOWLEDGE_GENERATION_EVENT_MISMATCH', '知识生成 claim 与已冻结的任务事件不一致', 409)
    }

    if (req.method === 'POST') {
      const claim = await repository.claimGenerationKnowledge({ workspaceId, eventId, aggregateId, taskId, logicalAttempt: logicalAttempt as number, providerAttemptId, providerAttemptKey, requestBodySha256, requestNonce, productId, contextHash, expectedDocuments })
      if (!claim.claimed || !claim.claimId || claim.state !== 'claimed' || !claim.claimedAt) {
        const code = claim.reason === 'snapshot_changed' ? 'KNOWLEDGE_CONTEXT_CHANGED' : claim.reason === 'active_claim' ? 'KNOWLEDGE_GENERATION_CLAIM_ACTIVE' : 'KNOWLEDGE_GENERATION_ATTEMPT_CONFLICT'
        throw new DomainError(code, '知识资料已变化或当前生成请求仍有未核实的 Provider 尝试，已阻断模型派发', 409)
      }
      return send(res, 200, workspaceId, { ok: true, claim_id: claim.claimId, workspace_id: workspaceId, event_id: eventId, aggregate_id: aggregateId, task_id: taskId, logical_attempt: logicalAttempt, transport_attempt: transportAttempt, provider_attempt_id: providerAttemptId, provider_attempt_key: providerAttemptKey, request_body_sha256: requestBodySha256, request_nonce: requestNonce, product_id: productId, context_hash: contextHash, document_count: expectedDocuments.length, claim_state: claim.state, claimed_at: claim.claimedAt }, null, req)
    }

    const claimId = decodeURIComponent(knowledgeClaimTransitionMatch![1]!)
    const to = input.to
    if (!['provider_started', 'outcome_unknown', 'completed', 'rejected'].includes(String(to))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '知识生成 claim 状态转换无效', 400)
    const updated = await repository.settleGenerationKnowledgeClaim({ workspaceId, claimId, providerAttemptId, providerAttemptKey, requestBodySha256, requestNonce, to: to as 'provider_started' | 'outcome_unknown' | 'completed' | 'rejected' })
    if (!updated || updated.state !== to) throw new DomainError('KNOWLEDGE_GENERATION_CLAIM_TRANSITION_CONFLICT', '知识生成 claim 状态或请求身份已变化', 409)
    return send(res, 200, workspaceId, { ok: true, claim_id: claimId, workspace_id: workspaceId, event_id: eventId, aggregate_id: aggregateId, task_id: taskId, logical_attempt: logicalAttempt, transport_attempt: transportAttempt, provider_attempt_id: providerAttemptId, provider_attempt_key: providerAttemptKey, request_body_sha256: requestBodySha256, request_nonce: requestNonce, product_id: productId, context_hash: contextHash, document_count: expectedDocuments.length, claim_state: updated.state, claimed_at: updated.claimedAt, updated_at: updated.updatedAt }, null, req)
  }
  if (req.method === 'POST' && path === '/v1/internal/model-usage') {
    await requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    const input = await body(req)
    const modality = input.modality
    // The API is the single settlement owner for every modality. Settle the
    // reservation when verified usage arrives; delivery only verifies that
    // durable fact before exposing generated content.
    const deferCreativePointSettlementToWorker = false
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    const actionId = typeof input.actionId === 'string' ? input.actionId.trim() : undefined
    const runKey = typeof input.runKey === 'string' ? input.runKey.trim() : undefined
    const contextLinkId = typeof input.contextLinkId === 'string' ? input.contextLinkId.trim() : undefined
    const contextHash = typeof input.contextHash === 'string' ? input.contextHash.trim() : undefined
    const providerRequestId = typeof input.providerRequestId === 'string' ? input.providerRequestId.trim() : undefined
    const number = (value: unknown, name: string) => {
      if (value === undefined) return undefined
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${name} 必须是非负数`, 400)
      return value
    }
    if (!['text', 'image', 'image_edit', 'ocr', 'video', 'embedding'].includes(String(modality)) || !model || !actionId || !runKey) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '模型用量回执缺少合法 modality、model、actionId 或 runKey', 400)
    if (verifiedWorkerRequestRoles.get(req) === 'automation' && modality !== 'embedding') throw new DomainError(ERROR_CODES.FORBIDDEN, 'automation worker may report embedding usage only', 403)
    if ((contextLinkId === undefined) !== (contextHash === undefined) || (contextHash !== undefined && !/^[a-f0-9]{64}$/u.test(contextHash))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '模型用量回执的 contextLinkId/contextHash 必须成对且合法', 400)
    if (input.workspaceId !== undefined && input.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '模型用量回执工作区不匹配', 403)
    let actionAuthorization = await persistence.actionLedger?.get(workspaceId, actionId)
    // Older durable candidate jobs could be queued before their zero-charge
    // authorization was persisted. Repair that narrow image-only case at the
    // settlement boundary so a real provider result is not stranded.
    if (!actionAuthorization && modality === 'image' && actionId.startsWith('image:')) {
      actionAuthorization = await recordActionSettlement({ workspaceId, actionKey: actionId, actionKind: 'model_image', settlement: 'included_quota', amountFen: 0, actorId: requestActor(req), description: '图片生成候选（未绑定商品）', settlementStatus: 'authorized' })
    }
    if (!actionAuthorization || ['refunded', 'released', 'manual_attention'].includes(actionAuthorization.settlementStatus ?? '') || actionAuthorization.state === 'refunded') {
      throw new DomainError('MODEL_USAGE_ACTION_NOT_AUTHORIZED', '模型中转回执未绑定有效的原始扣费授权，已阻断入账', 409)
    }
    await recordRelayUsage({ workspaceId, actionId, runKey, ...(contextLinkId ? { contextLinkId, contextHash: contextHash! } : {}), modality: modality as RelayUsageRecord['modality'], model, ...(providerRequestId ? { providerRequestId } : {}), ...(input.inputTokens !== undefined ? { inputTokens: number(input.inputTokens, 'inputTokens')! } : {}), ...(input.outputTokens !== undefined ? { outputTokens: number(input.outputTokens, 'outputTokens')! } : {}), ...(input.totalTokens !== undefined ? { totalTokens: number(input.totalTokens, 'totalTokens')! } : {}), ...(input.costCny !== undefined ? { costCny: number(input.costCny, 'costCny')! } : {}), observedAt: typeof input.observedAt === 'string' && Number.isFinite(Date.parse(input.observedAt)) ? input.observedAt : new Date().toISOString(), ...(input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? { metadata: input.metadata as Record<string, unknown> } : {}) }, { deferCreativePointSettlementToWorker })
    return send(res, 200, workspaceId, { recorded: true, action_id: actionId ?? null, provider_request_id: providerRequestId ?? null }, null, req)
  }
  if (req.method === 'POST' && path === '/v1/internal/image-generation-jobs/reconciliation') {
    await requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    await hydrateWorkspace(workspaceId)
    const input = await body(req)
    const limit = input.limit === undefined ? 100 : Number(input.limit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须是 1 至 1000 的整数', 400)
    if (input.workspace_id !== undefined && input.workspace_id !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '图片对账工作区不匹配', 403)
    const cursor = input.cursor === undefined ? undefined : typeof input.cursor === 'string' && input.cursor.trim() ? input.cursor.trim() : (() => { throw new DomainError(ERROR_CODES.INVALID_REQUEST, '图片对账 cursor 必须是非空字符串', 400) })()
    const olderThan = input.older_than === undefined ? undefined : typeof input.older_than === 'string' && Number.isFinite(Date.parse(input.older_than)) ? input.older_than : (() => { throw new DomainError(ERROR_CODES.INVALID_REQUEST, '图片对账 older_than 必须是合法时间', 400) })()
    const repository = persistence.imageGenerationExecutions
    if (!repository) throw new DomainError('IMAGE_GENERATION_DURABLE_NOT_CONFIGURED', '图片生成执行租约存储未配置', 503)
    const page = await repository.listPage({ workspaceId, states: ['provider_reserved', 'provider_dispatching', 'provider_started', 'outcome_unknown'], limit, ...(cursor ? { cursor } : {}), ...(olderThan ? { olderThan } : {}) })
    const executions = page.items
    const repaired: Array<Record<string, unknown>> = []
    const attention: Array<Record<string, unknown>> = []
    for (const execution of executions) {
      const job = service.getImageGenerationJob(workspaceId, execution.jobId)
      // A provider response may already exist while usage settlement or
      // artifact archiving is still pending. Such jobs must remain
      // reconcilable; treating the user-facing failed projection as a
      // terminal provider failure would permanently close the execution lease
      // and make a safe evidence-based recovery impossible.
      const providerSettlementPending = ['MODEL_USAGE_SETTLEMENT_PENDING', 'MODEL_USAGE_COST_MISSING'].includes(job.errorCode ?? '')
        || Boolean(execution.providerRequestId && job.state === 'failed' && job.archiveState !== 'archived')
      if (job.state === 'succeeded' && job.archiveState === 'archived' && Boolean(job.outputs?.length)) {
        const settled = await repository.reconcileCompleted({ workspaceId, jobId: job.id })
        repaired.push({ job_id: job.id, from: execution.state, to: settled.state, reason: 'job_archive_is_authoritative' })
      } else if (job.state === 'failed' && !providerSettlementPending) {
        const settled = await repository.reconcileFailed({ workspaceId, jobId: job.id, errorCode: job.errorCode ?? 'IMAGE_GENERATION_FAILED', errorMessage: job.errorMessage ?? '图片生成任务已失败' })
        repaired.push({ job_id: job.id, from: execution.state, to: settled.state, reason: 'job_failure_is_authoritative' })
      } else {
        const latestEvidence = persistence.reconciliationEvidence ? await persistence.reconciliationEvidence.getLatest({ workspaceId, jobId: execution.jobId }) : undefined
        if (latestEvidence?.nextAttemptAt && Date.parse(latestEvidence.nextAttemptAt) > Date.now()) continue
        const requestedEvents = persistence.outbox ? await persistence.outbox.listAggregateEvents(workspaceId, job.id, 100) : []
        const requested = requestedEvents.find(event => event.eventType === 'image.generation.requested' && event.payload.intent_hash === job.intentHash)
        attention.push({ job_id: job.id, event_id: execution.eventId, intent_hash: job.intentHash, execution_attempt: execution.attempt, query_attempt: (latestEvidence?.queryAttempt ?? 0) + 1, execution_state: execution.state, provider_request_id: execution.providerRequestId ?? null, reconciliation_required: true, next_action: 'Worker 必须查询真实 Provider 后提交 reconciliation-evidence；API 禁止直接查询 Provider', ...(providerSettlementPending ? { reason: 'provider_result_or_usage_settlement_pending' } : {}) })
        if (requested?.payload.action_id) attention.at(-1)!.action_id = requested.payload.action_id
      }
    }
    return send(res, 200, workspaceId, { checked: executions.length, repaired, attention, next_cursor: page.nextCursor ?? null, has_more: Boolean(page.nextCursor), scan_watermark: page.scanWatermark, read_only_provider_policy: true, provider_evidence_endpoint: '/v1/internal/image-generation-jobs/{job_id}/reconciliation-evidence' }, null, req)
  }
  if (req.method === 'POST' && path === '/v1/internal/billing/reconciliation') {
    await requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    const workerId = headerRequired(req, 'x-worker-id')
    const input = await body(req)
    if (typeof input.workspace_id !== 'string' || !input.workspace_id.trim()) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'workspace_id 必须是非空字符串', 400)
    if (input.workspace_id !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '支付对账工作区不匹配', 403)
    const limit = input.limit === undefined ? 10 : input.limit
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须是 1 至 20 的整数', 400)
    if (process.env.PAYMENT_RECONCILIATION_ENABLED !== 'true') throw new DomainError('PAYMENT_RECONCILIATION_DISABLED', '支付对账自动执行未启用', 503)
    const actorId = `worker:${workerId}`
    let reconciliation
    try {
      reconciliation = await runPaymentReconciliation({ workspaceId, actorId, limit })
    } catch (error) {
      await recordOperationAudit({ workspaceId, actorId, action: 'billing.reconciliation.worker', resourceType: 'billing_reconciliation', resourceId: workspaceId, before: {}, after: { state: 'failed', limit, code: error instanceof DomainError ? error.code : 'PAYMENT_RECONCILIATION_FAILED' }, reason: 'reconcile worker 支付与退款对账未完成' })
      throw error
    }
    const summary = {
      state: reconciliation.state, limit, checked: reconciliation.checked,
      payment_checked: reconciliation.payment_checked, refund_checked: reconciliation.refund_checked,
      deferred: reconciliation.deferred, provider_orders: reconciliation.provider_orders, total_query_budget: reconciliation.total_query_budget,
      settled: reconciliation.settled.length, pending: reconciliation.pending.length, failed: reconciliation.failed.length,
      refund_settled: reconciliation.refund_settled.length, refund_pending: reconciliation.refund_pending.length, refund_failed: reconciliation.refund_failed.length,
      audit_projection_failures: reconciliation.audit_projection_failures.length, queue_rotation_failures: reconciliation.queue_rotation_failures.length,
    }
    try {
      await recordOperationAudit({ workspaceId, actorId, action: 'billing.reconciliation.worker', resourceType: 'billing_reconciliation', resourceId: workspaceId, before: {}, after: summary, reason: 'reconcile worker 自动执行支付与退款对账' })
    } catch (auditError) {
      const businessState = reconciliation.state
      reconciliation.state = 'attention_required'
      reconciliation.audit_projection_failures.push({ order_id: workspaceId, code: 'BILLING_AUDIT_PROJECTION_FAILED', cause_code: auditError instanceof Error && 'code' in auditError && typeof auditError.code === 'string' ? auditError.code : 'OPERATION_AUDIT_APPEND_FAILED', message: auditError instanceof Error ? auditError.message : '对账汇总审计投影失败', business_state: businessState, reliable_fact_source: 'transactional_outbox' })
    }
    return send(res, 200, workspaceId, reconciliation, null, req)
  }
  if (req.method === 'POST' && path === '/v1/internal/model-usage/reconciliation') {
    await requireWorkerAuthorization(req)
    const workspaceId = headerRequired(req, 'x-workspace-id')
    const input = await body(req)
    const limit = input.limit === undefined ? 50 : Number(input.limit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须是 1 至 100 的整数', 400)
    if (input.workspace_id !== undefined && input.workspace_id !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '模型用量对账工作区不匹配', 403)
    const actorId = 'worker:model-usage-reconciliation'
    const reconciliation = await runModelUsageReconciliation({ workspaceId, actorId, limit })
    await recordOperationAudit({ workspaceId, actorId, action: 'billing.model-usage.reconciliation.worker', resourceType: 'model_usage', resourceId: workspaceId, before: {}, after: reconciliation, reason: 'reconcile worker 自动执行模型用量结算重试' })
    return send(res, 200, workspaceId, reconciliation, null, req)
  }
  }
  await respond()
  return true
}
