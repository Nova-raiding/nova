import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { signProductionEvidence, validateProductionEvidence, type ProductionEvidenceKind } from './production-evidence-gate.js'

const pair = generateKeyPairSync('ed25519')
const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const otherPublicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString()
const rsaPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'pem', type: 'spki' }).toString()
const imageSetDigest = `sha256:${'a'.repeat(64)}`; const manifestSha256 = 'd'.repeat(64); const releaseGitSha = 'e'.repeat(40); const now = new Date('2026-08-28T06:00:00Z')
const deploymentNonce = 'deployment_nonce_abcdefghijklmnop'
const expectedMigrationVersion = (JSON.parse(readFileSync('release-metadata.json', 'utf8')) as { expectedMigrationVersion: number }).expectedMigrationVersion
const artifactRoot = mkdtempSync(join(tmpdir(), 'production-evidence-artifacts-'))
afterAll(() => rmSync(artifactRoot, { recursive: true, force: true }))
const options = (kind: ProductionEvidenceKind) => ({ kind, releaseId: 'release-1', imageSetDigest, manifestSha256, releaseGitSha, deploymentNonce, artifactRoot, trustedKeyId: 'release-security-2026', publicKeyPem, expectedMigrationVersion, now })

function artifactReference(kind: ProductionEvidenceKind, name: string) {
  const relative = `${kind}/${name}.json`; const path = join(artifactRoot, relative)
  const migrationRows = Array.from({ length: expectedMigrationVersion }, (_, index) => `${index + 1}|migration|${'a'.repeat(64)}`)
  const content = kind === 'payment' ? JSON.stringify({
    kind, operation: name, release_id: 'release-1', deployment_nonce: deploymentNonce,
    order_id_sha256: 'f'.repeat(64), provider_trade_id_sha256: 'b'.repeat(64),
    amount_fen: 1, observed_at: '2026-08-28T05:10:00Z', provider_request_id: `request-${name}`, simulated: false,
    outcome: ({ checkout: 'created', callback: 'accepted', callback_replay: 'idempotent', provider_query: 'paid', reconciliation: 'balanced', refund: 'succeeded' } as Record<string, string>)[name],
  }) : kind === 'restore' && name === 'isolated_restore' ? JSON.stringify({
    schema_version: 'pg17-isolated-restore-capture/2', status: 'pass', simulated: false, release_id: 'release-1', release_git_sha: releaseGitSha, migration_target_version: expectedMigrationVersion,
    image_set_digest: imageSetDigest, manifest_sha256: manifestSha256, deployment_nonce_sha256: createHash('sha256').update(deploymentNonce).digest('hex'),
    backup_sha256: 'c'.repeat(64), source_database_id_sha256: '1'.repeat(64), target_database_id_sha256: '2'.repeat(64),
    source_archive_sha256: `sha256:${'3'.repeat(64)}`, migration_chain_sha256: createHash('sha256').update(migrationRows.join('\n')).digest('hex'),
    postgres_image_ref: `registry.example/postgres:17-alpine@sha256:${'4'.repeat(64)}`, postgres_image_id: `sha256:${'4'.repeat(64)}`,
    container_id: '5'.repeat(64), network_id: '6'.repeat(64), volume_name: `merchant_restore_data_${'7'.repeat(24)}`,
    restored_migration_prefix: '1:242:242', migrated_prefix: `1:${expectedMigrationVersion}:${expectedMigrationVersion}`, migration_chain_rows: migrationRows,
    captured_at: '2026-08-28T05:10:00Z',
  }) : JSON.stringify({ kind, name, provider_request_id: `request-${name}` })
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content)
  return `artifact://production/${relative}#${createHash('sha256').update(content).digest('hex')}`
}

function evidence(kind: ProductionEvidenceKind) {
  const checkNames = kind === 'payment' ? ['checkout', 'callback', 'callback_replay', 'provider_query', 'reconciliation', 'refund'] : ['backup_checksum', 'isolated_restore', 'migrations', 'data_integrity', 'application_smoke']
  const checks = Object.fromEntries(checkNames.map(name => [name, { status: 'pass', evidence_ref: artifactReference(kind, name) }]))
  const value: Record<string, unknown> = {
    schema_version: '2', kind, release_id: 'release-1', image_set_digest: imageSetDigest, manifest_sha256: manifestSha256, release_git_sha: releaseGitSha, environment: 'production', status: 'pass', generated_at: '2026-08-28T05:20:00Z', attested_at: '2026-08-28T05:30:00Z', expires_at: '2026-08-29T05:30:00Z', evidence_id: `production-${kind}-evidence-0001`, deployment_nonce: deploymentNonce, key_id: 'release-security-2026', simulated: false, verified_by: 'release-manager@example.com', checks,
    ...(kind === 'payment' ? { provider: 'alipay', amount_cny: 0.01, provider_trade_id_sha256: 'b'.repeat(64) } : { recovery_target_isolated: true, backup_sha256: 'c'.repeat(64), source_backup_created_at: '2026-08-28T04:00:00Z', recovery_point_at: '2026-08-28T04:30:00Z' }),
  }
  value.signature_base64 = signProductionEvidence(value, privateKeyPem)
  return value
}

describe('production payment and restore evidence gates', () => {
  for (const kind of ['payment', 'restore'] as const) it(`accepts independently signed ${kind} evidence bound to release, image, manifest and commit`, () => expect(validateProductionEvidence(evidence(kind), options(kind))).toEqual([]))

  it('fails closed for a malformed evidence schema without throwing', () => {
    const errors = validateProductionEvidence({ checks: null, generated_at: 'not-a-date' }, options('payment'))
    expect(errors).toEqual(expect.arrayContaining([
      'schema_version must match 2',
      'kind must match payment',
      'environment must match production',
      'status must match pass',
      'evidence_id is required',
      'deployment_nonce is required',
      'verified_by is required',
      'signature_base64 is required',
      'simulated must be false',
      'generated_at must be a strict UTC ISO timestamp',
      'checks.checkout.status must be pass',
      'checks.checkout.evidence_ref must be an immutable production artifact with SHA-256 fragment',
    ]))
  })

  it('rejects a caller-selected key and tampered evidence', () => {
    const value = evidence('payment'); value.amount_cny = 999
    expect(validateProductionEvidence(value, { ...options('payment'), publicKeyPem: otherPublicKey })).toContain('signature_base64 is invalid')
    expect(validateProductionEvidence(value, options('payment'))).toContain('signature_base64 is invalid')
    expect(validateProductionEvidence(evidence('payment'), { ...options('payment'), publicKeyPem: rsaPublicKey })).toContain('trusted public key must be Ed25519')
  })

  it.each(['fixture', 'mock', 'synthetic'])('rejects %s as a real production payment provider', provider => {
    const value = evidence('payment'); value.provider = provider; value.signature_base64 = signProductionEvidence(value, privateKeyPem)
    expect(validateProductionEvidence(value, options('payment'))).toContain('provider must identify a real provider')
  })

  it('rejects a synthetic payment evidence document even when its signature and provider fields look valid', () => {
    const value = evidence('payment'); value.simulated = true; value.signature_base64 = signProductionEvidence(value, privateKeyPem)
    expect(validateProductionEvidence(value, options('payment'))).toContain('simulated must be false')
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

  it('requires separate immutable artifacts for each payment operation', () => {
    const value = evidence('payment')
    const checks = value.checks as Record<string, { status: string; evidence_ref: string }>
    checks.refund!.evidence_ref = checks.checkout!.evidence_ref
    value.signature_base64 = signProductionEvidence(value, privateKeyPem)
    expect(validateProductionEvidence(value, options('payment'))).toContain('checks.refund.evidence_ref must differ from checks.checkout.evidence_ref')
  })

  it('rejects signed payment refs whose bytes do not prove the named operation and common order identity', () => {
    const value = evidence('payment')
    const checks = value.checks as Record<string, { status: string; evidence_ref: string }>
    const forged = (name: string, content: unknown) => {
      const relative = `payment/forged-${name}.json`
      const serialized = JSON.stringify(content)
      writeFileSync(join(artifactRoot, relative), serialized)
      checks[name]!.evidence_ref = `artifact://production/${relative}#${createHash('sha256').update(serialized).digest('hex')}`
    }
    forged('callback', { kind: 'payment', operation: 'checkout', provider_request_id: 'request-callback' })
    forged('refund', { kind: 'payment', operation: 'refund', release_id: 'release-1', deployment_nonce: deploymentNonce, order_id_sha256: 'a'.repeat(64), provider_trade_id_sha256: 'b'.repeat(64), amount_fen: 1, observed_at: '2026-08-28T05:10:00Z', provider_request_id: 'request-refund', outcome: 'succeeded' })
    value.signature_base64 = signProductionEvidence(value, privateKeyPem)
    expect(validateProductionEvidence(value, options('payment'))).toEqual(expect.arrayContaining([
      'checks.callback.evidence_ref operation must match callback',
      'checks.refund.evidence_ref order_id_sha256 must match the other payment operations',
    ]))
  })

  it('requires distinct restore artifacts for the backup, isolated restore, migration, integrity and smoke checks', () => {
    const value = evidence('restore')
    const checks = value.checks as Record<string, { status: string; evidence_ref: string }>
    checks.data_integrity!.evidence_ref = checks.backup_checksum!.evidence_ref
    value.signature_base64 = signProductionEvidence(value, privateKeyPem)
    expect(validateProductionEvidence(value, options('restore'))).toContain('checks.data_integrity.evidence_ref must differ from checks.backup_checksum.evidence_ref')
  })

  it('rejects an isolated restore artifact that is only a generic JSON pass claim', () => {
    const value = evidence('restore')
    const fake = JSON.stringify({ status: 'pass', simulated: false })
    writeFileSync(join(artifactRoot, 'restore/isolated_restore.json'), fake)
    ;(value.checks as Record<string, { evidence_ref: string }>).isolated_restore!.evidence_ref = `artifact://production/restore/isolated_restore.json#${createHash('sha256').update(fake).digest('hex')}`
    value.signature_base64 = signProductionEvidence(value, privateKeyPem)
    expect(validateProductionEvidence(value, options('restore'))).toContain('checks.isolated_restore.evidence_ref schema_version does not match the protected restore capture')
  })

  it('rejects a capture copied from another release, nonce, backup or unisolated database', () => {
    const value = evidence('restore')
    const path = join(artifactRoot, 'restore/isolated_restore.json')
    const original = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const bad = { ...original, release_id: 'other-release', deployment_nonce_sha256: '0'.repeat(64), backup_sha256: '9'.repeat(64), target_database_id_sha256: original.source_database_id_sha256 }
    const bytes = JSON.stringify(bad)
    writeFileSync(path, bytes)
    ;(value.checks as Record<string, { evidence_ref: string }>).isolated_restore!.evidence_ref = `artifact://production/restore/isolated_restore.json#${createHash('sha256').update(bytes).digest('hex')}`
    value.signature_base64 = signProductionEvidence(value, privateKeyPem)
    expect(validateProductionEvidence(value, options('restore'))).toEqual(expect.arrayContaining([
      'checks.isolated_restore.evidence_ref release_id does not match the protected restore capture',
      'checks.isolated_restore.evidence_ref deployment_nonce_sha256 does not match the protected restore capture',
      'checks.isolated_restore.evidence_ref backup_sha256 does not match the protected restore capture',
      'checks.isolated_restore.evidence_ref target database is not isolated',
    ]))
  })

  it('rejects an isolated restore captured for a different release migration target', () => {
    const value = evidence('restore')
    expect(validateProductionEvidence(value, { ...options('restore'), expectedMigrationVersion: expectedMigrationVersion + 1 })).toEqual(expect.arrayContaining([
      'checks.isolated_restore.evidence_ref migration_target_version does not match the protected restore capture',
      'checks.isolated_restore.evidence_ref migrated_prefix does not match the protected restore capture',
      'checks.isolated_restore.evidence_ref migration chain is incomplete',
    ]))
  })

  it('rejects impossible restore chronology even when independently signed', () => {
    const value = evidence('restore'); value.source_backup_created_at = '2026-08-28T05:10:00Z'; value.recovery_point_at = '2026-08-28T05:00:00Z'; value.signature_base64 = signProductionEvidence(value, privateKeyPem)
    expect(validateProductionEvidence(value, options('restore'))).toContain('recovery_point_at must not be before source_backup_created_at')
    const futurePoint = evidence('restore'); futurePoint.recovery_point_at = '2026-08-28T05:25:00Z'; futurePoint.signature_base64 = signProductionEvidence(futurePoint, privateKeyPem)
    expect(validateProductionEvidence(futurePoint, options('restore'))).toContain('recovery_point_at must not be after generated_at')
  })

  it('rejects evidence at the expiry boundary and malformed expiry timestamps', () => {
    const expired = evidence('payment'); expired.expires_at = now.toISOString(); expired.signature_base64 = signProductionEvidence(expired, privateKeyPem)
    expect(validateProductionEvidence(expired, options('payment'))).toContain('evidence has expired')

    const malformed = evidence('payment'); malformed.expires_at = '2026-08-29'; malformed.signature_base64 = signProductionEvidence(malformed, privateKeyPem)
    expect(validateProductionEvidence(malformed, options('payment'))).toContain('expires_at must be a strict UTC ISO timestamp')
  })

  it('rejects evidence signed by an unbound source trust anchor', () => {
    const value = evidence('payment'); value.key_id = 'unapproved-source-2026'; value.signature_base64 = signProductionEvidence(value, privateKeyPem)
    expect(validateProductionEvidence(value, options('payment'))).toContain('key_id must match release-security-2026')
  })

  it('rejects legacy or tampered image bindings even when independently signed', () => {
    const legacy = evidence('payment'); delete legacy.image_set_digest; legacy.schema_version = '1'; legacy.image_digest = imageSetDigest; legacy.signature_base64 = signProductionEvidence(legacy, privateKeyPem)
    expect(validateProductionEvidence(legacy, options('payment'))).toEqual(expect.arrayContaining(['schema_version must match 2', `image_set_digest must match ${imageSetDigest}`]))
    const changed = evidence('payment'); changed.image_set_digest = `sha256:${'f'.repeat(64)}`; changed.signature_base64 = signProductionEvidence(changed, privateKeyPem)
    expect(validateProductionEvidence(changed, options('payment'))).toContain(`image_set_digest must match ${imageSetDigest}`)
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
