import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { validateCapabilityProductionSignature } from './capability-evidence-gate.js'

export type ManualProductionBindings = Parameters<typeof validateCapabilityProductionSignature>[1]

type ManualEvidence = {
  schema_version?: string
  release_id?: string
  workspace_id?: string
  isolation_probe_workspace_id?: string
  manual_evidence_boundary?: string
  manual_publish_state?: string
  capture_journal?: {
    schema_version?: string
    captured_at?: string
    candidate_identity?: { release_id?: string; release_git_sha?: string; manifest_sha256?: string; image_set_digest?: string }
    observations?: Array<{ name?: string; status?: number; material?: Record<string, unknown>; observation_sha256?: string }>
  }
  capture_journal_sha256?: string
  manual_publish_report_id?: string
  verified_by?: string
  environment?: string
  workflow?: string
  official_api_receipt?: boolean
  tenant_isolation_verified?: boolean
  simulated?: boolean
  generated_at?: string
  expires_at?: string
  checks?: Array<{ name?: string; status?: string; observation?: string }>
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u
const MAX_AGE_MS = 24 * 60 * 60_000
const REQUIRED_CHECKS = ['tenant_scope', 'manual_report', 'merchant_visibility'] as const
const REQUIRED_OBSERVATIONS = ['release', 'target_list', 'target_get', 'isolation'] as const
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

export function validateManualOperationsEvidence(value: unknown, expectedReleaseId?: string, now = new Date(), production?: ManualProductionBindings): string[] {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['document must be a JSON object']
  const document = value as ManualEvidence
  if (document.schema_version !== 'manual-operations-evidence/1') errors.push('schema_version must be manual-operations-evidence/1')
  if (!document.release_id) errors.push('release_id is required')
  if (expectedReleaseId && document.release_id !== expectedReleaseId) errors.push(`release_id must match ${expectedReleaseId}`)
  if (!document.workspace_id?.trim()) errors.push('workspace_id is required')
  if (!document.isolation_probe_workspace_id?.trim()) errors.push('isolation_probe_workspace_id is required')
  else if (document.isolation_probe_workspace_id === document.workspace_id) errors.push('isolation probe workspace must differ from target workspace')
  if (!document.manual_publish_report_id?.trim()) errors.push('manual_publish_report_id is required')
  if (!document.verified_by?.trim()) errors.push('verified_by is required')
  if (document.environment !== 'production') errors.push('environment must be production')
  if (document.workflow !== 'public_import_manual_publish') errors.push('workflow must be public_import_manual_publish')
  if (document.official_api_receipt !== false) errors.push('official_api_receipt must be false')
  if (document.tenant_isolation_verified !== true) errors.push('tenant_isolation_verified must be true')
  if (document.simulated !== false) errors.push('simulated must be false')
  if (document.manual_evidence_boundary !== 'manual_unverified') errors.push('manual_evidence_boundary must be manual_unverified')
  if (!['manual_publish_in_progress', 'manual_publish_reported', 'manual_review_required'].includes(document.manual_publish_state ?? '')) errors.push('manual_publish_state must be a recognized manual workflow state')
  const journal = document.capture_journal
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) errors.push('capture_journal is required')
  else {
    if (journal.schema_version !== 'manual-operations-capture-journal/1') errors.push('capture_journal schema_version is invalid')
    if (Object.keys(journal).sort().join(',') !== 'candidate_identity,captured_at,observations,schema_version') errors.push('capture_journal fields are invalid')
    if (journal.captured_at !== document.generated_at) errors.push('capture_journal captured_at must match generated_at')
    const identity = journal.candidate_identity
    if (!identity || identity.release_id !== document.release_id || !/^[a-f0-9]{40}$/u.test(identity.release_git_sha ?? '')
      || !/^[a-f0-9]{64}$/u.test(identity.manifest_sha256 ?? '') || !/^sha256:[a-f0-9]{64}$/u.test(identity.image_set_digest ?? '')) {
      errors.push('capture_journal candidate identity is invalid or not release-bound')
    }
    if (identity && Object.keys(identity).sort().join(',') !== 'image_set_digest,manifest_sha256,release_git_sha,release_id') errors.push('capture_journal candidate identity fields are invalid')
    if (production && identity && (identity.release_git_sha !== production.releaseGitSha
      || identity.manifest_sha256 !== production.manifestSha256 || identity.image_set_digest !== production.imageSetDigest)) {
      errors.push('capture_journal candidate identity must match production release bindings')
    }
    const observations = Array.isArray(journal.observations) ? journal.observations : []
    const names = observations.map(observation => observation?.name)
    if (observations.length !== REQUIRED_OBSERVATIONS.length || new Set(names).size !== names.length || REQUIRED_OBSERVATIONS.some(name => !names.includes(name))) {
      errors.push('capture_journal observation set is incomplete or invalid')
    }
    for (const observation of observations) {
      if (!observation || typeof observation !== 'object' || !observation.material || typeof observation.material !== 'object' || Array.isArray(observation.material)) {
        errors.push('capture_journal observation material is invalid')
        continue
      }
      if (Object.keys(observation).sort().join(',') !== 'material,name,observation_sha256,status') errors.push('capture_journal observation fields are invalid')
      if (!/^[a-f0-9]{64}$/u.test(observation.observation_sha256 ?? '')) errors.push('capture_journal observation hash is invalid')
      if (['release', 'target_list', 'target_get'].includes(observation.name ?? '') && observation.status !== 200) errors.push(`capture_journal ${observation.name} observation must return HTTP 200`)
      else if (observation.name === 'isolation' && ![401, 403].includes(observation.status ?? 0)) errors.push('capture_journal isolation observation must be rejected')
      const material = observation.material
      const keys = Object.keys(material).sort().join(',')
      if (observation.name === 'release') {
        if (keys !== 'image_set_digest,manifest_sha256,ready,release_git_sha,release_id' || material.release_id !== identity?.release_id
          || material.release_git_sha !== identity?.release_git_sha || material.manifest_sha256 !== identity?.manifest_sha256
          || material.image_set_digest !== identity?.image_set_digest || material.ready !== true) errors.push('capture_journal release material is invalid or not identity-bound')
      } else if (observation.name === 'target_list') {
        if (keys !== 'expected_report_visible,returned_count,total,visible_report_id' || material.expected_report_visible !== true
          || material.visible_report_id !== document.manual_publish_report_id
          || !Number.isInteger(material.total) || Number(material.total) < 1 || !Number.isInteger(material.returned_count)
          || Number(material.returned_count) < 1 || Number(material.returned_count) > 20 || Number(material.returned_count) > Number(material.total)) {
          errors.push('capture_journal target list material is invalid')
        }
      } else if (observation.name === 'target_get') {
        if (keys !== 'evidence_boundary,manual_publish_report_id,state' || material.manual_publish_report_id !== document.manual_publish_report_id
          || material.state !== document.manual_publish_state || material.evidence_boundary !== document.manual_evidence_boundary) errors.push('capture_journal target report material does not match evidence')
      } else if (observation.name === 'isolation') {
        if (keys !== 'code_present,error_envelope' || material.error_envelope !== true || material.code_present !== true) errors.push('capture_journal isolation material is invalid')
      } else errors.push('capture_journal contains an unknown observation')
      if (typeof observation.observation_sha256 === 'string'
        && createHash('sha256').update(canonical({ name: observation.name, status: observation.status, material })).digest('hex') !== observation.observation_sha256) {
        errors.push(`capture_journal ${observation.name ?? 'unknown'} observation hash does not match material`)
      }
    }
    if (typeof document.capture_journal_sha256 !== 'string' || createHash('sha256').update(canonical(journal)).digest('hex') !== document.capture_journal_sha256) errors.push('capture_journal_sha256 does not match capture_journal')
  }
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
  if (!Array.isArray(document.checks) || document.checks.length !== REQUIRED_CHECKS.length) errors.push('checks must contain exactly three workflow checks')
  else {
    if (document.checks.some(check => !check || typeof check !== 'object' || Array.isArray(check)
      || Object.keys(check).sort().join(',') !== 'name,observation,status' || check.status !== 'pass' || typeof check.name !== 'string' || !check.name.trim())) errors.push('every workflow check must have a name and pass status')
    const names = document.checks.map(check => check.name).filter((name): name is string => typeof name === 'string')
    if (new Set(names).size !== names.length) errors.push('workflow check names must be unique')
    for (const required of REQUIRED_CHECKS) if (!names.includes(required)) errors.push(`${required} workflow check is required`)
    const observations: Record<string, string> = { tenant_scope: 'foreign_workspace_rejected', manual_report: 'human_evidence_boundary_preserved', merchant_visibility: 'expected_report_visible' }
    for (const check of document.checks) if (observations[check.name ?? ''] !== check.observation) errors.push(`${check.name ?? 'unknown'} workflow check observation is invalid`)
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
