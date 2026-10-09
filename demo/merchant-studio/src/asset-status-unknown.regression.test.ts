import { describe, expect, it } from 'vitest'
import { resolveAssetPrimaryAction, resolveAssetPrimaryStatus, resolveAssetSecondaryStatus } from './asset-status.js'
import type { AssetMetadata } from './api'

const unknownAsset = { id: 'asset-unknown', name: '商品素材.png', mimeType: 'image/png', sizeBytes: 12, scanStatus: 'future_scan_state', rightsStatus: 'approved', parseStatus: 'succeeded', factsConfirmedBy: 'merchant-1', references: [], revision: 1, createdAt: '2026-10-09T00:00:00.000Z', display: { primaryStatus: 'ready', label: 'ready', sourceState: 'ready', reasons: [], nextAction: null } } as unknown as AssetMetadata

describe('unknown merchant asset scan status', () => {
  it('asks the merchant to verify and refresh rather than claiming scanning is in progress', () => {
    expect(resolveAssetPrimaryStatus(unknownAsset)).toMatchObject({ key: 'unknown', label: '安全状态待核实', action: 'refresh', tone: 'amber' })
    expect(resolveAssetPrimaryAction(unknownAsset)).toMatchObject({ kind: 'refresh', label: '刷新状态' })
    expect(resolveAssetSecondaryStatus(unknownAsset)).toContain('扫描状态待核实')
  })
})
