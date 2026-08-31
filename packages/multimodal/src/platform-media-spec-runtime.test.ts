import { describe, expect, it } from 'vitest'
import {
  platformMediaSpecImmutableDigest,
  resolvePlatformMediaSpecifications,
  type PlatformMediaSpecRuntimeRecord,
} from './platform-media-spec-runtime.js'

function approvedRecord(overrides: Partial<PlatformMediaSpecRuntimeRecord> = {}): PlatformMediaSpecRuntimeRecord {
  const base = {
    id: 'spec-runtime-1', platform: 'taobao' as const, placement: 'detail-hero', device: 'desktop' as const, version: 'v1',
    specJson: { width: 1200, height: 400, safeZone: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, formats: ['webp'], maxFileBytes: 2_000_000, maxCopyLength: { headline: 24, subtitle: 40, cta: 8 } },
    sourceUrl: 'https://official.example/spec-v1', sourceSha256: 'a'.repeat(64), checkedAt: '2026-08-29T08:00:00.000Z',
    evidenceArtifactRef: 'artifact://canary/spec-runtime-1', evidenceArtifactSha256: 'b'.repeat(64), status: 'approved' as const,
    expiresAt: '2027-08-29T08:00:00.000Z', revision: 2, approvedBy: 'ops-1', approvedAt: '2026-08-29T09:00:00.000Z',
  }
  const value = { ...base, ...overrides } as Omit<PlatformMediaSpecRuntimeRecord, 'immutableDigest'>
  return { ...value, immutableDigest: overrides.immutableDigest ?? platformMediaSpecImmutableDigest(value) }
}

describe('platform media specification runtime', () => {
  it('binds one approved immutable registry row to the delivery specification', () => {
    const record = approvedRecord()
    const result = resolvePlatformMediaSpecifications({ platform: 'taobao', placement: 'detail-hero', devices: ['desktop'], records: [record], at: '2026-08-29T10:00:00.000Z' })

    expect(result).toMatchObject({ ok: true, findings: [], specifications: [{ id: record.id, width: 1200, height: 400, evidence: { state: 'production_canary', binding: { recordId: record.id, revision: 2, immutableDigest: record.immutableDigest, sourceSha256: record.sourceSha256, evidenceArtifactSha256: record.evidenceArtifactSha256 } } }] })
    expect(Object.isFrozen(result.specifications)).toBe(true)
  })

  it.each([
    { name: 'tampered digest', record: approvedRecord({ immutableDigest: 'c'.repeat(64) }), code: 'IMMUTABLE_DIGEST_MISMATCH' },
    { name: 'expired evidence', record: approvedRecord({ expiresAt: '2026-08-29T09:30:00.000Z' }), code: 'SPEC_EXPIRED' },
    { name: 'draft row', record: approvedRecord({ status: 'draft', approvedBy: undefined, approvedAt: undefined }), code: 'SPEC_NOT_ACTIVE' },
    { name: 'missing artifact', record: approvedRecord({ evidenceArtifactRef: undefined, evidenceArtifactSha256: undefined }), code: 'EVIDENCE_REQUIRED' },
  ])('fails closed for $name', ({ record, code }) => {
    const result = resolvePlatformMediaSpecifications({ platform: 'taobao', placement: 'detail-hero', devices: ['desktop'], records: [record], at: '2026-08-29T10:00:00.000Z' })
    expect(result).toMatchObject({ ok: false, specifications: [], findings: [expect.objectContaining({ code })] })
  })

  it('rejects missing, cross-scope and duplicate runtime rows without choosing one', () => {
    expect(resolvePlatformMediaSpecifications({ platform: 'taobao', placement: 'detail-hero', devices: ['mobile'], records: [], at: '2026-08-29T10:00:00.000Z' }).findings).toContainEqual(expect.objectContaining({ code: 'SPEC_MISSING' }))
    expect(resolvePlatformMediaSpecifications({ platform: 'taobao', placement: 'detail-hero', devices: ['desktop'], records: [approvedRecord({ platform: 'jd' })], at: '2026-08-29T10:00:00.000Z' }).findings).toContainEqual(expect.objectContaining({ code: 'SCOPE_MISMATCH' }))
    const record = approvedRecord()
    expect(resolvePlatformMediaSpecifications({ platform: 'taobao', placement: 'detail-hero', devices: ['desktop'], records: [record, approvedRecord({ id: 'spec-runtime-2' })], at: '2026-08-29T10:00:00.000Z' }).findings).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_ACTIVE_SPEC' }))
  })
})
