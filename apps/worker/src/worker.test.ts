import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createOutboxHandler, createWorkerProjection, type WorkerHandlerOptions } from './handler.js'
import { allSettledWithConcurrency, assertGenerationExecution, assertPublishExecution, assertWorkerReadinessDependencies, createApiExecutionAuthorizationGuard, executeImageGenerationContinuations, fetchPublishMedia, hasCompleteScanCallbackCredentials, imageReconciliationIdempotencyKey, imageReconciliationNextAttemptAt, isImageProviderOutcomeUnknown, pollOnce, postAutomationTick, postImageGenerationReconciliation, postImageGenerationReconciliationStatus, postImageGenerationResult, postModelUsage, postModelUsageReconciliation, postObjectOrphanCleanup, postSupportSlaScan, publishIdempotencyKey, quotaAdmissionForEvent, readWorkerConfig, reconcileImageGenerationWorkspace, requireImageGenerationActionId, requireModelRunKey, runAutomationMaintenance, workerQueueKey } from './main.js'
import type { PostgresOutboxRepository } from '../../../packages/persistence/src/index.js'
import { DurableOutboxDispatcher, InMemoryQueue, type DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import { QuotaExceededError } from '../../../packages/quotas/src/admission.js'
import type { WorkerExecutionAuthorizationGuard } from '../../../packages/workers/src/execution-authorization.js'

const baseEnv = { DATABASE_URL: 'postgres://worker', WORKER_WORKSPACES: 'ws_a, ws_b,ws_a' }
const testExecutionAuthorization = {
  assertAuthorized: async (event, operation) => ({ recheckId: `recheck_${event.id}`, actorId: 'test_actor', identityId: 'test_identity', workspaceId: event.workspaceId, workbench: 'workspace' as const, contextId: `workspace:${event.workspaceId}`, contextVersion: 'test_context', policyVersion: 'test_policy', grantRevision: 'test_grant', grantIds: [], scopeHash: 'a'.repeat(64), capability: operation, resourceId: event.aggregateId, resourceRevision: 'test_resource_revision', requestId: `request_${event.id}`, traceId: `trace_${event.id}`, authorized: true, checkedAt: new Date().toISOString() }),
} satisfies WorkerExecutionAuthorizationGuard
const createAuthorizedOutboxHandler = (options: WorkerHandlerOptions) => {
  const handler = createOutboxHandler({ ...options, executionAuthorization: testExecutionAuthorization })
  return async (input: Parameters<typeof handler>[0]) => {
    const operation = input.event.eventType === 'publish.requested' ? 'publish.execute'
      : input.event.eventType === 'publish.reconcile_requested' ? 'publish.reconcile'
        : input.event.eventType === 'generation.requested' ? 'generation.execute'
          : input.event.eventType === 'image.generation.requested' ? 'image_generation.execute'
            : input.event.eventType === 'sync.requested' ? 'catalog.sync.execute'
              : input.event.eventType === 'asset.scan_redrive_requested' ? 'asset.scan.execute'
                : 'asset.continuation.execute'
    const payload = input.event.payload.authorization_snapshot ? input.event.payload : {
      ...input.event.payload,
      authorization_snapshot: {
        schema_version: 1,
        decision_id: `test_decision_${input.event.id}`,
        actor_id: 'test_actor',
        identity_id: 'test_identity',
        workspace_id: input.event.workspaceId,
        workbench: 'workspace',
        context_id: `workspace:${input.event.workspaceId}`,
        context_version: 'test_context',
        policy_version: 'test_policy',
        grant_revision: 'test_grant',
        grant_ids: [],
        scope_hash: 'a'.repeat(64),
        capability: operation,
        resource_id: input.event.aggregateId,
        resource_revision: 'test_resource_revision',
        request_id: `request_${input.event.id}`,
        trace_id: `trace_${input.event.id}`,
        authorized: true,
        decided_at: new Date().toISOString(),
      },
    }
    return handler({ ...input, event: { ...input.event, payload } })
  }
}

describe('worker production entry', () => {
  it('bounds workspace maintenance concurrency and preserves settled results', async () => {
    let active = 0
    let peak = 0
    const results = await allSettledWithConcurrency([0, 1, 2, 3, 4, 5], 2, async value => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      if (value === 3) throw new Error('workspace failed')
      return value * 2
    })

    expect(peak).toBe(2)
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
    expect(results[5]).toEqual({ status: 'fulfilled', value: 10 })
  })

  it('uses the persisted event authority endpoint for non-publish critical operations', async () => {
    const checkedAt = new Date().toISOString()
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('/v1/worker-events/evt_generation_auth/execution-check?aggregate_id=gen_auth&operation=generation.execute')
      return new Response(JSON.stringify({ data: { authorization_recheck: { recheck_id: 'recheck_generation_auth', actor_id: 'test_actor', identity_id: 'identity_1', workspace_id: 'ws_a', workbench: 'workspace', context_id: 'workspace:ws_a', context_version: 'ctx_2', policy_version: 'policy_2', grant_revision: 'membership:identity_1:0', grant_ids: [], scope_hash: 'a'.repeat(64), capability: 'generation.execute', resource_id: 'gen_auth', resource_revision: 'resource_1', request_id: 'request_1', trace_id: 'trace_1', authorized: true, checked_at: checkedAt } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const event = { id: 'evt_generation_auth', workspaceId: 'ws_a', aggregateId: 'gen_auth', eventType: 'generation.requested', sequence: 1, createdAt: checkedAt, payload: { authorization_snapshot: { schema_version: 1, decision_id: 'decision_generation_auth', actor_id: 'test_actor', identity_id: 'identity_1', workspace_id: 'ws_a', workbench: 'workspace', context_id: 'workspace:ws_a', context_version: 'ctx_1', policy_version: 'policy_1', grant_revision: 'membership:identity_1:0', grant_ids: [], scope_hash: 'a'.repeat(64), capability: 'generation.execute', resource_id: 'gen_auth', resource_revision: 'resource_1', request_id: 'request_1', trace_id: 'trace_1', authorized: true, decided_at: checkedAt } } }
    await expect(createApiExecutionAuthorizationGuard({ apiBaseUrl: 'https://api.example.test', apiToken: 'worker-token' }, fetcher).assertAuthorized(event, 'generation.execute')).resolves.toMatchObject({ recheckId: 'recheck_generation_auth', scopeHash: 'a'.repeat(64) })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('rechecks a persisted redrive snapshot through the asset scan capability', async () => {
    const checkedAt = new Date().toISOString()
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain('/v1/worker-events/evt_scan_redrive_auth/execution-check?aggregate_id=asset_auth&operation=asset.scan.execute')
      expect(new Headers(init?.headers).get('x-worker-role')).toBe('scan')
      return new Response(JSON.stringify({ data: { authorization_recheck: { recheck_id: 'recheck_scan_auth', actor_id: 'operator_1', identity_id: 'identity_1', workspace_id: 'ws_a', workbench: 'workspace', context_id: 'workspace:ws_a', context_version: 'ctx_2', policy_version: 'policy_2', grant_revision: 'grant_1', grant_ids: [], scope_hash: 'b'.repeat(64), capability: 'asset.scan.execute', resource_id: 'asset_auth', resource_revision: 'resource_1', request_id: 'request_1', trace_id: 'trace_1', authorized: true, checked_at: checkedAt } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const event: DurableOutboxEvent = { id: 'evt_scan_redrive_auth', workspaceId: 'ws_a', aggregateId: 'asset_auth', eventType: 'asset.scan_redrive_requested', sequence: 2, createdAt: checkedAt, payload: { authorization_snapshot: { schema_version: 1, decision_id: 'decision_scan_auth', actor_id: 'operator_1', identity_id: 'identity_1', workspace_id: 'ws_a', workbench: 'workspace', context_id: 'workspace:ws_a', context_version: 'ctx_1', policy_version: 'policy_1', grant_revision: 'grant_1', grant_ids: [], scope_hash: 'b'.repeat(64), capability: 'asset.scan.execute', resource_id: 'asset_auth', resource_revision: 'resource_1', request_id: 'request_1', trace_id: 'trace_1', authorized: true, decided_at: checkedAt } } }
    await expect(createApiExecutionAuthorizationGuard({ apiBaseUrl: 'https://api.example.test', apiToken: 'worker-token', apiSigningSecret: 'scanner-signing-secret' }, fetcher).assertAuthorized(event, 'asset.scan.execute')).resolves.toMatchObject({ recheckId: 'recheck_scan_auth', capability: 'asset.scan.execute' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('keeps an authoritative execution denial non-retryable', async () => {
    const checkedAt = new Date().toISOString()
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'AUTHZ_EXECUTION_REVOKED', message: 'membership revoked' } }), { status: 403, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const event: DurableOutboxEvent = { id: 'evt_scan_auth_revoked', workspaceId: 'ws_a', aggregateId: 'asset_auth', eventType: 'asset.scan_redrive_requested', sequence: 2, createdAt: checkedAt, payload: { authorization_snapshot: { schema_version: 1, decision_id: 'decision_scan_auth', actor_id: 'operator_1', identity_id: 'identity_1', workspace_id: 'ws_a', workbench: 'workspace', context_id: 'workspace:ws_a', context_version: 'ctx_1', policy_version: 'policy_1', grant_revision: 'grant_1', grant_ids: [], scope_hash: 'b'.repeat(64), capability: 'asset.scan.execute', resource_id: 'asset_auth', resource_revision: 'resource_1', request_id: 'request_1', trace_id: 'trace_1', authorized: true, decided_at: checkedAt } } }
    await expect(createApiExecutionAuthorizationGuard({ apiBaseUrl: 'https://api.example.test', apiToken: 'worker-token' }, fetcher).assertAuthorized(event, 'asset.scan.execute'))
      .rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_REVOKED', retryable: false })
  })

  it('keeps provider-accepted image failures reconcilable', () => {
    expect(isImageProviderOutcomeUnknown(Object.assign(new Error('settlement pending'), { code: 'MODEL_USAGE_SETTLEMENT_PENDING', providerSucceeded: true }))).toBe(true)
    expect(isImageProviderOutcomeUnknown({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', details: { reconciliation_required: true } })).toBe(true)
    expect(isImageProviderOutcomeUnknown({ code: 'MODEL_PROVIDER_REQUEST_FAILED', providerOutcome: 'failed', providerSucceeded: false })).toBe(false)
  })
  it('requires the persisted image provider action instead of fabricating one in the worker', () => {
    expect(requireImageGenerationActionId({ action_id: ' image:request_1 ' })).toBe('image:request_1')
    expect(() => requireImageGenerationActionId({})).toThrow(expect.objectContaining({ code: 'IMAGE_GENERATION_ACTION_ID_REQUIRED', retryable: false, unknown: false }))
  })
  it('requires the persisted budget run instead of deriving it from an action in the worker', () => {
    expect(requireModelRunKey({ run_key: ' task:content_1 ' })).toBe('task:content_1')
    expect(() => requireModelRunKey({ action_id: 'model:generation:idem_1' })).toThrow(expect.objectContaining({ code: 'MODEL_RUN_KEY_REQUIRED', retryable: false, unknown: false }))
  })
  it('isolates Redis outbox queues by worker role and workspace', () => {
    expect(workerQueueKey('sync', 'ws_a')).toBe('merchant:outbox:sync:ws_a')
    expect(workerQueueKey('generation', 'ws_a')).toBe('merchant:outbox:generation:ws_a')
    expect(workerQueueKey('sync', 'ws_b')).toBe('merchant:outbox:sync:ws_b')
  })

  it('scopes every external-side-effect quota admission to the event workspace', () => {
    const event = { workspaceId: 'ws_tenant_a' }
    expect(quotaAdmissionForEvent(event, 'model', 'relay-model', 60)).toEqual({
      tenantId: 'ws_tenant_a', namespace: 'model', key: 'relay-model', limitPerWindow: 60,
    })
    expect(quotaAdmissionForEvent(event, 'platform', 'taobao:account_1', 120)).toEqual({
      tenantId: 'ws_tenant_a', namespace: 'platform', key: 'taobao:account_1', limitPerWindow: 120,
    })
  })

  it('posts the SLA scan through the reconcile API boundary', async () => {
    let requestHeaders: Headers | undefined
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      requestHeaders = new Headers(init?.headers)
      expect(requestHeaders.get('x-workspace-id')).toBe('ws_a')
      expect(JSON.parse(String(init?.body))).toEqual({ workspace_id: 'ws_a', limit: 25 })
      return new Response(JSON.stringify({ data: { workspaceId: 'ws_a', checked: 25 } }), { status: 200 })
    }) as unknown as typeof fetch
    await expect(postSupportSlaScan({ apiBaseUrl: 'http://api:8787', apiToken: 'worker-token', signingSecret: 'reconcile-signing-secret', workspaceId: 'ws_a', limit: 25, fetcher })).resolves.toMatchObject({ data: { checked: 25 } })
    expect(requestHeaders?.get('x-worker-role')).toBe('reconcile')
  })

  it('signs the image reconciliation listing as the reconcile worker', async () => {
    let requestHeaders: Headers | undefined
    await postImageGenerationReconciliation({
      apiBaseUrl: 'http://api:8787', apiToken: 'worker-token', signingSecret: 'reconcile-signing-secret', workspaceId: 'ws_a',
      fetcher: async (_url, init) => {
        requestHeaders = new Headers(init?.headers)
        return new Response(JSON.stringify({ data: { attention: [], next_cursor: null } }), { status: 200 })
      },
    })
    expect(requestHeaders?.get('x-worker-role')).toBe('reconcile')
  })

  it('requires explicit tenant scope and deduplicates configured workspaces', () => {
    expect(readWorkerConfig(baseEnv)).toMatchObject({ workspaces: ['ws_a', 'ws_b'], batchSize: 100, workspaceBatchSize: 10, leaseMs: 180_000, storageReconciliationIntervalMs: 900_000, modelUsageReconciliationIntervalMs: 300_000, dependencyCheckIntervalMs: 10_000 })
    expect(() => readWorkerConfig({ DATABASE_URL: baseEnv.DATABASE_URL })).toThrow('WORKER_WORKSPACES')
    expect(readWorkerConfig({ DATABASE_URL: baseEnv.DATABASE_URL, WORKER_WORKSPACES: 'auto' })).toMatchObject({ workspaces: [], autoDiscoverWorkspaces: true })
  })

  it('fails worker readiness closed unless the complete shipped schema and API dependencies are ready', async () => {
    const expectedMigrations = [{ version: 1, name: 'initial' }, { version: 2, name: 'force_rls' }]
    const database = { query: vi.fn(async () => ({ rows: expectedMigrations })) }
    const requests: string[] = []
    const readyFetcher: typeof fetch = async input => {
      requests.push(String(input))
      return new Response(JSON.stringify({ data: { persistence: { ready: true }, redis: { ready: true } }, error: null }), { status: 200 })
    }

    await expect(assertWorkerReadinessDependencies({ database, apiBaseUrl: 'http://api:8787/', fetcher: readyFetcher, expectedMigrations }))
      .resolves.toEqual({ migrationVersion: 2, apiReady: true })
    expect(requests).toEqual(['http://api:8787/readyz'])
    await expect(assertWorkerReadinessDependencies({ database, apiBaseUrl: 'http://api:8787/', apiHealthPath: '/healthz', fetcher: readyFetcher, expectedMigrations }))
      .resolves.toEqual({ migrationVersion: 2, apiReady: true })
    expect(requests.at(-1)).toBe('http://api:8787/healthz')

    await expect(assertWorkerReadinessDependencies({ database: { query: async () => ({ rows: [expectedMigrations[1]!] }) }, expectedMigrations }))
      .rejects.toThrow('expected complete migration chain through 2')
    await expect(assertWorkerReadinessDependencies({ database, apiBaseUrl: 'http://api:8787', fetcher: async () => new Response(JSON.stringify({ data: { persistence: { ready: false }, redis: { ready: true } } }), { status: 200 }), expectedMigrations }))
      .rejects.toThrow('invalid or incomplete readiness envelope')
    await expect(assertWorkerReadinessDependencies({ database, apiBaseUrl: 'http://api:8787', fetcher: async () => new Response('{}', { status: 503 }), expectedMigrations }))
      .rejects.toThrow('returned 503')
  })

  it('requires complete scan callback credentials before advertising scanner readiness', async () => {
    const complete = { API_BASE_URL: 'http://api', ASSET_SCANNER_API_TOKEN: 'scanner-token', ASSET_SCANNER_WORKSPACE_SIGNING_SECRET: 'workspace-secret', ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM_B64: Buffer.from('private-key').toString('base64'), ASSET_SCAN_RECEIPT_KEY_ID: 'key-1' }
    expect(hasCompleteScanCallbackCredentials({ apiBaseUrl: complete.API_BASE_URL }, complete)).toBe(true)
    expect(hasCompleteScanCallbackCredentials({ apiBaseUrl: complete.API_BASE_URL }, { ...complete, ASSET_SCAN_RECEIPT_KEY_ID: '' })).toBe(false)
    expect(hasCompleteScanCallbackCredentials({ apiBaseUrl: complete.API_BASE_URL }, { ...complete, ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM_B64: '' })).toBe(false)
  })

  it('rejects a production lease shorter than the bounded external operation window', () => {
    expect(() => readWorkerConfig({ ...baseEnv, NODE_ENV: 'production', WORKER_ROLE: 'generation', WORKER_API_BASE_URL: 'http://api', WORKER_API_TOKEN: 'token', WORKER_API_SIGNING_SECRET: 'signing-secret', AI_TIMEOUT_MS: '90000', WORKER_API_TIMEOUT_MS: '10000', WORKER_LEASE_MS: '109999' }))
      .toThrow('WORKER_LEASE_MS must be at least 170000ms')
  })

  it('restores snapshots and task.created, then safely acknowledges them', async () => {
    const projection = createWorkerProjection()
    const handler = createOutboxHandler({ projection })
    const snapshot = { id: 'evt_s', workspaceId: 'ws_a', aggregateId: 'task_1', eventType: 'state.snapshot', sequence: 1, payload: { entityType: 'task', entity: { id: 'task_1' } }, createdAt: new Date().toISOString() }
    const task = { ...snapshot, id: 'evt_t', eventType: 'task.created', payload: { id: 'task_1', workspaceId: 'ws_a' } }
    await handler({ event: snapshot, attempt: 1, now: Date.now() })
    await handler({ event: task, attempt: 1, now: Date.now() })
    expect(projection.snapshots.get('task_1')?.sequence).toBe(1)
    expect(projection.tasks.get('task_1')).toEqual(task.payload)
  })

  it('executes each ready image continuation once through the signed worker boundary', async () => {
    const requests: Array<{ url: string; signature: string | null }> = []
    const event = { id: 'evt_continuation', workspaceId: 'ws_a', aggregateId: 'asset_1', eventType: 'asset.generation_continuations.ready', sequence: 2, payload: { continuation_job_ids: ['img_1', 'img_1', 'img_2'] }, createdAt: new Date().toISOString() }
    const result = await executeImageGenerationContinuations({
      apiBaseUrl: 'http://api:8787/', apiToken: 'worker-token', signingSecret: 'worker-secret', event,
      fetcher: async (input, init) => {
        requests.push({ url: String(input), signature: new Headers(init?.headers).get('x-worker-workspace-signature') })
        return new Response(JSON.stringify({ data: { state: 'succeeded' }, error: null }), { status: 200 })
      },
    })
    expect(result.executed).toBe(2)
    expect(requests.map(item => item.url)).toEqual([
      'http://api:8787/v1/internal/image-generation-continuations/img_1/execute',
      'http://api:8787/v1/internal/image-generation-continuations/img_2/execute',
    ])
    expect(requests.every(item => /^[a-f0-9]{64}$/u.test(item.signature ?? ''))).toBe(true)
  })

  it('preserves the API continuation error code and retry decision instead of retrying every 409', async () => {
    const event = { id: 'evt_continuation_reconcile', workspaceId: 'ws_a', aggregateId: 'asset_1', eventType: 'asset.generation_continuations.ready', sequence: 3, payload: { continuation_job_ids: ['img_1'] }, createdAt: new Date().toISOString() }
    await expect(executeImageGenerationContinuations({
      apiBaseUrl: 'http://api:8787', apiToken: 'worker-token', signingSecret: 'worker-secret', event,
      fetcher: async () => new Response(JSON.stringify({ error: { code: 'IMAGE_ARTIFACT_RECONCILIATION_REQUIRED', message: 'archive outcome requires reconciliation', details: { retryable: false } } }), { status: 409 }),
    })).rejects.toMatchObject({ code: 'IMAGE_ARTIFACT_RECONCILIATION_REQUIRED', retryable: false, message: 'archive outcome requires reconciliation' })
  })

  it('routes ready image continuation events without treating them as content generation', async () => {
    const handled: string[] = []
    const handler = createAuthorizedOutboxHandler({ imageContinuationRequested: async event => { handled.push(event.id); return { resumed: true } } })
    const result = await handler({ event: { id: 'evt_ready', workspaceId: 'ws_a', aggregateId: 'asset_1', eventType: 'asset.generation_continuations.ready', sequence: 2, payload: { continuation_job_ids: ['img_1'] }, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() })
    expect(result).toMatchObject({ value: { resumed: true } })
    expect(handled).toEqual(['evt_ready'])
  })

  it('routes ordinary image generation events through the injected executor', async () => {
    const handled: string[] = []
    const handler = createAuthorizedOutboxHandler({
      imageGenerationRequested: async event => {
        handled.push(event.id)
        return { provider_request_id: 'provider_1', images: ['data:image/png;base64,aA=='] }
      },
    })
    const result = await handler({ event: { id: 'evt_image_generation', workspaceId: 'ws_a', aggregateId: 'img_1', eventType: 'image.generation.requested', sequence: 1, payload: { job_id: 'img_1', intent_hash: 'a'.repeat(64) }, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() })
    expect(handled).toEqual(['evt_image_generation'])
    expect(result).toEqual({ value: { provider_request_id: 'provider_1', images: ['data:image/png;base64,aA=='] } })
  })

  it('rejects malformed image callbacks before network I/O', async () => {
    const fetcher = vi.fn()
    const event: DurableOutboxEvent = { id: 'evt_callback_schema', workspaceId: 'ws_a', aggregateId: 'img_1', eventType: 'image.generation.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString() }
    await expect(postImageGenerationResult({ apiBaseUrl: 'https://api.example', apiToken: 'token', event, fetcher, result: { intent_hash: 'a'.repeat(64), error: {} as { code: string; message: string } } })).rejects.toThrow('error')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('moves publish.requested to unknown when no connector handler exists', async () => {
    const handler = createOutboxHandler()
    await expect(handler({ event: { id: 'evt_p', workspaceId: 'ws_a', aggregateId: 'job_1', eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() }))
      .rejects.toMatchObject({ error: { code: 'CONNECTOR_HANDLER_UNAVAILABLE', unknown: true, retryable: false } })
  })

  it('dispatches tenant-scoped SLA scan events to the injected API boundary', async () => {
    const scan = vi.fn(async (event: DurableOutboxEvent) => ({ workspaceId: event.workspaceId, planned: 2 }))
    const handler = createOutboxHandler({ slaScanRequested: scan })
    const event: DurableOutboxEvent = { id: 'evt_sla_scan', workspaceId: 'ws_a', aggregateId: 'workspace', eventType: 'support.sla.scan_requested', sequence: 1, payload: {}, createdAt: new Date().toISOString() }
    await expect(handler({ event, attempt: 1, now: Date.now() })).resolves.toEqual({ value: { workspaceId: 'ws_a', planned: 2 } })
    expect(scan).toHaveBeenCalledWith(event, expect.anything(), undefined)
  })

  it('preserves structured SLA callback retry semantics', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ error: { code: 'SUPPORT_SLA_SCOPE_REVOKED', message: 'scope revoked', details: { retryable: false } } }), { status: 403, headers: { 'content-type': 'application/json' } })
    await expect(postSupportSlaScan({ apiBaseUrl: 'https://api.example', apiToken: 'token', workspaceId: 'ws_a', fetcher }))
      .rejects.toMatchObject({ code: 'SUPPORT_SLA_SCOPE_REVOKED', message: 'scope revoked', retryable: false, unknown: false })
  })

  it('fails closed before a critical side effect when no authorization authority is wired', async () => {
    const connector = vi.fn()
    const handler = createOutboxHandler({ publishRequested: connector })
    await expect(handler({ event: { id: 'evt_authz_blocked', workspaceId: 'ws_a', aggregateId: 'job_authz_blocked', eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() }))
      .rejects.toMatchObject({ error: { code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID', retryable: false, unknown: false, eventId: 'evt_authz_blocked', workspaceId: 'ws_a' } })
    expect(connector).not.toHaveBeenCalled()
  })

  it('live-rechecks only redriven scans before invoking the scanner executor', async () => {
    const order: string[] = []
    const executionAuthorization = {
      assertAuthorized: vi.fn(async (event: DurableOutboxEvent, operation: 'asset.scan.execute') => {
        order.push(`authorize:${event.id}:${operation}`)
        return { recheckId: 'recheck_scan', actorId: 'operator_1', workspaceId: event.workspaceId, contextId: `workspace:${event.workspaceId}`, contextVersion: 'ctx_2', policyVersion: 'policy_2', grantRevision: 'grant_2', scopeHash: 'a'.repeat(64), capability: operation, resourceId: event.aggregateId, authorized: true as const, checkedAt: new Date().toISOString() }
      }),
    } as unknown as WorkerExecutionAuthorizationGuard
    const scanRequested = vi.fn(async (event: DurableOutboxEvent) => { order.push(`scan:${event.id}`); return { verdict: 'clean' } })
    const handler = createOutboxHandler({ executionAuthorization, scanRequested })
    const base = { workspaceId: 'ws_a', aggregateId: 'asset_1', sequence: 2, createdAt: new Date().toISOString(), payload: { asset_id: 'asset_1', storage_key: 'quarantine/ws_a/asset_1/source.png', sha256: 'a'.repeat(64), size_bytes: 1, source_revision: 2 } }

    await handler({ event: { ...base, id: 'evt_scan_initial', eventType: 'asset.uploaded' }, attempt: 1, now: Date.now() })
    expect(executionAuthorization.assertAuthorized).not.toHaveBeenCalled()
    await handler({ event: { ...base, id: 'evt_scan_redrive', eventType: 'asset.scan_redrive_requested' }, attempt: 1, now: Date.now() })
    expect(order).toEqual(['scan:evt_scan_initial', 'authorize:evt_scan_redrive:asset.scan.execute', 'scan:evt_scan_redrive'])
  })

  it('rejects a redriven scan without a durable authorization snapshot before scanning', async () => {
    const scanRequested = vi.fn()
    const handler = createOutboxHandler({ scanRequested })
    await expect(handler({ event: { id: 'evt_scan_redrive_legacy', workspaceId: 'ws_a', aggregateId: 'asset_1', eventType: 'asset.scan_redrive_requested', sequence: 2, createdAt: new Date().toISOString(), payload: { asset_id: 'asset_1', storage_key: 'quarantine/ws_a/asset_1/source.png', sha256: 'a'.repeat(64), size_bytes: 1, source_revision: 2 } }, attempt: 1, now: Date.now() }))
      .rejects.toMatchObject({ error: { code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID', retryable: false, unknown: false } })
    expect(scanRequested).not.toHaveBeenCalled()
  })

  it('dead-letters a legacy critical event without an authorization snapshot and never calls the connector', async () => {
    const connector = vi.fn()
    const event: DurableOutboxEvent = { id: 'evt_legacy_authz', workspaceId: 'ws_a', aggregateId: 'job_legacy_authz', eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString(), leaseToken: 'lease_authz' }
    const queue = new InMemoryQueue<DurableOutboxEvent>()
    await queue.enqueue({ id: event.id, value: event })
    const deadLetter = vi.fn(async (_workspaceId: string, _id: string, failure: { code: string }) => ({ ...event, lastError: failure }))
    const store = {
      claimPending: async () => [], validateLease: async () => event, renewLease: async () => event,
      ack: async () => event, recordFailure: async () => event, markUnknown: async () => event, deadLetter,
    }
    const dispatcher = new DurableOutboxDispatcher(store, queue, createOutboxHandler({ publishRequested: connector }))
    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({ state: 'dead_letter' })
    expect(deadLetter).toHaveBeenCalledWith('ws_a', event.id, expect.objectContaining({ code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID', retryable: false, unknown: false }), 'lease_authz')
    expect(connector).not.toHaveBeenCalled()
  })

  it('executes an injected publish connector and reports its verified remote status', async () => {
    const observed: string[] = []
    const handler = createAuthorizedOutboxHandler({
      publishRequested: async () => ({ receipt: { platform: 'jd', operation: 'update', remoteId: 'JD-1', requestId: 'req-1', status: 'submitted', simulated: false, idempotencyKey: 'idem-1' }, remoteStatus: { found: true, state: 'submitted', remoteId: 'JD-1', requestId: 'req-1', simulated: false } }),
      onPublishObservation: async event => { observed.push(event.aggregateId) },
    })
    const result = await handler({ event: { id: 'evt_verified', workspaceId: 'ws_a', aggregateId: 'job_1', eventType: 'publish.requested', sequence: 1, payload: { platform: 'jd', account_id: 'acct_1', fields: {} }, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() })
    expect(result).toMatchObject({ value: { remoteStatus: { state: 'submitted' } } })
    expect(observed).toEqual(['job_1'])
  })

  it('reports connector failure as an unknown business observation before durable unknown', async () => {
    const observations: Array<{ state: string; found: boolean }> = []
    const handler = createAuthorizedOutboxHandler({
      publishRequested: async () => { throw new Error('vault unavailable') },
      onPublishObservation: async (_event, observation) => { observations.push({ state: observation.remoteStatus.state, found: observation.remoteStatus.found }) },
    })
    await expect(handler({ event: { id: 'evt_failure', workspaceId: 'ws_a', aggregateId: 'job_2', eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() })).rejects.toMatchObject({ error: { unknown: true } })
    expect(observations).toEqual([{ state: 'unknown', found: false }])
  })

  it('does not manufacture remote unknown for a known pre-execution connector rejection', async () => {
    const observations: unknown[] = []
    const handler = createAuthorizedOutboxHandler({
      publishRequested: async () => { throw { normalized: { code: 'UNAUTHORIZED', message: 'reauthorization required', retryable: false, unknown: false } } },
      onPublishObservation: async (_event, observation) => { observations.push(observation) },
    })
    await expect(handler({ event: { id: 'evt_auth', workspaceId: 'ws_a', aggregateId: 'job_auth', eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() }))
      .rejects.toMatchObject({ error: { code: 'UNAUTHORIZED', retryable: false, unknown: false } })
    expect(observations).toEqual([])
  })

  it('runs a separate reconcile event and preserves submitted/published evidence', async () => {
    const handler = createAuthorizedOutboxHandler({
      reconcileRequested: async () => ({ remoteStatus: { found: true, state: 'published', remoteId: 'JD-1', requestId: 'status-1', simulated: false } }),
    })
    const result = await handler({ event: { id: 'evt_reconcile', workspaceId: 'ws_a', aggregateId: 'job_3', eventType: 'publish.reconcile_requested', sequence: 1, payload: { platform: 'jd', account_id: 'acct_1', idempotencyKey: 'idem-3', payload_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() })
    expect(result).toMatchObject({ value: { remoteStatus: { state: 'published', requestId: 'status-1' } } })
  })

  it('executes generation events through an injected model worker and reports the result', async () => {
    const reported: Array<{ content?: unknown }> = []
    const handler = createAuthorizedOutboxHandler({
      generationRequested: async () => ({ title: '模型标题', detail: '模型详情', sellingPoints: ['事实卖点'] }),
      onGenerationResult: async (_event, result) => { reported.push(result) },
    })
    const result = await handler({ event: { id: 'evt_generation', workspaceId: 'ws_a', aggregateId: 'gen_1', eventType: 'generation.requested', sequence: 1, payload: { input: {} }, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() })
    expect(result).toMatchObject({ value: { title: '模型标题' } })
    expect(reported).toEqual([{ content: { title: '模型标题', detail: '模型详情', sellingPoints: ['事实卖点'] } }])
  })

  it('forwards the durable lease signal to generation, sync, publish and reconcile handlers', async () => {
    const controller = new AbortController()
    const seen: AbortSignal[] = []
    const cases = [
      { eventType: 'generation.requested', option: 'generationRequested', payload: { input: {} }, result: { title: '标题', detail: '详情', sellingPoints: ['卖点'] } },
      { eventType: 'sync.requested', option: 'syncRequested', payload: {}, result: { synced: true } },
      { eventType: 'publish.requested', option: 'publishRequested', payload: {}, result: { remoteStatus: { found: true, state: 'submitted', simulated: false } } },
      { eventType: 'publish.reconcile_requested', option: 'reconcileRequested', payload: {}, result: { remoteStatus: { found: true, state: 'published', remoteId: 'remote-1', simulated: false } } },
    ] as const
    for (const item of cases) {
      const callback = vi.fn(async (_event: DurableOutboxEvent, _projection: unknown, signal?: AbortSignal) => {
        seen.push(signal!)
        return item.result
      })
      const handler = createAuthorizedOutboxHandler({ [item.option]: callback })
      await handler({ event: { id: `evt_${item.option}`, workspaceId: 'ws_a', aggregateId: `job_${item.option}`, eventType: item.eventType, sequence: 1, payload: item.payload, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now(), signal: controller.signal })
      expect(callback).toHaveBeenCalledOnce()
    }
    expect(seen).toEqual([controller.signal, controller.signal, controller.signal, controller.signal])
  })

  it('fails closed without reporting generation success when the lease signal aborts', async () => {
    const controller = new AbortController()
    let started!: () => void
    const generationStarted = new Promise<void>(resolve => { started = resolve })
    const report = vi.fn()
    const handler = createAuthorizedOutboxHandler({
      generationRequested: async (_event, _projection, signal) => {
        started()
        await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }))
        return { title: '不应提交', detail: '不应提交', sellingPoints: ['不应提交'] }
      },
      onGenerationResult: report,
    })
    const pending = handler({ event: { id: 'evt_abort_generation', workspaceId: 'ws_a', aggregateId: 'gen_abort', eventType: 'generation.requested', sequence: 1, payload: { input: {} }, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now(), signal: controller.signal })
    await generationStarted
    controller.abort(new Error('lease lost'))

    await expect(pending).rejects.toMatchObject({ error: { code: 'OUTBOX_LEASE_LOST', unknown: true } })
    expect(report).not.toHaveBeenCalled()
  })

  it('keeps quota exhaustion queued instead of reporting a terminal generation failure', async () => {
    const reported: unknown[] = []
    const handler = createAuthorizedOutboxHandler({
      generationRequested: async () => { throw new QuotaExceededError({ allowed: false, retryAfterSeconds: 12, limitPerWindow: 60, used: 61 }) },
      onGenerationResult: async (_event, result) => { reported.push(result) },
    })
    await expect(handler({ event: { id: 'evt_quota', workspaceId: 'ws_a', aggregateId: 'gen_quota', eventType: 'generation.requested', sequence: 1, payload: { input: {} }, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() }))
      .rejects.toMatchObject({ error: { code: 'QUOTA_EXHAUSTED', retryable: true, unknown: false } })
    expect(reported).toEqual([])
  })

  it('dead-letters a generation event after reporting a terminal model failure', async () => {
    const reported: unknown[] = []
    const pending = Object.assign(new Error('model usage settlement is pending'), { code: 'MODEL_USAGE_SETTLEMENT_PENDING' })
    const handler = createAuthorizedOutboxHandler({
      generationRequested: async () => { throw pending },
      onGenerationResult: async (_event, result) => { reported.push(result) },
    })

    await expect(handler({ event: { id: 'evt_pending', workspaceId: 'ws_a', aggregateId: 'gen_pending', eventType: 'generation.requested', sequence: 1, payload: { input: {} }, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() }))
      .rejects.toMatchObject({ error: { code: 'MODEL_USAGE_SETTLEMENT_PENDING', retryable: false, unknown: false } })
    expect(reported).toEqual([{ error: { code: 'MODEL_USAGE_SETTLEMENT_PENDING', message: 'model usage settlement is pending' } }])
  })

  it('blocks a stale generation event before another provider call', async () => {
    const event = { id: 'evt_stale', workspaceId: 'ws_a', aggregateId: 'gen_stale', eventType: 'generation.requested', sequence: 1, payload: { task_id: 'task_stale', input: {} }, createdAt: new Date().toISOString() }
    await expect(assertGenerationExecution({
      apiBaseUrl: 'http://api', apiToken: 'token', event,
      signingSecret: 'signing-secret',
      fetcher: async (_url, init) => {
        expect(init?.headers).toMatchObject({ 'x-worker-workspace-signature': expect.stringMatching(/^[a-f0-9]{64}$/u) })
        return new Response(JSON.stringify({ data: { state: 'failed', taskId: 'task_stale' } }), { status: 200 })
      },
    })).rejects.toMatchObject({ code: 'GENERATION_JOB_TERMINAL' })

    await expect(assertGenerationExecution({
      apiBaseUrl: 'http://api', apiToken: 'token', event,
      fetcher: async () => new Response(JSON.stringify({ data: { state: 'queued', taskId: 'another_task' } }), { status: 200 }),
    })).rejects.toMatchObject({ code: 'GENERATION_EXECUTION_GATE_INVALID' })

    const reported: unknown[] = []
    const handler = createAuthorizedOutboxHandler({
      generationRequested: async () => { throw Object.assign(new Error('generation job is already failed'), { code: 'GENERATION_JOB_TERMINAL' }) },
      onGenerationResult: async (_event, result) => { reported.push(result) },
    })
    await expect(handler({ event, attempt: 2, now: Date.now() })).rejects.toMatchObject({ error: { code: 'GENERATION_JOB_TERMINAL', retryable: false } })
    expect(reported).toEqual([])
  })

  it('accepts Redis auto-discovery configuration without changing the safe default', () => {
    expect(readWorkerConfig({ DATABASE_URL: baseEnv.DATABASE_URL, WORKER_WORKSPACES: 'auto', REDIS_URL: 'redis://redis' }).autoDiscoverWorkspaces).toBe(true)
  })

  it('bounds worker-to-api callback waits with an abort signal', async () => {
    vi.stubEnv('WORKER_API_TIMEOUT_MS', '10')
    try {
      const hangingFetcher: typeof fetch = async (_url, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by worker API timeout')), { once: true })
      })
      await expect(postAutomationTick({ apiBaseUrl: 'http://api', apiToken: 'token', workspaceId: 'ws_a', fetcher: hangingFetcher })).rejects.toThrow('aborted by worker API timeout')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('cancels worker API fetch immediately when the durable lease signal aborts', async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    const event = { id: 'evt_abort_api', workspaceId: 'ws_a', aggregateId: 'gen_abort_api', eventType: 'generation.requested', sequence: 1, payload: { task_id: 'task_abort' }, createdAt: new Date().toISOString() }
    const pending = assertGenerationExecution({
      apiBaseUrl: 'http://api', apiToken: 'token', event, signal: controller.signal,
      fetcher: async (_url, init) => {
        requestSignal = init?.signal ?? undefined
        return await new Promise<Response>((_resolve, reject) => requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true }))
      },
    })
    controller.abort(new Error('lease lost'))

    await expect(pending).rejects.toThrow('lease lost')
    expect(requestSignal?.aborted).toBe(true)
  })

  it('derives a stable platform idempotency key across retries and preserves an explicit key', () => {
    const base = { id: 'evt_idem', workspaceId: 'ws_a', aggregateId: 'publish_job_1', eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString() }
    expect(publishIdempotencyKey(base)).toBe('publish_job_1')
    expect(publishIdempotencyKey({ ...base, id: 'evt_retry' })).toBe('publish_job_1')
    expect(publishIdempotencyKey({ ...base, payload: { idempotencyKey: 'merchant-action-42' } })).toBe('merchant-action-42')
  })

  it('allows an explicit per-workspace batch cap for noisy-tenant isolation', () => {
    expect(readWorkerConfig({ ...baseEnv, WORKER_WORKSPACE_BATCH_SIZE: '4' }).workspaceBatchSize).toBe(4)
  })

  it('keeps reconciliation on a 15-minute default and accepts an explicit deployment override', () => {
    expect(readWorkerConfig(baseEnv).storageReconciliationIntervalMs).toBe(15 * 60_000)
    expect(readWorkerConfig({ ...baseEnv, STORAGE_RECONCILIATION_INTERVAL_MS: '1800000' }).storageReconciliationIntervalMs).toBe(1_800_000)
  })

  it('enforces a global batch cap while sharing work fairly across tenants', async () => {
    const pending = new Map<string, DurableOutboxEvent[]>(['ws_a', 'ws_b'].map(workspaceId => [workspaceId, Array.from({ length: 20 }, (_, index) => ({
      id: `${workspaceId}_evt_${index}`, workspaceId, aggregateId: `${workspaceId}_task_${index}`, eventType: 'task.created', sequence: 1,
      payload: { id: `${workspaceId}_task_${index}`, workspaceId }, createdAt: new Date().toISOString(),
    }))]))
    const acknowledged: string[] = []
    const repository = {
      claimPending: async (workspaceId: string, options: { limit?: number; leaseMs?: number; now?: string } = {}) => (pending.get(workspaceId)?.slice(0, options.limit ?? 100) ?? []).map(event => Object.assign(event, { leaseToken: `lease_${event.id}`, leaseUntil: new Date(Date.parse(options.now ?? new Date().toISOString()) + (options.leaseMs ?? 30_000)).toISOString() })),
      validateLease: async (workspaceId: string, id: string, leaseToken: string) => {
        const event = pending.get(workspaceId)?.find(candidate => candidate.id === id && candidate.leaseToken === leaseToken)
        if (!event) throw Object.assign(new Error('outbox event not found'), { code: 'OUTBOX_EVENT_NOT_FOUND' })
        return event
      },
      renewLease: async (workspaceId: string, id: string, leaseToken: string, leaseMs: number, now: string) => {
        const event = pending.get(workspaceId)?.find(candidate => candidate.id === id && candidate.leaseToken === leaseToken)
        if (!event) throw Object.assign(new Error('outbox event not found'), { code: 'OUTBOX_EVENT_NOT_FOUND' })
        event.leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString()
        return event
      },
      ack: async (workspaceId: string, id: string) => {
        const events = pending.get(workspaceId) ?? []
        const event = events.shift()!
        acknowledged.push(id)
        return { ...event, publishedAt: new Date().toISOString() }
      },
      recordFailure: async () => { throw new Error('unexpected failure') },
      markUnknown: async () => { throw new Error('unexpected unknown') },
    } as unknown as PostgresOutboxRepository

    const result = await pollOnce(repository, new Map(), { workspaces: ['ws_a', 'ws_b'], batchSize: 7, workspaceBatchSize: 3, leaseMs: 30_000 }, () => new InMemoryQueue())
    expect(result.processed).toBe(7)
    expect(acknowledged).toHaveLength(7)
    const workspaceCounts = ['ws_a', 'ws_b'].map(workspaceId => acknowledged.filter(id => id.startsWith(`${workspaceId}_`)).length)
    expect(Math.max(...workspaceCounts) - Math.min(...workspaceCounts)).toBeLessThanOrEqual(1)
  })

  it('does not claim scan work when the live scanner admission gate is closed', async () => {
    const claimPending = vi.fn(async () => [])
    const repository = { claimPending } as unknown as PostgresOutboxRepository
    await expect(pollOnce(repository, new Map(), { workspaces: ['ws_a'], batchSize: 1, leaseMs: 30_000, role: 'scan', claimAdmission: () => false }, () => new InMemoryQueue())).resolves.toEqual({ restored: 0, processed: 0, succeeded: 0, unknown: 0, queued: 0, deadLetter: 0 })
    expect(claimPending).not.toHaveBeenCalled()
  })

  it('includes redrive requests in the scan worker claim filter', async () => {
    const claimPending = vi.fn(async () => [])
    const repository = { claimPending } as unknown as PostgresOutboxRepository
    await pollOnce(repository, new Map(), { workspaces: ['ws_a'], batchSize: 1, leaseMs: 30_000, role: 'scan' }, () => new InMemoryQueue())
    expect(claimPending).toHaveBeenCalledWith('ws_a', expect.objectContaining({ eventTypes: expect.arrayContaining(['asset.scan_redrive_requested']) }))
  })

  it('fails closed for production callback workers without the signed API contract', () => {
    expect(() => readWorkerConfig({ ...baseEnv, NODE_ENV: 'production', WORKER_ROLE: 'publish' })).toThrow('WORKER_API_SIGNING_SECRET')
    expect(readWorkerConfig({ ...baseEnv, NODE_ENV: 'production', WORKER_ROLE: 'publish', WORKER_API_BASE_URL: 'http://api:8787', WORKER_API_TOKEN: 'test-token', WORKER_API_SIGNING_SECRET: 'test-signing' })).toMatchObject({ apiBaseUrl: 'http://api:8787', apiToken: 'test-token', apiSigningSecret: 'test-signing' })
  })
  it('also requires the signed callback contract in staging and preview', () => {
    for (const environment of ['staging', 'preview']) {
      expect(() => readWorkerConfig({ ...baseEnv, NODE_ENV: environment, WORKER_ROLE: 'automation' })).toThrow('WORKER_API_SIGNING_SECRET')
      expect(readWorkerConfig({ ...baseEnv, NODE_ENV: environment, WORKER_ROLE: 'automation', WORKER_API_BASE_URL: 'https://api.test', WORKER_API_TOKEN: 'worker-token', WORKER_API_SIGNING_SECRET: 'worker-secret' })).toMatchObject({ apiBaseUrl: 'https://api.test', apiSigningSecret: 'worker-secret' })
    }
  })

  it('supports the signed automation scheduler role without widening publish routing', async () => {
    const requests: Array<{ url: string; headers: Headers }> = []
    const response = await postAutomationTick({ apiBaseUrl: 'https://api.test', apiToken: 'worker-token', workspaceId: 'ws_a', signingSecret: 'worker-secret', fetcher: async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      return new Response(JSON.stringify({ data: { result: { executed: [] } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    } })
    expect(response).toMatchObject({ data: { result: { executed: [] } } })
    expect(requests[0]).toMatchObject({ url: 'https://api.test/v1/internal/automation/tick' })
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer worker-token')
    expect(requests[0]?.headers.get('x-workspace-id')).toBe('ws_a')
    expect(requests[0]?.headers.get('x-worker-workspace-signature')).toMatch(/^[a-f0-9]{64}$/u)
    expect(readWorkerConfig({ ...baseEnv, WORKER_ROLE: 'automation', WORKER_API_BASE_URL: 'https://api.test', WORKER_API_TOKEN: 'worker-token', WORKER_API_SIGNING_SECRET: 'worker-secret' }).automationIntervalMs).toBe(30_000)
  })

  it('runs object orphan cleanup through the signed automation callback', async () => {
    const requests: Array<{ url: string; body: string; headers: Headers }> = []
    const response = await postObjectOrphanCleanup({ apiBaseUrl: 'https://api.test', apiToken: 'worker-token', workspaceId: 'ws_a', limit: 25, signingSecret: 'worker-secret', fetcher: async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body), headers: new Headers(init?.headers) })
      return new Response(JSON.stringify({ data: { cleaned: 2, retried: 0, manualAttention: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    } })
    expect(response).toMatchObject({ data: { cleaned: 2 } })
    expect(requests[0]?.url).toBe('https://api.test/v1/internal/storage/orphans/cleanup')
    expect(JSON.parse(requests[0]!.body)).toEqual({ workspace_id: 'ws_a', limit: 25 })
    expect(requests[0]?.headers.get('x-worker-workspace-signature')).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('isolates automation failures so one workspace cannot starve later tenants or orphan cleanup', async () => {
    const calls: string[] = []
    const errors: string[] = []
    const result = await runAutomationMaintenance({
      workspaces: ['ws_a', 'ws_b'],
      tick: async workspaceId => { calls.push(`tick:${workspaceId}`); if (workspaceId === 'ws_a') throw new Error('tick failed'); return { data: { result: { executed: [{}] } } } },
      cleanup: async workspaceId => { calls.push(`cleanup:${workspaceId}`); if (workspaceId === 'ws_a') throw new Error('cleanup failed'); return { data: { cleaned: 2 } } },
      onError: (workspaceId, operation) => errors.push(`${operation}:${workspaceId}`),
    })
    expect(calls).toEqual(['tick:ws_a', 'cleanup:ws_a', 'tick:ws_b', 'cleanup:ws_b'])
    expect(errors).toEqual(['automation_tick:ws_a', 'object_orphan_cleanup:ws_a'])
    expect(result).toEqual({ restored: 0, processed: 3, succeeded: 3, unknown: 2, queued: 0, deadLetter: 0 })
  })

  it('does not run object cleanup when Codex native Automations own scheduling', async () => {
    const calls: string[] = []
    await runAutomationMaintenance({
      workspaces: ['ws_native'],
      tick: async () => ({ data: { result: { executed: [], skipReason: 'codex_native_automations_only' } } }),
      cleanup: async workspaceId => { calls.push('cleanup:' + workspaceId); return { data: { cleaned: 1 } } },
    })
    expect(calls).toEqual([])
  })

  it('submits signed relay usage to the API before generated content is accepted', async () => {
    const requests: Array<{ url: string; body: string; headers: Headers }> = []
    await expect(postModelUsage({
      apiBaseUrl: 'https://api.test', apiToken: 'worker-token', signingSecret: 'worker-secret',
      usage: { workspaceId: 'ws_a', actionId: 'model:generation:idem_1', runKey: 'task:content_1', contextLinkId: 'context_link_1', contextHash: 'a'.repeat(64), modality: 'text', model: 'relay-text', providerRequestId: 'relay_req_1', inputTokens: 10, outputTokens: 5, totalTokens: 15, costCny: 0.02, observedAt: '2026-08-28T00:00:00.000Z' },
      fetcher: async (input, init) => { requests.push({ url: String(input), body: String(init?.body), headers: new Headers(init?.headers) }); return new Response(JSON.stringify({ data: { recorded: true } }), { status: 200 }) },
    })).resolves.toEqual({ recorded: true, costEvidence: true })
    expect(requests[0]?.url).toBe('https://api.test/v1/internal/model-usage')
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ workspaceId: 'ws_a', actionId: 'model:generation:idem_1', runKey: 'task:content_1', contextLinkId: 'context_link_1', contextHash: 'a'.repeat(64), providerRequestId: 'relay_req_1', totalTokens: 15, costCny: 0.02 })
    expect(requests[0]?.headers.get('x-workspace-id')).toBe('ws_a')
    expect(requests[0]?.headers.get('x-worker-workspace-signature')).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('returns settlement attestations from both provider usage sinks', async () => {
    const source = await readFile(new URL('./main.ts', import.meta.url), 'utf8')
    const usageSinkSection = source.slice(source.indexOf('const contentGenerator ='), source.indexOf('const requireImageProviderRequestId'))
    expect(usageSinkSection.match(/return postModelUsage\(/gu)).toHaveLength(2)
    expect(usageSinkSection).not.toContain('await postModelUsage(')
  })

  it('rejects a successful model usage callback without settlement evidence', async () => {
    await expect(postModelUsage({
      apiBaseUrl: 'https://api.test', apiToken: 'worker-token',
      usage: { workspaceId: 'ws_a', actionId: 'model:generation:idem_missing_receipt', runKey: 'task:content_missing_receipt', modality: 'text', model: 'relay-text', providerRequestId: 'relay_req_missing_receipt', inputTokens: 1, outputTokens: 1, totalTokens: 2, observedAt: '2026-08-28T00:00:00.000Z' },
      fetcher: async () => new Response('{}', { status: 200 }),
    })).rejects.toMatchObject({ code: 'MODEL_USAGE_CALLBACK_REJECTED' })
  })

  it('submits signed workspace-scoped model usage reconciliation requests', async () => {
    const requests: Array<{ url: string; body: string; headers: Headers }> = []
    await postModelUsageReconciliation({ apiBaseUrl: 'https://api.test', apiToken: 'worker-token', signingSecret: 'worker-secret', workspaceId: 'ws_a', limit: 25, fetcher: async (input, init) => { requests.push({ url: String(input), body: String(init?.body), headers: new Headers(init?.headers) }); return new Response(JSON.stringify({ data: { checked: 1, settled: ['usage_1'], pending: [] }, error: null }), { status: 200 }) } })
    expect(requests[0]?.url).toBe('https://api.test/v1/internal/model-usage/reconciliation')
    expect(JSON.parse(requests[0]!.body)).toEqual({ workspace_id: 'ws_a', limit: 25 })
    expect(requests[0]?.headers.get('x-workspace-id')).toBe('ws_a')
    expect(requests[0]?.headers.get('x-worker-workspace-signature')).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('queries status in the Worker and submits a workspace-scoped status/evidence envelope', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = []
    const result = await reconcileImageGenerationWorkspace({
      apiBaseUrl: 'https://api.test', apiToken: 'worker-token', signingSecret: 'worker-secret', workspaceId: 'ws_a', limit: 10,
      queryStatus: async providerRequestId => ({ state: 'processing', providerRequestId, evidence: { observedAt: '2026-08-31T00:00:00.000Z', source: 'provider_status', providerStatus: 'queued' } }),
      fetcher: async (input, init) => {
        const url = String(input)
        requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) })
        return url.endsWith('/reconciliation')
          ? new Response(JSON.stringify({ pending_executions: [{ job_id: 'job_1', event_id: 'event_1', intent_hash: 'a'.repeat(64), execution_attempt: 2, query_attempt: 3, execution_state: 'provider_started', provider_request_id: 'provider_1' }], next_cursor: null }), { status: 200 })
          : new Response(JSON.stringify({ data: { accepted: true }, error: null }), { status: 200 })
      },
    })
    expect(result).toMatchObject({ pages: 1, completed: true })
    const statusRequest = requests.find(request => request.url.endsWith('/reconciliation-evidence'))
    expect(statusRequest?.body).toMatchObject({ workspace_id: 'ws_a', job_id: 'job_1', event_id: 'event_1', intent_hash: 'a'.repeat(64), execution_attempt: 2, query_attempt: 3, provider_request_id: 'provider_1', provider_state: 'processing', provider_status: 'queued', observed_at: '2026-08-31T00:00:00.000Z', idempotency_key: imageReconciliationIdempotencyKey({ workspaceId: 'ws_a', jobId: 'job_1', eventId: 'event_1', intentHash: 'a'.repeat(64), executionAttempt: 2, queryAttempt: 3, providerRequestId: 'provider_1' }) })
    expect(statusRequest?.body.response_digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(statusRequest?.headers.get('x-workspace-id')).toBe('ws_a')
    expect(statusRequest?.headers.get('x-worker-workspace-signature')).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('does not query pre-provider states or malformed execution states', async () => {
    const queried: string[] = []
    const evidence: Record<string, unknown>[] = []
    const result = await reconcileImageGenerationWorkspace({
      apiBaseUrl: 'https://api.test', apiToken: 'worker-token', workspaceId: 'ws_a',
      queryStatus: async providerRequestId => {
        queried.push(providerRequestId)
        return { state: 'processing', providerRequestId, evidence: { observedAt: '2026-08-31T00:00:00.000Z', source: 'provider_status' } }
      },
      fetcher: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/reconciliation')) return new Response(JSON.stringify({ pending_executions: [
          { job_id: 'reserved', event_id: 'event_reserved', intent_hash: 'a'.repeat(64), execution_attempt: 1, execution_state: 'provider_reserved' },
          { job_id: 'dispatching', event_id: 'event_dispatching', intent_hash: 'b'.repeat(64), execution_attempt: 1, execution_state: 'provider_dispatching', provider_request_id: 'not-authoritative-yet' },
          { job_id: 'started-without-request', event_id: 'event_started_missing', intent_hash: 'c'.repeat(64), execution_attempt: 1, execution_state: 'provider_started' },
          { job_id: 'unknown', event_id: 'event_unknown', intent_hash: 'd'.repeat(64), execution_attempt: 1, execution_state: 'outcome_unknown', provider_request_id: 'provider_unknown' },
          { job_id: 'future', event_id: 'event_future', intent_hash: 'e'.repeat(64), execution_attempt: 1, execution_state: 'provider_finished', provider_request_id: 'provider_future' },
        ], next_cursor: null }), { status: 200 })
        evidence.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ data: { accepted: true }, error: null }), { status: 200 })
      },
    })
    expect(queried).toEqual(['provider_unknown'])
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({ job_id: 'unknown', provider_request_id: 'provider_unknown', provider_state: 'processing' })
    expect(result.results).toHaveLength(1)
    expect((result.results[0] as { queried: number }).queried).toBe(1)
  })

  it('does not collapse distinct event bindings that reuse a provider request id', async () => {
    const queried: string[] = []
    const evidence: string[] = []
    await reconcileImageGenerationWorkspace({
      apiBaseUrl: 'https://api.test', apiToken: 'worker-token', workspaceId: 'ws_a',
      queryStatus: async providerRequestId => { queried.push(providerRequestId); return { state: 'processing', providerRequestId, evidence: { observedAt: '2026-08-31T00:00:00.000Z', source: 'provider_status' } } },
      fetcher: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/reconciliation')) return new Response(JSON.stringify({ pending_executions: [
          { job_id: 'job_1', event_id: 'event_1', intent_hash: 'a'.repeat(64), execution_attempt: 1, execution_state: 'provider_started', provider_request_id: 'provider_1' },
          { job_id: 'job_1', event_id: 'event_2', intent_hash: 'b'.repeat(64), execution_attempt: 1, execution_state: 'provider_started', provider_request_id: 'provider_1' },
        ], next_cursor: null }), { status: 200 })
        evidence.push(JSON.parse(String(init?.body)).event_id)
        return new Response(JSON.stringify({ data: { accepted: true }, error: null }), { status: 200 })
      },
    })
    expect(queried).toEqual(['provider_1', 'provider_1'])
    expect(evidence).toEqual(['event_1', 'event_2'])
  })

  it('derives the same idempotency key for an identical provider observation', () => {
    const input = { workspaceId: 'ws_a', jobId: 'job_1', eventId: 'event_1', intentHash: 'a'.repeat(64), executionAttempt: 2, queryAttempt: 3, providerRequestId: 'provider_1' } as const
    expect(imageReconciliationIdempotencyKey(input)).toBe(imageReconciliationIdempotencyKey({ ...input }))
    expect(imageReconciliationIdempotencyKey(input)).toMatch(/^image-reconcile:[a-f0-9]{64}$/u)
    expect(imageReconciliationIdempotencyKey(input)).not.toBe(imageReconciliationIdempotencyKey({ ...input, queryAttempt: 4 }))
    expect(imageReconciliationIdempotencyKey(input)).not.toBe(imageReconciliationIdempotencyKey({ ...input, workspaceId: 'ws_b' }))
    expect(imageReconciliationIdempotencyKey(input)).not.toBe(imageReconciliationIdempotencyKey({ ...input, eventId: 'event_2' }))
  })

  it('uses bounded exponential backoff for non-terminal provider observations', () => {
    expect(imageReconciliationNextAttemptAt({ observedAt: '2026-08-31T00:00:00.000Z', state: 'processing', queryAttempt: 1 })).toBe('2026-08-31T00:00:30.000Z')
    expect(imageReconciliationNextAttemptAt({ observedAt: '2026-08-31T00:00:00.000Z', state: 'unknown', queryAttempt: 2 })).toBe('2026-08-31T00:02:00.000Z')
    expect(imageReconciliationNextAttemptAt({ observedAt: '2026-08-31T00:00:00.000Z', state: 'succeeded', queryAttempt: 3 })).toBeUndefined()
  })

  it('rejects invalid reconciliation page and provider timeout limits before network I/O', async () => {
    let called = false
    const fetcher: typeof fetch = async () => { called = true; return new Response('{}', { status: 200 }) }
    await expect(reconcileImageGenerationWorkspace({ apiBaseUrl: 'https://api.test', apiToken: 'worker-token', workspaceId: 'ws_a', maxPages: 0, fetcher })).rejects.toThrow('maxPages')
    await expect(reconcileImageGenerationWorkspace({ apiBaseUrl: 'https://api.test', apiToken: 'worker-token', workspaceId: 'ws_a', queryTimeoutMs: 0, queryStatus: async () => ({ state: 'processing', providerRequestId: 'provider_1', evidence: { observedAt: '2026-08-31T00:00:00.000Z', source: 'provider_status' } }), fetcher: async () => new Response(JSON.stringify({ pending_executions: [{ job_id: 'job_1', event_id: 'event_1', intent_hash: 'a'.repeat(64), execution_attempt: 1, provider_request_id: 'provider_1' }] }), { status: 200 }) })).rejects.toThrow('timeout')
    expect(called).toBe(false)
  })

  it('submits unknown evidence on a status query timeout and never retries generation', async () => {
    const requests: Record<string, unknown>[] = []
    await reconcileImageGenerationWorkspace({
      apiBaseUrl: 'https://api.test', apiToken: 'worker-token', workspaceId: 'ws_a', queryTimeoutMs: 1,
      queryStatus: async (_providerRequestId, options) => await new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true })),
      fetcher: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/reconciliation')) return new Response(JSON.stringify({ pending_executions: [{ job_id: 'job_2', event_id: 'event_2', intent_hash: 'b'.repeat(64), execution_attempt: 1, execution_state: 'outcome_unknown', provider_request_id: 'provider_2' }] }), { status: 200 })
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ data: { accepted: true }, error: null }), { status: 200 })
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ provider_state: 'unknown', provider_request_id: 'provider_2', provider_status: 'timeout', error_code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' })
  })

  it('enforces the status query timeout when the provider ignores abort signals', async () => {
    const requests: Record<string, unknown>[] = []
    await reconcileImageGenerationWorkspace({
      apiBaseUrl: 'https://api.test', apiToken: 'worker-token', workspaceId: 'ws_a', queryTimeoutMs: 1,
      queryStatus: async () => await new Promise(() => undefined),
      fetcher: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/reconciliation')) return new Response(JSON.stringify({ pending_executions: [{ job_id: 'job_3', event_id: 'event_3', intent_hash: 'c'.repeat(64), execution_attempt: 1, execution_state: 'outcome_unknown', provider_request_id: 'provider_3' }] }), { status: 200 })
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ data: { accepted: true }, error: null }), { status: 200 })
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ provider_state: 'unknown', provider_request_id: 'provider_3', provider_status: 'timeout', error_code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' })
  })

  it('rejects status evidence before network I/O when request ids do not match', async () => {
    let called = false
    await expect(postImageGenerationReconciliationStatus({
      apiBaseUrl: 'https://api.test', apiToken: 'worker-token', workspaceId: 'ws_a', candidate: { jobId: 'job_1', eventId: 'event_1', intentHash: 'a'.repeat(64), executionAttempt: 1, providerRequestId: 'provider_1', executionState: 'provider_started' },
      status: { state: 'succeeded', providerRequestId: 'provider_2', images: ['https://cdn.example/image.png'], evidence: { observedAt: '2026-08-31T00:00:00.000Z', source: 'provider_status' } },
      fetcher: async () => { called = true; return new Response('{}', { status: 200 }) },
    })).rejects.toThrow('provider request id mismatch')
    expect(called).toBe(false)
  })

  it('rejects model usage callbacks without an action id before network I/O', async () => {
    let called = false
    await expect(postModelUsage({
      apiBaseUrl: 'http://api.test',
      apiToken: 'worker-token',
      usage: { workspaceId: 'ws-1', modality: 'text', model: 'test-model', costCny: 0.01, observedAt: '2026-08-29T00:00:00.000Z' },
      fetcher: async () => { called = true; return new Response('{}', { status: 200 }) },
    })).rejects.toThrow('requires actionId')
    expect(called).toBe(false)
  })

  it('rejects model usage callbacks without a run key before network I/O', async () => {
    let called = false
    await expect(postModelUsage({
      apiBaseUrl: 'http://api.test',
      apiToken: 'worker-token',
      usage: { workspaceId: 'ws-1', actionId: 'model:generation:idem_1', modality: 'text', model: 'test-model', costCny: 0.01, observedAt: '2026-08-29T00:00:00.000Z' },
      fetcher: async () => { called = true; return new Response('{}', { status: 200 }) },
    })).rejects.toThrow('requires runKey')
    expect(called).toBe(false)
  })

  it('requires the execution gate to return the frozen publish payload hash', async () => {
    const event = { id: 'evt_gate', workspaceId: 'ws_a', aggregateId: 'job_gate', eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString() }
    const validHash = 'a'.repeat(64)
    const accepted = await assertPublishExecution({
      apiBaseUrl: 'http://api.test', apiToken: 'token', event,
      fetcher: async () => new Response(JSON.stringify({ data: { credential_ref: 'vault://merchant/ws_a/jd', payload_hash: validHash } }), { status: 200, headers: { 'content-type': 'application/json' } }),
    })
    expect(accepted).toEqual({ credentialRef: 'vault://merchant/ws_a/jd', payloadHash: validHash, mediaRequired: false })

    await expect(assertPublishExecution({
      apiBaseUrl: 'http://api.test', apiToken: 'token', event,
      fetcher: async () => new Response(JSON.stringify({ data: { credential_ref: 'vault://merchant/ws_a/jd' } }), { status: 200, headers: { 'content-type': 'application/json' } }),
    })).rejects.toThrow('did not return a payload hash')
  })

  it('rejects publish media whose declared base64 content does not match its digest', async () => {
    const event = { id: 'evt_media', workspaceId: 'ws_a', aggregateId: 'job_media', eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString() }
    await expect(fetchPublishMedia({
      apiBaseUrl: 'http://api.test', apiToken: 'token', event,
      fetcher: async () => new Response(JSON.stringify({ data: { media: [{ visual_ref: 'dvis_1', role: 'main', mime_type: 'image/png', sha256: 'a'.repeat(64), content_base64: Buffer.from('not-a-png').toString('base64') }] } }), { status: 200 }),
    })).rejects.toThrow('invalid size or SHA-256 digest')
  })
})
