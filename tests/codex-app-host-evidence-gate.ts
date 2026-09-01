import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const REQUIRED_SCENARIOS = [
  'plugin_discovery',
  'merchant_start',
  'wallet_recharge_entry',
  'platform_oauth_entry',
  'asset_attachment',
  'error_recovery',
  'image_generation',
  'automatic_scan',
  'candidate_images_rendered',
  'candidate_primary_cta',
  'candidate_selection_persisted',
  'selection_not_reviewed',
  'selection_not_published',
] as const
type ScenarioId = typeof REQUIRED_SCENARIOS[number]
type Scenario = { id?: ScenarioId; state?: string; evidence_ref?: string; console_errors?: number; network_errors?: number }
type HostEvidence = { schema_version?: string; release_id?: string; environment?: string; generated_at?: string; host?: string; app_version?: string; plugin_version?: string; mcp_base_url?: string; bridge_sha256?: string; simulated?: boolean; scenarios?: Scenario[] }

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const forbidden = /(?:fixture|mock|local|localhost|127\.0\.0\.1|test_e2e)/iu
const immutableArtifact = /^artifact:\/\/production\/[A-Za-z0-9._/-]+#[a-f0-9]{64}$/u
const sha256 = /^[a-f0-9]{64}$/u

function canonicalPublicOrigin(value: unknown): string | undefined {
  if (!nonEmpty(value)) return undefined
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) return undefined
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
    const privateLiteral = hostname === '::1' || /^10\./u.test(hostname) || /^169\.254\./u.test(hostname) || /^192\.168\./u.test(hostname) || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(hostname) || /^(?:fc|fd)[0-9a-f]{2}:/u.test(hostname) || /^fe[89ab][0-9a-f]:/u.test(hostname)
    if (parsed.hostname !== parsed.hostname.toLowerCase() || forbidden.test(parsed.hostname) || privateLiteral) return undefined
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

export function validateCodexAppHostEvidence(document: unknown, options: { expectedReleaseId?: string; expectedMcpBaseUrl?: string; expectedBridgeSha256?: string; artifactRoot?: string } = {}): string[] {
  const errors: string[] = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as HostEvidence
  if (value.schema_version !== '2') errors.push('schema_version must be 2')
  if (!nonEmpty(value.release_id)) errors.push('release_id is required')
  if (options.expectedReleaseId && value.release_id !== options.expectedReleaseId) errors.push(`release_id must match ${options.expectedReleaseId}`)
  if (value.environment !== 'preproduction' && value.environment !== 'production') errors.push('environment must be preproduction or production')
  if (!nonEmpty(value.generated_at) || Number.isNaN(Date.parse(value.generated_at))) errors.push('generated_at must be an ISO instant')
  for (const [field, label] of [['host', 'host'], ['app_version', 'app_version'], ['plugin_version', 'plugin_version']] as const) {
    if (!nonEmpty(value[field])) errors.push(`${label} is required`)
    else if (forbidden.test(value[field]!)) errors.push(`${label} must identify a real Codex App host, not fixture/local evidence`)
  }
  if (value.simulated !== false) errors.push('simulated must be false')
  const mcpOrigin = canonicalPublicOrigin(value.mcp_base_url)
  if (!mcpOrigin || value.mcp_base_url !== mcpOrigin) errors.push('mcp_base_url must be a canonical public HTTPS root origin')
  const expectedMcpOrigin = canonicalPublicOrigin(options.expectedMcpBaseUrl)
  if (options.expectedMcpBaseUrl && (!expectedMcpOrigin || mcpOrigin !== expectedMcpOrigin)) errors.push('mcp_base_url must match the deployment configuration')
  if (!sha256.test(value.bridge_sha256 ?? '')) errors.push('bridge_sha256 must be a SHA-256 digest')
  if (options.expectedBridgeSha256 && value.bridge_sha256 !== options.expectedBridgeSha256) errors.push('bridge_sha256 must match the deployed plugin bridge')
  if (!Array.isArray(value.scenarios)) return [...errors, 'scenarios is required']
  const seen = new Set<string>()
  for (const scenario of value.scenarios) {
    if (!scenario || typeof scenario !== 'object' || !nonEmpty(scenario.id)) { errors.push('each scenario must have an id'); continue }
    if (seen.has(scenario.id)) errors.push(`duplicate scenario: ${scenario.id}`)
    seen.add(scenario.id)
    if (scenario.state !== 'passed') errors.push(`${scenario.id}.state must be passed`)
    if (!nonEmpty(scenario.evidence_ref) || !immutableArtifact.test(scenario.evidence_ref)) errors.push(`${scenario.id}.evidence_ref must be an immutable production artifact`)
    else if (options.artifactRoot) errors.push(...validateArtifact(scenario.evidence_ref, options.artifactRoot, `${scenario.id}.evidence_ref`))
    if (scenario.console_errors !== 0) errors.push(`${scenario.id}.console_errors must be 0`)
    if (scenario.network_errors !== 0) errors.push(`${scenario.id}.network_errors must be 0`)
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
  if (!path) { console.error('--file is required'); process.exit(2) }
  if (args.includes('--require-artifacts') && !artifactRoot) { console.error('--artifact-root is required for independent host evidence validation'); process.exit(2) }
  if (args.includes('--require-artifacts') && (!expectedMcpBaseUrl || !expectedBridgeSha256)) { console.error('--expected-mcp-base-url and --expected-bridge-sha256 are required for production host evidence validation'); process.exit(2) }
  let document: unknown
  try { document = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { console.error(`unable to read Codex App host evidence: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }
  const errors = validateCodexAppHostEvidence(document, { expectedReleaseId, expectedMcpBaseUrl, expectedBridgeSha256, artifactRoot })
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log(`Codex App host evidence gate passed: ${path} (external host evidence; not stdio or browser fixture evidence)`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
