import { describe, expect, it, vi } from 'vitest'
import { handleMultimodalMcpMethod } from './mcp-multimodal-handlers.js'
import { DomainError } from '../../../packages/application/src/service.js'
import type { MultimodalMcpRuntime } from './server.js'

describe('video.get settlement delivery boundary', () => {
  function runtime() {
    const context = { workspaceId: 'workspace-a', actionId: 'video:a', runKey: 'run:a', providerJobId: 'job-a', model: 'video-model', providerRequestId: 'generation-a' }
    const getStatus = vi.fn(async () => ({ status: 'queued', providerJobId: 'job-a', settlementStatus: 'pending_receipt', videoUrl: undefined as string | undefined }))
    const archive = vi.fn(async (workspaceId: string, value: unknown) => ({ ...(value as object), assetId: `${workspaceId}-asset`, archiveState: 'archived', status: 'completed' as const }))
    const persistEvent = vi.fn()
    const scope = vi.fn(async () => context)
    const nextEventSequence = vi.fn(async () => 1)
    const dependencies = { workspaceId: 'workspace-a', result: (value: unknown) => value, required: (params: Record<string, unknown>, key: string) => String(params[key]), DomainError, videoGenerator: { getStatus }, assertVideoProviderJobScope: scope, archiveCompletedVideo: archive, persistEvent, nextEventSequence, executionContract: () => ({ providerExecuted: true }), modelSettlementDomainError: () => new DomainError('MODEL_USAGE_SETTLEMENT_PENDING', 'pending', 503), service: { findAssetBySourceProviderJobId: () => ({ id: 'cached-unsettled-asset' }) } } as unknown as MultimodalMcpRuntime
    return { dependencies, context, getStatus, archive, persistEvent, scope }
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
})
