import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

/**
 * Minimal Prometheus text-format exposition for the worker pool.
 *
 * Scope and safety contract:
 *   - Read-only. The endpoint answers exactly one path with `GET`/`HEAD`; every
 *     other method and path is rejected before any registry state is touched.
 *   - No tenant data. Every label is either a fixed enum (`role`, `queue`,
 *     `outcome`) or a sanitised, length-capped error code. Workspace ids, job
 *     ids, asset keys, provider request ids and error messages never appear.
 *   - Fail-closed in production: without `METRICS_AUTH_TOKEN` the endpoint
 *     answers 503, and a non-matching bearer answers 401 - the same contract
 *     `apps/api/src/server.ts` applies to `GET /metrics`.
 *   - Observability must never change the commercial execution outcome, so a
 *     failure to bind the listener is reported and swallowed rather than
 *     aborting the worker.
 */

export const WORKER_METRICS_PATH = '/metrics'
export const WORKER_METRICS_DEFAULT_PORT = 9102
/**
 * Loopback by default. A worker started without explicit deployment
 * configuration therefore never creates a cluster-reachable listener; the
 * Kubernetes manifest opts in to `0.0.0.0` deliberately, because a scraper
 * cannot reach another Pod's loopback interface.
 */
export const WORKER_METRICS_DEFAULT_HOST = '127.0.0.1'

/** Bounded so a hostile or buggy error code cannot explode label cardinality. */
const MAX_DISTINCT_ERROR_CODES = 16
const MAX_ERROR_CODE_LENGTH = 64
const UNKNOWN_ERROR_CODE = 'UNKNOWN'
const OVERFLOW_ERROR_CODE = 'OTHER'
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]+$/

/** Prometheus text format: `\`, `"` and newline are the only escapes. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\n/gu, '\\n')
}

function quoted(value: string): string {
  return `"${escapeLabelValue(value)}"`
}

function label(name: string, value: string): string {
  return `${name}=${quoted(value)}`
}

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Error codes originate from `serializeError`, so they are attacker-influenced
 * only in the sense that a thrown error may carry an arbitrary `code`. Anything
 * outside the conservative character set collapses to `UNKNOWN`, which keeps
 * the exposition well-formed without needing to trust the producer.
 */
export function sanitizeErrorCode(raw: string | undefined): string {
  if (!raw) return UNKNOWN_ERROR_CODE
  const candidate = raw.length > MAX_ERROR_CODE_LENGTH ? raw.slice(0, MAX_ERROR_CODE_LENGTH) : raw
  return ERROR_CODE_PATTERN.test(candidate) ? candidate : UNKNOWN_ERROR_CODE
}

export interface WorkerPollResult {
  restored: number
  processed: number
  succeeded: number
  unknown: number
  queued: number
  deadLetter: number
}

export const POLL_ITEM_OUTCOMES = ['restored', 'processed', 'succeeded', 'unknown', 'queued', 'dead_letter'] as const
export type PollItemOutcome = typeof POLL_ITEM_OUTCOMES[number]

/** Structural subset of `ScannerHeartbeat`; typed here so this module owns no dependency on the heartbeat contract. */
export interface ScannerHeartbeatObservation {
  ready: boolean
  recoveryCapable: boolean
  observedAt: string
  clamav?: { definitionsAgeSeconds?: number }
  eicar?: { ageSeconds?: number }
  callback?: { lastAcceptedAt?: string; ageSeconds?: number }
  queue?: { backlog?: number; deadLetter?: number }
  failure?: { code?: string }
}

export interface ScannerQueueObservation {
  backlog: number
  deadLetter: number
  /** Age of the oldest row satisfying the same predicate as `backlog`. */
  oldestPendingAgeSeconds?: number
}

export interface WorkerMetricsRegistryOptions {
  role: string
  /** Epoch milliseconds at process start. */
  processStartMs?: number
  now?: () => number
}

/**
 * Process-local registry. Every counter here resets when the process restarts;
 * that is inherent to in-process instrumentation and is called out in
 * `infra/observability/` rather than hidden. Restart *counting* is deliberately
 * absent - see `merchant_worker_process_start_time_seconds`.
 */
export class WorkerMetricsRegistry {
  private readonly role: string
  private readonly now: () => number
  private readonly processStartMs: number
  private readonly pollFailuresByCode = new Map<string, number>()
  private readonly pollItemsByOutcome = new Map<PollItemOutcome, number>()
  private pollSuccesses = 0
  private pollFailures = 0
  private lastSuccessAtMs?: number
  private lastAttemptAtMs?: number
  private lastDurationSeconds?: number
  private lastSucceeded?: boolean
  private lastErrorCode?: string
  private scanner?: ScannerHeartbeatObservation
  private scannerQueue?: ScannerQueueObservation
  private scannerQueueReads = 0
  private scannerQueueReadFailures = 0

  constructor(options: WorkerMetricsRegistryOptions) {
    this.role = options.role
    this.now = options.now ?? (() => Date.now())
    this.processStartMs = options.processStartMs ?? this.now()
  }

  recordPollSuccess(input: { startedAtMs: number; finishedAtMs: number; result: WorkerPollResult }): void {
    this.pollSuccesses += 1
    this.lastSucceeded = true
    this.lastSuccessAtMs = input.finishedAtMs
    this.lastAttemptAtMs = input.finishedAtMs
    this.lastDurationSeconds = Math.max(0, (input.finishedAtMs - input.startedAtMs) / 1000)
    for (const outcome of POLL_ITEM_OUTCOMES) {
      const key = outcome === 'dead_letter' ? 'deadLetter' : outcome
      const value = Number(input.result[key as keyof WorkerPollResult] ?? 0)
      if (!Number.isFinite(value) || value <= 0) continue
      this.pollItemsByOutcome.set(outcome, (this.pollItemsByOutcome.get(outcome) ?? 0) + value)
    }
  }

  recordPollFailure(input: { finishedAtMs: number; code?: string }): void {
    this.pollFailures += 1
    this.lastSucceeded = false
    this.lastAttemptAtMs = input.finishedAtMs
    const code = sanitizeErrorCode(input.code)
    this.lastErrorCode = code
    if (this.pollFailuresByCode.size >= MAX_DISTINCT_ERROR_CODES && !this.pollFailuresByCode.has(code)) {
      this.pollFailuresByCode.set(OVERFLOW_ERROR_CODE, (this.pollFailuresByCode.get(OVERFLOW_ERROR_CODE) ?? 0) + 1)
      return
    }
    this.pollFailuresByCode.set(code, (this.pollFailuresByCode.get(code) ?? 0) + 1)
  }

  recordScannerHeartbeat(heartbeat: ScannerHeartbeatObservation): void {
    this.scanner = heartbeat
  }

  /** Projects one successful durable read of the scan queue onto the gauge family. */
  recordScannerQueue(queue: ScannerQueueObservation): void {
    this.scannerQueue = queue
    this.scannerQueueReads += 1
  }

  /**
   * A durable scan-queue read failed.
   *
   * The previous observation is dropped rather than kept. Keeping it would serve
   * a stale backlog as a current reading, and `merchant_queue_depth{queue="scan"}
   * = 5` cannot be told apart from "the read that would refresh this number has
   * been failing for twenty minutes" - which is exactly the failure the backlog
   * rule exists to catch. Withholding the family moves that case to "no data"
   * and the honest signals are the `outcome="failed"` counter below and the
   * caller's error line. Same contract as
   * `merchant_job_queue_metrics_reads_total` on the API side: a failed read is
   * never rendered as `0`, and never as a stale value either.
   */
  recordScannerQueueReadFailure(): void {
    this.scannerQueueReadFailures += 1
    this.scannerQueue = undefined
  }

  render(): string {
    const nowMs = this.now()
    const labels = label('role', this.role)
    const lines: string[] = []
    const emit = (help: string, type: 'gauge' | 'counter', samples: string[]): void => {
      lines.push(`# HELP ${help}`)
      lines.push(`# TYPE ${type}`)
      lines.push(...samples)
    }

    emit(
      'merchant_worker_up Whether the worker metrics endpoint is serving for this role.',
      'gauge',
      [`merchant_worker_up{${labels}} 1`],
    )
    emit(
      'merchant_worker_process_start_time_seconds Start time of the worker process since the unix epoch. A change in this value for a stable pod identity means the container restarted; it is the restart signal this repository can produce without kube-state-metrics.',
      'gauge',
      [`merchant_worker_process_start_time_seconds{${labels}} ${Math.floor(this.processStartMs / 1000)}`],
    )
    emit(
      'merchant_worker_process_uptime_seconds Uptime of the worker process in seconds.',
      'gauge',
      [`merchant_worker_process_uptime_seconds{${labels}} ${Math.max(0, (nowMs - this.processStartMs) / 1000)}`],
    )

    // Emitted before the first completed cycle on purpose: a worker that has
    // never completed a poll must be distinguishable from one that is merely
    // scraping early, and `time() - <epoch 0>` is exactly that statement.
    const heartbeatSeconds = this.lastSuccessAtMs === undefined ? 0 : Math.floor(this.lastSuccessAtMs / 1000)
    emit(
      'merchant_worker_heartbeat_timestamp_seconds Unix timestamp of the last poll cycle this role completed successfully. This is the worker liveness signal that previously had no outlet: the readiness file, Redis heartbeat key and API ops projection are not scrapable.',
      'gauge',
      [`merchant_worker_heartbeat_timestamp_seconds{${labels}} ${heartbeatSeconds}`],
    )

    const lastAttempt = finite(this.lastAttemptAtMs)
    if (lastAttempt !== undefined) {
      emit(
        'merchant_worker_poll_last_attempt_timestamp_seconds Unix timestamp of the last poll cycle attempt, successful or not.',
        'gauge',
        [`merchant_worker_poll_last_attempt_timestamp_seconds{${labels}} ${Math.floor(lastAttempt / 1000)}`],
      )
    }
    const duration = finite(this.lastDurationSeconds)
    if (duration !== undefined) {
      emit(
        'merchant_worker_poll_duration_seconds Duration of the last successful poll cycle in seconds.',
        'gauge',
        [`merchant_worker_poll_duration_seconds{${labels}} ${duration}`],
      )
    }
    if (this.lastSucceeded !== undefined) {
      emit(
        'merchant_worker_last_poll_succeeded Whether the most recent poll cycle completed successfully.',
        'gauge',
        [`merchant_worker_last_poll_succeeded{${labels}} ${this.lastSucceeded ? 1 : 0}`],
      )
    }

    emit(
      'merchant_worker_poll_total Poll cycles completed by this process, by outcome.',
      'counter',
      [
        `merchant_worker_poll_total{${labels},outcome="success"} ${this.pollSuccesses}`,
        `merchant_worker_poll_total{${labels},outcome="failure"} ${this.pollFailures}`,
      ],
    )
    if (this.pollFailuresByCode.size > 0) {
      emit(
        'merchant_worker_poll_failures_total Poll cycles that failed, by bounded error code.',
        'counter',
        [...this.pollFailuresByCode.entries()]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([code, count]) => `merchant_worker_poll_failures_total{${labels},code=${quoted(code)}} ${count}`),
      )
    }
    if (this.pollItemsByOutcome.size > 0) {
      emit(
        'merchant_worker_poll_items_total Queue items observed by this process, by terminal outcome.',
        'counter',
        [...this.pollItemsByOutcome.entries()]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([outcome, count]) => `merchant_worker_poll_items_total{${labels},outcome=${quoted(outcome)}} ${count}`),
      )
    }

    this.renderScanner(lines, labels)
    return `${lines.join('\n')}\n`
  }

  /**
   * Scanner-derived series. Emitted only for the scan role: a non-scan worker
   * has no heartbeat state to report, and an always-present zero series would
   * be a lie about coverage.
   */
  private renderScanner(lines: string[], labels: string): void {
    const emit = (help: string, samples: string[]): void => {
      lines.push(`# HELP ${help}`)
      lines.push('# TYPE gauge')
      lines.push(...samples)
    }
    const heartbeat = this.scanner
    if (heartbeat) {
      emit(
        'merchant_worker_scanner_ready Whether the scanner heartbeat reports this instance as ready.',
        [`merchant_worker_scanner_ready{${labels}} ${heartbeat.ready ? 1 : 0}`],
      )
      emit(
        'merchant_worker_scanner_recovery_capable Whether the scanner can safely execute a recovery scan.',
        [`merchant_worker_scanner_recovery_capable{${labels}} ${heartbeat.recoveryCapable ? 1 : 0}`],
      )
      const definitionsAge = finite(heartbeat.clamav?.definitionsAgeSeconds)
      if (definitionsAge !== undefined) {
        emit(
          'merchant_worker_scanner_definitions_age_seconds Age of the loaded ClamAV definitions.',
          [`merchant_worker_scanner_definitions_age_seconds{${labels}} ${definitionsAge}`],
        )
      }
      const eicarAge = finite(heartbeat.eicar?.ageSeconds)
      if (eicarAge !== undefined) {
        emit(
          'merchant_worker_scanner_eicar_age_seconds Age of the last passing EICAR self-test.',
          [`merchant_worker_scanner_eicar_age_seconds{${labels}} ${eicarAge}`],
        )
      }
      const callbackAge = finite(heartbeat.callback?.ageSeconds)
      if (callbackAge !== undefined) {
        emit(
          'merchant_worker_scanner_callback_age_seconds Age of the last accepted scanner callback.',
          [`merchant_worker_scanner_callback_age_seconds{${labels}} ${callbackAge}`],
        )
      }
      const acceptedAt = heartbeat.callback?.lastAcceptedAt ? Date.parse(heartbeat.callback.lastAcceptedAt) : Number.NaN
      if (Number.isFinite(acceptedAt)) {
        emit(
          'merchant_worker_scanner_last_callback_accepted_timestamp_seconds Unix timestamp of the last accepted scanner callback.',
          [`merchant_worker_scanner_last_callback_accepted_timestamp_seconds{${labels}} ${Math.floor(acceptedAt / 1000)}`],
        )
      }
      if (heartbeat.failure?.code) {
        emit(
          'merchant_worker_scanner_failure Whether the last scanner heartbeat probe failed, by bounded code.',
          [`merchant_worker_scanner_failure{${labels},code=${quoted(sanitizeErrorCode(heartbeat.failure.code))}} 1`],
        )
      }
    }

    // Emitted for every scan-role worker that has attempted at least one read,
    // including one whose every read failed: that is the only way "the queue
    // series is absent" can be told apart from "this worker never probes".
    if (this.scannerQueueReads > 0 || this.scannerQueueReadFailures > 0) {
      lines.push('# HELP merchant_worker_scanner_queue_reads_total Durable scan-queue aggregation reads by outcome.')
      lines.push('# TYPE merchant_worker_scanner_queue_reads_total counter')
      lines.push(`merchant_worker_scanner_queue_reads_total{${labels},outcome="ok"} ${this.scannerQueueReads}`)
      lines.push(`merchant_worker_scanner_queue_reads_total{${labels},outcome="failed"} ${this.scannerQueueReadFailures}`)
    }

    const queue = this.scannerQueue
    if (queue) {
      const queueLabel = label('queue', 'scan')
      emit(
        'merchant_queue_depth Durable queue rows that are pending and eligible for a claim.',
        [`merchant_queue_depth{${queueLabel}} ${Math.max(0, queue.backlog)}`],
      )
      emit(
        'merchant_queue_dead_letter_events Durable queue rows that reached a terminal failure.',
        [`merchant_queue_dead_letter_events{${queueLabel}} ${Math.max(0, queue.deadLetter)}`],
      )
      // Zero when nothing is pending, so the series always exists once the scan
      // role has probed: an absent series is indistinguishable from "no alert
      // configured" and would silently disable the backlog rule.
      emit(
        'merchant_queue_oldest_job_age_seconds Age of the oldest active job by queue.',
        [`merchant_queue_oldest_job_age_seconds{${queueLabel}} ${Math.max(0, finite(queue.oldestPendingAgeSeconds) ?? 0)}`],
      )
    }
  }
}

export interface MetricsAuthorization {
  authorized: boolean
  status: number
  error?: string
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8')
  const rightBuffer = Buffer.from(right, 'utf8')
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

/**
 * Same fail-closed contract as the API: in production a missing token is a 503
 * (the endpoint is not configured) and a wrong bearer is a 401 (it is
 * configured and the caller is not allowed). Outside production the endpoint is
 * open so local verification does not need a secret, matching the API.
 */
export function authorizeMetricsRequest(input: { production: boolean; token?: string; authorization?: string }): MetricsAuthorization {
  if (!input.production) return { authorized: true, status: 200 }
  const token = input.token?.trim()
  if (!token) return { authorized: false, status: 503, error: 'METRICS_AUTH_NOT_CONFIGURED' }
  if (!input.authorization || !safeEqual(input.authorization, `Bearer ${token}`)) {
    return { authorized: false, status: 401, error: 'METRICS_UNAUTHORIZED' }
  }
  return { authorized: true, status: 200 }
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

export interface WorkerMetricsServerOptions {
  registry: WorkerMetricsRegistry
  port: number
  host: string
  /** Reported instead of thrown: a metrics listener must never fail the worker. */
  onError?: (error: unknown) => void
  production?: boolean
  token?: string
}

export interface WorkerMetricsServer {
  /** Resolves true when the listener is bound, false when it could not be. */
  start(): Promise<boolean>
  stop(): Promise<void>
  address(): { port: number; host: string } | undefined
}

export function createWorkerMetricsServer(options: WorkerMetricsServerOptions): WorkerMetricsServer {
  const production = options.production ?? process.env.NODE_ENV === 'production'
  const token = options.token ?? process.env.METRICS_AUTH_TOKEN
  let server: Server | undefined
  let bound: { port: number; host: string } | undefined

  const handle = (request: { method?: string; url?: string; headers: IncomingHttpHeaders }, response: {
    statusCode: number
    setHeader(name: string, value: string): void
    end(body?: string): void
  }): void => {
    const method = request.method ?? 'GET'
    // Reject everything that is not a bodyless read before inspecting state:
    // the endpoint performs no writes and accepts no payload.
    if (method !== 'GET' && method !== 'HEAD') {
      response.statusCode = 405
      response.setHeader('allow', 'GET, HEAD')
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }))
      return
    }
    // Compare the path only; a query string is never meaningful here and would
    // otherwise suggest filter parameters this endpoint does not implement.
    const url = request.url ?? ''
    const path = url.split('?')[0]
    if (path !== WORKER_METRICS_PATH || url !== path) {
      response.statusCode = 404
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(JSON.stringify({ error: 'NOT_FOUND' }))
      return
    }
    const authorization = authorizeMetricsRequest({ production, token, authorization: headerValue(request.headers, 'authorization') })
    if (!authorization.authorized) {
      response.statusCode = authorization.status
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(JSON.stringify({ error: authorization.error }))
      return
    }
    response.statusCode = 200
    response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    if (method === 'HEAD') {
      response.end()
      return
    }
    response.end(options.registry.render())
  }

  return {
    async start(): Promise<boolean> {
      if (server) return true
      const created = createServer((request, response) => {
        try {
          handle(request, response)
        } catch (error) {
          options.onError?.(error)
          if (!response.headersSent) response.statusCode = 500
          response.end()
        }
      })
      // Slowloris-shaped inputs are rejected by the runtime rather than held:
      // this server has exactly one legitimate, tiny request shape.
      created.headersTimeout = 10_000
      created.requestTimeout = 10_000
      created.keepAliveTimeout = 5_000
      const started = await new Promise<boolean>(resolve => {
        const onListenError = (error: unknown) => { options.onError?.(error); resolve(false) }
        created.once('error', onListenError)
        created.listen(options.port, options.host, () => {
          created.off('error', onListenError)
          const address = created.address()
          if (address && typeof address === 'object') bound = { port: address.port, host: options.host }
          resolve(true)
        })
      })
      if (!started) return false
      server = created
      return true
    },
    async stop(): Promise<void> {
      const current = server
      server = undefined
      if (!current) return
      await new Promise<void>(resolve => { current.close(() => resolve()) })
    },
    address: () => bound,
  }
}
