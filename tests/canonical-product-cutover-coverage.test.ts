import { describe, expect, it } from 'vitest'
import { validateCanonicalProductCutoverEvidence } from './canonical-product-cutover-evidence-gate.js'

const validEvidence = {
  schema_version: '1', release_id: 'release-1', environment: 'production',
  generated_at: '2026-08-29T01:00:00Z', expires_at: '2026-09-29T01:00:00Z', simulated: false,
  source: 'production_database', database_identity_sha256: 'b'.repeat(64),
  cutover_state: 'not_cut_over', canonical_read_mode: 'legacy_shadow', canonical_read_enabled: false,
  workspace_count: 1, shadow_check_cycles: 2,
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
    }, { expectedReleaseId: 'release-expected' })

    expect(errors).toEqual(expect.arrayContaining([
      'release_id is required', 'release_id must match release-expected', 'environment must be production',
      'simulated must be false', 'database_identity_sha256 must be a SHA-256 digest',
      'canonical_read_enabled must be false for the current release', 'workspace_count must be a positive integer',
      'shadow_check_cycles must be a non-negative integer', 'status_counts.verified must be a non-negative integer',
      'evidence_ref must be an immutable production artifact',
      'rollback_evidence_ref must be an immutable production artifact',
    ]))
  })

  it('accepts the complete legacy-shadow evidence contract', () => {
    expect(validateCanonicalProductCutoverEvidence(validEvidence, { expectedReleaseId: 'release-1' })).toEqual([])
  })
})
