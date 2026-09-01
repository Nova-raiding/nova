import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function receipt(input: { receiptId: string; workspaceId: string; assetId: string; digest: string; sourceRevision?: number }) {
  const value = {
    schema_version: 'asset-scan-receipt/1.0', receipt_id: input.receiptId, scan_job_id: `job_${input.assetId}`, scan_attempt_id: `attempt_${input.assetId}`,
    issuer: { scanner_service_id: 'scanner', scanner_instance_id: 'scanner-086', key_id: 'key-086' },
    subject: { workspace_id: input.workspaceId, asset_id: input.assetId, asset_source_revision: input.sourceRevision ?? 1, object_key: `quarantine/${input.workspaceId}/${input.assetId}/source`, sha256: 'a'.repeat(64), size_bytes: 4, mime_type: 'image/png' },
    scan: { verdict: 'clean', engine: 'clamav', engine_version: '1.4.6', definitions_version: '20260830', policy_version: 'v1', started_at: '2026-08-30T01:00:00.000Z', completed_at: '2026-08-30T01:00:01.000Z', findings: [] },
    issued_at: '2026-08-30T01:00:01.000Z', expires_at: '2026-08-30T01:05:01.000Z',
  }
  return { value, digest: input.digest }
}

describe('migration 086 trusted clean asset backfill', () => {
  it('registers a conservative metadata-only fail-closed migration', async () => {
    const sql = await readFile(new URL('./migrations/086_trusted_clean_asset_backfill.sql', import.meta.url), 'utf8')
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 86)).toMatchObject({ version: 86, name: 'trusted_clean_asset_backfill' })
    const latestVersion = Math.max(...migrations.map(item => item.version))
    expect(migrations.map(item => item.version)).toEqual(Array.from({ length: latestVersion }, (_, index) => index + 1))
    expect(sql).toContain("snapshot.entity_type = 'asset'")
    expect(sql).toContain("snapshot.payload->>'scanStatus' = 'clean'")
    expect(sql).toContain('FROM asset_scan_receipts receipt')
    expect(sql).toContain("receipt.verdict = 'clean'")
    expect(sql).toContain("'clean/' || p_workspace_id || '/'")
    expect(sql).toContain("'{scanStatus}', '\"blocked\"'::jsonb")
    expect(sql).toContain('CREATE TRIGGER business_entity_asset_trusted_clean')
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+(?:TABLE|SCHEMA|DATABASE)\b/iu)
  })

  postgresIt('keeps exactly bound trusted clean snapshots and blocks every ambiguous legacy clean snapshot without deleting metadata', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_086_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      const migrations = await loadMigrations()
      const backfill = migrations.find(item => item.version === 86)!
      expect(await new MigrationRunner(database, migrations.filter(item => item.version < 86)).run()).toEqual(Array.from({ length: 85 }, (_, index) => index + 1))
      await database.query("INSERT INTO workspaces (id,status) VALUES ('ws_086','active'),('ws_other','active')")

      const trustedDigest = '1'.repeat(64)
      const mismatchedDigest = '2'.repeat(64)
      for (const input of [
        receipt({ receiptId: 'receipt_trusted', workspaceId: 'ws_086', assetId: 'asset_trusted', digest: trustedDigest }),
        receipt({ receiptId: 'receipt_mismatch', workspaceId: 'ws_086', assetId: 'asset_mismatch', digest: mismatchedDigest }),
        receipt({ receiptId: 'receipt_wrong_key', workspaceId: 'ws_086', assetId: 'asset_wrong_key', digest: '3'.repeat(64) }),
      ]) {
        await database.query(
          `INSERT INTO asset_scan_receipts (receipt_id,workspace_id,asset_id,asset_source_revision,receipt_digest,signature,verdict,object_key,object_sha256,canonical_payload,receipt)
           VALUES ($1,$2,$3,1,$4,$5,'clean',$6,$7,$8::text,$8::jsonb)`,
          [input.value.receipt_id, input.value.subject.workspace_id, input.value.subject.asset_id, input.digest, 'A'.repeat(86), input.value.subject.object_key, input.value.subject.sha256, JSON.stringify(input.value)],
        )
      }

      const snapshot = async (entityType: string, id: string, payload: Record<string, unknown>, version = 3) => database!.query(
        `INSERT INTO business_entity_snapshots (workspace_id,entity_type,entity_id,entity_version,payload) VALUES ('ws_086',$1,$2,$3,$4::jsonb)`,
        [entityType, id, version, JSON.stringify(payload)],
      )
      const cleanPayload = (id: string, receiptId?: string, digest?: string, storageKey = `clean/ws_086/${id}/source`) => ({
        id, workspaceId: 'ws_086', sourceRevision: 1, scanStatus: 'clean', ...(receiptId ? { scanReceiptId: receiptId } : {}), ...(digest ? { scanReceiptDigest: digest } : {}), scanVerdict: 'clean', storageKey, revision: 3, businessLabel: `preserve:${id}`,
      })
      await snapshot('asset', 'asset_trusted', cleanPayload('asset_trusted', 'receipt_trusted', trustedDigest))
      await snapshot('asset', 'asset_legacy', cleanPayload('asset_legacy'))
      await snapshot('asset', 'asset_mismatch', cleanPayload('asset_mismatch', 'receipt_mismatch', 'f'.repeat(64)))
      await snapshot('asset', 'asset_wrong_key', cleanPayload('asset_wrong_key', 'receipt_wrong_key', '3'.repeat(64), 'clean/ws_other/asset_wrong_key/source'))
      await snapshot('asset', 'asset_revision_overflow', { ...cleanPayload('asset_revision_overflow'), sourceRevision: 2147483648 })
      await snapshot('asset', 'asset_quarantined', { ...cleanPayload('asset_quarantined'), scanStatus: 'quarantined', storageKey: 'quarantine/ws_086/asset_quarantined/source' })
      await snapshot('product', 'product_clean_word', { id: 'product_clean_word', workspaceId: 'ws_086', scanStatus: 'clean', storageKey: 'business-data', revision: 3 })

      expect(await new MigrationRunner(database, [backfill]).run()).toEqual([86])
      const rows = await database.query<{ entity_type: string; entity_id: string; entity_version: number; payload: Record<string, unknown> }>(
        `SELECT entity_type,entity_id,entity_version,payload FROM business_entity_snapshots WHERE workspace_id='ws_086' ORDER BY entity_type,entity_id`,
      )
      const byId = new Map(rows.rows.map(row => [row.entity_id, row]))
      expect(byId.get('asset_trusted')).toMatchObject({ entity_version: 3, payload: { scanStatus: 'clean', storageKey: 'clean/ws_086/asset_trusted/source', businessLabel: 'preserve:asset_trusted', revision: 3 } })
      for (const id of ['asset_legacy', 'asset_mismatch', 'asset_wrong_key', 'asset_revision_overflow']) {
        expect(byId.get(id)).toMatchObject({ entity_version: 4, payload: { scanStatus: 'blocked', businessLabel: `preserve:${id}`, revision: 4 } })
      }
      expect(byId.get('asset_wrong_key')?.payload.storageKey).toBe('clean/ws_other/asset_wrong_key/source')
      expect(byId.get('asset_quarantined')).toMatchObject({ entity_version: 3, payload: { scanStatus: 'quarantined', revision: 3 } })
      expect(byId.get('product_clean_word')).toMatchObject({ entity_version: 3, payload: { scanStatus: 'clean', storageKey: 'business-data', revision: 3 } })
      expect((await database.query('SELECT count(*)::integer AS count FROM asset_scan_receipts')).rows[0]?.count).toBe(3)
      await expect(snapshot('asset', 'asset_future_bypass', cleanPayload('asset_future_bypass'))).rejects.toThrow(/trusted signed scan receipt/u)
      await expect(database.query(
        `UPDATE business_entity_snapshots SET payload=jsonb_set(payload,'{businessLabel}','"still-trusted"'::jsonb,true),entity_version=4 WHERE workspace_id='ws_086' AND entity_type='asset' AND entity_id='asset_trusted'`,
      )).resolves.toMatchObject({ rowCount: 1 })
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
