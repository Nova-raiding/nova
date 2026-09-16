import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const artifact = /^artifact:\/\/production\/[A-Za-z0-9._/-]+#[a-f0-9]{64}$/u
const hex = /^[a-f0-9]{64}$/u

type CutoverEvidence = {
  schema_version?: string
  release_id?: string
  environment?: string
  generated_at?: string
  expires_at?: string
  simulated?: boolean
  source?: string
  database_identity_sha256?: string
  cutover_state?: string
  canonical_read_mode?: string
  canonical_read_enabled?: boolean
  workspace_count?: number
  shadow_check_cycles?: number
  status_counts?: Record<string, number>
  evidence_ref?: string
  rollback_evidence_ref?: string
}

function validateArtifact(reference: string | undefined, root: string, label: string): string[] {
  if (!artifact.test(reference ?? '')) return [`${label} must be an immutable production artifact`]
  const relative = reference!.slice('artifact://production/'.length).split('#')[0]!
  if (relative.split('/').some(segment => !segment || segment === '.' || segment === '..')) return [`${label} contains an invalid artifact path`]
  try {
    const realRoot = realpathSync(root); const candidate = resolve(realRoot, relative)
    if (!candidate.startsWith(`${realRoot}${sep}`)) return [`${label} escapes the artifact root`]
    const stat = lstatSync(candidate)
    if (stat.isSymbolicLink() || !stat.isFile()) return [`${label} must resolve to a regular non-symlink artifact`]
    const realCandidate = realpathSync(candidate)
    if (!realCandidate.startsWith(`${realRoot}${sep}`)) return [`${label} escapes the artifact root`]
    const hash = createHash('sha256'); const descriptor = openSync(realCandidate, 'r'); const buffer = Buffer.allocUnsafe(64 * 1024)
    try { for (let bytes = readSync(descriptor, buffer, 0, buffer.length, null); bytes > 0; bytes = readSync(descriptor, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, bytes)) }
    finally { closeSync(descriptor) }
    if (hash.digest('hex') !== reference!.split('#')[1]) return [`${label} SHA-256 does not match the referenced artifact`]
  } catch { return [`${label} referenced artifact does not exist or cannot be read`] }
  return []
}

export function validateCanonicalProductCutoverEvidence(document: unknown, options: { expectedReleaseId?: string; artifactRoot?: string; now?: Date } = {}): string[] {
  const errors: string[] = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as CutoverEvidence
  if (value.schema_version !== '1') errors.push('schema_version must be 1')
  if (typeof value.release_id !== 'string' || !value.release_id.trim()) errors.push('release_id is required')
  if (options.expectedReleaseId && value.release_id !== options.expectedReleaseId) errors.push(`release_id must match ${options.expectedReleaseId}`)
  if (value.environment !== 'production') errors.push('environment must be production')
  for (const field of ['generated_at', 'expires_at'] as const) if (typeof value[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value[field]!) || Number.isNaN(Date.parse(value[field]!))) errors.push(`${field} must be a strict UTC ISO timestamp`)
  const generatedAt = Date.parse(value.generated_at ?? ''); const expiresAt = Date.parse(value.expires_at ?? ''); const now = (options.now ?? new Date()).getTime()
  if (Number.isFinite(generatedAt) && generatedAt > now + 300_000) errors.push('generated_at must not be in the future')
  if (Number.isFinite(generatedAt) && now - generatedAt > 24 * 3_600_000) errors.push('cutover evidence is stale')
  if (Number.isFinite(generatedAt) && Number.isFinite(expiresAt) && expiresAt <= generatedAt) errors.push('expires_at must be after generated_at')
  if (Number.isFinite(generatedAt) && Number.isFinite(expiresAt) && expiresAt - generatedAt > 24 * 3_600_000) errors.push('cutover evidence validity must not exceed 24 hours')
  if (Number.isFinite(expiresAt) && expiresAt <= now) errors.push('cutover evidence is expired')
  if (value.simulated !== false) errors.push('simulated must be false')
  if (value.source !== 'production_database') errors.push('source must be production_database')
  if (!hex.test(value.database_identity_sha256 ?? '')) errors.push('database_identity_sha256 must be a SHA-256 digest')
  if (value.cutover_state !== 'not_cut_over') errors.push('cutover_state must be not_cut_over until canonical cutover is externally verified')
  if (value.canonical_read_mode !== 'legacy_shadow') errors.push('canonical_read_mode must be legacy_shadow for the current release')
  if (value.canonical_read_enabled !== false) errors.push('canonical_read_enabled must be false for the current release')
  if (!Number.isInteger(value.workspace_count) || value.workspace_count! < 1) errors.push('workspace_count must be a positive integer')
  if (!Number.isInteger(value.shadow_check_cycles) || value.shadow_check_cycles! < 2) errors.push('shadow_check_cycles must be at least two consecutive cycles')
  const statuses = value.status_counts
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) errors.push('status_counts is required')
  else for (const [name, count] of Object.entries(statuses)) if (!Number.isInteger(count) || count < 0) errors.push(`status_counts.${name} must be a non-negative integer`)
  if (!artifact.test(value.evidence_ref ?? '')) errors.push('evidence_ref must be an immutable production artifact')
  else if (options.artifactRoot) errors.push(...validateArtifact(value.evidence_ref, options.artifactRoot, 'evidence_ref'))
  if (!artifact.test(value.rollback_evidence_ref ?? '')) errors.push('rollback_evidence_ref must be an immutable production artifact')
  else if (options.artifactRoot) errors.push(...validateArtifact(value.rollback_evidence_ref, options.artifactRoot, 'rollback_evidence_ref'))
  if (value.evidence_ref === value.rollback_evidence_ref) errors.push('rollback_evidence_ref must differ from evidence_ref')
  return errors
}

function arg(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function main() {
  const file = arg('--file'); const releaseId = arg('--release-id'); const artifactRoot = arg('--artifact-root')
  if (!file || !releaseId || !artifactRoot) { console.error('--file, --release-id and --artifact-root are required'); process.exit(2) }
  let document: unknown
  try { document = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { console.error(`unable to read canonical cutover evidence: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }
  const errors = validateCanonicalProductCutoverEvidence(document, { expectedReleaseId: releaseId, artifactRoot })
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log(`canonical product cutover evidence gate passed: ${file} (current release remains legacy_shadow; no cutover claim)`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
