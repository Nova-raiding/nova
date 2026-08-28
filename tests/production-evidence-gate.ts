import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

export type ProductionEvidenceKind = 'payment' | 'restore'

type Check = { status?: string; evidence_ref?: string }
type Evidence = {
  schema_version?: string
  kind?: string
  release_id?: string
  image_digest?: string
  environment?: string
  status?: string
  generated_at?: string
  simulated?: boolean
  verified_by?: string
  verified_at?: string
  checks?: Record<string, Check>
  provider?: string
  amount_cny?: number
  provider_trade_id_sha256?: string
  recovery_target_isolated?: boolean
  backup_sha256?: string
  source_backup_created_at?: string
  recovery_point_at?: string
  attestation_hmac_sha256?: string
}

const REQUIRED_CHECKS: Record<ProductionEvidenceKind, string[]> = {
  payment: ['checkout', 'callback', 'callback_replay', 'provider_query', 'reconciliation', 'refund'],
  restore: ['backup_checksum', 'isolated_restore', 'migrations', 'data_integrity', 'application_smoke'],
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function signProductionEvidence(value: Record<string, unknown>, key: string): string {
  const { attestation_hmac_sha256: _attestation, ...unsigned } = value
  return createHmac('sha256', key).update(canonical(unsigned)).digest('hex')
}

export function validateProductionEvidence(value: Evidence, options: { kind: ProductionEvidenceKind; releaseId: string; imageDigest: string; attestationKey: string; now?: Date; maxAgeHours?: number }): string[] {
  const errors: string[] = []
  for (const field of ['schema_version', 'kind', 'release_id', 'image_digest', 'environment', 'status', 'generated_at', 'verified_by', 'verified_at', 'attestation_hmac_sha256'] as const) {
    if (!nonEmpty(value[field])) errors.push(`${field} is required`)
  }
  if (value.schema_version !== '1') errors.push('schema_version must be 1')
  if (value.kind !== options.kind) errors.push(`kind must be ${options.kind}`)
  if (value.release_id !== options.releaseId) errors.push(`release_id must match ${options.releaseId}`)
  if (value.image_digest !== options.imageDigest) errors.push('image_digest must match the immutable deployment image')
  if (value.environment !== 'production') errors.push('environment must be production')
  if (value.status !== 'pass') errors.push('status must be pass')
  if (value.simulated !== false) errors.push('simulated must be false')
  if (!nonEmpty(options.attestationKey) || options.attestationKey.length < 32) errors.push('attestation key must contain at least 32 characters')
  if (nonEmpty(value.verified_by) && /^(test|fixture|local|unknown)$/iu.test(value.verified_by)) errors.push('verified_by must identify a real production approver')

  const now = options.now ?? new Date()
  const generated = new Date(value.generated_at ?? '')
  const verified = new Date(value.verified_at ?? '')
  if (!Number.isFinite(generated.getTime())) errors.push('generated_at must be an ISO timestamp')
  if (!Number.isFinite(verified.getTime())) errors.push('verified_at must be an ISO timestamp')
  if (Number.isFinite(generated.getTime()) && generated.getTime() > now.getTime() + 5 * 60_000) errors.push('generated_at must not be in the future')
  if (Number.isFinite(generated.getTime()) && now.getTime() - generated.getTime() > (options.maxAgeHours ?? 168) * 3_600_000) errors.push('evidence is stale')
  if (Number.isFinite(generated.getTime()) && Number.isFinite(verified.getTime()) && verified.getTime() > generated.getTime()) errors.push('verified_at must not be after generated_at')

  for (const name of REQUIRED_CHECKS[options.kind]) {
    const check = value.checks?.[name]
    if (check?.status !== 'pass') errors.push(`checks.${name}.status must be pass`)
    if (!nonEmpty(check?.evidence_ref) || /(?:fixture|localhost|127\.0\.0\.1|mock)/iu.test(check?.evidence_ref ?? '')) errors.push(`checks.${name}.evidence_ref must point to non-local evidence`)
  }
  if (options.kind === 'payment') {
    if (!nonEmpty(value.provider) || /fixture|mock/iu.test(value.provider ?? '')) errors.push('provider must identify a real payment provider')
    if (typeof value.amount_cny !== 'number' || value.amount_cny <= 0) errors.push('amount_cny must be positive')
    if (!/^[a-f0-9]{64}$/u.test(value.provider_trade_id_sha256 ?? '')) errors.push('provider_trade_id_sha256 must be a SHA-256 hash')
  } else {
    if (value.recovery_target_isolated !== true) errors.push('recovery_target_isolated must be true')
    if (!/^[a-f0-9]{64}$/u.test(value.backup_sha256 ?? '')) errors.push('backup_sha256 must be a SHA-256 hash')
    for (const field of ['source_backup_created_at', 'recovery_point_at'] as const) if (!Number.isFinite(new Date(value[field] ?? '').getTime())) errors.push(`${field} must be an ISO timestamp`)
  }

  if (nonEmpty(value.attestation_hmac_sha256) && options.attestationKey.length >= 32) {
    const expected = signProductionEvidence(value as Record<string, unknown>, options.attestationKey)
    const actual = value.attestation_hmac_sha256.toLowerCase()
    if (!/^[a-f0-9]{64}$/u.test(actual) || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual.padEnd(64, '0').slice(0, 64)))) errors.push('attestation_hmac_sha256 is invalid')
  }
  return errors
}

if (process.argv[1]?.endsWith('production-evidence-gate.ts') || process.argv[1]?.endsWith('production-evidence-gate.js')) {
  const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
  const kind = argument('--kind') as ProductionEvidenceKind | undefined
  const path = argument('--file')
  const releaseId = argument('--release-id')
  const imageDigest = argument('--image-digest')
  const attestationKey = process.env.EVIDENCE_ATTESTATION_KEY ?? ''
  if (!kind || !REQUIRED_CHECKS[kind] || !path || !releaseId || !imageDigest) throw new Error('usage: --kind payment|restore --file <path> --release-id <id> --image-digest <sha256>')
  const document = JSON.parse(readFileSync(path, 'utf8')) as Evidence
  const errors = validateProductionEvidence(document, { kind, releaseId, imageDigest, attestationKey })
  if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
  console.log(`${kind} production evidence gate passed: ${path}`)
}
