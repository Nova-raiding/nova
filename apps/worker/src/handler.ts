import { WorkerFailure } from '../../../packages/workers/src/runner.js'
import type { DurableOutboxEvent, DurableOutboxHandler } from '../../../packages/workers/src/durable.js'
import type { PublishHandlerResult } from '../../../packages/workers/src/publish-adapter.js'
import { buildPublishObservationRequest, PublishObservationReportError } from '../../../packages/workers/src/publish-observation.js'
import type { GeneratedContent } from '../../../packages/ai/src/generator.js'
import { QuotaExceededError } from '../../../packages/quotas/src/admission.js'
import { createUnavailableExecutionAuthorizationGuard, parseWorkerAuthorizationSnapshot, type CriticalWorkerOperation, type WorkerExecutionAuthorizationGuard } from '../../../packages/workers/src/execution-authorization.js'
import { createUnavailableCommercialAccessGuard, normalizeCommercialAccessFailure, parseWorkerCommercialAccessSnapshot, type WorkerCommercialAccessGuard } from '../../../packages/workers/src/commercial-access.js'

export interface WorkerProjection {
  snapshots: Map<string, { sequence: number; payload: Record<string, unknown> }>
  tasks: Map<string, Record<string, unknown>>
}

export interface WorkerHandlerOptions {
  projection?: WorkerProjection
  onStateSnapshot?: (event: DurableOutboxEvent, projection: WorkerProjection, signal?: AbortSignal) => Promise<void> | void
  onTaskCreated?: (event: DurableOutboxEvent, projection: WorkerProjection, signal?: AbortSignal) => Promise<void> | void
  publishRequested?: (event: DurableOutboxEvent, projection: WorkerProjection, signal?: AbortSignal) => Promise<PublishHandlerResult>
  reconcileRequested?: (event: DurableOutboxEvent, projection: WorkerProjection, signal?: AbortSignal) => Promise<PublishHandlerResult>
  generationRequested?: (event: DurableOutboxEvent, projection: WorkerProjection, signal?: AbortSignal) => Promise<GeneratedContent>
  /** Executes a frozen ordinary-image request; the callback must persist the
   * provider result before the outbox event is acknowledged. */
  imageGenerationRequested?: (event: DurableOutboxEvent, projection: WorkerProjection, signal?: AbortSignal) => Promise<unknown>
  onGenerationResult?: (event: DurableOutboxEvent, result: { content?: GeneratedContent; error?: { code: string; message: string } }, projection: WorkerProjection, signal?: AbortSignal) => Promise<void> | void
  onGenerationDeferred?: (event: DurableOutboxEvent, error: { code: string; message: string; retryAfterSeconds: number }, projection: WorkerProjection, signal?: AbortSignal) => Promise<void> | void
  onPublishObservation?: (event: DurableOutboxEvent, observation: PublishHandlerResult, projection: WorkerProjection, signal?: AbortSignal) => Promise<void> | void
  syncRequested?: (event: DurableOutboxEvent, projection: WorkerProjection, signal?: AbortSignal) => Promise<unknown>
  scanRequested?: (event: DurableOutboxEvent, projection: WorkerProjection, signal?: AbortSignal) => Promise<unknown>
  /** Runs a tenant-scoped SLA scan through the API/persistence boundary. */
  slaScanRequested?: (event: DurableOutboxEvent, projection: WorkerProjection, signal?: AbortSignal) => Promise<unknown>
  imageContinuationRequested?: (event: DurableOutboxEvent, projection: WorkerProjection, signal?: AbortSignal) => Promise<unknown>
  /** Required at the production side-effect boundary. The default denies all
   * critical execution until an authoritative live recheck port is wired. */
  executionAuthorization?: WorkerExecutionAuthorizationGuard
  /** Required for every merchant business side effect. Pure system
   * projections intentionally bypass this gate. */
  commercialAccess?: WorkerCommercialAccessGuard
}

export function createWorkerProjection(): WorkerProjection {
  return { snapshots: new Map(), tasks: new Map() }
}

/**
 * The production-safe default handler deliberately has no publish side effect.
 * A publish event without an injected, platform-specific connector is an
 * unknown outcome and must remain visible for human reconciliation.
 */
export function createOutboxHandler(options: WorkerHandlerOptions = {}): DurableOutboxHandler<DurableOutboxEvent, unknown> {
  const projection = options.projection ?? createWorkerProjection()
  const executionAuthorization = options.executionAuthorization ?? createUnavailableExecutionAuthorizationGuard()
  const commercialAccess = options.commercialAccess ?? createUnavailableCommercialAccessGuard()
  const commercialize = async (event: DurableOutboxEvent, operation: CriticalWorkerOperation, signal?: AbortSignal) => {
    try {
      return await commercialAccess.assertCommercialAccess(event, operation, signal)
    } catch (error) {
      const snapshot = (() => {
        try { return parseWorkerCommercialAccessSnapshot(event, operation) } catch { return undefined }
      })()
      const normalized = normalizeCommercialAccessFailure(error)
      throw new WorkerFailure({
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        unknown: normalized.unknown,
        ...(snapshot ? {
          decisionId: snapshot.decisionId,
          accessRevision: snapshot.accessRevision,
          ...(snapshot.reservationId ? { reservationId: snapshot.reservationId } : {}),
          entitlementSnapshotId: snapshot.entitlementSnapshotId,
          entitlementSnapshotChecksum: snapshot.entitlementSnapshotChecksum,
          rateVersion: snapshot.rateVersion,
          eventId: event.id,
          workspaceId: event.workspaceId,
        } : { eventId: event.id, workspaceId: event.workspaceId }),
      })
    }
  }
  const authorize = async (event: DurableOutboxEvent, operation: CriticalWorkerOperation, signal?: AbortSignal) => {
    let authorization
    try {
      authorization = await executionAuthorization.assertAuthorized(event, operation, signal)
    } catch (error) {
      // Preserve the enqueue decision even when the live recheck is denied or
      // unavailable. The durable runner stores WorkerFailure.error verbatim,
      // so this keeps dead-letter/retry evidence tied to the exact event.
      const snapshot = (() => {
        try { return parseWorkerAuthorizationSnapshot(event, operation) } catch { return undefined }
      })()
      const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown; unknown?: unknown }
      throw new WorkerFailure({
        code: typeof candidate.code === 'string' ? candidate.code : 'AUTHZ_EXECUTION_RECHECK_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'worker execution authorization failed',
        retryable: candidate.retryable === true,
        unknown: candidate.unknown === true,
        ...(snapshot ? { decisionId: snapshot.decisionId, eventId: event.id, workspaceId: event.workspaceId, ...(snapshot.traceId ? { traceId: snapshot.traceId } : {}) } : { eventId: event.id, workspaceId: event.workspaceId }),
      })
    }
    await commercialize(event, operation, signal)
    return authorization
  }
  return async ({ event, signal }) => {
    throwIfLeaseLost(signal)
    if (!isObject(event.payload)) {
      throw unknownFailure('MALFORMED_EVENT', `Event ${event.id} payload must be an object`)
    }

    if (event.eventType === 'state.snapshot') {
      const entity = event.payload.entity
      const entityType = event.payload.entityType
      const entityId = isObject(entity) ? entity.id : undefined
      const entityWorkspaceId = isObject(entity) ? entity.workspaceId : undefined
      if (!isObject(entity)
        || typeof entityType !== 'string' || !entityType.trim()
        || typeof entityId !== 'string' || !entityId.trim() || entityId !== event.aggregateId
        || typeof entityWorkspaceId !== 'string' || !entityWorkspaceId.trim() || entityWorkspaceId !== event.workspaceId) {
        throw unknownFailure('MALFORMED_STATE_SNAPSHOT', `Event ${event.id} is not a valid state snapshot`)
      }
      const previous = projection.snapshots.get(event.aggregateId)
      if (!previous || previous.sequence <= event.sequence) {
        projection.snapshots.set(event.aggregateId, { sequence: event.sequence, payload: event.payload })
      }
      await options.onStateSnapshot?.(event, projection, signal)
      throwIfLeaseLost(signal)
      return { value: { handled: event.eventType, aggregateId: event.aggregateId } }
    }

    if (event.eventType === 'task.created') {
      const taskId = typeof event.payload.id === 'string' ? event.payload.id : undefined
      const payloadWorkspaceId = typeof event.payload.workspaceId === 'string'
        ? event.payload.workspaceId
        : typeof event.payload.workspace_id === 'string' ? event.payload.workspace_id : undefined
      const snakeWorkspaceId = typeof event.payload.workspace_id === 'string' ? event.payload.workspace_id : undefined
      if (!taskId || taskId !== event.aggregateId || !payloadWorkspaceId || payloadWorkspaceId !== event.workspaceId
        || (snakeWorkspaceId !== undefined && snakeWorkspaceId !== event.workspaceId)) {
        throw unknownFailure('MALFORMED_TASK_CREATED', `Event ${event.id} is not scoped to its task and workspace`)
      }
      projection.tasks.set(taskId, event.payload)
      await options.onTaskCreated?.(event, projection, signal)
      throwIfLeaseLost(signal)
      return { value: { handled: event.eventType, taskId } }
    }

    if (event.eventType === 'generation.requested' && options.generationRequested) {
      await authorize(event, 'generation.execute', signal)
      try {
        const content = await options.generationRequested(event, projection, signal)
        throwIfLeaseLost(signal)
        await options.onGenerationResult?.(event, { content }, projection, signal)
        throwIfLeaseLost(signal)
        return { value: content }
      } catch (error) {
        throwIfLeaseLost(signal)
        // Quota exhaustion is backpressure, not a terminal generation failure.
        // Leave the outbox event retryable so the user-facing job remains
        // queued while the provider's window resets.
        if (error instanceof QuotaExceededError) {
          await options.onGenerationDeferred?.(event, { code: error.code, message: error.message, retryAfterSeconds: error.decision.retryAfterSeconds }, projection, signal)
          throw new WorkerFailure({ code: error.code, message: error.message, retryable: true, unknown: false })
        }
        const candidateCode = (error as { code?: unknown })?.code
        const failure = {
          code: typeof candidateCode === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(candidateCode) ? candidateCode : 'AI_GENERATION_FAILED',
          message: error instanceof Error ? error.message : 'content generation failed',
        }
        if (failure.code === 'GENERATION_JOB_TERMINAL') {
          throw new WorkerFailure({ code: failure.code, message: failure.message, retryable: false, unknown: false })
        }
        await options.onGenerationResult?.(event, { error: failure }, projection, signal)
        // The user-facing generation job is now terminal. Retrying this
        // external model event would charge the same logical action again
        // while the job can no longer accept a result.
        throw new WorkerFailure({ code: failure.code, message: failure.message, retryable: false, unknown: false })
      }
    }

    if (event.eventType === 'image.generation.requested' && options.imageGenerationRequested) {
      await authorize(event, 'image_generation.execute', signal)
      try {
        const result = await options.imageGenerationRequested(event, projection, signal)
        throwIfLeaseLost(signal)
        return { value: result }
      } catch (error) {
        throwIfLeaseLost(signal)
        const candidate = error as { code?: unknown; retryable?: unknown; unknown?: unknown }
        throw new WorkerFailure({
          code: typeof candidate.code === 'string' ? candidate.code : 'IMAGE_GENERATION_EXECUTION_FAILED',
          message: error instanceof Error ? error.message : 'image generation failed',
          retryable: candidate.retryable === true,
          unknown: candidate.unknown !== false,
        })
      }
    }

    if (event.eventType === 'sync.requested' && options.syncRequested) {
      await authorize(event, 'catalog.sync.execute', signal)
      try {
        const result = await options.syncRequested(event, projection, signal)
        throwIfLeaseLost(signal)
        return { value: result }
      } catch (error) {
        throwIfLeaseLost(signal)
        const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown; unknown?: unknown }
        throw new WorkerFailure({
          code: typeof candidate.code === 'string' ? candidate.code : 'SYNC_EXECUTION_FAILED',
          message: error instanceof Error ? error.message : 'catalog sync failed',
          retryable: candidate.retryable === true,
          unknown: candidate.unknown === true,
        })
      }
    }

    if (['asset.uploaded', 'asset.generated_quarantined', 'asset.video_quarantined', 'asset.scan_redrive_requested'].includes(event.eventType) && options.scanRequested) {
      try {
        if (event.eventType === 'asset.scan_redrive_requested') await authorize(event, 'asset.scan.execute', signal)
        else await commercialize(event, 'asset.scan.execute', signal)
        const result = await options.scanRequested(event, projection, signal)
        throwIfLeaseLost(signal)
        return { value: result }
      } catch (error) {
        throwIfLeaseLost(signal)
        if (error instanceof WorkerFailure) throw error
        const candidate = error as { code?: unknown; retryable?: unknown }
        throw new WorkerFailure({ code: typeof candidate.code === 'string' ? candidate.code : 'ASSET_SCAN_EXECUTION_FAILED', message: error instanceof Error ? error.message : 'asset scan failed', retryable: candidate.retryable !== false, unknown: false })
      }
    }

    if (event.eventType === 'support.sla.scan_requested' && options.slaScanRequested) {
      try {
        const result = await options.slaScanRequested(event, projection, signal)
        throwIfLeaseLost(signal)
        return { value: result }
      } catch (error) {
        throwIfLeaseLost(signal)
        const candidate = error as { code?: unknown; retryable?: unknown; unknown?: unknown }
        throw new WorkerFailure({ code: typeof candidate.code === 'string' ? candidate.code : 'SUPPORT_SLA_SCAN_FAILED', message: error instanceof Error ? error.message : 'support SLA scan failed', retryable: candidate.retryable !== false, unknown: candidate.unknown === true })
      }
    }

    if (event.eventType === 'asset.generation_continuations.ready' && options.imageContinuationRequested) {
      await authorize(event, 'asset.continuation.execute', signal)
      try {
        const result = await options.imageContinuationRequested(event, projection, signal)
        throwIfLeaseLost(signal)
        return { value: result }
      } catch (error) {
        throwIfLeaseLost(signal)
        const candidate = error as { code?: unknown; retryable?: unknown }
        throw new WorkerFailure({ code: typeof candidate.code === 'string' ? candidate.code : 'IMAGE_CONTINUATION_EXECUTION_FAILED', message: error instanceof Error ? error.message : 'image continuation failed', retryable: candidate.retryable !== false, unknown: false })
      }
    }

    if (event.eventType === 'asset.generation_continuation.waiting_scan' || event.eventType === 'asset.generation_continuation.awaiting_rights' || event.eventType === 'asset.generation_continuations.awaiting_confirmation') {
      return { value: { handled: event.eventType, aggregateId: event.aggregateId } }
    }

    if ((event.eventType === 'publish.requested' && options.publishRequested) || (event.eventType === 'publish.reconcile_requested' && options.reconcileRequested)) {
      await authorize(event, event.eventType === 'publish.requested' ? 'publish.execute' : 'publish.reconcile', signal)
      let executionCompleted = false
      try {
        const executor = event.eventType === 'publish.requested' ? options.publishRequested! : options.reconcileRequested!
        const observation = await executor(event, projection, signal)
        executionCompleted = true
        throwIfLeaseLost(signal)
        await options.onPublishObservation?.(event, observation, projection, signal)
        throwIfLeaseLost(signal)
        const report = buildPublishObservationRequest(observation, { source: event.eventType === 'publish.reconcile_requested' ? 'reconcile' : 'publish' })
        if (!report.status.found || report.status.state === 'unknown') return { state: 'unknown' as const, value: observation }
        return { value: observation }
      } catch (error) {
        throwIfLeaseLost(signal)
        // A committed connector result followed by a failed API write must be
        // retried as delivery failure. Do not emit a synthetic unknown
        // observation that could downgrade a real submitted/published result.
        if (executionCompleted) {
          const reportError = error instanceof PublishObservationReportError ? error : undefined
          throw new WorkerFailure({ code: 'OBSERVATION_REPORT_FAILED', message: error instanceof Error ? error.message : 'publish observation reporting failed', retryable: reportError?.retryable ?? true, unknown: false })
        }
        if (error instanceof QuotaExceededError) {
          throw new WorkerFailure({ code: error.code, message: error.message, retryable: true, unknown: false })
        }
        const candidate = error as { normalized?: { code?: string; message?: string; retryable?: boolean; unknown?: boolean } }
        const normalized = candidate.normalized ?? { code: 'PUBLISH_EXECUTION_FAILED', message: error instanceof Error ? error.message : 'publish execution failed', retryable: false, unknown: true }
        // A connector/auth/lock rejection that happened before the external
        // call is known, not an unknown remote outcome. Keep it retryable or
        // terminal according to its normalized contract without emitting a
        // misleading remote observation.
        if (candidate.normalized && candidate.normalized.unknown === false) {
          throw new WorkerFailure({ code: normalized.code ?? 'PUBLISH_EXECUTION_FAILED', message: normalized.message ?? 'publish execution failed', retryable: normalized.retryable ?? false, unknown: false })
        }
        // Connector failures are still business-visible unknown outcomes. If
        // reporting is configured, persist that observation before the durable
        // outbox row is marked unknown.
        if (options.onPublishObservation) {
          await options.onPublishObservation(event, { remoteStatus: { found: false, state: 'unknown', simulated: false } }, projection, signal)
        }
        throw new WorkerFailure({ code: normalized.code ?? 'PUBLISH_EXECUTION_FAILED', message: normalized.message ?? 'publish execution failed', retryable: normalized.retryable ?? false, unknown: normalized.unknown ?? true })
      }
    }

    if (event.eventType === 'publish.requested') {
      throw unknownFailure(
        'CONNECTOR_HANDLER_UNAVAILABLE',
        `Publish event ${event.id} is awaiting a real platform connector; moved to manual reconciliation`,
      )
    }

    if (event.eventType === 'sync.requested') throw unknownFailure('SYNC_HANDLER_UNAVAILABLE', `Sync event ${event.id} requires a sync worker`)

    throw unknownFailure('UNSUPPORTED_EVENT_TYPE', `Event type ${event.eventType} requires manual handling`)
  }
}

function throwIfLeaseLost(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw new WorkerFailure({ code: 'OUTBOX_LEASE_LOST', message: 'outbox lease lost; external operation aborted', retryable: false, unknown: true })
}

function unknownFailure(code: string, message: string): WorkerFailure {
  return new WorkerFailure({ code, message, retryable: false, unknown: true })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
