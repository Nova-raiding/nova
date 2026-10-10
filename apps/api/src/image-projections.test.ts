import { describe, expect, it } from 'vitest'
import type { AssetMetadata } from '../../../packages/application/src/service.js'
import { assetDisplayProjection } from './image-projections.js'

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
