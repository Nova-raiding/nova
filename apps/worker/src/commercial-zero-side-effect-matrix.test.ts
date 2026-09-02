import { describe, expect, it, vi } from 'vitest'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import { WorkerCommercialAccessError } from '../../../packages/workers/src/commercial-access.js'
import type { CriticalWorkerOperation } from '../../../packages/workers/src/execution-authorization.js'
import { createOutboxHandler } from './handler.js'
import type { WorkerHandlerOptions } from './handler.js'

const operations = [
  { operation: 'generation.execute', eventType: 'generation.requested', callback: 'generationRequested' },
  { operation: 'image_generation.execute', eventType: 'image.generation.requested', callback: 'imageGenerationRequested' },
  { operation: 'catalog.sync.execute', eventType: 'sync.requested', callback: 'syncRequested' },
  { operation: 'asset.scan.execute', eventType: 'asset.uploaded', callback: 'scanRequested' },
  { operation: 'asset.continuation.execute', eventType: 'asset.generation_continuations.ready', callback: 'imageContinuationRequested' },
  { operation: 'publish.execute', eventType: 'publish.requested', callback: 'publishRequested' },
  { operation: 'publish.reconcile', eventType: 'publish.reconcile_requested', callback: 'reconcileRequested' },
] as const satisfies readonly { operation: CriticalWorkerOperation; eventType: string; callback: string }[]

function event(operation: CriticalWorkerOperation, eventType: string): DurableOutboxEvent {
  return {
    id: `evt_${operation.replaceAll('.', '_')}`,
    workspaceId: 'ws_worker_matrix',
    aggregateId: `aggregate_${operation.replaceAll('.', '_')}`,
    eventType,
    sequence: 1,
    createdAt: '2026-09-02T00:00:00.000Z',
    payload: {
      commercial_access_snapshot: {
        schema_version: 1,
        decision_id: `decision_${operation}`,
        workspace_id: 'ws_worker_matrix',
        operation,
        access_mode: 'POINT_REQUIRED_NO_CHARGE',
        access_revision: '7',
        balance_state: 'known',
        entitlement_snapshot_id: 'entitlement-worker-matrix',
        entitlement_snapshot_checksum: 'a'.repeat(64),
        rate_version: null,
        quoted_points: 0,
        decided_at: '2026-09-02T00:00:00.000Z',
      },
    },
  }
}

describe('worker commercial zero-side-effect matrix', () => {
  it.each([
    ['zero', 'COMMERCIAL_EXECUTION_DENIED', false],
    ['unknown', 'COMMERCIAL_EXECUTION_BALANCE_BLOCKED', false],
    ['insufficient', 'COMMERCIAL_EXECUTION_RESERVATION_INVALID', false],
  ])('blocks all seven worker operations at %s before provider, connector, scanner, storage, persistence, or completion callbacks', async (_state, code, retryable) => {
    const external = Object.fromEntries(operations.map(item => [item.callback, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>
    const generationRequested = external.generationRequested as unknown as NonNullable<WorkerHandlerOptions['generationRequested']>
    const imageGenerationRequested = external.imageGenerationRequested as unknown as NonNullable<WorkerHandlerOptions['imageGenerationRequested']>
    const syncRequested = external.syncRequested as unknown as NonNullable<WorkerHandlerOptions['syncRequested']>
    const scanRequested = external.scanRequested as unknown as NonNullable<WorkerHandlerOptions['scanRequested']>
    const imageContinuationRequested = external.imageContinuationRequested as unknown as NonNullable<WorkerHandlerOptions['imageContinuationRequested']>
    const publishRequested = external.publishRequested as unknown as NonNullable<WorkerHandlerOptions['publishRequested']>
    const reconcileRequested = external.reconcileRequested as unknown as NonNullable<WorkerHandlerOptions['reconcileRequested']>
    const persistenceMutation = vi.fn()
    const outboxCompletion = vi.fn()
    const queueFollowUp = vi.fn()
    const commercialAccess = {
      assertCommercialAccess: vi.fn(async () => {
        throw new WorkerCommercialAccessError(code, `blocked by ${code}`, retryable)
      }),
    }
    const handler = createOutboxHandler({
      executionAuthorization: { assertAuthorized: vi.fn(async () => ({} as never)) },
      commercialAccess,
      generationRequested,
      imageGenerationRequested,
      syncRequested,
      scanRequested,
      imageContinuationRequested,
      publishRequested,
      reconcileRequested,
      onGenerationResult: persistenceMutation,
      onGenerationDeferred: queueFollowUp,
      onPublishObservation: outboxCompletion,
    })

    for (const item of operations) {
      await expect(handler({ event: event(item.operation, item.eventType), attempt: 1, now: Date.parse('2026-09-02T00:00:01.000Z') }))
        .rejects.toMatchObject({ error: { code, retryable, unknown: false } })
    }

    expect(commercialAccess.assertCommercialAccess).toHaveBeenCalledTimes(operations.length)
    for (const callback of Object.values(external)) expect(callback).not.toHaveBeenCalled()
    expect(persistenceMutation).not.toHaveBeenCalled()
    expect(outboxCompletion).not.toHaveBeenCalled()
    expect(queueFollowUp).not.toHaveBeenCalled()
  })
})
