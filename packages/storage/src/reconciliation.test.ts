import { describe, expect, it } from 'vitest'
import { reconcileObjectInventory } from './reconciliation.js'

const ref = (storageKey: string, sizeBytes = 4) => ({ workspaceId: 'ws_a', assetId: storageKey.split('/').at(-2) ?? 'asset', storageKey, sha256: 'a'.repeat(64), sizeBytes })
const object = (storageKey: string, sizeBytes = 4) => ({ workspaceId: 'ws_a', storageKey, sha256: 'a'.repeat(64), sizeBytes })

describe('object inventory reconciliation', () => {
  it('matches durable references and calculates quota usage', () => {
    expect(reconcileObjectInventory({ workspaceId: 'ws_a', references: [ref('clean/ws_a/asset_1/source.png')], inventory: [object('clean/ws_a/asset_1/source.png')], quota: { limitBytes: 10, reservedBytes: 2 } })).toMatchObject({
      status: 'clean',
      quota: { usedBytes: 4, reservedBytes: 2, projectedBytes: 6, availableBytes: 4 },
      counts: { matched: 1, missing: 0, metadataMismatches: 0, orphans: 0 },
      findings: [],
    })
  })

  it('reports missing, mismatched and orphaned objects deterministically', () => {
    const report = reconcileObjectInventory({
      workspaceId: 'ws_a',
      references: [ref('clean/ws_a/asset_missing/source.png'), ref('clean/ws_a/asset_mismatch/source.png', 4)],
      inventory: [object('clean/ws_a/asset_mismatch/source.png', 9), object('clean/ws_a/unreferenced/extra.png', 3)],
    })
    expect(report.status).toBe('attention_required')
    expect(report.findings.map(finding => finding.code)).toEqual(['MISSING_OBJECT', 'OBJECT_METADATA_MISMATCH', 'ORPHAN_OBJECT'])
    expect(report.quota.usedBytes).toBe(12)
  })

  it('fails closed for cross-workspace objects and quota overflow', () => {
    const report = reconcileObjectInventory({
      workspaceId: 'ws_a',
      references: [ref('clean/ws_a/asset_1/source.png')],
      inventory: [{ ...object('clean/ws_b/asset_2/source.png'), workspaceId: 'ws_b' }, object('clean/ws_a/asset_1/source.png', 9)],
      quota: { limitBytes: 10, reservedBytes: 2 },
    })
    expect(report.status).toBe('attention_required')
    expect(report.findings.map(finding => finding.code)).toEqual(['CROSS_WORKSPACE_OBJECT', 'OBJECT_METADATA_MISMATCH', 'QUOTA_EXCEEDED'])
    expect(report.quota).toMatchObject({ usedBytes: 9, projectedBytes: 11, availableBytes: 0 })
  })
})
