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
  'plugin_discovery', 'merchant_start', 'wallet_recharge_entry',
  'platform_oauth_entry', 'asset_attachment', 'error_recovery',
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

const seenScenarioIds = new Set()
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
  const result = { id, state: 'passed', evidence_ref: evidenceRef(artifact), console_errors: 0, network_errors: 0 }
  if (id === 'error_recovery') {
    if (!scenario.error_recovery || scenario.error_recovery.trigger_http_status !== 503 || scenario.error_recovery.trigger_error_code !== 'MODEL_PROVIDER_OUTCOME_UNKNOWN') {
      throw new Error('error_recovery must include a real 503 MODEL_PROVIDER_OUTCOME_UNKNOWN capture')
    }
    const outcomeArtifact = hashFile(scenario.error_recovery.outcome_artifact_path)
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
  environment: capture.environment,
  generated_at: capture.generated_at,
  host,
  app_version: String(capture.app_version ?? ''),
  plugin_version: String(capture.plugin_version ?? ''),
  mcp_base_url: String(capture.mcp_base_url),
  bridge_sha256: String(capture.bridge_sha256),
  simulated: false,
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
