import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { AssetScanRedriveError, PostgresAssetScanRedriveRepository } from './asset-scan-redrive-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresBusinessRepository } from './business-repository.js'
import { PostgresOutboxRepository, withWorkspaceTransaction, type SqlPool } from './repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('migration 109 PostgreSQL asset scan redrive acceptance', () => {
  postgresIt('atomically redrives once, preserves old evidence, audits, isolates tenants, and rejects mutation', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_109_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base); isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString(), max: 8 })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('ws_redrive_a','active'),('ws_redrive_b','active')`)
      const pool = database as unknown as SqlPool
      const business = new PostgresBusinessRepository(pool)
      const outbox = new PostgresOutboxRepository(pool)
      const repository = new PostgresAssetScanRedriveRepository(pool)
      const assetId = 'asset_redrive_109'
      const storageKey = `quarantine/ws_redrive_a/${assetId}/source.png`
      const sha256 = 'a'.repeat(64)
      const asset = { id: assetId, workspaceId: 'ws_redrive_a', name: 'source.png', mimeType: 'image/png', sizeBytes: 12, sha256, sourceRevision: 1, storageKey, rightsStatus: 'approved', rightsScope: 'owned', scanStatus: 'quarantined', scanReceiptId: 'old-receipt', scanReceiptDigest: 'b'.repeat(64), scanVerdict: 'clean', scanFindings: ['private-old-finding'], revision: 1, createdAt: '2026-08-31T00:00:00.000Z' }
      await business.save({ workspaceId: 'ws_redrive_a', entityType: 'asset', entityId: assetId, entityVersion: 1, payload: asset })
      const old = await outbox.append({ workspaceId: 'ws_redrive_a', aggregateId: assetId, eventType: 'asset.uploaded', sequence: 1, payload: { asset_id: assetId, storage_key: storageKey, sha256, size_bytes: 12, source_revision: 1 } })
      await withWorkspaceTransaction(pool, 'ws_redrive_a', client => client.query(`UPDATE outbox_events SET attempts=12 WHERE workspace_id=$1 AND id=$2`, ['ws_redrive_a', old.id]))
      await outbox.deadLetter('ws_redrive_a', old.id, { code: 'CLAMAV_SCAN_ERROR', message: 'scanner unavailable', retryable: true })
      const before = (await database.query(`SELECT id,workspace_id,aggregate_id,event_type,sequence,payload,created_at FROM outbox_events WHERE id=$1`, [old.id])).rows[0]

      const authorizationSnapshot = { schema_version: 1 as const, decision_id: 'decision-redrive-109', actor_id: 'security-operator', workspace_id: 'ws_redrive_a', context_id: 'workspace:ws_redrive_a', context_version: 'ctx_1', policy_version: 'policy_1', grant_revision: 'grant_1', scope_hash: 'c'.repeat(64), capability: 'asset.scan.execute' as const, resource_id: assetId, authorized: true as const, decided_at: '2026-08-31T00:00:00.000Z' }
      const commercialAccessSnapshot = { schema_version: 1 as const, decision_id: 'commercial-decision-redrive-109', workspace_id: 'ws_redrive_a', operation: 'asset.scan.execute' as const, access_mode: 'POINT_REQUIRED_NO_CHARGE' as const, access_revision: '4', balance_state: 'known' as const, entitlement_snapshot_id: 'creative-point-access:ws_redrive_a:4', entitlement_snapshot_checksum: 'd'.repeat(64), rate_version: null, quoted_points: 0 as const, decided_at: '2026-08-31T00:00:00.000Z' }
      const failures = await repository.listRetryableFailures('ws_redrive_a', { assetIds: [assetId], scanMaxAttempts: 12 })
      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatchObject({ assetId, assetRevision: 1, sourceRevision: 1, event: { id: old.id } })
      const input = { workspaceId: 'ws_redrive_a', assetId, deadLetterOutboxEventId: old.id, expectedAssetRevision: 1, recoveryKey: 'recovery-109-once', actorId: 'security-operator', reason: 'scanner recovered after incident', scanMaxAttempts: 12, authorizationSnapshot, commercialAccessSnapshot }
      const [left, right] = await Promise.all([repository.redrive(input), repository.redrive(input)])
      expect(new Set([left.event.id, right.event.id]).size).toBe(1)
      expect([left.replayed, right.replayed].sort()).toEqual([false, true])
      expect(left.asset).toMatchObject({ sourceRevision: 2, revision: 2, scanStatus: 'quarantined', rightsStatus: 'approved', rightsScope: 'owned' })
      expect(left.asset).not.toHaveProperty('scanReceiptId')
      expect(left.asset).not.toHaveProperty('scanFindings')
      expect(left.event).toMatchObject({ eventType: 'asset.scan_redrive_requested', sequence: 2, payload: { source_revision: 2, mime_type: 'image/png', recovery_from_outbox_event_id: old.id, recovery_key: input.recoveryKey, authorization_snapshot: authorizationSnapshot, commercial_access_snapshot: commercialAccessSnapshot } })
      expect(await repository.listRetryableFailures('ws_redrive_a', { assetIds: [assetId], scanMaxAttempts: 12 })).toEqual([])
      expect((await database.query(`SELECT count(*)::int AS count FROM asset_scan_redrives WHERE workspace_id='ws_redrive_a'`)).rows[0]?.count).toBe(1)
      expect((await database.query(`SELECT count(*)::int AS count FROM workspace_operation_audit WHERE workspace_id='ws_redrive_a' AND action='asset.scan.recovery_requested'`)).rows[0]?.count).toBe(1)
      expect((await database.query(`SELECT id,workspace_id,aggregate_id,event_type,sequence,payload,created_at FROM outbox_events WHERE id=$1`, [old.id])).rows[0]).toEqual(before)

      await expect(repository.redrive({ ...input, scanMaxAttempts: 13, authorizationSnapshot: { ...authorizationSnapshot, decision_id: 'decision-redrive-replay', grant_revision: 'grant_2', decided_at: '2026-08-31T00:01:00.000Z' } })).resolves.toMatchObject({ replayed: true, event: { id: left.event.id } })
      await expect(repository.redrive({ ...input, reason: 'different retry request' })).rejects.toMatchObject({ code: 'ASSET_SCAN_REDRIVE_IDEMPOTENCY_CONFLICT' })
      await expect(repository.redrive({ ...input, recoveryKey: 'recovery-109-race' })).rejects.toBeInstanceOf(AssetScanRedriveError)
      await expect(repository.redrive({ ...input, workspaceId: 'ws_redrive_b', authorizationSnapshot: { ...authorizationSnapshot, workspace_id: 'ws_redrive_b', context_id: 'workspace:ws_redrive_b' }, commercialAccessSnapshot: { ...commercialAccessSnapshot, workspace_id: 'ws_redrive_b', entitlement_snapshot_id: 'creative-point-access:ws_redrive_b:4' } })).rejects.toMatchObject({ code: 'ASSET_SCAN_REDRIVE_ASSET_NOT_FOUND' })
      await expect(withWorkspaceTransaction(pool, 'ws_redrive_a', client => client.query(`UPDATE outbox_events SET payload='{}'::jsonb WHERE id=$1`, [old.id]))).rejects.toThrow(/immutable/u)
      await expect(withWorkspaceTransaction(pool, 'ws_redrive_a', client => client.query(`DELETE FROM outbox_events WHERE id=$1`, [old.id]))).rejects.toThrow(/cannot be deleted/u)
      await expect(withWorkspaceTransaction(pool, 'ws_redrive_a', client => client.query(`UPDATE asset_scan_redrives SET reason='tampered' WHERE workspace_id='ws_redrive_a'`))).rejects.toThrow(/immutable/u)
      await expect(withWorkspaceTransaction(pool, 'ws_redrive_a', client => client.query(`DELETE FROM asset_scan_redrives WHERE workspace_id='ws_redrive_a'`))).rejects.toThrow(/cannot be deleted/u)
      await expect(database.query('TRUNCATE TABLE asset_scan_redrives')).rejects.toThrow(/cannot be truncated/u)
      await expect(database.query('TRUNCATE TABLE outbox_events')).rejects.toThrow(/cannot (?:be truncated|truncate)/u)
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
