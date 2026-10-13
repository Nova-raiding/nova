import { describe, expect, it } from 'vitest'
import type { AssetMetadata, ImageGenerationJob, MerchantService } from '../../../packages/application/src/service.js'
import { assetDisplayProjection, publicImageJob } from './image-projections.js'

function restrictedAsset(rightsScope: 'internal_only' | 'limited_use'): AssetMetadata {
  return {
    id: 'asset-rights-projection', workspaceId: 'ws-rights-projection', name: 'fixture.png', mimeType: 'image/png',
    sizeBytes: 1, sha256: 'a'.repeat(64), storageKey: 'clean/ws-rights-projection/fixture.png',
    scanStatus: 'clean', scanVerdict: 'clean', scanReceiptId: 'receipt-1', scanReceiptDigest: 'b'.repeat(64),
    parseStatus: 'succeeded', rightsStatus: 'approved', rightsScope,
    contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true },
    references: [{ name: 'fixture.png', mimeType: 'image/png', firstSeenAt: '2026-10-10T00:00:00.000Z' }],
    createdAt: '2026-10-10T00:00:00.000Z', revision: 1,
  }
}

describe('assetDisplayProjection', () => {
  it.each(['internal_only', 'limited_use'] as const)('keeps rights correction reachable for approved %s assets', (scope) => {
    expect(assetDisplayProjection(restrictedAsset(scope), false).nextAction).toEqual({
      method: 'asset.rights.update', label: '调整权益范围', allowed: true,
    })
  })
})

describe('publicImageJob output variant', () => {
  const assets = new Map() as MerchantService['assets']
  const base = { id: 'image-job', workspaceId: 'ws', productId: 'product', revision: 1, state: 'queued', idempotencyKey: 'key', direction: '产品视觉', imageMode: 'create', count: 1, sourceProductVersion: 1, intentHash: 'hash', artifactRole: 'candidate', archiveState: 'pending', createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', outputs: [] } as unknown as ImageGenerationJob

  it('preserves long-detail semantics for ChatGPT result rendering without requiring main-image selection', () => {
    const projected = publicImageJob({ ...base, visualBrief: { size: '1024x4096', detailSections: ['价值主张'] } } as ImageGenerationJob, assets)
    expect(projected).toMatchObject({ outputVariant: 'detail_long', selectionRequired: false })
  })

  it('preserves secondary gallery semantics when the visual brief has detail sections', () => {
    const projected = publicImageJob({ ...base, visualBrief: { size: '1024x1024', detailSections: ['独立详情页卖点'], outputVariant: 'secondary' } } as ImageGenerationJob, assets)
    expect(projected).toMatchObject({ outputVariant: 'secondary', selectionRequired: false })
  })

  it('preserves banner semantics without main-image selection', () => {
    const projected = publicImageJob({ ...base, visualBrief: { size: '1536x1024', outputVariant: 'banner' } } as ImageGenerationJob, assets)
    expect(projected).toMatchObject({ outputVariant: 'banner', selectionRequired: false })
  })

  it('keeps ordinary product images on the existing main-image selection flow', () => {
    const projected = publicImageJob({ ...base, visualBrief: { size: '1024x1024' } } as ImageGenerationJob, assets)
    expect(projected).toMatchObject({ outputVariant: 'main_image', selectionRequired: true })
  })
})
