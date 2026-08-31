import { describe, expect, it } from 'vitest'
import { deliveryFindingReadiness, mediaSpecReadiness } from './delivery-readiness.js'
import type { PlatformCapability } from './api.js'

const capability = (capabilities: PlatformCapability['capabilities']): PlatformCapability => ({
  platform: 'taobao', readiness: { ready: true, reasons: [], verifiedCapabilities: [] }, capabilities,
})

describe('merchant delivery readiness projection', () => {
  it('does not present a passed mapping when findings remain', () => {
    expect(deliveryFindingReadiness('passed', [{ code: 'missing_title' }])).toBe('blocked')
    expect(deliveryFindingReadiness('passed', [])).toBe('approved')
    expect(deliveryFindingReadiness('pending', [])).toBe('unverified')
  })

  it('only marks a media spec approved with complete lifecycle and evidence', () => {
    const rows = mediaSpecReadiness([capability([{ capability: 'image_upload', state: 'production_canary', status: 'approved', source: 'official-doc', version: 'v3', expiresAt: '2027-01-01T00:00:00Z', evidenceRef: 'canary://image' }])], Date.parse('2026-08-29T00:00:00Z'))
    expect(rows[0]).toMatchObject({ readiness: 'approved', source: 'official-doc', version: 'v3', evidence: 'canary://image' })
  })

  it('fails closed for expired or incomplete capability claims', () => {
    const rows = mediaSpecReadiness([capability([
      { capability: 'video_upload', state: 'production_canary', status: 'approved', source: 'official-doc', version: 'v1', expiresAt: '2026-01-01T00:00:00Z', evidenceRef: 'canary://video' },
      { capability: 'image_upload', state: 'production_canary', evidenceRef: 'canary://image' },
    ])], Date.parse('2026-08-29T00:00:00Z'))
    expect(rows.map(row => row.readiness)).toEqual(['expired', 'unverified'])
  })

  it('emits an explicit unverified row instead of inventing media specs', () => {
    expect(mediaSpecReadiness([capability([])])[0]).toMatchObject({ readiness: 'unverified', source: null, version: null, validUntil: null, evidence: null })
  })
})
