import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export const REQUIRED_RELAY_MODALITIES = ['text', 'image', 'image_edit', 'ocr', 'video'] as const
type Modality = typeof REQUIRED_RELAY_MODALITIES[number]
type RelayResult = { modality?: Modality; state?: string; endpoint?: string; model?: string; providerRequestId?: string; providerJobId?: string; usageObserved?: boolean; costObserved?: boolean; costSource?: string; costCny?: number; pricingVersion?: string; pricingGroup?: string; evidence_ref?: string }
type RelayEvidence = { schema_version?: string; release_id?: string; generated_at?: string; expires_at?: string; environment?: string; simulated?: boolean; relay?: string; results?: RelayResult[] }

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const isIsoInstant = (value: unknown): value is string => nonEmpty(value) && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value)
const relayOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : undefined
  } catch { return undefined }
}
const immutableArtifact = /^artifact:\/\/production\/[A-Za-z0-9._/-]+#([a-f0-9]{64})$/u
function validateArtifact(reference: string | undefined, root: string, label: string): string[] {
  const match = immutableArtifact.exec(reference ?? '')
  if (!match) return [`${label} must be an immutable production artifact with SHA-256 fragment`]
  const relative = reference!.slice('artifact://production/'.length).split('#')[0]!
  if (relative.split('/').some(segment => segment === '.' || segment === '..' || segment.length === 0)) return [`${label} contains an invalid artifact path`]
  try {
    const realRoot = realpathSync(root); const candidate = resolve(realRoot, relative)
    if (candidate !== realRoot && !candidate.startsWith(`${realRoot}${sep}`)) return [`${label} escapes the artifact root`]
    const stat = lstatSync(candidate); if (stat.isSymbolicLink() || !stat.isFile()) return [`${label} must resolve to a regular non-symlink artifact`]
    const realCandidate = realpathSync(candidate); if (!realCandidate.startsWith(`${realRoot}${sep}`)) return [`${label} escapes the artifact root`]
    const hash = createHash('sha256'); const descriptor = openSync(realCandidate, 'r'); const buffer = Buffer.allocUnsafe(64 * 1024)
    try { for (let bytes = readSync(descriptor, buffer, 0, buffer.length, null); bytes > 0; bytes = readSync(descriptor, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, bytes)) }
    finally { closeSync(descriptor) }
    if (hash.digest('hex') !== match[1]) return [`${label} SHA-256 does not match the referenced artifact`]
  } catch { return [`${label} referenced artifact does not exist or cannot be read`] }
  return []
}

export function validateModelRelayEvidence(document: unknown, options: { expectedReleaseId?: string; expectedRelay?: string; requireProduction?: boolean; artifactRoot?: string; now?: Date } = {}): string[] {
  const errors: string[] = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as RelayEvidence
  if (value.schema_version !== '1') errors.push('schema_version must be 1')
  if (!nonEmpty(value.release_id)) errors.push('release_id is required')
  if (options.expectedReleaseId && value.release_id !== options.expectedReleaseId) errors.push(`release_id must match ${options.expectedReleaseId}`)
  if (options.requireProduction && value.environment !== 'production') errors.push('environment must be production')
  if (options.requireProduction && value.simulated !== false) errors.push('simulated must be false')
  if (!isIsoInstant(value.generated_at)) errors.push('generated_at must be an ISO instant')
  if (options.requireProduction) {
    if (!isIsoInstant(value.expires_at)) errors.push('expires_at must be an ISO instant')
    else {
      const expiresAt = Date.parse(value.expires_at)
      if (isIsoInstant(value.generated_at) && expiresAt <= Date.parse(value.generated_at)) errors.push('expires_at must be after generated_at')
      if (expiresAt <= (options.now ?? new Date()).getTime()) errors.push('relay evidence is expired')
    }
  }
  if (!nonEmpty(value.relay)) errors.push('relay is required')
  else try {
    const relay = new URL(value.relay)
    if (relay.protocol !== 'https:' || relay.username || relay.password || relay.pathname !== '/' || relay.search || relay.hash) errors.push('relay must be a plain HTTPS origin')
    if (options.expectedRelay && relay.origin !== relayOrigin(options.expectedRelay)) errors.push('relay must match the rendered production model_relay_base_url origin')
  } catch { errors.push('relay must be a valid HTTPS URL') }
  if (!Array.isArray(value.results)) return [...errors, 'results is required']
  const byModality = new Map<string, RelayResult>()
  const byProviderRequestId = new Map<string, string>()
  for (const result of value.results) {
    if (!result || typeof result !== 'object' || !nonEmpty(result.modality)) { errors.push('each results item must have a modality'); continue }
    if (byModality.has(result.modality)) errors.push(`duplicate modality: ${result.modality}`)
    byModality.set(result.modality, result)
    if (nonEmpty(result.providerRequestId)) {
      const previousModality = byProviderRequestId.get(result.providerRequestId)
      if (previousModality) errors.push(`providerRequestId must be unique across modalities: ${result.providerRequestId} (${previousModality}, ${result.modality})`)
      else byProviderRequestId.set(result.providerRequestId, result.modality)
    }
  }
  for (const modality of REQUIRED_RELAY_MODALITIES) {
    const result = byModality.get(modality)
    if (!result) { errors.push(`${modality} result is required`); continue }
    if (result.state !== 'ready') errors.push(`${modality} state must be ready`)
    if (!nonEmpty(result.endpoint)) errors.push(`${modality}.endpoint is required`)
    else if (!result.endpoint.startsWith('/') || result.endpoint.includes('\\') || /^https?:\/\//iu.test(result.endpoint) || /[\u0000-\u001f\u007f]/u.test(result.endpoint)) errors.push(`${modality}.endpoint must be a safe relative path`)
    if (!nonEmpty(result.model)) errors.push(`${modality}.model is required`)
    if (!nonEmpty(result.providerRequestId)) errors.push(`${modality}.providerRequestId is required`)
    if (nonEmpty(result.providerJobId) && result.providerJobId === result.providerRequestId) errors.push(`${modality}.providerRequestId must not reuse providerJobId`)
    if (result.usageObserved !== true) errors.push(`${modality}.usageObserved must be true`)
    if (result.costObserved !== true) errors.push(`${modality}.costObserved must be true`)
    if (typeof result.costCny !== 'number' || !Number.isFinite(result.costCny) || result.costCny < 0) errors.push(`${modality}.costCny must be a non-negative observed number`)
    if (options.requireProduction && result.costSource !== 'provider_receipt' && result.costSource !== 'relay_pricing_snapshot') errors.push(`${modality}.costSource must identify provider_receipt or relay_pricing_snapshot`)
    if (options.requireProduction && result.costSource === 'relay_pricing_snapshot') {
      if (!nonEmpty(result.pricingVersion)) errors.push(`${modality}.pricingVersion is required for relay_pricing_snapshot`)
      if (!nonEmpty(result.pricingGroup)) errors.push(`${modality}.pricingGroup is required for relay_pricing_snapshot`)
    }
    if (options.artifactRoot) errors.push(...validateArtifact(result.evidence_ref, options.artifactRoot, `${modality}.evidence_ref`))
  }
  return errors
}

function main() {
  const args = process.argv.slice(2)
  const fileIndex = args.indexOf('--file')
  const path = fileIndex >= 0 ? args[fileIndex + 1] : undefined
  const releaseIndex = args.indexOf('--release-id')
  const expectedReleaseId = releaseIndex >= 0 ? args[releaseIndex + 1] : undefined
  const relayIndex = args.indexOf('--expected-relay')
  const expectedRelay = relayIndex >= 0 ? args[relayIndex + 1] : undefined
  const artifactIndex = args.indexOf('--artifact-root')
  const artifactRoot = artifactIndex >= 0 ? args[artifactIndex + 1] : undefined
  if (!path) { console.error('--file is required'); process.exit(2) }
  if (args.includes('--require-artifacts') && !artifactRoot) { console.error('--artifact-root is required for independent relay evidence validation'); process.exit(2) }
  let document: unknown
  try { document = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { console.error(`unable to read JSON relay evidence: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }
  const errors = validateModelRelayEvidence(document, { expectedReleaseId, expectedRelay, requireProduction: args.includes('--require-production'), artifactRoot })
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log(`model relay evidence gate passed: ${path}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
