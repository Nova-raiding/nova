import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export type ProductionEvidenceKind = 'payment' | 'restore'
type Evidence = Record<string, unknown> & { checks?: Record<string, { status?: string; evidence_ref?: string }> }
const checksByKind = { payment: ['checkout', 'callback', 'callback_replay', 'provider_query', 'reconciliation', 'refund'], restore: ['backup_checksum', 'isolated_restore', 'migrations', 'data_integrity', 'application_smoke'] } as const
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const iso = (value: unknown) => text(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) && Number.isFinite(Date.parse(value))
const compareCodeUnits = ([left]: [string, unknown], [right]: [string, unknown]) => left < right ? -1 : left > right ? 1 : 0
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'signature_base64').sort(compareCodeUnits).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`; return JSON.stringify(value) }
const payload = (value: unknown) => Buffer.from(canonical(value))
const artifactRef = /^artifact:\/\/production\/([A-Za-z0-9._/-]+)#([a-f0-9]{64})$/u

function sha256File(path: string) {
  const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024); const descriptor = openSync(path, 'r')
  try { for (let bytes = readSync(descriptor, buffer, 0, buffer.length, null); bytes > 0; bytes = readSync(descriptor, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, bytes)) }
  finally { closeSync(descriptor) }
  return hash.digest('hex')
}

function validateArtifact(reference: string | undefined, root: string, label: string): string[] {
  const match = artifactRef.exec(reference ?? '')
  if (!match) return [`${label} must be an immutable production artifact with SHA-256 fragment`]
  const relative = match[1]!; const expectedHash = match[2]!
  if (relative.split('/').some(segment => segment === '.' || segment === '..' || segment.length === 0)) return [`${label} contains an invalid artifact path`]
  try {
    const realRoot = realpathSync(root); const candidate = resolve(realRoot, relative)
    if (candidate !== realRoot && !candidate.startsWith(`${realRoot}${sep}`)) return [`${label} escapes the artifact root`]
    if (lstatSync(candidate).isSymbolicLink() || !lstatSync(candidate).isFile()) return [`${label} must resolve to a regular non-symlink artifact`]
    const realCandidate = realpathSync(candidate)
    if (!realCandidate.startsWith(`${realRoot}${sep}`)) return [`${label} escapes the artifact root`]
    if (sha256File(realCandidate) !== expectedHash) return [`${label} SHA-256 does not match the referenced artifact`]
  } catch {
    return [`${label} referenced artifact does not exist or cannot be read`]
  }
  return []
}
/** Used by the independent evidence pipeline and tests; preflight receives no private key. */
export const signProductionEvidence = (value: unknown, privateKeyPem: string) => sign(null, payload(value), privateKeyPem).toString('base64')

export function validateProductionEvidence(document: unknown, options: { kind: ProductionEvidenceKind; releaseId: string; imageDigest: string; manifestSha256: string; releaseGitSha: string; deploymentNonce: string; artifactRoot: string; trustedKeyId: string; publicKeyPem: string; now?: Date }): string[] {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as Evidence; const errors: string[] = []; const now = options.now ?? new Date()
  const expected: Record<string, string> = { schema_version: '1', kind: options.kind, release_id: options.releaseId, image_digest: options.imageDigest, manifest_sha256: options.manifestSha256, release_git_sha: options.releaseGitSha, environment: 'production', status: 'pass', key_id: options.trustedKeyId }
  for (const [field, wanted] of Object.entries(expected)) if (value[field] !== wanted) errors.push(`${field} must match ${wanted}`)
  for (const field of ['evidence_id', 'deployment_nonce', 'verified_by', 'signature_base64'] as const) if (!text(value[field])) errors.push(`${field} is required`)
  if (value.simulated !== false) errors.push('simulated must be false')
  if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(String(value.evidence_id ?? ''))) errors.push('evidence_id is invalid')
  if (!/^[A-Za-z0-9_-]{22,128}$/u.test(String(value.deployment_nonce ?? ''))) errors.push('deployment_nonce is invalid')
  if (value.deployment_nonce !== options.deploymentNonce) errors.push('deployment_nonce must match the deployment orchestrator nonce')
  const generated = Date.parse(String(value.generated_at ?? '')); const attested = Date.parse(String(value.attested_at ?? '')); const expires = Date.parse(String(value.expires_at ?? ''))
  for (const field of ['generated_at', 'attested_at', 'expires_at'] as const) if (!iso(value[field])) errors.push(`${field} must be a strict UTC ISO timestamp`)
  if (generated > attested) errors.push('generated_at must not be after attested_at')
  if (attested > now.getTime() + 300_000) errors.push('attested_at must not be in the future')
  if (expires <= now.getTime()) errors.push('evidence has expired')
  const maxAge = options.kind === 'payment' ? 24 : 168
  if (Number.isFinite(attested) && now.getTime() - attested > maxAge * 3_600_000) errors.push('evidence is stale')
  for (const name of checksByKind[options.kind]) { const check = value.checks?.[name]; if (check?.status !== 'pass') errors.push(`checks.${name}.status must be pass`); errors.push(...validateArtifact(check?.evidence_ref, options.artifactRoot, `checks.${name}.evidence_ref`)) }
  if (options.kind === 'payment') { if (!text(value.provider) || /mock|fixture/iu.test(value.provider)) errors.push('provider must identify a real provider'); if (typeof value.amount_cny !== 'number' || value.amount_cny <= 0) errors.push('amount_cny must be positive'); if (!/^[a-f0-9]{64}$/u.test(String(value.provider_trade_id_sha256 ?? ''))) errors.push('provider_trade_id_sha256 must be a SHA-256 hash') }
  else { if (value.recovery_target_isolated !== true) errors.push('recovery_target_isolated must be true'); if (!/^[a-f0-9]{64}$/u.test(String(value.backup_sha256 ?? ''))) errors.push('backup_sha256 must be a SHA-256 hash'); for (const field of ['source_backup_created_at', 'recovery_point_at']) if (!iso(value[field])) errors.push(`${field} must be a strict UTC ISO timestamp`) }
  if (text(value.signature_base64)) {
    if (!/^[A-Za-z0-9+/]{86}==$/u.test(value.signature_base64)) errors.push('signature_base64 must be a canonical Ed25519 signature')
    else try { const key = createPublicKey(options.publicKeyPem); if (key.asymmetricKeyType !== 'ed25519') errors.push('trusted public key must be Ed25519'); else if (!verify(null, payload(value), key, Buffer.from(value.signature_base64, 'base64'))) errors.push('signature_base64 is invalid') } catch { errors.push('trusted public key or signature is invalid') }
  }
  return errors
}

function arg(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function main() {
  const kind = arg('--kind') as ProductionEvidenceKind; const file = arg('--file'); const releaseId = arg('--release-id'); const imageDigest = arg('--image-digest'); const manifestSha256 = arg('--manifest-sha256'); const releaseGitSha = arg('--release-git-sha'); const deploymentNonce = arg('--deployment-nonce'); const artifactRoot = arg('--artifact-root'); const publicKeyPath = arg('--public-key'); const trustedKeyId = arg('--key-id')
  if (!checksByKind[kind] || !file || !releaseId || !imageDigest || !manifestSha256 || !releaseGitSha || !deploymentNonce || !artifactRoot || !publicKeyPath || !trustedKeyId) { console.error('release, image, manifest, commit, deployment nonce, artifact root and fixed trust anchor are required'); process.exit(2) }
  const publicKeyPem = readFileSync(publicKeyPath, 'utf8'); if (publicKeyPem.includes('UNPROVISIONED') || trustedKeyId === 'UNPROVISIONED') { console.error('production evidence trust anchor is not provisioned'); process.exit(1) }
  const document = JSON.parse(readFileSync(file, 'utf8')) as unknown
  const errors = validateProductionEvidence(document, { kind, releaseId, imageDigest, manifestSha256, releaseGitSha, deploymentNonce, artifactRoot, publicKeyPem, trustedKeyId })
  if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
  console.log(`${kind} production evidence gate passed: ${file}`)
}
if (import.meta.url === `file://${process.argv[1]}`) main()
