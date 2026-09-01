import { readFileSync } from 'node:fs'

const artifact = /^artifact:\/\/production\/[A-Za-z0-9._/-]+#[a-f0-9]{64}$/u
const hex = /^[a-f0-9]{64}$/u

type CutoverEvidence = {
  schema_version?: string
  release_id?: string
  environment?: string
  generated_at?: string
  expires_at?: string
  simulated?: boolean
  source?: string
  database_identity_sha256?: string
  cutover_state?: string
  canonical_read_mode?: string
  canonical_read_enabled?: boolean
  workspace_count?: number
  shadow_check_cycles?: number
  status_counts?: Record<string, number>
  evidence_ref?: string
  rollback_evidence_ref?: string
}

export function validateCanonicalProductCutoverEvidence(document: unknown, options: { expectedReleaseId?: string } = {}): string[] {
  const errors: string[] = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as CutoverEvidence
  if (value.schema_version !== '1') errors.push('schema_version must be 1')
  if (typeof value.release_id !== 'string' || !value.release_id.trim()) errors.push('release_id is required')
  if (options.expectedReleaseId && value.release_id !== options.expectedReleaseId) errors.push(`release_id must match ${options.expectedReleaseId}`)
  if (value.environment !== 'production') errors.push('environment must be production')
  for (const field of ['generated_at', 'expires_at'] as const) if (typeof value[field] !== 'string' || Number.isNaN(Date.parse(value[field]!))) errors.push(`${field} must be an ISO instant`)
  if (value.simulated !== false) errors.push('simulated must be false')
  if (value.source !== 'production_database') errors.push('source must be production_database')
  if (!hex.test(value.database_identity_sha256 ?? '')) errors.push('database_identity_sha256 must be a SHA-256 digest')
  if (value.cutover_state !== 'not_cut_over') errors.push('cutover_state must be not_cut_over until canonical cutover is externally verified')
  if (value.canonical_read_mode !== 'legacy_shadow') errors.push('canonical_read_mode must be legacy_shadow for the current release')
  if (value.canonical_read_enabled !== false) errors.push('canonical_read_enabled must be false for the current release')
  if (!Number.isInteger(value.workspace_count) || value.workspace_count! < 1) errors.push('workspace_count must be a positive integer')
  if (!Number.isInteger(value.shadow_check_cycles) || value.shadow_check_cycles! < 2) errors.push('shadow_check_cycles must be at least two consecutive cycles')
  const statuses = value.status_counts
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) errors.push('status_counts is required')
  else for (const [name, count] of Object.entries(statuses)) if (!Number.isInteger(count) || count < 0) errors.push(`status_counts.${name} must be a non-negative integer`)
  if (!artifact.test(value.evidence_ref ?? '')) errors.push('evidence_ref must be an immutable production artifact')
  if (!artifact.test(value.rollback_evidence_ref ?? '')) errors.push('rollback_evidence_ref must be an immutable production artifact')
  return errors
}

function arg(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function main() {
  const file = arg('--file'); const releaseId = arg('--release-id')
  if (!file || !releaseId) { console.error('--file and --release-id are required'); process.exit(2) }
  let document: unknown
  try { document = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { console.error(`unable to read canonical cutover evidence: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }
  const errors = validateCanonicalProductCutoverEvidence(document, { expectedReleaseId: releaseId })
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log(`canonical product cutover evidence gate passed: ${file} (current release remains legacy_shadow; no cutover claim)`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
