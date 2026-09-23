import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateBackupAttestation } from './backup-attestation-gate.js'
import { signProductionEvidence } from './production-evidence-gate.js'

describe('production backup attestation gate', () => {
  it('binds an Ed25519 attestation to the exact backup bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-attestation-')); const backupPath = realpathSync(root) + '/merchant.dump'; const bytes = 'postgres-custom-backup'; writeFileSync(backupPath, bytes)
    const pair = generateKeyPairSync('ed25519'); const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(); const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const value: Record<string, unknown> = { schema_version: '1', kind: 'postgres_backup', environment: 'production', backup_file_name: 'merchant.dump', backup_sha256: createHash('sha256').update(bytes).digest('hex'), source_database_id_sha256: 'a'.repeat(64), created_at: '2026-08-29T00:00:00Z', expires_at: '2026-09-29T00:00:00Z', key_id: 'release-security-2026', simulated: false }
    value.signature_base64 = signProductionEvidence(value, privateKeyPem)
    const options = { backupPath, trustedKeyId: 'release-security-2026', publicKeyPem, expectedSourceDatabaseIdSha256: 'a'.repeat(64), now: new Date('2026-08-29T01:00:00Z') }
    expect(validateBackupAttestation(value, options)).toEqual([])
    expect(validateBackupAttestation(value, { ...options, requireSnapshotTime: true })).toContain('strict restore requires a v2 backup with signed snapshot time')
    writeFileSync(backupPath, 'tampered')
    expect(validateBackupAttestation(value, options)).toContain('backup_sha256 does not match backup bytes')
    expect(validateBackupAttestation(value, { ...options, expectedSourceDatabaseIdSha256: 'b'.repeat(64) })).toContain('source_database_id_sha256 does not match the approved source database')
  })

  it('requires a signed v2 snapshot observation and rejects impossible times even with a valid signature', () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-attestation-v2-')); const backupPath = realpathSync(root) + '/merchant.dump'; const bytes = 'postgres-custom-backup'; writeFileSync(backupPath, bytes)
    const pair = generateKeyPairSync('ed25519'); const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(); const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const value: Record<string, unknown> = {
      schema_version: '2', kind: 'postgres_backup', environment: 'production', backup_file_name: 'merchant.dump', backup_sha256: createHash('sha256').update(bytes).digest('hex'), source_database_id_sha256: 'a'.repeat(64),
      created_at: '2026-08-29T00:00:00.000Z', backup_started_at: '2026-08-29T00:00:00.000Z', snapshot_export_observed_at: '2026-08-29T00:00:01.000Z', dump_completed_at: '2026-08-29T00:00:02.000Z', snapshot_id_sha256: 'b'.repeat(64),
      expires_at: '2026-08-30T00:00:02.000Z', key_id: 'release-security-2026', simulated: false,
    }
    const resign = () => { value.signature_base64 = signProductionEvidence(value, privateKeyPem) }
    const options = { backupPath, trustedKeyId: 'release-security-2026', publicKeyPem, expectedSourceDatabaseIdSha256: 'a'.repeat(64), requireSnapshotTime: true, now: new Date('2026-08-29T01:00:00.000Z') }
    resign(); expect(validateBackupAttestation(value, options)).toEqual([])
    value.snapshot_export_observed_at = '2026-08-28T23:59:59.000Z'; resign()
    expect(validateBackupAttestation(value, options)).toContain('snapshot observation predates backup start')
    value.snapshot_export_observed_at = '2026-08-29T00:00:01.000Z'; value.dump_completed_at = '2026-08-29T00:00:00.000Z'; resign()
    expect(validateBackupAttestation(value, options)).toContain('dump completed before snapshot observation')
    value.dump_completed_at = '2026-08-29T02:10:00.000Z'; resign()
    expect(validateBackupAttestation(value, options)).toContain('dump completion must not be in the future')
    value.dump_completed_at = '2026-08-29T00:00:02.000Z'; value.snapshot_id_sha256 = 'not-a-hash'; resign()
    expect(validateBackupAttestation(value, options)).toContain('snapshot_id_sha256 must be a SHA-256 hash')
  })
})
