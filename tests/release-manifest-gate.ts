import { createHash, createPublicKey, verify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { MCP_METHODS } from '../packages/contracts/src/mcp.js'

type ReleaseManifest = { schemaVersion?: number; releaseId?: string; components?: { repositoryVersion?: string; releaseGitSha?: string }; mcp?: { methodCount?: number; methodListSha256?: string; bridgeSha256?: string }; artifacts?: Array<{ path?: string; sha256?: string; bytes?: number }>; productionEvidence?: Record<string, string> }
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const requiredArtifacts = ['VERSION', 'CHANGELOG.md', 'release-metadata.json', 'apps/plugin/.codex-plugin/plugin.json', 'apps/plugin/package.json', 'apps/plugin/skills/merchant-marketing/SKILL.md', 'apps/plugin/mcp/bridge.mjs', '.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs', 'apps/api/openapi.yaml', 'packages/contracts/src/mcp.ts']
const evidenceFields = ['capability', 'capacity', 'modelRelay', 'payment', 'restore', 'objectStorage', 'codexAppHost', 'canonicalCutover'] as const
type EvidenceField = typeof evidenceFields[number]
const signedEvidenceFields = new Set<EvidenceField>(['capability', 'payment', 'restore', 'codexAppHost'])
const immutableProductionArtifact = /^artifact:\/\/production\/([A-Za-z0-9._/-]+)#([a-f0-9]{64})$/u
const compare = ([left]: [string, unknown], [right]: [string, unknown]) => left < right ? -1 : left > right ? 1 : 0
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'signature_base64').sort(compare).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)

type EvidenceBindingOptions = {
  artifactRoot?: string
  evidenceFiles?: Partial<Record<EvidenceField, string>>
  publicKeyPem?: string
  trustedKeyId?: string
  now?: Date
  maxManifestAgeMs?: number
  maxEvidenceAgeMs?: number
}

function validateInstant(value: unknown, label: string, now: number, maxAgeMs: number, errors: string[]) {
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(parsed)) { errors.push(`${label} must be an ISO instant`); return }
  if (parsed > now + 300_000) errors.push(`${label} must not be more than five minutes in the future`)
  if (now - parsed > maxAgeMs) errors.push(`${label} is stale`)
}

function validateEvidenceBindings(value: ReleaseManifest, options: EvidenceBindingOptions, errors: string[]) {
  if (!options.artifactRoot) return
  let root: string
  try { root = realpathSync(options.artifactRoot) } catch { errors.push('production evidence artifact root does not exist or cannot be read'); return }
  const now = (options.now ?? new Date()).getTime()
  const maxAge = options.maxEvidenceAgeMs ?? 7 * 86_400_000
  let publicKey: ReturnType<typeof createPublicKey> | undefined
  if (options.publicKeyPem) {
    try { publicKey = createPublicKey(options.publicKeyPem); if (publicKey.asymmetricKeyType !== 'ed25519') { errors.push('trusted production evidence public key must be Ed25519'); publicKey = undefined } } catch { errors.push('trusted production evidence public key is invalid') }
  }
  for (const field of evidenceFields) {
    const reference = value.productionEvidence?.[field] ?? ''
    const match = immutableProductionArtifact.exec(reference)
    if (!match) continue
    const relative = match[1]!
    if (relative.split('/').some(part => !part || part === '.' || part === '..')) { errors.push(`productionEvidence.${field} contains an invalid path`); continue }
    try {
      const candidate = resolve(root, relative)
      if (!candidate.startsWith(`${root}${sep}`)) { errors.push(`productionEvidence.${field} escapes the artifact root`); continue }
      const stat = lstatSync(candidate)
      if (!stat.isFile() || stat.isSymbolicLink()) { errors.push(`productionEvidence.${field} must resolve to a regular non-symlink file`); continue }
      const path = realpathSync(candidate)
      if (!path.startsWith(`${root}${sep}`)) { errors.push(`productionEvidence.${field} escapes the artifact root`); continue }
      const bytes = readFileSync(path)
      if (sha256(bytes) !== match[2]) errors.push(`productionEvidence.${field} SHA-256 does not match the referenced artifact`)
      const supplied = options.evidenceFiles?.[field]
      if (!supplied) errors.push(`productionEvidence.${field} evidence file binding is required`)
      else {
        const suppliedStat = lstatSync(supplied)
        if (!suppliedStat.isFile() || suppliedStat.isSymbolicLink() || realpathSync(supplied) !== path) errors.push(`productionEvidence.${field} must reference the exact evidence file passed to deployment`)
      }
      const document = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
      if ((document.release_id ?? document.releaseId) !== value.releaseId) errors.push(`productionEvidence.${field} release_id must match the release manifest`)
      const observedAt = document.generated_at ?? document.generatedAt ?? document.ended_at ?? document.attested_at
      validateInstant(observedAt, `productionEvidence.${field} generated timestamp`, now, maxAge, errors)
      if (document.expires_at !== undefined) {
        const expires = typeof document.expires_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(document.expires_at) ? Date.parse(document.expires_at) : Number.NaN
        if (!Number.isFinite(expires)) errors.push(`productionEvidence.${field} expires_at must be an ISO instant`)
        else if (expires <= now) errors.push(`productionEvidence.${field} has expired`)
      }
      if (signedEvidenceFields.has(field)) {
        if (!options.trustedKeyId || !publicKey) errors.push(`productionEvidence.${field} requires the fixed production evidence trust anchor`)
        if (document.key_id !== options.trustedKeyId) errors.push(`productionEvidence.${field} key_id must match the trusted production evidence key`)
        const signature = document.signature_base64
        if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)) errors.push(`productionEvidence.${field} signature_base64 must be a canonical Ed25519 signature`)
        else if (publicKey && !verify(null, Buffer.from(canonical(document)), publicKey, Buffer.from(signature, 'base64'))) errors.push(`productionEvidence.${field} signature_base64 is invalid`)
      }
    } catch { errors.push(`productionEvidence.${field} artifact does not exist, is invalid JSON, or cannot be read`) }
  }
}

export function validateReleaseManifest(document: unknown, options: { root?: string; expectedReleaseId?: string } & EvidenceBindingOptions = {}): string[] {
  const errors: string[] = []; const root = resolve(options.root ?? process.cwd())
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as ReleaseManifest
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (!value.releaseId) errors.push('releaseId is required')
  if (options.expectedReleaseId && value.releaseId !== options.expectedReleaseId) errors.push(`releaseId must match ${options.expectedReleaseId}`)
  const repositoryVersion = (() => { try { return readFileSync(resolve(root, 'VERSION'), 'utf8').trim() } catch { return '' } })()
  const releaseGitSha = (() => { try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return '' } })()
  if (value.components?.repositoryVersion !== repositoryVersion) errors.push('components.repositoryVersion must match VERSION')
  if (value.components?.releaseGitSha !== releaseGitSha) errors.push('components.releaseGitSha must match the current Git HEAD')
  validateInstant((value as ReleaseManifest & { generatedAt?: string }).generatedAt, 'generatedAt', (options.now ?? new Date()).getTime(), options.maxManifestAgeMs ?? 86_400_000, errors)
  if (value.mcp?.methodCount !== MCP_METHODS.length) errors.push(`mcp.methodCount must match ${MCP_METHODS.length}`)
  if (value.mcp?.methodListSha256 !== sha256(JSON.stringify(MCP_METHODS))) errors.push('mcp.methodListSha256 does not match the current MCP contract')
  const currentBridgeHash = (() => { try { return sha256(readFileSync(resolve(root, 'apps/plugin/mcp/bridge.mjs'))) } catch { return '' } })()
  if (value.mcp?.bridgeSha256 !== currentBridgeHash) errors.push('mcp.bridgeSha256 does not match the current source bridge')
  const artifacts = new Map((value.artifacts ?? []).map(item => [item.path, item]))
  for (const path of requiredArtifacts) {
    const item = artifacts.get(path); if (!item) { errors.push(`artifact is missing: ${path}`); continue }
    try { const stat = lstatSync(resolve(root, path)); if (!stat.isFile() || stat.isSymbolicLink()) errors.push(`current artifact is not a regular file: ${path}`); else { const bytes = readFileSync(resolve(root, path)); if (item.sha256 !== sha256(bytes)) errors.push(`artifact SHA-256 does not match current source: ${path}`); if (item.bytes !== bytes.byteLength) errors.push(`artifact byte count does not match current source: ${path}`) } } catch { errors.push(`current artifact cannot be read: ${path}`) }
  }
  for (const field of evidenceFields) if (!immutableProductionArtifact.test(value.productionEvidence?.[field] ?? '')) errors.push(`productionEvidence.${field} must be an immutable production artifact`)
  validateEvidenceBindings(value, options, errors)
  return errors
}

function arg(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function main() {
  const file = arg('--file'); const releaseId = arg('--release-id'); const artifactRoot = arg('--artifact-root'); const publicKeyPath = arg('--public-key'); const trustedKeyId = arg('--key-id')
  const evidenceFiles = Object.fromEntries(evidenceFields.map(field => [field, arg(`--${field.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}-evidence`)])) as Partial<Record<EvidenceField, string>>
  if (!file || !releaseId || !artifactRoot || !publicKeyPath || !trustedKeyId || evidenceFields.some(field => !evidenceFiles[field])) { console.error('release manifest, artifact root, all evidence files and fixed production trust anchor are required'); process.exit(2) }
  let document: unknown
  try { document = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { console.error(`unable to read release manifest: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }
  const errors = validateReleaseManifest(document, { expectedReleaseId: releaseId, artifactRoot, evidenceFiles, publicKeyPem: readFileSync(publicKeyPath, 'utf8'), trustedKeyId })
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log(`release manifest gate passed: ${file} (source artifacts and exact production evidence bytes are hash-, freshness- and signature-bound)`)
}
if (import.meta.url === `file://${process.argv[1]}`) main()
