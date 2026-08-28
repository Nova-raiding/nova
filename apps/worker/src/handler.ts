import { WorkerFailure } from '../../../packages/workers/src/runner.js'
import type { DurableOutboxEvent, DurableOutboxHandler } from '../../../packages/workers/src/durable.js'
import type { PublishHandlerResult } from '../../../packages/workers/src/publish-adapter.js'
import { buildPublishObservationRequest, PublishObservationReportError } from '../../../packages/workers/src/publish-observation.js'
import type { GeneratedContent } from '../../../packages/ai/src/generator.js'
import { QuotaExceededError } from '../../../packages/quotas/src/admission.js'

export interface WorkerProjection {
  snapshots: Map<string, { sequence: number; payload: Record<string, unknown> }>
  tasks: Map<string, Record<string, unknown>>
}

export interface WorkerHandlerOptions {
  projection?: WorkerProjection
  onStateSnapshot?: (event: DurableOutboxEvent, projection: WorkerProjection) => Promise<void> | void
  onTaskCreated?: (event: DurableOutboxEvent, projection: WorkerProjection) => Promise<void> | void
  publishRequested?: (event: DurableOutboxEvent, projection: WorkerProjection) => Promise<PublishHandlerResult>
  reconcileRequested?: (event: DurableOutboxEvent, projection: WorkerProjection) => Promise<PublishHandlerResult>
  generationRequested?: (event: DurableOutboxEvent, projection: WorkerProjection) => Promise<GeneratedContent>
  onGenerationResult?: (event: DurableOutboxEvent, result: { content?: GeneratedContent; error?: { code: string; message: string } }, projection: WorkerProjection) => Promise<void> | void
  onGenerationDeferred?: (event: DurableOutboxEvent, error: { code: string; message: string; retryAfterSeconds: number }, projection: WorkerProjection) => Promise<void> | void
  onPublishObservation?: (event: DurableOutboxEvent, observation: PublishHandlerResult, projection: WorkerProjection) => Promise<void> | void
  syncRequested?: (event: DurableOutboxEvent, projection: WorkerProjection) => Promise<unknown>
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
  return async ({ event }) => {
    if (!isObject(event.payload)) {
      throw unknownFailure('MALFORMED_EVENT', `Event ${event.id} payload must be an object`)
    }

    if (event.eventType === 'state.snapshot') {
      const entity = event.payload.entity
      const entityType = event.payload.entityType
      if (!isObject(entity) || typeof entityType !== 'string') {
        throw unknownFailure('MALFORMED_STATE_SNAPSHOT', `Event ${event.id} is not a valid state snapshot`)
      }
      const previous = projection.snapshots.get(event.aggregateId)
      if (!previous || previous.sequence <= event.sequence) {
        projection.snapshots.set(event.aggregateId, { sequence: event.sequence, payload: event.payload })
      }
      await options.onStateSnapshot?.(event, projection)
      return { value: { handled: event.eventType, aggregateId: event.aggregateId } }
    }

    if (event.eventType === 'task.created') {
      const taskId = typeof event.payload.id === 'string' ? event.payload.id : event.aggregateId
      if (!taskId) throw unknownFailure('MALFORMED_TASK_CREATED', `Event ${event.id} has no task id`)
      projection.tasks.set(taskId, event.payload)
      await options.onTaskCreated?.(event, projection)
      return { value: { handled: event.eventType, taskId } }
    }

    if (event.eventType === 'generation.requested' && options.generationRequested) {
      try {
        const content = await options.generationRequested(event, projection)
        await options.onGenerationResult?.(event, { content }, projection)
        return { value: content }
      } catch (error) {
        // Quota exhaustion is backpressure, not a terminal generation failure.
        // Leave the outbox event retryable so the user-facing job remains
        // queued while the provider's window resets.
        if (error instanceof QuotaExceededError) {
          await options.onGenerationDeferred?.(event, { code: error.code, message: error.message, retryAfterSeconds: error.decision.retryAfterSeconds }, projection)
          throw new WorkerFailure({ code: error.code, message: error.message, retryable: true, unknown: false })
        }
        const failure = { code: 'AI_GENERATION_FAILED', message: error instanceof Error ? error.message : 'content generation failed' }
        await options.onGenerationResult?.(event, { error: failure }, projection)
        throw new WorkerFailure({ code: failure.code, message: failure.message, retryable: true, unknown: false })
      }
    }

    if (event.eventType === 'sync.requested' && options.syncRequested) {
      try {
        return { value: await options.syncRequested(event, projection) }
      } catch (error) {
        throw new WorkerFailure({ code: 'SYNC_EXECUTION_FAILED', message: error instanceof Error ? error.message : 'catalog sync failed', retryable: true, unknown: false })
      }
    }

    if ((event.eventType === 'publish.requested' && options.publishRequested) || (event.eventType === 'publish.reconcile_requested' && options.reconcileRequested)) {
      let executionCompleted = false
      try {
        const executor = event.eventType === 'publish.requested' ? options.publishRequested! : options.reconcileRequested!
        const observation = await executor(event, projection)
        executionCompleted = true
        await options.onPublishObservation?.(event, observation, projection)
        const report = buildPublishObservationRequest(observation, { source: event.eventType === 'publish.reconcile_requested' ? 'reconcile' : 'publish' })
        if (!report.status.found || report.status.state === 'unknown') return { state: 'unknown' as const, value: observation }
        return { value: observation }
      } catch (error) {
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
          await options.onPublishObservation(event, { remoteStatus: { found: false, state: 'unknown', simulated: false } }, projection)
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

function unknownFailure(code: string, message: string): WorkerFailure {
  return new WorkerFailure({ code, message, retryable: false, unknown: true })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
