import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { signObjectStorageEvidence, validateObjectStorageEvidence } from './object-storage-evidence-gate.js'

const ref = (name: string) => `artifact://production/storage/${name}#${'a'.repeat(64)}`
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
const bindings = { expectedReleaseId: 'release-1', expectedReleaseGitSha: '1'.repeat(40), expectedManifestSha256: '2'.repeat(64), expectedImageSetDigest: `sha256:${'3'.repeat(64)}`, expectedDeploymentNonce: 'deployment_nonce_1234567890', expectedConfigChecksum: 'b'.repeat(64), expectedEncryption: 'AES256' as const, trustedKeyId: 'storage-attestor-v1', publicKeyPem, now: '2026-08-29T04:00:00Z' }
const unsignedEvidence = { schema_version: '2', release_id: 'release-1', release_git_sha: '1'.repeat(40), manifest_sha256: '2'.repeat(64), image_set_digest: `sha256:${'3'.repeat(64)}`, deployment_nonce: 'deployment_nonce_1234567890', key_id: 'storage-attestor-v1', environment: 'production', generated_at: '2026-08-29T01:00:00Z', attested_at: '2026-08-29T03:30:00Z', expires_at: '2026-09-29T01:00:00Z', provider: 's3-compatible', bucket: 'merchant-assets', endpoint: 'https://s3.example.com', versioning: true, public_access_blocked: true, server_side_encryption: 'AES256' as const, lifecycle_policy_id: 'asset-lifecycle-v1', simulated: false, attestation_ref: ref('attestation'), source_binding: { release_id: 'release-1', provider: 's3-compatible', bucket: 'merchant-assets', endpoint: 'https://s3.example.com', config_checksum: 'b'.repeat(64), evidence_ref: ref('source-binding') }, retention_evidence: { policy_id: 'asset-lifecycle-v1', retention_days: 365, verified_at: '2026-08-29T02:00:00Z', evidence_ref: ref('retention') }, restore_evidence: { target_isolated: true, restored_at: '2026-08-29T03:00:00Z', backup_checksum_sha256: 'c'.repeat(64), evidence_ref: ref('restore') }, checks: ['quarantine_clean_metadata', 'version_restore', 'integrity_sample', 'deletion_protection', 'orphan_recovery', 'generated_video_archive'].map(id => ({ id, state: 'passed', evidence_ref: ref(id) })) }
const evidence = { ...unsignedEvidence, signature_base64: signObjectStorageEvidence(unsignedEvidence, privateKeyPem) }

describe('object storage production evidence gate', () => {
  it('requires signed release/config-bound cloud storage evidence', () => expect(validateObjectStorageEvidence(evidence, { ...bindings, expectedBucket: 'merchant-assets', expectedEndpoint: 'https://s3.example.com' })).toEqual([]))
  it('requires a KMS key only when aws:kms is selected', () => {
    const kms = { ...unsignedEvidence, server_side_encryption: 'aws:kms' as const, kms_key_id: 'kms-key-production' }
    const signed = { ...kms, signature_base64: signObjectStorageEvidence(kms, privateKeyPem) }
    expect(validateObjectStorageEvidence(signed, { ...bindings, expectedEncryption: 'aws:kms' })).toEqual([])
    const missingKey = { ...kms, kms_key_id: undefined }
    expect(validateObjectStorageEvidence({ ...missingKey, signature_base64: signObjectStorageEvidence(missingKey, privateKeyPem) }, { ...bindings, expectedEncryption: 'aws:kms' })).toContain('kms_key_id is required when server_side_encryption is aws:kms')
    expect(validateObjectStorageEvidence(evidence, { ...bindings, expectedEncryption: 'aws:kms' })).toContain('server_side_encryption must match rendered production config aws:kms')
  })
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
    valid.signature_base64 = signObjectStorageEvidence(valid, privateKeyPem)
    expect(validateObjectStorageEvidence(valid, { ...bindings, artifactRoot: root })).toEqual([])
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
  it('fails closed for expired or non-forward evidence windows', () => {
    const expired = structuredClone(evidence)
    expect(validateObjectStorageEvidence(expired, { now: '2026-10-01T00:00:00Z' })).toContain('evidence has expired')

    const reversed = structuredClone(evidence)
    reversed.expires_at = reversed.generated_at
    expect(validateObjectStorageEvidence(reversed, { now: '2026-08-29T00:00:00Z' })).toEqual(expect.arrayContaining([
      'expires_at must be later than generated_at',
    ]))
  })
  it('rejects tampering, another trust root, and mismatched release deployment bindings', () => {
    const tampered = structuredClone(evidence)
    tampered.bucket = 'attacker-bucket'
    expect(validateObjectStorageEvidence(tampered, bindings)).toContain('signature_base64 is invalid')

    const otherKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString()
    expect(validateObjectStorageEvidence(evidence, { ...bindings, publicKeyPem: otherKey })).toContain('signature_base64 is invalid')
    expect(validateObjectStorageEvidence(evidence, { ...bindings, expectedDeploymentNonce: 'another_deployment_nonce_123' })).toContain('deployment_nonce must match another_deployment_nonce_123')
    expect(validateObjectStorageEvidence(evidence, { ...bindings, expectedConfigChecksum: 'd'.repeat(64) })).toContain(`source_binding.config_checksum must match rendered production config ${'d'.repeat(64)}`)
  })
  it('rejects stale and future attestations', () => {
    expect(validateObjectStorageEvidence(evidence, { ...bindings, now: '2026-08-31T04:00:00Z' })).toContain('evidence is stale')
    expect(validateObjectStorageEvidence(evidence, { ...bindings, now: '2026-08-29T03:00:00Z' })).toContain('attested_at must not be in the future')
  })
  it('rejects retention or restore observations outside the signed evidence interval', () => {
    const invalid = structuredClone(evidence)
    invalid.retention_evidence.verified_at = '2026-08-29T00:59:59Z'
    invalid.restore_evidence.restored_at = '2026-08-29T03:30:01Z'
    expect(validateObjectStorageEvidence(invalid, bindings)).toEqual(expect.arrayContaining([
      'retention_evidence.verified_at must not be before generated_at',
      'restore_evidence.restored_at must not be after attested_at',
    ]))
  })
})
