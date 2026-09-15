import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { produceObjectStorageEvidence } from '../scripts/produce-object-storage-evidence.js'
import { validateObjectStorageEvidence } from './object-storage-evidence-gate.js'

const ids = ['quarantine_clean_metadata', 'version_restore', 'integrity_sample', 'deletion_protection', 'orphan_recovery', 'generated_video_archive'] as const
const releaseId = 'release-oss-v2'
const observedAt = '2026-09-14T08:00:00.000Z'
const now = '2026-09-14T09:00:00.000Z'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oss-v2-producer-')); mkdirSync(join(root, 'raw'))
  const put = (name: string, value: unknown) => { const path = join(root, 'raw', name); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); return path }
  const bucket = 'merchant-assets-production'
  const canaryPath = put('canary.json', { schema_version: '1', state: 'ready', release_id: releaseId, environment: 'production', simulated: false, provider: 'aliyun-oss', bucket, endpoint: 'https://s3.oss-cn-beijing.aliyuncs.com', region: 'cn-beijing', canary_prefix: 'merchant-assets/canary/release-oss-v2/run/', object_key_sha256: '1'.repeat(64), payload_sha256: '2'.repeat(64), encryption: 'AES256', checks: ['put', 'head', 'get_hash', 'encryption', 'delete'].map(id => ({ id, state: 'passed' })), observed_at: observedAt })
  const endpoint = 'https://s3.oss-cn-beijing.aliyuncs.com'
  const lifecyclePolicyId = 'store-nova-merchant-assets-retention'
  const controlPlanePath = put('control.json', { schema_version: '1', provider: 'aliyun-oss', mode: 'read-only', bucket_sha256: createHash('sha256').update(bucket).digest('hex'), region: 'cn-beijing', endpoint_sha256: createHash('sha256').update(endpoint).digest('hex'), lifecycle_rule_id_sha256: createHash('sha256').update(lifecyclePolicyId).digest('hex'), observed_at: observedAt, ready: true, checks: { versioning_enabled: { state: 'passed', observed: true }, lifecycle_enabled_rules: { state: 'passed', observed: 1 }, public_access_blocked: { state: 'passed', observed: true } } })
  const restorePath = put('restore.json', { schema_version: '1', release_id: releaseId, environment: 'production', simulated: false, target_isolated: true, restored_at: observedAt, backup_checksum_sha256: '9'.repeat(64) })
  const checkPaths = Object.fromEntries(ids.map(id => [id, put(`${id}.json`, { schema_version: '1', id, state: 'passed', release_id: releaseId, environment: 'production', simulated: false, observed_at: observedAt })])) as Record<typeof ids[number], string>
  const pair = generateKeyPairSync('ed25519'); const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(); const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const outputPath = join(root, 'evidence-v2.json')
  const input = { artifactRoot: root, outputPath, privateKeyPem, publicKeyPem, keyId: 'storage-attestor-2026', releaseId, releaseGitSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), imageSetDigest: `sha256:${'c'.repeat(64)}`, deploymentNonce: 'deployment_nonce_oss_123456', configChecksum: 'd'.repeat(64), bucket, endpoint, region: 'cn-beijing', encryption: 'AES256' as const, lifecyclePolicyId, retentionDays: 90, expiresAt: '2026-09-15T09:00:00.000Z', canaryPath, controlPlanePath, restorePath, checkPaths, now: () => new Date(now) }
  return { root, outputPath, input, publicKeyPem }
}

describe('object storage schema v2 evidence producer', () => {
  it('assembles real raw artifacts, signs them and produces gate-consumable evidence', () => {
    const { root, outputPath, input, publicKeyPem } = fixture()
    const evidence = produceObjectStorageEvidence(input)
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(evidence)
    expect(evidence.checks).toHaveLength(6)
    expect(evidence.attestation_ref).toMatch(/^artifact:\/\/production\/raw\/canary\.json#[a-f0-9]{64}$/u)
    expect(validateObjectStorageEvidence(evidence, { expectedReleaseId: releaseId, expectedReleaseGitSha: input.releaseGitSha, expectedManifestSha256: input.manifestSha256, expectedImageSetDigest: input.imageSetDigest, expectedDeploymentNonce: input.deploymentNonce, expectedConfigChecksum: input.configChecksum, expectedBucket: input.bucket, expectedEndpoint: input.endpoint, expectedEncryption: 'AES256', artifactRoot: root, trustedKeyId: input.keyId, publicKeyPem, now })).toEqual([])
  })

  it('fails closed when raw control-plane or business-check evidence is not genuine and complete', () => {
    const badControl = fixture(); writeFileSync(badControl.input.controlPlanePath, JSON.stringify({ schema_version: '1', provider: 'aliyun-oss', mode: 'read-only', ready: false }))
    expect(() => produceObjectStorageEvidence(badControl.input)).toThrow('OBJECT_STORAGE_EVIDENCE_CONTROL_PLANE_NOT_READY')
    const badCheck = fixture(); writeFileSync(badCheck.input.checkPaths.orphan_recovery, JSON.stringify({ schema_version: '1', id: 'orphan_recovery', state: 'passed', release_id: releaseId, environment: 'production', simulated: true }))
    expect(() => produceObjectStorageEvidence(badCheck.input)).toThrow('OBJECT_STORAGE_EVIDENCE_CHECK_ORPHAN_RECOVERY_INVALID')
  })

  it('rejects artifacts outside the immutable artifact root and refuses output overwrite', () => {
    const value = fixture(); const outside = join(mkdtempSync(join(tmpdir(), 'oss-outside-')), 'canary.json'); writeFileSync(outside, '{}')
    expect(() => produceObjectStorageEvidence({ ...value.input, canaryPath: outside })).toThrow('OBJECT_STORAGE_EVIDENCE_ARTIFACT_OUTSIDE_ROOT')
    produceObjectStorageEvidence(value.input)
    expect(() => produceObjectStorageEvidence(value.input)).toThrow(/EEXIST/u)
  })

  it('rejects stale and cross-configuration control-plane artifacts', () => {
    const wrongRegion = fixture()
    const control = JSON.parse(readFileSync(wrongRegion.input.controlPlanePath, 'utf8'))
    writeFileSync(wrongRegion.input.controlPlanePath, JSON.stringify({ ...control, region: 'cn-hangzhou' }))
    expect(() => produceObjectStorageEvidence(wrongRegion.input)).toThrow('OBJECT_STORAGE_EVIDENCE_CONTROL_PLANE_REGION_MISMATCH')

    const stale = fixture()
    const canary = JSON.parse(readFileSync(stale.input.canaryPath, 'utf8'))
    writeFileSync(stale.input.canaryPath, JSON.stringify({ ...canary, observed_at: '2026-09-12T08:00:00.000Z' }))
    expect(() => produceObjectStorageEvidence(stale.input)).toThrow('OBJECT_STORAGE_EVIDENCE_CANARY_STALE')
  })
})
