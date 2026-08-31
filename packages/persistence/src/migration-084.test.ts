import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'
import { AssetScanReceiptConflictError, PostgresAssetScanReceiptRepository, type PersistableAssetScanReceipt } from './asset-scan-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const receipt = (overrides: Partial<PersistableAssetScanReceipt> = {}): PersistableAssetScanReceipt => ({
  schema_version: 'asset-scan-receipt/1.0', receipt_id: 'receipt_084', scan_job_id: 'job_084', scan_attempt_id: 'attempt_084',
  issuer: { scanner_service_id: 'scanner', scanner_instance_id: 'scanner-084', key_id: 'key-084' },
  subject: { workspace_id: 'ws_084_a', asset_id: 'asset_084', asset_source_revision: 1, object_key: 'quarantine/ws_084_a/asset_084/source', sha256: 'a'.repeat(64), size_bytes: 4, mime_type: 'image/png' },
  scan: { verdict: 'clean', engine: 'clamav', engine_version: '1.4.6', definitions_version: '20260830', policy_version: 'v1', started_at: '2026-08-30T01:00:00.000Z', completed_at: '2026-08-30T01:00:01.000Z', findings: [] },
  issued_at: '2026-08-30T01:00:01.000Z', expires_at: '2026-08-30T01:05:01.000Z', ...overrides,
})
const appendInput = (value = receipt()) => ({ receipt: value, receiptDigest: createHash('sha256').update(JSON.stringify(value)).digest('hex'), signature: 'A'.repeat(86) })

describe('migration 084 asset scan receipts', () => {
  it('registers an append-only, tenant-isolated receipt ledger', async () => {
    const sql = await readFile(new URL('./migrations/084_asset_scan_receipts.sql', import.meta.url), 'utf8')
    expect(sql).toContain('UNIQUE (workspace_id,asset_id,asset_source_revision)')
    expect(sql).toContain('receipt_digest TEXT NOT NULL UNIQUE')
    expect(sql).toContain('canonical_payload TEXT NOT NULL')
    expect(sql).toContain('canonical_payload::jsonb = receipt')
    expect(sql).toContain('ALTER TABLE asset_scan_receipts ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('ALTER TABLE asset_scan_receipts FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('CREATE POLICY asset_scan_receipts_workspace_isolation')
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON asset_scan_receipts')
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE asset_scan_receipts FROM merchant_app')
    expect(sql).toContain('GRANT SELECT, INSERT ON TABLE asset_scan_receipts TO merchant_app')
    expect(sql).not.toMatch(/GRANT[^;]+(?:UPDATE|DELETE)[^;]+asset_scan_receipts/u)
  })

  it('is the ordered migration 084 asset', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 84)).toMatchObject({ version: 84, name: 'asset_scan_receipts' })
    expect(migrations.map(item => item.version)).toEqual(Array.from({ length: migrations.length }, (_, index) => index + 1))
  })

  postgresIt('enforces RLS, idempotency, conflict detection, and append-only storage in PostgreSQL', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_084_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      const migrations = await loadMigrations()
      const { MigrationRunner } = await import('./migration.js')
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('ws_084_a','active'),('ws_084_b','active')`)

      const appUrl = new URL(isolated)
      appUrl.username = 'merchant_app'
      appUrl.password = 'merchant_app_local_only'
      app = new Pool({ connectionString: appUrl.toString() })
      const repository = new PostgresAssetScanReceiptRepository(app)
      const first = await repository.append(appendInput())
      expect(first.created).toBe(true)
      await expect(repository.append(appendInput())).resolves.toEqual({ created: false, record: first.record })
      await expect(repository.getByReceiptId('ws_084_b', 'receipt_084')).resolves.toBeUndefined()

      const conflicting = receipt({ scan_attempt_id: 'attempt_conflict' })
      await expect(repository.append(appendInput(conflicting))).rejects.toBeInstanceOf(AssetScanReceiptConflictError)
      await expect(app.query(`UPDATE asset_scan_receipts SET signature=$1 WHERE receipt_id=$2`, ['B'.repeat(86), 'receipt_084'])).rejects.toThrow(/permission denied/u)
      await expect(app.query(`DELETE FROM asset_scan_receipts WHERE receipt_id=$1`, ['receipt_084'])).rejects.toThrow(/permission denied/u)
      await expect(database.query(`UPDATE asset_scan_receipts SET signature=$1 WHERE receipt_id=$2`, ['B'.repeat(86), 'receipt_084'])).rejects.toThrow(/append-only/u)
      await expect(database.query(`DELETE FROM asset_scan_receipts WHERE receipt_id=$1`, ['receipt_084'])).rejects.toThrow(/append-only/u)
    } finally {
      await app?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
