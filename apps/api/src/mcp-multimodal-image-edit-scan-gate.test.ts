import { describe, expect, it, vi } from 'vitest'
import { handleMultimodalMcpMethod } from './mcp-multimodal-handlers.js'
import { DomainError } from '../../../packages/application/src/service.js'
import type { MultimodalMcpRuntime } from './server.js'

function runtime(scanClean: boolean) {
  const rawProviderImage = 'data:image/png;base64,provider-output-before-scan'
  const archived = {
    id: 'edit-job-1', workspaceId: 'workspace-a', productId: 'product-a', revision: 2,
    archiveState: scanClean ? 'archived' : 'pending',
    outputs: [{ visualRef: 'visual-a', assetId: 'asset-generated-a' }],
  }
  const readArchivedGeneratedImages = vi.fn(async () => ['data:image/png;base64,verified-archived-output'])
  const req = {
    aborted: false,
    complete: true,
    socket: { destroyed: false },
    once() { return this },
    removeListener() { return this },
  }
  const dependencies = {
    req,
    workspaceId: 'workspace-a',
    result: (value: unknown) => value,
    observeLegacyWalletShadow: vi.fn(async () => undefined),
    required: () => '{}',
    DomainError,
    ERROR_CODES: { INVALID_REQUEST: 'INVALID_REQUEST' },
    createImageEditCandidate: () => ({ ok: true, value: {
      id: 'edit-1', prompt: '优化背景并保留商品结构', sourceImageId: 'asset-source',
      region: { rect: { x: 0, y: 0, width: 1, height: 1 } },
      context: { product: { id: 'product-a' } },
    } }),
    requireProtectedProductIntent: () => ({ ok: true }),
    protectedProductConclusion: () => ({ protected: true }),
    assetForWorkspace: () => ({ id: 'asset-source', mimeType: 'image/png', scanStatus: 'clean', rightsStatus: 'approved', rightsScope: 'owned', aiModificationAllowed: true, usageScopes: ['commercial'], storageKey: 'source/key' }),
    isUsableAssetWithoutScan: () => true,
    demoUnscannedAssetsEnabled: () => false,
    getStoredObjectWithRetry: vi.fn(async () => ({ body: new Uint8Array([1]), metadata: { contentType: 'image/png' } })),
    service: {
      products: new Map([['product-a', { id: 'product-a', workspaceId: 'workspace-a', platform: 'taobao', factsConfirmed: true }]]),
      enqueueImageGeneration: () => ({ id: 'edit-job-1', state: 'queued' }),
    },
    canonicalProductReadControl: async () => ({ mode: 'legacy_read' }),
    requireGenerationRulePreflight: async () => ({}),
    requireRuleSafeGenerationText: () => undefined,
    enforceMcpCommercialAccess: async () => ({}),
    requirePlatformModelCostGate: () => undefined,
    reserveCreativePointsForModel: async () => null,
    requestActor: () => 'actor-a',
    refundPluginWalletDebit: vi.fn(async () => undefined),
    persistEvent: vi.fn(async () => undefined),
    isProduction: () => true,
    executionContract: () => ({ providerExecuted: true }),
    imageEditGenerator: { generate: vi.fn(async () => [rawProviderImage]) },
    appendProtectedProductConstraints: (prompt: string) => prompt,
    archiveGeneratedImages: vi.fn(async () => archived),
    persistSnapshot: vi.fn(async () => undefined),
    providerSucceededButSettlementPending: () => false,
    releaseReservedModelPoints: vi.fn(async () => undefined),
    imageJobOutputsAreClean: vi.fn(() => scanClean),
    readArchivedGeneratedImages,
    publicImageJob: () => ({ id: 'edit-job-1' }),
  } as unknown as MultimodalMcpRuntime
  return { dependencies, rawProviderImage, readArchivedGeneratedImages }
}

describe('multimodal.image.edit scan response gate', () => {
  it('does not return raw provider output while its archived candidate is still quarantined', async () => {
    const f = runtime(false)
    const result = await handleMultimodalMcpMethod('multimodal.image.edit', {}, f.dependencies) as { images: string[] }
    expect(result.images).toEqual([])
    expect(JSON.stringify(result)).not.toContain(f.rawProviderImage)
    expect(f.readArchivedGeneratedImages).not.toHaveBeenCalled()
  })

  it('returns only the archived readback after the candidate is scan-clean', async () => {
    const f = runtime(true)
    const result = await handleMultimodalMcpMethod('multimodal.image.edit', {}, f.dependencies) as { images: string[] }
    expect(result.images).toEqual(['data:image/png;base64,verified-archived-output'])
    expect(JSON.stringify(result)).not.toContain(f.rawProviderImage)
    expect(f.readArchivedGeneratedImages).toHaveBeenCalledTimes(1)
  })
})
