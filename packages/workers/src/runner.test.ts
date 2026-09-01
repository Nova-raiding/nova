import { describe, expect, it } from 'vitest'
import { InMemoryJobRunner, normalizeWorkerError } from './runner.js'

describe('worker runner reliability boundaries', () => {
  it('rejects invalid retry configuration and enqueue identity before state changes', () => {
    expect(() => new InMemoryJobRunner('sync', async () => undefined, { baseDelayMs: Number.NaN })).toThrow('WORKER_RETRY_BASE_DELAY_INVALID')
    const runner = new InMemoryJobRunner('sync', async () => undefined)
    expect(() => runner.enqueue({ workspaceId: ' ', idempotencyKey: 'idem', payload: undefined })).toThrow('WORKER_WORKSPACE_REQUIRED')
    expect(() => runner.enqueue({ workspaceId: 'ws\n1', idempotencyKey: 'idem', payload: undefined })).toThrow('WORKER_WORKSPACE_INVALID')
    expect(() => runner.enqueue({ workspaceId: 'w'.repeat(257), idempotencyKey: 'idem', payload: undefined })).toThrow('WORKER_WORKSPACE_INVALID')
    expect(() => runner.enqueue({ workspaceId: 'ws_1', idempotencyKey: '', payload: undefined })).toThrow('WORKER_IDEMPOTENCY_KEY_REQUIRED')
    expect(() => runner.enqueue({ workspaceId: 'ws_1', idempotencyKey: 'idem\u0000key', payload: undefined })).toThrow('WORKER_IDEMPOTENCY_KEY_INVALID')
    expect(() => runner.enqueue({ workspaceId: 'ws_1', idempotencyKey: 'i'.repeat(257), payload: undefined })).toThrow('WORKER_IDEMPOTENCY_KEY_INVALID')
    expect(() => runner.enqueue({ workspaceId: 'ws_1', idempotencyKey: 'idem', payload: undefined, maxAttempts: 1.5 })).toThrow('WORKER_MAX_ATTEMPTS_INVALID')
    expect(runner.jobs.size).toBe(0)
  })

  it('keeps idempotency tenant-scoped and preserves bounded error evidence', async () => {
    const runner = new InMemoryJobRunner('sync', async () => { throw { code: 'bad code', message: 'line\nitem\u0000', retryable: 'yes', unknown: 1 } })
    const first = runner.enqueue({ workspaceId: 'ws_a', idempotencyKey: 'same', payload: undefined })
    const second = runner.enqueue({ workspaceId: 'ws_b', idempotencyKey: 'same', payload: undefined })
    expect(second.id).not.toBe(first.id)
    await runner.runNext()
    expect(first.lastError).toEqual({ code: 'WORKER_ERROR', message: 'line item ', retryable: false, unknown: false })
  })

  it('normalizes primitive and oversized error values safely', () => {
    expect(normalizeWorkerError('failure')).toEqual({ code: 'WORKER_ERROR', message: 'Worker execution failed', retryable: false, unknown: false })
    expect(normalizeWorkerError({ code: 'SAFE', message: 'x'.repeat(2_100), retryable: true, unknown: false })).toMatchObject({ code: 'SAFE', retryable: true, unknown: false, message: 'x'.repeat(2_000) })
  })
})
