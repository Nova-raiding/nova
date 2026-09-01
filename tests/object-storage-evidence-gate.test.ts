import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateObjectStorageEvidence } from './object-storage-evidence-gate.js'

const ref = (name: string) => `artifact://production/storage/${name}#${'a'.repeat(64)}`
const evidence = { schema_version: '1', release_id: 'release-1', environment: 'production', generated_at: '2026-08-29T01:00:00Z', expires_at: '2026-09-29T01:00:00Z', provider: 's3-compatible', bucket: 'merchant-assets', endpoint: 'https://s3.example.com', versioning: true, public_access_blocked: true, kms_encryption: true, lifecycle_policy_id: 'asset-lifecycle-v1', simulated: false, attestation_ref: ref('attestation'), source_binding: { release_id: 'release-1', provider: 's3-compatible', bucket: 'merchant-assets', endpoint: 'https://s3.example.com', config_checksum: 'b'.repeat(64), evidence_ref: ref('source-binding') }, retention_evidence: { policy_id: 'asset-lifecycle-v1', retention_days: 365, verified_at: '2026-08-29T02:00:00Z', evidence_ref: ref('retention') }, restore_evidence: { target_isolated: true, restored_at: '2026-08-29T03:00:00Z', backup_checksum_sha256: 'c'.repeat(64), evidence_ref: ref('restore') }, checks: ['quarantine_clean_metadata', 'version_restore', 'integrity_sample', 'deletion_protection', 'orphan_recovery', 'generated_video_archive'].map(id => ({ id, state: 'passed', evidence_ref: ref(id) })) }

describe('object storage production evidence gate', () => {
  it('requires release/config-bound cloud storage evidence', () => expect(validateObjectStorageEvidence(evidence, { expectedReleaseId: 'release-1', expectedBucket: 'merchant-assets', expectedEndpoint: 'https://s3.example.com' })).toEqual([]))
  it('rejects local storage, disabled controls, and incomplete recovery proof', () => { const invalid = structuredClone(evidence); invalid.endpoint = 'http://localhost:9000'; invalid.versioning = false; invalid.checks = invalid.checks.slice(0, 1); expect(validateObjectStorageEvidence(invalid)).toEqual(expect.arrayContaining(['endpoint must identify a real cloud object store', 'endpoint must use HTTPS', 'versioning must be true', 'version_restore check is required'])) })
  it('verifies referenced artifact bytes when a production artifact root is supplied', () => {
    const root = mkdtempSync(join(tmpdir(), 'object-storage-evidence-'))
    mkdirSync(join(root, 'storage'), { recursive: true })
    const content = 'immutable storage evidence'
    const digest = createHash('sha256').update(content).digest('hex')
    const artifactRef = (name: string) => `artifact://production/storage/${name}#${digest}`
    for (const name of ['attestation', 'source-binding', 'retention', 'restore']) writeFileSync(join(root, 'storage', name), content)
    for (const check of evidence.checks) writeFileSync(join(root, 'storage', check.id!), content)
    const valid = structuredClone(evidence)
    valid.attestation_ref = artifactRef('attestation')
    valid.source_binding.evidence_ref = artifactRef('source-binding')
    valid.retention_evidence.evidence_ref = artifactRef('retention')
    valid.restore_evidence.evidence_ref = artifactRef('restore')
    valid.checks = valid.checks.map(check => ({ ...check, evidence_ref: artifactRef(check.id!) }))
    expect(validateObjectStorageEvidence(valid, { artifactRoot: root })).toEqual([])
    writeFileSync(join(root, 'storage', 'integrity_sample'), 'tampered')
    expect(validateObjectStorageEvidence(valid, { artifactRoot: root })).toContain('integrity_sample.evidence_ref SHA-256 does not match the referenced artifact')
  })
  it('fails closed when source binding, checksum, retention, or restore evidence is incomplete', () => {
    const { source_binding: _sourceBinding, ...withoutSourceBinding } = structuredClone(evidence)
    const invalid = withoutSourceBinding
    invalid.retention_evidence.retention_days = 0
    invalid.restore_evidence.target_isolated = false
    invalid.restore_evidence.backup_checksum_sha256 = 'not-a-checksum'
    expect(validateObjectStorageEvidence(invalid)).toEqual(expect.arrayContaining([
      'source_binding is required',
      'retention_evidence.retention_days must be a positive integer',
      'restore_evidence.target_isolated must be true',
      'restore_evidence.backup_checksum_sha256 must be a SHA-256 hash',
    ]))
  })
  it('rejects source bindings that point at another release or storage target', () => {
    const invalid = structuredClone(evidence)
    invalid.source_binding.release_id = 'release-2'
    invalid.source_binding.bucket = 'other-bucket'
    invalid.source_binding.config_checksum = 'bad'
    expect(validateObjectStorageEvidence(invalid)).toEqual(expect.arrayContaining([
      'source_binding.release_id must match release_id',
      'source_binding.bucket must match bucket',
      'source_binding.config_checksum must be a SHA-256 hash',
    ]))
  })
})
