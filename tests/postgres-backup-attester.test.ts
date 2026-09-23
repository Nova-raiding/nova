import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertSourcePolicy, createProtectedEnvironment, hashRegularFile, parseCreateArguments, parseSourcePolicy, produceBackup, pgDumpArguments, signBackupAttestation, SNAPSHOT_SQL } from '../infra/protected/attest-postgres-backup.mjs'
import { verifyProducedBackupV2 } from '../infra/protected/produce-protected-live-backup.mjs'
import { validateBackupAttestation } from './backup-attestation-gate.js'

const keys = () => {
  const pair = generateKeyPairSync('ed25519')
  return { privatePem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicPem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() }
}
const systemIdentifier = '7412345678901234567'
const sourcePolicy = { system_identifier_sha256: createHash('sha256').update(systemIdentifier).digest('hex'), database_oid: 16_384, database_name: 'merchant_production' }
const snapshotIdentity = { systemIdentifier, databaseOid: sourcePolicy.database_oid, databaseName: sourcePolicy.database_name, migrationVersion: 233, snapshot: '00000003-0000001B-1', snapshotExportObservedAt: '2026-09-21T12:00:01.000Z' }
const snapshotTimes = { backupStartedAt: '2026-09-21T12:00:00.000Z', snapshotExportObservedAt: snapshotIdentity.snapshotExportObservedAt, dumpCompletedAt: '2026-09-21T12:00:02.000Z' }

describe('synthetic protected postgres backup attester', () => {
  it('accepts only signed v2 producer output bound to reviewed source, migration and dump', () => {
    const pair = keys(), bytes = Buffer.from('synthetic-dump'), now = new Date('2026-09-21T12:00:03.000Z')
    const document = signBackupAttestation({ backupBytes: bytes, backupFileName: 'before-upgrade-233.dump', ...snapshotIdentity, ...snapshotTimes, keyId: 'synthetic-test-key', ...pair, validitySeconds: 3600 })
    const check = (candidate: Record<string, unknown>, dumpSha = createHash('sha256').update(bytes).digest('hex'), policy = sourcePolicy, migration = 233, observedAt = now) => verifyProducedBackupV2(candidate, dumpSha, 'before-upgrade-233.dump', policy, migration, pair.publicPem, 'synthetic-test-key', observedAt)
    expect(() => check(document)).not.toThrow()
    expect(() => check({ ...document, schema_version: '1' })).toThrow('schema v2')
    expect(() => check(document, createHash('sha256').update('changed').digest('hex'))).toThrow('signed dump identity')
    expect(() => check(document, undefined, { ...sourcePolicy, database_oid: 99 })).toThrow('reviewed source')
    expect(() => check(document, undefined, sourcePolicy, 234)).toThrow('migration/key identity')
    expect(() => check({ ...document, snapshot_export_observed_at: '2026-09-21T11:59:59.000Z' })).toThrow('chronology')
    expect(() => check({ ...document, signature_base64: 'A'.repeat(86) + '==' })).toThrow('signature is invalid')
    expect(() => check(document, undefined, sourcePolicy, 233, new Date('2026-09-22T13:00:00.000Z'))).toThrow('expired')
  })
  it('hashes large dump files in fixed-size chunks without loading their bytes as one buffer', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-backup-hash-'))), path = join(root, 'large.dump')
    const chunk = Buffer.alloc(1024 * 1024, 0x5a)
    writeFileSync(path, Buffer.concat([chunk, chunk, chunk]))
    expect(hashRegularFile(path)).toEqual({ sha256: createHash('sha256').update(chunk).update(chunk).update(chunk).digest('hex'), bytes: chunk.length * 3 })
  })
  it('requires the live backup producer to bind an explicit migration version', () => {
    const source = readFileSync('infra/protected/produce-protected-live-backup.mjs', 'utf8')
    expect(source).toContain('process.env.EXPECTED_MIGRATION_VERSION')
    expect(source).toContain('process.env.PRODUCTION_POSTGRES_CONTAINER')
    expect(source).toContain('process.env.RELEASE_ID')
    expect(source).toContain('production-backup-source-${releaseId}.json')
    expect(source).toContain('backups/${releaseId}')
    expect(source).toContain('merchant-production-postgres-')
    expect(source).toContain('EXPECTED_MIGRATION_VERSION must be a positive integer')
    expect(source).toContain('before-upgrade-${expectedMigrationVersion}.dump')
    expect(source).not.toContain('assert.equal(value.migration_version, 219)')
    expect(source).not.toContain("['inspect', 'local-postgres-1']")
    expect(source).not.toContain("production-backup-source.json'")
  })

  it('signs synthetic bytes with matching Ed25519 keys and the existing restore verifier rejects tampering', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-backup-attester-'))), backupPath = join(root, 'merchant.dump')
    const backupBytes = Buffer.from('synthetic-custom-format-dump'); writeFileSync(backupPath, backupBytes)
    const pair = keys(), now = new Date('2026-09-21T12:00:03.000Z')
    const value = signBackupAttestation({ backupBytes, backupFileName: 'merchant.dump', ...snapshotIdentity, ...snapshotTimes, keyId: 'synthetic-test-key', ...pair, validitySeconds: 3600 })
    const options = { backupPath, trustedKeyId: 'synthetic-test-key', publicKeyPem: pair.publicPem, expectedSourceDatabaseIdSha256: value.source_database_id_sha256 as string, requireSnapshotTime: true, now }
    expect(validateBackupAttestation(value, options)).toEqual([])
    expect(validateBackupAttestation({ ...value, migration_version: 232 }, options)).toContain('signature_base64 is invalid')
    expect(value).toMatchObject({ schema_version: '2', source_database_id_sha256: sourcePolicy.system_identifier_sha256, source_database_oid: 16_384, source_database_name: 'merchant_production', snapshot_id_sha256: createHash('sha256').update(snapshotIdentity.snapshot).digest('hex'), backup_started_at: snapshotTimes.backupStartedAt, snapshot_export_observed_at: snapshotTimes.snapshotExportObservedAt, dump_completed_at: snapshotTimes.dumpCompletedAt })
    expect(() => signBackupAttestation({ backupBytes, backupFileName: 'merchant.dump', ...snapshotIdentity, ...snapshotTimes, keyId: 'synthetic-test-key', privatePem: keys().privatePem, publicPem: pair.publicPem })).toThrow('does not match trust anchor')
    expect(() => signBackupAttestation({ backupBytes, backupFileName: 'merchant.dump', ...snapshotIdentity, ...snapshotTimes, keyId: 'synthetic-test-key', ...pair, validitySeconds: 86_401 })).toThrow('validity exceeds')
    expect(() => signBackupAttestation({ backupBytes, backupFileName: 'merchant.dump', ...snapshotIdentity, ...snapshotTimes, snapshotExportObservedAt: '2026-09-21T11:59:59.000Z', keyId: 'synthetic-test-key', ...pair })).toThrow('chronology')
    expect(() => signBackupAttestation({ backupBytes, backupFileName: 'merchant.dump', ...snapshotIdentity, ...snapshotTimes, dumpCompletedAt: '2026-09-21T12:00:00.000Z', keyId: 'synthetic-test-key', ...pair })).toThrow('chronology')
  })

  it('owns snapshot identity and pg_dump production arguments rather than accepting a caller dump hash', async () => {
    expect(SNAPSHOT_SQL.join('\n')).toContain('pg_control_system()')
    expect(SNAPSHOT_SQL.join('\n')).toContain('max(version)')
    expect(SNAPSHOT_SQL.join('\n')).toContain('pg_export_snapshot()')
    expect(SNAPSHOT_SQL.join('\n')).toContain('SNAPSHOT_EXPORTED_AT=')
    expect(SNAPSHOT_SQL.join('\n')).toContain('current_database()')
    expect(pgDumpArguments('00000003-0000001B-1', '/protected/out.tmp')).toEqual(['--format=custom', '--no-owner', '--no-privileges', '--snapshot=00000003-0000001B-1', '--file=/protected/out.tmp'])
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-backup-producer-'))), backupPath = join(root, 'merchant.dump'), attestationPath = join(root, 'merchant.attestation.json')
    const release = vi.fn(), pair = keys(), clock = vi.fn()
      .mockReturnValueOnce(new Date(snapshotTimes.backupStartedAt))
      .mockReturnValueOnce(new Date(snapshotTimes.dumpCompletedAt))
    const document = await produceBackup({ backupPath, attestationPath, ...pair, sourcePolicy, keyId: 'synthetic-test-key', clock, validitySeconds: 3600 }, {
      snapshot: async () => ({ ...snapshotIdentity, release }),
      dump: async (snapshot, path) => { expect(snapshot).toBe('00000003-0000001B-1'); writeFileSync(path, 'synthetic-pg-dump') },
    })
    expect(release).toHaveBeenCalledOnce()
    expect(clock).toHaveBeenCalledTimes(2)
    expect(document.snapshot_id_sha256).toBe(createHash('sha256').update(snapshotIdentity.snapshot).digest('hex'))
    expect(readFileSync(`${backupPath}.sha256`, 'utf8')).toBe(`${document.backup_sha256}  ${backupPath}\n`)
    expect(JSON.parse(readFileSync(attestationPath, 'utf8'))).toMatchObject({ schema_version: '2', environment: 'production', simulated: false, migration_version: 233, snapshot_export_observed_at: snapshotTimes.snapshotExportObservedAt })
    await expect(produceBackup({ backupPath, attestationPath, ...pair, sourcePolicy, keyId: 'synthetic-test-key' }, {
      snapshot: async () => ({ ...snapshotIdentity, release: () => {} }),
      dump: async (_snapshot, path) => { writeFileSync(path, 'replacement-must-not-land') },
    })).rejects.toThrow()
    expect(readFileSync(backupPath, 'utf8')).toBe('synthetic-pg-dump')
  })

  it('rejects every protected source identity mismatch before dump', async () => {
    expect(parseSourcePolicy(Buffer.from(JSON.stringify(sourcePolicy)))).toEqual(sourcePolicy)
    expect(assertSourcePolicy(snapshotIdentity, sourcePolicy)).toBe(sourcePolicy.system_identifier_sha256)
    expect(() => assertSourcePolicy({ ...snapshotIdentity, systemIdentifier: '7412345678901234568' }, sourcePolicy)).toThrow('cluster')
    expect(() => assertSourcePolicy({ ...snapshotIdentity, databaseOid: 16_385 }, sourcePolicy)).toThrow('OID')
    expect(() => assertSourcePolicy({ ...snapshotIdentity, databaseName: 'other' }, sourcePolicy)).toThrow('name')
    expect(() => parseSourcePolicy(JSON.stringify({ ...sourcePolicy, policy_path: '/tmp/override' }))).toThrow('fields')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-backup-policy-'))), dump = vi.fn(), pair = keys()
    await expect(produceBackup({ backupPath: join(root, 'db.dump'), attestationPath: join(root, 'db.json'), ...pair, sourcePolicy: { ...sourcePolicy, database_oid: 99 }, keyId: 'synthetic-test-key' }, {
      snapshot: async () => ({ ...snapshotIdentity, release: () => {} }), dump,
    })).rejects.toThrow('OID')
    expect(dump).not.toHaveBeenCalled()
  })

  it('refuses a missing or forged snapshot observation before dumping', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-backup-time-'))), pair = keys(), dump = vi.fn()
    const input = { backupPath: join(root, 'db.dump'), attestationPath: join(root, 'db.json'), ...pair, sourcePolicy, keyId: 'synthetic-test-key', clock: () => new Date(snapshotTimes.backupStartedAt) }
    await expect(produceBackup(input, { snapshot: async () => ({ ...snapshotIdentity, snapshotExportObservedAt: '', release: () => {} }), dump })).rejects.toThrow('snapshot_export_observed_at')
    await expect(produceBackup(input, { snapshot: async () => ({ ...snapshotIdentity, snapshotExportObservedAt: '2026-09-21T11:59:59.000Z', release: () => {} }), dump })).rejects.toThrow('predates backup start')
    expect(dump).not.toHaveBeenCalled()
  })

  it('strictly parses the complete create interface and rejects ambiguity', () => {
    const valid = ['create', '--backup', '/protected/db.dump', '--checksum', '/protected/db.sha256', '--attestation', '/protected/db.json', '--source-policy', '/run/release-security/evidence-trust/production-backup-source-release-example.json']
    expect(parseCreateArguments(valid)).toEqual({ backupPath: '/protected/db.dump', checksumPath: '/protected/db.sha256', attestationPath: '/protected/db.json', sourcePolicyPath: '/run/release-security/evidence-trust/production-backup-source-release-example.json' })
    expect(() => parseCreateArguments([...valid, '--backup', '/protected/other.dump'])).toThrow('duplicate option')
    expect(() => parseCreateArguments([...valid, '--extra', 'value'])).toThrow('unknown option')
    expect(() => parseCreateArguments(valid.slice(0, -1))).toThrow('exactly one value')
    expect(createProtectedEnvironment({ PGHOST: 'database', PGUSER: 'merchant', PGPASSWORD: 'secret', PGOPTIONS: '-c session_preload_libraries=evil', PGSERVICEFILE: '/tmp/hostile', NODE_OPTIONS: '--require=/tmp/hostile.cjs' })).toEqual({ PATH: '/usr/bin:/bin', NODE_OPTIONS: '', PGHOST: 'database', PGPASSWORD: 'secret', PGUSER: 'merchant' })
  })
})
