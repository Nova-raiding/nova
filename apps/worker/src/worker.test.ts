import { describe, expect, it, vi } from 'vitest'
import { createOutboxHandler, createWorkerProjection } from './handler.js'
import { assertPublishExecution, fetchPublishMedia, pollOnce, postAutomationTick, postModelUsage, readWorkerConfig } from './main.js'
import type { PostgresOutboxRepository } from '../../../packages/persistence/src/index.js'
import { InMemoryQueue, type DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import { QuotaExceededError } from '../../../packages/quotas/src/admission.js'

const baseEnv = { DATABASE_URL: 'postgres://worker', WORKER_WORKSPACES: 'ws_a, ws_b,ws_a' }

describe('worker production entry', () => {
  it('requires explicit tenant scope and deduplicates configured workspaces', () => {
    expect(readWorkerConfig(baseEnv)).toMatchObject({ workspaces: ['ws_a', 'ws_b'], batchSize: 100, workspaceBatchSize: 10, leaseMs: 30_000 })
    expect(() => readWorkerConfig({ DATABASE_URL: baseEnv.DATABASE_URL })).toThrow('WORKER_WORKSPACES')
    expect(readWorkerConfig({ DATABASE_URL: baseEnv.DATABASE_URL, WORKER_WORKSPACES: 'auto' })).toMatchObject({ workspaces: [], autoDiscoverWorkspaces: true })
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

  it('moves publish.requested to unknown when no connector handler exists', async () => {
    const handler = createOutboxHandler()
    await expect(handler({ event: { id: 'evt_p', workspaceId: 'ws_a', aggregateId: 'job_1', eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() }))
      .rejects.toMatchObject({ error: { code: 'CONNECTOR_HANDLER_UNAVAILABLE', unknown: true, retryable: false } })
  })

  it('executes an injected publish connector and reports its verified remote status', async () => {
    const observed: string[] = []
    const handler = createOutboxHandler({
      publishRequested: async () => ({ receipt: { platform: 'jd', operation: 'update', remoteId: 'JD-1', requestId: 'req-1', status: 'submitted', simulated: false, idempotencyKey: 'idem-1' }, remoteStatus: { found: true, state: 'submitted', remoteId: 'JD-1', requestId: 'req-1', simulated: false } }),
      onPublishObservation: async event => { observed.push(event.aggregateId) },
    })
    const result = await handler({ event: { id: 'evt_verified', workspaceId: 'ws_a', aggregateId: 'job_1', eventType: 'publish.requested', sequence: 1, payload: { platform: 'jd', account_id: 'acct_1', fields: {} }, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() })
    expect(result).toMatchObject({ value: { remoteStatus: { state: 'submitted' } } })
    expect(observed).toEqual(['job_1'])
  })

  it('reports connector failure as an unknown business observation before durable unknown', async () => {
    const observations: Array<{ state: string; found: boolean }> = []
    const handler = createOutboxHandler({
      publishRequested: async () => { throw new Error('vault unavailable') },
      onPublishObservation: async (_event, observation) => { observations.push({ state: observation.remoteStatus.state, found: observation.remoteStatus.found }) },
    })
    await expect(handler({ event: { id: 'evt_failure', workspaceId: 'ws_a', aggregateId: 'job_2', eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() })).rejects.toMatchObject({ error: { unknown: true } })
    expect(observations).toEqual([{ state: 'unknown', found: false }])
  })

  it('does not manufacture remote unknown for a known pre-execution connector rejection', async () => {
    const observations: unknown[] = []
    const handler = createOutboxHandler({
      publishRequested: async () => { throw { normalized: { code: 'UNAUTHORIZED', message: 'reauthorization required', retryable: false, unknown: false } } },
      onPublishObservation: async (_event, observation) => { observations.push(observation) },
    })
    await expect(handler({ event: { id: 'evt_auth', workspaceId: 'ws_a', aggregateId: 'job_auth', eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() }))
      .rejects.toMatchObject({ error: { code: 'UNAUTHORIZED', retryable: false, unknown: false } })
    expect(observations).toEqual([])
  })

  it('runs a separate reconcile event and preserves submitted/published evidence', async () => {
    const handler = createOutboxHandler({
      reconcileRequested: async () => ({ remoteStatus: { found: true, state: 'published', remoteId: 'JD-1', requestId: 'status-1', simulated: false } }),
    })
    const result = await handler({ event: { id: 'evt_reconcile', workspaceId: 'ws_a', aggregateId: 'job_3', eventType: 'publish.reconcile_requested', sequence: 1, payload: { platform: 'jd', account_id: 'acct_1', idempotencyKey: 'idem-3', payload_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() })
    expect(result).toMatchObject({ value: { remoteStatus: { state: 'published', requestId: 'status-1' } } })
  })

  it('executes generation events through an injected model worker and reports the result', async () => {
    const reported: Array<{ content?: unknown }> = []
    const handler = createOutboxHandler({
      generationRequested: async () => ({ title: '模型标题', detail: '模型详情', sellingPoints: ['事实卖点'] }),
      onGenerationResult: async (_event, result) => { reported.push(result) },
    })
    const result = await handler({ event: { id: 'evt_generation', workspaceId: 'ws_a', aggregateId: 'gen_1', eventType: 'generation.requested', sequence: 1, payload: { input: {} }, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() })
    expect(result).toMatchObject({ value: { title: '模型标题' } })
    expect(reported).toEqual([{ content: { title: '模型标题', detail: '模型详情', sellingPoints: ['事实卖点'] } }])
  })

  it('keeps quota exhaustion queued instead of reporting a terminal generation failure', async () => {
    const reported: unknown[] = []
    const handler = createOutboxHandler({
      generationRequested: async () => { throw new QuotaExceededError({ allowed: false, retryAfterSeconds: 12, limitPerWindow: 60, used: 61 }) },
      onGenerationResult: async (_event, result) => { reported.push(result) },
    })
    await expect(handler({ event: { id: 'evt_quota', workspaceId: 'ws_a', aggregateId: 'gen_quota', eventType: 'generation.requested', sequence: 1, payload: { input: {} }, createdAt: new Date().toISOString() }, attempt: 1, now: Date.now() }))
      .rejects.toMatchObject({ error: { code: 'QUOTA_EXHAUSTED', retryable: true, unknown: false } })
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

  it('allows an explicit per-workspace batch cap for noisy-tenant isolation', () => {
    expect(readWorkerConfig({ ...baseEnv, WORKER_WORKSPACE_BATCH_SIZE: '4' }).workspaceBatchSize).toBe(4)
  })

  it('enforces a global batch cap while sharing work fairly across tenants', async () => {
    const pending = new Map<string, DurableOutboxEvent[]>(['ws_a', 'ws_b'].map(workspaceId => [workspaceId, Array.from({ length: 20 }, (_, index) => ({
      id: `${workspaceId}_evt_${index}`, workspaceId, aggregateId: `${workspaceId}_task_${index}`, eventType: 'task.created', sequence: 1,
      payload: { id: `${workspaceId}_task_${index}`, workspaceId }, createdAt: new Date().toISOString(),
    }))]))
    const acknowledged: string[] = []
    const repository = {
      claimPending: async (workspaceId: string, options: { limit?: number } = {}) => pending.get(workspaceId)?.slice(0, options.limit ?? 100) ?? [],
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

  it('fails closed for production callback workers without the signed API contract', () => {
    expect(() => readWorkerConfig({ ...baseEnv, NODE_ENV: 'production', WORKER_ROLE: 'publish' })).toThrow('WORKER_API_SIGNING_SECRET')
    expect(readWorkerConfig({ ...baseEnv, NODE_ENV: 'production', WORKER_ROLE: 'publish', WORKER_API_BASE_URL: 'http://api:8787', WORKER_API_TOKEN: 'test-token', WORKER_API_SIGNING_SECRET: 'test-signing' })).toMatchObject({ apiBaseUrl: 'http://api:8787', apiToken: 'test-token', apiSigningSecret: 'test-signing' })
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

  it('submits signed relay usage to the API before generated content is accepted', async () => {
    const requests: Array<{ url: string; body: string; headers: Headers }> = []
    await postModelUsage({
      apiBaseUrl: 'https://api.test', apiToken: 'worker-token', signingSecret: 'worker-secret',
      usage: { workspaceId: 'ws_a', actionId: 'model:generation:idem_1', modality: 'text', model: 'relay-text', providerRequestId: 'relay_req_1', inputTokens: 10, outputTokens: 5, totalTokens: 15, costCny: 0.02, observedAt: '2026-08-28T00:00:00.000Z' },
      fetcher: async (input, init) => { requests.push({ url: String(input), body: String(init?.body), headers: new Headers(init?.headers) }); return new Response('{}', { status: 200 }) },
    })
    expect(requests[0]?.url).toBe('https://api.test/v1/internal/model-usage')
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ workspaceId: 'ws_a', actionId: 'model:generation:idem_1', providerRequestId: 'relay_req_1', totalTokens: 15, costCny: 0.02 })
    expect(requests[0]?.headers.get('x-workspace-id')).toBe('ws_a')
    expect(requests[0]?.headers.get('x-worker-workspace-signature')).toMatch(/^[a-f0-9]{64}$/u)
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
