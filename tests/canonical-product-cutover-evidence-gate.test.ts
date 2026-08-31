import { describe, expect, it } from 'vitest'
import { validateCanonicalProductCutoverEvidence } from './canonical-product-cutover-evidence-gate.js'

const ref = (name: string) => `artifact://production/canonical/${name}#${'a'.repeat(64)}`
const evidence = {
  schema_version: '1', release_id: 'release-1', environment: 'production', generated_at: '2026-08-29T01:00:00Z', expires_at: '2026-09-29T01:00:00Z', simulated: false,
  source: 'production_database', database_identity_sha256: 'b'.repeat(64), cutover_state: 'not_cut_over', canonical_read_mode: 'legacy_shadow', canonical_read_enabled: false,
  workspace_count: 1, shadow_check_cycles: 2, status_counts: { verified: 0, backfilled: 0, legacy_only: 1, conflict: 0, blocked: 0 }, evidence_ref: ref('snapshot'), rollback_evidence_ref: ref('rollback'),
}

describe('canonical product cutover evidence gate', () => {
  it('records the current production state without claiming cutover', () => expect(validateCanonicalProductCutoverEvidence(evidence, { expectedReleaseId: 'release-1' })).toEqual([]))
  it('rejects a simulated or prematurely enabled canonical cutover', () => {
    const invalid = { ...evidence, simulated: true, canonical_read_mode: 'canonical_read', canonical_read_enabled: true }
    expect(validateCanonicalProductCutoverEvidence(invalid)).toEqual(expect.arrayContaining(['simulated must be false', 'canonical_read_mode must be legacy_shadow for the current release', 'canonical_read_enabled must be false for the current release']))
  })
})
