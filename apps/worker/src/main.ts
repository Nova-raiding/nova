import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { contextEnvelopeHash, loadMigrations, PostgresAssetScanAttemptRepository, PostgresOutboxRepository, withWorkspaceTransaction, type AssetScanAttemptRecord, type AssetScanAttemptRepository, type Migration, type SqlPool } from '../../../packages/persistence/src/index.js'
import { PostgresMappingPreflightApprovalRepository } from '../../../packages/persistence/src/mapping-preflight-approval-repository.js'
import { DurableOutboxDispatcher, InMemoryQueue, RedisQueueAdapter, type DurableOutboxEvent, type QueuePort, type RedisQueueTransport } from '../../../packages/workers/src/durable.js'
import { createOutboxHandler, createWorkerProjection } from './handler.js'
import { connectRedisQueue } from './redis-transport.js'
import { ConnectorMappingPreflightError, ConnectorRuntime, SyncPaginationError } from '../../../packages/application/src/connector-runtime.js'
import { createVaultCredentialProviderFromEnv } from '../../../packages/connectors/src/index.js'
import { readBoundedResponseText } from '../../../packages/connectors/src/bounded-response.js'
import type { PublishHandlerResult } from '../../../packages/workers/src/publish-adapter.js'
import { buildPublishObservationRequest, PublishObservationReportError } from '../../../packages/workers/src/publish-observation.js'
import { createContentGeneratorFromEnv, type ContentGenerationInput, type GeneratedContent } from '../../../packages/ai/src/generator.js'
import { createImageGeneratorFromEnv, type ImageGenerationInput, type ImageGenerationStatus } from '../../../packages/ai/src/image-generator.js'
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
import { createExecutionAuthorizationGuard, WorkerExecutionAuthorizationError, type WorkerAuthorizationRecheck } from '../../../packages/workers/src/execution-authorization.js'
import { createCommercialAccessGuard, WorkerCommercialAccessError, type WorkerCommercialAccessRecheck } from '../../../packages/workers/src/commercial-access.js'
import { assertClamAvExecutionAdmission } from '../../../packages/workers/src/scanner-heartbeat.js'
import { planSupportSlaReportSchedule } from '../../../packages/workers/src/support-sla-scan.js'
import { validateImageGenerationCallbackResult } from '../../../packages/contracts/src/index.js'
import { assertGenerationInput } from './generation-input.js'

export interface WorkerConfig {
  databaseUrl: string
  workspaces: string[]
  autoDiscoverWorkspaces: boolean
  pollIntervalMs: number
  storageReconciliationIntervalMs: number
  modelUsageReconciliationIntervalMs: number
  supportSlaScanIntervalMs: number
  supportSlaReportIntervalMs: number
  imageGenerationReconciliationIntervalMs: number
  workerApiTimeoutMs: number
  automationIntervalMs: number
  batchSize: number
  workspaceBatchSize: number
  leaseMs: number
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
}

export type WorkerRole = 'all' | 'sync' | 'generation' | 'publish' | 'reconcile' | 'automation' | 'scan'

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

export function imageReconciliationQueryTimeoutMs(workerApiTimeoutMs: number): number {
  if (!Number.isSafeInteger(workerApiTimeoutMs) || workerApiTimeoutMs < 1) throw new RangeError('worker API timeout must be a positive integer')
  return Math.min(workerApiTimeoutMs, 5 * 60 * 1000)
}

export function publishIdempotencyKey(event: DurableOutboxEvent): string {
  const configured = event.payload.idempotencyKey
  return typeof configured === 'string' && configured.trim() ? configured : event.aggregateId
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
  scan: { eventTypes: ['asset.uploaded', 'asset.generated_quarantined', 'asset.video_quarantined', 'asset.scan_redrive_requested'] },
}

const DEFAULT_WORKER_API_TIMEOUT_MS = 10_000
const DEFAULT_WORKER_DEPENDENCY_CHECK_INTERVAL_MS = 10_000
const DEFAULT_STORAGE_RECONCILIATION_INTERVAL_MS = 15 * 60_000
const DEFAULT_MODEL_USAGE_RECONCILIATION_INTERVAL_MS = 5 * 60_000
const DEFAULT_SUPPORT_SLA_SCAN_INTERVAL_MS = 60_000
const DEFAULT_SUPPORT_SLA_REPORT_INTERVAL_MS = 60 * 60_000
const MAX_WORKER_API_RESPONSE_BYTES = 24 * 1024 * 1024

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

function workerRoleForRequest(method: string, requestTarget: string, body?: string | Uint8Array): WorkerRequestRole {
  const path = new URL(requestTarget, 'http://worker.internal').pathname
  if (/^\/v1\/sync-jobs\//u.test(path)) return 'sync'
  if (path === '/v1/internal/image-generation-jobs/reconciliation') return 'reconcile'
  if (/^\/v1\/(?:generation-jobs|internal\/image-generation-jobs|internal\/image-generation-continuations)\//u.test(path)) return 'generation'
  if (/^\/v1\/publish-jobs\/[^/]+\/observation$/u.test(path)) {
    try { return JSON.parse(typeof body === 'string' ? body : Buffer.from(body ?? []).toString('utf8')).source === 'reconcile' ? 'reconcile' : 'publish' } catch { return 'publish' }
  }
  if (/^\/v1\/publish-jobs\//u.test(path)) return 'publish'
  if (/^\/v1\/worker-events\//u.test(path)) {
    const operation = new URL(requestTarget, 'http://worker.internal').searchParams.get('operation')
    if (operation === 'publish.reconcile') return 'reconcile'
    if (operation === 'catalog.sync.execute') return 'sync'
    if (operation === 'asset.scan.execute') return 'scan'
    return 'generation'
  }
  if (path === '/v1/internal/automation/tick' || path === '/v1/ops/data-deletion/complete' || path === '/v1/internal/storage/orphans/cleanup') return 'automation'
  if (path === '/v1/internal/support/sla-scan' || path === '/v1/internal/support/sla-report') return 'reconcile'
  if (path.includes('reconciliation')) return 'reconcile'
  if (path === '/v1/internal/model-usage') return 'generation'
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
 * A queued event may outlive an account revoke/re-authorize operation. */
export async function assertPublishExecution(input: {
  apiBaseUrl: string
  apiToken: string
  event: DurableOutboxEvent
  fetcher?: typeof fetch
  signingSecret?: string
  signal?: AbortSignal
  production?: boolean
}): Promise<{ credentialRef: string; payloadHash: string; mediaRequired: boolean; authorizationSnapshot?: Record<string, unknown> }> {
  let response: Response
  try {
    response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}/v1/publish-jobs/${encodeURIComponent(input.event.aggregateId)}/execution-check?event_id=${encodeURIComponent(input.event.id)}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
      redirect: 'error',
      signal: input.signal,
    })
  } catch (error) {
    throw new Error(`publish execution gate unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`publish execution rejected by authorization gate (${response.status})`)
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
    return {
      recheckId: String(raw.recheck_id ?? ''), actorId: String(raw.actor_id ?? ''), identityId: String(raw.identity_id ?? ''), workspaceId: String(raw.workspace_id ?? ''), workbench: raw.workbench === 'workspace' ? 'workspace' : '' as 'workspace', contextId: String(raw.context_id ?? ''), contextVersion: String(raw.context_version ?? ''), policyVersion: String(raw.policy_version ?? ''), grantRevision: String(raw.grant_revision ?? ''), grantIds: Array.isArray(raw.grant_ids) ? raw.grant_ids.filter((value): value is string => typeof value === 'string') : [], scopeHash: String(raw.scope_hash ?? ''), capability: String(raw.capability ?? '') as WorkerAuthorizationRecheck['capability'], resourceId: String(raw.resource_id ?? ''), resourceRevision: String(raw.resource_revision ?? ''), requestId: String(raw.request_id ?? ''), traceId: String(raw.trace_id ?? ''), authorized: raw.authorized === true, checkedAt: String(raw.checked_at ?? ''),
    }
  })
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
      allowed: raw.allowed === true, ready: raw.ready === true, checkedAt: String(raw.checked_at ?? ''),
    }
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

async function updateImageGenerationExecution(input: { apiBaseUrl: string; apiToken: string; event: DurableOutboxEvent; operation: 'claim' | 'reserve_provider_operation' | 'begin_provider_dispatch' | 'provider_started' | 'completed' | 'failed' | 'outcome_unknown'; ownerToken?: string; providerRequestId?: string; errorCode?: string; errorMessage?: string; fetcher?: typeof fetch; signingSecret?: string; signal?: AbortSignal }) {
  const path = `/v1/internal/image-generation-jobs/${encodeURIComponent(input.event.aggregateId)}/execution`
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? workerAuthIntent(input.signingSecret) : {}) },
    body: JSON.stringify({ operation: input.operation, event_id: input.event.id, ...(input.ownerToken ? { owner_token: input.ownerToken } : {}), ...(input.providerRequestId ? { provider_request_id: input.providerRequestId } : {}), ...(input.errorCode ? { error_code: input.errorCode } : {}), ...(input.errorMessage ? { error_message: input.errorMessage } : {}) }),
    redirect: 'error',
    signal: input.signal,
  })
  if (!response.ok) throw Object.assign(new Error(`image generation execution API returned ${response.status}`), { code: response.status === 409 ? 'IMAGE_GENERATION_EXECUTION_BUSY' : 'IMAGE_GENERATION_EXECUTION_GATE_UNAVAILABLE' })
  const envelope = await parseWorkerApiJson(response) as { data?: { execution?: { ownerToken?: string; providerOperationKey?: string } } }
  return envelope.data?.execution
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
    const error = Object.assign(new Error(`model usage API returned ${response.status}`), { code: response.status === 409 || response.status === 503 ? 'MODEL_USAGE_SETTLEMENT_PENDING' : 'MODEL_USAGE_CALLBACK_REJECTED' })
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

export type ImageGenerationReconciliationCandidate = {
  jobId: string
  eventId: string
  intentHash: string
  executionAttempt: number
  queryAttempt?: number
  providerRequestId: string
  executionState: 'provider_started' | 'outcome_unknown'
  actionId?: string
}

/** Stable per-observation key: replaying the same provider observation is safe,
 * while a changed response at the same query attempt remains a server-side
 * idempotency conflict instead of silently overwriting evidence. */
export function imageReconciliationIdempotencyKey(input: Pick<ImageGenerationReconciliationCandidate, 'jobId' | 'eventId' | 'intentHash' | 'executionAttempt' | 'providerRequestId'> & { workspaceId: string; queryAttempt: number }) {
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

export function imageReconciliationNextAttemptAt(input: { observedAt: string; state: ImageGenerationReconciliationEvidence['state']; queryAttempt: number }) {
  if (input.state === 'succeeded' || input.state === 'failed') return undefined
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
  const providerRequestId = input.candidate.providerRequestId.trim()
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
    const executionState = item.execution_state === 'provider_started' || item.execution_state === 'outcome_unknown' ? item.execution_state : undefined
    const executionAttempt = Number(item.execution_attempt ?? item.attempt ?? 0)
    const queryAttempt = Number(item.query_attempt ?? executionAttempt)
    const key = `${jobId}:${eventId}:${intentHash}:${executionAttempt}:${providerRequestId}`
    // Reservation and dispatch fences are pre-provider states. Keep them
    // observable to the API, but never query a Provider without an
    // authoritative request id. Unknown execution states fail closed too.
    if (!jobId || !eventId || !executionState || !/^[a-f0-9]{64}$/u.test(intentHash) || !providerRequestId || !Number.isSafeInteger(executionAttempt) || executionAttempt < 1 || !Number.isSafeInteger(queryAttempt) || queryAttempt < 1 || seen.has(key)) return []
    seen.add(key)
    const actionId = typeof item.action_id === 'string' && item.action_id.trim() ? item.action_id.trim() : undefined
    return [{ jobId, eventId, intentHash, executionAttempt, queryAttempt, providerRequestId, executionState, ...(actionId ? { actionId } : {}) }]
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
      const candidateKey = `${candidate.jobId}:${candidate.eventId}:${candidate.intentHash}:${candidate.executionAttempt}:${candidate.providerRequestId}`
      if (queriedCandidates.has(candidateKey)) continue
      queriedCandidates.add(candidateKey)
      let status: ImageGenerationReconciliationEvidence
      try {
        const observed = await queryImageProviderStatus({ queryStatus: input.queryStatus, providerRequestId: candidate.providerRequestId, signal: input.signal, timeoutMs: input.queryTimeoutMs })
        status = { state: observed.state, providerRequestId: observed.providerRequestId, ...(observed.images ? { images: observed.images } : {}), evidence: observed.evidence }
      } catch (error) {
        status = { ...statusEvidenceFromError(error), providerRequestId: candidate.providerRequestId }
      }
      statusResults.push(await postImageGenerationReconciliationStatus({ ...input, candidate, status }))
    }
    results.push({ page, queried: candidates.length, statusResults })
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
  if (envelope.data?.state === 'succeeded' || envelope.data?.state === 'failed') {
    throw Object.assign(new Error(`generation job is already ${envelope.data.state}`), { code: 'GENERATION_JOB_TERMINAL' })
  }
  if (envelope.data?.state !== 'queued' && envelope.data?.state !== 'running') {
    throw Object.assign(new Error('generation execution gate returned an invalid state'), { code: 'GENERATION_EXECUTION_GATE_INVALID' })
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
  const body = new Uint8Array(await content.arrayBuffer())
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
    modelUsageReconciliationIntervalMs: positiveInt(env.MODEL_USAGE_RECONCILIATION_INTERVAL_MS, DEFAULT_MODEL_USAGE_RECONCILIATION_INTERVAL_MS, 'MODEL_USAGE_RECONCILIATION_INTERVAL_MS'),
    supportSlaScanIntervalMs: positiveInt(env.SUPPORT_SLA_SCAN_INTERVAL_MS, DEFAULT_SUPPORT_SLA_SCAN_INTERVAL_MS, 'SUPPORT_SLA_SCAN_INTERVAL_MS'),
    supportSlaReportIntervalMs: positiveInt(env.SUPPORT_SLA_REPORT_INTERVAL_MS, DEFAULT_SUPPORT_SLA_REPORT_INTERVAL_MS, 'SUPPORT_SLA_REPORT_INTERVAL_MS'),
    imageGenerationReconciliationIntervalMs: positiveInt(env.IMAGE_GENERATION_RECONCILIATION_INTERVAL_MS, DEFAULT_MODEL_USAGE_RECONCILIATION_INTERVAL_MS, 'IMAGE_GENERATION_RECONCILIATION_INTERVAL_MS'),
    workerApiTimeoutMs,
    automationIntervalMs: positiveInt(env.WORKER_AUTOMATION_INTERVAL_MS, 30_000, 'WORKER_AUTOMATION_INTERVAL_MS'),
    batchSize: positiveInt(env.WORKER_BATCH_SIZE, 100, 'WORKER_BATCH_SIZE'),
    workspaceBatchSize: positiveInt(env.WORKER_WORKSPACE_BATCH_SIZE, 10, 'WORKER_WORKSPACE_BATCH_SIZE'),
    leaseMs,
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
  }
}

export async function pollOnce(
  repository: PostgresOutboxRepository,
  dispatchers: Map<string, DurableOutboxDispatcher<DurableOutboxEvent>>,
  config: Pick<WorkerConfig, 'workspaces' | 'batchSize' | 'leaseMs'> & { role?: WorkerRole; workspaceBatchSize?: number; scanMaxAttempts?: number; scanRetryBaseMs?: number; scanRetryMaxMs?: number; claimAdmission?: () => boolean | Promise<boolean> },
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
          { leaseMs: config.leaseMs, claim: config.role && config.role !== 'all' && config.role !== 'automation' ? workerRouting[config.role] : undefined, ...(config.role === 'scan' ? { maxAttempts: config.scanMaxAttempts ?? 12, baseDelayMs: config.scanRetryBaseMs ?? 5_000, maxDelayMs: config.scanRetryMaxMs ?? 900_000 } : {}) },
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

export async function scannerOperationalMetrics(pool: SqlPool, workspaceIds: readonly string[], scanMaxAttempts: number): Promise<{ backlog: number; deadLetter: number; lastCallbackAcceptedAt?: string }> {
  let backlog = 0
  let deadLetter = 0
  let lastCallbackAcceptedAt: string | undefined
  for (let offset = 0; offset < workspaceIds.length; offset += 10) {
    const rows = await Promise.all(workspaceIds.slice(offset, offset + 10).map(workspaceId => withWorkspaceTransaction(pool, workspaceId, async client => {
      const result = await client.query<{ backlog: number | string; dead_letter: number | string; last_callback_accepted_at: Date | string | null }>(
        `SELECT
           count(*) FILTER (WHERE event.published_at IS NULL AND event.unknown_at IS NULL)::integer AS backlog,
           count(*) FILTER (WHERE event.published_at IS NOT NULL AND event.last_error IS NOT NULL
             AND (event.last_error->>'retryable'='false' OR event.attempts >= $3)
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
    }
  }
  return { backlog, deadLetter, ...(lastCallbackAcceptedAt ? { lastCallbackAcceptedAt } : {}) }
}

export async function runWorker(config: WorkerConfig, pool: Pool): Promise<void> {
  const repository = new PostgresOutboxRepository(pool as unknown as SqlPool)
  const dispatchers = new Map<string, DurableOutboxDispatcher<DurableOutboxEvent>>()
  const redisConnection = process.env.REDIS_URL?.trim() ? await connectRedisQueue(process.env.REDIS_URL.trim()) : undefined
  const quotaConnection = await createQuotaCounterStore(process.env.REDIS_URL)
  const quotaAdmission = new FixedWindowQuotaAdmission(quotaConnection.store)
  const executionAuthorization = createApiExecutionAuthorizationGuard(config)
  const commercialAccess = createApiCommercialAccessGuard(config)
  const queueFactory = redisConnection
    ? (workspaceId: string) => new RedisQueueAdapter<DurableOutboxEvent>(redisConnection.transport, workerQueueKey(config.role, workspaceId))
    : undefined
  const mappingExecution = new WorkerMappingExecutionContext()
  const mappingApprovals = new PostgresMappingPreflightApprovalRepository(pool as unknown as SqlPool)
  const scanAttempts = new PostgresAssetScanAttemptRepository(pool as unknown as SqlPool)
  const runtime = new ConnectorRuntime({
    configSource: process.env,
    credentialProvider: createVaultCredentialProviderFromEnv(),
    mappingPreflight: createPersistentWorkerMappingPreflightAdapter({ approvals: mappingApprovals, scopes: createPostgresWorkerMappingScopeLoader(pool), execution: mappingExecution }),
  })
  const generationUsageContexts = new Map<string, { runKey: string; contextHash: string; contextLinkId?: string; taskId: string; campaignItemId?: string; signal?: AbortSignal }>()
  const imageUsageContexts = new Map<string, { runKey: string; contextHash: string; signal?: AbortSignal; providerRequestId?: string }>()
  const contentGenerator = createContentGeneratorFromEnv(process.env, async usage => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for model usage settlement')
    const execution = usage.actionId ? generationUsageContexts.get(usage.actionId) : undefined
    const enriched = execution ? { ...usage, runKey: execution.runKey, contextHash: execution.contextHash, ...(execution.contextLinkId ? { contextLinkId: execution.contextLinkId } : {}), metadata: { ...(usage.metadata ?? {}), task_id: execution.taskId, campaign_item_id: execution.campaignItemId ?? null } } : usage
    return postModelUsage({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, usage: enriched, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal: execution?.signal })
  })
  const imageGenerator = createImageGeneratorFromEnv(process.env, async usage => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for image model usage settlement')
    const execution = usage.actionId ? imageUsageContexts.get(usage.actionId) : undefined
    if (execution && usage.providerRequestId) execution.providerRequestId = usage.providerRequestId
    const enriched = execution ? { ...usage, runKey: execution.runKey, contextHash: execution.contextHash, metadata: { ...(usage.metadata ?? {}), image_job: true } } : usage
    return postModelUsage({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, usage: enriched, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal: execution?.signal })
  })
  const requireImageProviderRequestId = (actionId: string) => {
    const providerRequestId = imageUsageContexts.get(actionId)?.providerRequestId?.trim()
    if (!providerRequestId) throw Object.assign(new Error('image provider response did not expose a real provider request id'), { code: 'IMAGE_PROVIDER_REQUEST_ID_MISSING', retryable: false, unknown: true })
    return providerRequestId
  }
  const scanRoleEnabled = config.role === 'scan' || config.role === 'all'
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
    const remoteId = typeof payload.remote_id === 'string' && payload.remote_id
      ? payload.remote_id
      : typeof fields.remoteId === 'string' && fields.remoteId
        ? fields.remoteId
        : undefined
    const lockRemoteId = remoteId ?? `create:${event.aggregateId}`
    const idempotencyKey = publishIdempotencyKey(event)
    try {
      return await quotaConnection.lock.run(`publish:${event.workspaceId}:${String(platform)}:${accountId}:${lockRemoteId}`, () => mappingExecution.run(event, () => {
        signal?.throwIfAborted()
        return runtime.executePublish({
        platform: platform as 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin',
        context: { workspaceId: event.workspaceId, accountId, ...(execution ? { credentialRef: execution.credentialRef } : {}), traceId: event.id, signal },
        fields,
        ...(media?.length ? { media } : {}),
        ...(remoteId ? { remoteId } : {}),
        // A platform may commit just before transport cancellation. Retrying
        // with this stable key is the fail-closed boundary for that ambiguity.
        idempotencyKey,
      }) }))
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
    const execution = config.apiBaseUrl && config.apiToken ? await assertPublishExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), production: config.environment === 'production', signal }) : undefined
    if (execution && payload.payload_hash !== execution.payloadHash) throw new Error('publish event payload hash does not match the frozen publish job')
    // A publish-job id is an internal tenant-scoped identifier, not a platform
    // remote id. When the initial publish only returned a request id, let the
    // connector resolve the write by the stable idempotency key instead of
    // querying a fabricated platform id.
    const remoteId = typeof payload.remote_id === 'string' && payload.remote_id ? payload.remote_id : undefined
    try {
      return await quotaConnection.lock.run(`publish:${event.workspaceId}:${String(platform)}:${accountId}:${remoteId}`, () => {
        signal?.throwIfAborted()
        return runtime.executeReconcile({
        platform: platform as 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin',
        context: { workspaceId: event.workspaceId, accountId, ...(execution ? { credentialRef: execution.credentialRef } : {}), traceId: event.id, signal },
        ...(typeof payload.remote_id === 'string' ? { remoteId: payload.remote_id } : {}),
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
    await quotaAdmission.admit(quotaAdmissionForEvent(event, 'model', modelKey, config.modelQuotaPerMinute))
    generationUsageContexts.set(actionId, { runKey, contextHash, ...(typeof event.payload.context_link_id === 'string' && event.payload.context_link_id ? { contextLinkId: event.payload.context_link_id } : {}), taskId, ...(typeof event.payload.campaign_item_id === 'string' && event.payload.campaign_item_id ? { campaignItemId: event.payload.campaign_item_id } : {}), signal })
    try { return await contentGenerator.generate(validatedInput, { signal }) }
    finally { generationUsageContexts.delete(actionId) }
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
    await updateImageGenerationExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, operation: 'begin_provider_dispatch', ownerToken, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
    imageUsageContexts.set(actionId, { runKey, contextHash: intentHash, ...(signal ? { signal } : {}) })
    const input: ImageGenerationInput = { productTitle, direction, count, ...(typeof payload.category === 'string' && payload.category ? { category: payload.category } : {}), ...(payload.image_mode === 'create' || payload.image_mode === 'optimize' ? { mode: payload.image_mode } : {}), ...(Array.isArray(payload.source_asset_ids) ? { sourceAssetRefs: payload.source_asset_ids.filter((value): value is string => typeof value === 'string') } : {}), ...(payload.visual_brief && isObject(payload.visual_brief) ? { visualBrief: payload.visual_brief as ImageGenerationInput['visualBrief'] } : {}), usageContext: { workspaceId: event.workspaceId, actionId, runKey } }
    try {
      let images: string[]
      try {
        images = await imageGenerator.generate(input, { signal, providerOperationKey })
        signal?.throwIfAborted()
      } catch (error) {
        if (signal?.aborted) throw error
        const candidate = error as { code?: unknown }
        const failure = { code: typeof candidate.code === 'string' ? candidate.code : 'IMAGE_GENERATION_FAILED', message: error instanceof Error ? error.message : 'image generation failed' }
        const providerRequestId = imageUsageContexts.get(actionId)?.providerRequestId?.trim()
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
      await updateImageGenerationExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, operation: 'provider_started', ownerToken, providerRequestId, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
      try {
        await postImageGenerationResult({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, result: { intent_hash: intentHash, owner_token: ownerToken, provider_request_id: providerRequestId, images }, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
      } catch (error) {
        await updateImageGenerationExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, operation: 'outcome_unknown', ownerToken, errorCode: 'IMAGE_GENERATION_CALLBACK_UNCERTAIN', errorMessage: error instanceof Error ? error.message : 'image callback outcome unknown', ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal }).catch(() => undefined)
        throw error
      }
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
      const result = await runtime.sync(platform as 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin', { workspaceId: event.workspaceId, accountId, credentialRef: execution.credentialRef, traceId: event.id, signal }, cursor, async page => {
        await postSyncProgress({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, event, page: { pageNumber: page.pageNumber, ...(page.cursor ? { cursor: page.cursor } : {}), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), items: page.items as unknown[] }, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
      })
      signal?.throwIfAborted()
      await postSyncResult({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, state: 'succeeded', ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
      return result
    } catch (error) {
      signal?.throwIfAborted()
      await postSyncResult({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, state: error instanceof SyncPaginationError ? 'partial' : 'failed', errorMessage: error instanceof Error ? error.message : 'catalog sync failed', ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
      throw error
    }
  }
  const scanRequested = async (event: DurableOutboxEvent, _projection: unknown, signal?: AbortSignal) => {
    const apiToken = process.env.ASSET_SCANNER_API_TOKEN?.trim()
    const signingSecret = process.env.ASSET_SCANNER_WORKSPACE_SIGNING_SECRET?.trim()
    const privateKey = assetScanReceiptPrivateKeyPem(process.env)
    const keyId = process.env.ASSET_SCAN_RECEIPT_KEY_ID?.trim()
    if (!config.apiBaseUrl || !apiToken || !signingSecret || !privateKey || !keyId) throw Object.assign(new Error('asset scanner callback and receipt credentials are not configured'), { code: 'ASSET_SCANNER_CONFIG_MISSING', retryable: true })
    const scannerInstanceId = process.env.HOSTNAME?.trim() || `worker-${process.pid}`
    return executeAssetScan({ apiBaseUrl: config.apiBaseUrl, apiToken, apiSigningSecret: signingSecret, receiptPrivateKeyPem: privateKey, receiptKeyId: keyId, scannerServiceId: process.env.ASSET_SCANNER_SERVICE_ID?.trim() || 'merchant-asset-scanner', scannerInstanceId, policyVersion: process.env.ASSET_SCAN_POLICY_VERSION?.trim() || '2026-08-30', clamavHost, clamavPort, clamavTimeoutMs, definitionsMaxAgeSeconds: positiveInt(process.env.SCANNER_DEFINITIONS_MAX_AGE_SECONDS, 86_400, 'SCANNER_DEFINITIONS_MAX_AGE_SECONDS'), attemptRepository: scanAttempts, event, signal, onCallbackAccepted: acceptedAt => redisConnection!.scannerHeartbeat.recordCallbackAccepted(scannerInstanceId, acceptedAt, positiveInt(process.env.SCANNER_CALLBACK_MAX_AGE_SECONDS, 86_400, 'SCANNER_CALLBACK_MAX_AGE_SECONDS')) })
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
    await postGenerationResult({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, result, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
  }
  const onGenerationDeferred = async (event: DurableOutboxEvent, error: { retryAfterSeconds: number; code: string; message: string }, _projection: unknown, signal?: AbortSignal) => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for generation defer')
    await postGenerationDeferred({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, retryAfterSeconds: error.retryAfterSeconds, code: error.code, message: error.message, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}), signal })
  }
  let stopping = false
  let nextStorageReconciliationAt = 0
  let nextModelUsageReconciliationAt = 0
  let nextImageGenerationReconciliationAt = 0
  let nextSupportSlaScanAt = 0
  let nextSupportSlaReportAt = 0
  const readyFile = process.env.WORKER_READY_FILE ?? '/tmp/merchant-worker-ready'
  let scannerHeartbeat: ScannerHeartbeatController | undefined
  const stop = () => { stopping = true }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    // Container restarts reuse /tmp. Remove a stale marker before touching any
    // dependency so a failed restart can never inherit readiness.
    await unlink(readyFile).catch(() => undefined)
    const expectedMigrations = await loadMigrations()
    if (scanRoleEnabled) {
      const instanceId = process.env.HOSTNAME?.trim() || `worker-${process.pid}`
      const heartbeatIntervalMs = positiveInt(process.env.SCANNER_HEARTBEAT_INTERVAL_MS, 5_000, 'SCANNER_HEARTBEAT_INTERVAL_MS')
      const heartbeatTtlSeconds = positiveInt(process.env.SCANNER_HEARTBEAT_TTL_SECONDS, 15, 'SCANNER_HEARTBEAT_TTL_SECONDS')
      const callbackMaxAgeSeconds = positiveInt(process.env.SCANNER_CALLBACK_MAX_AGE_SECONDS, 86_400, 'SCANNER_CALLBACK_MAX_AGE_SECONDS')
      if (heartbeatTtlSeconds * 1000 <= heartbeatIntervalMs * 2) throw new Error('SCANNER_HEARTBEAT_TTL_SECONDS must exceed two heartbeat intervals')
      const currentWorkspaces = async () => config.autoDiscoverWorkspaces ? await repository.listActiveWorkspaceIds() : config.workspaces
      // Redis heartbeat state is instance-scoped and intentionally ephemeral.
      // Rehydrate the callback proof from the durable tenant records before the
      // first readiness probe so a normal worker restart does not manufacture a
      // false negative, while still keeping the durable callback age gate.
      const durableScannerMetrics = await scannerOperationalMetrics(pool as unknown as SqlPool, await currentWorkspaces(), config.scanMaxAttempts)
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
          definitionsMaxAgeSeconds: positiveInt(process.env.SCANNER_DEFINITIONS_MAX_AGE_SECONDS, 86_400, 'SCANNER_DEFINITIONS_MAX_AGE_SECONDS'),
          eicarMaxAgeSeconds: positiveInt(process.env.SCANNER_EICAR_MAX_AGE_SECONDS, 900, 'SCANNER_EICAR_MAX_AGE_SECONDS'),
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
          return { backlog: metrics.backlog, deadLetter: metrics.deadLetter }
        },
        onHeartbeat: heartbeat => {
          // Compose health describes process/dependency recovery capability,
          // while API scanner readiness also gates on unresolved dead letters.
          // Keep those signals separate: a scanner must stay healthy enough to
          // recover its queue without making new business scans admissible.
          void (heartbeat.recoveryCapable
            ? writeFile(readyFile, JSON.stringify({ readyAt: new Date().toISOString(), role: config.role, state: heartbeat.ready ? 'ready' : 'recovery', heartbeat }))
            : unlink(readyFile).catch(() => undefined))
          log({ level: heartbeat.ready ? 'info' : 'error', message: 'scanner heartbeat published', heartbeat })
        },
      })
      await scannerHeartbeat.start()
    }
    let dependenciesReady = false
    let nextDependencyCheckAt = 0
    do {
      const startedAt = Date.now()
      try {
        if (!dependenciesReady || startedAt >= nextDependencyCheckAt) {
          dependenciesReady = false
          const dependencyState = await assertWorkerReadinessDependencies({ database: pool, ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}), ...(scannerHeartbeat ? { apiHealthPath: '/healthz' as const } : {}), expectedMigrations })
          if (clamavReadiness && !scannerHeartbeat) await clamavReadiness.ping()
          dependenciesReady = true
          nextDependencyCheckAt = startedAt + config.dependencyCheckIntervalMs
          if (!scannerHeartbeat) await writeFile(readyFile, JSON.stringify({ readyAt: new Date().toISOString(), role: config.role, state: 'idle', quotaAdmission: quotaConnection.mode, migrationVersion: dependencyState.migrationVersion, apiReady: dependencyState.apiReady }))
        }
        const workspaces = config.autoDiscoverWorkspaces ? await repository.listActiveWorkspaceIds() : config.workspaces
        const result = scannerHeartbeat && !scannerHeartbeat.canProcessScans()
          ? { restored: 0, processed: 0, succeeded: 0, unknown: 0, queued: 0, deadLetter: 0 }
          : config.role === 'automation'
          ? await (async () => {
            if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for automation ticks')
            return runAutomationMaintenance({
              workspaces,
              tick: workspaceId => postAutomationTick({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, workspaceId, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }) as Promise<{ data?: { result?: { executed?: unknown[] } } }>,
              cleanup: workspaceId => postObjectOrphanCleanup({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, workspaceId, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }) as Promise<{ data?: { cleaned?: number } }>,
              onError: (workspaceId, operation, error) => log({ level: 'error', message: 'automation workspace maintenance failed; continuing', workspaceId, operation, error: serializeError(error) }),
            })
          })()
          : await pollOnce(repository, dispatchers, { ...config, workspaces, ...(scannerHeartbeat ? { claimAdmission: () => scannerHeartbeat!.canProcessScans() } : {}) }, queueFactory, { executionAuthorization, commercialAccess, publishRequested, reconcileRequested, generationRequested, imageGenerationRequested, syncRequested, scanRequested, imageContinuationRequested, onGenerationResult, onGenerationDeferred, onPublishObservation })
        if (config.role === 'reconcile' && startedAt >= nextStorageReconciliationAt) {
          if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for storage reconciliation')
          const reconciliation = await allSettledWithConcurrency(workspaces, config.workspaceBatchSize, workspaceId => postStorageReconciliation({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, workspaceId, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }))
          nextStorageReconciliationAt = Date.now() + config.storageReconciliationIntervalMs
          Object.assign(result as unknown as Record<string, unknown>, { storageReconciliation: { completed: reconciliation.filter(item => item.status === 'fulfilled').length, failed: reconciliation.filter(item => item.status === 'rejected').length } })
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
        if (!scannerHeartbeat) await writeFile(readyFile, JSON.stringify({ readyAt: new Date().toISOString(), role: config.role, workspaces: workspaces.length, quotaAdmission: quotaConnection.mode, ...result }))
        log({ level: 'info', message: 'worker poll completed', ...result, durationMs: Date.now() - startedAt })
      } catch (error) {
        dependenciesReady = false
        await unlink(readyFile).catch(() => undefined)
        log({ level: 'error', message: 'worker poll failed; retrying', error: serializeError(error) })
      }
      if (!config.once && !stopping) await sleep(!dependenciesReady ? config.dependencyCheckIntervalMs : config.role === 'automation' ? config.automationIntervalMs : config.pollIntervalMs)
    } while (!config.once && !stopping)
  } finally {
    await scannerHeartbeat?.stop()
    await redisConnection?.close()
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

function parseWorkerRole(raw: string | undefined): WorkerRole {
  const role = raw?.trim() || 'all'
  if (!['all', 'sync', 'generation', 'publish', 'reconcile', 'automation', 'scan'].includes(role)) throw new Error(`WORKER_ROLE must be one of all, sync, generation, publish, reconcile, automation, scan`)
  return role as WorkerRole
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

function serializeError(error: unknown): { message: string; code?: string } {
  const candidate = error as { message?: unknown; code?: unknown }
  return { message: typeof candidate?.message === 'string' ? candidate.message : String(error), ...(typeof candidate?.code === 'string' ? { code: candidate.code } : {}) }
}

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }

function log(value: Record<string, unknown>) { process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), service: 'worker', ...value })}\n`) }

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  const config = readWorkerConfig()
  const pool = new Pool({ connectionString: config.databaseUrl, max: Number(process.env.WORKER_DB_POOL_MAX ?? 5), connectionTimeoutMillis: Number(process.env.WORKER_DB_CONNECTION_TIMEOUT_MS ?? 3000) })
  runWorker(config, pool).catch(error => {
    log({ level: 'fatal', message: 'worker stopped', error: serializeError(error) })
    process.exitCode = 1
  }).finally(() => { void pool.end() })
}
