import { randomUUID } from 'node:crypto'
import type { HandlerResult, RunnerOptions, WorkerError, WorkerHandler, WorkerJob, WorkerKind } from './types.js'

export class WorkerFailure extends Error {
  constructor(readonly error: WorkerError) { super(error.message) }
}

export class InMemoryJobRunner<T, R> {
  readonly jobs = new Map<string, WorkerJob<T>>()
  private readonly idempotency = new Map<string, string>()
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly clock: () => number
  private readonly idFactory: () => string

  constructor(readonly kind: WorkerKind, private readonly handler: WorkerHandler<T, R>, options: RunnerOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? 100
    this.maxDelayMs = options.maxDelayMs ?? 30_000
    if (!Number.isSafeInteger(this.baseDelayMs) || this.baseDelayMs < 0 || this.baseDelayMs > 86_400_000) throw new Error('WORKER_RETRY_BASE_DELAY_INVALID')
    if (!Number.isSafeInteger(this.maxDelayMs) || this.maxDelayMs < 0 || this.maxDelayMs > 86_400_000) throw new Error('WORKER_RETRY_MAX_DELAY_INVALID')
    if (this.maxDelayMs < this.baseDelayMs) throw new Error('WORKER_RETRY_DELAY_ORDER_INVALID')
    this.clock = options.now ?? (() => Date.now())
    this.idFactory = options.idFactory ?? (() => randomUUID())
  }

  enqueue(input: { workspaceId: string; idempotencyKey: string; payload: T; maxAttempts?: number }): WorkerJob<T> {
    if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) throw new Error('WORKER_WORKSPACE_REQUIRED')
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) throw new Error('WORKER_IDEMPOTENCY_KEY_REQUIRED')
    if (input.maxAttempts !== undefined && (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 100)) throw new Error('WORKER_MAX_ATTEMPTS_INVALID')
    // Idempotency is tenant-scoped. A merchant-supplied key may legitimately
    // be reused in another workspace and must never return that workspace's job.
    const scopedKey = `${input.workspaceId.length}:${input.workspaceId}:${input.idempotencyKey}`
    const existingId = this.idempotency.get(scopedKey)
    if (existingId) return this.jobs.get(existingId)!
    const job: WorkerJob<T> = { id: `job_${this.idFactory()}`, kind: this.kind, workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey, payload: input.payload, attempt: 0, maxAttempts: input.maxAttempts ?? 5, state: 'queued', notBefore: this.clock(), createdAt: this.clock() }
    this.jobs.set(job.id, job)
    this.idempotency.set(scopedKey, job.id)
    return job
  }

  async runNext(): Promise<WorkerJob<T> | undefined> {
    const job = [...this.jobs.values()].find(candidate => candidate.state === 'queued' && candidate.notBefore <= this.clock())
    if (!job) return undefined
    job.state = 'running'
    job.attempt += 1
    try {
      const result = await this.handler({ job, now: this.clock(), attempt: job.attempt })
      const normalized: HandlerResult<R> = result && typeof result === 'object' && ('state' in result || 'value' in result) ? result as HandlerResult<R> : { value: result as R }
      job.result = normalized.value
      job.state = normalized.state ?? 'succeeded'
      return job
    } catch (cause) {
      const error = normalizeWorkerError(cause)
      job.lastError = error
      if (error.unknown) {
        job.state = 'unknown'
      } else if (error.retryable && job.attempt < job.maxAttempts) {
        job.state = 'queued'
        job.notBefore = this.clock() + Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (job.attempt - 1))
      } else {
        job.state = job.attempt >= job.maxAttempts && error.retryable ? 'dead_letter' : 'failed'
      }
      return job
    }
  }

  async runUntilIdle(limit = 100): Promise<WorkerJob<T>[]> {
    const completed: WorkerJob<T>[] = []
    for (let index = 0; index < limit; index += 1) {
      const job = await this.runNext()
      if (!job) break
      completed.push(job)
    }
    return completed
  }

  retryUnknown(jobId: string, proof: { remoteAbsent: boolean; safeToRetry: boolean }) {
    const job = this.must(jobId)
    if (job.state !== 'unknown') throw new Error('Only unknown jobs can be reconciled')
    if (!proof.remoteAbsent || !proof.safeToRetry) throw new Error('Unknown job requires remote absence and connector safe-retry proof')
    job.state = 'queued'
    job.notBefore = this.clock()
    return job
  }

  private must(id: string) { const job = this.jobs.get(id); if (!job) throw new Error(`Job ${id} not found`); return job }
}

export function normalizeWorkerError(cause: unknown): WorkerError {
  if (cause instanceof WorkerFailure) return cause.error
  const candidate = cause && typeof cause === 'object' ? cause as Partial<WorkerError> : undefined
  const code = typeof candidate?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(candidate.code) ? candidate.code : 'WORKER_ERROR'
  const rawMessage = typeof candidate?.message === 'string' && candidate.message.trim() ? candidate.message : 'Worker execution failed'
  return { code, message: rawMessage.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 2_000), retryable: candidate?.retryable === true, unknown: candidate?.unknown === true }
}
