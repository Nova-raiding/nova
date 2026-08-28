import { pathToFileURL } from 'node:url'
import { createHash, createHmac } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { contextEnvelopeHash, PostgresOutboxRepository, type SqlPool } from '../../../packages/persistence/src/index.js'
import { DurableOutboxDispatcher, InMemoryQueue, RedisQueueAdapter, type DurableOutboxEvent, type QueuePort, type RedisQueueTransport } from '../../../packages/workers/src/durable.js'
import { createOutboxHandler, createWorkerProjection } from './handler.js'
import { connectRedisQueue } from './redis-transport.js'
import { ConnectorRuntime, SyncPaginationError } from '../../../packages/application/src/connector-runtime.js'
import { createVaultCredentialProviderFromEnv } from '../../../packages/connectors/src/index.js'
import { readBoundedResponseText } from '../../../packages/connectors/src/bounded-response.js'
import type { PublishHandlerResult } from '../../../packages/workers/src/publish-adapter.js'
import { buildPublishObservationRequest, PublishObservationReportError } from '../../../packages/workers/src/publish-observation.js'
import { createContentGeneratorFromEnv, type ContentGenerationInput, type GeneratedContent } from '../../../packages/ai/src/generator.js'
import type { RelayUsageRecord } from '../../../packages/ai/src/relay-usage.js'
import { FixedWindowQuotaAdmission } from '../../../packages/quotas/src/admission.js'
import { DistributedLockBusyError } from '../../../packages/quotas/src/lock.js'
import { createQuotaCounterStore } from './quota-transport.js'

export interface WorkerConfig {
  databaseUrl: string
  workspaces: string[]
  autoDiscoverWorkspaces: boolean
  pollIntervalMs: number
  automationIntervalMs: number
  batchSize: number
  workspaceBatchSize: number
  leaseMs: number
  once: boolean
  apiBaseUrl?: string
  apiToken?: string
  apiSigningSecret?: string
  platformQuotaPerMinute: number
  modelQuotaPerMinute: number
  role: WorkerRole
}

export type WorkerRole = 'all' | 'sync' | 'generation' | 'publish' | 'reconcile' | 'automation'

const workerRouting: Record<Exclude<WorkerRole, 'all' | 'automation'>, { eventTypes: string[]; snapshotEntityTypes?: string[] }> = {
  sync: { eventTypes: ['sync.requested', 'state.snapshot'], snapshotEntityTypes: ['product', 'platform_account', 'sync_job'] },
  generation: { eventTypes: ['task.created', 'state.snapshot', 'generation.requested'], snapshotEntityTypes: ['task', 'content_version'] },
  publish: { eventTypes: ['publish.requested'] },
  reconcile: { eventTypes: ['publish.reconcile_requested'] },
}

const DEFAULT_WORKER_API_TIMEOUT_MS = 10_000
const MAX_WORKER_API_RESPONSE_BYTES = 24 * 1024 * 1024

async function parseWorkerApiJson(response: Response): Promise<unknown> {
  return JSON.parse(await readBoundedResponseText(response, MAX_WORKER_API_RESPONSE_BYTES, 'worker API response')) as unknown
}

async function fetchWorkerApi(fetcher: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const configured = Number(process.env.WORKER_API_TIMEOUT_MS ?? DEFAULT_WORKER_API_TIMEOUT_MS)
  const timeoutMs = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_WORKER_API_TIMEOUT_MS
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetcher(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function postSyncProgress(input: { apiBaseUrl: string; apiToken: string; event: DurableOutboxEvent; page: { pageNumber: number; cursor?: string; nextCursor?: string; items: unknown[]; }; fetcher?: typeof fetch; signingSecret?: string }) {
  const path = `/v1/sync-jobs/${encodeURIComponent(input.event.aggregateId)}/progress`
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? { 'x-worker-workspace-signature': workerSignature(input.signingSecret, 'POST', path, input.event.workspaceId) } : {}) },
    body: JSON.stringify({ page_number: input.page.pageNumber, ...(input.page.cursor ? { cursor: input.page.cursor } : {}), ...(input.page.nextCursor ? { next_cursor: input.page.nextCursor } : {}), items: input.page.items }), redirect: 'error',
  })
  if (!response.ok) throw new Error(`sync progress API returned ${response.status}`)
}

export async function postAutomationTick(input: { apiBaseUrl: string; apiToken: string; workspaceId: string; signingSecret?: string; fetcher?: typeof fetch }) {
  const path = '/v1/internal/automation/tick'
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.workspaceId, ...(input.signingSecret ? { 'x-worker-workspace-signature': workerSignature(input.signingSecret, 'POST', path, input.workspaceId) } : {}) }, redirect: 'error',
  })
  if (!response.ok) throw new Error(`automation tick API returned ${response.status}`)
  return await parseWorkerApiJson(response)
}

async function postSyncResult(input: { apiBaseUrl: string; apiToken: string; event: DurableOutboxEvent; state: 'succeeded' | 'partial' | 'failed'; errorMessage?: string; fetcher?: typeof fetch; signingSecret?: string }) {
  const path = `/v1/sync-jobs/${encodeURIComponent(input.event.aggregateId)}/result`
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? { 'x-worker-workspace-signature': workerSignature(input.signingSecret, 'POST', path, input.event.workspaceId) } : {}) },
    body: JSON.stringify({ state: input.state, ...(input.errorMessage ? { error_message: input.errorMessage } : {}) }), redirect: 'error',
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

export async function postPublishObservation(input: {
  apiBaseUrl: string
  apiToken: string
  event: DurableOutboxEvent
  observation: PublishHandlerResult
  fetcher?: typeof fetch
  signingSecret?: string
}): Promise<void> {
  const source = input.event.eventType === 'publish.reconcile_requested' ? 'reconcile' : 'publish'
  const payload = buildPublishObservationRequest(input.observation, { source })
  let response: Response
  try {
    response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}/v1/publish-jobs/${encodeURIComponent(input.event.aggregateId)}/observation`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? { 'x-worker-workspace-signature': workerSignature(input.signingSecret, 'POST', `/v1/publish-jobs/${encodeURIComponent(input.event.aggregateId)}/observation`, input.event.workspaceId) } : {}) },
      body: JSON.stringify(payload),
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
}): Promise<{ credentialRef: string; payloadHash: string; mediaRequired: boolean }> {
  let response: Response
  try {
    response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}/v1/publish-jobs/${encodeURIComponent(input.event.aggregateId)}/execution-check`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? { 'x-worker-workspace-signature': workerSignature(input.signingSecret, 'GET', `/v1/publish-jobs/${encodeURIComponent(input.event.aggregateId)}/execution-check`, input.event.workspaceId) } : {}) },
      redirect: 'error',
    })
  } catch (error) {
    throw new Error(`publish execution gate unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`publish execution rejected by authorization gate (${response.status})`)
  const envelope = await parseWorkerApiJson(response) as { data?: { credential_ref?: string; payload_hash?: string; media_required?: boolean } }
  if (typeof envelope.data?.credential_ref !== 'string' || !envelope.data.credential_ref) throw new Error('publish execution gate did not return a credential locator')
  if (typeof envelope.data.payload_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(envelope.data.payload_hash)) throw new Error('publish execution gate did not return a payload hash')
  return { credentialRef: envelope.data.credential_ref, payloadHash: envelope.data.payload_hash, mediaRequired: envelope.data.media_required === true }
}

export async function fetchPublishMedia(input: { apiBaseUrl: string; apiToken: string; event: DurableOutboxEvent; fetcher?: typeof fetch; signingSecret?: string }) {
  const path = `/v1/publish-jobs/${encodeURIComponent(input.event.aggregateId)}/media`
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/u, '')}${path}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? { 'x-worker-workspace-signature': workerSignature(input.signingSecret, 'GET', path, input.event.workspaceId) } : {}) },
    redirect: 'error',
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

async function syncExecutionContext(input: { apiBaseUrl: string; apiToken: string; event: DurableOutboxEvent; signingSecret?: string }) {
  const path = `/v1/sync-jobs/${encodeURIComponent(input.event.aggregateId)}/execution-context`
  const response = await fetchWorkerApi(fetch, `${input.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? { 'x-worker-workspace-signature': workerSignature(input.signingSecret, 'GET', path, input.event.workspaceId) } : {}) },
    redirect: 'error',
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
}): Promise<void> {
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}/v1/generation-jobs/${encodeURIComponent(input.event.aggregateId)}/result`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? { 'x-worker-workspace-signature': workerSignature(input.signingSecret, 'POST', `/v1/generation-jobs/${encodeURIComponent(input.event.aggregateId)}/result`, input.event.workspaceId) } : {}) },
    body: JSON.stringify(input.result),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`generation result API returned ${response.status}`)
}

export async function postModelUsage(input: { apiBaseUrl: string; apiToken: string; usage: RelayUsageRecord; fetcher?: typeof fetch; signingSecret?: string }) {
  const workspaceId = input.usage.workspaceId?.trim()
  if (!workspaceId) throw new Error('model usage callback requires workspaceId')
  const path = '/v1/internal/model-usage'
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': workspaceId, ...(input.signingSecret ? { 'x-worker-workspace-signature': workerSignature(input.signingSecret, 'POST', path, workspaceId) } : {}) },
    body: JSON.stringify(input.usage),
    redirect: 'error',
  })
  if (!response.ok) {
    const error = Object.assign(new Error(`model usage API returned ${response.status}`), { code: response.status === 409 || response.status === 503 ? 'MODEL_USAGE_SETTLEMENT_PENDING' : 'MODEL_USAGE_CALLBACK_REJECTED' })
    throw error
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
}): Promise<void> {
  const path = `/v1/generation-jobs/${encodeURIComponent(input.event.aggregateId)}/defer`
  const response = await fetchWorkerApi(input.fetcher ?? fetch, `${input.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${input.apiToken}`, 'x-workspace-id': input.event.workspaceId, ...(input.signingSecret ? { 'x-worker-workspace-signature': workerSignature(input.signingSecret, 'POST', path, input.event.workspaceId) } : {}) },
    body: JSON.stringify({ code: input.code ?? 'QUOTA_EXHAUSTED', message: input.message ?? 'provider quota exhausted; waiting for retry window', retry_after_seconds: input.retryAfterSeconds }),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`generation defer API returned ${response.status}`)
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
  const callbackRole = role === 'all' || role === 'sync' || role === 'generation' || role === 'publish' || role === 'reconcile' || role === 'automation'
  if (env.NODE_ENV === 'production' && callbackRole && (!apiBaseUrl || !apiToken || !apiSigningSecret)) {
    throw new Error('production callback workers require WORKER_API_BASE_URL, WORKER_API_TOKEN and WORKER_API_SIGNING_SECRET')
  }
  return {
    databaseUrl,
    workspaces: [...new Set(workspaces)],
    autoDiscoverWorkspaces,
    pollIntervalMs: positiveInt(env.WORKER_POLL_INTERVAL_MS, 1_000, 'WORKER_POLL_INTERVAL_MS'),
    automationIntervalMs: positiveInt(env.WORKER_AUTOMATION_INTERVAL_MS, 30_000, 'WORKER_AUTOMATION_INTERVAL_MS'),
    batchSize: positiveInt(env.WORKER_BATCH_SIZE, 100, 'WORKER_BATCH_SIZE'),
    workspaceBatchSize: positiveInt(env.WORKER_WORKSPACE_BATCH_SIZE, 10, 'WORKER_WORKSPACE_BATCH_SIZE'),
    leaseMs: positiveInt(env.WORKER_LEASE_MS, 30_000, 'WORKER_LEASE_MS'),
    once: env.WORKER_ONCE === 'true',
    role,
    ...(apiBaseUrl ? { apiBaseUrl: apiBaseUrl.replace(/\/$/, '') } : {}),
    ...(apiToken ? { apiToken } : {}),
    ...(apiSigningSecret ? { apiSigningSecret } : {}),
    platformQuotaPerMinute: positiveInt(env.WORKER_PLATFORM_QUOTA_PER_MINUTE, 60, 'WORKER_PLATFORM_QUOTA_PER_MINUTE'),
    modelQuotaPerMinute: positiveInt(env.WORKER_MODEL_QUOTA_PER_MINUTE, 60, 'WORKER_MODEL_QUOTA_PER_MINUTE'),
  }
}

export async function pollOnce(
  repository: PostgresOutboxRepository,
  dispatchers: Map<string, DurableOutboxDispatcher<DurableOutboxEvent>>,
  config: Pick<WorkerConfig, 'workspaces' | 'batchSize' | 'leaseMs'> & { role?: WorkerRole; workspaceBatchSize?: number },
  queueFactory: (workspaceId: string) => QueuePort<DurableOutboxEvent> = () => new InMemoryQueue<DurableOutboxEvent>(),
  handlerOptions: Parameters<typeof createOutboxHandler>[0] = {},
): Promise<WorkerPollResult> {
  const result: WorkerPollResult = { restored: 0, processed: 0, succeeded: 0, unknown: 0, queued: 0, deadLetter: 0 }
  // Round-robin over workspace-scoped queues. The global batch cap is enforced
  // across all tenants (not once per tenant), while the per-workspace quantum
  // keeps a noisy tenant from consuming the whole poll.
  const workspaceBatchSize = Math.max(1, Math.min(config.batchSize, config.workspaceBatchSize ?? 10))
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
          { leaseMs: config.leaseMs, claim: config.role && config.role !== 'all' && config.role !== 'automation' ? workerRouting[config.role] : undefined },
        )
        dispatchers.set(workspaceId, dispatcher)
      }
      const allowance = Math.min(workspaceBatchSize, remaining)
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

export async function runWorker(config: WorkerConfig, pool: Pool): Promise<void> {
  const repository = new PostgresOutboxRepository(pool as unknown as SqlPool)
  const dispatchers = new Map<string, DurableOutboxDispatcher<DurableOutboxEvent>>()
  const redisConnection = process.env.REDIS_URL?.trim() ? await connectRedisQueue(process.env.REDIS_URL.trim()) : undefined
  const quotaConnection = await createQuotaCounterStore(process.env.REDIS_URL)
  const quotaAdmission = new FixedWindowQuotaAdmission(quotaConnection.store)
  const queueFactory = redisConnection
    ? (workspaceId: string) => new RedisQueueAdapter<DurableOutboxEvent>(redisConnection.transport, `merchant:outbox:${workspaceId}`)
    : undefined
  const runtime = new ConnectorRuntime({ configSource: process.env, credentialProvider: createVaultCredentialProviderFromEnv() })
  const generationUsageContexts = new Map<string, { contextHash: string; contextLinkId?: string; taskId: string; campaignItemId?: string }>()
  const contentGenerator = createContentGeneratorFromEnv(process.env, async usage => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for model usage settlement')
    const execution = usage.actionId ? generationUsageContexts.get(usage.actionId) : undefined
    const enriched = execution ? { ...usage, metadata: { ...(usage.metadata ?? {}), context_hash: execution.contextHash, context_link_id: execution.contextLinkId ?? null, task_id: execution.taskId, campaign_item_id: execution.campaignItemId ?? null } } : usage
    await postModelUsage({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, usage: enriched, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) })
  })
  const publishRequested = async (event: DurableOutboxEvent): Promise<PublishHandlerResult> => {
    const payload = event.payload
    const platform = payload.platform
    const accountId = payload.account_id
    const fields = payload.fields
    if (!['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'].includes(String(platform)) || typeof accountId !== 'string' || !accountId || !isObject(fields)) {
      throw new Error('publish event is missing platform, account_id or fields')
    }
    await quotaAdmission.admit({ namespace: 'platform', key: `${String(platform)}:${accountId}`, limitPerWindow: config.platformQuotaPerMinute })
    const execution = config.apiBaseUrl && config.apiToken ? await assertPublishExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }) : undefined
    if (execution && payload.payload_hash !== execution.payloadHash) throw new Error('publish event payload hash does not match the frozen publish job')
    const media = execution?.mediaRequired && config.apiBaseUrl && config.apiToken ? await fetchPublishMedia({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }) : undefined
    const remoteId = typeof payload.remote_id === 'string' && payload.remote_id
      ? payload.remote_id
      : typeof fields.remoteId === 'string' && fields.remoteId
        ? fields.remoteId
        : undefined
    const lockRemoteId = remoteId ?? `create:${event.aggregateId}`
    try {
      return await quotaConnection.lock.run(`publish:${event.workspaceId}:${String(platform)}:${accountId}:${lockRemoteId}`, () => runtime.executePublish({
        platform: platform as 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin',
        context: { workspaceId: event.workspaceId, accountId, ...(execution ? { credentialRef: execution.credentialRef } : {}), traceId: event.id },
        fields,
        ...(media?.length ? { media } : {}),
        ...(remoteId ? { remoteId } : {}),
        idempotencyKey: typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : event.aggregateId,
      }))
    } catch (error) {
      if (error instanceof DistributedLockBusyError) throw { normalized: { code: error.code, message: error.message, retryable: true, unknown: false } }
      throw error
    }
  }
  const reconcileRequested = async (event: DurableOutboxEvent): Promise<PublishHandlerResult> => {
    const payload = event.payload
    const platform = payload.platform
    const accountId = payload.account_id
    if (!['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'].includes(String(platform)) || typeof accountId !== 'string' || !accountId) throw new Error('reconcile event is missing platform or account_id')
    if (typeof payload.payload_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.payload_hash)) throw new Error('reconcile event is missing a valid payload hash')
    await quotaAdmission.admit({ namespace: 'platform', key: `${String(platform)}:${accountId}:reconcile`, limitPerWindow: config.platformQuotaPerMinute })
    const execution = config.apiBaseUrl && config.apiToken ? await assertPublishExecution({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }) : undefined
    if (execution && payload.payload_hash !== execution.payloadHash) throw new Error('publish event payload hash does not match the frozen publish job')
    const remoteId = typeof payload.remote_id === 'string' && payload.remote_id ? payload.remote_id : event.aggregateId
    try {
      return await quotaConnection.lock.run(`publish:${event.workspaceId}:${String(platform)}:${accountId}:${remoteId}`, () => runtime.executeReconcile({
        platform: platform as 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin',
        context: { workspaceId: event.workspaceId, accountId, ...(execution ? { credentialRef: execution.credentialRef } : {}), traceId: event.id },
        ...(typeof payload.remote_id === 'string' ? { remoteId: payload.remote_id } : {}),
        idempotencyKey: typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : event.aggregateId,
      }))
    } catch (error) {
      if (error instanceof DistributedLockBusyError) throw { normalized: { code: error.code, message: error.message, retryable: true, unknown: false } }
      throw error
    }
  }
  const generationRequested = async (event: DurableOutboxEvent): Promise<GeneratedContent> => {
    if (!contentGenerator) throw new Error('AI generation provider is not configured')
    const input = event.payload.input
    if (!isObject(input)) throw new Error('generation event is missing input')
    const contextHash = event.payload.context_hash
    const actionId = event.payload.action_id
    if (typeof contextHash !== 'string' || !/^[a-f0-9]{64}$/u.test(contextHash)) throw new Error('generation event is missing context_hash')
    if (contextEnvelopeHash(input) !== contextHash) throw new Error('generation event context hash mismatch')
    if (typeof actionId !== 'string' || !actionId || !isObject(input.usageContext) || input.usageContext.workspaceId !== event.workspaceId || input.usageContext.actionId !== actionId) throw new Error('generation event usage context mismatch')
    const taskId = event.payload.task_id
    if (typeof taskId !== 'string' || !taskId) throw new Error('generation event is missing task_id')
    const modelKey = process.env.AI_MODEL?.trim() ?? process.env.MODEL_ID?.trim() ?? 'configured-model'
    await quotaAdmission.admit({ namespace: 'model', key: modelKey, limitPerWindow: config.modelQuotaPerMinute })
    generationUsageContexts.set(actionId, { contextHash, ...(typeof event.payload.context_link_id === 'string' && event.payload.context_link_id ? { contextLinkId: event.payload.context_link_id } : {}), taskId, ...(typeof event.payload.campaign_item_id === 'string' && event.payload.campaign_item_id ? { campaignItemId: event.payload.campaign_item_id } : {}) })
    try { return await contentGenerator.generate(input as unknown as ContentGenerationInput) }
    finally { generationUsageContexts.delete(actionId) }
  }
  const syncRequested = async (event: DurableOutboxEvent): Promise<unknown> => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for sync result callbacks')
    const platform = event.payload.platform
    const accountId = event.payload.account_id
    if (!['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'].includes(String(platform)) || typeof accountId !== 'string' || !accountId) throw new Error('sync event is missing platform or account_id')
    const execution = await syncExecutionContext({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) })
    const remoteJob = await fetchWorkerApi(fetch, `${config.apiBaseUrl}/v1/sync-jobs/${encodeURIComponent(event.aggregateId)}`, { headers: { accept: 'application/json', authorization: `Bearer ${config.apiToken}`, 'x-workspace-id': event.workspaceId, ...(config.apiSigningSecret ? { 'x-worker-workspace-signature': workerSignature(config.apiSigningSecret, 'GET', `/v1/sync-jobs/${encodeURIComponent(event.aggregateId)}`, event.workspaceId) } : {}) }, redirect: 'error' })
    if (!remoteJob.ok) throw new Error(`sync job API returned ${remoteJob.status}`)
    const envelope = await parseWorkerApiJson(remoteJob) as { data?: { resumeCursor?: string; state?: string } }
    const cursor = typeof envelope.data?.resumeCursor === 'string' ? envelope.data.resumeCursor : typeof event.payload.cursor === 'string' ? event.payload.cursor : undefined
    try {
      const result = await runtime.sync(platform as 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin', { workspaceId: event.workspaceId, accountId, credentialRef: execution.credentialRef, traceId: event.id }, cursor, async page => {
        await postSyncProgress({ apiBaseUrl: config.apiBaseUrl!, apiToken: config.apiToken!, event, page: { pageNumber: page.pageNumber, ...(page.cursor ? { cursor: page.cursor } : {}), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), items: page.items as unknown[] }, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) })
      })
      await postSyncResult({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, state: 'succeeded', ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) })
      return result
    } catch (error) {
      await postSyncResult({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, state: error instanceof SyncPaginationError ? 'partial' : 'failed', errorMessage: error instanceof Error ? error.message : 'catalog sync failed', ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) })
      throw error
    }
  }
  const onPublishObservation = async (event: DurableOutboxEvent, observation: PublishHandlerResult) => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for publish observation')
    await postPublishObservation({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, observation, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) })
  }
  const onGenerationResult = async (event: DurableOutboxEvent, result: { content?: GeneratedContent; error?: { code: string; message: string } }) => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for generation result')
    await postGenerationResult({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, result, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) })
  }
  const onGenerationDeferred = async (event: DurableOutboxEvent, error: { retryAfterSeconds: number; code: string; message: string }) => {
    if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for generation defer')
    await postGenerationDeferred({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, event, retryAfterSeconds: error.retryAfterSeconds, code: error.code, message: error.message, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) })
  }
  let stopping = false
  const readyFile = process.env.WORKER_READY_FILE ?? '/tmp/merchant-worker-ready'
  const stop = () => { stopping = true }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    do {
      const startedAt = Date.now()
      try {
        const workspaces = config.autoDiscoverWorkspaces ? await repository.listActiveWorkspaceIds() : config.workspaces
        const result = config.role === 'automation'
          ? await (async () => {
            if (!config.apiBaseUrl || !config.apiToken) throw new Error('WORKER_API_BASE_URL and WORKER_API_TOKEN are required for automation ticks')
            let executed = 0
            for (const workspaceId of workspaces) {
              const response = await postAutomationTick({ apiBaseUrl: config.apiBaseUrl, apiToken: config.apiToken, workspaceId, ...(config.apiSigningSecret ? { signingSecret: config.apiSigningSecret } : {}) }) as { data?: { result?: { executed?: unknown[] } } }
              executed += Array.isArray(response.data?.result?.executed) ? response.data.result.executed.length : 0
            }
            return { restored: 0, processed: executed, succeeded: executed, unknown: 0, queued: 0, deadLetter: 0 }
          })()
          : await pollOnce(repository, dispatchers, { ...config, workspaces }, queueFactory, { publishRequested, reconcileRequested, generationRequested, syncRequested, onGenerationResult, onGenerationDeferred, onPublishObservation })
        await writeFile(readyFile, JSON.stringify({ readyAt: new Date().toISOString(), role: config.role, workspaces: workspaces.length, quotaAdmission: quotaConnection.mode, ...result }))
        log({ level: 'info', message: 'worker poll completed', ...result, durationMs: Date.now() - startedAt })
      } catch (error) {
        log({ level: 'error', message: 'worker poll failed; retrying', error: serializeError(error) })
      }
      if (!config.once && !stopping) await sleep(config.role === 'automation' ? config.automationIntervalMs : config.pollIntervalMs)
    } while (!config.once && !stopping)
  } finally {
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
  if (!['all', 'sync', 'generation', 'publish', 'reconcile', 'automation'].includes(role)) throw new Error(`WORKER_ROLE must be one of all, sync, generation, publish, reconcile, automation`)
  return role as WorkerRole
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

function serializeError(error: unknown): { message: string; code?: string } {
  const candidate = error as { message?: unknown; code?: unknown }
  return { message: typeof candidate?.message === 'string' ? candidate.message : String(error), ...(typeof candidate?.code === 'string' ? { code: candidate.code } : {}) }
}

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }

function workerSignature(secret: string, method: string, path: string, workspaceId: string) {
  return createHmac('sha256', secret).update(`${method}\n${path}\n${workspaceId}`).digest('hex')
}

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
