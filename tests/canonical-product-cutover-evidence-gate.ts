import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { canonicalSafeStateBindingFromEnvironment, validateCanonicalSafeStateAttestation, type CanonicalSafeStateBinding, type CanonicalSafeStateSourcePolicy } from '../infra/protected/canonical-safe-state-attestation.mjs'

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
  shadow_cycles?: Array<{ cycle_id?: string; source_ref?: string; completed_at?: string }>
  status_counts?: Record<string, number>
  evidence_ref?: string
  rollback_evidence_ref?: string
}

function readArtifact(reference: string | undefined, root: string, label: string, readContent = false): { errors: string[]; bytes?: Buffer } {
  if (!artifact.test(reference ?? '')) return { errors: [`${label} must be an immutable production artifact`] }
  const relative = reference!.slice('artifact://production/'.length).split('#')[0]!
  if (relative.split('/').some(segment => !segment || segment === '.' || segment === '..')) return { errors: [`${label} contains an invalid artifact path`] }
  try {
    const realRoot = realpathSync(root); const candidate = resolve(realRoot, relative)
    if (!candidate.startsWith(`${realRoot}${sep}`)) return { errors: [`${label} escapes the artifact root`] }
    const stat = lstatSync(candidate)
    if (stat.isSymbolicLink() || !stat.isFile()) return { errors: [`${label} must resolve to a regular non-symlink artifact`] }
    const realCandidate = realpathSync(candidate)
    if (!realCandidate.startsWith(`${realRoot}${sep}`)) return { errors: [`${label} escapes the artifact root`] }
    if (readContent && (stat.size === 0 || stat.size > 1_048_576)) return { errors: [`${label} must be a nonempty JSON artifact at most 1 MiB`] }
    const hash = createHash('sha256'); const descriptor = openSync(realCandidate, 'r'); const buffer = Buffer.allocUnsafe(64 * 1024); const chunks: Buffer[] = []; let total = 0
    try { for (let length = readSync(descriptor, buffer, 0, buffer.length, null); length > 0; length = readSync(descriptor, buffer, 0, buffer.length, null)) { total += length; if (readContent && total > 1_048_576) return { errors: [`${label} must be a nonempty JSON artifact at most 1 MiB`] }; const chunk = buffer.subarray(0, length); hash.update(chunk); if (readContent) chunks.push(Buffer.from(chunk)) } }
    finally { closeSync(descriptor) }
    if (hash.digest('hex') !== reference!.split('#')[1]) return { errors: [`${label} SHA-256 does not match the referenced artifact`] }
    return { errors: [], ...(readContent ? { bytes: Buffer.concat(chunks) } : {}) }
  } catch { return { errors: [`${label} referenced artifact does not exist or cannot be read`] } }
}

function validateArtifact(reference: string | undefined, root: string, label: string): string[] { return readArtifact(reference, root, label).errors }

const strictTimestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) && !Number.isNaN(Date.parse(value))
const countNames = ['verified', 'backfilled', 'legacy_only', 'conflict', 'blocked'] as const
function validCounts(value: unknown): value is Record<string, number> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...countNames].sort().join(',')
    && countNames.every(name => Number.isSafeInteger((value as Record<string, unknown>)[name]) && Number((value as Record<string, unknown>)[name]) >= 0)
}
function sameCounts(left: unknown, right: unknown): boolean {
  if (!left || typeof left !== 'object' || !right || typeof right !== 'object') return false
  return countNames.every(name => (left as Record<string, unknown>)[name] === (right as Record<string, unknown>)[name])
}

type SafeStateTrust = {
  expectedBinding: CanonicalSafeStateBinding
  expectedSourcePolicy: CanonicalSafeStateSourcePolicy
  trustedKeyId: string
  publicKeyPem: string
}
export function validateCanonicalProductCutoverEvidence(document: unknown, options: { expectedReleaseId?: string; artifactRoot?: string; safeStateTrust?: SafeStateTrust; now?: Date } = {}): string[] {
  const errors: string[] = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as CutoverEvidence
  if ((document as Record<string, unknown>).evidence_purpose === 'ordinary_release_safe_state') {
    if (options.expectedReleaseId && value.release_id !== options.expectedReleaseId) errors.push(`release_id must match ${options.expectedReleaseId}`)
    if (!options.safeStateTrust) errors.push('ordinary release requires protected source policy, candidate binding, and independent Ed25519 source attestation')
    else errors.push(...validateCanonicalSafeStateAttestation(document, { ...options.safeStateTrust, ...(options.now ? { now: options.now } : {}) }))
    return errors
  }
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
  if (!Array.isArray(value.shadow_cycles) || value.shadow_cycles.length < 2 || value.shadow_cycles.length !== value.shadow_check_cycles) errors.push('shadow_cycles must enumerate every consecutive cycle')
  else {
    const seenIds = new Set<string>(); const seenRefs = new Set<string>(); let previous = -Infinity
    for (const [index, cycle] of value.shadow_cycles.entries()) {
      const label = `shadow_cycles[${index}]`
      if (!cycle || typeof cycle !== 'object' || Array.isArray(cycle)) { errors.push(`${label} must be an object`); continue }
      if (typeof cycle.cycle_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(cycle.cycle_id) || seenIds.has(cycle.cycle_id)) errors.push(`${label}.cycle_id must be distinct and stable`)
      else seenIds.add(cycle.cycle_id)
      if (!artifact.test(cycle.source_ref ?? '') || !cycle.source_ref?.startsWith('artifact://production/canonical/shadow-cycles/') || seenRefs.has(cycle.source_ref!)) errors.push(`${label}.source_ref must be a distinct immutable production shadow-cycle artifact`)
      else seenRefs.add(cycle.source_ref!)
      if (!strictTimestamp(cycle.completed_at) || Date.parse(cycle.completed_at) <= previous || (Number.isFinite(generatedAt) && Date.parse(cycle.completed_at) > generatedAt)) errors.push(`${label}.completed_at must follow the previous cycle and precede generated_at`)
      else previous = Date.parse(cycle.completed_at)
      if (options.artifactRoot && artifact.test(cycle.source_ref ?? '')) {
        const source = readArtifact(cycle.source_ref, options.artifactRoot, `${label}.source_ref`, true)
        errors.push(...source.errors)
        if (source.bytes) {
          let observed: Record<string, unknown>
          try { observed = JSON.parse(source.bytes.toString('utf8')) as Record<string, unknown> } catch { errors.push(`${label}.source_ref must contain JSON`); continue }
          const counts = observed && typeof observed === 'object' ? observed.status_counts : undefined
          if (!observed || typeof observed !== 'object' || observed.schema_version !== 'canonical-shadow-cycle/1' || observed.release_id !== value.release_id || observed.database_identity_sha256 !== value.database_identity_sha256 || observed.cycle_id !== cycle.cycle_id || observed.completed_at !== cycle.completed_at || observed.source !== 'production_database' || observed.read_only_transaction !== true || observed.simulated !== false || observed.canonical_read_mode !== 'legacy_shadow' || observed.workspace_count !== value.workspace_count || !validCounts(counts) || (index === value.shadow_cycles.length - 1 && !sameCounts(counts, value.status_counts))) errors.push(`${label}.source_ref provenance or summary mismatch`)
        }
      }
    }
  }
  const statuses = value.status_counts
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) errors.push('status_counts is required')
  else for (const [name, count] of Object.entries(statuses)) if (!Number.isInteger(count) || count < 0) errors.push(`status_counts.${name} must be a non-negative integer`)
  if (!artifact.test(value.evidence_ref ?? '')) errors.push('evidence_ref must be an immutable production artifact')
  else if (options.artifactRoot) errors.push(...validateArtifact(value.evidence_ref, options.artifactRoot, 'evidence_ref'))
  if (!artifact.test(value.rollback_evidence_ref ?? '')) errors.push('rollback_evidence_ref must be an immutable production artifact')
  else if (options.artifactRoot) errors.push(...validateArtifact(value.rollback_evidence_ref, options.artifactRoot, 'rollback_evidence_ref'))
  if (value.evidence_ref === value.rollback_evidence_ref) errors.push('rollback_evidence_ref must differ from evidence_ref')
  // Immutable bytes prove only that a self-declared file has not changed. The
  // production gate remains closed until a protected, read-only database
  // collector and independent source-provenance verifier are wired here.
  errors.push('shadow cycles require protected read-only database collection and independent provenance verification')
  return errors
}

function arg(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }

function readProtectedTrustFile(path: string, limit: number): Buffer {
  if (!path.startsWith('/run/release-security/evidence-trust/') || realpathSync(path) !== path) throw new Error('canonical safe-state trust path is not fixed and canonical')
  let sawTrustRoot = false
  for (let current = path; current !== '/'; current = dirname(current)) {
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error('canonical safe-state trust path is not root-protected')
    if (current === '/run/release-security/evidence-trust') sawTrustRoot = true
  }
  const filesystemRoot = lstatSync('/')
  if (!sawTrustRoot || filesystemRoot.uid !== 0 || (filesystemRoot.mode & 0o022) !== 0) throw new Error('canonical safe-state trust path is not rooted under protected evidence-trust')
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size < 1 || stat.size > limit) throw new Error('canonical safe-state trust file is invalid')
    const bytes = readFileSync(descriptor)
    if (bytes.length !== stat.size) throw new Error('canonical safe-state trust file changed while reading')
    return bytes
  } finally { closeSync(descriptor) }
}

function safeStateTrustFromHost(): SafeStateTrust {
  const root = '/run/release-security/evidence-trust'
  const policyBytes = readProtectedTrustFile(`${root}/canonical-safe-state-source-policy.json`, 16_384)
  const collectorDigest = readProtectedTrustFile(`${root}/canonical-safe-state-collector-sha256`, 128).toString('utf8').trim()
  const keyBytes = readProtectedTrustFile(`${root}/canonical-safe-state-public.pem`, 8_192)
  const keyId = readProtectedTrustFile(`${root}/canonical-safe-state-key-id`, 128).toString('utf8').trim()
  const policy = JSON.parse(policyBytes.toString('utf8')) as Record<string, unknown>
  if (policy.schema_version !== 'canonical-safe-state-source-policy/1'
    || Object.keys(policy).sort().join(',') !== 'collector_sha256,database_identity,schema_version'
    || !policy.database_identity || typeof policy.database_identity !== 'object'
    || Object.keys(policy.database_identity as Record<string, unknown>).sort().join(',') !== 'database_name_sha256,database_oid,endpoint_sha256,system_identifier_sha256'
    || !/^[a-f0-9]{64}$/u.test(collectorDigest)
    || policy.collector_sha256 !== collectorDigest) throw new Error('protected canonical safe-state source policy or installed collector digest is invalid')
  const expectedBinding = canonicalSafeStateBindingFromEnvironment(process.env)
  const expectedSourcePolicy = { ...policy, source_policy_sha256: createHash('sha256').update(policyBytes).digest('hex') } as CanonicalSafeStateSourcePolicy
  return { expectedBinding, expectedSourcePolicy, trustedKeyId: keyId, publicKeyPem: keyBytes.toString('utf8') }
}

function main() {
  const file = arg('--file'); const releaseId = arg('--release-id'); const artifactRoot = arg('--artifact-root')
  if (!file || !releaseId || !artifactRoot) { console.error('--file, --release-id and --artifact-root are required'); process.exit(2) }
  let document: unknown
  try { document = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { console.error(`unable to read canonical cutover evidence: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }
  let safeStateTrust: SafeStateTrust | undefined
  if (document && typeof document === 'object' && (document as Record<string, unknown>).evidence_purpose === 'ordinary_release_safe_state') {
    try { safeStateTrust = safeStateTrustFromHost() }
    catch (error) { console.error(`unable to load protected ordinary-release safe-state trust: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }
  }
  const errors = validateCanonicalProductCutoverEvidence(document, { expectedReleaseId: releaseId, artifactRoot, ...(safeStateTrust ? { safeStateTrust } : {}) })
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log(`canonical product cutover evidence gate passed: ${file} (current release remains legacy_shadow; no cutover claim)`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
