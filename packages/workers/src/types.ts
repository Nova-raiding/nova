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
  /** Correlation retained when an authorization gate blocks queued work. */
  decisionId?: string
  /** Original principal and policy evidence for manual reconciliation. */
  actorId?: string
  identityId?: string
  capability?: string
  policyVersion?: string
  requestId?: string
  /** Commercial evidence retained when the point/access gate blocks I/O. */
  accessRevision?: string
  reservationId?: string
  entitlementSnapshotId?: string
  entitlementSnapshotChecksum?: string
  rateVersion?: string | null
  eventId?: string
  workspaceId?: string
  traceId?: string
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
