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

  it('keeps retryable work queued with bounded exponential backoff, then dead-letters at the attempt limit', async () => {
    let now = 10_000
    const runner = new InMemoryJobRunner('sync', async () => {
      throw { code: 'TEMPORARY_PROVIDER_FAILURE', message: 'try again', retryable: true, unknown: false }
    }, { now: () => now, baseDelayMs: 100, maxDelayMs: 250, idFactory: () => 'retry' })
    const job = runner.enqueue({ workspaceId: 'ws_retry', idempotencyKey: 'idem-retry', payload: { input: 'same' }, maxAttempts: 3 })

    await expect(runner.runNext()).resolves.toMatchObject({ id: job.id, state: 'queued', attempt: 1, notBefore: 10_100 })
    now = 10_099
    await expect(runner.runNext()).resolves.toBeUndefined()
    now = 10_100
    await expect(runner.runNext()).resolves.toMatchObject({ state: 'queued', attempt: 2, notBefore: 10_300 })
    now = 10_300
    await expect(runner.runNext()).resolves.toMatchObject({ state: 'dead_letter', attempt: 3, lastError: expect.objectContaining({ retryable: true }) })
    expect((await runner.runNext())).toBeUndefined()
  })

  it('keeps unknown work terminal until reconciliation proves a safe retry', async () => {
    let calls = 0
    const runner = new InMemoryJobRunner('publish', async () => {
      calls += 1
      throw { code: 'REMOTE_OUTCOME_UNKNOWN', message: 'provider response lost', retryable: false, unknown: true }
    }, { idFactory: () => 'unknown' })
    const job = runner.enqueue({ workspaceId: 'ws_unknown', idempotencyKey: 'idem-unknown', payload: { remote: 'x' } })
    await expect(runner.runNext()).resolves.toMatchObject({ state: 'unknown', attempt: 1 })
    expect(calls).toBe(1)
    expect(() => runner.retryUnknown(job.id, { remoteAbsent: false, safeToRetry: true })).toThrow('Unknown job requires')
    expect(() => runner.retryUnknown(job.id, { remoteAbsent: true, safeToRetry: false })).toThrow('Unknown job requires')
    expect(runner.retryUnknown(job.id, { remoteAbsent: true, safeToRetry: true })).toMatchObject({ state: 'queued', attempt: 1 })
    await expect(runner.runNext()).resolves.toMatchObject({ state: 'unknown', attempt: 2 })
    expect(calls).toBe(2)
  })

  it('does not execute the same queued job twice when runNext is called concurrently', async () => {
    let release!: () => void
    const entered = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const runner = new InMemoryJobRunner('sync', async () => {
      calls += 1
      await entered
      return { value: 'done' }
    }, { idFactory: () => 'concurrent' })
    const job = runner.enqueue({ workspaceId: 'ws_concurrent', idempotencyKey: 'idem-concurrent', payload: {} })
    const first = runner.runNext()
    const second = runner.runNext()
    await Promise.resolve()
    expect(await Promise.race([second, Promise.resolve(undefined)])).toBeUndefined()
    release()
    await expect(first).resolves.toMatchObject({ id: job.id, state: 'succeeded', attempt: 1 })
    expect(calls).toBe(1)
  })
})
