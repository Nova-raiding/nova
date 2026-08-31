import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const requiredImages = ['merchant-api', 'merchant-ops-ui', 'merchant-ui', 'merchant-worker', 'clamav'] as const
const requiredScannerSecretRefs = ['api_token_ref', 'workspace_signing_secret_ref', 'receipt_private_key_ref', 'trusted_public_keys_ref'] as const
const artifactRef = /^artifact:\/\/production\/([A-Za-z0-9._/-]+)#([a-f0-9]{64})$/u
const compare = ([a]: [string, unknown], [b]: [string, unknown]) => a < b ? -1 : a > b ? 1 : 0
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'signature_base64').sort(compare).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function resolveArtifact(reference: unknown, root: string, label: string): { path?: string; hash?: string; errors: string[] } {
  const match = artifactRef.exec(typeof reference === 'string' ? reference : '')
  if (!match) return { errors: [`${label} must be an immutable production artifact reference`] }
  const relative = match[1]!; const hash = match[2]!
  if (relative.split('/').some(part => !part || part === '.' || part === '..')) return { errors: [`${label} contains an invalid path`] }
  try {
    const realRoot = realpathSync(root); const candidate = resolve(realRoot, relative)
    if (!candidate.startsWith(`${realRoot}${sep}`)) return { errors: [`${label} escapes the artifact root`] }
    const stat = lstatSync(candidate); if (!stat.isFile() || stat.isSymbolicLink()) return { errors: [`${label} must be a regular non-symlink file`] }
    const path = realpathSync(candidate); if (!path.startsWith(`${realRoot}${sep}`)) return { errors: [`${label} escapes the artifact root`] }
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== hash) return { errors: [`${label} checksum mismatch`] }
    return { path, hash, errors: [] }
  } catch { return { errors: [`${label} does not exist or cannot be read`] } }
}

export type ReleaseBundleOptions = { releaseId: string; artifactRoot: string; trustedKeyId: string; publicKeyPem: string; now?: Date }
export function validateReleaseBundle(document: unknown, options: ReleaseBundleOptions): { errors: string[]; descriptor?: Record<string, unknown> } {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return { errors: ['document must be a JSON object'] }
  const value = document as Record<string, unknown>; const errors: string[] = []
  const expected = { schema_version: '1', kind: 'known_good_release', environment: 'production', release_id: options.releaseId, key_id: options.trustedKeyId }
  for (const [field, wanted] of Object.entries(expected)) if (value[field] !== wanted) errors.push(`${field} must match ${wanted}`)
  if (value.simulated !== false) errors.push('simulated must be false')
  if (!/^[0-9a-f]{40}$/u.test(String(value.release_git_sha ?? ''))) errors.push('release_git_sha must be a full lowercase Git SHA')
  if (!/^[0-9a-f]{64}$/u.test(String(value.manifest_sha256 ?? ''))) errors.push('manifest_sha256 must be lowercase SHA-256')
  const imageDigests = value.image_digests
  if (!imageDigests || typeof imageDigests !== 'object' || Array.isArray(imageDigests) || Object.keys(imageDigests).sort().join(',') !== [...requiredImages].sort().join(',')) errors.push('image_digests must contain exactly the five release images')
  else for (const name of requiredImages) if (!/^sha256:[0-9a-f]{64}$/u.test(String((imageDigests as Record<string, unknown>)[name] ?? ''))) errors.push(`image_digests.${name} is invalid`)
  const scanner = value.asset_scanner
  if (!scanner || typeof scanner !== 'object' || Array.isArray(scanner)) errors.push('asset_scanner contract is required')
  else {
    const contract = scanner as Record<string, unknown>
    if (contract.mode !== 'clamav_worker') errors.push('asset_scanner.mode must be clamav_worker')
    if (contract.allow_local_fixture !== false) errors.push('asset_scanner.allow_local_fixture must be false')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(String(contract.policy_version ?? '')) || String(contract.policy_version).toLowerCase().includes('local')) errors.push('asset_scanner.policy_version must be an immutable non-local version')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(String(contract.receipt_key_id ?? ''))) errors.push('asset_scanner.receipt_key_id is invalid')
    if (contract.clamav_image_digest !== (imageDigests as Record<string, unknown> | undefined)?.clamav) errors.push('asset_scanner.clamav_image_digest must match image_digests.clamav')
    if (!Number.isInteger(contract.signature_max_age_minutes) || Number(contract.signature_max_age_minutes) < 1 || Number(contract.signature_max_age_minutes) > 1440) errors.push('asset_scanner.signature_max_age_minutes must be from 1 to 1440')
    const refs = contract.secret_refs
    if (!refs || typeof refs !== 'object' || Array.isArray(refs) || Object.keys(refs).sort().join(',') !== [...requiredScannerSecretRefs].sort().join(',')) errors.push('asset_scanner.secret_refs must contain exactly the isolated scanner secret references')
    else {
      const values = requiredScannerSecretRefs.map(name => String((refs as Record<string, unknown>)[name] ?? ''))
      if (values.some(reference => !/^(?:vault|secret):\/\/[A-Za-z0-9._/-]+$/u.test(reference))) errors.push('asset_scanner.secret_refs must use immutable managed-secret references')
      if (new Set(values).size !== values.length) errors.push('asset_scanner.secret_refs must be isolated from one another')
    }
  }
  const manifest = resolveArtifact(value.manifest_ref, options.artifactRoot, 'manifest_ref'); const capability = resolveArtifact(value.capability_evidence_ref, options.artifactRoot, 'capability_evidence_ref')
  errors.push(...manifest.errors, ...capability.errors)
  if (manifest.hash && manifest.hash !== value.manifest_sha256) errors.push('manifest_sha256 does not match manifest_ref')
  const approved = Date.parse(String(value.approved_at ?? '')); const expires = Date.parse(String(value.expires_at ?? '')); const now = (options.now ?? new Date()).getTime()
  if (!Number.isFinite(approved) || approved > now + 300_000) errors.push('approved_at is invalid')
  if (!Number.isFinite(expires) || expires <= now) errors.push('known-good release approval has expired')
  if (Number.isFinite(approved) && Number.isFinite(expires) && (expires <= approved || expires - approved > 30 * 86_400_000)) errors.push('known-good release approval must expire within 30 days after approval')
  const signature = value.signature_base64
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)) errors.push('signature_base64 must be a canonical Ed25519 signature')
  else try { const key = createPublicKey(options.publicKeyPem); if (key.asymmetricKeyType !== 'ed25519') errors.push('trusted public key must be Ed25519'); else if (!verify(null, Buffer.from(canonical(value)), key, Buffer.from(signature, 'base64'))) errors.push('signature_base64 is invalid') } catch { errors.push('trusted public key or signature is invalid') }
  if (errors.length) return { errors }
  const canonicalImages = requiredImages.slice().sort().map(name => `${name}=${(imageDigests as Record<string, string>)[name]}\n`).join('')
  return { errors, descriptor: { release_id: value.release_id, release_git_sha: value.release_git_sha, manifest_sha256: value.manifest_sha256, image_set_digest: `sha256:${createHash('sha256').update(canonicalImages).digest('hex')}`, image_digests: imageDigests, asset_scanner: scanner, manifest_path: manifest.path, capability_evidence_path: capability.path } }
}

function arg(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function main() {
  const file = arg('--file'); const releaseId = arg('--release-id'); const artifactRoot = arg('--artifact-root'); const publicKey = arg('--public-key'); const keyId = arg('--key-id'); const descriptorOut = arg('--descriptor-out')
  if (!file || !releaseId || !artifactRoot || !publicKey || !keyId || !descriptorOut) { console.error('signed release bundle, fixed trust anchor, artifact root and descriptor output are required'); process.exit(2) }
  const result = validateReleaseBundle(JSON.parse(readFileSync(file, 'utf8')), { releaseId, artifactRoot, trustedKeyId: keyId, publicKeyPem: readFileSync(publicKey, 'utf8') })
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exit(1) }
  writeFileSync(descriptorOut, JSON.stringify(result.descriptor), { mode: 0o600 })
  console.log(`known-good release bundle passed: ${releaseId}`)
}
if (import.meta.url === `file://${process.argv[1]}`) main()
