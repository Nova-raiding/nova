import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { signManualCandidate, validateManualCandidate } from '../infra/protected/attest-manual-operations-evidence.mjs'
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

  it('requires the protected Ed25519 signature and exact deployment bindings for production', () => {
    const pair = generateKeyPairSync('ed25519')
    const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const candidate = { ...evidence, isolation_probe_workspace_id: 'foreign-workspace', checks: [
      { name: 'tenant_scope', status: 'pass', observation: 'foreign_workspace_rejected' },
      { name: 'manual_report', status: 'pass', observation: 'human_evidence_boundary_preserved' },
      { name: 'merchant_visibility', status: 'pass', observation: 'expected_report_visible' },
    ] }
    const binding = { releaseId: 'release-1', imageSetDigest: `sha256:${'a'.repeat(64)}`, manifestSha256: 'b'.repeat(64), releaseGitSha: 'c'.repeat(40), deploymentNonce: 'n'.repeat(22), keyId: 'test-key' }
    const signed = signManualCandidate(candidate, binding, privatePem, publicKeyPem, now)
    const production = { ...binding, trustedKeyId: binding.keyId, publicKeyPem }
    expect(validateManualOperationsEvidence(signed, 'release-1', now, production)).toEqual([])
    expect(validateManualOperationsEvidence(candidate, 'release-1', now, production)).toContain('signature_base64 is required')
    expect(validateManualOperationsEvidence({ ...signed, workspace_id: 'foreign-workspace' }, 'release-1', now, production)).toContain('signature_base64 is invalid')
    expect(validateManualOperationsEvidence(signed, 'release-1', now, { ...production, deploymentNonce: 'x'.repeat(22) })).toContain(`deployment_nonce must match ${'x'.repeat(22)}`)
    expect(validateManualOperationsEvidence(signed, 'release-1', now, { ...production, trustedKeyId: 'unknown' })).toContain('key_id must match unknown')
    expect(() => signManualCandidate({ ...candidate, official_api_receipt: true }, binding, privatePem, publicKeyPem, now)).toThrow('candidate manual workflow boundary mismatch')
    expect(() => signManualCandidate(candidate, binding, privatePem, generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }), now)).toThrow('protected private key does not match trust anchor')
    expect(() => validateManualCandidate({ ...candidate, signature_base64: 'forged' }, binding, now)).toThrow('candidate already contains signer fields')
  })
})
