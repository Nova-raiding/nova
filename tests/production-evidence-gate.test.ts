import { describe, expect, it } from 'vitest'
import { signProductionEvidence, validateProductionEvidence, type ProductionEvidenceKind } from './production-evidence-gate.js'

const key = 'production-evidence-test-key-32-characters'
const digest = `sha256:${'a'.repeat(64)}`
const now = new Date('2026-08-28T06:00:00Z')

function evidence(kind: ProductionEvidenceKind) {
  const checks = Object.fromEntries((kind === 'payment'
    ? ['checkout', 'callback', 'callback_replay', 'provider_query', 'reconciliation', 'refund']
    : ['backup_checksum', 'isolated_restore', 'migrations', 'data_integrity', 'application_smoke'])
    .map(name => [name, { status: 'pass', evidence_ref: `artifact://production/${kind}/${name}` }]))
  const value: Record<string, unknown> = {
    schema_version: '1', kind, release_id: 'release-1', image_digest: digest, environment: 'production', status: 'pass', generated_at: '2026-08-28T05:30:00Z', simulated: false, verified_by: 'release-manager@example.com', verified_at: '2026-08-28T05:20:00Z', checks,
    ...(kind === 'payment' ? { provider: 'alipay', amount_cny: 0.01, provider_trade_id_sha256: 'b'.repeat(64) } : { recovery_target_isolated: true, backup_sha256: 'c'.repeat(64), source_backup_created_at: '2026-08-28T04:00:00Z', recovery_point_at: '2026-08-28T04:30:00Z' }),
  }
  value.attestation_hmac_sha256 = signProductionEvidence(value, key)
  return value
}

describe('production payment and restore evidence gates', () => {
  for (const kind of ['payment', 'restore'] as const) it(`accepts attested ${kind} evidence bound to the release image`, () => {
    expect(validateProductionEvidence(evidence(kind), { kind, releaseId: 'release-1', imageDigest: digest, attestationKey: key, now })).toEqual([])
  })

  it('rejects tampering, simulation, stale evidence and the wrong release', () => {
    const value = evidence('payment')
    value.amount_cny = 999
    value.simulated = true
    value.generated_at = '2026-08-01T00:00:00Z'
    expect(validateProductionEvidence(value, { kind: 'payment', releaseId: 'release-2', imageDigest: digest, attestationKey: key, now })).toEqual(expect.arrayContaining([
      'release_id must match release-2', 'simulated must be false', 'evidence is stale', 'attestation_hmac_sha256 is invalid',
    ]))
  })

  it('rejects local references and a non-isolated restore', () => {
    const value = evidence('restore')
    const checks = value.checks as Record<string, { evidence_ref: string }>
    checks.application_smoke!.evidence_ref = 'http://localhost/smoke'
    value.recovery_target_isolated = false
    value.attestation_hmac_sha256 = signProductionEvidence(value, key)
    expect(validateProductionEvidence(value, { kind: 'restore', releaseId: 'release-1', imageDigest: digest, attestationKey: key, now })).toEqual(expect.arrayContaining([
      'checks.application_smoke.evidence_ref must point to non-local evidence', 'recovery_target_isolated must be true',
    ]))
  })
})
