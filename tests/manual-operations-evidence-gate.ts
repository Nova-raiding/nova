import { readFileSync } from 'node:fs'

type ManualEvidence = {
  schema_version?: string
  release_id?: string
  environment?: string
  workflow?: string
  official_api_receipt?: boolean
  tenant_isolation_verified?: boolean
  checks?: Array<{ name?: string; status?: string }>
}

export function validateManualOperationsEvidence(value: unknown, expectedReleaseId?: string): string[] {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['document must be a JSON object']
  const document = value as ManualEvidence
  if (document.schema_version !== 'manual-operations-evidence/1') errors.push('schema_version must be manual-operations-evidence/1')
  if (!document.release_id) errors.push('release_id is required')
  if (expectedReleaseId && document.release_id !== expectedReleaseId) errors.push(`release_id must match ${expectedReleaseId}`)
  if (document.environment !== 'production') errors.push('environment must be production')
  if (document.workflow !== 'public_import_manual_publish') errors.push('workflow must be public_import_manual_publish')
  if (document.official_api_receipt !== false) errors.push('official_api_receipt must be false')
  if (document.tenant_isolation_verified !== true) errors.push('tenant_isolation_verified must be true')
  if (!Array.isArray(document.checks) || document.checks.length < 3) errors.push('checks must contain at least three workflow checks')
  else if (document.checks.some(check => check.status !== 'pass' || typeof check.name !== 'string' || !check.name.trim())) errors.push('every workflow check must have a name and pass status')
  return errors
}

function arg(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = arg('--file')
  const releaseId = arg('--release-id')
  if (!file || !releaseId) { console.error('manual operations evidence file and release id are required'); process.exit(2) }
  let value: unknown
  try { value = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { console.error(`unable to read evidence: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }
  const errors = validateManualOperationsEvidence(value, releaseId)
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log(`manual operations evidence gate passed: ${file}`)
}
