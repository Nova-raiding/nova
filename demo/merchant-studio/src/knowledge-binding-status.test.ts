import { describe, expect, it } from 'vitest'
import { resolveKnowledgeBindingStatus, resolveKnowledgeBindingSummary } from './knowledge-binding-status.js'
import type { AssetMetadata } from './api.js'

const asset = (overrides: Partial<AssetMetadata> = {}): AssetMetadata => ({
  id: 'asset-1',
  name: '商品资料.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  sizeBytes: 1024,
  rightsStatus: 'pending',
  scanStatus: 'clean',
  parseStatus: 'succeeded',
  contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true },
  references: [],
  revision: 1,
  createdAt: '2026-09-01T00:00:00Z',
  readiness: { status: 'draft', reasons: [], },
  ...overrides,
})

describe('knowledge binding status', () => {
  it('exposes the three fail-closed lifecycle states', () => {
    expect(resolveKnowledgeBindingStatus(asset())).toMatchObject({
      approvalStatus: 'pending',
      rightsStatus: 'unknown',
      indexState: 'queued',
      ready: false,
    })
  })

  it('only reports ready after facts, rights, scan, parse and server readiness pass', () => {
    expect(resolveKnowledgeBindingStatus(asset({
      rightsStatus: 'approved',
      factsConfirmedBy: 'merchant-1',
      factsConfirmedAt: '2026-09-01T00:01:00Z',
      readiness: { status: 'ready', reasons: [] },
    }))).toMatchObject({
      approvalStatus: 'approved',
      rightsStatus: 'cleared',
      indexState: 'ready',
      ready: true,
    })
  })

  it('keeps missing bindings blocked and aggregates the strictest state', () => {
    const ready = asset({
      rightsStatus: 'approved',
      factsConfirmedBy: 'merchant-1',
      factsConfirmedAt: '2026-09-01T00:01:00Z',
      readiness: { status: 'ready', reasons: [] },
    })
    expect(resolveKnowledgeBindingSummary([ready], ['asset-1', 'missing'])).toMatchObject({
      boundAssetCount: 2,
      missingAssetCount: 1,
      approvalStatus: 'pending',
      rightsStatus: 'unknown',
      indexState: 'queued',
      ready: false,
    })
  })
})
