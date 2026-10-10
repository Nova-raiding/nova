import { describe, expect, it, vi } from 'vitest'
import { handleInternalRuntimeRoute } from './http-internal-runtime-routes.js'
import type { InternalRuntimeContext } from './server.js'

function fixture() {
  const event = { id: 'evt', workspaceId: 'ws', aggregateId: 'job', eventType: 'image.generation.requested', payload: {
    action_id: 'image:key', run_key: 'image:key', authorization_snapshot: {
      schema_version: 1, decision_id: 'decision', actor_id: 'actor', identity_id: 'identity', workspace_id: 'ws', workbench: 'workspace', context_id: 'workspace:ws', context_version: '1', policy_version: '1', grant_revision: '1', grant_ids: ['grant'], scope_hash: 'a'.repeat(64), capability: 'image_generation.execute', resource_id: 'job', resource_revision: '1', request_id: 'request', trace_id: 'trace', authorized: true, decided_at: '2026-10-05T00:00:00.000Z',
    },
  } }
  const execution: { state: string; ownerToken: string; eventId: string; providerStartedAt?: string; providerRequestId?: string } = { state: 'provider_reserved', ownerToken: 'owner', eventId: 'evt' }
  const reserve = vi.fn(async () => ({ reservation: { status: 'active' } }))
  const release = vi.fn(async () => undefined)
  const close = vi.fn(async () => { execution.state = 'failed'; execution.ownerToken = ''; return execution })
  const dispatch = vi.fn(async () => ({ ...execution, state: 'provider_dispatching' }))
  const context = {
    req: { method: 'POST' }, res: {}, path: '/v1/internal/image-generation-jobs/job/execution',
    requireWorkerAuthorization: vi.fn(), headerRequired: () => 'ws', enrichRequestObservation: vi.fn(),
    body: async () => ({ operation: 'begin_provider_dispatch', owner_token: 'owner' }),
    persistence: { imageGenerationExecutions: { get: async () => execution, beginProviderDispatch: dispatch, failBeforeProvider: close, hasPreProviderFailureProof: async () => true }, outbox: { listAggregateEvents: async () => [event] } },
    service: { getImageGenerationJob: () => ({ idempotencyKey: 'key' }) },
    reserveDailyModelBudget: reserve, releaseDailyModelBudget: release, recheckWorkerAuthorizationSnapshot: vi.fn(), send: vi.fn(),
  } as unknown as InternalRuntimeContext
  return { event, execution, reserve, dispatch, context, release, close }
}

describe('durable image final dispatch budget guard', () => {
  it('reserves the frozen action and run before allowing provider dispatch', async () => {
    const f = fixture()
    await handleInternalRuntimeRoute(f.context)
    expect(f.reserve).toHaveBeenCalledWith('ws', 'image:key', 'image:key', 'image')
    expect(f.reserve.mock.invocationCallOrder[0]).toBeLessThan(f.dispatch.mock.invocationCallOrder[0]!)
  })
  it('preserves a safe retry’s original run budget instead of creating a new run', async () => {
    const f = fixture(); f.event.payload.run_key = 'image:original-key'
    await handleInternalRuntimeRoute(f.context)
    expect(f.reserve).toHaveBeenCalledWith('ws', 'image:key', 'image:original-key', 'image')
  })
  it('blocks provider dispatch when the budget cannot be reserved', async () => {
    const f = fixture(); f.reserve.mockRejectedValue(new Error('budget unavailable'))
    await expect(handleInternalRuntimeRoute(f.context)).rejects.toThrow('budget unavailable')
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it.each(['settled', 'released'])('does not dispatch against %s budget', async status => {
    const f = fixture(); f.reserve.mockResolvedValue({ reservation: { status } })
    await expect(handleInternalRuntimeRoute(f.context)).rejects.toMatchObject({ code: 'MODEL_USAGE_BUDGET_LINK_CONFLICT' })
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it.each(['provider_started', 'outcome_unknown', 'provider_dispatching'])('never backfills a budget for %s execution', async state => {
    const f = fixture(); f.execution.state = state
    await expect(handleInternalRuntimeRoute(f.context)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
    expect(f.reserve).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('rejects the wrong execution owner before reserving', async () => {
    const f = fixture(); f.execution.ownerToken = 'other'
    await expect(handleInternalRuntimeRoute(f.context)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
    expect(f.reserve).not.toHaveBeenCalled()
  })
  it.each(['action_id', 'run_key'] as const)('rejects an invalid frozen %s before reserving', async field => {
    const f = fixture(); f.event.payload[field] = field === 'action_id' ? 'image:other' : ''
    await expect(handleInternalRuntimeRoute(f.context)).rejects.toMatchObject({ code: 'MODEL_USAGE_BUDGET_LINK_CONFLICT' })
    expect(f.reserve).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled()
  })
})

// Exercise the actual durable MCP admission, with storage/auth ports isolated.
import { handleImageMcpMethod } from './mcp-image-handlers.js'
import type { IncomingMessage } from 'node:http'
import { afterEach } from 'vitest'
afterEach(() => vi.unstubAllEnvs())
function admissionFixture() {
  vi.stubEnv('IMAGE_GENERATION_EXECUTION_MODE', 'durable')
  const job = { id: 'job', workspaceId: 'ws', productId: 'product', idempotencyKey: 'key', revision: 1, state: 'queued', sourceAssetIds: [] }
  const reserve = vi.fn(async () => ({ reservation: { status: 'active' } }))
  const persist = vi.fn(async () => undefined)
  const release = vi.fn(async () => undefined)
  const discard = vi.fn()
  const runtime = {
    service: { products: new Map([['product', { id: 'product', workspaceId: 'ws', factsConfirmed: true, platform: 'taobao' }]]), imageGenerationJobs: new Map(), assertBrandVisualGenerationReady: vi.fn(), enqueueImageGeneration: () => job, discardUnpersistedImageGeneration: discard },
    persistence: { persistSnapshotAndEvent: persist, outbox: {}, imageGenerationExecutions: {} },
    protectedProductConclusion: vi.fn(), requireProtectedProductIntent: vi.fn(), enforceProductBrandAccess: vi.fn(), canonicalProductReadControl: async () => ({ mode: 'legacy' }), requireGenerationRulePreflight: vi.fn(), requireRuleSafeGenerationText: vi.fn(), imageTrace: vi.fn(), requireApprovedAssetForImageGeneration: vi.fn(), enforceMcpCommercialAccess: async () => ({ classification: 'NO_CHARGE' }), requirePlatformModelCostGate: vi.fn(), observeLegacyImageEntitlementShadow: vi.fn(), observeLegacyWalletShadow: vi.fn(), reserveCreativePointsForModel: async () => ({ id: 'point-hold' }), imageCreativePointsEvidence: vi.fn(), requestActor: () => 'actor', header: vi.fn(() => ''), workerAuthorizationSnapshot: () => ({ authorized: true }), serializedWorkerAuthorizationSnapshot: () => ({ authorized: true }), commercialWorkerSnapshotForReservation: vi.fn(), withCommercialWorkerSnapshot: async (_w: unknown, _t: unknown, payload: unknown) => payload, reserveDailyModelBudget: reserve, releaseReservedModelPoints: release, refundPluginWalletDebit: vi.fn(), publicImageJob: (value: unknown) => value,
  } as unknown as Parameters<typeof handleImageMcpMethod>[4]
  const call = () => handleImageMcpMethod('catalog.image.generate', { product_id: 'product', mode: 'create', idempotency_key: 'key' }, 'ws', {} as IncomingMessage, runtime)
  return { reserve, persist, release, discard, call }
}
describe('durable image MCP admission budget', () => {
  it('writes a dispatchable event only after the exact action/run budget is active', async () => {
    const f = admissionFixture(); await f.call()
    expect(f.reserve).toHaveBeenCalledWith('ws', 'image:key', 'image:key', 'image')
    expect(f.reserve.mock.invocationCallOrder[0]).toBeLessThan(f.persist.mock.invocationCallOrder[0]!)
    expect(f.persist).toHaveBeenCalledWith(expect.objectContaining({ eventPayload: expect.objectContaining({ action_id: 'image:key', run_key: 'image:key' }) }))
  })
  it('compensates the owned point hold and removes the unadmitted job when budget preflight fails', async () => {
    const f = admissionFixture(); f.reserve.mockRejectedValue(new Error('budget denied'))
    await expect(f.call()).rejects.toThrow('budget denied')
    expect(f.persist).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce(); expect(f.discard).toHaveBeenCalledWith('ws', 'job')
  })
  it('rejects an unbound candidate without a merchant-confirmed title before admission', async () => {
    const reserve = vi.fn()
    const persist = vi.fn()
    const enforceAssetAccess = vi.fn()
    const runtime = {
      service: { products: new Map(), imageGenerationJobs: new Map() },
      enforceAssetAccess, reserveDailyModelBudget: reserve,
      persistSnapshotAndEvent: persist,
    } as unknown as Parameters<typeof handleImageMcpMethod>[4]
    await expect(handleImageMcpMethod('catalog.image.generate', { asset_ids_json: '["asset-1"]' }, 'ws', {} as IncomingMessage, runtime))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(reserve).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(enforceAssetAccess).not.toHaveBeenCalled()
  })
})

describe('known zero-dispatch image budget cleanup', () => {
  function closeFixture() {
    const f = fixture()
    f.context.body = async () => ({ operation: 'fail_before_provider', event_id: 'evt', owner_token: 'owner', error_code: 'AUTHZ_DENIED', error_message: 'denied' })
    return f
  }
  it('releases only after the durable zero-dispatch CAS completes', async () => {
    const f = closeFixture(); await handleInternalRuntimeRoute(f.context)
    expect(f.close).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledWith('ws', 'image:key')
    expect(f.close.mock.invocationCallOrder[0]).toBeLessThan(f.release.mock.invocationCallOrder[0]!)
  })
  it('can retry cleanup after release fails without repeating the execution transition', async () => {
    const f = closeFixture(); f.release.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(handleInternalRuntimeRoute(f.context)).rejects.toMatchObject({ code: 'MODEL_USAGE_BUDGET_CLEANUP_PENDING', reconciliationRequired: true })
    await handleInternalRuntimeRoute(f.context)
    expect(f.close).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledTimes(2)
    expect(f.context.send).toHaveBeenLastCalledWith(f.context.res, 200, 'ws', expect.objectContaining({ already_closed: true, budget_cleanup_only: true }), null, f.context.req)
  })
  it('never releases if the zero-dispatch CAS loses to a dispatched owner', async () => {
    const f = closeFixture(); f.close.mockRejectedValue(new Error('lease lost'))
    await expect(handleInternalRuntimeRoute(f.context)).rejects.toThrow('lease lost')
    expect(f.release).not.toHaveBeenCalled()
  })
  it('cleans the hold created after a concurrent zero-dispatch close won', async () => {
    const f = fixture()
    f.dispatch.mockImplementation(async () => { f.execution.state = 'failed'; throw new Error('CAS lost') })
    await expect(handleInternalRuntimeRoute(f.context)).rejects.toThrow('CAS lost')
    expect(f.release).toHaveBeenCalledWith('ws', 'image:key')
  })
  it.each(['provider_dispatching', 'provider_started', 'outcome_unknown'])('never releases a concurrent %s winner', async state => {
    const f = fixture()
    f.dispatch.mockImplementation(async () => { f.execution.state = state; throw new Error('CAS lost') })
    await expect(handleInternalRuntimeRoute(f.context)).rejects.toThrow('CAS lost')
    expect(f.release).not.toHaveBeenCalled()
  })
})


import { MemoryModelUsageRepository } from '../../../packages/persistence/src/model-usage-repository.js'
it('execution fence prevents real repository released-budget reactivation for a terminal job', async () => {
  const repository = new MemoryModelUsageRepository()
  const input = { workspaceId: 'ws', reservationKey: 'image:key', runKey: 'image:key', modality: 'image' as const, model: 'image-test', estimateCny: 0.2, estimateVersion: 'v1', dailyLimitCny: 20, runLimitCny: 1 }
  await repository.reserveDailyBudget(input)
  await repository.releaseDailyBudget({ workspaceId: 'ws', reservationKey: 'image:key' })
  // Prove the storage behavior rather than assuming reserve returns released.
  expect((await repository.reserveDailyBudget(input)).reservation.status).toBe('active')
  await repository.releaseDailyBudget({ workspaceId: 'ws', reservationKey: 'image:key' })
  const f = fixture(); f.execution.state = 'failed'
  f.reserve.mockImplementation(() => repository.reserveDailyBudget(input))
  await expect(handleInternalRuntimeRoute(f.context)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
  expect(f.reserve).not.toHaveBeenCalled()
})

it('a signed worker terminal replay reports cleanup-only without pretending to own the cleared lease', async () => {
  const f = fixture(); f.execution.state = 'failed'; f.execution.ownerToken = ''
  f.context.body = async () => ({ operation: 'fail_before_provider', event_id: 'evt', owner_token: 'different-worker-owner', error_code: 'AUTHZ_DENIED', error_message: 'denied' })
  await handleInternalRuntimeRoute(f.context)
  expect(f.close).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledWith('ws', 'image:key')
  expect(f.context.send).toHaveBeenCalledWith(f.context.res, 200, 'ws', expect.objectContaining({ already_closed: true, budget_cleanup_only: true }), null, f.context.req)
})
