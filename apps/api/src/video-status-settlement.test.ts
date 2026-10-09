import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { handleMultimodalMcpMethod, publicVideoRenderingResult } from './mcp-multimodal-handlers.js'
import { DomainError } from '../../../packages/application/src/service.js'
import type { MultimodalMcpRuntime } from './server.js'

describe('video.get settlement delivery boundary', () => {
  it.each([
    ['clean', { scan_status: 'clean', download_path: '/v1/assets/asset-generic/download' }, undefined],
    ['pending', { scan_status: 'pending' }, '视频扫描尚未确认通过'],
  ] as const)('multimodal.generate exposes normalized %s archive readiness', async (scanStatus, expected, warning) => {
    const product = { id: 'product-a', workspaceId: 'workspace-a' }
    const dependencies = {
      workspaceId: 'workspace-a', req: {}, result: (value: unknown) => value,
      required: (params: Record<string, unknown>, key: string) => String(params[key]),
      DomainError, ERROR_CODES: { INVALID_REQUEST: 'INVALID_REQUEST' },
      service: { products: new Map([[product.id, product]]) },
      enforceProductBrandAccess: vi.fn(async () => {}), canonicalProductReadControl: vi.fn(async () => ({ mode: 'legacy' })),
      observeLegacyWalletShadow: vi.fn(async () => {}), generationRulePreflight: vi.fn(async () => ({ blocking: false })),
      requireRuleSafeGenerationText: vi.fn(), requireVideoModelCostPreflight: vi.fn(async () => {}),
      evaluateStoryboardBeforeRendering: vi.fn(() => ({})), enforceMcpCommercialAccess: vi.fn(async () => ({})),
      createOneSentenceGenerationRequest: (value: object) => ({ ok: true, value: { ...(value as object), modality: 'video', output: 'rendering' } }),
      createHash,
      reserveCreativePointsForModel: vi.fn(async () => null),
      videoGenerator: { generate: vi.fn(async () => ({ status: 'completed', providerJobId: 'job-generic', videoUrl: 'https://relay.example/private.mp4' })) },
      generateOwnedVideo: vi.fn(async () => ({ status: 'completed', providerJobId: 'job-generic', videoUrl: 'https://relay.example/private.mp4' })),
      archiveCompletedVideo: vi.fn(async () => ({ status: 'completed', providerJobId: 'job-generic', videoUrl: 'https://relay.example/private.mp4', assetId: 'asset-generic', archiveState: 'archived' })),
      withOwnedVideoAction: async (_workspaceId: string, _actionId: string, _request: unknown, execute: (beforeDispatch?: () => Promise<void>) => Promise<unknown>) => execute(async () => {}),
      assetForWorkspace: vi.fn(() => ({ scanStatus })),
      requestActor: () => 'actor-a', releaseReservedModelPoints: vi.fn(async () => {}), refundPluginWalletDebit: vi.fn(async () => {}),
      providerSucceededButSettlementPending: () => false, executionContract: () => ({ providerExecuted: true }),
      persistEvent: vi.fn(async () => {}), randomUUID: () => 'event-a',
    } as unknown as MultimodalMcpRuntime

    const response = await handleMultimodalMcpMethod('multimodal.generate', {
      modality: 'video', output: 'rendering', prompt: '商品展示', context_json: JSON.stringify({ brand: { id: 'brand-a', version: '1' }, product: { id: product.id, version: '1' }, rules: [{ id: 'rule-a', version: '1' }] }),
    }, dependencies) as Record<string, unknown>
    expect(response).toMatchObject({ asset_id: 'asset-generic', archive_state: 'archived', ...expected })
    if (warning) expect(response.availability_warning).toContain(warning)
    else expect(response).not.toHaveProperty('availability_warning')
    expect(response).not.toHaveProperty('rendering.videoUrl')
    expect(dependencies.videoGenerator!.generate).not.toHaveBeenCalled()
    expect(dependencies.generateOwnedVideo).toHaveBeenCalledTimes(1)
  })

  it('exposes archive and scan readiness on generic multimodal rendering without leaking the relay URL', () => {
    const clean = publicVideoRenderingResult('workspace-a', { status: 'completed', providerJobId: 'job-a', videoUrl: 'https://relay.example/private.mp4', assetId: 'asset-a', archiveState: 'archived' }, () => ({ scanStatus: 'clean' }))
    expect(clean).toMatchObject({ asset_id: 'asset-a', archive_state: 'archived', scan_status: 'clean', download_path: '/v1/assets/asset-a/download', rendering: { status: 'completed', assetId: 'asset-a' } })
    expect(clean).not.toHaveProperty('rendering.videoUrl')

    const quarantined = publicVideoRenderingResult('workspace-a', { status: 'completed', providerJobId: 'job-b', videoUrl: 'https://relay.example/private.mp4', assetId: 'asset-b', archiveState: 'archived' }, () => ({ scanStatus: 'pending' }))
    expect(quarantined).toMatchObject({ availability_warning: expect.stringContaining('扫描尚未确认通过') })
    expect(quarantined).not.toHaveProperty('download_path')
  })

  function runtime() {
    const context = { workspaceId: 'workspace-a', actionId: 'video:a', runKey: 'run:a', providerJobId: 'job-a', model: 'video-model', providerRequestId: 'generation-a' }
    const getStatus = vi.fn(async () => ({ status: 'queued', providerJobId: 'job-a', settlementStatus: 'pending_receipt', videoUrl: undefined as string | undefined }))
    const archive = vi.fn(async (workspaceId: string, value: unknown) => ({ ...(value as object), assetId: `${workspaceId}-asset`, archiveState: 'archived', status: 'completed' as const }))
    const persistEvent = vi.fn()
    const scope = vi.fn(async () => context)
    const nextEventSequence = vi.fn(async () => 1)
    const assetForWorkspace = vi.fn((_workspaceId: string, _assetId: string) => ({ scanStatus: 'clean' }))
    const dependencies = { workspaceId: 'workspace-a', result: (value: unknown) => value, required: (params: Record<string, unknown>, key: string) => String(params[key]), DomainError, videoGenerator: { getStatus }, assertVideoProviderJobScope: scope, archiveCompletedVideo: archive, persistEvent, nextEventSequence, assetForWorkspace, executionContract: () => ({ providerExecuted: true }), modelSettlementDomainError: () => new DomainError('MODEL_USAGE_SETTLEMENT_PENDING', 'pending', 503), service: { findAssetBySourceProviderJobId: () => ({ id: 'cached-unsettled-asset' }) } } as unknown as MultimodalMcpRuntime
    return { dependencies, context, getStatus, archive, persistEvent, scope, assetForWorkspace }
  }
  it('uses server context and returns pending without downloading or returning any asset', async () => {
    const f = runtime()
    const result = await handleMultimodalMcpMethod('multimodal.video.get', { provider_job_id: 'job-a', action_id: 'attacker-action' }, f.dependencies)
    expect(result).toMatchObject({ status: 'queued', settlement_status: 'pending_receipt' })
    expect(result).not.toHaveProperty('asset_id')
    expect(f.getStatus).toHaveBeenCalledWith('job-a', f.context)
    expect(f.archive).not.toHaveBeenCalled(); expect(f.persistEvent).not.toHaveBeenCalled()
  })
  it('does not fall back to a cached asset when current settlement fails', async () => {
    const f = runtime(); f.getStatus.mockRejectedValue(new Error('settlement failed'))
    await expect(handleMultimodalMcpMethod('multimodal.video.get', { provider_job_id: 'job-a' }, f.dependencies)).rejects.toMatchObject({ code: 'MODEL_USAGE_SETTLEMENT_PENDING' })
    expect(f.archive).not.toHaveBeenCalled()
  })
  it('scope denial prevents any provider request', async () => {
    const f = runtime(); f.scope.mockRejectedValue(new DomainError('VIDEO_PROVIDER_SCOPE_DENIED', 'denied', 403))
    await expect(handleMultimodalMcpMethod('multimodal.video.get', { provider_job_id: 'job-a' }, f.dependencies)).rejects.toMatchObject({ code: 'VIDEO_PROVIDER_SCOPE_DENIED' })
    expect(f.getStatus).not.toHaveBeenCalled()
  })
  it('records a definitive provider rejection as a terminal status event', async () => {
    const f = runtime()
    f.getStatus.mockRejectedValue(Object.assign(new Error('provider rejected'), {
      code: 'MODEL_PROVIDER_REQUEST_FAILED',
      details: { provider_outcome: 'failed', provider_status: 422, provider_request_id: 'provider-rejected-1' },
    }))
    ;(f.dependencies as any).modelSettlementDomainError = () => new DomainError('MODEL_PROVIDER_REQUEST_FAILED', 'provider rejected', 502)
    await expect(handleMultimodalMcpMethod('multimodal.video.get', { provider_job_id: 'job-a' }, f.dependencies)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
    expect(f.archive).not.toHaveBeenCalled()
    expect(f.persistEvent).toHaveBeenCalledWith('workspace-a', 'video_job-a', 'multimodal.video_status_observed', 1, expect.objectContaining({
      provider_job_id: 'job-a',
      error_code: 'MODEL_PROVIDER_REQUEST_FAILED',
      provider_status: 422,
      provider_request_id: 'provider-rejected-1',
      rendering: { status: 'failed', providerJobId: 'job-a', settlementStatus: 'settled' },
    }))
  })
  it('archives only after status confirms settlement', async () => {
    const f = runtime(); f.getStatus.mockResolvedValue({ status: 'completed', providerJobId: 'job-a', settlementStatus: 'settled', videoUrl: undefined })
    expect(await handleMultimodalMcpMethod('multimodal.video.get', { provider_job_id: 'job-a' }, f.dependencies)).toMatchObject({ asset_id: 'workspace-a-asset', status: 'completed' })
    expect(f.archive).toHaveBeenCalledTimes(1)
  })

  it('records an archive failure after provider completion so the job is retryable and visible to Ops', async () => {
    const f = runtime()
    f.getStatus.mockResolvedValue({ status: 'completed', settlementStatus: 'settled', providerJobId: 'job-a', videoUrl: 'https://cdn.example/video.mp4' })
    f.archive.mockRejectedValue(new DomainError('VIDEO_ARTIFACT_DOWNLOAD_FAILED', 'archive failed', 502))
    await expect(handleMultimodalMcpMethod('multimodal.video.get', { provider_job_id: 'job-a' }, f.dependencies)).rejects.toMatchObject({ code: 'VIDEO_ARTIFACT_DOWNLOAD_FAILED' })
    expect(f.persistEvent).toHaveBeenCalledWith('workspace-a', 'video_job-a', 'multimodal.video_status_observed', 1, expect.objectContaining({
      provider_job_id: 'job-a',
      error_code: 'VIDEO_ARTIFACT_DOWNLOAD_FAILED',
      rendering: expect.objectContaining({ status: 'completed', archiveState: 'failed' }),
    }))
  })

  it('uses a new event sequence when a later retry archives the same provider job', async () => {
    const f = runtime()
    const nextEventSequence = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    ;(f.dependencies as any).nextEventSequence = nextEventSequence
    f.getStatus.mockResolvedValue({ status: 'completed', settlementStatus: 'settled', providerJobId: 'job-a', videoUrl: 'https://cdn.example/video.mp4' })
    f.archive.mockRejectedValueOnce(new DomainError('VIDEO_ARTIFACT_DOWNLOAD_FAILED', 'archive failed', 502)).mockResolvedValueOnce({ assetId: 'asset-a', archiveState: 'archived', status: 'completed' })
    await expect(handleMultimodalMcpMethod('multimodal.video.get', { provider_job_id: 'job-a' }, f.dependencies)).rejects.toMatchObject({ code: 'VIDEO_ARTIFACT_DOWNLOAD_FAILED' })
    await expect(handleMultimodalMcpMethod('multimodal.video.get', { provider_job_id: 'job-a' }, f.dependencies)).resolves.toMatchObject({ asset_id: 'asset-a' })
    expect(f.persistEvent).toHaveBeenNthCalledWith(2, 'workspace-a', 'video_job-a', 'multimodal.video_status_observed', 2, expect.objectContaining({ rendering: expect.objectContaining({ archiveState: 'archived' }) }))
  })

  it('only reports a scan-eligible delivery as formally complete and marks unscanned demo artifacts', async () => {
    const clean = runtime()
    clean.getStatus.mockResolvedValue({ status: 'completed', settlementStatus: 'settled', providerJobId: 'job-a', videoUrl: undefined })
    expect(await handleMultimodalMcpMethod('multimodal.video.get', { provider_job_id: 'job-a' }, clean.dependencies)).toMatchObject({
      asset_id: 'workspace-a-asset', archive_state: 'archived', scan_status: 'clean', download_path: '/v1/assets/workspace-a-asset/download', status: 'completed',
    })
    const demo = runtime()
    demo.getStatus.mockResolvedValue({ status: 'completed', settlementStatus: 'settled', providerJobId: 'job-a', videoUrl: undefined })
    demo.assetForWorkspace.mockReturnValue({ scanStatus: 'unscanned' })
    const unscanned = await handleMultimodalMcpMethod('multimodal.video.get', { provider_job_id: 'job-a' }, demo.dependencies)
    expect(unscanned).toMatchObject({
      asset_id: 'workspace-a-asset', archive_state: 'archived', scan_status: 'unscanned', availability_warning: expect.stringContaining('演示或未扫描'),
    })
    expect(unscanned).not.toHaveProperty('download_path')
    demo.assetForWorkspace.mockReturnValue({ scanStatus: 'unknown' })
    const unknown = await handleMultimodalMcpMethod('multimodal.video.get', { provider_job_id: 'job-a' }, demo.dependencies)
    expect(unknown).not.toHaveProperty('download_path')
  })

  it('explains that a clean but unarchived video is still unavailable', async () => {
    const f = runtime()
    f.getStatus.mockResolvedValue({ status: 'completed', settlementStatus: 'settled', providerJobId: 'job-a', videoUrl: undefined })
    f.archive.mockResolvedValue({ assetId: 'workspace-a-asset', archiveState: 'pending', status: 'completed' } as never)
    const result = await handleMultimodalMcpMethod('multimodal.video.get', { provider_job_id: 'job-a' }, f.dependencies)
    expect(result).toMatchObject({ scan_status: 'clean', availability_warning: expect.stringContaining('尚未完成归档') })
    expect(result).not.toHaveProperty('download_path')
  })
})
