export type WorkerKind = 'sync' | 'generation' | 'publish' | 'reconcile'
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'dead_letter'

export interface WorkerJob<T = unknown> {
  id: string
  kind: WorkerKind
  workspaceId: string
  idempotencyKey: string
  payload: T
  attempt: number
  maxAttempts: number
  state: JobState
  notBefore: number
  createdAt: number
  /** Handler result is retained for business-state projection; outbox ack is separate. */
  result?: unknown
  lastError?: WorkerError
}

export interface WorkerError {
  code: string
  message: string
  retryable: boolean
  unknown?: boolean
}

export interface HandlerResult<T = unknown> {
  value?: T
  state?: 'succeeded' | 'unknown'
}

export interface WorkerContext<T = unknown> {
  job: WorkerJob<T>
  now: number
  attempt: number
}

export type WorkerHandler<T, R> = (context: WorkerContext<T>) => Promise<HandlerResult<R> | R>

export interface RunnerOptions {
  baseDelayMs?: number
  maxDelayMs?: number
  now?: () => number
  idFactory?: () => string
}
