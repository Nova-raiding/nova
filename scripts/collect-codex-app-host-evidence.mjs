#!/usr/bin/env node

/**
 * Build release-bound ChatGPT/Codex App host evidence from a real host capture.
 *
 * This tool intentionally refuses local/fixture/browser captures. It only
 * hashes artifact files supplied by the operator and emits an immutable
 * evidence document for tests/codex-app-host-evidence-gate.ts.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative, sep } from 'node:path'

const REQUIRED_SCENARIOS = [
  'plugin_discovery', 'merchant_start', 'merchant_payment_status',
  'manual_publish_workflow', 'asset_attachment', 'error_recovery',
  'image_generation', 'automatic_scan', 'candidate_images_rendered',
  'candidate_primary_cta', 'candidate_selection_persisted',
  'selection_not_reviewed', 'selection_not_published',
  'automation_read_only', 'automation_host_absent',
]

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  const value = process.argv[i + 1]
  if (!key?.startsWith('--') || !value) throw new Error(`invalid argument: ${key ?? ''}`)
  args.set(key.slice(2), value)
}

const inputPath = args.get('capture')
const outputPath = args.get('output')
const artifactRoot = args.get('artifact-root')
if (!inputPath || !outputPath || !artifactRoot) {
  console.error('usage: collect-codex-app-host-evidence.mjs --capture <real-host-capture.json> --output <evidence.json> --artifact-root <root>')
  process.exit(2)
}

const capture = JSON.parse(readFileSync(resolve(inputPath), 'utf8'))
const forbidden = /(?:fixture|mock|local|localhost|127\.0\.0\.1|test_e2e)/iu
const host = String(capture.host ?? '').trim()
if (!/^(?:codex-app|chatgpt)(?:[-_.][A-Za-z0-9][A-Za-z0-9._-]*)?$/u.test(host) || forbidden.test(host)) {
  throw new Error('capture.host must identify the real ChatGPT/Codex App host')
}
if (capture.simulated !== false) throw new Error('capture.simulated must be false')
if (capture.environment !== 'preproduction' && capture.environment !== 'production') {
  throw new Error('capture.environment must be preproduction or production')
}
if (capture.environment === 'production' && (!/^[a-f0-9]{40}$/u.test(capture.release_git_sha ?? '') || !/^sha256:[a-f0-9]{64}$/u.test(capture.image_set_digest ?? ''))) {
  throw new Error('production capture requires exact release_git_sha and image_set_digest from the deployed /releasez response')
}
if (capture.environment === 'production' && !/^[A-Za-z0-9_-]{22,128}$/u.test(capture.deployment_nonce ?? '')) {
  throw new Error('production capture requires the consumed deployment nonce for this cutover')
}
if (typeof capture.generated_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(capture.generated_at) || Number.isNaN(Date.parse(capture.generated_at))) {
  throw new Error('capture.generated_at must be a strict UTC ISO timestamp from the real host capture')
}
if (!/^https:\/\//u.test(String(capture.mcp_base_url ?? '')) || forbidden.test(String(capture.mcp_base_url))) {
  throw new Error('capture.mcp_base_url must be a public HTTPS origin, not local or fixture')
}
if (!/^[a-f0-9]{64}$/u.test(String(capture.bridge_sha256 ?? ''))) {
  throw new Error('capture.bridge_sha256 must be a SHA-256 digest')
}
for (const [field, label] of [['release_id', 'release_id'], ['app_version', 'app_version'], ['plugin_version', 'plugin_version']] ) {
  if (!String(capture[field] ?? '').trim() || forbidden.test(String(capture[field]))) {
    throw new Error(`capture.${label} must be a non-empty real release/version value`)
  }
}
if (!Array.isArray(capture.scenarios)) throw new Error('capture.scenarios must be an array')

const root = realpathSync(resolve(artifactRoot))
const hashFile = file => {
  const requested = resolve(file)
  if (!existsSync(requested) || lstatSync(requested).isSymbolicLink() || !lstatSync(requested).isFile()) {
    throw new Error(`scenario artifact must be a regular file under artifact root: ${file}`)
  }
  const absolute = realpathSync(requested)
  if (!absolute.startsWith(`${root}${sep}`)) throw new Error(`scenario artifact must be a regular file under artifact root: ${file}`)
  const body = readFileSync(absolute)
  return { absolute, digest: createHash('sha256').update(body).digest('hex') }
}

const evidenceRef = artifact => `artifact://production/${relative(root, artifact.absolute).split('\\').join('/')}#${artifact.digest}`

let candidateRoute
if (capture.environment === 'preproduction') {
  const route = capture.candidate_route
  if (!route || typeof route !== 'object') throw new Error('preproduction capture requires candidate_route from the isolated TLS host run')
  if (!/^[a-f0-9]{40}$/u.test(route.expected_git_sha ?? '') || !/^[a-f0-9]{64}$/u.test(route.expected_manifest_sha256 ?? '') || !/^sha256:[a-f0-9]{64}$/u.test(route.expected_image_set_digest ?? '')) throw new Error('candidate_route requires frozen Git, manifest, and image-set identities')
  if (capture.manifest_sha256 !== route.expected_manifest_sha256) throw new Error('manifest_sha256 must match the frozen candidate route identity')
  for (const field of ['candidate_api_container_id', 'gateway_container_id', 'mcp_config_sha256', 'route_file_sha256']) {
    if (!/^[a-f0-9]{64}$/u.test(route[field] ?? '')) throw new Error(`candidate_route.${field} requires a full Docker ID or SHA-256`)
  }
  const probe = hashFile(route.release_probe_artifact_path)
  if (lstatSync(probe.absolute).size > 64 * 1024) throw new Error('candidate route probe must be a bounded /releasez JSON response')
  let observed
  try { observed = JSON.parse(readFileSync(probe.absolute, 'utf8'))?.data } catch { throw new Error('candidate_route.release_probe_artifact_path must contain /releasez JSON') }
  if (observed?.ready !== true || observed.release?.release_id !== capture.release_id || observed.release?.release_git_sha !== route.expected_git_sha || observed.release?.manifest_sha256 !== route.expected_manifest_sha256 || observed.release?.image_set_digest !== route.expected_image_set_digest) throw new Error('candidate route probe does not match the frozen release')
  candidateRoute = {
    expected_git_sha: route.expected_git_sha,
    expected_manifest_sha256: route.expected_manifest_sha256,
    expected_image_set_digest: route.expected_image_set_digest,
    candidate_api_container_id: route.candidate_api_container_id,
    gateway_container_id: route.gateway_container_id,
    mcp_config_sha256: route.mcp_config_sha256,
    route_file_sha256: route.route_file_sha256,
    release_probe_evidence_ref: evidenceRef(probe),
  }
}

if (!/^[a-f0-9]{64}$/u.test(capture.manifest_sha256 ?? '')) throw new Error('manifest_sha256 must be a frozen release SHA-256')

const seenScenarioIds = new Set()
const usedArtifacts = new Set(candidateRoute ? [realpathSync(resolve(capture.candidate_route.release_probe_artifact_path))] : [])
const scenarios = capture.scenarios.map(scenario => {
  if (!scenario || typeof scenario !== 'object') throw new Error('scenario must be an object')
  const id = String(scenario.id ?? '')
  if (!REQUIRED_SCENARIOS.includes(id)) throw new Error(`unknown scenario: ${id}`)
  if (seenScenarioIds.has(id)) throw new Error(`duplicate scenario: ${id}`)
  seenScenarioIds.add(id)
  if (scenario.state !== 'passed' || scenario.console_errors !== 0 || scenario.network_errors !== 0) {
    throw new Error(`${id} must be passed with zero console/network errors`)
  }
  const artifact = hashFile(scenario.artifact_path)
  if (usedArtifacts.has(artifact.absolute)) throw new Error(`${id} must have its own host artifact, separate from the release probe`)
  usedArtifacts.add(artifact.absolute)
  const result = { id, state: 'passed', evidence_ref: evidenceRef(artifact), console_errors: 0, network_errors: 0 }
  if (id === 'error_recovery') {
    if (!scenario.error_recovery || scenario.error_recovery.trigger_http_status !== 503 || scenario.error_recovery.trigger_error_code !== 'MODEL_PROVIDER_OUTCOME_UNKNOWN') {
      throw new Error('error_recovery must include a real 503 MODEL_PROVIDER_OUTCOME_UNKNOWN capture')
    }
    const outcomeArtifact = hashFile(scenario.error_recovery.outcome_artifact_path)
    if (outcomeArtifact.absolute === artifact.absolute) throw new Error('error_recovery outcome must be a separate reconciliation artifact')
    if (usedArtifacts.has(outcomeArtifact.absolute)) throw new Error('error_recovery outcome must not reuse the release probe or a scenario artifact')
    result.error_recovery = {
      ...scenario.error_recovery,
      outcome_evidence_ref: evidenceRef(outcomeArtifact),
    }
    delete result.error_recovery.outcome_artifact_path
  }
  delete scenario.artifact_path
  return result
})

for (const id of REQUIRED_SCENARIOS) if (!seenScenarioIds.has(id)) throw new Error(`missing required scenario: ${id}`)

const evidence = {
  schema_version: '2',
  release_id: String(capture.release_id ?? ''),
  ...(capture.environment === 'production' ? { release_git_sha: capture.release_git_sha, image_set_digest: capture.image_set_digest, deployment_nonce: capture.deployment_nonce } : {}),
  manifest_sha256: capture.manifest_sha256,
  environment: capture.environment,
  generated_at: capture.generated_at,
  host,
  app_version: String(capture.app_version ?? ''),
  plugin_version: String(capture.plugin_version ?? ''),
  mcp_base_url: String(capture.mcp_base_url),
  bridge_sha256: String(capture.bridge_sha256),
  simulated: false,
  ...(candidateRoute ? { candidate_route: candidateRoute } : {}),
  scenarios,
}
mkdirSync(dirname(resolve(outputPath)), { recursive: true })
const serialized = `${JSON.stringify(evidence, null, 2)}\n`
const absoluteOutput = resolve(outputPath)
if (existsSync(absoluteOutput)) {
  const existing = readFileSync(absoluteOutput, 'utf8')
  if (existing !== serialized) throw new Error(`refusing to overwrite existing host evidence: ${outputPath}`)
} else {
  writeFileSync(absoluteOutput, serialized, { mode: 0o600 })
}
console.log(`wrote real ChatGPT/Codex host evidence: ${outputPath}`)
