import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresAssetPromotionCleanupRepository } from './asset-promotion-cleanup-repository.js'
import { PostgresAssetScanReceiptRepository, type AppendAssetScanReceiptInput, type PersistableAssetScanReceipt } from './asset-scan-repository.js'
import { PostgresBusinessRepository } from './business-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresOutboxRepository, withWorkspaceTransaction, type SqlPool } from './repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('migration 087 atomic asset promotion cleanup', () => {
  it('registers a tenant-scoped immutable durable cleanup queue', async () => {
    const sql = await readFile(new URL('./migrations/087_asset_promotion_cleanup_tasks.sql', import.meta.url), 'utf8')
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 87)).toMatchObject({ version: 87, name: 'asset_promotion_cleanup_tasks' })
    expect(migrations.map(item => item.version)).toEqual(Array.from({ length: 119 }, (_, index) => index + 1))
    expect(sql).toContain('asset_promotion_cleanup_tasks')
    expect(sql).not.toContain('FOR UPDATE SKIP LOCKED') // claim SQL belongs to the repository, not the migration
    expect(sql).toContain('asset promotion cleanup binding is immutable')
    expect(sql).toContain('asset promotion cleanup tasks cannot be deleted')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
  })

  postgresIt('rolls back every promotion row on DB failure and converges delete-failure/response-loss/concurrent replay exactly once', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_087_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base); isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('ws_087','active')`)
      app = new Pool({ connectionString: isolated.toString(), max: 8 })
      const sqlPool = app as unknown as SqlPool
      const receipts = new PostgresAssetScanReceiptRepository(sqlPool)
      const cleanup = new PostgresAssetPromotionCleanupRepository(sqlPool)
      const business = new PostgresBusinessRepository(sqlPool)
      const outbox = new PostgresOutboxRepository(sqlPool)
      const quarantineKey = 'quarantine/ws_087/asset_087/source.png'
      const cleanKey = 'clean/ws_087/asset_087/source.png'
      const objectSha256 = 'b'.repeat(64)
      const sizeBytes = 20
      const uploaded = await outbox.append({ workspaceId: 'ws_087', aggregateId: 'asset_087', eventType: 'asset.uploaded', sequence: 1, payload: { asset_id: 'asset_087', storage_key: quarantineKey, sha256: objectSha256, size_bytes: sizeBytes } })
      const receipt: PersistableAssetScanReceipt = {
        schema_version: 'asset-scan-receipt/1.0', receipt_id: 'receipt_087', scan_job_id: uploaded.id, scan_attempt_id: 'attempt_087',
        issuer: { scanner_service_id: 'scanner', scanner_instance_id: 'scanner-087', key_id: 'key-087' },
        subject: { workspace_id: 'ws_087', asset_id: 'asset_087', asset_source_revision: 1, object_key: quarantineKey, sha256: objectSha256, size_bytes: sizeBytes, mime_type: 'image/png' },
        scan: { verdict: 'clean', engine: 'clamav', engine_version: '1.5.3', definitions_version: '28108', policy_version: 'v1', started_at: '2026-08-30T01:00:00.000Z', completed_at: '2026-08-30T01:00:01.000Z', findings: [] },
        issued_at: '2026-08-30T01:00:01.000Z', expires_at: '2026-08-30T01:05:01.000Z',
      }
      const receiptInput: AppendAssetScanReceiptInput = { receipt, receiptDigest: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'), signature: 'A'.repeat(86) }
      const evidence = `scan-receipt://${receipt.receipt_id}/${receiptInput.receiptDigest}`
      const payload = { id: 'asset_087', workspaceId: 'ws_087', sourceRevision: 1, revision: 2, storageKey: cleanKey, sha256: objectSha256, sizeBytes, mimeType: 'image/png', scanStatus: 'clean', scanReceiptId: receipt.receipt_id, scanReceiptDigest: receiptInput.receiptDigest, scanVerdict: 'clean' }

      const commit = (fail = false) => withWorkspaceTransaction(sqlPool, 'ws_087', async client => {
        await receipts.appendInTransaction(client, receiptInput)
        await business.saveInTransaction(client, { workspaceId: 'ws_087', entityType: 'asset', entityId: 'asset_087', entityVersion: 2, payload })
        const ready = await outbox.appendInTransaction(client, { workspaceId: 'ws_087', aggregateId: 'asset_087', eventType: 'asset.scan_promoted', sequence: 2, payload: { asset_id: 'asset_087', storage_key: cleanKey } })
        const task = await cleanup.createInTransaction(client, { workspaceId: 'ws_087', receiptId: receipt.receipt_id, assetId: 'asset_087', assetSourceRevision: 1, quarantineKey, cleanKey, scanEvidenceRef: evidence, objectSha256, sizeBytes, readyOutboxEventId: ready.id })
        if (fail) throw new Error('injected database failure after copy')
        return task.task
      })

      await expect(commit(true)).rejects.toThrow('injected database failure after copy')
      expect((await database.query(`SELECT count(*)::int AS count FROM asset_scan_receipts WHERE receipt_id='receipt_087'`)).rows[0]?.count).toBe(0)
      expect((await database.query(`SELECT count(*)::int AS count FROM business_entity_snapshots WHERE workspace_id='ws_087' AND entity_id='asset_087'`)).rows[0]?.count).toBe(0)

      const [left,right] = await Promise.all([commit(),commit()])
      expect(left.cleanupId).toBe(right.cleanupId)
      expect((await database.query(`SELECT count(*)::int AS count FROM asset_scan_receipts WHERE receipt_id='receipt_087'`)).rows[0]?.count).toBe(1)
      expect((await database.query(`SELECT count(*)::int AS count FROM outbox_events WHERE workspace_id='ws_087' AND event_type='asset.scan_promoted'`)).rows[0]?.count).toBe(1)
      expect((await database.query(`SELECT count(*)::int AS count FROM asset_promotion_cleanup_tasks WHERE workspace_id='ws_087'`)).rows[0]?.count).toBe(1)

      // Inject phase-2 deletion failure: the committed clean state remains
      // authoritative and the complete binding stays pending for retry.
      const [leased] = await cleanup.claimPending('ws_087', { limit: 1, leaseMs: 30_000 })
      expect(leased?.cleanupId).toBe(left.cleanupId)
      await cleanup.recordFailure({ workspaceId: 'ws_087', cleanupId: left.cleanupId, leaseToken: leased!.leaseToken, error: { code: 'INJECTED_DELETE_FAILURE' }, nextAttemptAt: new Date().toISOString() })
      expect((await cleanup.getByReceipt('ws_087','receipt_087'))).toMatchObject({ status: 'pending', attempts: 1, lastError: { code: 'INJECTED_DELETE_FAILURE' } })
      expect((await business.loadWorkspace('ws_087')).find(row => row.entityType === 'asset' && row.entityId === 'asset_087')?.payload).toMatchObject({ scanStatus: 'clean', storageKey: cleanKey })

      // Lost HTTP response replays the same callback transaction without a
      // second receipt, ready event, task, or generation trigger.
      const replay = await commit()
      expect(replay.cleanupId).toBe(left.cleanupId)
      await cleanup.markCompleted({ workspaceId: 'ws_087', cleanupId: replay.cleanupId })
      expect(await cleanup.getByReceipt('ws_087','receipt_087')).toMatchObject({ status: 'completed', attempts: 1 })
    } finally {
      await app?.end(); await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1',[databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
