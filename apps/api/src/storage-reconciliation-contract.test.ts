import { describe, expect, it } from 'vitest'
import { redactStorageReconciliation } from './server.js'

describe('storage reconciliation API contract', () => {
  it('returns only redacted workspace status and never object identifiers', () => {
    const result = redactStorageReconciliation({
      workspaceId: 'ws_a', lastRunAt: '2026-08-29T10:00:00Z', status: 'attention_required',
      quota: { usedBytes: 9, reservedBytes: 2, projectedBytes: 11, limitBytes: 10, availableBytes: 0 },
      counts: { references: 1, inventoryObjects: 2, matched: 0, missing: 1, metadataMismatches: 0, orphans: 1, crossWorkspace: 0, duplicates: 0, invalidMetadata: 0 },
      findings: [{ code: 'ORPHAN_OBJECT', workspaceId: 'ws_a', storageKey: 'clean/ws_a/private/object.png', assetId: 'asset_1' }],
    })
    expect(result).toMatchObject({ status: 'attention_required', counts: { orphans: 1 }, findingCounts: { orphan_object: 1 } })
    expect(JSON.stringify(result)).not.toContain('private/object.png')
    expect(JSON.stringify(result)).not.toContain('asset_1')
  })

  it('fails closed to an explicit unavailable state', () => {
    expect(redactStorageReconciliation()).toEqual({ status: 'unavailable', message: '尚未收到对象清单对账结果' })
  })

  it('marks old reports as expired instead of implying current health', () => {
    const result = redactStorageReconciliation({
      workspaceId: 'ws-demo', lastRunAt: '2020-01-01T00:00:00.000Z', status: 'clean',
      quota: { usedBytes: 1, reservedBytes: 0, projectedBytes: 1 },
      counts: { references: 1, inventoryObjects: 1, matched: 1, missing: 0, metadataMismatches: 0, orphans: 0, crossWorkspace: 0, duplicates: 0, invalidMetadata: 0 }, findings: [],
    })
    expect(result).toMatchObject({ status: 'clean', freshness: 'expired', freshnessAfterMinutes: 1440 })
  })

  it('exposes a safe failed-run signal without provider error details', () => {
    const result = redactStorageReconciliation({
      workspaceId: 'ws-a', status: 'attention_required', runStatus: 'failed', findings: [],
      quota: { usedBytes: 0, reservedBytes: 0, projectedBytes: 0 },
      counts: { references: 0, inventoryObjects: 0, matched: 0, missing: 0, metadataMismatches: 0, orphans: 0, crossWorkspace: 0, duplicates: 0, invalidMetadata: 0 },
      error: { code: 'RECONCILIATION_PROVIDER_FAILED', message: 'secret provider detail', retryable: true, nextActions: ['retry'] },
    })
    expect(result).toMatchObject({ status: 'failed', runStatus: 'failed', errorMessage: expect.any(String) })
    expect(JSON.stringify(result)).not.toContain('secret provider detail')
  })
})
