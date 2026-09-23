import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { MCP_METHODS } from '../packages/contracts/src/mcp.js'
import { releaseGitShaForRoot } from '../scripts/release-identity.js'
import { verifyPluginReleaseDescriptor, type PluginReleaseDescriptor } from '../scripts/plugin-release-descriptor.mjs'
import { verifyLocalPluginTestAttestation, type LocalPluginTestAttestation } from '../scripts/local-plugin-test-attestation.mjs'
import { validateCapacityEvidence } from './capacity-evidence-gate.js'
import { validateManualOperationsEvidence } from './manual-operations-evidence-gate.js'

type ReleaseManifest = { schemaVersion?: number; releaseId?: string; components?: { repositoryVersion?: string; releaseGitSha?: string; pluginVersion?: string }; mcp?: { methodCount?: number; methodListSha256?: string; bridgeSha256?: string }; artifacts?: Array<{ path?: string; sha256?: string; bytes?: number }>; pluginRelease?: { descriptorSha256?: string; testAttestationSha256?: string; packageSha256?: string; keyId?: string; platform?: string }; productionEvidenceBundle?: { required?: boolean; schemaVersion?: string }; productionEvidence?: Record<string, string> }
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const requiredArtifacts = ['VERSION', 'CHANGELOG.md', 'release-metadata.json', 'scripts/release-manifest.ts', 'scripts/release-identity.ts', 'apps/plugin/.codex-plugin/plugin.json', 'apps/plugin/package.json', 'apps/plugin/skills/merchant-marketing/SKILL.md', 'apps/plugin/mcp/bridge.mjs', '.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs', 'apps/api/openapi.yaml', 'packages/contracts/src/mcp.ts', 'services/payment-gateway/index.mjs', 'services/payment-gateway/alipay.mjs', 'services/payment-gateway/alipay.d.mts', 'packages/billing/src/callback-envelope.mjs', 'packages/billing/src/callback-envelope.d.mts', 'services/payment-gateway/Dockerfile', 'infra/scripts/render-ecs-production-compose.sh', 'infra/scripts/stage-verified-ecs-release.sh', 'infra/scripts/deploy-verified-ecs-compose.sh', 'infra/scripts/rollback-ecs-compose.sh', 'infra/scripts/invoke-ecs-automatic-rollback.sh', 'infra/scripts/install-ecs-release-controls.mjs', 'infra/scripts/install-ecs-release-controls.d.mts', 'infra/protected/attest-manual-operations-evidence.mjs', 'infra/protected/attest-manual-operations-evidence.d.mts', 'infra/protected/attest-release-evidence-bundle.mjs', 'infra/protected/attest-release-evidence-bundle.d.mts', 'infra/protected/attest-postgres-backup.mjs', 'infra/protected/attest-postgres-backup.d.mts', 'infra/protected/ecs-preidentity-recovery.mjs', 'infra/protected/ecs-preidentity-recovery.d.mts', 'tests/release-evidence-bundle-gate.ts']
const cloudRequiredArtifacts = [...requiredArtifacts.filter(path => !path.startsWith('apps/plugin/') && !path.startsWith('.codex-marketplace/')), 'scripts/plugin-release-descriptor.mjs', 'scripts/plugin-release-descriptor.d.mts', 'scripts/local-plugin-test-attestation.mjs', 'scripts/local-plugin-test-attestation.d.mts']
const evidenceFields = ['capability', 'capacity', 'modelRelay', 'payment', 'restore', 'objectStorage', 'codexAppHost', 'canonicalCutover'] as const
type EvidenceField = typeof evidenceFields[number]
const signedEvidenceFields = new Set<EvidenceField>(['capability', 'payment', 'restore', 'objectStorage', 'codexAppHost'])
const immutableProductionArtifact = /^artifact:\/\/production\/([A-Za-z0-9._/-]+)#([a-f0-9]{64})$/u
const compare = ([left]: [string, unknown], [right]: [string, unknown]) => left < right ? -1 : left > right ? 1 : 0
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'signature_base64').sort(compare).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)

function validateCapacityArtifact(document: Record<string, unknown>, releaseId: string, errors: string[], now: Date) {
  if (document.status !== 'not_performed' && document.profile !== 'no_load') return
  errors.push(...validateCapacityEvidence(document, { expectedProfile: 'no_load', expectedReleaseId: releaseId, now }))
}

type EvidenceBindingOptions = {
  artifactRoot?: string
  evidenceFiles?: Partial<Record<EvidenceField, string>>
  publicKeyPem?: string
  trustedKeyId?: string
  now?: Date
  maxManifestAgeMs?: number
  maxEvidenceAgeMs?: number
  pluginDescriptorPath?: string
  pluginTestAttestationPath?: string
  pluginPublicKeyPem?: string
  pluginKeyId?: string
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
      if (field === 'capacity') validateCapacityArtifact(document, value.releaseId!, errors, new Date(now))
      if (field === 'capability' && document.schema_version === 'manual-operations-evidence/1') {
        errors.push(...validateManualOperationsEvidence(document, value.releaseId, new Date(now)).map(error => `productionEvidence.capability ${error}`))
      }
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
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) errors.push('schemaVersion must be 1 or 2')
  if (value.productionEvidenceBundle?.required !== true || value.productionEvidenceBundle?.schemaVersion !== 'release-evidence-bundle/1') errors.push('productionEvidenceBundle must require release-evidence-bundle/1')
  if (!value.releaseId) errors.push('releaseId is required')
  if (options.expectedReleaseId && value.releaseId !== options.expectedReleaseId) errors.push(`releaseId must match ${options.expectedReleaseId}`)
  const repositoryVersion = (() => { try { return readFileSync(resolve(root, 'VERSION'), 'utf8').trim() } catch { return '' } })()
  const releaseGitSha = releaseGitShaForRoot(root, value.releaseId)
  if (value.components?.repositoryVersion !== repositoryVersion) errors.push('components.repositoryVersion must match VERSION')
  if (value.components?.releaseGitSha !== releaseGitSha) errors.push('components.releaseGitSha must match the current Git HEAD or staged candidate identity')
  validateInstant((value as ReleaseManifest & { generatedAt?: string }).generatedAt, 'generatedAt', (options.now ?? new Date()).getTime(), options.maxManifestAgeMs ?? 86_400_000, errors)
  if (value.mcp?.methodCount !== MCP_METHODS.length) errors.push(`mcp.methodCount must match ${MCP_METHODS.length}`)
  if (value.mcp?.methodListSha256 !== sha256(JSON.stringify(MCP_METHODS))) errors.push('mcp.methodListSha256 does not match the current MCP contract')
  if (value.schemaVersion === 2) {
    if (!options.pluginDescriptorPath || !options.pluginTestAttestationPath || !options.pluginPublicKeyPem || !options.pluginKeyId) errors.push('plugin-release/2 requires a trusted descriptor, local test attestation, public key and key ID')
    else try {
      const stat = lstatSync(options.pluginDescriptorPath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('descriptor is not a regular non-symlink file')
      const bytes = readFileSync(options.pluginDescriptorPath)
      if (value.pluginRelease?.descriptorSha256 !== sha256(bytes)) throw new Error('descriptor SHA-256 mismatch')
      const descriptor = verifyPluginReleaseDescriptor(JSON.parse(bytes.toString('utf8')) as PluginReleaseDescriptor, {
        publicKeyPem: options.pluginPublicKeyPem, keyId: options.pluginKeyId,
        releaseId: value.releaseId, gitSha: value.components?.releaseGitSha,
        mcpMethodsSha256: value.mcp?.methodListSha256,
        platform: value.pluginRelease?.platform,
      })
      if (descriptor.plugin_id !== 'merchant-marketing'
        || value.pluginRelease?.keyId !== descriptor.key_id || value.pluginRelease?.packageSha256 !== descriptor.package_sha256
        || value.components?.pluginVersion !== descriptor.plugin_version || value.mcp?.bridgeSha256 !== descriptor.bridge_sha256) {
        throw new Error('signed plugin descriptor does not match the cloud release manifest')
      }
      const testStat = lstatSync(options.pluginTestAttestationPath)
      if (!testStat.isFile() || testStat.isSymbolicLink()) throw new Error('local plugin test attestation is not a regular non-symlink file')
      const testBytes = readFileSync(options.pluginTestAttestationPath)
      if (value.pluginRelease?.testAttestationSha256 !== sha256(testBytes)) throw new Error('local plugin test attestation SHA-256 mismatch')
      verifyLocalPluginTestAttestation(JSON.parse(testBytes.toString('utf8')) as LocalPluginTestAttestation, {
        publicKeyPem: options.pluginPublicKeyPem, keyId: options.pluginKeyId,
        releaseId: value.releaseId!, gitSha: value.components!.releaseGitSha!,
        platform: descriptor.platform, descriptorSha256: sha256(bytes), now: (options.now ?? new Date()).getTime(),
      })
    } catch (error) { errors.push(`plugin-release/2 verification failed: ${error instanceof Error ? error.message : String(error)}`) }
  } else {
    const currentBridgeHash = (() => { try { return sha256(readFileSync(resolve(root, 'apps/plugin/mcp/bridge.mjs'))) } catch { return '' } })()
    if (value.mcp?.bridgeSha256 !== currentBridgeHash) errors.push('mcp.bridgeSha256 does not match the current source bridge')
  }
  const artifactEntries = value.artifacts ?? []
  const artifactPaths = new Set<string>()
  for (const item of artifactEntries) {
    if (typeof item.path !== 'string') continue
    if (artifactPaths.has(item.path)) errors.push(`artifact path is duplicated: ${item.path}`)
    artifactPaths.add(item.path)
  }
  const artifacts = new Map(artifactEntries.map(item => [item.path, item]))
  if (value.schemaVersion === 2 && artifactEntries.some(item => item.path?.startsWith('apps/plugin/') || item.path?.startsWith('.codex-marketplace/'))) errors.push('cloud manifest must not contain local plugin source artifacts')
  for (const path of value.schemaVersion === 2 ? cloudRequiredArtifacts : requiredArtifacts) {
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
  const pluginDescriptorPath = arg('--plugin-descriptor'); const pluginTestAttestationPath = arg('--plugin-test-attestation'); const pluginPublicKeyPath = arg('--plugin-public-key'); const pluginKeyId = arg('--plugin-key-id')
  const errors = validateReleaseManifest(document, { expectedReleaseId: releaseId, artifactRoot, evidenceFiles, publicKeyPem: readFileSync(publicKeyPath, 'utf8'), trustedKeyId,
    pluginDescriptorPath, pluginTestAttestationPath, pluginPublicKeyPem: pluginPublicKeyPath ? readFileSync(pluginPublicKeyPath, 'utf8') : undefined, pluginKeyId })
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log(`release manifest gate passed: ${file} (source artifacts and exact production evidence bytes are hash-, freshness- and signature-bound)`)
}
if (import.meta.url === `file://${process.argv[1]}`) main()
