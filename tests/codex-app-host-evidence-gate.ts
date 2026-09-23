import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { isIP } from 'node:net'
import { resolve, sep } from 'node:path'

const REQUIRED_SCENARIOS = [
  'plugin_discovery',
  'merchant_start',
  'merchant_payment_status',
  'manual_publish_workflow',
  'asset_attachment',
  'error_recovery',
  'image_generation',
  'automatic_scan',
  'candidate_images_rendered',
  'candidate_primary_cta',
  'candidate_selection_persisted',
  'selection_not_reviewed',
  'selection_not_published',
  'automation_read_only',
  'automation_host_absent',
] as const
type ScenarioId = typeof REQUIRED_SCENARIOS[number]
type ErrorRecoveryEvidence = {
  trigger_http_status?: number
  trigger_error_code?: string
  request_id?: string
  trace_id?: string
  recovery_action?: 'query_provider' | 'refresh_status' | 'manual_reconcile'
  retry_allowed?: boolean
  before_state?: 'provider_started' | 'outcome_unknown'
  after_state?: 'reconciled_succeeded' | 'reconciled_failed' | 'outcome_unknown'
  reconciliation_required?: boolean
  outcome_evidence_ref?: string
}
type Scenario = { id?: ScenarioId; state?: string; evidence_ref?: string; console_errors?: number; network_errors?: number; error_recovery?: ErrorRecoveryEvidence }
type CandidateRoute = { expected_git_sha?: string; expected_manifest_sha256?: string; expected_image_set_digest?: string; candidate_api_container_id?: string; gateway_container_id?: string; mcp_config_sha256?: string; route_file_sha256?: string; release_probe_evidence_ref?: string }
type HostEvidence = { schema_version?: string; release_id?: string; manifest_sha256?: string; environment?: string; generated_at?: string; host?: string; app_version?: string; plugin_version?: string; mcp_base_url?: string; bridge_sha256?: string; simulated?: boolean; candidate_route?: CandidateRoute; scenarios?: Scenario[] }

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const forbidden = /(?:fixture|mock|local|localhost|127\.0\.0\.1|test_e2e)/iu
// A non-local hostname is not sufficient proof that the capture came from the
// supported ChatGPT/Codex host. Keep the accepted identifier deliberately
// narrow so a browser, arbitrary desktop shell, or another app cannot be
// relabelled as host evidence.
const supportedHostIdentifier = /^(?:codex-app|chatgpt)(?:[-_.][A-Za-z0-9][A-Za-z0-9._-]*)?$/u
const immutableArtifact = /^artifact:\/\/production\/[A-Za-z0-9._/-]+#[a-f0-9]{64}$/u
const sha256 = /^[a-f0-9]{64}$/u
const imageSetDigest = /^sha256:[a-f0-9]{64}$/u
const gitSha = /^[a-f0-9]{40}$/u
const strictUtcInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u

function canonicalPublicOrigin(value: unknown): string | undefined {
  if (!nonEmpty(value)) return undefined
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) return undefined
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
    if (parsed.hostname !== parsed.hostname.toLowerCase() || forbidden.test(parsed.hostname) || isIP(hostname) !== 0) return undefined
    return parsed.origin
  } catch { return undefined }
}

function validateArtifact(reference: string | undefined, root: string, label: string): string[] {
  const match = immutableArtifact.exec(reference ?? '')
  if (!match) return [`${label} must be an immutable production artifact with SHA-256 fragment`]
  const relative = match[0].slice('artifact://production/'.length).split('#')[0]!
  if (relative.split('/').some(segment => segment === '.' || segment === '..' || segment.length === 0)) return [`${label} contains an invalid artifact path`]
  try {
    const realRoot = realpathSync(root); const candidate = resolve(realRoot, relative)
    if (candidate !== realRoot && !candidate.startsWith(`${realRoot}${sep}`)) return [`${label} escapes the artifact root`]
    const stat = lstatSync(candidate)
    if (stat.isSymbolicLink() || !stat.isFile()) return [`${label} must resolve to a regular non-symlink artifact`]
    const realCandidate = realpathSync(candidate)
    if (!realCandidate.startsWith(`${realRoot}${sep}`)) return [`${label} escapes the artifact root`]
    const hash = createHash('sha256'); const descriptor = openSync(realCandidate, 'r'); const buffer = Buffer.allocUnsafe(64 * 1024)
    try { for (let bytes = readSync(descriptor, buffer, 0, buffer.length, null); bytes > 0; bytes = readSync(descriptor, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, bytes)) }
    finally { closeSync(descriptor) }
    if (hash.digest('hex') !== match[0].split('#')[1]) return [`${label} SHA-256 does not match the referenced artifact`]
  } catch { return [`${label} referenced artifact does not exist or cannot be read`] }
  return []
}

function validateReleaseProbe(reference: string | undefined, root: string, releaseId: string | undefined, route: CandidateRoute): string[] {
  if (!immutableArtifact.test(reference ?? '')) return []
  try {
    const relative = reference!.slice('artifact://production/'.length).split('#')[0]!
    const path = resolve(realpathSync(root), relative)
    if (lstatSync(path).size > 64 * 1024) return ['candidate_route.release_probe_evidence_ref must be a bounded /releasez JSON response']
    const probe = JSON.parse(readFileSync(path, 'utf8')) as { data?: { ready?: boolean; release?: { release_id?: string; release_git_sha?: string; manifest_sha256?: string; image_set_digest?: string } } }
    const observed = probe.data?.release
    if (probe.data?.ready !== true || observed?.release_id !== releaseId || observed?.release_git_sha !== route.expected_git_sha || observed?.manifest_sha256 !== route.expected_manifest_sha256 || observed?.image_set_digest !== route.expected_image_set_digest) return ['candidate_route.release_probe_evidence_ref must contain the frozen candidate /releasez identity']
  } catch { return ['candidate_route.release_probe_evidence_ref must contain a readable /releasez JSON response'] }
  return []
}

export function validateCodexAppHostEvidence(document: unknown, options: { expectedReleaseId?: string; expectedManifestSha256?: string; expectedMcpBaseUrl?: string; expectedBridgeSha256?: string; expectedGitSha?: string; expectedImageSetDigest?: string; artifactRoot?: string; requireFresh?: boolean; now?: Date } = {}): string[] {
  const errors: string[] = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as HostEvidence
  if (value.schema_version !== '2') errors.push('schema_version must be 2')
  if (!nonEmpty(value.release_id)) errors.push('release_id is required')
  if (options.expectedReleaseId && value.release_id !== options.expectedReleaseId) errors.push(`release_id must match ${options.expectedReleaseId}`)
  if (!sha256.test(value.manifest_sha256 ?? '')) errors.push('manifest_sha256 must be a SHA-256 digest')
  if (options.expectedManifestSha256 && value.manifest_sha256 !== options.expectedManifestSha256) errors.push(`manifest_sha256 must match ${options.expectedManifestSha256}`)
  if (value.environment !== 'preproduction' && value.environment !== 'production') errors.push('environment must be preproduction or production')
  if (!nonEmpty(value.generated_at) || !strictUtcInstant.test(value.generated_at) || Number.isNaN(Date.parse(value.generated_at))) errors.push('generated_at must be a strict UTC ISO timestamp')
  else if (options.requireFresh) {
    const generatedAt = Date.parse(value.generated_at); const now = (options.now ?? new Date()).getTime()
    if (generatedAt > now + 300_000) errors.push('generated_at must not be more than five minutes in the future')
    if (now - generatedAt > 24 * 3_600_000) errors.push('Codex App host evidence is stale')
  }
  for (const [field, label] of [['host', 'host'], ['app_version', 'app_version'], ['plugin_version', 'plugin_version']] as const) {
    if (!nonEmpty(value[field])) errors.push(`${label} is required`)
    else if (forbidden.test(value[field]!)) errors.push(`${label} must identify a real Codex App host, not fixture/local evidence`)
  }
  if (nonEmpty(value.host) && !forbidden.test(value.host) && !supportedHostIdentifier.test(value.host.trim())) errors.push('host must identify a supported ChatGPT/Codex App host')
  if (value.simulated !== false) errors.push('simulated must be false')
  const mcpOrigin = canonicalPublicOrigin(value.mcp_base_url)
  if (!mcpOrigin || value.mcp_base_url !== mcpOrigin) errors.push('mcp_base_url must be a canonical public HTTPS root origin')
  const expectedMcpOrigin = canonicalPublicOrigin(options.expectedMcpBaseUrl)
  if (options.expectedMcpBaseUrl && (!expectedMcpOrigin || mcpOrigin !== expectedMcpOrigin)) errors.push('mcp_base_url must match the deployment configuration')
  if (!sha256.test(value.bridge_sha256 ?? '')) errors.push('bridge_sha256 must be a SHA-256 digest')
  if (options.expectedBridgeSha256 && value.bridge_sha256 !== options.expectedBridgeSha256) errors.push('bridge_sha256 must match the deployed plugin bridge')
  if (value.environment === 'preproduction' && options.requireFresh) {
    const route = value.candidate_route
    if (!route || typeof route !== 'object') errors.push('candidate_route is required for preproduction host evidence')
    else {
      if (!gitSha.test(route.expected_git_sha ?? '')) errors.push('candidate_route.expected_git_sha must be a full Git SHA')
      if (!sha256.test(route.expected_manifest_sha256 ?? '')) errors.push('candidate_route.expected_manifest_sha256 must be a SHA-256 digest')
      if (!imageSetDigest.test(route.expected_image_set_digest ?? '')) errors.push('candidate_route.expected_image_set_digest must be a SHA-256 digest')
      if (options.expectedGitSha && route.expected_git_sha !== options.expectedGitSha) errors.push('candidate_route.expected_git_sha must match the release candidate')
      if (options.expectedManifestSha256 && route.expected_manifest_sha256 !== options.expectedManifestSha256) errors.push('candidate_route.expected_manifest_sha256 must match the release candidate')
      if (options.expectedImageSetDigest && route.expected_image_set_digest !== options.expectedImageSetDigest) errors.push('candidate_route.expected_image_set_digest must match the release candidate')
      for (const field of ['candidate_api_container_id', 'gateway_container_id', 'mcp_config_sha256', 'route_file_sha256'] as const) {
        if (!sha256.test(route[field] ?? '')) errors.push(`candidate_route.${field} must be a SHA-256 or full Docker ID`)
      }
      if (!nonEmpty(route.release_probe_evidence_ref) || !immutableArtifact.test(route.release_probe_evidence_ref)) errors.push('candidate_route.release_probe_evidence_ref must be an immutable production artifact')
      else if (options.artifactRoot) {
        const artifactErrors = validateArtifact(route.release_probe_evidence_ref, options.artifactRoot, 'candidate_route.release_probe_evidence_ref')
        errors.push(...artifactErrors)
        if (artifactErrors.length === 0) errors.push(...validateReleaseProbe(route.release_probe_evidence_ref, options.artifactRoot, value.release_id, route))
      }
    }
  }
  if (!Array.isArray(value.scenarios)) return [...errors, 'scenarios is required']
  const seen = new Set<string>()
  const usedArtifacts = new Set<string>(value.candidate_route?.release_probe_evidence_ref ? [value.candidate_route.release_probe_evidence_ref] : [])
  for (const scenario of value.scenarios) {
    if (!scenario || typeof scenario !== 'object' || !nonEmpty(scenario.id)) { errors.push('each scenario must have an id'); continue }
    if (seen.has(scenario.id)) errors.push(`duplicate scenario: ${scenario.id}`)
    seen.add(scenario.id)
    if (scenario.state !== 'passed') errors.push(`${scenario.id}.state must be passed`)
    if (!nonEmpty(scenario.evidence_ref) || !immutableArtifact.test(scenario.evidence_ref)) errors.push(`${scenario.id}.evidence_ref must be an immutable production artifact`)
    else if (options.artifactRoot) errors.push(...validateArtifact(scenario.evidence_ref, options.artifactRoot, `${scenario.id}.evidence_ref`))
    if (nonEmpty(scenario.evidence_ref)) {
      if (usedArtifacts.has(scenario.evidence_ref)) errors.push(`${scenario.id}.evidence_ref must not reuse the release probe or another scenario artifact`)
      usedArtifacts.add(scenario.evidence_ref)
    }
    if (scenario.console_errors !== 0) errors.push(`${scenario.id}.console_errors must be 0`)
    if (scenario.network_errors !== 0) errors.push(`${scenario.id}.network_errors must be 0`)
    if (scenario.id === 'error_recovery') {
      const recovery = scenario.error_recovery
      if (!recovery || typeof recovery !== 'object') errors.push('error_recovery.evidence is required')
      else {
        if (recovery.trigger_http_status !== 503) errors.push('error_recovery.trigger_http_status must be 503')
        if (recovery.trigger_error_code !== 'MODEL_PROVIDER_OUTCOME_UNKNOWN') errors.push('error_recovery.trigger_error_code must be MODEL_PROVIDER_OUTCOME_UNKNOWN')
        for (const field of ['request_id', 'trace_id'] as const) if (!nonEmpty(recovery[field]) || recovery[field]!.length > 256 || /[\u0000-\u001f\u007f]/u.test(recovery[field]!)) errors.push(`error_recovery.${field} must be a safe correlation id`)
        if (!['query_provider', 'refresh_status', 'manual_reconcile'].includes(recovery.recovery_action ?? '')) errors.push('error_recovery.recovery_action must be an approved recovery action')
        if (recovery.retry_allowed !== false) errors.push('error_recovery.retry_allowed must be false')
        if (!['provider_started', 'outcome_unknown'].includes(recovery.before_state ?? '')) errors.push('error_recovery.before_state is invalid')
        if (!['reconciled_succeeded', 'reconciled_failed', 'outcome_unknown'].includes(recovery.after_state ?? '')) errors.push('error_recovery.after_state is invalid')
        if (recovery.reconciliation_required !== true) errors.push('error_recovery.reconciliation_required must be true')
        if (!immutableArtifact.test(recovery.outcome_evidence_ref ?? '')) errors.push('error_recovery.outcome_evidence_ref must be an immutable production artifact')
        else if (options.artifactRoot) errors.push(...validateArtifact(recovery.outcome_evidence_ref, options.artifactRoot, 'error_recovery.outcome_evidence_ref'))
        if (recovery.outcome_evidence_ref === scenario.evidence_ref) errors.push('error_recovery.outcome_evidence_ref must be a separate reconciliation artifact')
        if (recovery.outcome_evidence_ref === value.candidate_route?.release_probe_evidence_ref) errors.push('error_recovery.outcome_evidence_ref must not reuse the release probe')
      }
    }
  }
  for (const id of REQUIRED_SCENARIOS) if (!seen.has(id)) errors.push(`${id} scenario is required`)
  return errors
}

function main() {
  const args = process.argv.slice(2)
  const fileIndex = args.indexOf('--file')
  const path = fileIndex >= 0 ? args[fileIndex + 1] : undefined
  const releaseIndex = args.indexOf('--release-id')
  const expectedReleaseId = releaseIndex >= 0 ? args[releaseIndex + 1] : undefined
  const artifactIndex = args.indexOf('--artifact-root')
  const artifactRoot = artifactIndex >= 0 ? args[artifactIndex + 1] : undefined
  const mcpIndex = args.indexOf('--expected-mcp-base-url')
  const expectedMcpBaseUrl = mcpIndex >= 0 ? args[mcpIndex + 1] : undefined
  const bridgeIndex = args.indexOf('--expected-bridge-sha256')
  const expectedBridgeSha256 = bridgeIndex >= 0 ? args[bridgeIndex + 1] : undefined
  const gitIndex = args.indexOf('--expected-git-sha')
  const expectedGitSha = gitIndex >= 0 ? args[gitIndex + 1] : undefined
  const imageIndex = args.indexOf('--expected-image-set-digest')
  const expectedImageSetDigest = imageIndex >= 0 ? args[imageIndex + 1] : undefined
  const manifestIndex = args.indexOf('--expected-manifest-sha256')
  const expectedManifestSha256 = manifestIndex >= 0 ? args[manifestIndex + 1] : undefined
  if (!path) { console.error('--file is required'); process.exit(2) }
  if (args.includes('--require-artifacts') && !artifactRoot) { console.error('--artifact-root is required for independent host evidence validation'); process.exit(2) }
  if (args.includes('--require-artifacts') && (!expectedReleaseId || !expectedMcpBaseUrl || !expectedBridgeSha256 || !expectedGitSha || !expectedImageSetDigest || !expectedManifestSha256 || !sha256.test(expectedManifestSha256))) { console.error('--release-id, --expected-mcp-base-url, --expected-bridge-sha256, --expected-git-sha, --expected-manifest-sha256 and --expected-image-set-digest are required for host evidence validation'); process.exit(2) }
  let document: unknown
  try { document = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { console.error(`unable to read Codex App host evidence: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }
  const errors = validateCodexAppHostEvidence(document, { expectedReleaseId, expectedManifestSha256, expectedMcpBaseUrl, expectedBridgeSha256, expectedGitSha, expectedImageSetDigest, artifactRoot, requireFresh: args.includes('--require-artifacts') })
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log(`Codex App host evidence consistency gate passed: ${path} (real ChatGPT/Codex host provenance still requires operator review)`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
