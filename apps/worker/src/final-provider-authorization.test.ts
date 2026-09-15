import { describe, expect, it, vi } from 'vitest'
import { closeRejectedImageDispatch, createApiExecutionAuthorizationGuard, createWorkerProviderDispatchAdmission, executeWorkerProviderAfterPreflight, updateImageGenerationExecution, type WorkerProviderDispatchScope } from './main.js'
import { createOutboxHandler } from './handler.js'
import { WorkerExecutionAuthorizationError, type CriticalWorkerOperation, type WorkerExecutionAuthorizationGuard } from '../../../packages/workers/src/execution-authorization.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'

// Controlled API/connector stubs exercise the production callback ordering;
// these are regression tests, not real provider or PostgreSQL evidence.
function fixture(operation: CriticalWorkerOperation = 'generation.execute'): DurableOutboxEvent {
  const eventType = operation === 'publish.execute' ? 'publish.requested' : operation === 'image_generation.execute' ? 'image.generation.requested' : operation === 'catalog.sync.execute' ? 'sync.requested' : 'generation.requested'
  return {
    id: 'event_dispatch', workspaceId: 'workspace_dispatch', aggregateId: 'job_dispatch', eventType, sequence: 1, createdAt: new Date().toISOString(),
    payload: {
      authorization_snapshot: {
        schema_version: 1, decision_id: 'enqueue_decision', actor_id: 'actor_a', identity_id: 'identity_a', workspace_id: 'workspace_dispatch',
        workbench: 'workspace', context_id: 'workspace:workspace_dispatch', context_version: 'context_1', policy_version: 'policy_1',
        grant_revision: 'membership:identity_a:1', grant_ids: [], scope_hash: 'a'.repeat(64), capability: operation, resource_id: 'job_dispatch',
        resource_revision: '1', request_id: 'request_dispatch', trace_id: 'trace_dispatch', authorized: true, decided_at: new Date().toISOString(),
      },
    },
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function guard(allowed: () => boolean): WorkerExecutionAuthorizationGuard {
  return {
    assertAuthorized: vi.fn(async () => {
      if (!allowed()) throw new WorkerExecutionAuthorizationError('CUSTOMER_DELIVERY_REQUIRED', '交付凭证已失效', { retryable: false })
      return {} as never
    }),
  }
}

describe('final worker provider authorization after asynchronous preflight', () => {
  it.each([
    ['quota', 'generation.execute'],
    ['publish lock and media', 'publish.execute'],
    ['image lease', 'image_generation.execute'],
    ['sync execution context', 'catalog.sync.execute'],
  ] as const)('rejects revocation during %s with zero provider calls', async (_wait, operation) => {
    let allowed = true
    const authorization = guard(() => allowed)
    const waiting = deferred()
    const entered = deferred()
    const invoke = vi.fn(async () => 'provider-result')
    const running = executeWorkerProviderAfterPreflight({
      event: fixture(operation), operation, authorization,
      preflight: async () => { entered.resolve(); await waiting.promise }, invoke,
    })
    const rejected = expect(running).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_REQUIRED', retryable: false, unknown: false })
    await entered.promise
    expect(invoke).not.toHaveBeenCalled()
    allowed = false
    waiting.resolve()
    await rejected
    expect(invoke).not.toHaveBeenCalled()
    expect(authorization.assertAuthorized).toHaveBeenCalledOnce()
  })

  it('does not replace a current API recheck with the enqueue snapshot', async () => {
    const event = fixture()
    let revoked = false
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (revoked) return Response.json({ error: { code: 'CUSTOMER_DELIVERY_REQUIRED', message: '交付未完成' } }, { status: 403 })
      const raw = event.payload.authorization_snapshot as Record<string, unknown>
      return Response.json({ data: { authorization_recheck: { ...raw, recheck_id: 'fresh_recheck', checked_at: new Date().toISOString() } } })
    })
    const authorization = createApiExecutionAuthorizationGuard({ apiBaseUrl: 'https://api.example.test', apiToken: 'test-only-token' }, fetcher)
    await authorization.assertAuthorized(event, 'generation.execute')
    const invoke = vi.fn(async () => 'not reached')
    await expect(executeWorkerProviderAfterPreflight({ event, operation: 'generation.execute', authorization, preflight: async () => { revoked = true }, invoke }))
      .rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_REQUIRED', retryable: false, unknown: false })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('propagates authorization unavailability without provider I/O', async () => {
    const authorization = createApiExecutionAuthorizationGuard({ apiBaseUrl: 'https://api.example.test', apiToken: 'test-only-token' }, async () => Response.json({ error: { code: 'CUSTOMER_DELIVERY_ACCESS_UNAVAILABLE', message: '读取不可用' } }, { status: 503 }))
    const invoke = vi.fn()
    await expect(executeWorkerProviderAfterPreflight({ event: fixture(), operation: 'generation.execute', authorization, preflight: async () => undefined, invoke }))
      .rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_ACCESS_UNAVAILABLE', retryable: true, unknown: false })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('preserves the exact order and does not recheck settlement after a successful call', async () => {
    const order: string[] = []
    let allowed = true
    const authorization: WorkerExecutionAuthorizationGuard = { assertAuthorized: vi.fn(async () => { expect(allowed).toBe(true); order.push('authorization'); return {} as never }) }
    const result = await executeWorkerProviderAfterPreflight({
      event: fixture(), operation: 'generation.execute', authorization,
      preflight: async () => { order.push('quota') },
      invoke: async () => { order.push('provider'); allowed = false; order.push('record-real-receipt'); return 'receipt' },
    })
    expect(result).toBe('receipt')
    expect(order).toEqual(['quota', 'authorization', 'provider', 'record-real-receipt'])
  })

  it('does not invoke after cancellation during the final check', async () => {
    const controller = new AbortController()
    const invoke = vi.fn()
    await expect(executeWorkerProviderAfterPreflight({
      event: fixture(), operation: 'generation.execute', signal: controller.signal,
      authorization: { assertAuthorized: vi.fn(async () => { controller.abort(new Error('lease lost')); return {} as never }) },
      preflight: async () => undefined, invoke,
    })).rejects.toThrow('lease lost')
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each(['generation.execute', 'publish.execute', 'image_generation.execute'] as const)('does not record false provider outcomes for final %s denial', async operation => {
    let allowed = true
    const authorization = guard(() => allowed)
    const invoke = vi.fn(async () => (undefined as never))
    const callback = () => executeWorkerProviderAfterPreflight({ event: fixture(operation), operation, authorization, preflight: async () => { allowed = false }, invoke })
    const result = vi.fn()
    const observation = vi.fn()
    const handler = createOutboxHandler({
      executionAuthorization: authorization,
      commercialAccess: { assertCommercialAccess: async () => ({} as never) },
      ...(operation === 'generation.execute' ? { generationRequested: callback } : operation === 'publish.execute' ? { publishRequested: callback } : { imageGenerationRequested: callback }),
      onGenerationResult: result,
      onPublishObservation: observation,
    })
    await expect(handler({ event: fixture(operation), attempt: 1, now: Date.now() }))
      .rejects.toMatchObject({ error: { code: 'CUSTOMER_DELIVERY_REQUIRED', retryable: false, unknown: false } })
    expect(invoke).not.toHaveBeenCalled()
    expect(result).not.toHaveBeenCalled()
    expect(observation).not.toHaveBeenCalled()
  })
})

describe('trusted worker dispatch context reaches individual transport requests', () => {
  it('rechecks every sync page after signing/preflight and stops before the next fetch', async () => {
    let allowed = true
    const authorization = guard(() => allowed)
    const admission = createWorkerProviderDispatchAdmission(authorization)
    const fetchProvider = vi.fn(async () => ({ nextCursor: 'page_2' }))
    const scope: WorkerProviderDispatchScope = { event: fixture('catalog.sync.execute'), operation: 'catalog.sync.execute', providerRequests: 0 }
    await expect(admission.run(scope, async () => {
      await admission.beforeConnectorRequest({ operation: 'sync_products', workspaceId: scope.event.workspaceId })
      await fetchProvider()
      allowed = false
      await admission.beforeConnectorRequest({ operation: 'sync_products', workspaceId: scope.event.workspaceId })
      await fetchProvider()
    })).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_REQUIRED' })
    expect(fetchProvider).toHaveBeenCalledOnce()
    expect(scope.providerRequests).toBe(1)
  })

  it('does not share identities between concurrent worker events', async () => {
    const pending = deferred()
    const scopeA: WorkerProviderDispatchScope = { event: fixture(), operation: 'generation.execute', providerRequests: 0 }
    const scopeB: WorkerProviderDispatchScope = { event: { ...fixture(), id: 'event_b', workspaceId: 'workspace_b' }, operation: 'generation.execute', providerRequests: 0 }
    const seen: string[] = []
    const admission = createWorkerProviderDispatchAdmission({ assertAuthorized: vi.fn(async event => { seen.push(event.id); return {} as never }) })
    const runningA = admission.run(scopeA, async () => { await pending.promise; await admission.beforeModelRequest({ operation: 'text_generate', workspaceId: scopeA.event.workspaceId }) })
    await admission.run(scopeB, () => admission.beforeModelRequest({ operation: 'text_generate', workspaceId: scopeB.event.workspaceId }))
    pending.resolve()
    await runningA
    expect(seen).toEqual(['event_b', 'event_dispatch'])
    expect(scopeA.providerRequests).toBe(1)
    expect(scopeB.providerRequests).toBe(1)
  })

  it('denies missing or mismatched trusted scope before consulting provider', async () => {
    const authorization = guard(() => true)
    const admission = createWorkerProviderDispatchAdmission(authorization)
    await expect(admission.beforeModelRequest({ operation: 'text_generate', workspaceId: 'workspace_dispatch' })).rejects.toMatchObject({ code: 'AUTHZ_PROVIDER_CONTEXT_REQUIRED' })
    const scope: WorkerProviderDispatchScope = { event: fixture(), operation: 'generation.execute', providerRequests: 0 }
    await expect(admission.run(scope, () => admission.beforeModelRequest({ operation: 'text_generate', workspaceId: 'workspace_other' }))).rejects.toMatchObject({ code: 'AUTHZ_PROVIDER_CONTEXT_REQUIRED' })
    await expect(admission.run(scope, () => admission.beforeConnectorRequest({ operation: 'create_product', workspaceId: 'workspace_dispatch' }))).rejects.toMatchObject({ code: 'AUTHZ_PROVIDER_CONTEXT_REQUIRED' })
    expect(authorization.assertAuthorized).not.toHaveBeenCalled()
  })

  it('keeps observation queries and credential recovery outside new delivery checks', async () => {
    const authorization = guard(() => false)
    const admission = createWorkerProviderDispatchAdmission(authorization)
    for (const operation of ['query_write', 'refresh_credential', 'revoke', 'exchange_code']) await admission.beforeConnectorRequest({ operation })
    for (const operation of ['image_query', 'video_query']) await admission.beforeModelRequest({ operation })
    expect(authorization.assertAuthorized).not.toHaveBeenCalled()
  })
})

describe('image zero-provider rejection closure', () => {
  it.each([
    { status: 423, code: 'WORKSPACE_DISABLED' },
    { status: 403, code: 'WORKSPACE_DISABLED' },
    { status: 423, code: undefined },
  ])('treats workspace stop ($status/$code) before image dispatch as known and closes only the unsent lease', async ({ status, code }) => {
    const event = fixture('image_generation.execute')
    const provider = vi.fn(async () => 'not reached')
    const operations: string[] = []
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as Record<string, unknown>
      operations.push(String(input.operation))
      if (input.operation === 'begin_provider_dispatch') return Response.json({ error: { code, message: '工作区已停用' } }, { status })
      expect(input.operation).toBe('fail_before_provider')
      expect(input).toMatchObject({ event_id: event.id, owner_token: 'owner_test', error_code: 'WORKSPACE_DISABLED' })
      expect(input.provider_request_id).toBeUndefined()
      return Response.json({ data: { execution: { state: 'failed', workspaceId: event.workspaceId, jobId: event.aggregateId, eventId: event.id } } })
    })
    const input = { apiBaseUrl: 'https://api.example.test', apiToken: 'test-only-token', event, ownerToken: 'owner_test', fetcher }
    const execute = async () => {
      try {
        await updateImageGenerationExecution({ ...input, operation: 'begin_provider_dispatch' })
        await provider()
      } catch (error) {
        expect(error).toBeInstanceOf(WorkerExecutionAuthorizationError)
        expect(error).toMatchObject({ code: 'WORKSPACE_DISABLED', retryable: false, unknown: false })
        return closeRejectedImageDispatch({ ...input, error, providerRequests: 0 })
      }
    }
    await expect(execute()).rejects.toMatchObject({ code: 'WORKSPACE_DISABLED', retryable: false, unknown: false })
    expect(provider).not.toHaveBeenCalled()
    expect(operations).toEqual(['begin_provider_dispatch', 'fail_before_provider'])
  })

  it.each([false, true])('closes a proven uninvoked image lease without a fabricated provider id (read retryability %s)', async retryable => {
    const error = new WorkerExecutionAuthorizationError(retryable ? 'CUSTOMER_DELIVERY_ACCESS_UNAVAILABLE' : 'CUSTOMER_DELIVERY_REQUIRED', '交付门禁拒绝', { retryable })
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: { execution: { state: 'failed', workspaceId: 'workspace_dispatch', jobId: 'job_dispatch', eventId: 'event_dispatch' } } }))
    await expect(closeRejectedImageDispatch({ apiBaseUrl: 'https://api.example.test', apiToken: 'test-only-token', event: fixture('image_generation.execute'), ownerToken: 'owner_test', providerRequests: 0, error, fetcher }))
      .rejects.toMatchObject({ code: error.code, retryable: false, unknown: false })
    const posted = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(posted).toEqual({ operation: 'fail_before_provider', event_id: 'event_dispatch', owner_token: 'owner_test', error_code: error.code, error_message: error.message })
    expect(posted.provider_request_id).toBeUndefined()
  })

  it.each([
    [1, new WorkerExecutionAuthorizationError('CUSTOMER_DELIVERY_REQUIRED', 'revoked after earlier dispatch', { retryable: false })],
    [1, new WorkerExecutionAuthorizationError('WORKSPACE_DISABLED', 'workspace stopped after earlier dispatch', { retryable: false })],
    [0, Object.assign(new Error('network timeout'), { code: 'ETIMEDOUT' })],
  ])('never closes a lease as zero-provider after %s prior requests or a generic transport failure', async (providerRequests, error) => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(closeRejectedImageDispatch({ apiBaseUrl: 'https://api.example.test', apiToken: 'test-only-token', event: fixture('image_generation.execute'), ownerToken: 'owner_test', providerRequests, error, fetcher })).rejects.toBe(error)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('fails closed when the owner/event-bound close cannot be persisted', async () => {
    const error = new WorkerExecutionAuthorizationError('CUSTOMER_DELIVERY_REQUIRED', 'revoked', { retryable: false })
    await expect(closeRejectedImageDispatch({ apiBaseUrl: 'https://api.example.test', apiToken: 'test-only-token', event: fixture('image_generation.execute'), ownerToken: 'owner_test', providerRequests: 0, error, fetcher: async () => Response.json({ error: { code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' } }, { status: 409 }) }))
      .rejects.toMatchObject({ code: 'IMAGE_GENERATION_PRE_PROVIDER_CLOSE_UNAVAILABLE', retryable: false, unknown: false })
  })

  it('does not accept a successful HTTP response carrying another execution binding', async () => {
    const error = new WorkerExecutionAuthorizationError('CUSTOMER_DELIVERY_REQUIRED', 'revoked', { retryable: false })
    await expect(closeRejectedImageDispatch({ apiBaseUrl: 'https://api.example.test', apiToken: 'test-only-token', event: fixture('image_generation.execute'), ownerToken: 'owner_test', providerRequests: 0, error, fetcher: async () => Response.json({ data: { execution: { state: 'failed', workspaceId: 'workspace_other', jobId: 'job_dispatch', eventId: 'event_dispatch' } } }) }))
      .rejects.toMatchObject({ code: 'IMAGE_GENERATION_PRE_PROVIDER_CLOSE_UNAVAILABLE', retryable: false, unknown: false })
  })
})
