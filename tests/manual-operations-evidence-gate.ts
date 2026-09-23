import { readFileSync } from 'node:fs'
import { validateCapabilityProductionSignature } from './capability-evidence-gate.js'

export type ManualProductionBindings = Parameters<typeof validateCapabilityProductionSignature>[1]

type ManualEvidence = {
  schema_version?: string
  release_id?: string
  workspace_id?: string
  manual_publish_report_id?: string
  verified_by?: string
  environment?: string
  workflow?: string
  official_api_receipt?: boolean
  tenant_isolation_verified?: boolean
  simulated?: boolean
  generated_at?: string
  expires_at?: string
  checks?: Array<{ name?: string; status?: string }>
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u
const MAX_AGE_MS = 24 * 60 * 60_000
const REQUIRED_CHECKS = ['tenant_scope', 'manual_report', 'merchant_visibility'] as const

export function validateManualOperationsEvidence(value: unknown, expectedReleaseId?: string, now = new Date(), production?: ManualProductionBindings): string[] {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['document must be a JSON object']
  const document = value as ManualEvidence
  if (document.schema_version !== 'manual-operations-evidence/1') errors.push('schema_version must be manual-operations-evidence/1')
  if (!document.release_id) errors.push('release_id is required')
  if (expectedReleaseId && document.release_id !== expectedReleaseId) errors.push(`release_id must match ${expectedReleaseId}`)
  if (!document.workspace_id?.trim()) errors.push('workspace_id is required')
  if (!document.manual_publish_report_id?.trim()) errors.push('manual_publish_report_id is required')
  if (!document.verified_by?.trim()) errors.push('verified_by is required')
  if (document.environment !== 'production') errors.push('environment must be production')
  if (document.workflow !== 'public_import_manual_publish') errors.push('workflow must be public_import_manual_publish')
  if (document.official_api_receipt !== false) errors.push('official_api_receipt must be false')
  if (document.tenant_isolation_verified !== true) errors.push('tenant_isolation_verified must be true')
  if (document.simulated !== false) errors.push('simulated must be false')
  const generatedAt = typeof document.generated_at === 'string' && UTC.test(document.generated_at) ? Date.parse(document.generated_at) : Number.NaN
  const expiresAt = typeof document.expires_at === 'string' && UTC.test(document.expires_at) ? Date.parse(document.expires_at) : Number.NaN
  if (!Number.isFinite(generatedAt)) errors.push('generated_at must be a strict UTC ISO timestamp')
  else {
    if (generatedAt > now.getTime() + 300_000) errors.push('generated_at must not be more than five minutes in the future')
    if (now.getTime() - generatedAt > MAX_AGE_MS) errors.push('manual operations evidence is stale')
  }
  if (!Number.isFinite(expiresAt)) errors.push('expires_at must be a strict UTC ISO timestamp')
  else {
    if (expiresAt <= now.getTime()) errors.push('manual operations evidence has expired')
    if (Number.isFinite(generatedAt) && (expiresAt <= generatedAt || expiresAt > generatedAt + MAX_AGE_MS)) errors.push('expires_at must be after generated_at and within 24 hours')
  }
  if (!Array.isArray(document.checks) || document.checks.length < 3) errors.push('checks must contain at least three workflow checks')
  else {
    if (document.checks.some(check => check.status !== 'pass' || typeof check.name !== 'string' || !check.name.trim())) errors.push('every workflow check must have a name and pass status')
    const names = document.checks.map(check => check.name).filter((name): name is string => typeof name === 'string')
    if (new Set(names).size !== names.length) errors.push('workflow check names must be unique')
    for (const required of REQUIRED_CHECKS) if (!names.includes(required)) errors.push(`${required} workflow check is required`)
  }
  if (production) errors.push(...validateCapabilityProductionSignature(value, production))
  return errors
}

function arg(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = arg('--file')
  const releaseId = arg('--release-id')
  if (!file || !releaseId) { console.error('manual operations evidence file and release id are required'); process.exit(2) }
  const production = process.argv.includes('--require-signed-production')
  const imageSetDigest = arg('--image-set-digest'), manifestSha256 = arg('--manifest-sha256'), releaseGitSha = arg('--release-git-sha')
  const deploymentNonce = arg('--deployment-nonce'), publicKeyPath = arg('--public-key'), trustedKeyId = arg('--key-id')
  if (production && (!imageSetDigest || !manifestSha256 || !releaseGitSha || !deploymentNonce || !publicKeyPath || !trustedKeyId)) {
    console.error('signed manual production evidence requires image set, manifest, commit, deployment nonce and fixed trust anchor bindings'); process.exit(2)
  }
  let value: unknown
  try { value = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { console.error(`unable to read evidence: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }
  let bindings: ManualProductionBindings | undefined
  try {
    if (production) bindings = { releaseId, imageSetDigest: imageSetDigest!, manifestSha256: manifestSha256!, releaseGitSha: releaseGitSha!, deploymentNonce: deploymentNonce!, publicKeyPem: readFileSync(publicKeyPath!, 'utf8'), trustedKeyId: trustedKeyId! }
  } catch { console.error('unable to read manual evidence trust anchor'); process.exit(1) }
  const errors = validateManualOperationsEvidence(value, releaseId, new Date(), bindings)
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log(`manual operations evidence gate passed: ${file}${production ? ' (production signature and deployment binding validated)' : ' (schema only; not production attestation)'}`)
}
