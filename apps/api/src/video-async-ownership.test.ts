import { createHash } from 'node:crypto'
import { handleMultimodalMcpMethod } from './mcp-multimodal-handlers.js'
import { DomainError } from '../../../packages/application/src/service.js'
import type { MultimodalMcpRuntime } from './server.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryOutbox, type OutboxRepository } from '../../../packages/persistence/src/repository.js'
const provider = vi.hoisted(() => ({ posts: 0, budgetFailure: false, preflightFailure: false }))
vi.mock('./model-budget-runtime.js', async original => ({ ...await original<typeof import('./model-budget-runtime.js')>(), createModelBudgetRuntime: () => ({ reserveDailyModelBudget: async () => {}, releaseDailyModelBudget: async () => {}, withDailyModelBudget: async (_kind: unknown, _context: unknown, invoke: () => Promise<unknown>) => { if (provider.budgetFailure) throw Object.assign(new Error('budget refused'), { code: 'MODEL_DAILY_COST_BUDGET_EXCEEDED' }); return invoke() } }) }))
vi.mock('../../../packages/ai/src/video-generator.js', async original => {
  const real = await original<typeof import('../../../packages/ai/src/video-generator.js')>()
  return { ...real, createVideoGeneratorFromEnv: () => new real.OpenAICompatibleVideoGenerator({ baseUrl: 'https://relay.example', apiKey: 'test-only', model: 'video-model', imageModel: 'video-image-model', beforeRequest: async () => { if (provider.preflightFailure) throw Object.assign(new Error('preflight refused'), { code: 'MODEL_QUOTA_UNAVAILABLE' }) }, usageSink: () => ({ recorded: true, costEvidence: true }), fetch: async () => { provider.posts += 1; return new Response(JSON.stringify({ id: `job-${provider.posts}`, status: 'queued' }), { headers: { 'x-request-id': `generation-${provider.posts}` } }) } }) }
})
import { evaluateStoryboardBeforeRendering, assertVideoProviderJobScope, generateOwnedVideo, withOwnedVideoAction, modelSettlementDomainError, setFailedImageReconciliationPersistenceForTests } from './server.js'
let restore: (() => void) | undefined
const input = (actionId: string) => ({ prompt: 'test', output: 'rendering' as const, context: {}, usageContext: { workspaceId: 'video-workspace', actionId, runKey: actionId } })
const ownedGenerate = (value: ReturnType<typeof input>) => withOwnedVideoAction(value.usageContext.workspaceId, value.usageContext.actionId, value, beforeDispatch => generateOwnedVideo({ ...value, beforeDispatch }), providerJobId => ({ status: 'queued' as const, providerJobId, settlementStatus: 'pending_receipt' as const }))
afterEach(() => { vi.unstubAllEnvs(); restore?.(); provider.posts = 0; provider.budgetFailure = false; provider.preflightFailure = false })
function install(store = new InMemoryOutbox()) {
  // Exercise the same durable repository interface; reuse the existing narrow injection seam.
  restore = setFailedImageReconciliationPersistenceForTests({ outbox: store as unknown as OutboxRepository })
  return store
}
describe('durable accepted video ownership', () => {
  it.each(['multimodal.video.request', 'multimodal.generate'])('%s cleans its owned reservation when preparation fails before provider dispatch', async method => {
    const store = install(); const order: string[] = []; let observations = 0
    const context = { brand: { id: 'brand', version: '1' }, product: { id: 'product', version: '1' }, rules: [{ id: 'rule', version: '1' }] }
    const reservation = { id: 'reservation', requestOwnsReservation: true }
    const append = store.append.bind(store)
    vi.spyOn(store, 'append').mockImplementation(event => { if (event.eventType === 'multimodal.video.preflight_rejected') order.push('rejected'); return append(event) })
    const prepareFailure = new Error('injected preparation failure')
    const dependencies = {
      workspaceId: 'video-workspace', req: {}, result: (value: unknown) => value, required: (params: Record<string, unknown>, key: string) => String(params[key]), DomainError, ERROR_CODES: { INVALID_REQUEST: 'INVALID_REQUEST' },
      service: { products: new Map() }, enforceProductBrandAccess: async () => {}, canonicalProductReadControl: async () => ({ mode: 'legacy' }),
      observeLegacyWalletShadow: async () => { observations++; if (method === 'multimodal.generate' && observations === 2) throw prepareFailure },
      header: () => undefined, isProduction: () => false, generationRulePreflight: async () => ({ blocking: false }), requireRuleSafeGenerationText: () => {}, evaluateStoryboardBeforeRendering: () => ({}), requireVideoModelCostPreflight: async () => {}, enforceMcpCommercialAccess: async () => ({}),
      createVideoRenderingRequest: (value: object) => ({ ok: true, value: { ...value, output: 'rendering' } }), createOneSentenceGenerationRequest: (value: object) => ({ ok: true, value }), createHash,
      reserveCreativePointsForModel: async () => { order.push('reserve'); return reservation }, recordActionSettlement: async () => { throw prepareFailure }, requestActor: () => 'actor',
      releaseReservedModelPoints: async (_workspace: string, _action: string, _reason: string, owner: unknown) => { expect(owner).toBe(reservation); order.push('release') }, refundPluginWalletDebit: async () => { order.push('refund') }, providerSucceededButSettlementPending: (error: { reconciliationRequired?: boolean }) => error?.reconciliationRequired === true,
      withOwnedVideoAction, generateOwnedVideo, videoGenerator: { generate: vi.fn() },
    } as unknown as MultimodalMcpRuntime
    await expect(handleMultimodalMcpMethod(method, { prompt: 'test', output: 'rendering', modality: 'video', context_json: JSON.stringify(context), idempotency_key: 'prepare-failure' }, dependencies)).rejects.toThrow('injected preparation failure')
    expect(order).toEqual(['reserve', 'release', 'refund', 'rejected'])
    expect(provider.posts).toBe(0)
  })

  it.each(['multimodal.video.request', 'multimodal.generate'])('%s losers cannot enter reservation, preflight or cleanup callbacks', async method => {
    install()
    let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    let finish!: () => void; const finishPromise = new Promise<void>(resolve => { finish = resolve })
    const loserBusiness = vi.fn(async () => { throw new Error('loser preflight must never execute') })
    const first = withOwnedVideoAction('video-workspace', method, { method }, async beforeDispatch => { await beforeDispatch(); entered(); await finishPromise; return 'accepted' }, () => 'replayed')
    await enteredPromise
    await expect(withOwnedVideoAction('video-workspace', method, { method }, loserBusiness, () => 'replayed')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' })
    expect(loserBusiness).not.toHaveBeenCalled()
    finish(); expect(await first).toBe('accepted')
  })
  it('records a rejected preflight only after owner cleanup and preserves ambiguous cleanup', async () => {
    const store = install(); let cleaned = false
    const append = store.append.bind(store)
    vi.spyOn(store, 'append').mockImplementation(event => {
      if (event.eventType === 'multimodal.video.preflight_rejected') expect(cleaned).toBe(true)
      return append(event)
    })
    await expect(withOwnedVideoAction('video-workspace', 'cleanup-complete', {}, async () => { cleaned = true; throw new Error('known refusal after cleanup') }, () => '')).rejects.toThrow('known refusal')
    await expect(withOwnedVideoAction('video-workspace', 'cleanup-unknown', {}, async () => { throw Object.assign(new Error('cleanup uncertain'), { reconciliationRequired: true }) }, () => '')).rejects.toThrow('cleanup uncertain')
    const rejected = store.listWorkspaceEvents('video-workspace').filter(event => event.eventType === 'multimodal.video.preflight_rejected')
    expect(rejected).toHaveLength(1)
  })

  it.each(['budgetFailure', 'preflightFailure'] as const)('a deterministic %s records no dispatch and explicitly requires a new action', async failure => {
    const store = install(); provider[failure] = true
    await expect(ownedGenerate(input(`video:${failure}`))).rejects.toThrow('refused')
    expect(provider.posts).toBe(0)
    expect(store.listWorkspaceEvents('video-workspace').map(event => event.eventType).sort()).toEqual(['multimodal.video.preparation_claimed', 'multimodal.video.preflight_rejected'].sort())
    provider[failure] = false
    await expect(ownedGenerate(input(`video:${failure}`))).rejects.toMatchObject({ code: 'VIDEO_PREFLIGHT_REJECTED', details: { provider_dispatched: false, requires_new_idempotency_key: true } })
    await expect(ownedGenerate(input(`video:${failure}:new-key`))).resolves.toMatchObject({ providerJobId: 'job-1', settlementStatus: 'pending_receipt' })
    expect(provider.posts).toBe(1)
  })

  it('concurrent identical actions dispatch once and retain server-owned scope', async () => {
    const store = install()
    const results = await Promise.allSettled([ownedGenerate(input('video:concurrent')), ownedGenerate(input('video:concurrent'))])
    expect(provider.posts).toBe(1)
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(await ownedGenerate(input('video:concurrent'))).toMatchObject({ providerJobId: 'job-1', status: 'queued', settlementStatus: 'pending_receipt' })
    expect(provider.posts).toBe(1)
    await expect(ownedGenerate({ ...input('video:concurrent'), prompt: 'different intent' })).rejects.toMatchObject({ code: 'VIDEO_IDEMPOTENCY_CONFLICT' })
    // Replace repository facade; ownership is recovered from stored rows, not a process map.
    restore?.(); install(store)
    expect(await assertVideoProviderJobScope('video-workspace', 'job-1')).toMatchObject({ workspaceId: 'video-workspace', actionId: 'video:concurrent', runKey: 'video:concurrent', providerRequestId: 'generation-1' })
    await expect(assertVideoProviderJobScope('other-workspace', 'job-1')).rejects.toMatchObject({ code: 'VIDEO_PROVIDER_SCOPE_DENIED' })
  })
  it('failure writing replay pointer preserves owned job and never submits again', async () => {
    const store = install(); const append = store.append.bind(store)
    vi.spyOn(store, 'append').mockImplementation(value => {
      if (value.eventType === 'multimodal.video.accepted' && value.sequence === 3) throw new Error('pointer write failed')
      return append(value)
    })
    await expect(ownedGenerate(input('video:partial'))).rejects.toMatchObject({ providerSucceeded: true, reconciliationRequired: true, providerJobId: 'job-1' })
    expect(await assertVideoProviderJobScope('video-workspace', 'job-1')).toMatchObject({ actionId: 'video:partial' })
    await expect(ownedGenerate(input('video:partial'))).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' })
    expect(provider.posts).toBe(1)
  })
  it('accepted authority write failure keeps dispatch claim and forbids another submit', async () => {
    const store = install(); const append = store.append.bind(store)
    vi.spyOn(store, 'append').mockImplementation(value => {
      if (value.eventType === 'multimodal.video.accepted') throw new Error('authority write failed')
      return append(value)
    })
    const failure = await ownedGenerate(input('video:authority-failure')).catch(error => error)
    expect(modelSettlementDomainError(failure)).toMatchObject({ code: 'MODEL_VIDEO_CONTEXT_PENDING', details: { provider_job_id: 'job-1', action_id: 'video:authority-failure', run_key: 'video:authority-failure', retryable: false } })
    await expect(assertVideoProviderJobScope('video-workspace', 'job-1')).rejects.toMatchObject({ code: 'VIDEO_PROVIDER_SCOPE_DENIED' })
    await expect(ownedGenerate(input('video:authority-failure'))).rejects.toMatchObject({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' })
    expect(provider.posts).toBe(1)
  })
})

function candidateEvidence() {
  return { platform: 'taobao', platformCapability: { state: 'official_document', specification: { maxFileBytes: 100 } }, reviewAt: '2026-10-05T00:00:00Z', durationSeconds: 5, aspectRatio: '1:1', resolution: { width: 512, height: 512 }, fps: 24,
    scenes: [{ id: 'scene', startSeconds: 0, endSeconds: 5, visual: '原创商品静物展示', productIds: ['product'], skuIds: ['sku'], claims: [] }],
    cover: { assetId: 'asset', productIds: ['product'], skuIds: ['sku'], factSourceIds: ['asset://original'], rights: { status: 'approved', evidenceRef: 'asset://original-rights' } },
    output: { container: 'mp4', videoCodec: 'h264' }, completionEvidence: {}, provenance: 'manual' }
}
function candidateRuntime() {
  const archive = vi.fn(async (_workspace: string, rendering: object) => rendering)
  const runtime = {
    workspaceId: 'video-workspace', req: {}, result: (value: unknown) => value, required: (params: Record<string, unknown>, key: string) => String(params[key]), DomainError, ERROR_CODES: { INVALID_REQUEST: 'INVALID_REQUEST' },
    service: { products: new Map([['product', { id: 'product', workspaceId: 'video-workspace', platform: 'taobao', sourceAssetIds: ['asset'] }]]) },
    isExemptUnboundImageCandidateProduct: async () => true, enforceAssetAccess: async () => {}, requireApprovedAssetForImageGeneration: () => {},
    assetForWorkspace: () => ({ id: 'asset', mimeType: 'image/png', storageKey: 'test-image', scanStatus: 'clean' }), getStoredObjectWithRetry: async () => ({ body: Buffer.from('original-test-image') }),
    enforceProductBrandAccess: async () => {}, canonicalProductReadControl: async () => ({ mode: 'legacy' }), observeLegacyWalletShadow: async () => {},
    header: () => undefined, isProduction: () => false, generationRulePreflight: async () => ({ blocking: false }), requireRuleSafeGenerationText: () => {}, evaluateStoryboardBeforeRendering, requireVideoModelCostPreflight: async () => {}, enforceMcpCommercialAccess: async () => ({}),
    createVideoRenderingRequest: (value: object) => ({ ok: true, value: { ...value, output: 'rendering' } }), createOneSentenceGenerationRequest: (value: object) => ({ ok: true, value }), createHash,
    reserveCreativePointsForModel: async () => null, recordActionSettlement: async () => {}, requestActor: () => 'actor', executionContract: () => ({ providerExecuted: true }), randomUUID: () => 'candidate-event', persistEvent: async () => {},
    releaseReservedModelPoints: async () => {}, refundPluginWalletDebit: async () => {}, providerSucceededButSettlementPending: () => false,
    withOwnedVideoAction, generateOwnedVideo, assertVideoProviderJobScope, archiveCompletedVideo: archive, modelSettlementDomainError,
    videoGenerator: { generate: vi.fn(), getStatus: vi.fn(async () => ({ status: 'queued', settlementStatus: 'pending_receipt' })) },
  } as unknown as MultimodalMcpRuntime
  return { runtime, archive }
}
function candidateParams(evidence: unknown = candidateEvidence()) {
  return { prompt: '原创内部候选', output: 'rendering', modality: 'video', idempotency_key: 'internal-candidate', context_json: JSON.stringify({ candidateOnly: true, brand: null, product: { id: 'product', version: '1' }, rules: [], storyboardQuality: evidence }) }
}
describe('server-authorized internal candidate rendering', () => {
  it('retains unpublished status through accepted replay, repository reload, pending GET and archived GET', async () => {
    const store = install(); vi.stubEnv('REQUIRE_PLATFORM_GOVERNANCE_GATES', 'true')
    const { runtime, archive } = candidateRuntime()
    const first = await handleMultimodalMcpMethod('multimodal.video.request', candidateParams(), runtime)
    expect(first).toMatchObject({ candidate_only: true, publishable: false, storyboard_quality: { renderReady: true, externallyUnverified: true, publishable: false } })
    expect(provider.posts).toBe(1)
    expect(await handleMultimodalMcpMethod('multimodal.video.request', candidateParams(), runtime)).toMatchObject({ candidate_only: true, publishable: false })
    expect(provider.posts).toBe(1)
    restore?.(); install(store)
    expect(await assertVideoProviderJobScope('video-workspace', 'job-1')).toMatchObject({ candidateOnly: true, publishable: false })
    archive.mockClear()
    expect(await handleMultimodalMcpMethod('multimodal.video.get', { provider_job_id: 'job-1' }, runtime)).toMatchObject({ candidate_only: true, publishable: false, settlement_status: 'pending_receipt' })
    expect(archive).not.toHaveBeenCalled()
    vi.mocked(runtime.videoGenerator!.getStatus).mockResolvedValue({ status: 'completed', settlementStatus: 'settled', providerJobId: 'job-1', videoUrl: 'https://relay.example/result.mp4' })
    archive.mockResolvedValue({ status: 'completed', settlementStatus: 'settled', assetId: 'archive-asset', archiveState: 'archived' })
    expect(await handleMultimodalMcpMethod('multimodal.video.get', { provider_job_id: 'job-1' }, runtime)).toMatchObject({ candidate_only: true, publishable: false, asset_id: 'archive-asset' })
  })
  it('requires explicit storyboard evidence with governance enabled and never upgrades default platform rendering', async () => {
    install(); vi.stubEnv('REQUIRE_PLATFORM_GOVERNANCE_GATES', 'true')
    const { runtime } = candidateRuntime()
    const params = candidateParams(null)
    await expect(handleMultimodalMcpMethod('multimodal.video.request', params, runtime)).rejects.toMatchObject({ code: 'VIDEO_STORYBOARD_QUALITY_REQUIRED' })
    const context = JSON.parse(candidateParams().context_json)
    expect(() => evaluateStoryboardBeforeRendering(context)).toThrow(DomainError)
    expect(provider.posts).toBe(0)
  })
  it.each(['bound', 'foreign', 'asset_denied', 'rights', 'malformed', 'other_entry'] as const)('blocks %s without provider dispatch', async failure => {
    install(); vi.stubEnv('REQUIRE_PLATFORM_GOVERNANCE_GATES', 'true')
    const { runtime } = candidateRuntime()
    const evidence = candidateEvidence()
    if (failure === 'bound') runtime.isExemptUnboundImageCandidateProduct = async () => false
    if (failure === 'foreign') runtime.service.products.get('product')!.workspaceId = 'other-workspace'
    if (failure === 'asset_denied') runtime.enforceAssetAccess = async () => { throw new DomainError('PERMISSION_DENIED', 'denied', 403) }
    if (failure === 'rights') evidence.cover.rights.status = 'denied'
    if (failure === 'malformed') evidence.durationSeconds = -1
    await expect(handleMultimodalMcpMethod(failure === 'other_entry' ? 'multimodal.generate' : 'multimodal.video.request', candidateParams(evidence), runtime)).rejects.toMatchObject({ code: ['bound', 'foreign'].includes(failure) ? 'VIDEO_CANDIDATE_SOURCE_REQUIRED' : failure === 'asset_denied' ? 'PERMISSION_DENIED' : 'VIDEO_STORYBOARD_QUALITY_BLOCKED' })
    expect(provider.posts).toBe(0)
  })
})
