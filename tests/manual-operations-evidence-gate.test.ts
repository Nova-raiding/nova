import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { signManualCandidate, validateManualCandidate } from '../infra/protected/attest-manual-operations-evidence.mjs'
import { validateManualOperationsEvidence } from './manual-operations-evidence-gate.js'
import { manualCaptureJournal, manualCaptureJournalSha256, manualCaptureObservationSha256 } from './manual-operations-evidence-fixture.js'
import { validateManualOperationsEvidenceRuntime } from '../apps/api/src/server.js'

const now = new Date('2026-09-21T08:00:00Z')
const candidateIdentity = { release_id: 'release-1', release_git_sha: 'c'.repeat(40), manifest_sha256: 'b'.repeat(64), image_set_digest: `sha256:${'a'.repeat(64)}` }
const generatedAt = '2026-09-21T07:00:00Z'
const captureJournal = manualCaptureJournal(candidateIdentity, generatedAt)
const evidence = {
  schema_version: 'manual-operations-evidence/1', release_id: 'release-1', environment: 'production',
  workflow: 'public_import_manual_publish', official_api_receipt: false, manual_evidence_boundary: 'manual_unverified', manual_publish_state: 'manual_publish_reported', tenant_isolation_verified: true,
  workspace_id: 'workspace-1', isolation_probe_workspace_id: 'foreign-workspace', manual_publish_report_id: 'manual-report-1', verified_by: 'release-operator',
  simulated: false, generated_at: generatedAt, expires_at: '2026-09-22T07:00:00Z',
  capture_journal: captureJournal, capture_journal_sha256: manualCaptureJournalSha256(captureJournal),
  checks: [
    { name: 'tenant_scope', status: 'pass', observation: 'foreign_workspace_rejected' },
    { name: 'manual_report', status: 'pass', observation: 'human_evidence_boundary_preserved' },
    { name: 'merchant_visibility', status: 'pass', observation: 'expected_report_visible' },
  ],
}

describe('manual operations evidence gate', () => {
  it('accepts fresh, release-bound, non-simulated evidence with the required workflow checks', () => {
    expect(validateManualOperationsEvidence(evidence, 'release-1', now)).toEqual([])
    expect(validateManualOperationsEvidenceRuntime(evidence, { expectedReleaseId: 'release-1', now })).toEqual([])
  })

  it('keeps runtime and release-gate decisions aligned for manual evidence boundaries and journal bindings', () => {
    const mismatchedReportJournal = structuredClone(captureJournal)
    const listObservation = mismatchedReportJournal.observations.find(observation => observation.name === 'target_list')!
    listObservation.material.visible_report_id = 'different-report'
    listObservation.observation_sha256 = manualCaptureObservationSha256(listObservation.name, listObservation.status, listObservation.material)
    const invalidCases = [
      { ...evidence, manual_evidence_boundary: 'unverified' },
      { ...evidence, manual_publish_state: 'published' },
      { ...evidence, capture_journal: undefined },
      { ...evidence, capture_journal_sha256: '0'.repeat(64) },
      { ...evidence, capture_journal: mismatchedReportJournal, capture_journal_sha256: manualCaptureJournalSha256(mismatchedReportJournal) },
    ]
    for (const invalid of invalidCases) {
      expect(validateManualOperationsEvidence(invalid, 'release-1', now).length).toBeGreaterThan(0)
      expect(validateManualOperationsEvidenceRuntime(invalid, { expectedReleaseId: 'release-1', now }).length).toBeGreaterThan(0)
    }
  })

  it('rejects generic pass rows that do not prove the manual workflow boundaries', () => {
    const invalid = { ...evidence, checks: ['one', 'two', 'three'].map(name => ({ name, status: 'pass' })) }
    expect(validateManualOperationsEvidence(invalid, 'release-1', now)).toEqual(expect.arrayContaining([
      'tenant_scope workflow check is required', 'manual_report workflow check is required', 'merchant_visibility workflow check is required',
    ]))
  })

  it('rejects missing manual boundaries, altered capture journal, and mismatched expected release identity', () => {
    expect(validateManualOperationsEvidence({ ...evidence, manual_evidence_boundary: 'unknown' }, 'release-1', now)).toContain('manual_evidence_boundary must be manual_unverified')
    expect(validateManualOperationsEvidence({ ...evidence, official_api_receipt: null }, 'release-1', now)).toContain('official_api_receipt must be false')
    expect(validateManualOperationsEvidence({ ...evidence, capture_journal_sha256: '0'.repeat(64) }, 'release-1', now)).toContain('capture_journal_sha256 does not match capture_journal')
    expect(validateManualOperationsEvidence(evidence, 'release-1', now, {
      releaseId: 'release-1', imageSetDigest: `sha256:${'f'.repeat(64)}`, manifestSha256: 'e'.repeat(64), releaseGitSha: 'd'.repeat(40), deploymentNonce: 'n'.repeat(22), trustedKeyId: 'test-key', publicKeyPem: 'unused',
    })).toContain('capture_journal candidate identity must match production release bindings')
  })

  it('recomputes observation digests and rejects unbound or raw response material', () => {
    const staleDigestJournal = structuredClone(captureJournal)
    staleDigestJournal.observations[2]!.material.state = 'manual_review_required'
    expect(validateManualOperationsEvidence({ ...evidence, capture_journal: staleDigestJournal }, 'release-1', now)).toContain('capture_journal target_get observation hash does not match material')

    const rehashedJournal = structuredClone(captureJournal)
    const releaseObservation = rehashedJournal.observations.find(observation => observation.name === 'release')!
    releaseObservation.material.release_git_sha = 'd'.repeat(40)
    releaseObservation.observation_sha256 = manualCaptureObservationSha256(releaseObservation.name, releaseObservation.status, releaseObservation.material)
    expect(validateManualOperationsEvidence({ ...evidence, capture_journal: rehashedJournal, capture_journal_sha256: manualCaptureJournalSha256(rehashedJournal) }, 'release-1', now)).toContain('capture_journal release material is invalid or not identity-bound')

    const rawJournal = structuredClone(captureJournal)
    const getObservation = rawJournal.observations.find(observation => observation.name === 'target_get')!
    getObservation.material.raw_response = 'sensitive-response'
    getObservation.observation_sha256 = manualCaptureObservationSha256(getObservation.name, getObservation.status, getObservation.material)
    expect(validateManualOperationsEvidence({ ...evidence, capture_journal: rawJournal, capture_journal_sha256: manualCaptureJournalSha256(rawJournal) }, 'release-1', now)).toContain('capture_journal target report material does not match evidence')

    const missingErrorCodeJournal = structuredClone(captureJournal)
    const isolationObservation = missingErrorCodeJournal.observations.find(observation => observation.name === 'isolation')!
    isolationObservation.material.code_present = false
    isolationObservation.observation_sha256 = manualCaptureObservationSha256(isolationObservation.name, isolationObservation.status, isolationObservation.material)
    expect(validateManualOperationsEvidence({ ...evidence, capture_journal: missingErrorCodeJournal, capture_journal_sha256: manualCaptureJournalSha256(missingErrorCodeJournal) }, 'release-1', now)).toContain('capture_journal isolation material is invalid')

    const mismatchedVisibleReport = structuredClone(captureJournal)
    const listObservation = mismatchedVisibleReport.observations.find(observation => observation.name === 'target_list')!
    listObservation.material.visible_report_id = 'different-report'
    listObservation.observation_sha256 = manualCaptureObservationSha256(listObservation.name, listObservation.status, listObservation.material)
    expect(validateManualOperationsEvidence({ ...evidence, capture_journal: mismatchedVisibleReport, capture_journal_sha256: manualCaptureJournalSha256(mismatchedVisibleReport) }, 'release-1', now)).toContain('capture_journal target list material is invalid')
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
    const rehashedInvalidCandidate = structuredClone(candidate)
    const releaseObservation = rehashedInvalidCandidate.capture_journal.observations.find((observation: { name: string }) => observation.name === 'release')!
    releaseObservation.material.release_git_sha = 'd'.repeat(40)
    releaseObservation.observation_sha256 = manualCaptureObservationSha256(releaseObservation.name, releaseObservation.status, releaseObservation.material)
    rehashedInvalidCandidate.capture_journal_sha256 = manualCaptureJournalSha256(rehashedInvalidCandidate.capture_journal)
    expect(() => signManualCandidate(rehashedInvalidCandidate, binding, privatePem, publicKeyPem, now)).toThrow('candidate capture journal release material is invalid or not identity-bound')
    const missingCodeCandidate = structuredClone(candidate)
    const isolationObservation = missingCodeCandidate.capture_journal.observations.find((observation: { name: string }) => observation.name === 'isolation')!
    isolationObservation.material.code_present = false
    isolationObservation.observation_sha256 = manualCaptureObservationSha256(isolationObservation.name, isolationObservation.status, isolationObservation.material)
    missingCodeCandidate.capture_journal_sha256 = manualCaptureJournalSha256(missingCodeCandidate.capture_journal)
    expect(() => signManualCandidate(missingCodeCandidate, binding, privatePem, publicKeyPem, now)).toThrow('candidate capture journal isolation material is invalid')
    const mismatchedVisibleReportCandidate = structuredClone(candidate)
    const listObservation = mismatchedVisibleReportCandidate.capture_journal.observations.find((observation: { name: string }) => observation.name === 'target_list')!
    listObservation.material.visible_report_id = 'different-report'
    listObservation.observation_sha256 = manualCaptureObservationSha256(listObservation.name, listObservation.status, listObservation.material)
    mismatchedVisibleReportCandidate.capture_journal_sha256 = manualCaptureJournalSha256(mismatchedVisibleReportCandidate.capture_journal)
    expect(() => signManualCandidate(mismatchedVisibleReportCandidate, binding, privatePem, publicKeyPem, now)).toThrow('candidate capture journal target list material is invalid')
    expect(validateManualOperationsEvidence({ ...signed, workspace_id: 'foreign-workspace' }, 'release-1', now, production)).toContain('signature_base64 is invalid')
    expect(validateManualOperationsEvidence(signed, 'release-1', now, { ...production, deploymentNonce: 'x'.repeat(22) })).toContain(`deployment_nonce must match ${'x'.repeat(22)}`)
    expect(validateManualOperationsEvidence(signed, 'release-1', now, { ...production, trustedKeyId: 'unknown' })).toContain('key_id must match unknown')
    expect(() => signManualCandidate({ ...candidate, official_api_receipt: true }, binding, privatePem, publicKeyPem, now)).toThrow('candidate manual workflow boundary mismatch')
    expect(() => signManualCandidate(candidate, binding, privatePem, generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }), now)).toThrow('protected private key does not match trust anchor')
    expect(() => validateManualCandidate({ ...candidate, signature_base64: 'forged' }, binding, now)).toThrow('candidate already contains signer fields')
  })
})
