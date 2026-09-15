import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const REQUIRED_CHECKS = ['quarantine_clean_metadata', 'version_restore', 'integrity_sample', 'deletion_protection', 'orphan_recovery', 'generated_video_archive'] as const
type StorageCheck = { id?: string; state?: string; evidence_ref?: string }
type StorageEvidence = {
  schema_version?: string; release_id?: string; release_git_sha?: string; manifest_sha256?: string; image_set_digest?: string
  deployment_nonce?: string; key_id?: string; signature_base64?: string; environment?: string; generated_at?: string; attested_at?: string; expires_at?: string
  provider?: string; bucket?: string; endpoint?: string; versioning?: boolean; public_access_blocked?: boolean
  server_side_encryption?: 'AES256' | 'aws:kms'; kms_key_id?: string; lifecycle_policy_id?: string; simulated?: boolean; attestation_ref?: string
  source_binding?: { release_id?: string; provider?: string; bucket?: string; endpoint?: string; config_checksum?: string; evidence_ref?: string }
  retention_evidence?: { policy_id?: string; retention_days?: number; verified_at?: string; evidence_ref?: string }
  restore_evidence?: { target_isolated?: boolean; restored_at?: string; backup_checksum_sha256?: string; evidence_ref?: string }
  checks?: StorageCheck[]
}
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const iso = (value: unknown) => text(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) && Number.isFinite(Date.parse(value))
const compareCodeUnits = ([left]: [string, unknown], [right]: [string, unknown]) => left < right ? -1 : left > right ? 1 : 0
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'signature_base64').sort(compareCodeUnits).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`; return JSON.stringify(value) }
const payload = (value: unknown) => Buffer.from(canonical(value))
/** Used by the independent evidence producer and tests; release gates receive no private key. */
export const signObjectStorageEvidence = (value: unknown, privateKeyPem: string) => sign(null, payload(value), privateKeyPem).toString('base64')
const forbidden = /(?:local|localhost|127\.0\.0\.1|mock|fixture|file:)/iu
const artifact = /^artifact:\/\/production\/[A-Za-z0-9._/-]+#[a-f0-9]{64}$/u

function validateArtifact(reference: string | undefined, root: string, label: string): string[] {
  const match = artifact.exec(reference ?? '')
  if (!match) return [`${label} must be an immutable production artifact`]
  const relative = reference!.slice('artifact://production/'.length).split('#')[0]!
  if (relative.split('/').some(segment => segment === '.' || segment === '..' || segment.length === 0)) return [`${label} contains an invalid artifact path`]
  try {
    const realRoot = realpathSync(root)
    const candidate = resolve(realRoot, relative)
    if (candidate !== realRoot && !candidate.startsWith(`${realRoot}${sep}`)) return [`${label} escapes the artifact root`]
    const stat = lstatSync(candidate)
    if (stat.isSymbolicLink() || !stat.isFile()) return [`${label} must resolve to a regular non-symlink artifact`]
    const realCandidate = realpathSync(candidate)
    if (!realCandidate.startsWith(`${realRoot}${sep}`)) return [`${label} escapes the artifact root`]
    const hash = createHash('sha256')
    const descriptor = openSync(realCandidate, 'r')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    try { for (let bytes = readSync(descriptor, buffer, 0, buffer.length, null); bytes > 0; bytes = readSync(descriptor, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, bytes)) }
    finally { closeSync(descriptor) }
    if (hash.digest('hex') !== match[0].split('#')[1]) return [`${label} SHA-256 does not match the referenced artifact`]
  } catch { return [`${label} referenced artifact does not exist or cannot be read`] }
  return []
}

export function validateObjectStorageEvidence(document: unknown, options: { expectedReleaseId?: string; expectedReleaseGitSha?: string; expectedManifestSha256?: string; expectedImageSetDigest?: string; expectedDeploymentNonce?: string; expectedConfigChecksum?: string; expectedBucket?: string; expectedEndpoint?: string; expectedEncryption?: 'AES256' | 'aws:kms'; artifactRoot?: string; trustedKeyId?: string; publicKeyPem?: string; now?: Date | string } = {}): string[] {
  const errors: string[] = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as StorageEvidence
  if (value.schema_version !== '2') errors.push('schema_version must be 2')
  if (!text(value.release_id)) errors.push('release_id is required')
  if (options.expectedReleaseId && value.release_id !== options.expectedReleaseId) errors.push(`release_id must match ${options.expectedReleaseId}`)
  for (const [field, expected] of [['release_git_sha', options.expectedReleaseGitSha], ['manifest_sha256', options.expectedManifestSha256], ['image_set_digest', options.expectedImageSetDigest], ['deployment_nonce', options.expectedDeploymentNonce], ['key_id', options.trustedKeyId]] as const) if (expected && value[field] !== expected) errors.push(`${field} must match ${expected}`)
  if (!/^[a-f0-9]{40}$/u.test(value.release_git_sha ?? '')) errors.push('release_git_sha must be a full lowercase Git SHA')
  if (!/^[a-f0-9]{64}$/u.test(value.manifest_sha256 ?? '')) errors.push('manifest_sha256 must be a SHA-256 hash')
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.image_set_digest ?? '')) errors.push('image_set_digest must be sha256 plus 64 lowercase hex characters')
  if (!/^[A-Za-z0-9_-]{22,128}$/u.test(value.deployment_nonce ?? '')) errors.push('deployment_nonce is invalid')
  if (!text(value.key_id)) errors.push('key_id is required')
  if (value.environment !== 'production') errors.push('environment must be production')
  const generatedAt = text(value.generated_at) ? Date.parse(value.generated_at) : Number.NaN
  const attestedAt = text(value.attested_at) ? Date.parse(value.attested_at) : Number.NaN
  const expiresAt = text(value.expires_at) ? Date.parse(value.expires_at) : Number.NaN
  for (const field of ['generated_at', 'attested_at', 'expires_at'] as const) if (!iso(value[field])) errors.push(`${field} must be a strict UTC ISO timestamp`)
  const now = options.now instanceof Date ? options.now.getTime() : Date.parse(options.now ?? new Date().toISOString())
  if (Number.isFinite(generatedAt) && Number.isFinite(attestedAt) && generatedAt > attestedAt) errors.push('generated_at must not be after attested_at')
  if (Number.isFinite(attestedAt) && attestedAt > now + 300_000) errors.push('attested_at must not be in the future')
  if (Number.isFinite(generatedAt) && generatedAt > now + 300_000) errors.push('generated_at must not be in the future')
  if (Number.isFinite(attestedAt) && now - attestedAt > 24 * 3_600_000) errors.push('evidence is stale')
  if (Number.isFinite(generatedAt) && Number.isFinite(expiresAt) && expiresAt <= generatedAt) errors.push('expires_at must be later than generated_at')
  if (Number.isFinite(expiresAt) && (!Number.isFinite(now) || expiresAt <= now)) errors.push('evidence has expired')
  for (const field of ['provider', 'bucket', 'endpoint', 'lifecycle_policy_id'] as const) { if (!text(value[field])) errors.push(`${field} is required`); else if (forbidden.test(value[field]!)) errors.push(`${field} must identify a real cloud object store`) }
  if (options.expectedBucket && value.bucket !== options.expectedBucket) errors.push(`bucket must match rendered production config ${options.expectedBucket}`)
  if (options.expectedEndpoint && value.endpoint !== options.expectedEndpoint) errors.push(`endpoint must match rendered production config ${options.expectedEndpoint}`)
  if (options.expectedEncryption && value.server_side_encryption !== options.expectedEncryption) errors.push(`server_side_encryption must match rendered production config ${options.expectedEncryption}`)
  try { if (new URL(value.endpoint!).protocol !== 'https:') errors.push('endpoint must use HTTPS') } catch { errors.push('endpoint must be a valid HTTPS URL') }
  const source = value.source_binding
  if (!source || typeof source !== 'object') errors.push('source_binding is required')
  else {
    if (source.release_id !== value.release_id) errors.push('source_binding.release_id must match release_id')
    if (source.provider !== value.provider) errors.push('source_binding.provider must match provider')
    if (source.bucket !== value.bucket) errors.push('source_binding.bucket must match bucket')
    if (source.endpoint !== value.endpoint) errors.push('source_binding.endpoint must match endpoint')
    if (!/^[a-f0-9]{64}$/u.test(source.config_checksum ?? '')) errors.push('source_binding.config_checksum must be a SHA-256 hash')
    if (options.expectedConfigChecksum && source.config_checksum !== options.expectedConfigChecksum) errors.push(`source_binding.config_checksum must match rendered production config ${options.expectedConfigChecksum}`)
    if (!artifact.test(source.evidence_ref ?? '')) errors.push('source_binding.evidence_ref must be an immutable production artifact')
    else if (options.artifactRoot) errors.push(...validateArtifact(source.evidence_ref, options.artifactRoot, 'source_binding.evidence_ref'))
  }
  for (const field of ['versioning', 'public_access_blocked'] as const) if (value[field] !== true) errors.push(`${field} must be true`)
  if (value.server_side_encryption !== 'AES256' && value.server_side_encryption !== 'aws:kms') errors.push('server_side_encryption must be AES256 or aws:kms')
  if (value.server_side_encryption === 'aws:kms' && !text(value.kms_key_id)) errors.push('kms_key_id is required when server_side_encryption is aws:kms')
  if (value.simulated !== false) errors.push('simulated must be false')
  if (!artifact.test(value.attestation_ref ?? '')) errors.push('attestation_ref must be an immutable production artifact')
  else if (options.artifactRoot) errors.push(...validateArtifact(value.attestation_ref, options.artifactRoot, 'attestation_ref'))
  const retention = value.retention_evidence
  if (!retention || typeof retention !== 'object') errors.push('retention_evidence is required')
  else {
    if (retention.policy_id !== value.lifecycle_policy_id) errors.push('retention_evidence.policy_id must match lifecycle_policy_id')
    const retentionDays = retention.retention_days
    if (!Number.isSafeInteger(retentionDays) || typeof retentionDays !== 'number' || retentionDays <= 0) errors.push('retention_evidence.retention_days must be a positive integer')
    if (!text(retention.verified_at) || Number.isNaN(Date.parse(retention.verified_at))) errors.push('retention_evidence.verified_at must be an ISO instant')
    if (!artifact.test(retention.evidence_ref ?? '')) errors.push('retention_evidence.evidence_ref must be an immutable production artifact')
    else if (options.artifactRoot) errors.push(...validateArtifact(retention.evidence_ref, options.artifactRoot, 'retention_evidence.evidence_ref'))
  }
  const restore = value.restore_evidence
  if (!restore || typeof restore !== 'object') errors.push('restore_evidence is required')
  else {
    if (restore.target_isolated !== true) errors.push('restore_evidence.target_isolated must be true')
    if (!text(restore.restored_at) || Number.isNaN(Date.parse(restore.restored_at))) errors.push('restore_evidence.restored_at must be an ISO instant')
    if (!/^[a-f0-9]{64}$/u.test(restore.backup_checksum_sha256 ?? '')) errors.push('restore_evidence.backup_checksum_sha256 must be a SHA-256 hash')
    if (!artifact.test(restore.evidence_ref ?? '')) errors.push('restore_evidence.evidence_ref must be an immutable production artifact')
    else if (options.artifactRoot) errors.push(...validateArtifact(restore.evidence_ref, options.artifactRoot, 'restore_evidence.evidence_ref'))
  }
  if (!Array.isArray(value.checks)) return [...errors, 'checks is required']
  const seen = new Set<string>()
  for (const check of value.checks) { if (!text(check.id)) { errors.push('each check must have an id'); continue }; if (seen.has(check.id)) errors.push(`duplicate check: ${check.id}`); seen.add(check.id); if (check.state !== 'passed') errors.push(`${check.id}.state must be passed`); if (!artifact.test(check.evidence_ref ?? '')) errors.push(`${check.id}.evidence_ref must be an immutable production artifact`); else if (options.artifactRoot) errors.push(...validateArtifact(check.evidence_ref, options.artifactRoot, `${check.id}.evidence_ref`)) }
  for (const id of REQUIRED_CHECKS) if (!seen.has(id)) errors.push(`${id} check is required`)
  if (!text(value.signature_base64)) errors.push('signature_base64 is required')
  else if (!/^[A-Za-z0-9+/]{86}==$/u.test(value.signature_base64)) errors.push('signature_base64 must be a canonical Ed25519 signature')
  else if (!options.publicKeyPem) errors.push('trusted public key is required')
  else try { const key = createPublicKey(options.publicKeyPem); if (key.asymmetricKeyType !== 'ed25519') errors.push('trusted public key must be Ed25519'); else if (!verify(null, payload(value), key, Buffer.from(value.signature_base64, 'base64'))) errors.push('signature_base64 is invalid') } catch { errors.push('trusted public key or signature is invalid') }
  return errors
}

function arg(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function main() { const file = arg('--file'); const releaseId = arg('--release-id'); const expectedBucket = arg('--expected-bucket'); const expectedEndpoint = arg('--expected-endpoint'); const expectedEncryption = arg('--expected-encryption'); const artifactRoot = arg('--artifact-root'); const expectedReleaseGitSha = arg('--release-git-sha'); const expectedManifestSha256 = arg('--manifest-sha256'); const expectedImageSetDigest = arg('--image-set-digest'); const expectedDeploymentNonce = arg('--deployment-nonce'); const expectedConfigChecksum = arg('--expected-config-checksum'); const publicKeyPath = arg('--public-key'); const trustedKeyId = arg('--key-id'); if (!file || !releaseId || !artifactRoot || !expectedReleaseGitSha || !expectedManifestSha256 || !expectedImageSetDigest || !expectedDeploymentNonce || !expectedConfigChecksum || !expectedEncryption || !['AES256', 'aws:kms'].includes(expectedEncryption) || !publicKeyPath || !trustedKeyId) { console.error('file, release, commit, manifest, image set, deployment nonce, config checksum, encryption, artifact root and fixed trust anchor are required'); process.exit(2) }; const publicKeyPem = readFileSync(publicKeyPath, 'utf8'); if (publicKeyPem.includes('UNPROVISIONED') || trustedKeyId === 'UNPROVISIONED') { console.error('object storage evidence trust anchor is not provisioned'); process.exit(1) }; let document: unknown; try { document = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { console.error(`unable to read object storage evidence: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }; const errors = validateObjectStorageEvidence(document, { expectedReleaseId: releaseId, expectedReleaseGitSha, expectedManifestSha256, expectedImageSetDigest, expectedDeploymentNonce, expectedConfigChecksum, expectedBucket, expectedEndpoint, expectedEncryption: expectedEncryption as 'AES256' | 'aws:kms', artifactRoot, publicKeyPem, trustedKeyId }); if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }; console.log(`object storage evidence gate passed: ${file} (signed real production storage requirements validated)`) }
if (import.meta.url === `file://${process.argv[1]}`) main()
