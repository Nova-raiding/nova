import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export const REQUIRED_RELAY_MODALITIES = ['text', 'image', 'image_edit', 'ocr', 'video'] as const
type Modality = typeof REQUIRED_RELAY_MODALITIES[number]
type RelayUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number; billingUnits?: number; durationSeconds?: number }
type RelayResult = { modality?: Modality; state?: string; endpoint?: string; model?: string; providerRequestId?: string; providerJobId?: string; usageObserved?: boolean; usage?: RelayUsage; usageProviderRequestId?: string; costObserved?: boolean; costSource?: string; costCny?: number; pricingVersion?: string; pricingGroup?: string; evidence_ref?: string }
type RelayErrorRecovery = { verified?: boolean; failure_status?: number; failure_observed_at?: string; recovered_at?: string; failed_request_id?: string; recovery_request_id?: string; evidence_ref?: string }
type RelayTokenQuota = { credential?: 'model' | 'video'; observed_at?: string; total_granted?: number; total_used?: number; total_available?: number; expires_at?: number; unlimited_quota?: boolean; evidence_ref?: string }
type RelayEvidence = { schema_version?: string; release_id?: string; generated_at?: string; expires_at?: string; environment?: string; simulated?: boolean; relay?: string; token_quota?: RelayTokenQuota[]; results?: RelayResult[]; error_recovery?: RelayErrorRecovery }

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const isIsoInstant = (value: unknown): value is string => nonEmpty(value) && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value)
const relayOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : undefined
  } catch { return undefined }
}
const immutableArtifact = /^artifact:\/\/production\/[A-Za-z0-9._/-]+#([a-f0-9]{64})$/u
type ExpectedArtifact = { releaseId?: string; result?: RelayResult; recovery?: RelayErrorRecovery; tokenQuota?: RelayTokenQuota; relay?: string }
function validateArtifact(reference: string | undefined, root: string, label: string, expected?: ExpectedArtifact): string[] {
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
    if (expected) {
      let artifactValue: Record<string, any>
      try { artifactValue = JSON.parse(readFileSync(realCandidate, 'utf8')) as Record<string, any> }
      catch { return [`${label} must contain a JSON relay receipt`] }
      if (!artifactValue || typeof artifactValue !== 'object' || Array.isArray(artifactValue) || artifactValue.release_id !== expected.releaseId) return [`${label} release_id must match the evidence release_id`]
      if (expected.tokenQuota) {
        const captured = artifactValue.token_quota
        const summary = expected.tokenQuota
        if (artifactValue.schema_version !== '1' || !captured || typeof captured !== 'object' || Array.isArray(captured)
          || ['credential', 'observed_at', 'total_granted', 'total_used', 'total_available', 'expires_at', 'unlimited_quota'].some(field => captured[field] !== summary[field as keyof RelayTokenQuota])) {
          return [`${label} token quota receipt must match the summarized finite token evidence`]
        }
      } else if (expected.recovery) {
        const { failure, recovery } = artifactValue
        const summary = expected.recovery
        const validCapture = (capture: unknown): capture is Record<string, unknown> => !!capture && typeof capture === 'object' && !Array.isArray(capture)
        const failureBody = validCapture(failure) ? failure.relay_response : undefined
        const failureError = validCapture(failureBody) ? failureBody.error : undefined
        if (artifactValue.schema_version !== '1' || !validCapture(failure) || !validCapture(recovery)
          || failure.release_id !== expected.releaseId || recovery.release_id !== expected.releaseId
          || failure.http_status !== 503 || typeof recovery.http_status !== 'number' || !Number.isSafeInteger(recovery.http_status) || recovery.http_status < 200 || recovery.http_status > 299
          || failure.error_code !== 'MODEL_PROVIDER_OUTCOME_UNKNOWN'
          || !validCapture(failureError) || failureError.code !== failure.error_code
          || !isIsoInstant(failure.observed_at) || !isIsoInstant(recovery.observed_at)
          || failure.observed_at !== summary.failure_observed_at || recovery.observed_at !== summary.recovered_at
          || Date.parse(recovery.observed_at) <= Date.parse(failure.observed_at)
          || !nonEmpty(failure.provider_request_id) || !nonEmpty(recovery.provider_request_id)
          || failure.provider_request_id !== summary.failed_request_id || recovery.provider_request_id !== summary.recovery_request_id
          || failure.provider_request_id === recovery.provider_request_id
          || failure.relay !== expected.relay || recovery.relay !== expected.relay
          || !nonEmpty(failure.endpoint) || failure.endpoint !== recovery.endpoint
          || !failure.endpoint.startsWith('/') || failure.endpoint.startsWith('//') || failure.endpoint.includes('\\')
          || failure.endpoint.includes('?') || failure.endpoint.includes('#') || failure.endpoint.split('/').some(segment => segment === '.' || segment === '..')
          || /[\u0000-\u001f\u007f]/u.test(failure.endpoint)) {
          return [`${label} capture pair must match the summarized 503 MODEL_PROVIDER_OUTCOME_UNKNOWN recovery, release, relay, endpoint, times and request ids`]
        }
      } else if (expected.result) {
        if (artifactValue.modality !== expected.result.modality) return [`${label} modality must match ${expected.result.modality}`]
        const receipt = artifactValue.result
        if (!receipt || typeof receipt !== 'object' || ['providerRequestId', 'providerJobId', 'model', 'state', 'endpoint', 'usageObserved', 'usageProviderRequestId', 'costObserved', 'costCny', 'costSource', 'pricingVersion', 'pricingGroup'].some(field => receipt[field] !== expected.result?.[field as keyof RelayResult]) || JSON.stringify(receipt.usage) !== JSON.stringify(expected.result.usage)) {
          return [`${label} receipt must match the summarized request, model, state, endpoint, usage and cost`]
        }
      }
    }
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
    if (isIsoInstant(value.generated_at)) {
      const generatedAt = Date.parse(value.generated_at)
      const now = (options.now ?? new Date()).getTime()
      if (generatedAt > now + 300_000) errors.push('generated_at must not be in the future')
      if (now - generatedAt > 24 * 3_600_000) errors.push('relay evidence is stale')
    }
    if (!isIsoInstant(value.expires_at)) errors.push('expires_at must be an ISO instant')
    else {
      const expiresAt = Date.parse(value.expires_at)
      if (isIsoInstant(value.generated_at) && expiresAt <= Date.parse(value.generated_at)) errors.push('expires_at must be after generated_at')
      if (isIsoInstant(value.generated_at) && expiresAt - Date.parse(value.generated_at) > 24 * 3_600_000) errors.push('relay evidence validity must not exceed 24 hours')
      if (expiresAt <= (options.now ?? new Date()).getTime()) errors.push('relay evidence is expired')
    }
  }
  if (!nonEmpty(value.relay)) errors.push('relay is required')
  else try {
    const relay = new URL(value.relay)
    if (relay.protocol !== 'https:' || relay.username || relay.password || relay.pathname !== '/' || relay.search || relay.hash) errors.push('relay must be a plain HTTPS origin')
    if (options.expectedRelay && relay.origin !== relayOrigin(options.expectedRelay)) errors.push('relay must match the rendered production model_relay_base_url origin')
  } catch { errors.push('relay must be a valid HTTPS URL') }
  if (options.requireProduction) {
    if (!Array.isArray(value.token_quota)) errors.push('token_quota is required for production relay evidence')
    else {
      for (const credential of ['model', 'video'] as const) {
        const matching = value.token_quota.filter(quota => quota?.credential === credential)
        if (matching.length !== 1) { errors.push(`token_quota.${credential} must have exactly one finite token receipt`); continue }
        const quota = matching[0]!
        const granted = quota.total_granted; const used = quota.total_used; const available = quota.total_available; const expires = quota.expires_at
        if (quota.unlimited_quota !== false || ![granted, used, available, expires].every(number => typeof number === 'number' && Number.isSafeInteger(number))
          || (granted ?? 0) <= 0 || (used ?? -1) < 0 || (available ?? 0) <= 0 || used! + available! !== granted
          || (expires ?? -1) < 0 || (expires !== 0 && expires! <= Math.floor((options.now ?? new Date()).getTime() / 1000))) errors.push(`token_quota.${credential} must be a current finite server-enforced quota`)
        if (!isIsoInstant(quota.observed_at)) errors.push(`token_quota.${credential}.observed_at must be an ISO instant`)
        else if (isIsoInstant(value.generated_at) && (Date.parse(quota.observed_at) > Date.parse(value.generated_at) || Date.parse(value.generated_at) - Date.parse(quota.observed_at) > 24 * 3_600_000)) errors.push(`token_quota.${credential}.observed_at must precede generated_at by at most 24 hours`)
        errors.push(...validateArtifact(quota.evidence_ref, options.artifactRoot ?? '', `token_quota.${credential}.evidence_ref`, { releaseId: value.release_id, tokenQuota: quota }))
      }
      if (value.token_quota.some(quota => quota?.credential !== 'model' && quota?.credential !== 'video')) errors.push('token_quota contains an unknown credential')
    }
  }
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
    else if (!result.endpoint.startsWith('/') || result.endpoint.startsWith('//') || result.endpoint.includes('\\') || result.endpoint.includes('?') || result.endpoint.includes('#') || result.endpoint.split('/').some(segment => segment === '.' || segment === '..') || /[\u0000-\u001f\u007f]/u.test(result.endpoint)) errors.push(`${modality}.endpoint must be a safe relative path`)
    if (!nonEmpty(result.model)) errors.push(`${modality}.model is required`)
    if (!nonEmpty(result.providerRequestId)) errors.push(`${modality}.providerRequestId is required`)
    if (nonEmpty(result.providerJobId) && result.providerJobId === result.providerRequestId) errors.push(`${modality}.providerRequestId must not reuse providerJobId`)
    if (result.usageObserved !== true) errors.push(`${modality}.usageObserved must be true`)
    const usage = result.usage
    const numericUsage = usage && Object.entries(usage).filter(([, amount]) => amount !== undefined)
    if (!usage || !numericUsage?.length || numericUsage.some(([, amount]) => typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) errors.push(`${modality}.usage must contain finite non-negative numeric units`)
    else {
      if ((modality === 'text' || modality === 'ocr') && usage.inputTokens === undefined && usage.outputTokens === undefined && usage.totalTokens === undefined) errors.push(`${modality}.usage must contain token units`)
      if ((modality === 'image' || modality === 'image_edit') && (!Number.isSafeInteger(usage.billingUnits) || (usage.billingUnits ?? 0) <= 0)) errors.push(`${modality}.usage must contain positive integer billingUnits`)
      if (modality === 'video' && (typeof usage.durationSeconds !== 'number' || usage.durationSeconds <= 0)) errors.push(`${modality}.usage must contain positive durationSeconds`)
      if (usage.totalTokens !== undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined && usage.totalTokens !== usage.inputTokens + usage.outputTokens) errors.push(`${modality}.usage token totals must be consistent`)
    }
    if (!nonEmpty(result.usageProviderRequestId) || result.usageProviderRequestId !== result.providerRequestId) errors.push(`${modality}.usageProviderRequestId must match providerRequestId`)
    if (result.costObserved !== true) errors.push(`${modality}.costObserved must be true`)
    if (typeof result.costCny !== 'number' || !Number.isFinite(result.costCny) || result.costCny < 0) errors.push(`${modality}.costCny must be a non-negative observed number`)
    if (options.requireProduction && result.costSource !== 'provider_receipt' && result.costSource !== 'relay_pricing_snapshot') errors.push(`${modality}.costSource must identify provider_receipt or relay_pricing_snapshot`)
    if (options.requireProduction && result.costSource === 'relay_pricing_snapshot') {
      if (!nonEmpty(result.pricingVersion)) errors.push(`${modality}.pricingVersion is required for relay_pricing_snapshot`)
      if (!nonEmpty(result.pricingGroup)) errors.push(`${modality}.pricingGroup is required for relay_pricing_snapshot`)
    }
    if (options.requireProduction || options.artifactRoot) errors.push(...validateArtifact(result.evidence_ref, options.artifactRoot ?? '', `${modality}.evidence_ref`, { releaseId: value.release_id, result }))
  }
  if (options.requireProduction) {
    const recovery = value.error_recovery
    if (!recovery || typeof recovery !== 'object') errors.push('error_recovery is required for production relay evidence')
    else {
      if (recovery.verified !== true) errors.push('error_recovery.verified must be true')
      if (recovery.failure_status !== 503) errors.push('error_recovery.failure_status must be 503')
      if (!isIsoInstant(recovery.failure_observed_at)) errors.push('error_recovery.failure_observed_at must be an ISO instant')
      if (!isIsoInstant(recovery.recovered_at)) errors.push('error_recovery.recovered_at must be an ISO instant')
      if (isIsoInstant(recovery.failure_observed_at) && isIsoInstant(recovery.recovered_at) && Date.parse(recovery.recovered_at) <= Date.parse(recovery.failure_observed_at)) errors.push('error_recovery.recovered_at must be after failure_observed_at')
      if (!nonEmpty(recovery.failed_request_id)) errors.push('error_recovery.failed_request_id is required')
      if (!nonEmpty(recovery.recovery_request_id)) errors.push('error_recovery.recovery_request_id is required')
      if (nonEmpty(recovery.failed_request_id) && recovery.failed_request_id === recovery.recovery_request_id) errors.push('error_recovery request ids must be distinct')
      errors.push(...validateArtifact(recovery.evidence_ref, options.artifactRoot ?? '', 'error_recovery.evidence_ref', { releaseId: value.release_id, relay: value.relay, recovery }))
    }
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
