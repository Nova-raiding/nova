import { describe, expect, it } from 'vitest'
import { validateManualOperationsEvidence } from './manual-operations-evidence-gate.js'

const now = new Date('2026-09-21T08:00:00Z')
const evidence = {
  schema_version: 'manual-operations-evidence/1', release_id: 'release-1', environment: 'production',
  workflow: 'public_import_manual_publish', official_api_receipt: false, tenant_isolation_verified: true,
  workspace_id: 'workspace-1', manual_publish_report_id: 'manual-report-1', verified_by: 'release-operator',
  simulated: false, generated_at: '2026-09-21T07:00:00Z', expires_at: '2026-09-22T07:00:00Z',
  checks: [{ name: 'tenant_scope', status: 'pass' }, { name: 'manual_report', status: 'pass' }, { name: 'merchant_visibility', status: 'pass' }],
}

describe('manual operations evidence gate', () => {
  it('accepts fresh, release-bound, non-simulated evidence with the required workflow checks', () => {
    expect(validateManualOperationsEvidence(evidence, 'release-1', now)).toEqual([])
  })

  it('rejects generic pass rows that do not prove the manual workflow boundaries', () => {
    const invalid = { ...evidence, checks: ['one', 'two', 'three'].map(name => ({ name, status: 'pass' })) }
    expect(validateManualOperationsEvidence(invalid, 'release-1', now)).toEqual(expect.arrayContaining([
      'tenant_scope workflow check is required', 'manual_report workflow check is required', 'merchant_visibility workflow check is required',
    ]))
  })

  it('rejects simulated, stale, expired, future, and duplicate-check evidence', () => {
    const invalid = structuredClone(evidence)
    invalid.simulated = true
    invalid.generated_at = '2026-09-19T07:00:00Z'
    invalid.expires_at = '2026-09-20T07:00:00Z'
    invalid.checks[2]!.name = 'manual_report'
    expect(validateManualOperationsEvidence(invalid, 'release-1', now)).toEqual(expect.arrayContaining([
      'simulated must be false', 'manual operations evidence is stale', 'manual operations evidence has expired',
      'workflow check names must be unique', 'merchant_visibility workflow check is required',
    ]))
    const future = { ...evidence, generated_at: '2026-09-21T08:05:01Z', expires_at: '2026-09-22T08:05:01Z' }
    expect(validateManualOperationsEvidence(future, 'release-1', now)).toContain('generated_at must not be more than five minutes in the future')
  })
})
