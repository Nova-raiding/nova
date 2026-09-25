import { pathToFileURL } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { unlink, utimes, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { Pool, type PoolConfig } from 'pg'
import type { RedisClientType } from 'redis'
import { contextEnvelopeHash, loadMigrations, PostgresAssetScanAttemptRepository, PostgresCreativePointLifecycleRepository, PostgresCreativePointRepository, PostgresOnboardingGrantDispatchRepository, PostgresOutboxRepository, withWorkspaceTransaction, type AssetScanAttemptRecord, type AssetScanAttemptRepository, type Migration, type SqlPool } from '../../../packages/persistence/src/index.js'
import { PostgresMappingPreflightApprovalRepository } from '../../../packages/persistence/src/mapping-preflight-approval-repository.js'
import { DurableOutboxDispatcher, InMemoryQueue, RedisQueueAdapter, type DurableOutboxEvent, type QueuePort, type RedisQueueTransport, type WorkerDispatchObservation } from '../../../packages/workers/src/durable.js'
import { buildWorkerDispatchLogRecord, workerDispatchTraceId, writeWorkerDispatchLog, type WorkerDispatchLogEvent } from '../../../packages/workers/src/dispatch-observability.js'
import { createOutboxHandler, createWorkerProjection } from './handler.js'
import { connectRedisQueue, createRedisCredentialRefreshLock, DEFAULT_QUEUE_MAX_DEPTH } from './redis-transport.js'
import { ConnectorMappingPreflightError, ConnectorRuntime, SyncPaginationError } from '../../../packages/application/src/connector-runtime.js'
import { createVaultCredentialProviderFromEnv } from '../../../packages/connectors/src/index.js'
import { readBoundedResponseText } from '../../../packages/connectors/src/bounded-response.js'
import type { PublishHandlerResult } from '../../../packages/workers/src/publish-adapter.js'
import { buildPublishObservationRequest, PublishObservationReportError } from '../../../packages/workers/src/publish-observation.js'
import { createContentGeneratorFromEnv, type ContentGenerationInput, type GeneratedContent } from '../../../packages/ai/src/generator.js'
import { createImageGeneratorFromEnv, type ImageGenerationInput, type ImageGenerationStatus } from '../../../packages/ai/src/image-generator.js'
import { createRelayPricingClientFromEnv } from '../../../packages/ai/src/relay-pricing.js'
import { createEmbeddingClientFromEnv } from '../../../packages/ai/src/embedding.js'
import type { RelayUsageRecord } from '../../../packages/ai/src/relay-usage.js'
import { FixedWindowQuotaAdmission, type QuotaAdmissionInput } from '../../../packages/quotas/src/admission.js'
import { DistributedLockBusyError } from '../../../packages/quotas/src/lock.js'
import { createQuotaCounterStore } from './quota-transport.js'
import { createPersistentWorkerMappingPreflightAdapter, createPostgresWorkerMappingScopeLoader, WorkerMappingExecutionContext } from './mapping-preflight-adapter.js'
import { ASSET_SCAN_RECEIPT_SCHEMA, assetScanReceiptDigest, canonicalAssetScanReceipt, parseAssetScanReceipt, signAssetScanReceipt } from '../../../packages/security/src/asset-scan-receipt.js'
import { createScannerRequestProof } from '../../../packages/security/src/scanner-request-proof.js'
import { createWorkerRequestProof, resolveWorkerId, type WorkerRequestRole } from '../../../packages/security/src/worker-request-proof.js'
import { createClamAvScanner, type ClamAvScanner } from './clamav-scanner.js'
import { ScannerHeartbeatController } from './scanner-heartbeat.js'
import { createWorkerMetricsServer, WORKER_METRICS_DEFAULT_HOST, WORKER_METRICS_DEFAULT_PORT, WorkerMetricsRegistry } from './worker-metrics.js'
import { createExecutionAuthorizationGuard, executeAfterAuthorizationCheck, WorkerExecutionAuthorizationError, type CriticalWorkerOperation, type WorkerAuthorizationRecheck, type WorkerExecutionAuthorizationGuard } from '../../../packages/workers/src/execution-authorization.js'
import { createCommercialAccessGuard, WorkerCommercialAccessError, type WorkerCommercialAccessRecheck } from '../../../packages/workers/src/commercial-access.js'
import { CUSTOMER_DELIVERY_SCAN_EVENT, CUSTOMER_DELIVERY_SCAN_OPERATION, createDeliveryScanAdmissionGuard, DeliveryScanAdmissionError } from '../../../packages/workers/src/customer-delivery-scan-admission.js'
import { assertClamAvExecutionAdmission } from '../../../packages/workers/src/scanner-heartbeat.js'
import { planSupportSlaReportSchedule } from '../../../packages/workers/src/support-sla-scan.js'
import { isGenerationJobExecutable, isGenerationJobFinished, validateImageGenerationCallbackResult } from '../../../packages/contracts/src/index.js'
import { assertGenerationInput } from './generation-input.js'
import { CreativePointRelaySettlement, deliverGenerationResultWithPointSettlement, relayProviderIdentity, requiresCreativePointSettlement } from './creative-point-relay-settlement.js'
import { PostgresKnowledgeRepository } from '../../../packages/persistence/src/knowledge.js'
import { indexApprovedKnowledge } from '../../../packages/application/src/knowledge-lexical-index.js'
import { GenerationKnowledgeReceiptError, validateGenerationKnowledgeReceipt, type FrozenGenerationKnowledgeDocument } from '../../../packages/application/src/knowledge-execution-fence.js'

export interface WorkerConfig {
  databaseUrl: string
  workspaces: string[]
  autoDiscoverWorkspaces: boolean
  pollIntervalMs: number
  storageReconciliationIntervalMs: number
  paymentReconciliationIntervalMs: number
  paymentReconciliationBatchSize: number
  modelUsageReconciliationIntervalMs: number
  supportSlaScanIntervalMs: number
  supportSlaReportIntervalMs: number
  imageGenerationReconciliationIntervalMs: number
  workerApiTimeoutMs: number
  automationIntervalMs: number
  batchSize: number
  workspaceBatchSize: number
  leaseMs: number
  /** Hard bound on ready + delayed durable queue entries before claims stop. */
  queueMaxDepth: number
  once: boolean
  apiBaseUrl?: string
  apiToken?: string
  apiSigningSecret?: string
  workerId: string
  /** Set by readWorkerConfig; production handlers must never bypass the API gate. */
  environment?: 'production' | 'non-production'
  platformQuotaPerMinute: number
  modelQuotaPerMinute: number
  role: WorkerRole
  dependencyCheckIntervalMs: number
  scanMaxAttempts: number
  scanRetryBaseMs: number
  scanRetryMaxMs: number
  clamavMaxFileBytes: number
  /** Prometheus exposition port. 0 disables the listener entirely. */
  metricsPort: number
  /** Bind address; loopback by default so an unconfigured worker exposes nothing. */
  metricsHost: string
}

export type WorkerRole = 'all' | 'sync' | 'generation' | 'publish' | 'reconcile' | 'automation' | 'scan'

function imageWorkerTrace(event: string, fields: Record<string, unknown> = {}): void {
  try {
    console.info(JSON.stringify({
      event: `merchant.image.worker.${event}`,
      timestamp: new Date().toISOString(),
      ...fields,
    }))
  } catch {
    // Observability must never change the commercial execution outcome.
  }
}

/**
 * Dispatch states map onto the runbook's correlation vocabulary. A failed
 * publish used to leave no log line at all — only `outbox_events.last_error` —
 * so an operator could not join it with the API request that queued it.
 */
const WORKER_DISPATCH_LOG_EVENTS: Record<WorkerDispatchObservation['state'], WorkerDispatchLogEvent> = {
  started: 'worker.outbox.dispatch_started',
  succeeded: 'worker.outbox.succeeded',
  queued: 'worker.outbox.retry_scheduled',
  unknown: 'worker.outbox.unknown',
  dead_letter: 'worker.outbox.dead_letter',
}

/**
 * The connector context used to carry `traceId: event.id` — the outbox row id.
 * That is a durable id, but it is not the request trace id the API request log
 * and the worker dispatch log both carry, so connector-side lines could never
 * be joined with the request that caused them. Only the authorization
 * snapshot's request trace id is propagated; when it is absent the field is
 * omitted rather than filled with a non-joinable substitute.
 */
export function workerTraceContext(event: DurableOutboxEvent): { traceId?: string } {
  const traceId = workerDispatchTraceId(event)
  return traceId ? { traceId } : {}
}

export function emitWorkerDispatchLog(observation: WorkerDispatchObservation<DurableOutboxEvent>, sink?: (line: string) => void): void {
  writeWorkerDispatchLog(buildWorkerDispatchLogRecord({
    event: WORKER_DISPATCH_LOG_EVENTS[observation.state],
    outboxEvent: observation.event,
    attempt: observation.attempt,
    ...(observation.failure?.code ? { errorCode: observation.failure.code } : {}),
    ...(observation.failure?.message ? { errorMessage: observation.failure.message } : {}),
    ...(observation.retryAt ? { retryAt: observation.retryAt } : {}),
  }), sink)
}

function imageWorkerErrorFields(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return { error_message: String(error) }
  const candidate = error as {
    name?: unknown
    code?: unknown
    message?: unknown
    cause?: unknown
    providerOutcome?: unknown
    providerRequestId?: unknown
    providerIdempotencyKey?: unknown
  }
  const cause = candidate.cause && typeof candidate.cause === 'object'
    ? candidate.cause as { name?: unknown; code?: unknown; message?: unknown }
    : undefined
  return {
    ...(typeof candidate.name === 'string' ? { error_name: candidate.name } : {}),
    ...(typeof candidate.code === 'string' ? { error_code: candidate.code } : {}),
    ...(typeof candidate.message === 'string' ? { error_message: candidate.message.slice(0, 1_000) } : {}),
    ...(typeof candidate.providerOutcome === 'string' ? { provider_outcome: candidate.providerOutcome } : {}),
    ...(typeof candidate.providerRequestId === 'string' ? { provider_request_id: candidate.providerRequestId } : {}),
    ...(typeof candidate.providerIdempotencyKey === 'string' ? { provider_idempotency_key: candidate.providerIdempotencyKey } : {}),
    ...(cause && typeof cause.name === 'string' ? { cause_name: cause.name } : {}),
    ...(cause && typeof cause.code === 'string' ? { cause_code: cause.code } : {}),
    ...(cause && typeof cause.message === 'string' ? { cause_message: cause.message.slice(0, 1_000) } : {}),
  }
}

export function workerQueueKey(role: WorkerRole, workspaceId: string): string {
  return `merchant:outbox:${role}:${workspaceId}`
}

export function quotaAdmissionForEvent(
  event: Pick<DurableOutboxEvent, 'workspaceId'>,
  namespace: QuotaAdmissionInput['namespace'],
  key: string,
  limitPerWindow: number,
): QuotaAdmissionInput {
  return { tenantId: event.workspaceId, namespace, key, limitPerWindow }
}

export async function allSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length || 1))
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      try {
        results[index] = { status: 'fulfilled', value: await operation(items[index]!, index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }))
  return results
}

export type PaymentReconciliationResult = {
  state: string
  checked?: number
  payment_checked?: number
  refund_checked?: number
  settled?: unknown[]
  pending?: unknown[]
  failed?: unknown[]
  refund_settled?: unknown[]
  refund_pending?: unknown[]
  refund_failed?: unknown[]
}

export type PaymentReconciliationSweepSummary = {
  completed: number
  failed: number
  businessWarnings: number
  checked: number
  paymentChecked: number
  refundChecked: number
  paymentSettled: number
  paymentPending: number
  paymentFailed: number
  refundSettled: number
  refundPending: number
  refundFailed: number
}

/** Payment provider maintenance is a least-privilege reconcile responsibility.
 * The local `all` dispatcher has no corresponding signed worker role and must
 * not acquire provider-facing maintenance work. Advance before starting I/O so
 * an unexpected sweep failure cannot turn the poll interval into retry cadence. */
export function planPaymentReconciliationRun(input: { role: WorkerRole; startedAt: number; nextRunAt: number; intervalMs: number }): { run: boolean; nextRunAt: number } {
  const run = input.role === 'reconcile' && input.startedAt >= input.nextRunAt
  return { run, nextRunAt: run ? input.startedAt + input.intervalMs : input.nextRunAt }
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function itemCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

/** Run a bounded, workspace-scoped payment sweep and retain business-level
 * attention separately from transport failures. Reconcile deployments run
 * multiple replicas, so this client-side cap complements the API's durable
 * per-workspace lease without pretending to provide distributed exclusion. */
export async function runPaymentReconciliationSweep(input: {
  workspaces: readonly string[]
  reconcile: (workspaceId: string) => Promise<PaymentReconciliationResult>
  workspaceConcurrency?: number
}): Promise<PaymentReconciliationSweepSummary> {
  const concurrency = Math.min(2, Math.max(1, Math.floor(input.workspaceConcurrency ?? 2)))
  const results = await allSettledWithConcurrency(input.workspaces, concurrency, workspaceId => input.reconcile(workspaceId))
  const summary: PaymentReconciliationSweepSummary = {
    completed: 0, failed: 0, businessWarnings: 0, checked: 0, paymentChecked: 0, refundChecked: 0,
    paymentSettled: 0, paymentPending: 0, paymentFailed: 0, refundSettled: 0, refundPending: 0, refundFailed: 0,
  }
  for (const result of results) {
    if (result.status === 'rejected') {
      summary.failed += 1
      continue
    }
    summary.completed += 1
    if (result.value.state === 'attention_required') summary.businessWarnings += 1
    summary.checked += nonNegativeInteger(result.value.checked)
    summary.paymentChecked += nonNegativeInteger(result.value.payment_checked)
    summary.refundChecked += nonNegativeInteger(result.value.refund_checked)
    summary.paymentSettled += itemCount(result.value.settled)
    summary.paymentPending += itemCount(result.value.pending)
    summary.paymentFailed += itemCount(result.value.failed)
    summary.refundSettled += itemCount(result.value.refund_settled)
    summary.refundPending += itemCount(result.value.refund_pending)
    summary.refundFailed += itemCount(result.value.refund_failed)
  }
  return summary
}

export function imageReconciliationQueryTimeoutMs(workerApiTimeoutMs: number): number {
  if (!Number.isSafeInteger(workerApiTimeoutMs) || workerApiTimeoutMs < 1) throw new RangeError('worker API timeout must be a positive integer')
  return Math.min(workerApiTimeoutMs, 5 * 60 * 1000)
}

export function publishIdempotencyKey(event: DurableOutboxEvent): string {
  const configured = event.payload.idempotencyKey
  return typeof configured === 'string' && configured.trim() ? configured : event.aggregateId
}

/**
 * The platform remote id a publish/reconcile event refers to. `remote_id` is
 * the frozen job field; `fields.remoteId` is the pre-execution binding the
 * publish handler also writes with. An absent value means "create", which the
 * connector must resolve through the stable idempotency key.
 */
export function resolvePublishRemoteId(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.remote_id === 'string' && payload.remote_id) return payload.remote_id
  const fields = isObject(payload.fields) ? payload.fields : undefined
  return typeof fields?.remoteId === 'string' && fields.remoteId ? fields.remoteId : undefined
}

/**
 * Mutex key for one platform write. `publish.requested` and
 * `publish.reconcile_requested` for the same job must derive the exact same
 * key, otherwise a reconcile can observe (and overwrite) a create that is
 * still in flight on another worker replica. A create has no remote id yet, so
 * it is keyed by the stable aggregate id instead of the literal `undefined`.
 */
export function publishLockKey(input: { workspaceId: string; platform: string; accountId: string; remoteId?: string; aggregateId: string }): string {
  return `publish:${input.workspaceId}:${input.platform}:${input.accountId}:${input.remoteId ?? `create:${input.aggregateId}`}`
}

/**
 * An image provider may have accepted the request even when the response or
 * usage settlement was lost. Such an error must remain reconcilable and must
 * never be reported to the API as a terminal provider failure.
 */
export function isImageProviderOutcomeUnknown(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as {
    code?: unknown
    providerOutcome?: unknown
    providerSucceeded?: unknown
    reconciliationRequired?: unknown
    details?: Record<string, unknown>
  }
  return candidate.code === 'MODEL_PROVIDER_OUTCOME_UNKNOWN'
    || candidate.code === 'MODEL_USAGE_SETTLEMENT_PENDING'
    || candidate.providerOutcome === 'unknown'
    || candidate.providerSucceeded === true
    || candidate.reconciliationRequired === true
    || candidate.details?.provider_succeeded === true
    || candidate.details?.provider_outcome === 'unknown'
    || candidate.details?.reconciliation_required === true
}

export function requireImageGenerationActionId(payload: Record<string, unknown>): string {
  const actionId = typeof payload.action_id === 'string' ? payload.action_id.trim() : ''
  if (!actionId) throw Object.assign(new Error('image generation event is missing action_id'), { code: 'IMAGE_GENERATION_ACTION_ID_REQUIRED', retryable: false, unknown: false })
  return actionId
}

export function requireModelRunKey(payload: Record<string, unknown>): string {
  const runKey = typeof payload.run_key === 'string' ? payload.run_key.trim() : ''
  if (!runKey) throw Object.assign(new Error('model generation event is missing run_key'), { code: 'MODEL_RUN_KEY_REQUIRED', retryable: false, unknown: false })
  return runKey
}

function requirePublishExecutionConfig(config: Pick<WorkerConfig, 'apiBaseUrl' | 'apiToken' | 'apiSigningSecret' | 'environment'>) {
  if (config.environment !== 'production') return
  if (!config.apiBaseUrl || !config.apiToken || !config.apiSigningSecret) throw new Error('production publish execution requires WORKER_API_BASE_URL, WORKER_API_TOKEN and WORKER_API_SIGNING_SECRET')
}

const workerRouting: Record<Exclude<WorkerRole, 'all' | 'automation'>, { eventTypes: string[]; snapshotEntityTypes?: string[] }> = {
  sync: { eventTypes: ['sync.requested', 'state.snapshot'], snapshotEntityTypes: ['product', 'platform_account', 'sync_job'] },
    generation: { eventTypes: ['task.created', 'state.snapshot', 'generation.requested', 'image.generation.requested', 'asset.generation_continuations.ready', 'asset.generation_continuation.waiting_scan', 'asset.generation_continuation.awaiting_rights', 'asset.generation_continuations.awaiting_confirmation'], snapshotEntityTypes: ['task', 'content_version'] },
  publish: { eventTypes: ['publish.requested'] },
  reconcile: { eventTypes: ['publish.reconcile_requested'] },
  scan: { eventTypes: ['asset.uploaded', 'asset.generated_quarantined', 'asset.video_quarantined', 'asset.scan_redrive_requested', CUSTOMER_DELIVERY_SCAN_EVENT] },
}

/**
 * Everything `ROLE=all` owns except the platform scan queue, derived from
 * `workerRouting` so a new event type cannot be silently dropped from the
 * `all` claim. `state.snapshot` is included: the snapshot projection is not a
 * scan side effect and must keep flowing while the local scanner is unready.
 */
export const NON_SCAN_EVENT_TYPES: readonly string[] = [...new Set(
  (['sync', 'generation', 'publish', 'reconcile'] as const).flatMap(role => workerRouting[role].eventTypes),
)]

/**
 * Keeps the ready file's modification time inside the probe window while the
 * poll loop is working, without ever writing, creating, or removing it.
 *
 * `touch()` deliberately fails silently when the file is absent: a worker whose
 * dependencies are not verified has no marker and must not acquire one from a
 * timer. `start()` is bounded to the moment the loop is actually executing, so
 * the heartbeat cannot outlive the work it is evidence for; `stop()` runs in
 * the loop body's `finally`, which is also what makes a blocked event loop or a
 * dead process stop refreshing and be restarted by the probe.
 */
export function createReadyFileHeartbeat(options: { readyFile: string; intervalMs?: number }): { start: () => void; stop: () => void; touch: () => Promise<boolean> } {
  const intervalMs = options.intervalMs ?? READY_FILE_HEARTBEAT_MS
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError('ready file heartbeat interval must be a positive integer')
  let timer: ReturnType<typeof setInterval> | undefined
  const touch = async (): Promise<boolean> => {
    const at = new Date()
    try {
      await utimes(options.readyFile, at, at)
      return true
    } catch {
      // Absent (never ready, or revoked) or unreadable: nothing to refresh.
      return false
    }
  }
  return {
    touch,
    start() {
      if (timer !== undefined) return
      timer = setInterval(() => { void touch() }, intervalMs)
      // A liveness hint must never be the reason a shutting-down process stays
      // alive (see the credential refresh lock, which had exactly that bug).
      timer.unref?.()
    },
    stop() {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
  }
}

const DEFAULT_WORKER_API_TIMEOUT_MS = 10_000
const DEFAULT_WORKER_DEPENDENCY_CHECK_INTERVAL_MS = 10_000
/**
 * The freshness window the non-scanner probes read: `find <ready-file> -mmin -2`
 * (`infra/kubernetes/base/workers.yaml`). It is the budget every dependency call
 * the poll loop awaits has to fail inside - a call that can outlive it is
 * indistinguishable from a wedged loop while the ready-file heartbeat is
 * running. See `READY_FILE_HEARTBEAT_MS` and `workerDatabasePoolOptions`.
 */
export const READY_FILE_PROBE_WINDOW_MS = 120_000
/**
 * Postgres statement budget for the worker pool. The loop's queries are all
 * short (claim, lease, acknowledge, per-workspace aggregates); the only thing
 * this is sized against is the probe window above.
 */
const DEFAULT_WORKER_DB_QUERY_TIMEOUT_MS = 30_000
/**
 * How often the scan queue depth/age gauge is refreshed from Postgres. The
 * heartbeat probe already queries the same aggregate every few seconds, but it
 * is gated on API readiness, so it cannot be the only source for a series whose
 * whole purpose is to page when consumption stops.
 */
const SCANNER_QUEUE_METRICS_INTERVAL_MS = 30_000
/**
 * How often the poll loop proves it is still running by refreshing the ready
 * file's modification time.
 *
 * The non-scanner roles are probed with `find <ready-file> -mmin -2`, but the
 * file used to be rewritten only at the end of a whole cycle (or after a
 * dependency check). A cycle is not bounded by that: a single worker API call
 * is allowed `WORKER_API_TIMEOUT_MS` (minutes, not seconds), and one cycle runs
 * up to `WORKER_BATCH_SIZE` events across `WORKER_WORKSPACE_BATCH_SIZE`
 * workspaces. A legitimately slow cycle therefore tripped the liveness probe,
 * kubelet restarted the pod, and the 15-minute durable lease kept the work from
 * being picked up anywhere else - the queue stalled, with no log line saying
 * why.
 *
 * Raising the probe threshold instead would only move the collision: any window
 * large enough for the worst legitimate cycle is too large to catch a genuinely
 * dead process. Proving liveness on a cadence shorter than the window is what
 * the scanner role already does (heartbeat every 5s, TTL 15s), and this is the
 * same idea for the roles that have no heartbeat controller of their own.
 *
 * The refresh is therefore only honest while "the loop is executing" implies
 * "the loop will finish what it is doing". That is the invariant this file and
 * the queue transport have to keep, and it is why every await the loop reaches
 * is bounded by a budget of its own:
 *
 *  - worker API calls: `WORKER_API_TIMEOUT_MS` (see `fetchWorkerApi`);
 *  - a single event's handler: `handlerTimeoutMs` on the dispatcher;
 *  - Postgres: the query/statement timeout on the pool this loop is handed
 *    (see `workerDatabasePoolOptions`), which also covers the transaction
 *    wrapper the repository opens;
 *  - Redis: `REDIS_OPERATION_TIMEOUT_MS` around every round trip the queue,
 *    scanner-heartbeat and quota transports perform (see `redis-transport.ts`).
 *
 * A bounded await that runs out of budget throws, the iteration's `catch`
 * removes the marker and its `finally` stops this timer, so the probe fails and
 * kubelet restarts the pod within one probe window. An *unbounded* await does
 * the opposite: it parks the loop while the timer keeps the marker inside the
 * window, which is precisely the failure the fourth budget above closes. Adding
 * a new dependency call to the loop without a budget re-opens it.
 *
 * Removing the marker is only half of it, and the half that was missing: the
 * next iteration's dependency check used to write it straight back, so a worker
 * failing *every* iteration was advertised as ready again within one poll
 * interval. `failureThreshold` counts consecutive probe failures, and a marker
 * that reappears between two of them never reaches it. The loop therefore
 * carries `consecutiveIterationFailures` and stops writing the idle marker once
 * its failure streak passes `READY_MARKER_TOLERATED_FAILURES`, so a loop that
 * stops progressing keeps the marker revoked until it recovers on its own -
 * which is what lets the probe restart it. The same counter is what keeps the
 * revocation from outliving the failure: a *single* transient failure must not
 * suppress the marker for the whole of the next (possibly multi-minute)
 * iteration. See that constant's own note for the threshold and how it is
 * derived from the probe's restart budget.
 *
 * A progress-gated refresh ("only touch while the loop reports advancement")
 * was considered and rejected: with the deployed budgets an honest gap between
 * two steps reaches minutes (`WORKER_API_TIMEOUT_MS=360000` in the shipped
 * configmap, and a handler is allowed its whole lease), so any gate tight enough
 * to catch a stall would have restarted healthy workers again - the regression
 * this heartbeat exists to prevent. Bounding the steps keeps both properties.
 *
 * Only the mtime is refreshed; the document itself is still written by the loop
 * at the points where it has real evidence to report.
 */
const READY_FILE_HEARTBEAT_MS = 30_000
/**
 * Consecutive failed iterations after which the idle marker is no longer written
 * back by the dependency check: the failure path's revocation then lasts until
 * an iteration actually completes.
 *
 * The budget it is derived from is the probe's, not the loop's. The shipped
 * liveness probe (`infra/kubernetes/base/workers.yaml`) is
 * `find <ready-file> -mmin -2` with `initialDelaySeconds` 15, `periodSeconds`
 * 10, `timeoutSeconds` 3 and *no* `failureThreshold`, i.e. the Kubernetes
 * default of 3 - three consecutive failures, ~30s, is the entire restart
 * budget, and the readiness probe is the same ~30s (`periodSeconds` 5,
 * `failureThreshold` 6). `failureThreshold` counts *consecutive* failures, so
 * every marker the loop writes back inside a failing streak restarts that
 * count; the tolerance has to be strictly smaller than the probe's threshold
 * for the count to ever be reached, and it is `1` rather than `2` because the
 * failure path *unlinks* the marker rather than leaving it stale - each
 * tolerated iteration is a full probe-success window, and every one of them
 * postpones the restart of a genuinely wedged loop. One failed iteration is the
 * smallest streak that is not evidence about the next iteration; anything
 * larger buys nothing but delay.
 *
 * Why tolerate a failure at all: with `0` (the previous `iterationFailed`
 * boolean) a single transient failure - one Redis round trip over
 * `REDIS_OPERATION_TIMEOUT_MS`, one API 503, one statement timeout - leaves the
 * marker revoked for the whole of the *next* iteration. That iteration is
 * allowed to run for minutes (`WORKER_API_TIMEOUT_MS` 360s across
 * `WORKER_BATCH_SIZE` events and `WORKER_WORKSPACE_BATCH_SIZE` workspaces), and
 * the heartbeat cannot restore the marker it does not have (`touch()` is
 * `utimes`, and its ENOENT is swallowed). The liveness probe then fires after
 * ~30s and SIGTERMs a worker whose dependencies are healthy and whose events are
 * leased - the #29 stall, re-entered from the other side and with every probe
 * green. Both directions are registered in `tests/invariants/registry.ts`.
 */
const READY_MARKER_TOLERATED_FAILURES = 1

/**
 * Whether the poll loop may write the ready marker after `consecutiveFailures`
 * consecutive failed iterations.
 *
 * The single decision point for the gate: the dependency-check write is the only
 * production caller, and it is exported so a future writer of the marker has one
 * place to ask rather than a comparison to copy - the branch's recurring defect
 * is a rule implemented twice and one copy drifting.
 */
export function readyMarkerRefreshAllowed(consecutiveFailures: number): boolean {
  return consecutiveFailures <= READY_MARKER_TOLERATED_FAILURES
}
const DEFAULT_STORAGE_RECONCILIATION_INTERVAL_MS = 15 * 60_000
const DEFAULT_PAYMENT_RECONCILIATION_INTERVAL_MS = 5 * 60_000
const DEFAULT_PAYMENT_RECONCILIATION_BATCH_SIZE = 10
const DEFAULT_MODEL_USAGE_RECONCILIATION_INTERVAL_MS = 5 * 60_000
const DEFAULT_SUPPORT_SLA_SCAN_INTERVAL_MS = 60_000
const DEFAULT_SUPPORT_SLA_REPORT_INTERVAL_MS = 60 * 60_000
const MAX_WORKER_API_RESPONSE_BYTES = 24 * 1024 * 1024
export const DEFAULT_CLAMAV_MAX_FILE_BYTES = 100 * 1024 * 1024

function assetScanContentTooLarge(maxBytes: number): Error & { code: string; retryable: false } {
  return Object.assign(new Error(`asset scan content exceeds the ${maxBytes}-byte scanner limit`), {
    code: 'ASSET_SCAN_CONTENT_TOO_LARGE',
    retryable: false as const,
  })
}

/** Reads an untrusted scan-content response without allowing an absent or
 * dishonest Content-Length header to turn into an unbounded allocation. */
export async function readBoundedAssetScanContent(response: Response, maxBytes = DEFAULT_CLAMAV_MAX_FILE_BYTES): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('asset scan content limit must be a positive safe integer')
  const rawLength = response.headers.get('content-length')
  if (rawLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength)) {
      await response.body?.cancel().catch(() => undefined)
      throw Object.assign(new Error('asset scan content-length is invalid'), { code: 'ASSET_SCAN_CONTENT_LENGTH_INVALID', retryable: false })
    }
    const declaredLength = Number(rawLength)
    if (!Number.isSafeInteger(declaredLength)) {
      await response.body?.cancel().catch(() => undefined)
      throw Object.assign(new Error('asset scan content-length is invalid'), { code: 'ASSET_SCAN_CONTENT_LENGTH_INVALID', retryable: false })
    }
    if (declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw assetScanContentTooLarge(maxBytes)
    }
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      if (value.byteLength > maxBytes - total) {
        await reader.cancel(assetScanContentTooLarge(maxBytes)).catch(() => undefined)
        throw assetScanContentTooLarge(maxBytes)
      }
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

type WorkerReadinessDatabase = {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<{ version: number; name: string }> }>
}

/** A worker is ready only when its database schema exactly matches the shipped
 * migration inventory and its API dependency reports durable readiness. */
export async function assertWorkerReadinessDependencies(input: {
  database: WorkerReadinessDatabase
  apiBaseUrl?: string
  apiHealthPath?: '/healthz' | '/readyz'
  fetcher?: typeof fetch
  expectedMigrations?: readonly Pick<Migration, 'version' | 'name'>[]
}): Promise<{ migrationVersion: number; apiReady: boolean }> {
  const expected = input.expectedMigrations ?? await loadMigrations()
  const result = await input.database.query('SELECT version, name FROM schema_migrations ORDER BY version ASC')
  const actual = result.rows.map(row => ({ version: Number(row.version), name: row.name }))
  const mismatch = actual.length !== expected.length || expected.some((migration, index) => {
    const applied = actual[index]
    return !applied || applied.version !== migration.version || applied.name !== migration.name
  })
  if (mismatch) {
    const expectedTail = expected.at(-1)?.version ?? 0
    const actualTail = actual.at(-1)?.version ?? 0
    throw new Error(`worker database schema mismatch: expected complete migration chain through ${expectedTail}, found ${actual.length} migrations through ${actualTail}`)
  }

  if (!input.apiBaseUrl) return { migrationVersion: expected.at(-1)?.version ?? 0, apiReady: false }
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${input.apiHealthPath ?? '/readyz'}`, {
    headers: { accept: 'application/json' },
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`worker API readiness dependency returned ${response.status}`)
  const envelope = await parseWorkerApiJson(response) as { data?: { persistence?: { ready?: unknown }; redis?: { ready?: unknown } }; error?: unknown }
  if (envelope.error != null || envelope.data?.persistence?.ready !== true || envelope.data?.redis?.ready !== true) {
    throw new Error('worker API readiness dependency returned an invalid or incomplete readiness envelope')
  }
  return { migrationVersion: expected.at(-1)?.version ?? 0, apiReady: true }
}

export function assetScanReceiptPrivateKeyPem(env: NodeJS.ProcessEnv): string | undefined {
  const direct = env.ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM?.trim()
  if (direct) return direct
  const encoded = env.ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM_B64?.trim()
  if (!encoded) return undefined
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim()
    return decoded || undefined
  } catch {
    return undefined
  }
}

export function hasCompleteScanCallbackCredentials(config: Pick<WorkerConfig, 'apiBaseUrl'>, env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    config.apiBaseUrl
    && env.ASSET_SCANNER_API_TOKEN?.trim()
    && env.ASSET_SCANNER_WORKSPACE_SIGNING_SECRET?.trim()
    && assetScanReceiptPrivateKeyPem(env)
    && env.ASSET_SCAN_RECEIPT_KEY_ID?.trim(),
  )
}

async function parseWorkerApiJson(response: Response): Promise<unknown> {
  return JSON.parse(await readBoundedResponseText(response, MAX_WORKER_API_RESPONSE_BYTES, 'worker API response')) as unknown
}

async function fetchWorkerApi(fetcher: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const configured = Number(process.env.WORKER_API_TIMEOUT_MS ?? DEFAULT_WORKER_API_TIMEOUT_MS)
  const timeoutMs = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_WORKER_API_TIMEOUT_MS
  const controller = new AbortController()
  const callerSignal = init.signal
  const abortFromCaller = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) abortFromCaller()
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeout = setTimeout(() => controller.abort(new DOMException('worker API request timed out', 'TimeoutError')), timeoutMs)
  try {
    const headers = new Headers(init.headers)
    const signingSecret = headers.get('x-internal-worker-signing-secret')
    headers.delete('x-internal-worker-signing-secret')
    if (signingSecret) {
      const target = new URL(url)
      const requestTarget = `${target.pathname}${target.search}`
      const method = (init.method ?? 'GET').toUpperCase()
      const workspaceId = headers.get('x-workspace-id') ?? ''
      const body = typeof init.body === 'string' || init.body instanceof Uint8Array ? init.body : undefined
      if (init.body !== undefined && body === undefined) throw new Error('signed worker requests require a string or Uint8Array body')
      const proof = createWorkerRequestProof({ secret: signingSecret, workerId: headers.get('x-worker-id') ?? undefined, role: workerRoleForRequest(method, requestTarget, body), method, requestTarget, workspaceId, body })
      for (const [name, value] of Object.entries(proof.headers)) headers.set(name, value)
    }
    return await fetcher(url, { ...init, headers: Object.fromEntries(headers.entries()), signal: controller.signal })
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}

function workerAuthIntent(signingSecret: string, workerId = resolveWorkerId()): Record<string, string> {
  return { 'x-internal-worker-signing-secret': signingSecret, 'x-worker-id': workerId }
}

export function workerRoleForRequest(method: string, requestTarget: string, body?: string | Uint8Array): WorkerRequestRole {
  const path = new URL(requestTarget, 'http://worker.internal').pathname
  if (/^\/v1\/sync-jobs\//u.test(path)) return 'sync'
  if (path === '/v1/internal/billing/reconciliation') return 'reconcile'
  if (path === '/v1/internal/image-generation-jobs/reconciliation') return 'reconcile'
  if (/^\/v1\/(?:generation-jobs|internal\/image-generation-jobs|internal\/image-generation-continuations)\//u.test(path)) return 'generation'
  if (/^\/v1\/publish-jobs\/[^/]+\/observation$/u.test(path)) {
    try { return JSON.parse(typeof body === 'string' ? body : Buffer.from(body ?? []).toString('utf8')).source === 'reconcile' ? 'reconcile' : 'publish' } catch { return 'publish' }
  }
  // The publish execution gate is admission-checked for both the publish and
  // the reconcile worker (workerRouteRoles). The caller declares which
  // credential set it actually signs and authenticates with; declaring
  // 'reconcile' only selects that set, it does not grant access — the proof
  // below is computed with the declared role's secret and the API verifies it
  // against the bearer token and signing secret of that same role.
  if (/^\/v1\/publish-jobs\/[^/]+\/execution-check$/u.test(path)) {
    const declaredRole = new URL(requestTarget, 'http://worker.internal').searchParams.get('worker_role')
    return declaredRole === 'reconcile' ? 'reconcile' : 'publish'
  }
  if (/^\/v1\/publish-jobs\//u.test(path)) return 'publish'
  if (/^\/v1\/worker-events\//u.test(path)) {
    const operation = new URL(requestTarget, 'http://worker.internal').searchParams.get('operation')
    if (operation === 'publish.reconcile') return 'reconcile'
    if (operation === 'catalog.sync.execute') return 'sync'
    if (operation === 'asset.scan.execute' || operation === CUSTOMER_DELIVERY_SCAN_OPERATION) return 'scan'
    return 'generation'
  }
  if (path === '/v1/internal/automation/tick' || path === '/v1/ops/data-deletion/complete' || path === '/v1/internal/storage/orphans/cleanup') return 'automation'
  if (path === '/v1/internal/support/sla-scan' || path === '/v1/internal/support/sla-report') return 'reconcile'
  if (path.includes('reconciliation')) return 'reconcile'
  // Knowledge indexing is owned by the automation worker. Its admission,
  // outcome and usage callbacks must use that worker's isolated credential;
  // generation remains accepted server-side only for already-deployed callers.
  if (path === '/v1/internal/knowledge-embeddings/admission' || path === '/v1/internal/knowledge-embeddings/outcome') return 'automation'
  if (path === '/v1/internal/model-usage') {
    try {
      return JSON.parse(typeof body === 'string' ? body : Buffer.from(body ?? []).toString('utf8')).modality === 'embedding' ? 'automation' : 'generation'
    } catch { return 'generation' }
  }
  if (/^\/v1\/assets\/[^/]+\/scan$/u.test(path)) return 'scan'
  throw new Error(`no worker role policy for ${method} ${path}`)
}

async function postSyncProgress(input: { apiBaseUrl: string; apiToken: string; event: DurableOutboxEvent; page: { pageNumber: number; cursor?: string; nextCursor?: string; items: unknown[]; }; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal }) {
  const path = `/v1/sync-jobs/${encodeURIComponent(input.event.aggregateId)}/progress`
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify({ page_number: input.page.pageNumber, ...(input.page.cursor ? { cursor: input.page.cursor } : {}), ...(input.page.nextCursor ? { next_cursor: input.page.nextCursor } : {}), items: input.page.items }), redirect: 'error', signal: input.signal,
  })
  if (!response.ok) throw new Error(`sync progress API returned ${response.status}`)
}

export async function postAutomationTick(input: { apiBaseUrl: string; apiToken: string; workspaceId: string; signingSecret?: string; fetcher?: typeof fetch }) {
  const path = '/v1/internal/automation/tick'
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) }, redirect: 'error',
  })
  if (!response.ok) throw new Error(`automation tick API returned ${response.status}`)
  return await parseWorkerApiJson(response)
}

export async function postObjectOrphanCleanup(input: { apiBaseUrl: string; apiToken: string; workspaceId: string; limit?: number; signingSecret?: string; fetcher?: typeof fetch }) {
  const path = '/v1/internal/storage/orphans/cleanup'
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify({ workspace_id: input.workspaceId, limit: input.limit ?? 100 }), redirect: 'error',
  })
  if (!response.ok) throw new Error(`object orphan cleanup API returned ${response.status}`)
  return await parseWorkerApiJson(response)
}

/** Ask the API to reconcile one workspace. Object-store and database access
 * remain exclusively behind the API's signed workspace boundary. */
export async function postStorageReconciliation(input: { apiBaseUrl: string; apiToken: string; workspaceId: string; signingSecret?: string; fetcher?: typeof fetch; signal?: AbortSignal }) {
  const path = '/v1/internal/storage/reconciliation'
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    redirect: 'error',
    signal: input.signal,
  })
  if (!response.ok) throw new Error(`storage reconciliation API returned ${response.status}`)
  return await parseWorkerApiJson(response)
}

export async function postSupportSlaScan(input: { apiBaseUrl: string; apiToken: string; workspaceId: string; limit?: number; signingSecret?: string; fetcher?: typeof fetch; signal?: AbortSignal }) {
  const workspaceId = input.workspaceId.trim()
  if (!workspaceId) throw new Error('support SLA scan requires workspaceId')
  const limit = input.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('support SLA scan limit must be 1..1000')
  const path = '/v1/internal/support/sla-scan'
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify({ workspace_id: workspaceId, limit }), redirect: 'error', signal: input.signal,
  })
  if (!response.ok) {
    let apiError: { code?: unknown; message?: unknown; details?: { retryable?: unknown } } | undefined
    try { apiError = (await parseWorkerApiJson(response) as { error?: typeof apiError }).error } catch { /* preserve bounded HTTP fallback */ }
    const code = typeof apiError?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(apiError.code) ? apiError.code : 'SUPPORT_SLA_SCAN_FAILED'
    const message = typeof apiError?.message === 'string' && apiError.message.trim() ? apiError.message : `support SLA scan API returned ${response.status}`
    const explicitRetryable = apiError?.details?.retryable
    const retryable = typeof explicitRetryable === 'boolean' ? explicitRetryable : response.status === 429 || response.status >= 500
    throw Object.assign(new Error(message), { code, retryable, unknown: false })
  }
  return await parseWorkerApiJson(response)
}

export async function postSupportSlaReport(input: { apiBaseUrl: string; apiToken: string; workspaceId: string; periodStart: string; periodEnd: string; cutoffAt: string; reportId: string; signingSecret?: string; fetcher?: typeof fetch; signal?: AbortSignal }) {
  const workspaceId = input.workspaceId.trim()
  if (!workspaceId || !input.reportId.trim()) throw new Error('support SLA report requires workspaceId and reportId')
  const path = '/v1/internal/support/sla-report'
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': workspaceId, ...(input.signingSecret ? { 'x-internal-worker-signing-secret': input.signingSecret } : {}) },
    body: JSON.stringify({ workspace_id: workspaceId, period_start: input.periodStart, period_end: input.periodEnd, cutoff_at: input.cutoffAt, report_id: input.reportId }), redirect: 'error', signal: input.signal,
  })
  if (!response.ok) throw new Error(`support SLA report API returned ${response.status}`)
  return await parseWorkerApiJson(response)
}

async function postSyncResult(input: { apiBaseUrl: string; apiToken: string; event: DurableOutboxEvent; state: 'succeeded' | 'partial' | 'failed'; errorMessage?: string; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal }) {
  const path = `/v1/sync-jobs/${encodeURIComponent(input.event.aggregateId)}/result`
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify({ state: input.state, ...(input.errorMessage ? { error_message: input.errorMessage } : {}) }), redirect: 'error', signal: input.signal,
  })
  if (!response.ok) throw new Error(`sync result API returned ${response.status}`)
}

export interface WorkerPollResult {
  restored: number
  processed: number
  succeeded: number
  unknown: number
  queued: number
  deadLetter: number
}

export async function runAutomationMaintenance(input: {
  workspaces: string[]
  tick: (workspaceId: string) => Promise<{ data?: { result?: { executed?: unknown[]; skipReason?: string } } }>
  cleanup: (workspaceId: string) => Promise<{ data?: { cleaned?: number } }>
  onError?: (workspaceId: string, operation: 'automation_tick' | 'object_orphan_cleanup', error: unknown) => void
}): Promise<WorkerPollResult> {
  let executed = 0
  let failures = 0
  for (const workspaceId of input.workspaces) {
    let nativeAutomationOnly = false
    try {
      const response = await input.tick(workspaceId)
      nativeAutomationOnly = response.data?.result?.skipReason === 'codex_native_automations_only'
      executed += Array.isArray(response.data?.result?.executed) ? response.data.result.executed.length : 0
    } catch (error) {
      failures += 1
      input.onError?.(workspaceId, 'automation_tick', error)
    }
    if (!nativeAutomationOnly) {
      try {
        const cleanup = await input.cleanup(workspaceId)
        executed += typeof cleanup.data?.cleaned === 'number' ? cleanup.data.cleaned : 0
      } catch (error) {
        failures += 1
        input.onError?.(workspaceId, 'object_orphan_cleanup', error)
      }
    }
  }
  return { restored: 0, processed: executed, succeeded: executed, unknown: failures, queued: 0, deadLetter: 0 }
}

export async function postPublishObservation(input: {
  apiBaseUrl: string
  apiToken: string
  event: DurableOutboxEvent
  observation: PublishHandlerResult
  fetcher?: typeof fetch
  signingSecret?: string
  signal?: AbortSignal
}): Promise<void> {
  const source = input.event.eventType === 'publish.reconcile_requested' ? 'reconcile' : 'publish'
  const payload = buildPublishObservationRequest(input.observation, { source })
  let response: Response
  try {
    response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}/v1/publish-jobs/${encodeURIComponent(input.event.aggregateId)}/observation`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
      body: JSON.stringify(payload),
      signal: input.signal,
    })
  } catch (error) {
    throw new PublishObservationReportError(error instanceof Error ? error.message : 'publish observation API request failed', { retryable: true })
  }
  if (!response.ok) throw new PublishObservationReportError(`publish observation API returned ${response.status}`, { retryable: response.status >= 500 || response.status === 429 })
}

/** Re-check authorization immediately before a connector write or reconcile.
 * A queued event may outlive an account revoke/re-authorize operation.
 *
 * `role` names the credential set that `apiToken`/`signingSecret` belong to.
 * It is not a privilege claim: the same value drives the `x-worker-role`
 * header and the role signed into the request proof, and the API verifies all
 * three against that role's own configured credentials. A caller that does not
 * actually hold the role's token and signing secret is rejected (403), so
 * declaring 'reconcile' cannot elevate a publish worker. The default keeps
 * every existing publish caller byte-identical. */
export async function assertPublishExecution(input: {
  apiBaseUrl: string
  apiToken: string
  event: DurableOutboxEvent
  fetcher?: typeof fetch
  signingSecret?: string
  role?: 'publish' | 'reconcile'
  signal?: AbortSignal
  production?: boolean
}): Promise<{ credentialRef: string; payloadHash: string; mediaRequired: boolean; authorizationSnapshot?: Record<string, unknown> }> {
  const role = input.role ?? 'publish'
  let response: Response
  try {
    response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}/v1/publish-jobs/${encodeURIComponent(input.event.aggregateId)}/execution-check?event_id=${encodeURIComponent(input.event.id)}${role === 'publish' ? '' : `&worker_role=${role}`}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
      redirect: 'error',
      signal: input.signal,
    })
  } catch (error) {
    input.signal?.throwIfAborted()
    throw new WorkerExecutionAuthorizationError('AUTHZ_EXECUTION_RECHECK_UNAVAILABLE', `publish execution gate unavailable: ${error instanceof Error ? error.message : String(error)}`, { retryable: true })
  }
  if (!response.ok) {
    let apiError: { code?: unknown; message?: unknown } | undefined
    try { apiError = (await parseWorkerApiJson(response) as { error?: typeof apiError }).error } catch { /* retain bounded fallback */ }
    const code = typeof apiError?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(apiError.code) ? apiError.code : 'AUTHZ_EXECUTION_RECHECK_DENIED'
    throw new WorkerExecutionAuthorizationError(code, typeof apiError?.message === 'string' ? apiError.message : `publish execution rejected by authorization gate (${response.status})`, { retryable: response.status === 429 || response.status >= 500 })
  }
  const envelope = await parseWorkerApiJson(response) as { data?: { credential_ref?: string; payload_hash?: string; media_required?: boolean; authorization_snapshot?: unknown } }
  if (typeof envelope.data?.credential_ref !== 'string' || !envelope.data.credential_ref) throw new Error('publish execution gate did not return a credential locator')
  if (typeof envelope.data.payload_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(envelope.data.payload_hash)) throw new Error('publish execution gate did not return a payload hash')
  const snapshot = envelope.data.authorization_snapshot
  const eventSnapshot = input.event.payload.authorization_snapshot
  if (input.production && (!snapshot || !eventSnapshot || JSON.stringify(snapshot) !== JSON.stringify(eventSnapshot))) throw new Error('publish execution gate authorization snapshot is missing or does not match the durable event')
  if (snapshot !== null && snapshot !== undefined && (!eventSnapshot || JSON.stringify(snapshot) !== JSON.stringify(eventSnapshot))) throw new Error('publish execution gate authorization snapshot mismatch')
  return { credentialRef: envelope.data.credential_ref, payloadHash: envelope.data.payload_hash, mediaRequired: envelope.data.media_required === true, ...(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? { authorizationSnapshot: snapshot as Record<string, unknown> } : {}) }
}

export function createApiExecutionAuthorizationGuard(config: Pick<WorkerConfig, 'apiBaseUrl' | 'apiToken' | 'apiSigningSecret'> & Partial<Pick<WorkerConfig, 'workerId'>>, fetcher: typeof fetch = fetch) {
  return createExecutionAuthorizationGuard(async ({ event, operation, signal }) => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for execution authorization recheck')
    const path = operation === 'publish.execute'
      ? `/v1/publish-jobs/${encodeURIComponent(event.aggregateId)}/execution-check?event_id=${encodeURIComponent(event.id)}`
      : `/v1/worker-events/${encodeURIComponent(event.id)}/execution-check?aggregate_id=${encodeURIComponent(event.aggregateId)}&operation=${encodeURIComponent(operation)}`
    const response = await fetchWorkerApi(fetcher, `${config.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${config.apiToken}`, 'x-workspace-id': event.workspaceId, ...(config.apiSigningSecret ? workerAuthIntent(config.apiSigningSecret, config.workerId ?? resolveWorkerId()) : {}) },
      redirect: 'error', signal,
    })
    if (!response.ok) {
      let apiError: { code?: unknown; message?: unknown } | undefined
      try { apiError = (await parseWorkerApiJson(response) as { error?: typeof apiError }).error } catch { /* preserve bounded HTTP fallback */ }
      const denied = response.status === 401 || response.status === 403
      const code = typeof apiError?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(apiError.code)
        ? apiError.code
        : denied ? 'AUTHZ_EXECUTION_RECHECK_DENIED' : 'AUTHZ_EXECUTION_RECHECK_UNAVAILABLE'
      const message = typeof apiError?.message === 'string' && apiError.message.trim()
        ? apiError.message
        : `execution authorization recheck returned ${response.status}`
      throw new WorkerExecutionAuthorizationError(code, message, { retryable: !denied && (response.status === 429 || response.status >= 500) })
    }
    const envelope = await parseWorkerApiJson(response) as { data?: { authorization_recheck?: Record<string, unknown> } }
    const raw = envelope.data?.authorization_recheck
    if (!raw) throw new Error('execution authorization recheck evidence is missing')
    if (!Array.isArray(raw.grant_ids) || raw.grant_ids.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new WorkerExecutionAuthorizationError('AUTHZ_EXECUTION_RECHECK_INVALID', 'execution authorization recheck grant_ids evidence is malformed', { retryable: true })
    }
    return {
      recheckId: String(raw.recheck_id ?? ''), actorId: String(raw.actor_id ?? ''), identityId: String(raw.identity_id ?? ''), workspaceId: String(raw.workspace_id ?? ''), workbench: raw.workbench === 'workspace' ? 'workspace' : '' as 'workspace', contextId: String(raw.context_id ?? ''), contextVersion: String(raw.context_version ?? ''), policyVersion: String(raw.policy_version ?? ''), grantRevision: String(raw.grant_revision ?? ''), grantIds: [...raw.grant_ids] as string[], scopeHash: String(raw.scope_hash ?? ''), capability: String(raw.capability ?? '') as WorkerAuthorizationRecheck['capability'], resourceId: String(raw.resource_id ?? ''), resourceRevision: String(raw.resource_revision ?? ''), requestId: String(raw.request_id ?? ''), traceId: String(raw.trace_id ?? ''), authorized: raw.authorized === true, checkedAt: String(raw.checked_at ?? ''),
    }
  })
}

/** Callback-local preflight (quota, locks, leases and credential reads) can
 * outlive the handler's initial check. Never carry an earlier allow across
 * those waits into a provider call. This does not replace connector-level
 * checks after signing/DNS or between pagination requests. */
export async function executeWorkerProviderAfterPreflight<T>(input: {
  event: DurableOutboxEvent
  operation: CriticalWorkerOperation
  authorization: WorkerExecutionAuthorizationGuard
  preflight: () => Promise<void>
  invoke: () => Promise<T>
  signal?: AbortSignal
}): Promise<T> {
  input.signal?.throwIfAborted()
  await input.preflight()
  input.signal?.throwIfAborted()
  return executeAfterAuthorizationCheck({ guard: input.authorization, event: input.event, operation: input.operation, providerCall: input.invoke, signal: input.signal })
}

export interface WorkerProviderDispatchScope {
  event: DurableOutboxEvent
  operation: CriticalWorkerOperation
  signal?: AbortSignal
  /** Set only after live admission, immediately before transport dispatch.
   * A nonzero count must never be reported as a proven zero-provider abort. */
  providerRequests: number
}

/** Trusted event context follows provider preflight/retries without accepting
 * identity from model input or a caller-controlled URL/header. Read-only
 * provider reconciliation and credential recovery retain their own gates. */
export function createWorkerProviderDispatchAdmission(authorization: WorkerExecutionAuthorizationGuard) {
  const current = new AsyncLocalStorage<WorkerProviderDispatchScope>()
  const check = async (operation: CriticalWorkerOperation, workspaceId?: string, signal?: AbortSignal) => {
    const scope = current.getStore()
    if (!scope || scope.operation !== operation || (workspaceId !== undefined && workspaceId !== scope.event.workspaceId)) {
      throw new WorkerExecutionAuthorizationError('AUTHZ_PROVIDER_CONTEXT_REQUIRED', 'provider dispatch lacks the exact trusted worker event context', { retryable: false })
    }
    scope.signal?.throwIfAborted()
    signal?.throwIfAborted()
    await authorization.assertAuthorized(scope.event, operation, scope.signal ?? signal)
    scope.signal?.throwIfAborted()
    signal?.throwIfAborted()
    scope.providerRequests += 1
  }
  return {
    run: <T>(scope: WorkerProviderDispatchScope, invoke: () => T): T => current.run(scope, invoke),
    beforeModelRequest: async (input: { operation: string; workspaceId?: string; signal?: AbortSignal }) => {
      if (input.operation === 'image_query' || input.operation === 'video_query') return
      const operation = input.operation === 'text_generate' ? 'generation.execute'
        : input.operation === 'image_generate' || input.operation === 'image_edit' ? 'image_generation.execute' : undefined
      if (!operation) throw new WorkerExecutionAuthorizationError('AUTHZ_PROVIDER_OPERATION_INVALID', 'model operation is not registered for this worker', { retryable: false })
      await check(operation, input.workspaceId, input.signal)
    },
    beforeConnectorRequest: async (input: { operation: string; workspaceId?: string; signal?: AbortSignal }) => {
      if (['query_write', 'refresh_credential', 'revoke', 'exchange_code'].includes(input.operation)) return
      const operation = input.operation === 'sync_products' ? 'catalog.sync.execute'
        : ['create_product', 'update_product', 'upload_media'].includes(input.operation) ? 'publish.execute' : undefined
      if (!operation) throw new WorkerExecutionAuthorizationError('AUTHZ_PROVIDER_OPERATION_INVALID', 'connector operation is not registered for this worker', { retryable: false })
      await check(operation, input.workspaceId, input.signal)
    },
  }
}

/** Re-check the immutable commercial quote and reservation after identity /
 * RBAC authorization and immediately before provider I/O. The API owns the
 * ledger transaction; this adapter only consumes signed, current evidence. */
export function createApiCommercialAccessGuard(config: Pick<WorkerConfig, 'apiBaseUrl' | 'apiToken' | 'apiSigningSecret'> & Partial<Pick<WorkerConfig, 'workerId'>>, fetcher: typeof fetch = fetch) {
  return createCommercialAccessGuard(async ({ event, operation, signal }) => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for commercial access recheck')
    const path = operation === 'publish.execute'
      ? `/v1/publish-jobs/${encodeURIComponent(event.aggregateId)}/execution-check?event_id=${encodeURIComponent(event.id)}`
      : `/v1/worker-events/${encodeURIComponent(event.id)}/execution-check?aggregate_id=${encodeURIComponent(event.aggregateId)}&operation=${encodeURIComponent(operation)}`
    const response = await fetchWorkerApi(fetcher, `${config.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${config.apiToken}`, 'x-workspace-id': event.workspaceId, ...(config.apiSigningSecret ? workerAuthIntent(config.apiSigningSecret, config.workerId ?? resolveWorkerId()) : {}) },
      redirect: 'error', signal,
    })
    if (!response.ok) {
      let apiError: { code?: unknown; message?: unknown } | undefined
      try { apiError = (await parseWorkerApiJson(response) as { error?: typeof apiError }).error } catch { /* preserve bounded HTTP fallback */ }
      const denied = response.status === 401 || response.status === 403 || response.status === 409 || response.status === 422
      const code = typeof apiError?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(apiError.code)
        ? apiError.code
        : denied ? 'COMMERCIAL_EXECUTION_DENIED' : 'COMMERCIAL_EXECUTION_RECHECK_UNAVAILABLE'
      const message = typeof apiError?.message === 'string' && apiError.message.trim()
        ? apiError.message
        : `commercial access recheck returned ${response.status}`
      throw new WorkerCommercialAccessError(code, message, !denied && (response.status === 429 || response.status >= 500))
    }
    const envelope = await parseWorkerApiJson(response) as { data?: { commercial_access_recheck?: Record<string, unknown> } }
    const raw = envelope.data?.commercial_access_recheck
    if (!raw) throw new Error('commercial access recheck evidence is missing')
    return {
      recheckId: String(raw.recheck_id ?? ''), workspaceId: String(raw.workspace_id ?? ''), operation: String(raw.operation ?? '') as WorkerCommercialAccessRecheck['operation'],
      accessMode: String(raw.access_mode ?? '') as WorkerCommercialAccessRecheck['accessMode'], accessRevision: String(raw.access_revision ?? ''),
      balanceState: String(raw.balance_state ?? '') as WorkerCommercialAccessRecheck['balanceState'], entitlementSnapshotId: String(raw.entitlement_snapshot_id ?? ''),
      entitlementSnapshotChecksum: String(raw.entitlement_snapshot_checksum ?? ''), rateVersion: raw.rate_version === null ? null : String(raw.rate_version ?? ''), quotedPoints: Number(raw.quoted_points),
      ...(typeof raw.reservation_id === 'string' ? { reservationId: raw.reservation_id } : {}), reservationState: String(raw.reservation_state ?? '') as WorkerCommercialAccessRecheck['reservationState'],
      ...(typeof raw.denial_code === 'string' ? { denialCode: raw.denial_code as WorkerCommercialAccessRecheck['denialCode'] } : {}),
      allowed: raw.allowed === true, ready: raw.ready === true, checkedAt: String(raw.checked_at ?? ''),
    }
  })
}

/** Reuses the signed scan-machine transport while keeping platform admission
 * separate from merchant authorization and point snapshots. */
export function createApiDeliveryScanAdmissionGuard(config: Pick<WorkerConfig, 'apiBaseUrl' | 'apiToken' | 'apiSigningSecret'> & Partial<Pick<WorkerConfig, 'workerId'>>, fetcher: typeof fetch = fetch) {
  return createDeliveryScanAdmissionGuard(async ({ event, signal }) => {
    if (!config.apiBaseUrl || !config.apiToken || !config.apiSigningSecret) throw new DeliveryScanAdmissionError('DELIVERY_SCAN_EXECUTION_RECHECK_UNAVAILABLE', 'delivery scan requires API endpoint and signed machine credentials', true)
    const path = `/v1/worker-events/${encodeURIComponent(event.id)}/execution-check?aggregate_id=${encodeURIComponent(event.aggregateId)}&operation=${encodeURIComponent(CUSTOMER_DELIVERY_SCAN_OPERATION)}`
    const response = await fetchWorkerApi(fetcher, `${config.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${config.apiToken}`, 'x-workspace-id': event.workspaceId, ...workerAuthIntent(config.apiSigningSecret, config.workerId ?? resolveWorkerId()) },
      redirect: 'error', signal,
    })
    if (!response.ok) {
      let apiError: { code?: unknown; message?: unknown } | undefined
      try { apiError = (await parseWorkerApiJson(response) as { error?: typeof apiError }).error } catch { /* preserve bounded HTTP fallback */ }
      const retryable = response.status === 429 || response.status >= 500
      const code = typeof apiError?.code === 'string' && /^DELIVERY_SCAN_[A-Z0-9_]{2,63}$/u.test(apiError.code)
        ? apiError.code : retryable ? 'DELIVERY_SCAN_EXECUTION_RECHECK_UNAVAILABLE' : 'DELIVERY_SCAN_EXECUTION_DENIED'
      throw new DeliveryScanAdmissionError(code, `delivery scan admission API returned ${response.status}`, retryable)
    }
    const envelope = await parseWorkerApiJson(response) as { data?: { delivery_scan_recheck?: unknown } }
    return envelope.data?.delivery_scan_recheck
  })
}

export async function fetchPublishMedia(input: { apiBaseUrl: string; apiToken: string; event: DurableOutboxEvent; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal }) {
  const path = `/v1/publish-jobs/${encodeURIComponent(input.event.aggregateId)}/media`
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    redirect: 'error',
    signal: input.signal,
  })
  if (!response.ok) throw new Error(`publish media API returned ${response.status}`)
  const envelope = await parseWorkerApiJson(response) as { data?: { media?: Array<{ visual_ref?: string; role?: 'main' | 'secondary'; mime_type?: string; sha256?: string; content_base64?: string }> } }
  if (!Array.isArray(envelope.data?.media)) throw new Error('publish media API returned an invalid media list')
  return envelope.data.media.map(item => {
    if (typeof item.visual_ref !== 'string' || (item.role !== 'main' && item.role !== 'secondary') || typeof item.mime_type !== 'string' || !/^image\/[a-z0-9.+-]+$/iu.test(item.mime_type) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(item.sha256) || typeof item.content_base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.content_base64)) throw new Error('publish media API returned an invalid media item')
    const bytes = Buffer.from(item.content_base64, 'base64')
    if (!bytes.length || bytes.length > 15 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== item.sha256.toLowerCase()) throw new Error('publish media API returned media with an invalid size or SHA-256 digest')
    return { visualRef: item.visual_ref, role: item.role, mimeType: item.mime_type, sha256: item.sha256.toLowerCase(), bytes, idempotencyKey: `${input.event.aggregateId}:media:${item.visual_ref}` }
  })
}

async function syncExecutionContext(input: { apiBaseUrl: string; apiToken: string; event: DurableOutboxEvent; signingSecret?: string; signal?: AbortSignal }) {
  const path = `/v1/sync-jobs/${encodeURIComponent(input.event.aggregateId)}/execution-context`
  const response = await fetchWorkerApi(fetch, `${input.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    redirect: 'error',
    signal: input.signal,
  })
  if (!response.ok) throw new Error(`sync execution rejected by authorization gate (${response.status})`)
  const envelope = await parseWorkerApiJson(response) as { data?: { credential_ref?: string } }
  if (typeof envelope.data?.credential_ref !== 'string' || !envelope.data.credential_ref) throw new Error('sync execution gate did not return a credential locator')
  return { credentialRef: envelope.data.credential_ref }
}

export async function postGenerationResult(input: {
  apiBaseUrl: string
  apiToken: string
  event: DurableOutboxEvent
  result: { content?: GeneratedContent; error?: { code: string; message: string } }
  fetcher?: typeof fetch
  signingSecret?: string
  signal?: AbortSignal
}): Promise<void> {
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}/v1/generation-jobs/${encodeURIComponent(input.event.aggregateId)}/result`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify(input.result),
    redirect: 'error',
    signal: input.signal,
  })
  if (!response.ok) throw new Error(`generation result API returned ${response.status}`)
}

export async function postImageGenerationResult(input: { apiBaseUrl: string; apiToken: string; event: DurableOutboxEvent; result: { intent_hash: string; owner_token?: string; provider_request_id?: string; images?: string[]; error?: { code: string; message: string } }; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal }) {
  const result = validateImageGenerationCallbackResult(input.result)
  const path = `/v1/internal/image-generation-jobs/${encodeURIComponent(input.event.aggregateId)}/result`
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify({ event_id: input.event.id, ...result }),
    redirect: 'error',
    signal: input.signal,
  })
  if (!response.ok) throw new Error(`image generation result API returned ${response.status}`)
}

export async function updateImageGenerationExecution(input: { apiBaseUrl: string; apiToken: string; event: DurableOutboxEvent; operation: 'claim' | 'reserve_provider_operation' | 'begin_provider_dispatch' | 'fail_before_provider' | 'provider_started' | 'completed' | 'failed' | 'outcome_unknown'; ownerToken?: string; providerRequestId?: string; errorCode?: string; errorMessage?: string; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal }) {
  const path = `/v1/internal/image-generation-jobs/${encodeURIComponent(input.event.aggregateId)}/execution`
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify({ operation: input.operation, event_id: input.event.id, ...(input.ownerToken ? { owner_token: input.ownerToken } : {}), ...(input.providerRequestId ? { provider_request_id: input.providerRequestId } : {}), ...(input.errorCode ? { error_code: input.errorCode } : {}), ...(input.errorMessage ? { error_message: input.errorMessage } : {}) }),
    redirect: 'error',
    signal: input.signal,
  })
  if (!response.ok) {
    let apiError: { code?: unknown; message?: unknown } | undefined
    try { apiError = (await parseWorkerApiJson(response) as { error?: typeof apiError }).error } catch { /* preserve bounded fallback */ }
    const code = typeof apiError?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(apiError.code) ? apiError.code : undefined
    const workspaceDisabled = code === 'WORKSPACE_DISABLED' || response.status === 423
    if (workspaceDisabled || (code && (code.startsWith('CUSTOMER_DELIVERY_') || code.startsWith('AUTHZ_') || code.startsWith('AUTHORIZATION_'))) || response.status === 401 || response.status === 403) {
      throw new WorkerExecutionAuthorizationError(workspaceDisabled ? 'WORKSPACE_DISABLED' : code ?? 'AUTHZ_EXECUTION_RECHECK_DENIED', typeof apiError?.message === 'string' ? apiError.message : 'image dispatch authorization was rejected', { retryable: !workspaceDisabled && (response.status === 429 || response.status >= 500) })
    }
    throw Object.assign(new Error(`image generation execution API returned ${response.status}`), { code: code ?? (response.status === 409 ? 'IMAGE_GENERATION_EXECUTION_BUSY' : 'IMAGE_GENERATION_EXECUTION_GATE_UNAVAILABLE') })
  }
  const envelope = await parseWorkerApiJson(response) as { data?: { execution?: { ownerToken?: string; providerOperationKey?: string; state?: string; workspaceId?: string; jobId?: string; eventId?: string } } }
  return envelope.data?.execution
}

/** Only a locally proven zero-dispatch authorization rejection may close a
 * reserved lease this way. A transport failure or any prior provider attempt
 * must retain reconciliation semantics, never this known-not-sent transition. */
export async function closeRejectedImageDispatch(input: {
  apiBaseUrl: string; apiToken: string; event: DurableOutboxEvent; ownerToken: string
  providerRequests: number; error: unknown; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal
}): Promise<never> {
  if (!(input.error instanceof WorkerExecutionAuthorizationError) || input.providerRequests !== 0) throw input.error
  try {
    const closed = await updateImageGenerationExecution({ ...input, operation: 'fail_before_provider', errorCode: input.error.code, errorMessage: input.error.message.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 255) || 'Provider dispatch authorization was rejected' })
    if (!closed || closed.state !== 'failed' || closed.workspaceId !== input.event.workspaceId || closed.jobId !== input.event.aggregateId || closed.eventId !== input.event.id) throw new Error('image rejection closure did not return the bound terminal execution')
  } catch {
    throw new WorkerExecutionAuthorizationError('IMAGE_GENERATION_PRE_PROVIDER_CLOSE_UNAVAILABLE', 'Provider was not called, but the rejected execution could not be closed; manual recovery is required', { retryable: false })
  }
  // The durable execution is now terminal. Replaying this old event cannot
  // safely retry its reserved provider key, even if the read failure was 503.
  throw new WorkerExecutionAuthorizationError(input.error.code, input.error.message, { retryable: false })
}

export interface KnowledgeEmbeddingBinding { workspaceId: string; documentId: string; documentRevision: number; contentHash: string; actionId: string; runKey: string }

function knowledgeEmbeddingBody(input: KnowledgeEmbeddingBinding) {
  return { document_id: input.documentId, document_revision: input.documentRevision, content_hash: input.contentHash, action_id: input.actionId, run_key: input.runKey }
}

export async function postKnowledgeEmbeddingAdmission(input: KnowledgeEmbeddingBinding & { apiBaseUrl: string; apiToken: string; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal }) {
  const path = '/v1/internal/knowledge-embeddings/admission'
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify(knowledgeEmbeddingBody(input)), redirect: 'error', signal: input.signal,
  })
  if (!response.ok) throw Object.assign(new Error(`knowledge embedding admission API returned ${response.status}`), { code: response.status === 409 || response.status === 503 ? 'KNOWLEDGE_EMBEDDING_ADMISSION_UNAVAILABLE' : 'KNOWLEDGE_EMBEDDING_ADMISSION_REJECTED' })
  const envelope = await parseWorkerApiJson(response) as { data?: { admitted?: unknown; reservation?: { reservation_key?: unknown; run_key?: unknown; status?: unknown } } }
  const reservation = envelope.data?.reservation
  if (envelope.data?.admitted !== true || !reservation || typeof reservation.reservation_key !== 'string' || !reservation.reservation_key.trim() || reservation.run_key !== input.runKey || !['active', 'settled'].includes(String(reservation.status))) throw Object.assign(new Error('knowledge embedding admission omitted durable reservation evidence'), { code: 'KNOWLEDGE_EMBEDDING_ADMISSION_INVALID' })
  return envelope.data
}

export async function postKnowledgeEmbeddingOutcome(input: KnowledgeEmbeddingBinding & { outcome: 'failed_before_provider' | 'unknown'; apiBaseUrl: string; apiToken: string; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal }) {
  const path = '/v1/internal/knowledge-embeddings/outcome'
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify({ ...knowledgeEmbeddingBody(input), outcome: input.outcome }), redirect: 'error', signal: input.signal,
  })
  if (!response.ok) throw Object.assign(new Error(`knowledge embedding outcome API returned ${response.status}`), { code: 'KNOWLEDGE_EMBEDDING_OUTCOME_UNAVAILABLE', reconciliationRequired: input.outcome === 'unknown' })
  const envelope = await parseWorkerApiJson(response) as { data?: { outcome?: unknown; action_id?: unknown; reconciliation_required?: unknown } }
  if (envelope.data?.outcome !== input.outcome || envelope.data.action_id !== input.actionId || envelope.data.reconciliation_required !== (input.outcome === 'unknown')) throw Object.assign(new Error('knowledge embedding outcome API omitted durable evidence'), { code: 'KNOWLEDGE_EMBEDDING_OUTCOME_INVALID', reconciliationRequired: input.outcome === 'unknown' })
  return envelope.data
}

export async function postModelUsage(input: { apiBaseUrl: string; apiToken: string; usage: RelayUsageRecord; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal }) {
  const workspaceId = input.usage.workspaceId?.trim()
  if (!workspaceId) throw new Error('model usage callback requires workspaceId')
  if (!input.usage.actionId?.trim()) throw new Error('model usage callback requires actionId')
  if (!input.usage.runKey?.trim()) throw new Error('model usage callback requires runKey')
  const usage = input.usage
  for (const [field, value] of [['inputTokens', usage.inputTokens], ['outputTokens', usage.outputTokens], ['totalTokens', usage.totalTokens]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`model usage callback ${field} must be a non-negative safe integer`)
  }
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined && usage.totalTokens !== undefined && usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    throw new Error('model usage callback totalTokens must equal inputTokens plus outputTokens')
  }
  if (usage.costCny !== undefined && (!Number.isFinite(usage.costCny) || usage.costCny < 0)) {
    throw new Error('model usage callback costCny must be a finite non-negative number')
  }
  const path = '/v1/internal/model-usage'
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify(input.usage),
    redirect: 'error',
    signal: input.signal,
  })
  if (!response.ok) {
    let apiError: { code?: unknown; message?: unknown } | undefined
    try {
      const payload = await parseWorkerApiJson(response)
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const candidate = (payload as { error?: unknown }).error
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) apiError = candidate as { code?: unknown; message?: unknown }
      }
    } catch { /* preserve the HTTP fallback when the API response is not JSON */ }
    const apiCode = typeof apiError?.code === 'string' && apiError.code.trim() ? apiError.code.trim() : undefined
    const apiMessage = typeof apiError?.message === 'string' && apiError.message.trim() ? apiError.message.trim() : undefined
    const error = Object.assign(new Error(apiMessage ?? `model usage API returned ${response.status}`), { code: apiCode ?? (response.status === 409 || response.status === 503 ? 'MODEL_USAGE_SETTLEMENT_PENDING' : 'MODEL_USAGE_CALLBACK_REJECTED'), ...(apiCode ? { apiErrorCode: apiCode } : {}) })
    throw error
  }
  const envelope = await parseWorkerApiJson(response) as { data?: { recorded?: unknown } }
  if (envelope.data?.recorded !== true) throw Object.assign(new Error('model usage API omitted settlement evidence'), { code: 'MODEL_USAGE_CALLBACK_REJECTED' })
  return { recorded: true, costEvidence: true } as const
}

export async function postModelUsageReconciliation(input: { apiBaseUrl: string; apiToken: string; workspaceId: string; limit?: number; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal }) {
  const workspaceId = input.workspaceId.trim()
  if (!workspaceId) throw new Error('model usage reconciliation requires workspaceId')
  const limit = input.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('model usage reconciliation limit must be 1..100')
  const path = '/v1/internal/model-usage/reconciliation'
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify({ workspace_id: workspaceId, limit }),
    redirect: 'error',
    signal: input.signal,
  })
  if (!response.ok) throw new Error(`model usage reconciliation API returned ${response.status}`)
  return await parseWorkerApiJson(response)
}

export async function postPaymentReconciliation(input: { apiBaseUrl: string; apiToken: string; workspaceId: string; limit?: number; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal }): Promise<PaymentReconciliationResult> {
  const workspaceId = input.workspaceId.trim()
  if (!workspaceId || /[\u0000-\u001f\u007f]/u.test(workspaceId)) throw new Error('payment reconciliation requires a valid workspaceId')
  const limit = input.limit ?? DEFAULT_PAYMENT_RECONCILIATION_BATCH_SIZE
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('payment reconciliation limit must be 1..20')
  const path = '/v1/internal/billing/reconciliation'
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify({ workspace_id: workspaceId, limit }),
    redirect: 'error',
    signal: input.signal,
  })
  if (!response.ok) throw new Error(`payment reconciliation API returned ${response.status}`)
  const envelope = await parseWorkerApiJson(response) as { data?: unknown }
  if (!isObject(envelope.data) || typeof envelope.data.state !== 'string') throw new Error('payment reconciliation API returned an invalid response')
  return envelope.data as PaymentReconciliationResult
}

export type ImageGenerationReconciliationCandidate = {
  jobId: string
  eventId: string
  intentHash: string
  executionAttempt: number
  queryAttempt?: number
  providerRequestId?: string
  executionState: 'provider_reserved' | 'provider_dispatching' | 'provider_started' | 'outcome_unknown'
  actionId?: string
}

/** Stable per-observation key: replaying the same provider observation is safe,
 * while a changed response at the same query attempt remains a server-side
 * idempotency conflict instead of silently overwriting evidence. */
export function imageReconciliationIdempotencyKey(input: { workspaceId: string; jobId: string; eventId: string; intentHash: string; executionAttempt: number; providerRequestId: string; queryAttempt: number }) {
  const canonical = JSON.stringify({
    version: 1,
    workspace_id: input.workspaceId.trim(),
    job_id: input.jobId.trim(),
    event_id: input.eventId.trim(),
    intent_hash: input.intentHash.trim(),
    execution_attempt: input.executionAttempt,
    provider_request_id: input.providerRequestId.trim(),
    query_attempt: input.queryAttempt,
  })
  return `image-reconcile:${createHash('sha256').update(canonical).digest('hex')}`
}

/**
 * The image reconciliation statuses that end the polling loop. This is a
 * *different* set from the content generation job states
 * (`packages/contracts/src/generation-job-state.ts`): the provider only ever
 * reports `succeeded`, `failed` or `unknown`, and the two are named apart so a
 * terminal-state predicate is never mistaken for the generation job guard.
 */
const IMAGE_RECONCILIATION_FINISHED_STATES = ['succeeded', 'failed'] as const

export function imageReconciliationNextAttemptAt(input: { observedAt: string; state: ImageGenerationReconciliationEvidence['state']; queryAttempt: number }) {
  if ((IMAGE_RECONCILIATION_FINISHED_STATES as readonly string[]).includes(input.state)) return undefined
  const exponent = Math.min(Math.max(input.queryAttempt - 1, 0), 6)
  const delaySeconds = Math.min(3600, (input.state === 'unknown' ? 60 : 30) * 2 ** exponent)
  return new Date(Date.parse(input.observedAt) + delaySeconds * 1000).toISOString()
}

type ImageGenerationReconciliationEvidence = {
  state: 'processing' | 'succeeded' | 'failed' | 'unknown'
  providerRequestId: string
  images?: string[]
  evidence: { observedAt: string; source: 'provider_status'; providerStatus?: string; errorCode?: string; errorMessage?: string }
}

function validateImageGenerationReconciliationEvidence(input: {
  workspaceId: string
  candidate: ImageGenerationReconciliationCandidate
  status: ImageGenerationReconciliationEvidence
}) {
  if (!input.workspaceId.trim()) throw new Error('image reconciliation evidence requires workspaceId')
  if (!input.candidate.jobId.trim()) throw new Error('image reconciliation evidence requires jobId')
  if (!input.candidate.eventId.trim() || !/^[a-f0-9]{64}$/u.test(input.candidate.intentHash)) throw new Error('image reconciliation evidence requires eventId and intentHash')
  if (!Number.isSafeInteger(input.candidate.executionAttempt) || input.candidate.executionAttempt < 1) throw new Error('image reconciliation evidence requires a positive execution attempt')
  const queryAttempt = input.candidate.queryAttempt ?? input.candidate.executionAttempt
  if (!Number.isSafeInteger(queryAttempt) || queryAttempt < 1) throw new Error('image reconciliation evidence requires a positive query attempt')
  const providerRequestId = input.candidate.providerRequestId?.trim() ?? ''
  if (!providerRequestId || providerRequestId.length > 512 || /[\u0000-\u001f\u007f]/u.test(providerRequestId)) throw new Error('image reconciliation evidence requires a valid provider request id')
  if (input.status.providerRequestId !== providerRequestId) throw new Error('image reconciliation status provider request id mismatch')
  if (!['processing', 'succeeded', 'failed', 'unknown'].includes(input.status.state)) throw new Error('image reconciliation status is invalid')
  if (input.status.evidence.source !== 'provider_status' || !Number.isFinite(Date.parse(input.status.evidence.observedAt))) throw new Error('image reconciliation evidence timestamp or source is invalid')
  if (input.status.evidence.providerStatus !== undefined && (typeof input.status.evidence.providerStatus !== 'string' || !input.status.evidence.providerStatus.trim() || input.status.evidence.providerStatus.length > 128 || /[\u0000-\u001f\u007f]/u.test(input.status.evidence.providerStatus))) throw new Error('image reconciliation provider status is invalid')
  const images = input.status.images
  if (input.status.state === 'succeeded') {
    if (!images?.length || images.length > 6 || images.some(image => typeof image !== 'string' || !image.trim() || image.length > 4 * 1024 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(image))) throw new Error('succeeded image reconciliation status requires 1 to 6 valid images')
  } else if (images !== undefined) {
    throw new Error('non-succeeded image reconciliation status cannot contain images')
  }
  return { providerRequestId, images, queryAttempt }
}

export async function postImageGenerationReconciliationStatus(input: {
  apiBaseUrl: string
  apiToken: string
  workspaceId: string
  candidate: ImageGenerationReconciliationCandidate
  status: ImageGenerationReconciliationEvidence
  fetcher?: typeof fetch
  signingSecret?: string
  signal?: AbortSignal
}) {
  const validated = validateImageGenerationReconciliationEvidence(input)
  const path = `/v1/internal/image-generation-jobs/${encodeURIComponent(input.candidate.jobId.trim())}/reconciliation-evidence`
  const responseDigest = createHash('sha256').update(JSON.stringify({ candidate: input.candidate, status: input.status })).digest('hex')
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.workspaceId.trim(), ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify({
      workspace_id: input.workspaceId.trim(), job_id: input.candidate.jobId.trim(), event_id: input.candidate.eventId.trim(), intent_hash: input.candidate.intentHash, execution_attempt: input.candidate.executionAttempt, query_attempt: validated.queryAttempt,
      idempotency_key: imageReconciliationIdempotencyKey({ workspaceId: input.workspaceId, jobId: input.candidate.jobId, eventId: input.candidate.eventId, intentHash: input.candidate.intentHash, executionAttempt: input.candidate.executionAttempt, queryAttempt: validated.queryAttempt, providerRequestId: validated.providerRequestId }),
      provider_request_id: validated.providerRequestId,
      ...(input.candidate.actionId ? { action_ledger_id: input.candidate.actionId } : {}),
      provider_state: input.status.state,
      provider_status: input.status.evidence.providerStatus,
      ...(validated.images ? { images: validated.images } : {}),
      observed_at: input.status.evidence.observedAt,
      ...(input.status.evidence.errorCode ? { error_code: input.status.evidence.errorCode } : {}),
      ...(input.status.evidence.errorMessage ? { error_message: input.status.evidence.errorMessage } : {}),
      ...(imageReconciliationNextAttemptAt({ observedAt: input.status.evidence.observedAt, state: input.status.state, queryAttempt: validated.queryAttempt }) ? { next_attempt_at: imageReconciliationNextAttemptAt({ observedAt: input.status.evidence.observedAt, state: input.status.state, queryAttempt: validated.queryAttempt }) } : {}),
      response_digest: responseDigest,
    }),
    redirect: 'error', signal: input.signal,
  })
  if (!response.ok) throw new Error(`image generation reconciliation status API returned ${response.status}`)
  return parseWorkerApiJson(response)
}

function validateImageReconciliationPageRequest(input: { workspaceId: string; limit?: number; cursor?: string }) {
  const workspaceId = input.workspaceId.trim()
  if (!workspaceId || /[\u0000-\u001f\u007f]/u.test(workspaceId)) throw new Error('image reconciliation requires a valid workspaceId')
  const limit = input.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('image reconciliation limit must be 1..1000')
  if (input.cursor !== undefined && (!input.cursor.trim() || /[\u0000-\u001f\u007f]/u.test(input.cursor))) throw new Error('image reconciliation cursor must be a non-empty safe string')
  return { workspaceId, limit, ...(input.cursor !== undefined ? { cursor: input.cursor.trim() } : {}) }
}

export async function postImageGenerationReconciliation(input: { apiBaseUrl: string; apiToken: string; workspaceId: string; limit?: number; cursor?: string; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal }) {
  const request = validateImageReconciliationPageRequest(input)
  const path = '/v1/internal/image-generation-jobs/reconciliation'
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': request.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify({ workspace_id: request.workspaceId, limit: request.limit, query_only: true, ...('cursor' in request ? { cursor: request.cursor } : {}) }), redirect: 'error', signal: input.signal,
  })
  if (!response.ok) throw new Error(`image generation reconciliation API returned ${response.status}`)
  return parseWorkerApiJson(response)
}

function imageReconciliationCandidates(page: unknown): ImageGenerationReconciliationCandidate[] {
  if (!page || typeof page !== 'object') return []
  const source = page as { pending_executions?: unknown; executions?: unknown; attention?: unknown }
  const seen = new Set<string>()
  return [source.pending_executions, source.executions, source.attention].flatMap(values => Array.isArray(values) ? values : []).flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const item = value as Record<string, unknown>
    const jobId = typeof item.job_id === 'string' ? item.job_id.trim() : ''
    const eventId = typeof item.event_id === 'string' ? item.event_id.trim() : ''
    const intentHash = typeof item.intent_hash === 'string' ? item.intent_hash.trim() : ''
    const providerRequestId = typeof item.provider_request_id === 'string' ? item.provider_request_id.trim() : ''
    const executionState = item.execution_state === 'provider_reserved' || item.execution_state === 'provider_dispatching' || item.execution_state === 'provider_started' || item.execution_state === 'outcome_unknown' ? item.execution_state : undefined
    const executionAttempt = Number(item.execution_attempt ?? item.attempt ?? 0)
    const queryAttempt = Number(item.query_attempt ?? executionAttempt)
    const key = `${jobId}:${eventId}:${intentHash}:${executionAttempt}:${providerRequestId}`
    // Reservation and dispatch fences are pre-provider states. Keep them
    // observable to the API, but never query a Provider without an
    // authoritative request id. Unknown execution states fail closed too.
    if (!jobId || !eventId || !executionState || !/^[a-f0-9]{64}$/u.test(intentHash) || ((executionState === 'provider_started' || executionState === 'outcome_unknown') && !providerRequestId) || !Number.isSafeInteger(executionAttempt) || executionAttempt < 1 || !Number.isSafeInteger(queryAttempt) || queryAttempt < 1 || seen.has(key)) return []
    seen.add(key)
    const actionId = typeof item.action_id === 'string' && item.action_id.trim() ? item.action_id.trim() : undefined
    return [{ jobId, eventId, intentHash, executionAttempt, queryAttempt, ...(providerRequestId ? { providerRequestId } : {}), executionState, ...(actionId ? { actionId } : {}) }]
  })
}

function statusEvidenceFromError(error: unknown): ImageGenerationReconciliationEvidence {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
  const timedOut = error instanceof DOMException && error.name === 'AbortError'
  const errorCode = timedOut ? 'MODEL_PROVIDER_OUTCOME_UNKNOWN' : error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code.slice(0, 128) : 'IMAGE_PROVIDER_STATUS_QUERY_FAILED'
  const providerStatus = timedOut ? 'timeout' : 'query_error'
  return { state: 'unknown', providerRequestId: '', evidence: { observedAt: new Date().toISOString(), source: 'provider_status', providerStatus, errorCode, errorMessage: message }, }
}

async function queryImageProviderStatus(input: { queryStatus: (providerRequestId: string, options?: { signal?: AbortSignal }) => Promise<ImageGenerationStatus>; providerRequestId: string; signal?: AbortSignal; timeoutMs?: number }) {
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 5 * 60 * 1000)) throw new RangeError('image provider status query timeout must be between 1 and 300000 milliseconds')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new DOMException('image provider status query timed out', 'AbortError')), input.timeoutMs ?? 30_000)
  const abort = () => controller.abort(input.signal?.reason)
  if (input.signal?.aborted) controller.abort()
  else input.signal?.addEventListener('abort', abort, { once: true })
  let rejectAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new DOMException('image provider status query aborted', 'AbortError'))
    if (controller.signal.aborted) rejectAbort()
    else controller.signal.addEventListener('abort', rejectAbort, { once: true })
  })
  try { return await Promise.race([input.queryStatus(input.providerRequestId, { signal: controller.signal }), aborted]) }
  finally {
    clearTimeout(timeout)
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
    input.signal?.removeEventListener('abort', abort)
  }
}

export async function reconcileImageGenerationWorkspace(input: Parameters<typeof postImageGenerationReconciliation>[0] & { maxPages?: number; queryStatus?: (providerRequestId: string, options?: { signal?: AbortSignal }) => Promise<ImageGenerationStatus>; queryTimeoutMs?: number }) {
  if (input.maxPages !== undefined && (!Number.isSafeInteger(input.maxPages) || input.maxPages < 1 || input.maxPages > 1000)) throw new RangeError('image reconciliation maxPages must be between 1 and 1000')
  if (input.queryTimeoutMs !== undefined && (!Number.isSafeInteger(input.queryTimeoutMs) || input.queryTimeoutMs < 1 || input.queryTimeoutMs > 5 * 60 * 1000)) throw new RangeError('image provider status query timeout must be between 1 and 300000 milliseconds')
  let cursor: string | undefined
  let pages = 0
  const results: unknown[] = []
  const maxPages = input.maxPages ?? 100
  const queriedCandidates = new Set<string>()
  do {
    const page = await postImageGenerationReconciliation({ ...input, ...(cursor ? { cursor } : {}) }) as { next_cursor?: unknown }
    const candidates = imageReconciliationCandidates(page)
    const statusResults: unknown[] = []
    if (input.queryStatus) for (const candidate of candidates) {
      const providerRequestId = candidate.providerRequestId
      if (!providerRequestId || candidate.executionState === 'provider_reserved' || candidate.executionState === 'provider_dispatching') continue
      const candidateKey = `${candidate.jobId}:${candidate.eventId}:${candidate.intentHash}:${candidate.executionAttempt}:${candidate.providerRequestId}`
      if (queriedCandidates.has(candidateKey)) continue
      queriedCandidates.add(candidateKey)
      let status: ImageGenerationReconciliationEvidence
      try {
        const observed = await queryImageProviderStatus({ queryStatus: input.queryStatus, providerRequestId, signal: input.signal, timeoutMs: input.queryTimeoutMs })
        status = { state: observed.state, providerRequestId: observed.providerRequestId, ...(observed.images ? { images: observed.images } : {}), evidence: observed.evidence }
      } catch (error) {
        status = { ...statusEvidenceFromError(error), providerRequestId }
      }
      statusResults.push(await postImageGenerationReconciliationStatus({ ...input, candidate, status }))
    }
    results.push({ page, queried: candidates.filter(candidate => Boolean(candidate.providerRequestId) && (candidate.executionState === 'provider_started' || candidate.executionState === 'outcome_unknown')).length, statusResults })
    pages += 1
    cursor = typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : undefined
  } while (cursor && pages < maxPages)
  return { pages, completed: !cursor, results }
}

export async function assertGenerationExecution(input: { apiBaseUrl: string; apiToken: string; event: DurableOutboxEvent; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal }) {
  const path = `/v1/generation-jobs/${encodeURIComponent(input.event.aggregateId)}`
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    redirect: 'error',
    signal: input.signal,
  })
  if (!response.ok) throw Object.assign(new Error(`generation execution gate returned ${response.status}`), { code: 'GENERATION_EXECUTION_GATE_UNAVAILABLE' })
  const envelope = await parseWorkerApiJson(response) as { data?: { state?: unknown; taskId?: unknown; task_id?: unknown } }
  const authoritativeTaskId = envelope.data?.taskId ?? envelope.data?.task_id
  if (typeof authoritativeTaskId !== 'string' || authoritativeTaskId !== input.event.payload.task_id) {
    throw Object.assign(new Error('generation execution gate task binding mismatch'), { code: 'GENERATION_EXECUTION_GATE_INVALID' })
  }
  // The state classification is `packages/contracts/src/generation-job-state.ts`'s,
  // shared with the API's write guard: a job whose outcome is already decided
  // (`succeeded` or `failed`) dead-letters the event, and any other state an
  // execution cannot start from is a gate error. Keeping a second list here is
  // what let the worker treat `failed` as terminal while the API treated it as
  // rewritable.
  if (isGenerationJobFinished(envelope.data?.state)) {
    throw Object.assign(new Error(`generation job is already ${String(envelope.data?.state)}`), { code: 'GENERATION_JOB_TERMINAL' })
  }
  if (!isGenerationJobExecutable(envelope.data?.state)) {
    throw Object.assign(new Error('generation execution gate returned an invalid state'), { code: 'GENERATION_EXECUTION_GATE_INVALID' })
  }
}

/** Re-read and validate the API's signed knowledge receipt immediately before
 * text provider dispatch. This is a final read check, not an atomic lock: a
 * concurrent approval/content change may still race after the check. */
export async function assertGenerationKnowledgeExecution(input: { apiBaseUrl: string; apiToken: string; event: DurableOutboxEvent; proof: { attempt: number; providerAttemptKey: string; requestBodySha256: string }; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal }) {
  if (!input.signingSecret?.trim()) throw new GenerationKnowledgeReceiptError('signed knowledge execution recheck is not configured')
  const requestNonce = randomUUID()
  const query = new URLSearchParams({
    aggregate_id: input.event.aggregateId,
    operation: 'generation.execute',
    attempt: String(input.proof.attempt),
    provider_attempt_key: input.proof.providerAttemptKey,
    request_body_sha256: input.proof.requestBodySha256,
    request_nonce: requestNonce,
  })
  const path = `/v1/worker-events/${encodeURIComponent(input.event.id)}/execution-check?${query.toString()}`
  let response: Response
  try {
    response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...workerAuthIntent(input.signingSecret) },
      redirect: 'error',
      signal: input.signal,
    })
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error
    throw new GenerationKnowledgeReceiptError('signed knowledge execution recheck is unavailable')
  }
  if (!response.ok) {
    let apiCode: unknown
    try { apiCode = (await parseWorkerApiJson(response) as { error?: { code?: unknown } }).error?.code } catch { /* keep the fail-closed generic code */ }
    const code = typeof apiCode === 'string' && /^KNOWLEDGE_EXECUTION_[A-Z_]{3,48}$/u.test(apiCode) ? apiCode : 'KNOWLEDGE_EXECUTION_RECHECK_UNAVAILABLE'
    throw Object.assign(new Error(`knowledge execution recheck returned ${response.status}`), { code })
  }

  const envelope = await parseWorkerApiJson(response) as { data?: { knowledge_recheck?: unknown } }
  const rawInput = input.event.payload.input
  const frozenInput = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput as Record<string, unknown> : undefined
  const rawProduct = frozenInput?.product
  const product = rawProduct && typeof rawProduct === 'object' && !Array.isArray(rawProduct) ? rawProduct as Record<string, unknown> : undefined
  const rawKnowledge = frozenInput?.knowledgeContext
  const knowledge = rawKnowledge && typeof rawKnowledge === 'object' && !Array.isArray(rawKnowledge) ? rawKnowledge as Record<string, unknown> : undefined
  const rawDocuments = knowledge?.documents === undefined ? [] : knowledge.documents
  const taskId = input.event.payload.task_id
  const contextHash = input.event.payload.context_hash
  if (!frozenInput || !product || typeof product.id !== 'string' || !product.id
    || typeof taskId !== 'string' || !taskId
    || typeof contextHash !== 'string' || !/^[a-f0-9]{64}$/u.test(contextHash)
    || !Array.isArray(rawDocuments)
    || rawDocuments.some(document => !document || typeof document !== 'object' || Array.isArray(document)
      || typeof (document as Record<string, unknown>).id !== 'string'
      || typeof (document as Record<string, unknown>).title !== 'string'
      || typeof (document as Record<string, unknown>).content !== 'string'
      || !Number.isSafeInteger((document as Record<string, unknown>).revision))
    || contextEnvelopeHash(frozenInput) !== contextHash) {
    throw new GenerationKnowledgeReceiptError('generation event has no valid frozen knowledge scope')
  }
  try {
    return validateGenerationKnowledgeReceipt({
      receipt: envelope.data?.knowledge_recheck,
      eventId: input.event.id,
      aggregateId: input.event.aggregateId,
      workspaceId: input.event.workspaceId,
      taskId,
      productId: product.id,
      contextHash,
      attempt: input.proof.attempt,
      providerAttemptKey: input.proof.providerAttemptKey,
      requestBodySha256: input.proof.requestBodySha256,
      requestNonce,
      documents: rawDocuments as FrozenGenerationKnowledgeDocument[],
    })
  } catch (error) {
    if (error instanceof GenerationKnowledgeReceiptError) throw error
    throw new GenerationKnowledgeReceiptError('signed knowledge execution evidence could not be validated')
  }
}

export async function postGenerationDeferred(input: {
  apiBaseUrl: string
  apiToken: string
  event: DurableOutboxEvent
  retryAfterSeconds: number
  code?: string
  message?: string
  fetcher?: typeof fetch
  signingSecret?: string
  signal?: AbortSignal
}): Promise<void> {
  const path = `/v1/generation-jobs/${encodeURIComponent(input.event.aggregateId)}/defer`
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify({ code: input.code ?? 'QUOTA_EXHAUSTED', message: input.message ?? 'provider quota exhausted; waiting for retry window', retry_after_seconds: input.retryAfterSeconds }),
    redirect: 'error',
    signal: input.signal,
  })
  if (!response.ok) throw new Error(`generation defer API returned ${response.status}`)
}

export async function executeImageGenerationContinuations(input: { apiBaseUrl: string; apiToken: string; signingSecret: string; event: DurableOutboxEvent; fetcher?: typeof fetch; signal?: AbortSignal }) {
  const rawJobIds = input.event.payload.continuation_job_ids
  if (!Array.isArray(rawJobIds) || rawJobIds.length === 0 || rawJobIds.some(value => typeof value !== 'string' || !value)) {
    throw Object.assign(new Error('image continuation event has no valid job ids'), { code: 'IMAGE_CONTINUATION_EVENT_INVALID', retryable: false })
  }
  const jobIds = [...new Set(rawJobIds as string[])]
  const results: unknown[] = []
  for (const jobId of jobIds) {
    input.signal?.throwIfAborted()
    const path = `/v1/internal/image-generation-continuations/${encodeURIComponent(jobId)}/execute`
    const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...workerAuthIntent(input.signingSecret) },
      redirect: 'error',
      signal: input.signal,
    })
    const envelope = await parseWorkerApiJson(response) as { error?: { code?: unknown; message?: unknown; details?: { retryable?: unknown } } | null }
    if (!response.ok) {
      const apiError = envelope.error
      const code = typeof apiError?.code === 'string' ? apiError.code : 'IMAGE_CONTINUATION_API_REJECTED'
      const message = typeof apiError?.message === 'string' ? apiError.message : `image continuation API returned ${response.status}`
      const explicitRetryable = apiError?.details?.retryable
      const retryable = typeof explicitRetryable === 'boolean' ? explicitRetryable : response.status === 429 || response.status >= 500
      throw Object.assign(new Error(message), { code, retryable })
    }
    results.push(envelope)
  }
  return { executed: jobIds.length, results }
}

export async function executeAssetScan(input: {
  apiBaseUrl: string
  apiToken: string
  apiSigningSecret: string
  receiptPrivateKeyPem: string
  receiptKeyId: string
  scannerServiceId: string
  scannerInstanceId: string
  policyVersion: string
  clamavHost: string
  clamavPort: number
  clamavTimeoutMs: number
  clamavMaxFileBytes?: number
  attemptRepository: AssetScanAttemptRepository
  scanner?: Pick<ClamAvScanner, 'version' | 'scan'>
  definitionsMaxAgeSeconds?: number
  now?: () => Date
  event: DurableOutboxEvent
  fetcher?: typeof fetch
  signal?: AbortSignal
  onCallbackAccepted?: (acceptedAt: string) => Promise<void>
}): Promise<{ terminal?: true; verdict?: string; receiptId?: string }> {
  const redrive = input.event.eventType === 'asset.scan_redrive_requested'
  const assetId = typeof input.event.payload.asset_id === 'string' ? input.event.payload.asset_id : input.event.aggregateId
  const expectedKey = input.event.payload.storage_key
  const expectedSha = input.event.payload.sha256
  const expectedSize = input.event.payload.size_bytes
  const expectedSourceRevision = input.event.payload.source_revision
  const maxFileBytes = input.clamavMaxFileBytes ?? DEFAULT_CLAMAV_MAX_FILE_BYTES
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw Object.assign(new Error('asset scanner maximum file size is invalid'), { code: 'ASSET_SCANNER_CONFIG_INVALID', retryable: false })
  if (!assetId || typeof expectedKey !== 'string' || typeof expectedSha !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedSha) || !Number.isSafeInteger(expectedSize)
    || (expectedSourceRevision !== undefined && (!Number.isSafeInteger(expectedSourceRevision) || Number(expectedSourceRevision) < 1))
    || (redrive && expectedSourceRevision === undefined)) throw Object.assign(new Error('asset scan event binding is invalid'), { code: 'ASSET_SCAN_EVENT_INVALID', retryable: false })
  const fetcher = input.fetcher ?? fetch
  const contentPath = `/v1/internal/assets/${encodeURIComponent(assetId)}/scan-content`
  const authHeaders = (method: string, path: string, body?: string | Uint8Array) => ({ authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...createScannerRequestProof({ secret: input.apiSigningSecret, method, requestTarget: path, workspaceId: input.event.workspaceId, body }).headers })
  const callback = async (attempt: AssetScanAttemptRecord) => {
    const subject = attempt.receipt.subject
    if (subject.workspace_id !== input.event.workspaceId || subject.asset_id !== assetId || subject.object_key !== expectedKey || subject.sha256 !== expectedSha || subject.size_bytes !== expectedSize
      || (expectedSourceRevision !== undefined && subject.asset_source_revision !== expectedSourceRevision) || attempt.outboxEventId !== input.event.id) {
      throw Object.assign(new Error('durable asset scan attempt does not match the outbox event'), { code: 'ASSET_SCAN_ATTEMPT_BINDING_INVALID', retryable: false })
    }
    if (attempt.callbackStatus === 'accepted') {
      await input.onCallbackAccepted?.(attempt.callbackAcceptedAt ?? new Date().toISOString())
      return { verdict: attempt.receipt.scan.verdict, receiptId: attempt.receipt.receipt_id }
    }
    await input.attemptRepository.recordCallbackAttempt({ workspaceId: input.event.workspaceId, outboxEventId: input.event.id, assetSourceRevision: attempt.assetSourceRevision, receiptDigest: attempt.receiptDigest })
    const resultPath = `/v1/internal/assets/${encodeURIComponent(assetId)}/scan-result`
    let result: Response
    try {
      result = await fetchWorkerApi(fetcher, `${input.apiBaseUrl.replace(/\/$/u, '')}${resultPath}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', ...authHeaders('POST', resultPath, attempt.callbackBody) }, body: attempt.callbackBody, redirect: 'error', signal: input.signal })
    } catch (error) {
      await input.attemptRepository.recordCallbackFailure({ workspaceId: input.event.workspaceId, outboxEventId: input.event.id, assetSourceRevision: attempt.assetSourceRevision, receiptDigest: attempt.receiptDigest, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    if (!result.ok) {
      let apiError: { code?: unknown; message?: unknown; details?: { retryable?: unknown } } | undefined
      try { apiError = (await parseWorkerApiJson(result) as { error?: typeof apiError }).error } catch { /* Preserve the HTTP fallback for an invalid error envelope. */ }
      const fallbackCode = result.status === 409 ? 'ASSET_SCAN_RECEIPT_CONFLICT' : 'ASSET_SCAN_RESULT_REJECTED'
      const code = typeof apiError?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(apiError.code) ? apiError.code : fallbackCode
      const message = typeof apiError?.message === 'string' && apiError.message.trim() ? apiError.message : `asset scan result API returned ${result.status}`
      const explicitRetryable = apiError?.details?.retryable
      const retryable = typeof explicitRetryable === 'boolean' ? explicitRetryable : result.status === 429 || result.status >= 500
      await input.attemptRepository.recordCallbackFailure({ workspaceId: input.event.workspaceId, outboxEventId: input.event.id, assetSourceRevision: attempt.assetSourceRevision, receiptDigest: attempt.receiptDigest, error: `${code}: ${message}` })
      throw Object.assign(new Error(message), { code, retryable })
    }
    const acceptedAt = new Date().toISOString()
    await input.attemptRepository.markCallbackAccepted({ workspaceId: input.event.workspaceId, outboxEventId: input.event.id, assetSourceRevision: attempt.assetSourceRevision, receiptDigest: attempt.receiptDigest, acceptedAt })
    await input.onCallbackAccepted?.(acceptedAt)
    return { verdict: attempt.receipt.scan.verdict, receiptId: attempt.receipt.receipt_id }
  }

  // A callback response may be lost after the API committed the receipt. The
  // durable row is therefore checked before content fetch or ClamAV access.
  const persisted = await input.attemptRepository.getByOutboxEvent(input.event.workspaceId, input.event.id)
  if (persisted) return callback(persisted)

  if (Number(expectedSize) > maxFileBytes) throw assetScanContentTooLarge(maxFileBytes)

  const content = await fetchWorkerApi(fetcher, `${input.apiBaseUrl.replace(/\/$/u, '')}${contentPath}`, { headers: { accept: 'application/octet-stream', ...authHeaders('GET', contentPath) }, redirect: 'error', signal: input.signal })
  if (!content.ok) {
    let apiError: { code?: unknown; message?: unknown; details?: { retryable?: unknown } } | undefined
    try { apiError = (await parseWorkerApiJson(content) as { error?: typeof apiError }).error } catch { /* preserve bounded HTTP fallback */ }
    const code = typeof apiError?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(apiError.code) ? apiError.code : 'ASSET_SCAN_CONTENT_UNAVAILABLE'
    const message = typeof apiError?.message === 'string' && apiError.message.trim() ? apiError.message : `asset scan content API returned ${content.status}`
    if (content.status === 409 && code === 'ASSET_SCAN_STATE_INVALID') return { terminal: true }
    const explicitRetryable = apiError?.details?.retryable
    const retryable = typeof explicitRetryable === 'boolean' ? explicitRetryable : content.status === 429 || content.status >= 500
    throw Object.assign(new Error(message), { code, retryable })
  }
  const body = await readBoundedAssetScanContent(content, maxFileBytes)
  const actualSha = createHash('sha256').update(body).digest('hex')
  const mimeType = (content.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  const sourceRevision = Number(content.headers.get('x-asset-source-revision'))
  let objectKey = ''
  try { objectKey = decodeURIComponent(content.headers.get('x-asset-object-key') ?? '') } catch { objectKey = '' }
  if (actualSha !== expectedSha || body.byteLength !== expectedSize || objectKey !== expectedKey || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1 || !mimeType
    || (expectedSourceRevision !== undefined && sourceRevision !== expectedSourceRevision)) throw Object.assign(new Error('asset scan content binding mismatch'), { code: 'ASSET_SCAN_CONTENT_BINDING_INVALID', retryable: false })
  input.signal?.throwIfAborted()
  const scanner = input.scanner ?? createClamAvScanner({ host: input.clamavHost, port: input.clamavPort, timeoutMs: input.clamavTimeoutMs })
  const startedAt = input.now?.() ?? new Date()
  const version = await scanner.version()
  const versionEvidence = assertClamAvExecutionAdmission(version, { now: startedAt, definitionsMaxAgeSeconds: input.definitionsMaxAgeSeconds ?? 86_400 })
  const scanned = await scanner.scan(body)
  if (scanned.status === 'error') throw Object.assign(new Error(`clamd scan error: ${scanned.message}`), { code: 'CLAMAV_SCAN_ERROR', retryable: true })
  const now = input.now?.() ?? new Date()
  const receiptId = `scan_${createHash('sha256').update(`${input.event.id}\0${sourceRevision}\0${actualSha}`).digest('hex')}`
  const scanAttemptId = `attempt_${createHash('sha256').update(`${input.event.id}\0${sourceRevision}`).digest('hex')}`
  const receipt = parseAssetScanReceipt({
    schema_version: ASSET_SCAN_RECEIPT_SCHEMA,
    receipt_id: receiptId,
    scan_job_id: input.event.id,
    scan_attempt_id: scanAttemptId,
    issuer: { scanner_service_id: input.scannerServiceId, scanner_instance_id: input.scannerInstanceId, key_id: input.receiptKeyId },
    subject: { workspace_id: input.event.workspaceId, asset_id: assetId, asset_source_revision: sourceRevision, object_key: objectKey, sha256: actualSha, size_bytes: body.byteLength, mime_type: mimeType },
    scan: { verdict: scanned.status === 'clean' ? 'clean' : 'malicious', engine: 'clamav', engine_version: versionEvidence.engineVersion!, definitions_version: versionEvidence.definitionsVersion!, policy_version: input.policyVersion, started_at: startedAt.toISOString(), completed_at: now.toISOString(), findings: scanned.status === 'infected' ? [scanned.signature] : [] },
    issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 5 * 60_000).toISOString(),
  })
  const canonicalReceipt = canonicalAssetScanReceipt(receipt)
  const signature = signAssetScanReceipt(receipt, input.receiptPrivateKeyPem.replace(/\\n/gu, '\n'))
  const attempt = await input.attemptRepository.createOrGet({
    workspaceId: input.event.workspaceId, outboxEventId: input.event.id, assetSourceRevision: sourceRevision,
    canonicalReceipt, signature, receiptDigest: assetScanReceiptDigest(receipt), callbackBody: JSON.stringify({ receipt, signature }),
  })
  return callback(attempt.record)
}

export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the worker')
  const rawWorkspaces = (env.WORKER_WORKSPACES ?? '').trim()
  const autoDiscoverWorkspaces = rawWorkspaces === 'auto' || rawWorkspaces === '*' || env.WORKER_AUTO_DISCOVER === 'true'
  const workspaces = rawWorkspaces.split(',').map(value => value.trim()).filter(value => value && value !== 'auto' && value !== '*')
  if (workspaces.length === 0 && !autoDiscoverWorkspaces) throw new Error('WORKER_WORKSPACES must contain at least one workspace id or be auto')
  const role = parseWorkerRole(env.WORKER_ROLE)
  const apiBaseUrl = env.WORKER_API_BASE_URL?.trim()
  const apiToken = env.WORKER_API_TOKEN?.trim()
  const apiSigningSecret = env.WORKER_API_SIGNING_SECRET?.trim()
  const workerId = resolveWorkerId(env)
  const callbackRole = role === 'all' || role === 'sync' || role === 'generation' || role === 'publish' || role === 'reconcile' || role === 'automation'
  const controlledEnvironment = ['staging', 'preview', 'production'].includes(env.NODE_ENV ?? '')
  if (controlledEnvironment && callbackRole && (!apiBaseUrl || !apiToken || !apiSigningSecret)) {
    throw new Error('controlled-environment callback workers require WORKER_API_BASE_URL, WORKER_API_TOKEN and WORKER_API_SIGNING_SECRET')
  }
  if (controlledEnvironment && (role === 'scan' || role === 'all')) {
    const requiredScanner = ['ASSET_SCANNER_API_TOKEN', 'ASSET_SCANNER_WORKSPACE_SIGNING_SECRET', 'ASSET_SCAN_RECEIPT_KEY_ID', 'CLAMAV_HOST'] as const
    const missing: string[] = requiredScanner.filter(name => !env[name]?.trim())
    if (!assetScanReceiptPrivateKeyPem(env)) missing.push('ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM')
    if (!apiBaseUrl || missing.length) throw new Error(`controlled-environment scan worker configuration missing: ${[...(!apiBaseUrl ? ['WORKER_API_BASE_URL'] : []), ...missing].join(', ')}`)
  }
  const leaseMs = positiveInt(env.WORKER_LEASE_MS, 180_000, 'WORKER_LEASE_MS')
  const aiTimeoutMs = positiveInt(env.AI_TIMEOUT_MS, 90_000, 'AI_TIMEOUT_MS')
  const workerApiTimeoutMs = positiveInt(env.WORKER_API_TIMEOUT_MS, DEFAULT_WORKER_API_TIMEOUT_MS, 'WORKER_API_TIMEOUT_MS')
  const minimumSafeLeaseMs = aiTimeoutMs + workerApiTimeoutMs * 2 + 60_000
  if (env.NODE_ENV === 'production' && leaseMs < minimumSafeLeaseMs) {
    throw new Error(`WORKER_LEASE_MS must be at least ${minimumSafeLeaseMs}ms so an active external operation cannot be reclaimed`)
  }
  return {
    databaseUrl,
    workspaces: [...new Set(workspaces)],
    autoDiscoverWorkspaces,
    pollIntervalMs: positiveInt(env.WORKER_POLL_INTERVAL_MS, 1_000, 'WORKER_POLL_INTERVAL_MS'),
    storageReconciliationIntervalMs: positiveInt(env.STORAGE_RECONCILIATION_INTERVAL_MS, DEFAULT_STORAGE_RECONCILIATION_INTERVAL_MS, 'STORAGE_RECONCILIATION_INTERVAL_MS'),
    paymentReconciliationIntervalMs: positiveInt(env.PAYMENT_RECONCILIATION_INTERVAL_MS, DEFAULT_PAYMENT_RECONCILIATION_INTERVAL_MS, 'PAYMENT_RECONCILIATION_INTERVAL_MS'),
    paymentReconciliationBatchSize: boundedPositiveInt(env.PAYMENT_RECONCILIATION_BATCH_SIZE, DEFAULT_PAYMENT_RECONCILIATION_BATCH_SIZE, 20, 'PAYMENT_RECONCILIATION_BATCH_SIZE'),
    modelUsageReconciliationIntervalMs: positiveInt(env.MODEL_USAGE_RECONCILIATION_INTERVAL_MS, DEFAULT_MODEL_USAGE_RECONCILIATION_INTERVAL_MS, 'MODEL_USAGE_RECONCILIATION_INTERVAL_MS'),
    supportSlaScanIntervalMs: positiveInt(env.SUPPORT_SLA_SCAN_INTERVAL_MS, DEFAULT_SUPPORT_SLA_SCAN_INTERVAL_MS, 'SUPPORT_SLA_SCAN_INTERVAL_MS'),
    supportSlaReportIntervalMs: positiveInt(env.SUPPORT_SLA_REPORT_INTERVAL_MS, DEFAULT_SUPPORT_SLA_REPORT_INTERVAL_MS, 'SUPPORT_SLA_REPORT_INTERVAL_MS'),
    imageGenerationReconciliationIntervalMs: positiveInt(env.IMAGE_GENERATION_RECONCILIATION_INTERVAL_MS, DEFAULT_MODEL_USAGE_RECONCILIATION_INTERVAL_MS, 'IMAGE_GENERATION_RECONCILIATION_INTERVAL_MS'),
    workerApiTimeoutMs,
    automationIntervalMs: positiveInt(env.WORKER_AUTOMATION_INTERVAL_MS, 30_000, 'WORKER_AUTOMATION_INTERVAL_MS'),
    batchSize: positiveInt(env.WORKER_BATCH_SIZE, 100, 'WORKER_BATCH_SIZE'),
    workspaceBatchSize: positiveInt(env.WORKER_WORKSPACE_BATCH_SIZE, 10, 'WORKER_WORKSPACE_BATCH_SIZE'),
    leaseMs,
    queueMaxDepth: positiveInt(env.WORKER_QUEUE_MAX_DEPTH, DEFAULT_QUEUE_MAX_DEPTH, 'WORKER_QUEUE_MAX_DEPTH'),
    once: env.WORKER_ONCE === 'true',
    role,
    environment: env.NODE_ENV === 'production' ? 'production' : 'non-production',
    ...(apiBaseUrl ? { apiBaseUrl: apiBaseUrl.replace(/\/$/, '') } : {}),
    ...(apiToken ? { apiToken } : {}),
    ...(apiSigningSecret ? { apiSigningSecret } : {}),
    workerId,
    platformQuotaPerMinute: positiveInt(env.WORKER_PLATFORM_QUOTA_PER_MINUTE, 60, 'WORKER_PLATFORM_QUOTA_PER_MINUTE'),
    modelQuotaPerMinute: positiveInt(env.WORKER_MODEL_QUOTA_PER_MINUTE, 60, 'WORKER_MODEL_QUOTA_PER_MINUTE'),
    dependencyCheckIntervalMs: positiveInt(env.WORKER_DEPENDENCY_CHECK_INTERVAL_MS, DEFAULT_WORKER_DEPENDENCY_CHECK_INTERVAL_MS, 'WORKER_DEPENDENCY_CHECK_INTERVAL_MS'),
    scanMaxAttempts: positiveInt(env.WORKER_SCAN_MAX_ATTEMPTS, 12, 'WORKER_SCAN_MAX_ATTEMPTS'),
    scanRetryBaseMs: positiveInt(env.WORKER_SCAN_RETRY_BASE_MS, 5_000, 'WORKER_SCAN_RETRY_BASE_MS'),
    scanRetryMaxMs: positiveInt(env.WORKER_SCAN_RETRY_MAX_MS, 900_000, 'WORKER_SCAN_RETRY_MAX_MS'),
    clamavMaxFileBytes: positiveInt(env.CLAMAV_MAX_FILE_BYTES, DEFAULT_CLAMAV_MAX_FILE_BYTES, 'CLAMAV_MAX_FILE_BYTES'),
    metricsPort: workerMetricsPort(env.WORKER_METRICS_PORT),
    metricsHost: env.WORKER_METRICS_HOST?.trim() || WORKER_METRICS_DEFAULT_HOST,
  }
}

export async function pollOnce(
  repository: PostgresOutboxRepository,
  dispatchers: Map<string, DurableOutboxDispatcher<DurableOutboxEvent>>,
  config: Pick<WorkerConfig, 'workspaces' | 'batchSize' | 'leaseMs'> & { role?: WorkerRole; workspaceBatchSize?: number; scanMaxAttempts?: number; scanRetryBaseMs?: number; scanRetryMaxMs?: number; claimAdmission?: () => boolean | Promise<boolean>; claimFor?: () => { eventTypes?: readonly string[]; snapshotEntityTypes?: readonly string[] } | undefined },
  queueFactory: (workspaceId: string) => QueuePort<DurableOutboxEvent> = () => new InMemoryQueue<DurableOutboxEvent>(),
  handlerOptions: Parameters<typeof createOutboxHandler>[0] = {},
): Promise<WorkerPollResult> {
  const result: WorkerPollResult = { restored: 0, processed: 0, succeeded: 0, unknown: 0, queued: 0, deadLetter: 0 }
  // Round-robin over workspace-scoped queues. The global batch cap is enforced
  // across all tenants, and each tenant claims only the item it will execute.
  let remaining = config.batchSize
  let round = 0
  while (remaining > 0 && config.workspaces.length > 0) {
    let roundProcessed = 0
    for (let offset = 0; offset < config.workspaces.length && remaining > 0; offset += 1) {
      // Rotate the first tenant between rounds so a remainder does not always
      // go to the first configured workspace.
      const workspaceId = config.workspaces[(round + offset) % config.workspaces.length]!
      let dispatcher = dispatchers.get(workspaceId)
      if (!dispatcher) {
        dispatcher = new DurableOutboxDispatcher(
          repository,
          queueFactory(workspaceId),
          createOutboxHandler({ projection: createWorkerProjection(), ...handlerOptions }),
          { leaseMs: config.leaseMs, claim: config.role && config.role !== 'all' && config.role !== 'automation' ? workerRouting[config.role] : undefined, ...(config.claimFor ? { claimFor: config.claimFor } : {}), ...(config.role === 'scan' ? { maxAttempts: config.scanMaxAttempts ?? 12, baseDelayMs: config.scanRetryBaseMs ?? 5_000, maxDelayMs: config.scanRetryMaxMs ?? 900_000 } : {}), onDispatch: emitWorkerDispatchLog },
        )
        dispatchers.set(workspaceId, dispatcher)
      }
      // Claim immediately before execution. Prefetching a batch starts every
      // database lease at once and lets later slow jobs expire in the queue.
      if (config.claimAdmission && !await config.claimAdmission()) return result
      const allowance = 1
      result.restored += await dispatcher.restore(workspaceId, allowance)
      const events = await dispatcher.dispatchUntilIdle(allowance)
      result.processed += events.length
      remaining -= events.length
      roundProcessed += events.length
      for (const event of events) {
        if (event.state === 'succeeded') result.succeeded += 1
        if (event.state === 'unknown') result.unknown += 1
        if (event.state === 'queued') result.queued += 1
        if (event.state === 'dead_letter') result.deadLetter += 1
      }
    }
    if (roundProcessed === 0) break
    round += 1
  }
  return result
}

export async function scannerOperationalMetrics(pool: SqlPool, workspaceIds: readonly string[], scanMaxAttempts: number): Promise<{ backlog: number; deadLetter: number; lastCallbackAcceptedAt?: string; oldestPendingAt?: string }> {
  let backlog = 0
  let deadLetter = 0
  let lastCallbackAcceptedAt: string | undefined
  let oldestPendingAt: string | undefined
  for (let offset = 0; offset < workspaceIds.length; offset += 10) {
    const rows = await Promise.all(workspaceIds.slice(offset, offset + 10).map(workspaceId => withWorkspaceTransaction(pool, workspaceId, async client => {
      const result = await client.query<{ backlog: number | string; dead_letter: number | string; last_callback_accepted_at: Date | string | null; oldest_pending_at: Date | string | null }>(
        `SELECT
           count(*) FILTER (WHERE event.published_at IS NULL
             AND event.unknown_at IS NULL
             AND (event.last_error IS NULL OR (event.last_error->'retryable' = 'true'::jsonb
               AND COALESCE(event.last_error->'unknown', 'false'::jsonb) = 'false'::jsonb))
             AND COALESCE(event.last_error->>'terminal', 'false') <> 'true')::integer AS backlog,
           -- Same predicate as the backlog count, so the reported age always
           -- belongs to a row that is actually counted as backlog.
           min(event.created_at) FILTER (WHERE event.published_at IS NULL
             AND event.unknown_at IS NULL
             AND (event.last_error IS NULL OR (event.last_error->'retryable' = 'true'::jsonb
               AND COALESCE(event.last_error->'unknown', 'false'::jsonb) = 'false'::jsonb))
             AND COALESCE(event.last_error->>'terminal', 'false') <> 'true') AS oldest_pending_at,
           count(*) FILTER (WHERE event.last_error IS NOT NULL
             AND (event.last_error->>'terminal'='true' OR (event.published_at IS NOT NULL
               AND (event.last_error->>'retryable'='false' OR event.attempts >= $3)))
             AND EXISTS (
               SELECT 1 FROM business_entity_snapshots snapshot
                WHERE snapshot.workspace_id=event.workspace_id
                  AND snapshot.entity_type='asset'
                  AND snapshot.entity_id=event.payload->>'asset_id'
                  AND snapshot.payload->>'scanStatus'='quarantined'
               ))::integer AS dead_letter,
           max(attempt.callback_accepted_at) AS last_callback_accepted_at
         FROM outbox_events event
         LEFT JOIN asset_scan_attempts attempt ON attempt.workspace_id=event.workspace_id AND attempt.outbox_event_id=event.id
         WHERE event.workspace_id=$1 AND event.event_type=ANY($2::text[])`,
        [workspaceId, workerRouting.scan.eventTypes, scanMaxAttempts],
      )
      return result.rows[0]
    })))
    for (const row of rows) {
      backlog += Number(row?.backlog ?? 0)
      deadLetter += Number(row?.dead_letter ?? 0)
      const acceptedAt = row?.last_callback_accepted_at instanceof Date ? row.last_callback_accepted_at.toISOString() : row?.last_callback_accepted_at ? String(row.last_callback_accepted_at) : undefined
      if (acceptedAt && (!lastCallbackAcceptedAt || acceptedAt > lastCallbackAcceptedAt)) lastCallbackAcceptedAt = acceptedAt
      // The oldest pending row is the minimum across every workspace, matching
      // the tenant-wide meaning of the summed backlog it is reported beside.
      const pendingAt = row?.oldest_pending_at instanceof Date ? row.oldest_pending_at.toISOString() : row?.oldest_pending_at ? String(row.oldest_pending_at) : undefined
      if (pendingAt && (!oldestPendingAt || pendingAt < oldestPendingAt)) oldestPendingAt = pendingAt
    }
  }
  return { backlog, deadLetter, ...(lastCallbackAcceptedAt ? { lastCallbackAcceptedAt } : {}), ...(oldestPendingAt ? { oldestPendingAt } : {}) }
}

/**
 * Projects the durable scan-queue counters onto the exported series. The age is
 * reported as 0 when nothing is pending so the series always exists once the
 * scan role has probed: an absent series is indistinguishable from a rule that
 * was never configured.
 */
export function scannerQueueObservation(metrics: { backlog: number; deadLetter: number; oldestPendingAt?: string }): { backlog: number; deadLetter: number; oldestPendingAgeSeconds?: number } {
  const oldestPendingMs = metrics.oldestPendingAt ? Date.parse(metrics.oldestPendingAt) : Number.NaN
  return {
    backlog: metrics.backlog,
    deadLetter: metrics.deadLetter,
    ...(Number.isFinite(oldestPendingMs) && metrics.backlog > 0 ? { oldestPendingAgeSeconds: Math.max(0, (Date.now() - oldestPendingMs) / 1000) } : {}),
  }
}

/**
 * Refresh the scan-role queue gauges from the durable aggregate.
 *
 * A read failure is never dressed up as a reading. Two failure modes were
 * possible here and both are wrong: swallowing the error and keeping the
 * previous observation serves a stale backlog as a current one (a backlog that
 * started failing to refresh reads as a healthy, unchanged queue), and
 * publishing a fresh `0` would claim an empty queue that was never observed.
 * The contract used here is the one the API already applies to
 * `merchant_job_queue_metrics_reads_total`: withhold the affected gauge family,
 * count the read outcome, and report the error. That leaves `no data` (which
 * the backlog rule's dependency note already covers) plus an explicit
 * `outcome="failed"` signal, instead of a number nobody can trust.
 *
 * Returns whether the read succeeded; the caller decides how loud to be about
 * the failure. The error is reported through `onFailure` rather than thrown so
 * a metrics refresh can never abort the worker loop that owns real work.
 */
export async function refreshScanQueueMetrics(input: {
  pool: SqlPool
  workspaces: readonly string[] | Promise<readonly string[]>
  scanMaxAttempts: number
  metrics: Pick<WorkerMetricsRegistry, 'recordScannerQueue' | 'recordScannerQueueReadFailure'>
  onFailure: (error: { message: string; code?: string }) => void
}): Promise<boolean> {
  try {
    const metrics = await scannerOperationalMetrics(input.pool, await input.workspaces, input.scanMaxAttempts)
    input.metrics.recordScannerQueue(scannerQueueObservation(metrics))
    return true
  } catch (error) {
    input.metrics.recordScannerQueueReadFailure()
    input.onFailure(serializeError(error))
    return false
  }
}

/**
 * `options` exists for one caller - the test that pins the loop's side of the
 * ready-file heartbeat. The shipped cadence is `READY_FILE_HEARTBEAT_MS` (30s),
 * which no unit test can wait out, and without an observable cadence nothing
 * would notice the arming below being dropped: the marker would go stale during
 * every slow cycle again, which is the restart loop #29 fixed. No production
 * path passes it.
 */
export async function runWorker(config: WorkerConfig, pool: Pool, options: { readyFileHeartbeatIntervalMs?: number; redisClientFactory?: (url: string) => RedisClientType } = {}): Promise<void> {
  const repository = new PostgresOutboxRepository(pool as unknown as SqlPool)
  const dispatchers = new Map<string, DurableOutboxDispatcher<DurableOutboxEvent>>()
  // `redisClientFactory` is the same seam the transports already accept, threaded
  // through so the loop's own evidence can drive it with a socket that never
  // answers. No production path passes it.
  const redisConnection = process.env.REDIS_URL?.trim() ? await connectRedisQueue(process.env.REDIS_URL.trim(), { maxDepth: config.queueMaxDepth, ...(options.redisClientFactory ? { clientFactory: options.redisClientFactory } : {}) }) : undefined
  const quotaConnection = await createQuotaCounterStore(process.env.REDIS_URL, options.redisClientFactory ? { clientFactory: options.redisClientFactory } : {})
  const quotaAdmission = new FixedWindowQuotaAdmission(quotaConnection.store)
  const executionAuthorization = createApiExecutionAuthorizationGuard(config)
  const providerDispatchAdmission = createWorkerProviderDispatchAdmission(executionAuthorization)
  const commercialAccess = createApiCommercialAccessGuard(config)
  const deliveryScanAdmission = createApiDeliveryScanAdmissionGuard(config)
  const queueFactory = redisConnection
    ? (workspaceId: string) => new RedisQueueAdapter<DurableOutboxEvent>(redisConnection.transport, workerQueueKey(config.role, workspaceId))
    : undefined
  const mappingExecution = new WorkerMappingExecutionContext()
  const mappingApprovals = new PostgresMappingPreflightApprovalRepository(pool as unknown as SqlPool)
  const sqlPool = pool as unknown as SqlPool
  const onboardingGrantDispatch = new PostgresOnboardingGrantDispatchRepository(sqlPool)
  const scanAttempts = new PostgresAssetScanAttemptRepository(sqlPool)
  const creativePointSettlement = new CreativePointRelaySettlement(new PostgresCreativePointRepository(sqlPool), new PostgresCreativePointLifecycleRepository(sqlPool), relayProviderIdentity(process.env))
  const knowledgeRepository = new PostgresKnowledgeRepository(sqlPool)
  const relayPricing = createRelayPricingClientFromEnv(process.env)
  // Share the OAuth refresh single-flight across replicas; without it the
  // publish and reconcile pods each serialize only against themselves and can
  // rotate the same refresh token concurrently.
  // Only the roles that actually talk to a platform need the cross-replica
  // refresh lock; creating it unconditionally opened a second Redis connection
  // for every worker process, including the automation and scan roles.
  const connectorRole = config.role === 'all' || config.role === 'sync' || config.role === 'publish' || config.role === 'reconcile'
  const credentialRefresh = connectorRole ? createRedisCredentialRefreshLock(process.env.REDIS_URL) : undefined
  const runtime = new ConnectorRuntime({
    configSource: process.env,
    ...(credentialRefresh ? { refreshLock: credentialRefresh.lock } : {}),
    beforeRequest: providerDispatchAdmission.beforeConnectorRequest,
    capabilityEvidenceTrust: (() => {
      const evidencePath = process.env.CAPABILITY_EVIDENCE_PATH?.trim()
      if (process.env.NODE_ENV !== 'production' || !evidencePath) return undefined
      try {
        return {
          documentJson: readFileSync(evidencePath, 'utf8'),
          publicKeyPem: readFileSync('/run/release-security/evidence-trust/production-evidence-public.pem', 'utf8'),
          trustedKeyId: readFileSync('/run/release-security/evidence-trust/production-evidence-key-id', 'utf8').trim(),
        }
      } catch { return undefined }
    })(),
    credentialProvider: createVaultCredentialProviderFromEnv(),
    mappingPreflight: createPersistentWorkerMappingPreflightAdapter({ approvals: mappingApprovals, scopes: createPostgresWorkerMappingScopeLoader(pool), execution: mappingExecution }),
  })
  const generationUsageContexts = new Map<string, { runKey: string; contextHash: string; contextLinkId?: string; taskId: string; campaignItemId?: string; event: DurableOutboxEvent; providerRequestIds: string[]; signal?: AbortSignal }>()
  const imageUsageContexts = new Map<string, { runKey: string; contextHash: string; event: DurableOutboxEvent; signal?: AbortSignal; providerRequestId?: string }>()
  const contentGenerator = createContentGeneratorFromEnv(process.env, async usage => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for model usage settlement')
    const execution = usage.actionId ? generationUsageContexts.get(usage.actionId) : undefined
    const enriched = execution ? { ...usage, runKey: execution.runKey, contextHash: execution.contextHash, ...(execution.contextLinkId ? { contextLinkId: execution.contextLinkId } : {}), metadata: { ...(usage.metadata ?? {}), task_id: execution.taskId, campaign_item_id: execution.campaignItemId ?? null } } : usage
    if (execution) {
      const providerRequestId = await creativePointSettlement.recordSucceeded(execution.event, enriched)
      if (providerRequestId) execution.providerRequestIds.push(providerRequestId)
    }
    return postModelUsage({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, usage: enriched, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal: execution?.signal })
  }, providerDispatchAdmission.beforeModelRequest)
  const knowledgeVectorIndexEnabled = process.env.KNOWLEDGE_VECTOR_INDEX_ENABLED?.trim() === 'true'
  const embeddingVersion = process.env.EMBEDDING_VERSION?.trim()
  const embeddingClient = knowledgeVectorIndexEnabled ? createEmbeddingClientFromEnv(process.env, async usage => {
    if (!config.apiBaseUrl || !config.apiToken || !config.apiSigningSecret) throw Object.assign(new Error('signed worker API configuration is required for embedding usage settlement'), { code: 'KNOWLEDGE_EMBEDDING_CONTRACT_MISSING' })
    return postModelUsage({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, signingSecret: config.apiSigningSecret, usage })
  }) : undefined
  if (knowledgeVectorIndexEnabled && (!embeddingClient || !embeddingVersion || !config.apiBaseUrl || !config.apiToken || !config.apiSigningSecret)) {
    throw Object.assign(new Error('enabled knowledge vector indexing requires relay, embedding version, and signed worker API configuration'), { code: 'KNOWLEDGE_EMBEDDING_CONTRACT_MISSING' })
  }
  const imageGenerator = createImageGeneratorFromEnv(process.env, async usage => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for image model usage settlement')
    const execution = usage.actionId ? imageUsageContexts.get(usage.actionId) : undefined
    if (execution && usage.providerRequestId) execution.providerRequestId = usage.providerRequestId
    let enriched = execution ? { ...usage, runKey: execution.runKey, contextHash: execution.contextHash, metadata: { ...(usage.metadata ?? {}), image_job: true } } : usage
    if (enriched.costCny === undefined && relayPricing) {
      const quote = await relayPricing.quote(enriched)
      enriched = { ...enriched, costCny: quote.costCny, metadata: { ...(enriched.metadata ?? {}), ...quote.metadata } }
      imageWorkerTrace('usage.cost_derived', {
        action_id: enriched.actionId ?? null,
        provider_request_id: enriched.providerRequestId ?? enriched.providerAttemptId ?? null,
        model: enriched.model,
        cost_cny: quote.costCny,
        cost_source: quote.metadata.cost_source,
        pricing_version: quote.metadata.pricing_version,
        pricing_group: quote.metadata.pricing_group,
        formula_version: quote.metadata.formula_version,
      })
    }
    if (execution) await creativePointSettlement.recordSucceeded(execution.event, enriched, 'image_generation.execute')
    return postModelUsage({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, usage: enriched, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal: execution?.signal })
  }, providerDispatchAdmission.beforeModelRequest)
  const requireImageProviderRequestId = (actionId: string) => {
    const providerRequestId = imageUsageContexts.get(actionId)?.providerRequestId?.trim()
    if (!providerRequestId) throw Object.assign(new Error('image provider response did not expose a real provider request id'), { code: 'IMAGE_PROVIDER_REQUEST_ID_MISSING', retryable: false, unknown: true })
    return providerRequestId
  }
  const scanRoleEnabled = config.role === 'scan' || config.role === 'all'
  // Hoisted to runWorker scope: the scan heartbeat block and the metrics
  // refresh in the poll loop both need the same workspace scope resolution.
  const currentWorkspaces = async () => config.autoDiscoverWorkspaces ? await repository.listActiveWorkspaceIds() : config.workspaces
  const clamavHost = process.env.CLAMAV_HOST?.trim() || '127.0.0.1'
  const clamavPort = positiveInt(process.env.CLAMAV_PORT, 3310, 'CLAMAV_PORT')
  const clamavTimeoutMs = positiveInt(process.env.ASSET_SCANNER_TIMEOUT_MS, 90_000, 'ASSET_SCANNER_TIMEOUT_MS')
  const clamavReadiness = scanRoleEnabled ? createClamAvScanner({ host: clamavHost, port: clamavPort, timeoutMs: Math.min(clamavTimeoutMs, 10_000) }) : undefined
  if (scanRoleEnabled && !redisConnection) throw new Error('scan worker requires REDIS_URL for distributed heartbeat and readiness evidence')
  const publishRequested = async (event: DurableOutboxEvent, _projection: unknown, signal?: AbortSignal): Promise<PublishHandlerResult> => {
    signal?.throwIfAborted()
    const payload = event.payload
    const platform = payload.platform
    const accountId = payload.account_id
    const fields = payload.fields
    if (!['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'].includes(String(platform)) || typeof accountId !== 'string' || !accountId || !isObject(fields)) {
      throw new Error('publish event is missing platform, account_id or fields')
    }
    requirePublishExecutionConfig(config)
    await quotaAdmission.admit(quotaAdmissionForEvent(event, 'platform', `${String(platform)}:${accountId}`, config.platformQuotaPerMinute))
    const execution = config.apiBaseUrl && config.apiToken ? await assertPublishExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), production: config.environment === 'production', signal }) : undefined
    if (execution && payload.payload_hash !== execution.payloadHash) throw new Error('publish event payload hash does not match the frozen publish job')
    const media = execution?.mediaRequired && config.apiBaseUrl && config.apiToken ? await fetchPublishMedia({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal }) : undefined
    const remoteId = resolvePublishRemoteId(payload)
    const lockKey = publishLockKey({ workspaceId: event.workspaceId, platform: String(platform), accountId, remoteId, aggregateId: event.aggregateId })
    const idempotencyKey = publishIdempotencyKey(event)
    try {
      return await quotaConnection.lock.run(lockKey, () => mappingExecution.run(event, async () => {
        let currentExecution = execution
        return executeWorkerProviderAfterPreflight({
          event, operation: 'publish.execute', authorization: executionAuthorization, signal,
          preflight: async () => {
            // Resolve the credential again inside the lock. Neither the
            // lock wait nor fetching media may preserve an earlier allow.
            if (config.apiBaseUrl && config.apiToken) currentExecution = await assertPublishExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), production: config.environment === 'production', signal })
            if (currentExecution && payload.payload_hash !== currentExecution.payloadHash) throw new WorkerExecutionAuthorizationError('AUTHZ_EXECUTION_RESOURCE_STALE', 'publish event payload hash no longer matches the frozen job', { retryable: false })
          },
          invoke: () => providerDispatchAdmission.run({ event, operation: 'publish.execute', signal, providerRequests: 0 }, () => runtime.executePublish({
            platform: platform as 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin',
            context: { workspaceId: event.workspaceId, accountId, ...(currentExecution ? { credentialRef: currentExecution.credentialRef } : {}), ...workerTraceContext(event), signal },
            fields,
            ...(media?.length ? { media } : {}),
            ...(remoteId ? { remoteId } : {}),
            // A platform may commit just before transport cancellation.
            // Preserve this stable key for an uncertain committed write.
            idempotencyKey,
          })),
        })
      }))
    } catch (error) {
      if (error instanceof DistributedLockBusyError) throw { normalized: { code: error.code, message: error.message, retryable: true, unknown: false } }
      if (error instanceof ConnectorMappingPreflightError) throw { normalized: { code: 'MAPPING_PREFLIGHT_BLOCKED', message: error.message, retryable: false, unknown: false } }
      throw error
    }
  }
  const reconcileRequested = async (event: DurableOutboxEvent, _projection: unknown, signal?: AbortSignal): Promise<PublishHandlerResult> => {
    signal?.throwIfAborted()
    const payload = event.payload
    const platform = payload.platform
    const accountId = payload.account_id
    if (!['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'].includes(String(platform)) || typeof accountId !== 'string' || !accountId) throw new Error('reconcile event is missing platform or account_id')
    if (typeof payload.payload_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.payload_hash)) throw new Error('reconcile event is missing a valid payload hash')
    requirePublishExecutionConfig(config)
    await quotaAdmission.admit(quotaAdmissionForEvent(event, 'platform', `${String(platform)}:${accountId}:reconcile`, config.platformQuotaPerMinute))
    const execution = config.apiBaseUrl && config.apiToken ? await assertPublishExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), role: 'reconcile', production: config.environment === 'production', signal }) : undefined
    if (execution && payload.payload_hash !== execution.payloadHash) throw new Error('publish event payload hash does not match the frozen publish job')
    // A publish-job id is an internal tenant-scoped identifier, not a platform
    // remote id. When the initial publish only returned a request id, let the
    // connector resolve the write by the stable idempotency key instead of
    // querying a fabricated platform id.
    const remoteId = resolvePublishRemoteId(payload)
    // Must match the publish handler's key exactly, including the
    // `create:<aggregate id>` fallback, or this query races the create it is
    // meant to observe.
    const lockKey = publishLockKey({ workspaceId: event.workspaceId, platform: String(platform), accountId, remoteId, aggregateId: event.aggregateId })
    try {
      return await quotaConnection.lock.run(lockKey, () => {
        signal?.throwIfAborted()
        return runtime.executeReconcile({
        platform: platform as 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin',
        context: { workspaceId: event.workspaceId, accountId, ...(execution ? { credentialRef: execution.credentialRef } : {}), ...workerTraceContext(event), signal },
        ...(remoteId ? { remoteId } : {}),
        idempotencyKey: publishIdempotencyKey(event),
      }) })
    } catch (error) {
      if (error instanceof DistributedLockBusyError) throw { normalized: { code: error.code, message: error.message, retryable: true, unknown: false } }
      throw error
    }
  }
  const generationRequested = async (event: DurableOutboxEvent, _projection: unknown, signal?: AbortSignal): Promise<GeneratedContent> => {
    signal?.throwIfAborted()
    if (!contentGenerator) throw new Error('AI generation provider is not configured')
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for generation execution')
    await assertGenerationExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
    const input = event.payload.input
    const contextHash = event.payload.context_hash
    const actionId = event.payload.action_id
    const runKey = requireModelRunKey(event.payload)
    if (typeof contextHash !== 'string' || !/^[a-f0-9]{64}$/u.test(contextHash)) throw new Error('generation event is missing context_hash')
    if (typeof actionId !== 'string' || !actionId) throw new Error('generation event is missing action_id')
    const validatedInput = assertGenerationInput(input, event.workspaceId, actionId, runKey)
    if (contextEnvelopeHash(validatedInput as unknown as Record<string, unknown>) !== contextHash) throw new Error('generation event context hash mismatch')
    const taskId = event.payload.task_id
    if (typeof taskId !== 'string' || !taskId) throw new Error('generation event is missing task_id')
    const modelKey = process.env.AI_MODEL?.trim() ?? process.env.MODEL_ID?.trim() ?? 'configured-model'
    const usageContext = { runKey, contextHash, ...(typeof event.payload.context_link_id === 'string' && event.payload.context_link_id ? { contextLinkId: event.payload.context_link_id } : {}), taskId, ...(typeof event.payload.campaign_item_id === 'string' && event.payload.campaign_item_id ? { campaignItemId: event.payload.campaign_item_id } : {}), event, providerRequestIds: [] as string[], ...(signal ? { signal } : {}) }
    try {
      const content = await executeWorkerProviderAfterPreflight({
        event, operation: 'generation.execute', authorization: executionAuthorization, signal,
        preflight: async () => { await quotaAdmission.admit(quotaAdmissionForEvent(event, 'model', modelKey, config.modelQuotaPerMinute)) },
        invoke: () => {
          generationUsageContexts.set(actionId, usageContext)
          const generationInput = {
            ...validatedInput,
            beforeProviderRequest: async (proof: { workspaceId?: string; actionId?: string; model: string; attempt: number; providerAttemptKey: string; requestBodySha256: string }) => {
              if (proof.workspaceId !== event.workspaceId || proof.actionId !== actionId || proof.model !== modelKey
                || !Number.isSafeInteger(proof.attempt) || proof.attempt < 0
                || !/^mm-[a-f0-9]{64}$/u.test(proof.providerAttemptKey) || !/^[a-f0-9]{64}$/u.test(proof.requestBodySha256)) {
                throw new GenerationKnowledgeReceiptError('text provider attempt has invalid frozen generation identity')
              }
              await assertGenerationKnowledgeExecution({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, event, proof, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
            },
          }
          return providerDispatchAdmission.run({ event, operation: 'generation.execute', signal, providerRequests: 0 }, () => contentGenerator.generate(generationInput, { signal }))
        },
      })
      return content
    } catch (error) {
      generationUsageContexts.delete(actionId)
      if (error instanceof WorkerExecutionAuthorizationError && usageContext.providerRequestIds.length > 0) {
        // A schema-repair attempt can be denied after an earlier response
        // already produced real usage. Preserve that evidence and reservation
        // for reconciliation instead of claiming this whole action was free.
        throw Object.assign(new Error('Generation was interrupted by current authorization after recorded provider usage'), {
          code: 'GENERATION_AUTHORIZATION_CHANGED_AFTER_USAGE', retryable: false, unknown: false,
          providerSucceeded: true, reconciliationRequired: true, cause: error,
          providerRequestIds: [...usageContext.providerRequestIds],
        })
      }
      const candidate = error as { providerOutcome?: unknown; providerRequestId?: unknown; providerIdempotencyKey?: unknown; code?: unknown; message?: unknown }
      if (candidate.providerOutcome === 'unknown') await creativePointSettlement.recordProviderOutcome(event, candidate).catch(() => undefined)
      else if (candidate.providerOutcome === 'failed') {
        try { await creativePointSettlement.recordProviderOutcome(event, candidate) }
        catch (settlementError) { throw Object.assign(settlementError instanceof Error ? settlementError : new Error('creative point release is pending'), { code: 'CREATIVE_POINT_SETTLEMENT_PENDING', providerSucceeded: true, reconciliationRequired: true }) }
      }
      throw error
    }
  }
  const imageGenerationRequested = async (event: DurableOutboxEvent, _projection: unknown, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (!imageGenerator) throw Object.assign(new Error('AI image generation provider is not configured'), { code: 'IMAGE_GENERATION_PROVIDER_NOT_CONFIGURED', retryable: false, unknown: false })
    if (!config.apiBaseUrl || !config.apiToken) throw Object.assign(new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for image generation execution'), { code: 'IMAGE_GENERATION_CALLBACK_CONFIG_MISSING', retryable: true, unknown: false })
    const payload = event.payload
    const intentHash = payload.intent_hash
    const productTitle = payload.product_title
    const direction = payload.direction
    const countValue = payload.requested_count
    if (typeof intentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(intentHash) || typeof productTitle !== 'string' || typeof direction !== 'string' || typeof countValue !== 'number' || !Number.isSafeInteger(countValue) || countValue < 1 || countValue > 6) throw Object.assign(new Error('image generation event is missing a frozen request payload'), { code: 'IMAGE_GENERATION_EVENT_INVALID', retryable: false, unknown: false })
    const count = countValue
    const actionId = requireImageGenerationActionId(payload)
    const runKey = requireModelRunKey(payload)
    const execution = await updateImageGenerationExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, operation: 'claim', ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
    const ownerToken = execution?.ownerToken
    if (!ownerToken) throw new Error('image generation execution lease response is missing owner token')
    const reserved = await updateImageGenerationExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, operation: 'reserve_provider_operation', ownerToken, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
    const providerOperationKey = reserved?.providerOperationKey
    if (!providerOperationKey) throw new Error('image generation execution response is missing provider operation reservation')
    const dispatchScope: WorkerProviderDispatchScope = { event, operation: 'image_generation.execute', signal, providerRequests: 0 }
    const closeRejected = (error: unknown) => closeRejectedImageDispatch({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, event, ownerToken, providerRequests: dispatchScope.providerRequests, error, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
    try {
      await executionAuthorization.assertAuthorized(event, 'image_generation.execute', signal)
      await updateImageGenerationExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, operation: 'begin_provider_dispatch', ownerToken, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
    } catch (error) { return closeRejected(error) }
    imageUsageContexts.set(actionId, { runKey, contextHash: intentHash, event, ...(signal ? { signal } : {}) })
    // Keep asset IDs and resolved pixels on their respective relay fields.
    // Passing IDs through `sourceImages` silently dropped the reference image
    // in the image generator's data-URL validation, so the provider generated
    // an unrelated product/color despite an optimize request.
    const sourceAssetRefs = Array.isArray(payload.source_asset_ids)
      ? payload.source_asset_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
    const sourceImages = Array.isArray(payload.source_asset_data_urls)
      ? payload.source_asset_data_urls.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
    const input: ImageGenerationInput = { productTitle, direction, count, ...(typeof payload.category === 'string' && payload.category ? { category: payload.category } : {}), ...(payload.image_mode === 'create' || payload.image_mode === 'optimize' ? { mode: payload.image_mode } : {}), ...(sourceAssetRefs.length ? { sourceAssetRefs } : {}), ...(sourceImages.length ? { sourceImages } : {}), ...(payload.visual_brief && isObject(payload.visual_brief) ? { visualBrief: payload.visual_brief as ImageGenerationInput['visualBrief'] } : {}), usageContext: { workspaceId: event.workspaceId, actionId, runKey } }
    imageWorkerTrace('dispatch', { workspace_id: event.workspaceId, job_id: event.aggregateId, event_id: event.id, action_id: actionId, provider_operation_key: providerOperationKey, mode: input.mode ?? 'create', requested_count: count, source_asset_count: sourceAssetRefs.length, source_image_count: sourceImages.length })
    try {
      let images: string[]
      try {
        images = await executeAfterAuthorizationCheck({ guard: executionAuthorization, event, operation: 'image_generation.execute', signal, providerCall: () => providerDispatchAdmission.run(dispatchScope, () => imageGenerator.generate(input, { signal, providerOperationKey })) })
        signal?.throwIfAborted()
      } catch (error) {
        if (signal?.aborted) throw error
        // A live authorization failure occurs before the provider call. It
        // must not manufacture a provider request or unknown remote outcome.
        if (error instanceof WorkerExecutionAuthorizationError && dispatchScope.providerRequests === 0) return closeRejected(error)
        const candidate = error as { code?: unknown }
        const failure = { code: typeof candidate.code === 'string' ? candidate.code : 'IMAGE_GENERATION_FAILED', message: error instanceof Error ? error.message : 'image generation failed' }
        const providerRequestId = imageUsageContexts.get(actionId)?.providerRequestId?.trim()
        imageWorkerTrace('provider_error', { workspace_id: event.workspaceId, job_id: event.aggregateId, event_id: event.id, action_id: actionId, provider_operation_key: providerOperationKey, ...(providerRequestId ? { provider_request_id: providerRequestId } : {}), ...imageWorkerErrorFields(error) })
        if (!providerRequestId) {
          await updateImageGenerationExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, operation: 'outcome_unknown', ownerToken, errorCode: failure.code, errorMessage: failure.message, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal }).catch(() => undefined)
          throw Object.assign(error instanceof Error ? error : new Error(failure.message), { code: failure.code, retryable: false, unknown: true })
        }
        await updateImageGenerationExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, operation: 'provider_started', ownerToken, providerRequestId, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal }).catch(() => undefined)
        if (isImageProviderOutcomeUnknown(error)) {
          await updateImageGenerationExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, operation: 'outcome_unknown', ownerToken, errorCode: typeof candidate.code === 'string' ? candidate.code : 'MODEL_PROVIDER_OUTCOME_UNKNOWN', errorMessage: failure.message, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal }).catch(() => undefined)
          throw error
        }
        await postImageGenerationResult({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, result: { intent_hash: intentHash, owner_token: ownerToken, error: failure }, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal }).catch(() => undefined)
        await updateImageGenerationExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, operation: 'failed', ownerToken, errorCode: failure.code, errorMessage: failure.message, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal }).catch(() => undefined)
        throw error
      }
      const providerRequestId = requireImageProviderRequestId(actionId)
      imageWorkerTrace('provider_result', { workspace_id: event.workspaceId, job_id: event.aggregateId, event_id: event.id, action_id: actionId, provider_operation_key: providerOperationKey, provider_request_id: providerRequestId, image_count: images.length })
      await updateImageGenerationExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, operation: 'provider_started', ownerToken, providerRequestId, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
      try {
        await postImageGenerationResult({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, result: { intent_hash: intentHash, owner_token: ownerToken, provider_request_id: providerRequestId, images }, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
        imageWorkerTrace('callback_accepted', { workspace_id: event.workspaceId, job_id: event.aggregateId, event_id: event.id, action_id: actionId, provider_operation_key: providerOperationKey, provider_request_id: providerRequestId, image_count: images.length })
      } catch (error) {
        imageWorkerTrace('callback_error', { workspace_id: event.workspaceId, job_id: event.aggregateId, event_id: event.id, action_id: actionId, provider_operation_key: providerOperationKey, provider_request_id: providerRequestId, ...imageWorkerErrorFields(error) })
        await updateImageGenerationExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, operation: 'outcome_unknown', ownerToken, errorCode: 'IMAGE_GENERATION_CALLBACK_UNCERTAIN', errorMessage: error instanceof Error ? error.message : 'image callback outcome unknown', ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal }).catch(() => undefined)
        throw error
      }
      // Image generation has the same commercial delivery boundary as text
      // generation: a provider result may be archived, but the reserved
      // creative points must not remain active after a successful delivery.
      // The image usage sink records the provider receipt while the provider
      // response is being parsed; settle only after the API accepted the
      // archived result, so a failed callback cannot charge the merchant.
      await creativePointSettlement.settleForDelivery(event, [providerRequestId], 'image_generation.execute')
      imageWorkerTrace('creative_points_settled', { workspace_id: event.workspaceId, job_id: event.aggregateId, event_id: event.id, action_id: actionId, provider_operation_key: providerOperationKey, provider_request_id: providerRequestId })
      // The callback proves application acceptance; complete the execution
      // lease only after that boundary succeeds. A failed completion remains
      // replayable/reconcilable and must not be acknowledged as completed.
      await updateImageGenerationExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, operation: 'completed', ownerToken, providerRequestId, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
      imageWorkerTrace('completed', { workspace_id: event.workspaceId, job_id: event.aggregateId, event_id: event.id, action_id: actionId, provider_operation_key: providerOperationKey, provider_request_id: providerRequestId, image_count: images.length })
      return { images, intent_hash: intentHash }
    } catch (error) {
      throw error
    } finally {
      imageUsageContexts.delete(actionId)
    }
  }
  const syncRequested = async (event: DurableOutboxEvent, _projection: unknown, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted()
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for sync result callbacks')
    const platform = event.payload.platform
    const accountId = event.payload.account_id
    if (!['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'].includes(String(platform)) || typeof accountId !== 'string' || !accountId) throw new Error('sync event is missing platform or account_id')
    const execution = await syncExecutionContext({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
    const remoteJob = await fetchWorkerApi(fetch, `${config.apiBaseUrl}/v1/sync-jobs/${encodeURIComponent(event.aggregateId)}`, { headers: { accept: 'application/json', authorization: `Bearer ${config.apiToken}`, 'x-workspace-id': event.workspaceId, ...(config.apiSigningSecret ? workerAuthIntent(config.apiSigningSecret, config.workerId) : {}) }, redirect: 'error', signal })
    if (!remoteJob.ok) throw new Error(`sync job API returned ${remoteJob.status}`)
    const envelope = await parseWorkerApiJson(remoteJob) as { data?: { resumeCursor?: string; state?: string } }
    const cursor = typeof envelope.data?.resumeCursor === 'string' ? envelope.data.resumeCursor : typeof event.payload.cursor === 'string' ? event.payload.cursor : undefined
    try {
      const result = await executeAfterAuthorizationCheck({ guard: executionAuthorization, event, operation: 'catalog.sync.execute', signal, providerCall: () => providerDispatchAdmission.run({ event, operation: 'catalog.sync.execute', signal, providerRequests: 0 }, () => runtime.sync(platform as 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin', { workspaceId: event.workspaceId, accountId, credentialRef: execution.credentialRef, ...workerTraceContext(event), signal }, cursor, async page => {
        await postSyncProgress({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, event, page: { pageNumber: page.pageNumber, ...(page.cursor ? { cursor: page.cursor } : {}), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), items: page.items as unknown[] }, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
      })) })
      signal?.throwIfAborted()
      await postSyncResult({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, state: 'succeeded', ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
      return result
    } catch (error) {
      signal?.throwIfAborted()
      const failure = error instanceof SyncPaginationError && error.cause instanceof WorkerExecutionAuthorizationError ? error.cause : error
      await postSyncResult({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, state: error instanceof SyncPaginationError && error.pages > 0 ? 'partial' : 'failed', errorMessage: failure instanceof Error ? failure.message : 'catalog sync failed', ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
      // Pagination retains already observed pages, but must not turn a
      // final authorization denial into a generic retryable connector error.
      throw failure
    }
  }
  const scanRequested = async (event: DurableOutboxEvent, _projection: unknown, signal?: AbortSignal) => {
    // The scan side effect itself is what must be deferred, not the queue that
    // carries unrelated work. A delivery taken while the scanner was ready
    // survives in the queue, so the claim routing alone cannot hold it back;
    // refusing here keeps the event retryable and leaves it for the cycle in
    // which this process is allowed to scan again.
    if (scannerHeartbeat !== undefined && !scannerHeartbeat.canProcessScans()) {
      throw Object.assign(new Error('asset scan is deferred until this worker can process scans'), { code: 'ASSET_SCANNER_NOT_READY', retryable: true })
    }
    const apiToken = process.env.ASSET_SCANNER_API_TOKEN?.trim()
    const signingSecret = process.env.ASSET_SCANNER_WORKSPACE_SIGNING_SECRET?.trim()
    const privateKey = assetScanReceiptPrivateKeyPem(process.env)
    const keyId = process.env.ASSET_SCAN_RECEIPT_KEY_ID?.trim()
    if (!config.apiBaseUrl || !apiToken || !signingSecret || !privateKey || !keyId) throw Object.assign(new Error('asset scanner callback and receipt credentials are not configured'), { code: 'ASSET_SCANNER_CONFIG_MISSING', retryable: true })
    const scannerInstanceId = process.env.HOSTNAME?.trim() || `worker-${process.pid}`
    return executeAssetScan({ apiBaseUrl: config.apiBaseUrl, apiToken, apiSigningSecret: signingSecret, receiptPrivateKeyPem: privateKey, receiptKeyId: keyId, scannerServiceId: process.env.ASSET_SCANNER_SERVICE_ID?.trim() || 'merchant-asset-scanner', scannerInstanceId, policyVersion: process.env.ASSET_SCAN_POLICY_VERSION?.trim() || '2026-08-30', clamavHost, clamavPort, clamavTimeoutMs, clamavMaxFileBytes: config.clamavMaxFileBytes, definitionsMaxAgeSeconds: positiveInt(process.env.SCANNER_DEFINITIONS_MAX_AGE_SECONDS, 86_400, 'SCANNER_DEFINITIONS_MAX_AGE_SECONDS'), attemptRepository: scanAttempts, event, signal, onCallbackAccepted: acceptedAt => redisConnection!.scannerHeartbeat.recordCallbackAccepted(scannerInstanceId, acceptedAt, positiveInt(process.env.SCANNER_CALLBACK_MAX_AGE_SECONDS, 86_400, 'SCANNER_CALLBACK_MAX_AGE_SECONDS')) })
  }
  const imageContinuationRequested = async (event: DurableOutboxEvent, _projection: unknown, signal?: AbortSignal) => {
    if (!config.apiBaseUrl || !config.apiToken || !config.apiSigningSecret) throw Object.assign(new Error('image continuation callback credentials are not configured'), { code: 'IMAGE_CONTINUATION_CONFIG_MISSING', retryable: true })
    return executeImageGenerationContinuations({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, signingSecret: config.apiSigningSecret, event, signal })
  }
  const onPublishObservation = async (event: DurableOutboxEvent, observation: PublishHandlerResult, _projection: unknown, signal?: AbortSignal) => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for publish observation')
    await postPublishObservation({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, observation, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
  }
  const onGenerationResult = async (event: DurableOutboxEvent, result: { content?: GeneratedContent; error?: { code: string; message: string } }, _projection: unknown, signal?: AbortSignal) => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for generation result')
    const actionId = typeof event.payload.action_id === 'string' ? event.payload.action_id : undefined
    const execution = actionId ? generationUsageContexts.get(actionId) : undefined
    const requiresPointSettlement = requiresCreativePointSettlement(event)
    try {
      await deliverGenerationResultWithPointSettlement(result.content !== undefined,
        () => postGenerationResult({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, event, result, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal }),
        async () => {
          if (!execution && requiresPointSettlement) throw Object.assign(new Error('provider execution context is missing; creative point settlement must be reconciled'), { code: 'MODEL_USAGE_EVIDENCE_MISSING', reconciliationRequired: true })
          if (execution) await creativePointSettlement.settleForDelivery(event, execution.providerRequestIds)
        })
    } catch (error) {
      if (result.content !== undefined) throw Object.assign(error instanceof Error ? error : new Error('generation result delivery or settlement is pending'), { code: 'MODEL_USAGE_SETTLEMENT_PENDING', providerSucceeded: true, reconciliationRequired: true })
      throw error
    } finally {
      // Keep the in-memory provider evidence when delivery or settlement fails.
      // The durable outbox retry can then retry this callback without losing
      // the only linkage from a successful relay call to its verified receipt.
      if (actionId && !(result.content !== undefined && requiresPointSettlement && !execution)) generationUsageContexts.delete(actionId)
    }
  }
  const onGenerationDeferred = async (event: DurableOutboxEvent, error: { retryAfterSeconds: number; code: string; message: string }, _projection: unknown, signal?: AbortSignal) => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for generation defer')
    await postGenerationDeferred({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, retryAfterSeconds: error.retryAfterSeconds, code: error.code, message: error.message, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
  }
  let stopping = false
  let nextStorageReconciliationAt = 0
  let nextPaymentReconciliationAt = 0
  let nextModelUsageReconciliationAt = 0
  let nextImageGenerationReconciliationAt = 0
  let nextSupportSlaScanAt = 0
  let nextSupportSlaReportAt = 0
  const readyFile = process.env.WORKER_READY_FILE ?? '/tmp/merchant-worker-ready'
  // The scanner role proves liveness through its heartbeat controller; every
  // other role has only this marker, which the probes read with `-mmin -2`.
  const readyFileHeartbeat = createReadyFileHeartbeat({ readyFile, ...(options.readyFileHeartbeatIntervalMs !== undefined ? { intervalMs: options.readyFileHeartbeatIntervalMs } : {}) })
  let scannerHeartbeat: ScannerHeartbeatController | undefined
  // The registry is created before the loop so a scrape can observe a worker
  // that has not completed its first cycle yet: `heartbeat_timestamp_seconds`
  // stays at 0 rather than being absent, which keeps the staleness rule
  // evaluating instead of silently matching nothing.
  const workerMetrics = new WorkerMetricsRegistry({ role: config.role })
  const workerMetricsServer = config.metricsPort > 0
    ? createWorkerMetricsServer({
      registry: workerMetrics,
      port: config.metricsPort,
      host: config.metricsHost,
      production: config.environment === 'production',
      onError: error => log({ level: 'error', message: 'worker metrics endpoint unavailable; continuing without it', error: serializeError(error) }),
    })
    : undefined
  const stop = () => { stopping = true }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    // Container restarts reuse /tmp. Remove a stale marker before touching any
    // dependency so a failed restart can never inherit readiness.
    await unlink(readyFile).catch(() => undefined)
    if (workerMetricsServer) {
      const bound = await workerMetricsServer.start()
      log({
        level: bound ? 'info' : 'error',
        message: bound ? 'worker metrics endpoint listening' : 'worker metrics endpoint disabled; collection is unavailable for this role',
        role: config.role,
        host: config.metricsHost,
        port: config.metricsPort,
        // Never log the token itself, only whether the production gate is armed.
        auth: config.environment === 'production' ? (process.env.METRICS_AUTH_TOKEN?.trim() ? 'bearer' : 'fail-closed') : 'open',
      })
    }
    const expectedMigrations = await loadMigrations()
    if (scanRoleEnabled) {
      const instanceId = process.env.HOSTNAME?.trim() || `worker-${process.pid}`
      const heartbeatIntervalMs = positiveInt(process.env.SCANNER_HEARTBEAT_INTERVAL_MS, 5_000, 'SCANNER_HEARTBEAT_INTERVAL_MS')
      const heartbeatTtlSeconds = positiveInt(process.env.SCANNER_HEARTBEAT_TTL_SECONDS, 15, 'SCANNER_HEARTBEAT_TTL_SECONDS')
      const callbackMaxAgeSeconds = positiveInt(process.env.SCANNER_CALLBACK_MAX_AGE_SECONDS, 86_400, 'SCANNER_CALLBACK_MAX_AGE_SECONDS')
      const definitionsMaxAgeSeconds = positiveInt(process.env.SCANNER_DEFINITIONS_MAX_AGE_SECONDS, 86_400, 'SCANNER_DEFINITIONS_MAX_AGE_SECONDS')
      const eicarMaxAgeSeconds = positiveInt(process.env.SCANNER_EICAR_MAX_AGE_SECONDS, 900, 'SCANNER_EICAR_MAX_AGE_SECONDS')
      if (heartbeatTtlSeconds * 1000 <= heartbeatIntervalMs * 2) throw new Error('SCANNER_HEARTBEAT_TTL_SECONDS must exceed two heartbeat intervals')
      // Redis heartbeat state is instance-scoped and intentionally ephemeral.
      // Rehydrate the callback proof from the durable tenant records before the
      // first readiness probe so a normal worker restart does not manufacture a
      // false negative, while still keeping the durable callback age gate.
      const durableScannerMetrics = await scannerOperationalMetrics(pool as unknown as SqlPool, await currentWorkspaces(), config.scanMaxAttempts)
      // Publish the queue observation once here as well. `queueProbe` only runs
      // after the API readiness probe succeeds, so without this the scan backlog
      // series would stay absent exactly when the API is the thing that is down.
      workerMetrics.recordScannerQueue(scannerQueueObservation(durableScannerMetrics))
      if (durableScannerMetrics.lastCallbackAcceptedAt) {
        await redisConnection!.scannerHeartbeat.recordCallbackAccepted(instanceId, durableScannerMetrics.lastCallbackAcceptedAt, callbackMaxAgeSeconds)
      }
      scannerHeartbeat = new ScannerHeartbeatController({
        instanceId,
        readyFile,
        scanner: clamavReadiness!,
        redis: redisConnection!.scannerHeartbeat,
        thresholds: {
          ttlSeconds: heartbeatTtlSeconds,
          definitionsMaxAgeSeconds,
          eicarMaxAgeSeconds,
          callbackMaxAgeSeconds,
          minimumReadyInstances: positiveInt(process.env.SCANNER_MINIMUM_READY_INSTANCES, 1, 'SCANNER_MINIMUM_READY_INSTANCES'),
        },
        intervalMs: heartbeatIntervalMs,
        callbackConfigured: hasCompleteScanCallbackCredentials(config, process.env),
        dependencyProbe: async () => {
          const state = await assertWorkerReadinessDependencies({ database: pool, ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}), apiHealthPath: '/healthz', expectedMigrations })
          return { databaseReady: true, apiReady: state.apiReady }
        },
        queueProbe: async () => {
          const metrics = await scannerOperationalMetrics(pool as unknown as SqlPool, await currentWorkspaces(), config.scanMaxAttempts)
          // Recording happens on the worker loop's own cadence, not here: this
          // probe is skipped whenever the API is unready. See the loop comment.
          return { backlog: metrics.backlog, deadLetter: metrics.deadLetter }
        },
        // `role` is the only field this worker adds to the readiness document.
        // The controller owns writing it, so the marker cannot be produced in
        // two shapes by two writers - the reason the release acceptance scripts
        // and the scan probes disagreed about what was on disk.
        formatReadyDocument: (heartbeat, at) => ({ readyAt: at.toISOString(), role: config.role, state: heartbeat.ready ? 'ready' : 'recovery', heartbeat }),
        onHeartbeat: heartbeat => {
          workerMetrics.recordScannerHeartbeat(heartbeat)
          const notReadyReasons = [
            ...(!heartbeat.checks.databaseReady ? ['database_not_ready'] : []),
            ...(!heartbeat.checks.apiReady ? ['api_not_ready'] : []),
            ...(!heartbeat.checks.redisReady ? ['redis_not_ready'] : []),
            ...(!heartbeat.clamav.reachable ? ['clamav_unreachable'] : []),
            ...(heartbeat.clamav.definitionsAgeSeconds === undefined || heartbeat.clamav.definitionsAgeSeconds > definitionsMaxAgeSeconds ? ['definitions_stale'] : []),
            ...(!heartbeat.eicar.passed ? ['eicar_check_failed'] : []),
            ...(heartbeat.eicar.ageSeconds === undefined || heartbeat.eicar.ageSeconds > eicarMaxAgeSeconds ? ['eicar_stale'] : []),
            ...(!heartbeat.callback.capable ? ['scanner_callback_not_capable'] : []),
            ...(heartbeat.callback.ageSeconds === undefined || heartbeat.callback.ageSeconds > callbackMaxAgeSeconds ? ['scanner_callback_stale'] : []),
            // Dead letters remain visible in queue evidence and are handled
            // through the audited recovery/redrive path. They must not be
            // reported as a scanner readiness failure: doing so would
            // deadlock recovery because the worker cannot process redrives
            // while its own health check is red.
            ...(heartbeat.failure?.code ? [heartbeat.failure.code] : []),
          ]
          log({ level: heartbeat.ready ? 'info' : heartbeat.recoveryCapable ? 'warn' : 'error', message: 'scanner heartbeat published', heartbeat, ...(notReadyReasons.length && !heartbeat.ready ? { not_ready_reasons: [...new Set(notReadyReasons)] } : {}) })
        },
      })
      await scannerHeartbeat.start()
    }
    let dependenciesReady = false
    // How many iterations have failed since the loop last completed one. The
    // dependency check below writes the idle marker back on every iteration it
    // passes, unwinding the failure path's revocation one iteration later; a
    // loop that never completes an iteration therefore stays revoked once this
    // count passes `READY_MARKER_TOLERATED_FAILURES`, which is what lets the
    // probes accumulate the consecutive failures that restart a pod. It is a
    // count and not a boolean because a *single* transient failure is not
    // evidence about the next iteration - see the constant's own note.
    let consecutiveIterationFailures = 0
    let nextDependencyCheckAt = 0
    let nextKnowledgeIndexAt = 0
    let nextScannerQueueMetricsAt = 0
    do {
      const startedAt = Date.now()
      // Refresh the scan queue gauge on this loop's cadence rather than from
      // `queueProbe`, which only runs once the API readiness probe succeeds.
      // Without an independent refresh the series would freeze at its last value
      // whenever the API is unreachable -- a stalled backlog would keep reading
      // 0 and the backlog rule could never fire on the failure it exists for.
      if (scanRoleEnabled && startedAt >= nextScannerQueueMetricsAt) {
        nextScannerQueueMetricsAt = startedAt + SCANNER_QUEUE_METRICS_INTERVAL_MS
        await refreshScanQueueMetrics({
          pool: pool as unknown as SqlPool,
          workspaces: currentWorkspaces(),
          scanMaxAttempts: config.scanMaxAttempts,
          metrics: workerMetrics,
          // A failing metric read is an operational event, not a caught
          // exception: the scan queue series is now withheld, and this line is
          // what tells an operator the difference between that and an idle
          // scanner worker.
          onFailure: error => log({ level: 'error', message: 'scan queue metrics read failed; scan queue series withheld until a read succeeds', role: config.role, error }),
        })
      }
      // From here on the loop is executing, not sleeping. Proving that on a
      // cadence shorter than the probe window is what keeps a slow cycle (a
      // minute-long API call, a deep batch) from being read as a dead process.
      readyFileHeartbeat.start()
      try {
        if (!dependenciesReady || startedAt >= nextDependencyCheckAt) {
          dependenciesReady = false
          const dependencyState = await assertWorkerReadinessDependencies({ database: pool, ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}), ...(scannerHeartbeat ? { apiHealthPath: '/healthz' as const } : {}), expectedMigrations })
          if (clamavReadiness && !scannerHeartbeat) await clamavReadiness.ping()
          dependenciesReady = true
          nextDependencyCheckAt = startedAt + config.dependencyCheckIntervalMs
          // A passing dependency check is not progress, so a failing loop must
          // stay revoked; it *is* a fallible probe of the next iteration, so a
          // single failure must not suppress one - see
          // `READY_MARKER_TOLERATED_FAILURES`.
          if (!scannerHeartbeat && readyMarkerRefreshAllowed(consecutiveIterationFailures)) await writeFile(readyFile, JSON.stringify({ readyAt: new Date().toISOString(), role: config.role, state: 'idle', quotaAdmission: quotaConnection.mode, migrationVersion: dependencyState.migrationVersion, apiReady: dependencyState.apiReady }))
        }
        const workspaces = config.autoDiscoverWorkspaces ? await repository.listActiveWorkspaceIds() : config.workspaces
        const result = config.role === 'automation'
          ? await (async () => {
            if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for automation ticks')
            return runAutomationMaintenance({
              workspaces,
              tick: workspaceId => postAutomationTick({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, workspaceId, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }) as Promise<{ data?: { result?: { executed?: unknown[] } } }>,
              cleanup: workspaceId => postObjectOrphanCleanup({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, workspaceId, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }) as Promise<{ data?: { cleaned?: number } }>,
              onError: (workspaceId, operation, error) => log({ level: 'error', message: 'automation workspace maintenance failed; continuing', workspaceId, operation, error: serializeError(error) }),
            })
          })()
          : await pollOnce(repository, dispatchers, {
            ...config,
            workspaces,
            // A scan-only worker owns nothing else, so an unready scanner means
            // there is no work for it to claim at all.
            ...(config.role === 'scan' && scannerHeartbeat ? { claimAdmission: () => scannerHeartbeat!.canProcessScans() } : {}),
            // `all` owns every queue in one process. Withholding the scan
            // routing while the scanner is unready keeps platform scans
            // deferred, but the publish/sync/generation queues must keep
            // draining: freezing the whole poll (the previous behaviour) turned
            // one optional local dependency into a total outbox outage with no
            // distinguishing signal.
            ...(config.role === 'all' && scannerHeartbeat ? { claimFor: () => scannerHeartbeat!.canProcessScans() ? undefined : { eventTypes: NON_SCAN_EVENT_TYPES } } : {}),
          }, queueFactory, { executionAuthorization, commercialAccess, deliveryScanAdmission, publishRequested, reconcileRequested, generationRequested, imageGenerationRequested, syncRequested, scanRequested, imageContinuationRequested, onGenerationResult, onGenerationDeferred, onPublishObservation })
        if ((config.role === 'automation' || config.role === 'all') && startedAt >= nextKnowledgeIndexAt && workspaces.length) {
          const indexed = await allSettledWithConcurrency(workspaces, Math.min(2, config.workspaceBatchSize), workspaceId => indexApprovedKnowledge({
            repository: knowledgeRepository, workspaceId, limit: Math.min(20, config.batchSize),
            ...(embeddingClient && embeddingVersion ? { embedding: {
              model: process.env.EMBEDDING_MODEL!.trim(), version: embeddingVersion, embed: embeddingClient.embed.bind(embeddingClient),
              admit: (binding: KnowledgeEmbeddingBinding) => postKnowledgeEmbeddingAdmission({ ...binding, apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, signingSecret: config.apiSigningSecret! }).then(() => undefined),
              reportOutcome: (outcome: KnowledgeEmbeddingBinding & { outcome: 'failed_before_provider' | 'unknown' }) => postKnowledgeEmbeddingOutcome({ ...outcome, apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, signingSecret: config.apiSigningSecret! }).then(() => undefined),
            } } : {}),
          }))
          nextKnowledgeIndexAt = Date.now() + 60_000
          Object.assign(result as unknown as Record<string, unknown>, { knowledgeLexicalIndex: { completed: indexed.filter(item => item.status === 'fulfilled').length, failed: indexed.filter(item => item.status === 'rejected').length } })
        }
        const paymentReconciliationSchedule = planPaymentReconciliationRun({ role: config.role, startedAt, nextRunAt: nextPaymentReconciliationAt, intervalMs: config.paymentReconciliationIntervalMs })
        nextPaymentReconciliationAt = paymentReconciliationSchedule.nextRunAt
        if (config.role === 'reconcile' && startedAt >= nextStorageReconciliationAt) {
          if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for storage reconciliation')
          const reconciliation = await allSettledWithConcurrency(workspaces, config.workspaceBatchSize, workspaceId => postStorageReconciliation({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, workspaceId, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }))
          nextStorageReconciliationAt = Date.now() + config.storageReconciliationIntervalMs
          Object.assign(result as unknown as Record<string, unknown>, { storageReconciliation: { completed: reconciliation.filter(item => item.status === 'fulfilled').length, failed: reconciliation.filter(item => item.status === 'rejected').length } })
        }
        if (paymentReconciliationSchedule.run) {
          if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for payment reconciliation')
          const paymentReconciliation = await runPaymentReconciliationSweep({
            workspaces,
            workspaceConcurrency: config.workspaceBatchSize,
            reconcile: workspaceId => postPaymentReconciliation({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, workspaceId, limit: config.paymentReconciliationBatchSize, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }),
          })
          Object.assign(result as unknown as Record<string, unknown>, { paymentReconciliation })
          if (paymentReconciliation.businessWarnings > 0) log({ level: 'warn', message: 'payment reconciliation completed with business warnings', paymentReconciliation })
        }
        if ((config.role === 'reconcile' || config.role === 'all') && workspaces.length > 0) {
          const onboardingDispatches = await allSettledWithConcurrency(workspaces, config.workspaceBatchSize, workspaceId => onboardingGrantDispatch.dispatchDue({ workspaceId, limit: Math.min(100, config.batchSize) }))
          Object.assign(result as unknown as Record<string, unknown>, {
            onboardingGrantDispatch: {
              completed: onboardingDispatches.filter(item => item.status === 'fulfilled').length,
              failed: onboardingDispatches.filter(item => item.status === 'rejected').length,
              dispatched: onboardingDispatches.reduce((sum, item) => sum + (item.status === 'fulfilled' ? item.value.dispatched : 0), 0),
              expired: onboardingDispatches.reduce((sum, item) => sum + (item.status === 'fulfilled' ? item.value.expired : 0), 0),
            },
          })
        }
        if (config.role === 'reconcile' && startedAt >= nextModelUsageReconciliationAt) {
          if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for model usage reconciliation')
          const reconciliation = await allSettledWithConcurrency(workspaces, config.workspaceBatchSize, workspaceId => postModelUsageReconciliation({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, workspaceId, limit: Math.min(100, config.batchSize), ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }))
          nextModelUsageReconciliationAt = Date.now() + config.modelUsageReconciliationIntervalMs
          Object.assign(result as unknown as Record<string, unknown>, { modelUsageReconciliation: { completed: reconciliation.filter(item => item.status === 'fulfilled').length, failed: reconciliation.filter(item => item.status === 'rejected').length } })
        }
        if (config.role === 'reconcile' && startedAt >= nextImageGenerationReconciliationAt) {
          if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for image generation reconciliation')
          const reconciliation = await allSettledWithConcurrency(workspaces, config.workspaceBatchSize, workspaceId => reconcileImageGenerationWorkspace({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, workspaceId, limit: Math.min(100, config.batchSize), ...(imageGenerator?.queryStatus ? { queryStatus: imageGenerator.queryStatus.bind(imageGenerator) } : {}), queryTimeoutMs: imageReconciliationQueryTimeoutMs(config.workerApiTimeoutMs), ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }))
          nextImageGenerationReconciliationAt = Date.now() + config.imageGenerationReconciliationIntervalMs
          Object.assign(result as unknown as Record<string, unknown>, { imageGenerationReconciliation: { completed: reconciliation.filter(item => item.status === 'fulfilled').length, failed: reconciliation.filter(item => item.status === 'rejected').length } })
        }
        if (config.role === 'reconcile' && startedAt >= nextSupportSlaScanAt) {
          if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for support SLA scan')
          const scans = await allSettledWithConcurrency(workspaces, config.workspaceBatchSize, workspaceId => postSupportSlaScan({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, workspaceId, limit: Math.min(1000, config.batchSize), ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }))
          nextSupportSlaScanAt = Date.now() + config.supportSlaScanIntervalMs
          Object.assign(result as unknown as Record<string, unknown>, { supportSlaScan: { completed: scans.filter(item => item.status === 'fulfilled').length, failed: scans.filter(item => item.status === 'rejected').length } })
        }
        if (config.role === 'reconcile' && startedAt >= nextSupportSlaReportAt) {
          if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for support SLA report')
          const schedule = planSupportSlaReportSchedule(new Date(startedAt))
          const reports = schedule
            ? await allSettledWithConcurrency(workspaces, config.workspaceBatchSize, workspaceId => postSupportSlaReport({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, workspaceId, periodStart: schedule.periodStart, periodEnd: schedule.periodEnd, cutoffAt: schedule.cutoffAt, reportId: schedule.reportId, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }))
            : []
          nextSupportSlaReportAt = Date.now() + config.supportSlaReportIntervalMs
          Object.assign(result as unknown as Record<string, unknown>, { supportSlaReport: { scheduled: Boolean(schedule), completed: reports.filter(item => item.status === 'fulfilled').length, failed: reports.filter(item => item.status === 'rejected').length } })
        }
        // Completed iteration: the marker is allowed back, and the write below
        // is the one piece of evidence that says the loop is draining.
        consecutiveIterationFailures = 0
        if (!scannerHeartbeat) await writeFile(readyFile, JSON.stringify({ readyAt: new Date().toISOString(), role: config.role, workspaces: workspaces.length, quotaAdmission: quotaConnection.mode, ...result }))
        // Only aggregate counters reach the endpoint: `workspaces` and the
        // per-tenant reconciliation summaries stay in the log line.
        workerMetrics.recordPollSuccess({ startedAtMs: startedAt, finishedAtMs: Date.now(), result })
        log({ level: 'info', message: 'worker poll completed', ...result, durationMs: Date.now() - startedAt })
      } catch (error) {
        dependenciesReady = false
        // The marker stays revoked until an iteration completes or the streak
        // is still inside the tolerated window, so consecutive failures stay
        // consecutive from the probe's point of view and `failureThreshold`
        // can be reached. Rewriting it on the next dependency check is the
        // regression this pins; keeping the *first* failure from rewriting it
        // is the regression the tolerance above pins.
        consecutiveIterationFailures += 1
        await unlink(readyFile).catch(() => undefined)
        const failure = serializeError(error)
        workerMetrics.recordPollFailure({ finishedAtMs: Date.now(), ...(failure.code ? { code: failure.code } : {}) })
        log({ level: 'error', message: 'worker poll failed; retrying', error: serializeError(error) })
        rethrowPollFailureInOnceMode(config.once, error)
      } finally {
        // Scoped to the executing part of the cycle: the idle sleep below is
        // not progress, and the marker it would refresh has been removed by the
        // failure path above anyway.
        readyFileHeartbeat.stop()
      }
      if (!config.once && !stopping) await sleep(!dependenciesReady ? config.dependencyCheckIntervalMs : config.role === 'automation' ? config.automationIntervalMs : config.pollIntervalMs)
    } while (!config.once && !stopping)
  } finally {
    await workerMetricsServer?.stop()
    await scannerHeartbeat?.stop()
    readyFileHeartbeat.stop()
    await redisConnection?.close()
    // Without this the connector roles keep a referenced node-redis socket and
    // never exit on SIGTERM; the pod is SIGKILLed after the full grace period.
    await credentialRefresh?.close()
    await quotaConnection.close()
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

function boundedPositiveInt(raw: string | undefined, fallback: number, maximum: number, name: string): number {
  const value = positiveInt(raw, fallback, name)
  if (value > maximum) throw new Error(`${name} must be at most ${maximum}`)
  return value
}

/**
 * Metrics port parsing accepts 0 as the documented opt-out. Every worker runs in
 * its own Pod netns, so the fixed default cannot collide across a deployment;
 * the opt-out exists for single-host scenarios that share one network namespace
 * and for operators who refuse an extra listener.
 */
function workerMetricsPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return WORKER_METRICS_DEFAULT_PORT
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error('WORKER_METRICS_PORT must be an integer between 0 and 65535')
  return value
}

function parseWorkerRole(raw: string | undefined): WorkerRole {
  const role = raw?.trim() || 'all'
  if (!['all', 'sync', 'generation', 'publish', 'reconcile', 'automation', 'scan'].includes(role)) throw new Error(`WORKER_ROLE must be one of all, sync, generation, publish, reconcile, automation, scan`)
  return role as WorkerRole
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

export function rethrowPollFailureInOnceMode(once: boolean, error: unknown): void {
  if (once) throw error
}

function serializeError(error: unknown): { message: string; code?: string } {
  const candidate = error as { message?: unknown; code?: unknown }
  return { message: typeof candidate?.message === 'string' ? candidate.message : String(error), ...(typeof candidate?.code === 'string' ? { code: candidate.code } : {}) }
}

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }

function log(value: Record<string, unknown>) { process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), service: 'worker', ...value })}\n`) }

/**
 * Connection options for the pool the poll loop is handed.
 *
 * `connectionTimeoutMillis` only bounds *acquiring* a connection. A statement
 * that the server never answers - a lock wait, a blackholed peer, a query
 * parked behind a saturated Postgres - left the loop parked on an await with no
 * deadline, which the ready-file heartbeat could not distinguish from a slow
 * cycle (see `READY_FILE_HEARTBEAT_MS`). `query_timeout` aborts the query
 * client-side and `statement_timeout` cancels it on the server, so a stuck read
 * becomes a failed iteration: the marker is removed and the probe restarts the
 * container. Both are kept well under the two-minute probe window
 * (`READY_FILE_PROBE_WINDOW_MS`) so the failure, not a stale marker, is what the
 * probe sees.
 */
export function workerDatabasePoolOptions(config: Pick<WorkerConfig, 'databaseUrl'>, env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const queryTimeoutMs = positiveInt(env.WORKER_DB_QUERY_TIMEOUT_MS, DEFAULT_WORKER_DB_QUERY_TIMEOUT_MS, 'WORKER_DB_QUERY_TIMEOUT_MS')
  if (queryTimeoutMs > READY_FILE_PROBE_WINDOW_MS) throw new Error(`WORKER_DB_QUERY_TIMEOUT_MS must not exceed the ${READY_FILE_PROBE_WINDOW_MS}ms ready-file probe window`)
  return {
    connectionString: config.databaseUrl,
    max: positiveInt(env.WORKER_DB_POOL_MAX, 5, 'WORKER_DB_POOL_MAX'),
    connectionTimeoutMillis: positiveInt(env.WORKER_DB_CONNECTION_TIMEOUT_MS, 3_000, 'WORKER_DB_CONNECTION_TIMEOUT_MS'),
    query_timeout: queryTimeoutMs,
    statement_timeout: queryTimeoutMs,
  }
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  const config = readWorkerConfig()
  const pool = new Pool(workerDatabasePoolOptions(config))
  runWorker(config, pool).catch(async error => {
    log({ level: 'fatal', message: 'worker stopped', error: serializeError(error) })
    process.exitCode = 1
    // An orchestrator can only recover a stopped worker when the process
    // actually exits - the same reason the API exits on a startup failure
    // (`apps/api/src/server.ts`). Setting the exit code is not enough here:
    // `runWorker` closes every connection it owns in its own `finally`, but that
    // block only covers what was open when the poll loop started, so an error
    // raised *after* the Redis connections are dialled and before it - a
    // configured `AI_THINKING_MODE` that `createContentGeneratorFromEnv`
    // rejects, the vector-indexing contract check, a failed
    // `createQuotaCounterStore` - leaves those sockets referenced. The event
    // loop then never drains, the process stays alive with a fatal line logged
    // and an exit code nothing reads, and a container with
    // `restart: unless-stopped` (`infra/local/docker-compose.yml`) is restarted
    // on exit, never on a hang: the worker sits there processing nothing.
    // `process.exit` does not wait for a piped stdout, and the line above is the
    // only evidence of why the container restarted, so flush it first.
    await new Promise<void>(resolve => { process.stdout.write('', () => resolve()) })
    process.exit(1)
  }).finally(() => { void pool.end() })
}
