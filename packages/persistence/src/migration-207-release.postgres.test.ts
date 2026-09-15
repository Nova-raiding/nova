import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const databaseConnection = (base: URL, database: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  return url.toString()
}

describe('migration 207 customer delivery evidence receipt identity', () => {
  postgresIt('rejects receipt identity drift and invalidates a valid replacement', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_delivery_receipt_identity_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    const database = new Pool({ connectionString: databaseConnection(base, databaseName) })
    const workspaceId = 'ws_receipt_identity'
    const assetId = 'asset_receipt_identity'
    const deliveryId = 'delivery_receipt_identity'

    const insertReceipt = async (revision: number, mimeType: string, sha256: string, sizeBytes: number) => {
      const receiptId = `receipt_identity_${revision}`
      const receiptDigest = createHash('sha256').update(receiptId).digest('hex')
      const objectKey = `quarantine/${workspaceId}/${assetId}/source-${revision}`
      const receipt = {
        schema_version: 'asset-scan-receipt/1.0',
        receipt_id: receiptId,
        subject: { workspace_id: workspaceId, asset_id: assetId, asset_source_revision: revision,
          object_key: objectKey, sha256, size_bytes: sizeBytes, mime_type: mimeType },
        scan: { verdict: 'clean' },
      }
      await database.query(
        `INSERT INTO asset_scan_receipts (
           receipt_id,workspace_id,asset_id,asset_source_revision,receipt_digest,
           signature,verdict,object_key,object_sha256,canonical_payload,receipt
         ) VALUES ($1,$2,$3,$4,$5,'signature','clean',$6,$7,$8::text,$8::jsonb)`,
        [receiptId, workspaceId, assetId, revision, receiptDigest, objectKey, sha256, JSON.stringify(receipt)],
      )
      return { receiptId, receiptDigest }
    }

    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const migrations = await loadMigrations()
      const migrationsThrough207 = migrations.filter(migration => migration.version <= 207)
      expect(await new MigrationRunner(database, migrationsThrough207.filter(migration => migration.version <= 206)).run()).toContain(206)
      await database.query(`INSERT INTO workspaces (id,status) VALUES ($1,'active')`, [workspaceId])

      const sha1 = createHash('sha256').update('identity-v1').digest('hex')
      const first = await insertReceipt(1, 'application/pdf', sha1, 41)
      const payload = {
        id: assetId, workspaceId, sourceRevision: 1, scanReceiptId: first.receiptId,
        scanReceiptDigest: first.receiptDigest, scanVerdict: 'clean', scanStatus: 'clean',
        storageKey: `clean/${workspaceId}/${assetId}/source-1`, mimeType: 'application/pdf',
        sha256: sha1, sizeBytes: 41, revision: 1,
      }
      await database.query(
        `INSERT INTO business_entity_snapshots (workspace_id,entity_type,entity_id,entity_version,payload)
         VALUES ($1,'asset',$2,1,$3::jsonb)`,
        [workspaceId, assetId, JSON.stringify(payload)],
      )
      await database.query(
        `INSERT INTO workspace_customer_deliveries (
           id,workspace_id,company_name,payment_status,payment_date,payment_evidence_refs,
           created_by_actor_id,updated_by_actor_id,effective_at
         ) VALUES ($1,$2,'Receipt Identity','paid',DATE '2026-09-14',ARRAY[$3],
           'operator','operator',now())`,
        [deliveryId, workspaceId, assetId],
      )

      await database.query(
        `UPDATE business_entity_snapshots
         SET payload=jsonb_set(payload,'{sha256}',to_jsonb($1::text),true), entity_version=2
         WHERE workspace_id=$2 AND entity_type='asset' AND entity_id=$3`,
        ['f'.repeat(64), workspaceId, assetId],
      )
      expect((await database.query(
        `SELECT effective_at IS NOT NULL AS effective FROM workspace_customer_deliveries
         WHERE workspace_id=$1 AND id=$2`, [workspaceId, deliveryId],
      )).rows).toEqual([{ effective: true }])

      const runnerThrough207 = new MigrationRunner(database, migrationsThrough207)
      expect(await runnerThrough207.run()).toEqual([207])
      expect(await runnerThrough207.run()).toEqual([])

      const trust = async (changed: Record<string, unknown> = {}) => Boolean((await database.query(
        `SELECT public.asset_snapshot_is_trusted_clean($1,$2,$3::jsonb) AS trusted`,
        [workspaceId, assetId, JSON.stringify({ ...payload, ...changed })],
      )).rows[0]?.trusted)
      expect(await trust()).toBe(true)
      expect(await trust({ mimeType: 'video/mp4' })).toBe(false)
      expect(await trust({ sha256: 'f'.repeat(64) })).toBe(false)
      expect(await trust({ sizeBytes: 42 })).toBe(false)

      expect((await database.query(
        `SELECT effective_at,revision FROM workspace_customer_deliveries
         WHERE workspace_id=$1 AND id=$2`, [workspaceId, deliveryId],
      )).rows).toEqual([{ effective_at: null, revision: '2' }])
      expect((await database.query(
        `SELECT count(*)::int AS count FROM workspace_operation_audit
         WHERE workspace_id=$1 AND resource_id=$2
           AND action='customer_delivery.evidence.invalidated'`, [workspaceId, deliveryId],
      )).rows).toEqual([{ count: 1 }])
      expect((await database.query(
        `SELECT payload->>'scanStatus' AS scan_status,entity_version
         FROM business_entity_snapshots
         WHERE workspace_id=$1 AND entity_type='asset' AND entity_id=$2`, [workspaceId, assetId],
      )).rows).toEqual([{ scan_status: 'blocked', entity_version: 3 }])
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await database.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [
        () => admin.end(),
      ])
    }
  }, 300_000)
})
