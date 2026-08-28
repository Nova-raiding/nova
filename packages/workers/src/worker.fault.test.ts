import { describe, expect, it, vi } from 'vitest'
import { createGenerationWorker, createPublishWorker, createReconcileWorker, createSyncWorker } from './factories.js'
import { InMemoryJobRunner, WorkerFailure } from './runner.js'

describe('in-memory worker runner', () => {
  it('deduplicates by idempotency key', () => {
    const worker = createSyncWorker(async () => ({ value: 'ok' }))
    const first = worker.enqueue({ workspaceId: 'ws', idempotencyKey: 'same', payload: { accountId: 'a' } })
    const second = worker.enqueue({ workspaceId: 'ws', idempotencyKey: 'same', payload: { accountId: 'a' } })
    expect(second.id).toBe(first.id)
    expect(worker.jobs.size).toBe(1)
  })

  it('scopes idempotency by workspace', () => {
    const worker = createSyncWorker(async () => ({ value: 'ok' }))
    const first = worker.enqueue({ workspaceId: 'ws-one', idempotencyKey: 'same', payload: { accountId: 'a' } })
    const second = worker.enqueue({ workspaceId: 'ws-two', idempotencyKey: 'same', payload: { accountId: 'b' } })
    expect(second.id).not.toBe(first.id)
    expect(second.workspaceId).toBe('ws-two')
    expect(worker.jobs.size).toBe(2)
  })

  it('backs off retryable failures and dead-letters after max attempts', async () => {
    let now = 1_000
    const handler = vi.fn(async () => { throw new WorkerFailure({ code: 'RATE_LIMITED', message: 'slow down', retryable: true }) })
    const worker = new InMemoryJobRunner('generation', handler, { now: () => now, baseDelayMs: 100, maxDelayMs: 500 })
    const job = worker.enqueue({ workspaceId: 'ws', idempotencyKey: 'retry', payload: {}, maxAttempts: 3 })
    await worker.runNext()
    expect(job.state).toBe('queued'); expect(job.notBefore).toBe(1_100)
    expect(await worker.runNext()).toBeUndefined()
    now = 1_100; await worker.runNext(); expect(job.notBefore).toBe(1_300)
    now = 1_300; await worker.runNext(); expect(job.state).toBe('dead_letter'); expect(handler).toHaveBeenCalledTimes(3)
  })

  it('preserves unknown and forbids blind retry', async () => {
    const worker = createPublishWorker(async () => { throw new WorkerFailure({ code: 'TIMEOUT', message: 'remote outcome unknown', retryable: true, unknown: true }) })
    const job = worker.enqueue({ workspaceId: 'ws', idempotencyKey: 'unknown', payload: { taskId: 't', contentVersionId: 'v', platform: 'jd', idempotencyKey: 'p' } })
    await worker.runNext(); expect(job.state).toBe('unknown')
    expect(() => worker.retryUnknown(job.id, { remoteAbsent: false, safeToRetry: true })).toThrow()
    expect(() => worker.retryUnknown(job.id, { remoteAbsent: true, safeToRetry: true })).not.toThrow()
  })

  it('supports the four isolated worker queues', async () => {
    const handlers = { sync: vi.fn(async () => ({ value: true })), generation: vi.fn(async () => ({ value: true })), publish: vi.fn(async () => ({ value: true })), reconcile: vi.fn(async () => ({ value: true })) }
    const workers = [createSyncWorker(handlers.sync), createGenerationWorker(handlers.generation), createPublishWorker(handlers.publish), createReconcileWorker(handlers.reconcile)]
    workers.forEach((worker, index) => worker.enqueue({ workspaceId: 'ws', idempotencyKey: `k-${index}`, payload: {} as never }))
    await Promise.all(workers.map(worker => worker.runUntilIdle()))
    expect(handlers.sync).toHaveBeenCalledOnce(); expect(handlers.generation).toHaveBeenCalledOnce(); expect(handlers.publish).toHaveBeenCalledOnce(); expect(handlers.reconcile).toHaveBeenCalledOnce()
  })
})
