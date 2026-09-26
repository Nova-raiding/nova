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
  shadow_cycles: [
    { cycle_id: 'cycle-1', completed_at: '2026-08-29T00:00:00Z', source_ref: ref('shadow-cycles/cycle-1') },
    { cycle_id: 'cycle-2', completed_at: '2026-08-29T00:30:00Z', source_ref: ref('shadow-cycles/cycle-2') },
  ],
}

describe('canonical product cutover evidence gate', () => {
  const now = new Date('2026-08-29T02:00:00Z')
  it('fails closed on an otherwise complete self-declared cycle summary', () => expect(validateCanonicalProductCutoverEvidence(evidence, { expectedReleaseId: 'release-1', now })).toEqual(['shadow cycles require protected read-only database collection and independent provenance verification']))
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
    const root = mkdtempSync(join(tmpdir(), 'cutover-evidence-')); mkdirSync(join(root, 'canonical'), { recursive: true }); mkdirSync(join(root, 'canonical/shadow-cycles'))
    const snapshot = 'snapshot'; const rollback = 'rollback'
    writeFileSync(join(root, 'canonical/snapshot'), snapshot); writeFileSync(join(root, 'canonical/rollback'), rollback)
    const cycles = evidence.shadow_cycles.map(cycle => {
      const source = JSON.stringify({ schema_version: 'canonical-shadow-cycle/1', release_id: evidence.release_id, database_identity_sha256: evidence.database_identity_sha256, cycle_id: cycle.cycle_id, completed_at: cycle.completed_at, source: 'production_database', read_only_transaction: true, simulated: false, canonical_read_mode: 'legacy_shadow', workspace_count: evidence.workspace_count, status_counts: evidence.status_counts })
      writeFileSync(join(root, `canonical/shadow-cycles/${cycle.cycle_id}`), source)
      return { ...cycle, source_ref: `artifact://production/canonical/shadow-cycles/${cycle.cycle_id}#${createHash('sha256').update(source).digest('hex')}` }
    })
    const value = { ...evidence, shadow_cycles: cycles, evidence_ref: `artifact://production/canonical/snapshot#${createHash('sha256').update(snapshot).digest('hex')}`, rollback_evidence_ref: `artifact://production/canonical/rollback#${createHash('sha256').update(rollback).digest('hex')}` }
    expect(validateCanonicalProductCutoverEvidence(value, { artifactRoot: root, now })).toEqual(['shadow cycles require protected read-only database collection and independent provenance verification'])
    expect(validateCanonicalProductCutoverEvidence({ ...value, shadow_cycles: [cycles[0], cycles[0]] }, { artifactRoot: root, now })).toEqual(expect.arrayContaining(['shadow_cycles[1].cycle_id must be distinct and stable', 'shadow_cycles[1].source_ref must be a distinct immutable production shadow-cycle artifact']))
    writeFileSync(join(root, 'canonical/shadow-cycles/cycle-2'), '{}')
    expect(validateCanonicalProductCutoverEvidence(value, { artifactRoot: root, now })).toContain('shadow_cycles[1].source_ref SHA-256 does not match the referenced artifact')
    writeFileSync(join(root, 'canonical/snapshot'), 'tampered')
    expect(validateCanonicalProductCutoverEvidence(value, { artifactRoot: root, now })).toContain('evidence_ref SHA-256 does not match the referenced artifact')
  })
})
