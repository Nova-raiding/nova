import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateCanonicalProductCutoverEvidence } from './canonical-product-cutover-evidence-gate.js'

const ref = (name: string) => `artifact://production/canonical/${name}#${'a'.repeat(64)}`
const evidence = {
  schema_version: '1', release_id: 'release-1', environment: 'production', generated_at: '2026-08-29T01:00:00Z', expires_at: '2026-08-30T00:59:00Z', simulated: false,
  source: 'production_database', database_identity_sha256: 'b'.repeat(64), cutover_state: 'not_cut_over', canonical_read_mode: 'legacy_shadow', canonical_read_enabled: false,
  workspace_count: 1, shadow_check_cycles: 2, status_counts: { verified: 0, backfilled: 0, legacy_only: 1, conflict: 0, blocked: 0 }, evidence_ref: ref('snapshot'), rollback_evidence_ref: ref('rollback'),
}

describe('canonical product cutover evidence gate', () => {
  const now = new Date('2026-08-29T02:00:00Z')
  it('records the current production state without claiming cutover', () => expect(validateCanonicalProductCutoverEvidence(evidence, { expectedReleaseId: 'release-1', now })).toEqual([]))
  it('rejects a simulated or prematurely enabled canonical cutover', () => {
    const invalid = { ...evidence, simulated: true, canonical_read_mode: 'canonical_read', canonical_read_enabled: true }
    expect(validateCanonicalProductCutoverEvidence(invalid, { now })).toEqual(expect.arrayContaining(['simulated must be false', 'canonical_read_mode must be legacy_shadow for the current release', 'canonical_read_enabled must be false for the current release']))
  })
  it('rejects stale, future, expired, overlong, and reused cutover evidence', () => {
    expect(validateCanonicalProductCutoverEvidence({ ...evidence, generated_at: '2026-08-27T00:00:00Z' }, { now })).toContain('cutover evidence is stale')
    expect(validateCanonicalProductCutoverEvidence({ ...evidence, generated_at: '2026-08-29T02:05:01Z' }, { now })).toContain('generated_at must not be in the future')
    expect(validateCanonicalProductCutoverEvidence({ ...evidence, expires_at: now.toISOString() }, { now })).toContain('cutover evidence is expired')
    expect(validateCanonicalProductCutoverEvidence({ ...evidence, expires_at: '2026-08-30T01:00:01Z' }, { now })).toContain('cutover evidence validity must not exceed 24 hours')
    expect(validateCanonicalProductCutoverEvidence({ ...evidence, rollback_evidence_ref: evidence.evidence_ref }, { now })).toContain('rollback_evidence_ref must differ from evidence_ref')
  })
  it('verifies immutable cutover and rollback artifact bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'cutover-evidence-')); mkdirSync(join(root, 'canonical'))
    const snapshot = 'snapshot'; const rollback = 'rollback'
    writeFileSync(join(root, 'canonical/snapshot'), snapshot); writeFileSync(join(root, 'canonical/rollback'), rollback)
    const value = { ...evidence, evidence_ref: `artifact://production/canonical/snapshot#${createHash('sha256').update(snapshot).digest('hex')}`, rollback_evidence_ref: `artifact://production/canonical/rollback#${createHash('sha256').update(rollback).digest('hex')}` }
    expect(validateCanonicalProductCutoverEvidence(value, { artifactRoot: root, now })).toEqual([])
    writeFileSync(join(root, 'canonical/snapshot'), 'tampered')
    expect(validateCanonicalProductCutoverEvidence(value, { artifactRoot: root, now })).toContain('evidence_ref SHA-256 does not match the referenced artifact')
  })
})
