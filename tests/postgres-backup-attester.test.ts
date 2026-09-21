import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createProtectedEnvironment, parseCreateArguments, produceBackup, pgDumpArguments, signBackupAttestation, SNAPSHOT_SQL } from '../infra/protected/attest-postgres-backup.mjs'
import { validateBackupAttestation } from './backup-attestation-gate.js'

const keys = () => {
  const pair = generateKeyPairSync('ed25519')
  return { privatePem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicPem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() }
}

describe('synthetic protected postgres backup attester', () => {
  it('signs synthetic bytes with matching Ed25519 keys and the existing restore verifier rejects tampering', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-backup-attester-'))), backupPath = join(root, 'merchant.dump')
    const backupBytes = Buffer.from('synthetic-custom-format-dump'); writeFileSync(backupPath, backupBytes)
    const pair = keys(), now = new Date('2026-09-21T12:00:00.000Z')
    const value = signBackupAttestation({ backupBytes, backupFileName: 'merchant.dump', systemIdentifier: '7412345678901234567', migrationVersion: 233, keyId: 'synthetic-test-key', ...pair, now, validitySeconds: 3600 })
    const options = { backupPath, trustedKeyId: 'synthetic-test-key', publicKeyPem: pair.publicPem, expectedSourceDatabaseIdSha256: value.source_database_id_sha256 as string, now }
    expect(validateBackupAttestation(value, options)).toEqual([])
    expect(validateBackupAttestation({ ...value, migration_version: 232 }, options)).toContain('signature_base64 is invalid')
    expect(() => signBackupAttestation({ backupBytes, backupFileName: 'merchant.dump', systemIdentifier: '7412345678901234567', migrationVersion: 233, keyId: 'synthetic-test-key', privatePem: keys().privatePem, publicPem: pair.publicPem })).toThrow('does not match trust anchor')
    expect(() => signBackupAttestation({ backupBytes, backupFileName: 'merchant.dump', systemIdentifier: '7412345678901234567', migrationVersion: 233, keyId: 'synthetic-test-key', ...pair, validitySeconds: 86_401 })).toThrow('validity exceeds')
  })

  it('owns snapshot identity and pg_dump production arguments rather than accepting a caller dump hash', async () => {
    expect(SNAPSHOT_SQL.join('\n')).toContain('pg_control_system()')
    expect(SNAPSHOT_SQL.join('\n')).toContain('max(version)')
    expect(SNAPSHOT_SQL.join('\n')).toContain('pg_export_snapshot()')
    expect(pgDumpArguments('00000003-0000001B-1', '/protected/out.tmp')).toEqual(['--format=custom', '--no-owner', '--no-privileges', '--snapshot=00000003-0000001B-1', '--file=/protected/out.tmp'])
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-backup-producer-'))), backupPath = join(root, 'merchant.dump'), attestationPath = join(root, 'merchant.attestation.json')
    const release = vi.fn(), pair = keys()
    const document = await produceBackup({ backupPath, attestationPath, ...pair, keyId: 'synthetic-test-key', now: new Date('2026-09-21T12:00:00.000Z'), validitySeconds: 3600 }, {
      snapshot: async () => ({ systemIdentifier: '7412345678901234567', migrationVersion: 233, snapshot: '00000003-0000001B-1', release }),
      dump: async (snapshot, path) => { expect(snapshot).toBe('00000003-0000001B-1'); writeFileSync(path, 'synthetic-pg-dump') },
    })
    expect(release).toHaveBeenCalledOnce()
    expect(readFileSync(`${backupPath}.sha256`, 'utf8')).toBe(`${document.backup_sha256}  ${backupPath}\n`)
    expect(JSON.parse(readFileSync(attestationPath, 'utf8'))).toMatchObject({ environment: 'production', simulated: false, migration_version: 233 })
    await expect(produceBackup({ backupPath, attestationPath, ...pair, keyId: 'synthetic-test-key' }, {
      snapshot: async () => ({ systemIdentifier: '7412345678901234567', migrationVersion: 233, snapshot: '00000003-0000001B-1', release: () => {} }),
      dump: async (_snapshot, path) => { writeFileSync(path, 'replacement-must-not-land') },
    })).rejects.toThrow()
    expect(readFileSync(backupPath, 'utf8')).toBe('synthetic-pg-dump')
  })

  it('strictly parses the complete create interface and rejects ambiguity', () => {
    const valid = ['create', '--backup', '/protected/db.dump', '--checksum', '/protected/db.sha256', '--attestation', '/protected/db.json']
    expect(parseCreateArguments(valid)).toEqual({ backupPath: '/protected/db.dump', checksumPath: '/protected/db.sha256', attestationPath: '/protected/db.json' })
    expect(() => parseCreateArguments([...valid, '--backup', '/protected/other.dump'])).toThrow('duplicate option')
    expect(() => parseCreateArguments([...valid, '--extra', 'value'])).toThrow('unknown option')
    expect(() => parseCreateArguments(valid.slice(0, -1))).toThrow('exactly one value')
    expect(createProtectedEnvironment({ PGHOST: 'database', PGUSER: 'merchant', PGPASSWORD: 'secret', PGOPTIONS: '-c session_preload_libraries=evil', PGSERVICEFILE: '/tmp/hostile', NODE_OPTIONS: '--require=/tmp/hostile.cjs' })).toEqual({ PATH: '/usr/bin:/bin', NODE_OPTIONS: '', PGHOST: 'database', PGPASSWORD: 'secret', PGUSER: 'merchant' })
  })
})
