import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresAssetScanAttemptRepository } from './asset-scan-attempt-repository.js'
import type { PersistableAssetScanReceipt } from './asset-scan-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const candidate = (attemptId: string) => {
  const receipt: PersistableAssetScanReceipt = {
    schema_version: 'asset-scan-receipt/1.0', receipt_id: `receipt_${attemptId}`, scan_job_id: 'evt_085', scan_attempt_id: attemptId,
    issuer: { scanner_service_id: 'scanner', scanner_instance_id: attemptId, key_id: 'key-085' },
    subject: { workspace_id: 'ws_085', asset_id: 'asset_085', asset_source_revision: 7, object_key: 'quarantine/ws_085/asset_085/source', sha256: 'a'.repeat(64), size_bytes: 4, mime_type: 'image/png' },
    scan: { verdict: 'clean', engine: 'clamav', engine_version: '1.4.6', definitions_version: '28108', policy_version: 'v1', started_at: '2026-08-30T01:00:00.000Z', completed_at: '2026-08-30T01:00:01.000Z', findings: [] },
    issued_at: '2026-08-30T01:00:01.000Z', expires_at: '2026-08-30T01:05:01.000Z',
  }
  const canonicalReceipt = JSON.stringify(receipt)
  const signature = attemptId === 'replica_a' ? 'A'.repeat(86) : 'B'.repeat(86)
  return { workspaceId: 'ws_085', outboxEventId: 'evt_085', assetSourceRevision: 7, canonicalReceipt, signature, receiptDigest: createHash('sha256').update(canonicalReceipt).digest('hex'), callbackBody: JSON.stringify({ receipt, signature }) }
}

describe('migration 085 durable asset scan attempts', () => {
  it('registers composite uniqueness, immutable evidence, callback state and RLS', async () => {
    const sql = await readFile(new URL('./migrations/085_asset_scan_attempts.sql', import.meta.url), 'utf8')
    expect(sql).toContain('PRIMARY KEY (outbox_event_id,asset_source_revision)')
    expect(sql).toContain('canonical_receipt TEXT NOT NULL')
    expect(sql).toContain('callback_body TEXT NOT NULL')
    expect(sql).toContain("callback_status TEXT NOT NULL DEFAULT 'pending'")
    expect(sql).toContain('asset scan attempt evidence is immutable')
    expect(sql).toContain('asset scan attempts are durable and cannot be deleted')
    expect(sql).toContain('FOREIGN KEY (outbox_event_id,workspace_id) REFERENCES outbox_events(id,workspace_id)')
    expect(sql).toContain('ALTER TABLE asset_scan_attempts FORCE ROW LEVEL SECURITY')
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 85)).toMatchObject({ version: 85, name: 'asset_scan_attempts' })
  })

  postgresIt('serializes competing replicas and durably resumes the exact callback bytes in PostgreSQL', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_085_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base); isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('ws_085','active')`)
      await database.query(`INSERT INTO outbox_events (id,workspace_id,aggregate_id,event_type,sequence,payload) VALUES ('evt_085','ws_085','asset_085','asset.uploaded',7,'{}')`)
      const appUrl = new URL(isolated); appUrl.username = 'merchant_app'; appUrl.password = 'merchant_app_local_only'
      app = new Pool({ connectionString: appUrl.toString(), max: 4 })
      const repository = new PostgresAssetScanAttemptRepository(app)
      const [left, right] = await Promise.all([repository.createOrGet(candidate('replica_a')), repository.createOrGet(candidate('replica_b'))])
      expect([left.created, right.created].filter(Boolean)).toHaveLength(1)
      expect(left.record.callbackBody).toBe(right.record.callbackBody)
      expect(left.record.receiptDigest).toBe(right.record.receiptDigest)
      const pending = await repository.recordCallbackAttempt({ workspaceId: 'ws_085', outboxEventId: 'evt_085', assetSourceRevision: 7, receiptDigest: left.record.receiptDigest })
      expect(pending).toMatchObject({ callbackStatus: 'pending', callbackAttempts: 1 })
      const accepted = await repository.markCallbackAccepted({ workspaceId: 'ws_085', outboxEventId: 'evt_085', assetSourceRevision: 7, receiptDigest: left.record.receiptDigest })
      expect(accepted).toMatchObject({ callbackStatus: 'accepted', callbackAttempts: 1 })
      await expect(repository.recordCallbackAttempt({ workspaceId: 'ws_085', outboxEventId: 'evt_085', assetSourceRevision: 7, receiptDigest: left.record.receiptDigest })).rejects.toBeDefined()
      await expect(database.query(`UPDATE asset_scan_attempts SET signature=$1 WHERE outbox_event_id='evt_085'`, ['C'.repeat(86)])).rejects.toThrow(/immutable/u)
      await expect(database.query(`DELETE FROM asset_scan_attempts WHERE outbox_event_id='evt_085'`)).rejects.toThrow(/cannot be deleted/u)
      expect((await repository.getByOutboxEvent('ws_085', 'evt_085'))?.callbackBody).toBe(left.record.callbackBody)
    } finally {
      await app?.end(); await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
