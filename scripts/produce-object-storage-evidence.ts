import { createHash, createPrivateKey } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { signObjectStorageEvidence, validateObjectStorageEvidence } from '../tests/object-storage-evidence-gate.js'
import type { AliyunOssControlPlaneResult } from './collect-aliyun-oss-control-plane.js'
import type { ObjectStorageCanaryEvidence } from './object-storage-canary.js'

const REQUIRED_CHECKS = ['quarantine_clean_metadata', 'version_restore', 'integrity_sample', 'deletion_protection', 'orphan_recovery', 'generated_video_archive'] as const
type RequiredCheck = typeof REQUIRED_CHECKS[number]
type RawCheck = { schema_version?: string; id?: string; state?: string; release_id?: string; environment?: string; simulated?: boolean }

export type ObjectStorageEvidenceProducerInput = {
  artifactRoot: string
  outputPath: string
  privateKeyPem: string
  publicKeyPem: string
  keyId: string
  releaseId: string
  releaseGitSha: string
  manifestSha256: string
  imageSetDigest: string
  deploymentNonce: string
  configChecksum: string
  bucket: string
  endpoint: string
  region: string
  encryption: 'AES256' | 'aws:kms'
  kmsKeyId?: string
  lifecyclePolicyId: string
  retentionDays: number
  expiresAt: string
  canaryPath: string
  controlPlanePath: string
  restorePath: string
  checkPaths: Record<RequiredCheck, string>
  now?: () => Date
}

function requireValue(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`OBJECT_STORAGE_EVIDENCE_${code}`)
}

function readArtifact(rootInput: string, pathInput: string): { value: any; ref: string } {
  requireValue(isAbsolute(rootInput) && isAbsolute(pathInput), 'ARTIFACT_PATH_MUST_BE_ABSOLUTE')
  const root = realpathSync(rootInput)
  const path = resolve(pathInput)
  const stat = lstatSync(path)
  requireValue(stat.isFile() && !stat.isSymbolicLink(), 'ARTIFACT_NOT_REGULAR_FILE')
  const realPath = realpathSync(path)
  const suffix = relative(root, realPath)
  requireValue(suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix), 'ARTIFACT_OUTSIDE_ROOT')
  const body = readFileSync(realPath)
  let value: unknown
  try { value = JSON.parse(body.toString('utf8')) } catch { throw new Error('OBJECT_STORAGE_EVIDENCE_ARTIFACT_JSON_INVALID') }
  return { value, ref: `artifact://production/${relative(root, realPath).split(sep).join('/')}#${createHash('sha256').update(body).digest('hex')}` }
}

function requireFreshInstant(value: unknown, nowMs: number, code: string) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value), `${code}_TIMESTAMP_INVALID`)
  const timestamp = Date.parse(value)
  requireValue(Number.isFinite(timestamp) && timestamp <= nowMs + 300_000, `${code}_TIMESTAMP_FUTURE`)
  requireValue(nowMs - timestamp <= 24 * 3_600_000, `${code}_STALE`)
}

export function produceObjectStorageEvidence(input: ObjectStorageEvidenceProducerInput) {
  const now = (input.now ?? (() => new Date()))().toISOString()
  const nowMs = Date.parse(now)
  const canaryArtifact = readArtifact(input.artifactRoot, input.canaryPath)
  const canary = canaryArtifact.value as ObjectStorageCanaryEvidence
  requireValue(canary.schema_version === '1' && canary.state === 'ready' && canary.environment === 'production' && canary.simulated === false, 'CANARY_NOT_REAL_READY')
  requireValue(canary.release_id === input.releaseId && canary.bucket === input.bucket && canary.endpoint === input.endpoint && canary.encryption === input.encryption, 'CANARY_BINDING_MISMATCH')
  requireValue(canary.region === input.region, 'CANARY_REGION_MISMATCH')
  requireFreshInstant(canary.observed_at, nowMs, 'CANARY')
  requireValue(Array.isArray(canary.checks) && ['put', 'head', 'get_hash', 'encryption', 'delete', 'delete_verified'].every(id => canary.checks.some(check => check.id === id && check.state === 'passed')), 'CANARY_CHECKS_INCOMPLETE')

  const controlArtifact = readArtifact(input.artifactRoot, input.controlPlanePath)
  const control = controlArtifact.value as AliyunOssControlPlaneResult
  requireValue(control.schema_version === '1' && control.provider === 'aliyun-oss' && control.mode === 'read-only' && control.ready === true, 'CONTROL_PLANE_NOT_READY')
  requireValue(control.bucket_sha256 === createHash('sha256').update(input.bucket).digest('hex'), 'CONTROL_PLANE_BUCKET_MISMATCH')
  requireValue(control.region === input.region, 'CONTROL_PLANE_REGION_MISMATCH')
  requireValue(control.endpoint_sha256 === createHash('sha256').update(input.endpoint).digest('hex'), 'CONTROL_PLANE_ENDPOINT_MISMATCH')
  requireValue(control.lifecycle_rule_id_sha256 === createHash('sha256').update(input.lifecyclePolicyId).digest('hex'), 'CONTROL_PLANE_LIFECYCLE_MISMATCH')
  requireFreshInstant(control.observed_at, nowMs, 'CONTROL_PLANE')
  requireValue(Object.values(control.checks ?? {}).length === 3 && Object.values(control.checks).every(check => check.state === 'passed'), 'CONTROL_PLANE_CHECKS_INCOMPLETE')

  const restoreArtifact = readArtifact(input.artifactRoot, input.restorePath)
  const restore = restoreArtifact.value as { schema_version?: string; release_id?: string; environment?: string; simulated?: boolean; target_isolated?: boolean; restored_at?: string; backup_checksum_sha256?: string }
  requireValue(restore.schema_version === '1' && restore.release_id === input.releaseId && restore.environment === 'production' && restore.simulated === false && restore.target_isolated === true, 'RESTORE_NOT_REAL_ISOLATED')
  requireValue(typeof restore.restored_at === 'string' && Number.isFinite(Date.parse(restore.restored_at)) && /^[a-f0-9]{64}$/u.test(restore.backup_checksum_sha256 ?? ''), 'RESTORE_INVALID')
  requireFreshInstant(restore.restored_at, nowMs, 'RESTORE')

  const checks = REQUIRED_CHECKS.map(id => {
    const artifact = readArtifact(input.artifactRoot, input.checkPaths[id])
    const check = artifact.value as RawCheck
    requireValue(check.schema_version === '1' && check.id === id && check.state === 'passed' && check.release_id === input.releaseId && check.environment === 'production' && check.simulated === false, `CHECK_${id.toUpperCase()}_INVALID`)
    requireFreshInstant((check as RawCheck & { observed_at?: string }).observed_at, nowMs, `CHECK_${id.toUpperCase()}`)
    return { id, state: 'passed', evidence_ref: artifact.ref }
  })

  const unsigned = {
    schema_version: '2', release_id: input.releaseId, release_git_sha: input.releaseGitSha, manifest_sha256: input.manifestSha256,
    image_set_digest: input.imageSetDigest, deployment_nonce: input.deploymentNonce, key_id: input.keyId, environment: 'production',
    generated_at: canary.observed_at, attested_at: now, expires_at: input.expiresAt, provider: canary.provider, bucket: input.bucket,
    endpoint: input.endpoint, versioning: true, public_access_blocked: true, server_side_encryption: input.encryption,
    ...(input.encryption === 'aws:kms' ? { kms_key_id: input.kmsKeyId } : {}), lifecycle_policy_id: input.lifecyclePolicyId,
    simulated: false, attestation_ref: canaryArtifact.ref,
    source_binding: { release_id: input.releaseId, provider: canary.provider, bucket: input.bucket, endpoint: input.endpoint, config_checksum: input.configChecksum, evidence_ref: controlArtifact.ref },
    retention_evidence: { policy_id: input.lifecyclePolicyId, retention_days: input.retentionDays, verified_at: control.observed_at, evidence_ref: controlArtifact.ref },
    restore_evidence: { target_isolated: true, restored_at: restore.restored_at!, backup_checksum_sha256: restore.backup_checksum_sha256!, evidence_ref: restoreArtifact.ref },
    checks,
  }
  const key = createPrivateKey(input.privateKeyPem)
  requireValue(key.asymmetricKeyType === 'ed25519', 'SIGNING_KEY_MUST_BE_ED25519')
  const evidence = { ...unsigned, signature_base64: signObjectStorageEvidence(unsigned, input.privateKeyPem) }
  const errors = validateObjectStorageEvidence(evidence, {
    expectedReleaseId: input.releaseId, expectedReleaseGitSha: input.releaseGitSha, expectedManifestSha256: input.manifestSha256,
    expectedImageSetDigest: input.imageSetDigest, expectedDeploymentNonce: input.deploymentNonce, expectedConfigChecksum: input.configChecksum,
    expectedBucket: input.bucket, expectedEndpoint: input.endpoint, expectedEncryption: input.encryption, artifactRoot: input.artifactRoot,
    trustedKeyId: input.keyId, publicKeyPem: input.publicKeyPem, now,
  })
  requireValue(errors.length === 0, `GATE_REJECTED:${errors.join('|')}`)
  writeFileSync(input.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return evidence
}

function arg(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function requiredArg(name: string) { const value = arg(name); if (!value) throw new Error(`${name} is required`); return value }
export function main() {
  const checkPaths = Object.fromEntries(REQUIRED_CHECKS.map(id => [id, requiredArg(`--check-${id.replaceAll('_', '-')}`)])) as Record<RequiredCheck, string>
  const privateKeyPath = requiredArg('--private-key'), publicKeyPath = requiredArg('--public-key')
  const encryption = requiredArg('--encryption'); requireValue(encryption === 'AES256' || encryption === 'aws:kms', 'ENCRYPTION_INVALID')
  const retentionDays = Number(requiredArg('--retention-days')); requireValue(Number.isSafeInteger(retentionDays) && retentionDays > 0, 'RETENTION_DAYS_INVALID')
  produceObjectStorageEvidence({
    artifactRoot: requiredArg('--artifact-root'), outputPath: requiredArg('--output'), privateKeyPem: readFileSync(privateKeyPath, 'utf8'), publicKeyPem: readFileSync(publicKeyPath, 'utf8'),
    keyId: requiredArg('--key-id'), releaseId: requiredArg('--release-id'), releaseGitSha: requiredArg('--release-git-sha'), manifestSha256: requiredArg('--manifest-sha256'),
    imageSetDigest: requiredArg('--image-set-digest'), deploymentNonce: requiredArg('--deployment-nonce'), configChecksum: requiredArg('--config-checksum'), bucket: requiredArg('--bucket'),
    endpoint: requiredArg('--endpoint'), region: requiredArg('--region'), encryption, ...(arg('--kms-key-id') ? { kmsKeyId: arg('--kms-key-id') } : {}), lifecyclePolicyId: requiredArg('--lifecycle-policy-id'),
    retentionDays, expiresAt: requiredArg('--expires-at'), canaryPath: requiredArg('--canary'), controlPlanePath: requiredArg('--control-plane'), restorePath: requiredArg('--restore'), checkPaths,
  })
  console.log('object storage schema v2 evidence produced and independently gate-validated')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
