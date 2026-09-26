import { describe, expect, it } from 'vitest'
import { validateCanonicalProductCutoverEvidence } from './canonical-product-cutover-evidence-gate.js'

const validEvidence = {
  schema_version: '1', release_id: 'release-1', environment: 'production',
  generated_at: '2026-08-29T01:00:00Z', expires_at: '2026-08-30T00:59:00Z', simulated: false,
  source: 'production_database', database_identity_sha256: 'b'.repeat(64),
  cutover_state: 'not_cut_over', canonical_read_mode: 'legacy_shadow', canonical_read_enabled: false,
  workspace_count: 1, shadow_check_cycles: 2,
  shadow_cycles: [
    { cycle_id: 'cycle-1', completed_at: '2026-08-29T00:00:00Z', source_ref: `artifact://production/canonical/shadow-cycles/cycle-1#${'c'.repeat(64)}` },
    { cycle_id: 'cycle-2', completed_at: '2026-08-29T00:30:00Z', source_ref: `artifact://production/canonical/shadow-cycles/cycle-2#${'d'.repeat(64)}` },
  ],
  status_counts: { verified: 1, backfilled: 0, legacy_only: 0, conflict: 0, blocked: 0 },
  evidence_ref: `artifact://production/canonical/snapshot#${'a'.repeat(64)}`,
  rollback_evidence_ref: `artifact://production/canonical/rollback#${'a'.repeat(64)}`,
}

describe('canonical product cutover release-gate coverage', () => {
  it('rejects non-object and array evidence as an error state', () => {
    expect(validateCanonicalProductCutoverEvidence(null)).toEqual(['document must be a JSON object'])
    expect(validateCanonicalProductCutoverEvidence([])).toEqual(['document must be a JSON object'])
  })

  it('reports every missing or unsafe release field instead of allowing a partial pass', () => {
    const errors = validateCanonicalProductCutoverEvidence({
      ...validEvidence,
      release_id: '', environment: 'staging', simulated: true,
      database_identity_sha256: 'not-a-digest', canonical_read_enabled: true,
      workspace_count: 0, shadow_check_cycles: -1,
      status_counts: { verified: -1 }, evidence_ref: 'file://mutable', rollback_evidence_ref: 'file://mutable',
    }, { expectedReleaseId: 'release-expected', now: new Date('2026-08-29T02:00:00Z') })

    expect(errors).toEqual(expect.arrayContaining([
      'release_id is required', 'release_id must match release-expected', 'environment must be production',
      'simulated must be false', 'database_identity_sha256 must be a SHA-256 digest',
      'canonical_read_enabled must be false for the current release', 'workspace_count must be a positive integer',
      'shadow_check_cycles must be at least two consecutive cycles', 'status_counts.verified must be a non-negative integer',
      'evidence_ref must be an immutable production artifact',
      'rollback_evidence_ref must be an immutable production artifact',
    ]))
  })

  it('keeps the production gate closed without independently verified database collection', () => {
    expect(validateCanonicalProductCutoverEvidence(validEvidence, { expectedReleaseId: 'release-1', now: new Date('2026-08-29T02:00:00Z') })).toEqual(['shadow cycles require protected read-only database collection and independent provenance verification'])
  })

  it('rejects a cycle count without distinct source artifacts', () => {
    expect(validateCanonicalProductCutoverEvidence({ ...validEvidence, shadow_cycles: undefined }, { now: new Date('2026-08-29T02:00:00Z') })).toContain('shadow_cycles must enumerate every consecutive cycle')
    expect(validateCanonicalProductCutoverEvidence({ ...validEvidence, shadow_cycles: [validEvidence.shadow_cycles[0], validEvidence.shadow_cycles[0]] }, { now: new Date('2026-08-29T02:00:00Z') })).toContain('shadow_cycles[1].source_ref must be a distinct immutable production shadow-cycle artifact')
  })
})
