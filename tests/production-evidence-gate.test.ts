import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { signProductionEvidence, validateProductionEvidence, type ProductionEvidenceKind } from './production-evidence-gate.js'

const pair = generateKeyPairSync('ed25519')
const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const otherPublicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString()
const rsaPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'pem', type: 'spki' }).toString()
const digest = `sha256:${'a'.repeat(64)}`; const manifestSha256 = 'd'.repeat(64); const releaseGitSha = 'e'.repeat(40); const now = new Date('2026-08-28T06:00:00Z')
const deploymentNonce = 'deployment_nonce_abcdefghijklmnop'
const artifactRoot = mkdtempSync(join(tmpdir(), 'production-evidence-artifacts-'))
afterAll(() => rmSync(artifactRoot, { recursive: true, force: true }))
const options = (kind: ProductionEvidenceKind) => ({ kind, releaseId: 'release-1', imageDigest: digest, manifestSha256, releaseGitSha, deploymentNonce, artifactRoot, trustedKeyId: 'release-security-2026', publicKeyPem, now })

function artifactReference(kind: ProductionEvidenceKind, name: string) {
  const relative = `${kind}/${name}.json`; const path = join(artifactRoot, relative); const content = JSON.stringify({ kind, name, provider_request_id: `request-${name}` })
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content)
  return `artifact://production/${relative}#${createHash('sha256').update(content).digest('hex')}`
}

function evidence(kind: ProductionEvidenceKind) {
  const checkNames = kind === 'payment' ? ['checkout', 'callback', 'callback_replay', 'provider_query', 'reconciliation', 'refund'] : ['backup_checksum', 'isolated_restore', 'migrations', 'data_integrity', 'application_smoke']
  const checks = Object.fromEntries(checkNames.map(name => [name, { status: 'pass', evidence_ref: artifactReference(kind, name) }]))
  const value: Record<string, unknown> = {
    schema_version: '1', kind, release_id: 'release-1', image_digest: digest, manifest_sha256: manifestSha256, release_git_sha: releaseGitSha, environment: 'production', status: 'pass', generated_at: '2026-08-28T05:20:00Z', attested_at: '2026-08-28T05:30:00Z', expires_at: '2026-08-29T05:30:00Z', evidence_id: `production-${kind}-evidence-0001`, deployment_nonce: deploymentNonce, key_id: 'release-security-2026', simulated: false, verified_by: 'release-manager@example.com', checks,
    ...(kind === 'payment' ? { provider: 'alipay', amount_cny: 0.01, provider_trade_id_sha256: 'b'.repeat(64) } : { recovery_target_isolated: true, backup_sha256: 'c'.repeat(64), source_backup_created_at: '2026-08-28T04:00:00Z', recovery_point_at: '2026-08-28T04:30:00Z' }),
  }
  value.signature_base64 = signProductionEvidence(value, privateKeyPem)
  return value
}

describe('production payment and restore evidence gates', () => {
  for (const kind of ['payment', 'restore'] as const) it(`accepts independently signed ${kind} evidence bound to release, image, manifest and commit`, () => expect(validateProductionEvidence(evidence(kind), options(kind))).toEqual([]))

  it('rejects a caller-selected key and tampered evidence', () => {
    const value = evidence('payment'); value.amount_cny = 999
    expect(validateProductionEvidence(value, { ...options('payment'), publicKeyPem: otherPublicKey })).toContain('signature_base64 is invalid')
    expect(validateProductionEvidence(value, options('payment'))).toContain('signature_base64 is invalid')
    expect(validateProductionEvidence(evidence('payment'), { ...options('payment'), publicKeyPem: rsaPublicKey })).toContain('trusted public key must be Ed25519')
  })

  it('rejects stale attestations, wrong binding, local artifacts and non-isolated restore', () => {
    const value = evidence('restore'); value.attested_at = '1970-01-01T00:00:00Z'; value.release_git_sha = '0'.repeat(40); value.recovery_target_isolated = false
    ;(value.checks as Record<string, { evidence_ref: string }>).application_smoke!.evidence_ref = 'http://localhost/smoke'
    expect(validateProductionEvidence(value, options('restore'))).toEqual(expect.arrayContaining([`release_git_sha must match ${releaseGitSha}`, 'evidence is stale', 'checks.application_smoke.evidence_ref must be an immutable production artifact with SHA-256 fragment', 'recovery_target_isolated must be true', 'signature_base64 is invalid']))
  })

  it('rejects a valid signature bound to a different deployment nonce', () => {
    const value = evidence('payment'); value.deployment_nonce = 'different_deployment_nonce_1234'; value.signature_base64 = signProductionEvidence(value, privateKeyPem)
    expect(validateProductionEvidence(value, options('payment'))).toContain('deployment_nonce must match the deployment orchestrator nonce')
  })

  it('rejects missing, changed and symlinked artifacts even when the reference shape is valid', () => {
    const missing = evidence('payment'); (missing.checks as Record<string, { evidence_ref: string }>).checkout!.evidence_ref = `artifact://production/payment/missing.json#${'f'.repeat(64)}`; missing.signature_base64 = signProductionEvidence(missing, privateKeyPem)
    expect(validateProductionEvidence(missing, options('payment'))).toContain('checks.checkout.evidence_ref referenced artifact does not exist or cannot be read')

    const traversal = evidence('payment'); (traversal.checks as Record<string, { evidence_ref: string }>).callback!.evidence_ref = `artifact://production/payment/../outside.json#${'f'.repeat(64)}`; traversal.signature_base64 = signProductionEvidence(traversal, privateKeyPem)
    expect(validateProductionEvidence(traversal, options('payment'))).toContain('checks.callback.evidence_ref contains an invalid artifact path')

    const changed = evidence('payment'); const changedRef = (changed.checks as Record<string, { evidence_ref: string }>).checkout!.evidence_ref; writeFileSync(join(artifactRoot, 'payment/checkout.json'), 'tampered')
    expect(changedRef).toMatch(/^artifact:/u)
    expect(validateProductionEvidence(changed, options('payment'))).toContain('checks.checkout.evidence_ref SHA-256 does not match the referenced artifact')

    const target = join(artifactRoot, 'payment/provider-query-target.json'); writeFileSync(target, 'provider result')
    const link = join(artifactRoot, 'payment/provider-query-link.json'); symlinkSync(target, link)
    const linked = evidence('payment'); (linked.checks as Record<string, { evidence_ref: string }>).provider_query!.evidence_ref = `artifact://production/payment/provider-query-link.json#${createHash('sha256').update('provider result').digest('hex')}`; linked.signature_base64 = signProductionEvidence(linked, privateKeyPem)
    expect(validateProductionEvidence(linked, options('payment'))).toContain('checks.provider_query.evidence_ref must resolve to a regular non-symlink artifact')
  })
})
