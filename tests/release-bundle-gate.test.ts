import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { signProductionEvidence } from './production-evidence-gate.js'
import { validateReleaseBundle } from './release-bundle-gate.js'

describe('known-good release bundle gate', () => {
  it('accepts only signed immutable rollback provenance and rejects tampering', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-bundle-'))
    const manifest = 'apiVersion: apps/v1\nkind: Deployment\n'; const capability = '{"signed":true}'
    writeFileSync(join(root, 'manifest.yaml'), manifest); writeFileSync(join(root, 'capability.json'), capability)
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const pair = generateKeyPairSync('ed25519'); const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(); const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const image_digests = Object.fromEntries(['merchant-api', 'merchant-ops-ui', 'merchant-ui', 'merchant-worker', 'clamav'].map((name, index) => [name, `sha256:${String(index + 1).repeat(64)}`]))
    const asset_scanner = { mode: 'clamav_worker', allow_local_fixture: false, policy_version: 'scan-policy-2026-08-30', receipt_key_id: 'scanner-production-2026-08', clamav_image_digest: image_digests.clamav, signature_max_age_minutes: 1440, secret_refs: { api_token_ref: 'vault://merchant-scanner/api-token', workspace_signing_secret_ref: 'vault://merchant-scanner/workspace-signing', receipt_private_key_ref: 'vault://merchant-scanner/receipt-private-key', trusted_public_keys_ref: 'vault://merchant-scanner/trusted-public-keys' } }
    const value: Record<string, unknown> = { schema_version: '1', kind: 'known_good_release', environment: 'production', release_id: 'release-1', release_git_sha: 'a'.repeat(40), manifest_sha256: hash(manifest), manifest_ref: `artifact://production/manifest.yaml#${hash(manifest)}`, capability_evidence_ref: `artifact://production/capability.json#${hash(capability)}`, image_digests, asset_scanner, approved_at: '2026-08-29T00:00:00Z', expires_at: '2026-08-30T00:00:00Z', key_id: 'release-security-2026', simulated: false }
    value.signature_base64 = signProductionEvidence(value, privateKeyPem)
    const options = { releaseId: 'release-1', artifactRoot: root, trustedKeyId: 'release-security-2026', publicKeyPem, now: new Date('2026-08-29T01:00:00Z') }
    expect(validateReleaseBundle(value, options).errors).toEqual([])
    expect(validateReleaseBundle(value, options).descriptor?.asset_scanner).toEqual(asset_scanner)
    value.release_git_sha = 'b'.repeat(40)
    expect(validateReleaseBundle(value, options).errors).toContain('signature_base64 is invalid')
  })

  it('rejects bundles that omit or weaken the signed scanner release contract', () => {
    const pair = generateKeyPairSync('ed25519'); const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const options = { releaseId: 'release-1', artifactRoot: tmpdir(), trustedKeyId: 'release-security-2026', publicKeyPem, now: new Date('2026-08-29T01:00:00Z') }
    const base = { schema_version: '1', kind: 'known_good_release', environment: 'production', release_id: 'release-1', key_id: 'release-security-2026', simulated: false, expires_at: '2026-08-30T00:00:00Z' }
    expect(validateReleaseBundle(base, options).errors).toContain('asset_scanner contract is required')
    const weakened = { ...base, asset_scanner: { mode: 'fixture', allow_local_fixture: true, policy_version: 'local', receipt_key_id: '', clamav_image_digest: 'sha256:bad', signature_max_age_minutes: 10080, secret_refs: {} } }
    expect(validateReleaseBundle(weakened, options).errors).toEqual(expect.arrayContaining([
      'asset_scanner.mode must be clamav_worker',
      'asset_scanner.allow_local_fixture must be false',
      'asset_scanner.clamav_image_digest must match image_digests.clamav',
      'asset_scanner.signature_max_age_minutes must be from 1 to 1440',
    ]))
  })

  it('rejects caller-consistent but unsigned and expired bundles', () => {
    const pair = generateKeyPairSync('ed25519'); const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const result = validateReleaseBundle({ schema_version: '1', kind: 'known_good_release', environment: 'production', release_id: 'release-1', key_id: 'release-security-2026', simulated: false, expires_at: '2020-01-01T00:00:00Z' }, { releaseId: 'release-1', artifactRoot: tmpdir(), trustedKeyId: 'release-security-2026', publicKeyPem, now: new Date('2026-08-29T01:00:00Z') })
    expect(result.errors).toEqual(expect.arrayContaining(['signature_base64 must be a canonical Ed25519 signature', 'known-good release approval has expired']))
  })
})
