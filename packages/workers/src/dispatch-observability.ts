import type { DurableOutboxEvent } from './durable.js'

/**
 * Structured outbox dispatch logging for the worker process.
 *
 * The production ops runbook (`doc/todo/release/production-ops-runbook.md`)
 * requires every line to correlate `trace_id`, `request_id`, `workspace_id`,
 * `task_id`, `job_id`, `platform` and `account_id` so a failed publish can be
 * traced end to end. Before this module the worker emitted no dispatch line at
 * all: a dead letter was only visible by querying `outbox_events.last_error`,
 * which is not a log and cannot be joined with the API request stream.
 *
 * Field handling mirrors `apps/api/src/request-observability.ts` (the `safeText`
 * / `safeCode` style whitelist). Only named, bounded scalar identifiers are
 * copied: credentials, cookies, request bodies, URLs and query strings are
 * never read, so they can never reach a line.
 */

export type WorkerDispatchLogEvent =
  | 'worker.outbox.dispatch_started'
  | 'worker.outbox.succeeded'
  | 'worker.outbox.retry_scheduled'
  | 'worker.outbox.unknown'
  | 'worker.outbox.dead_letter'

export interface WorkerDispatchLogRecord {
  event: WorkerDispatchLogEvent
  timestamp: string
  workspace_id: string | null
  task_id: string | null
  job_id: string | null
  request_id: string | null
  trace_id: string | null
  platform: string | null
  account_id: string | null
  outbox_event_id: string | null
  outbox_event_type: string | null
  attempt: number | null
  error_code: string | null
  error_message: string | null
  retry_at: string | null
}

/**
 * The key order of the emitted line. Kept as an explicit array so a test (and a
 * log pipeline) can assert the shape without depending on object literal order.
 */
export const WORKER_DISPATCH_LOG_FIELDS = [
  'event',
  'timestamp',
  'workspace_id',
  'task_id',
  'job_id',
  'request_id',
  'trace_id',
  'platform',
  'account_id',
  'outbox_event_id',
  'outbox_event_type',
  'attempt',
  'error_code',
  'error_message',
  'retry_at',
] as const

export interface WorkerDispatchCorrelation {
  readonly workspaceId: string | null
  readonly requestId: string | null
  readonly traceId: string | null
  readonly taskId: string | null
  readonly jobId: string | null
  readonly platform: string | null
  readonly accountId: string | null
}

/**
 * Event types whose `aggregateId` is a durable job identity. Scan and pure
 * projection events carry an asset/product/task id there instead, so treating
 * it as `job_id` would write a wrong join key into the log stream.
 */
const JOB_IDENTITY_EVENT_TYPES = new Set([
  'sync.requested',
  'generation.requested',
  'image.generation.requested',
  'publish.requested',
  'publish.reconcile_requested',
  'asset.generation_continuations.ready',
])

const MAX_IDENTIFIER_LENGTH = 128
const MAX_ERROR_MESSAGE_LENGTH = 1_000
const CONTROL_CHARACTER = new RegExp('[\\u0000-\\u001F\\u007F]', 'u')
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001F\\u007F]', 'gu')

/**
 * The authorization snapshot is written by the API at enqueue time and carries
 * the *request* correlation ids. `event.id` (the outbox row id) and the
 * in-process `job_<uuid>` are not request identities: joining on them against
 * the API request stream silently matches nothing.
 */
export function workerDispatchCorrelation(event: DurableOutboxEvent): WorkerDispatchCorrelation {
  const payload = isRecord(event.payload) ? event.payload : {}
  const snapshot = isRecord(payload.authorization_snapshot) ? payload.authorization_snapshot : undefined
  return Object.freeze({
    workspaceId: safeIdentifier(event.workspaceId),
    requestId: safeIdentifier(snapshot?.request_id),
    traceId: safeIdentifier(snapshot?.trace_id),
    taskId: safeIdentifier(payload.task_id) ?? safeIdentifier(payload.taskId),
    jobId: safeIdentifier(payload.job_id) ?? safeIdentifier(payload.publish_job_id) ?? jobIdFromAggregate(event),
    platform: safeIdentifier(payload.platform),
    accountId: safeIdentifier(payload.account_id) ?? safeIdentifier(payload.accountId),
  })
}

/**
 * The single place the worker turns a correlation identity into a connector
 * context. `traceId` must be the request trace id; a per-process job id would
 * make the connector's own logs unjoinable with the API and worker streams.
 */
export function workerDispatchTraceId(event: DurableOutboxEvent): string | undefined {
  return workerDispatchCorrelation(event).traceId ?? undefined
}

export function buildWorkerDispatchLogRecord(input: {
  event: WorkerDispatchLogEvent
  outboxEvent?: DurableOutboxEvent
  correlation?: WorkerDispatchCorrelation
  attempt?: number
  errorCode?: string
  errorMessage?: string
  retryAt?: string
  now?: () => number
}): WorkerDispatchLogRecord {
  const correlation = input.correlation ?? (input.outboxEvent ? workerDispatchCorrelation(input.outboxEvent) : undefined)
  return Object.freeze({
    event: input.event,
    timestamp: new Date((input.now ?? (() => Date.now()))()).toISOString(),
    workspace_id: correlation?.workspaceId ?? null,
    task_id: correlation?.taskId ?? null,
    job_id: correlation?.jobId ?? null,
    request_id: correlation?.requestId ?? null,
    trace_id: correlation?.traceId ?? null,
    platform: correlation?.platform ?? null,
    account_id: correlation?.accountId ?? null,
    outbox_event_id: safeIdentifier(input.outboxEvent?.id),
    outbox_event_type: safeIdentifier(input.outboxEvent?.eventType),
    attempt: safeAttempt(input.attempt),
    error_code: safeCode(input.errorCode),
    error_message: safeErrorMessage(input.errorMessage),
    retry_at: safeTimestamp(input.retryAt),
  })
}

/**
 * Observability must never change a commercial outcome: a serializer or
 * transport failure is swallowed rather than propagated into the dispatch
 * result.
 */
export function writeWorkerDispatchLog(record: WorkerDispatchLogRecord, sink: (line: string) => void = line => console.info(line)): void {
  try {
    sink(JSON.stringify(record))
  } catch {
    // Never let a log transport failure abort a dispatch.
  }
}

function jobIdFromAggregate(event: DurableOutboxEvent): string | null {
  if (!JOB_IDENTITY_EVENT_TYPES.has(event.eventType)) return null
  return safeIdentifier(event.aggregateId)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) return null
  if (CONTROL_CHARACTER.test(normalized)) return null
  return normalized
}

function safeCode(value: unknown): string | null {
  const code = safeIdentifier(value)
  return code && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(code) ? code : null
}

/**
 * Error text is the one free-form field. Collapse control characters (log
 * injection) and bound the length; a truncated message is still joinable by
 * `error_code`.
 */
function safeErrorMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(CONTROL_CHARACTERS, ' ').trim()
  if (!normalized) return null
  return normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH)
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return Number.isFinite(Date.parse(value)) ? value : null
}

function safeAttempt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
