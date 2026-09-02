import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const REQUIRED_CHECKS = ['quarantine_clean_metadata', 'version_restore', 'integrity_sample', 'deletion_protection', 'orphan_recovery', 'generated_video_archive'] as const
type StorageCheck = { id?: string; state?: string; evidence_ref?: string }
type StorageEvidence = {
  schema_version?: string; release_id?: string; environment?: string; generated_at?: string; expires_at?: string
  provider?: string; bucket?: string; endpoint?: string; versioning?: boolean; public_access_blocked?: boolean
  kms_encryption?: boolean; lifecycle_policy_id?: string; simulated?: boolean; attestation_ref?: string
  source_binding?: { release_id?: string; provider?: string; bucket?: string; endpoint?: string; config_checksum?: string; evidence_ref?: string }
  retention_evidence?: { policy_id?: string; retention_days?: number; verified_at?: string; evidence_ref?: string }
  restore_evidence?: { target_isolated?: boolean; restored_at?: string; backup_checksum_sha256?: string; evidence_ref?: string }
  checks?: StorageCheck[]
}
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
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

export function validateObjectStorageEvidence(document: unknown, options: { expectedReleaseId?: string; expectedBucket?: string; expectedEndpoint?: string; artifactRoot?: string; now?: Date | string } = {}): string[] {
  const errors: string[] = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as StorageEvidence
  if (value.schema_version !== '1') errors.push('schema_version must be 1')
  if (!text(value.release_id)) errors.push('release_id is required')
  if (options.expectedReleaseId && value.release_id !== options.expectedReleaseId) errors.push(`release_id must match ${options.expectedReleaseId}`)
  if (value.environment !== 'production') errors.push('environment must be production')
  const generatedAt = text(value.generated_at) ? Date.parse(value.generated_at) : Number.NaN
  const expiresAt = text(value.expires_at) ? Date.parse(value.expires_at) : Number.NaN
  for (const [field, parsed] of [['generated_at', generatedAt], ['expires_at', expiresAt] ] as const) if (!Number.isFinite(parsed)) errors.push(`${field} must be an ISO instant`)
  const now = options.now instanceof Date ? options.now.getTime() : Date.parse(options.now ?? new Date().toISOString())
  if (Number.isFinite(generatedAt) && Number.isFinite(expiresAt) && expiresAt <= generatedAt) errors.push('expires_at must be later than generated_at')
  if (Number.isFinite(expiresAt) && (!Number.isFinite(now) || expiresAt <= now)) errors.push('evidence has expired')
  for (const field of ['provider', 'bucket', 'endpoint', 'lifecycle_policy_id'] as const) { if (!text(value[field])) errors.push(`${field} is required`); else if (forbidden.test(value[field]!)) errors.push(`${field} must identify a real cloud object store`) }
  if (options.expectedBucket && value.bucket !== options.expectedBucket) errors.push(`bucket must match rendered production config ${options.expectedBucket}`)
  if (options.expectedEndpoint && value.endpoint !== options.expectedEndpoint) errors.push(`endpoint must match rendered production config ${options.expectedEndpoint}`)
  try { if (new URL(value.endpoint!).protocol !== 'https:') errors.push('endpoint must use HTTPS') } catch { errors.push('endpoint must be a valid HTTPS URL') }
  const source = value.source_binding
  if (!source || typeof source !== 'object') errors.push('source_binding is required')
  else {
    if (source.release_id !== value.release_id) errors.push('source_binding.release_id must match release_id')
    if (source.provider !== value.provider) errors.push('source_binding.provider must match provider')
    if (source.bucket !== value.bucket) errors.push('source_binding.bucket must match bucket')
    if (source.endpoint !== value.endpoint) errors.push('source_binding.endpoint must match endpoint')
    if (!/^[a-f0-9]{64}$/u.test(source.config_checksum ?? '')) errors.push('source_binding.config_checksum must be a SHA-256 hash')
    if (!artifact.test(source.evidence_ref ?? '')) errors.push('source_binding.evidence_ref must be an immutable production artifact')
    else if (options.artifactRoot) errors.push(...validateArtifact(source.evidence_ref, options.artifactRoot, 'source_binding.evidence_ref'))
  }
  for (const field of ['versioning', 'public_access_blocked', 'kms_encryption'] as const) if (value[field] !== true) errors.push(`${field} must be true`)
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
  return errors
}

function arg(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function main() { const file = arg('--file'); const releaseId = arg('--release-id'); const expectedBucket = arg('--expected-bucket'); const expectedEndpoint = arg('--expected-endpoint'); const artifactRoot = arg('--artifact-root'); if (!file || !releaseId) { console.error('--file and --release-id are required'); process.exit(2) }; if (!artifactRoot) { console.error('--artifact-root is required for production object storage evidence validation'); process.exit(2) }; let document: unknown; try { document = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { console.error(`unable to read object storage evidence: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }; const errors = validateObjectStorageEvidence(document, { expectedReleaseId: releaseId, expectedBucket, expectedEndpoint, artifactRoot }); if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }; console.log(`object storage evidence gate passed: ${file} (real production storage requirements validated)`) }
if (import.meta.url === `file://${process.argv[1]}`) main()
