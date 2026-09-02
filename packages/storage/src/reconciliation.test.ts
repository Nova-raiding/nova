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

  it('fails closed for provider keys containing path separators or control characters', () => {
    const report = reconcileObjectInventory({
      workspaceId: 'ws_a',
      references: [],
      inventory: [
        { workspaceId: 'ws_a', storageKey: 'clean/ws_a/asset_1/file\\evil.png', sha256: 'a'.repeat(64), sizeBytes: 1 },
        { workspaceId: 'ws_a', storageKey: 'clean/ws_a/asset_2/file\u0000.png', sha256: 'b'.repeat(64), sizeBytes: 1 },
      ],
    })

    expect(report.status).toBe('attention_required')
    expect(report.counts.crossWorkspace).toBe(2)
    expect(report.counts.invalidMetadata).toBe(0)
    expect(report.findings).toEqual([
      expect.objectContaining({ code: 'CROSS_WORKSPACE_OBJECT', storageKey: 'clean/ws_a/asset_1/file\\evil.png' }),
      expect.objectContaining({ code: 'CROSS_WORKSPACE_OBJECT', storageKey: 'clean/ws_a/asset_2/file\u0000.png' }),
    ])
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

  it('rejects invalid metadata instead of allowing integrity or quota bypasses', () => {
    const report = reconcileObjectInventory({
      workspaceId: 'ws_a',
      references: [{ ...ref('clean/ws_a/asset_invalid/source.png'), sha256: 'not-a-digest', sizeBytes: -1 }],
      inventory: [{ ...object('clean/ws_a/asset_invalid/source.png'), sha256: 'also-invalid', sizeBytes: -50 }],
      quota: { limitBytes: 1 },
    })
    expect(report.status).toBe('attention_required')
    expect(report.findings.map(finding => finding.code)).toEqual(['INVALID_OBJECT_METADATA', 'INVALID_OBJECT_METADATA'])
    expect(report.counts).toMatchObject({ references: 0, inventoryObjects: 0, invalidMetadata: 2, matched: 0 })
    expect(report.quota).toMatchObject({ usedBytes: 0, projectedBytes: 0 })
  })

  it('does not silently overwrite duplicate durable references', () => {
    const storageKey = 'clean/ws_a/asset_duplicate/source.png'
    const report = reconcileObjectInventory({
      workspaceId: 'ws_a',
      references: [ref(storageKey), { ...ref(storageKey), assetId: 'different_asset' }],
      inventory: [object(storageKey)],
    })
    expect(report.status).toBe('attention_required')
    expect(report.findings.map(finding => finding.code)).toEqual(['DUPLICATE_REFERENCE'])
    expect(report.counts).toMatchObject({ references: 1, matched: 1 })
  })

  it('rejects malformed workspace and quota inputs before calculating usage', () => {
    expect(() => reconcileObjectInventory({ workspaceId: ' ', references: [], inventory: [] }))
      .toThrow('RECONCILIATION_WORKSPACE_REQUIRED')
    expect(() => reconcileObjectInventory({ workspaceId: 'ws_a', references: [], inventory: [], quota: { limitBytes: -1 } }))
      .toThrow('RECONCILIATION_QUOTA_INVALID')
    expect(() => reconcileObjectInventory({ workspaceId: 'ws_a', references: [], inventory: [], quota: { limitBytes: 10, reservedBytes: Number.NaN } }))
      .toThrow('RECONCILIATION_QUOTA_INVALID')
  })

  it('fails closed when provider inventory totals exceed safe integer precision', () => {
    expect(() => reconcileObjectInventory({
      workspaceId: 'ws_a',
      references: [],
      inventory: [
        object('clean/ws_a/asset_large_a/source.bin', Number.MAX_SAFE_INTEGER),
        object('clean/ws_a/asset_large_b/source.bin', 1),
      ],
    })).toThrow('RECONCILIATION_SIZE_OVERFLOW')
  })

  it('fails closed when reserved bytes overflow the projected safe total', () => {
    expect(() => reconcileObjectInventory({
      workspaceId: 'ws_a',
      references: [],
      inventory: [object('clean/ws_a/asset_large/source.bin', Number.MAX_SAFE_INTEGER - 1)],
      quota: { limitBytes: Number.MAX_SAFE_INTEGER, reservedBytes: 2 },
    })).toThrow('RECONCILIATION_SIZE_OVERFLOW')
  })
})
