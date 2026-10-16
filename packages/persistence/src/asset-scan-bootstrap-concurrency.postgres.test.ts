import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresAssetScanRedriveRepository, type AssetScanRedriveInput } from './asset-scan-redrive-repository.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip
const asset = {
  id: 'asset_scan', workspaceId: 'ws_scan', revision: 1, sourceRevision: 1,
  storageKey: 'quarantine/ws_scan/asset_scan/source.png', sha256: 'a'.repeat(64),
  sizeBytes: 12, mimeType: 'image/png', scanStatus: 'quarantined',
}
const input: AssetScanRedriveInput = {
  workspaceId: 'ws_scan', assetId: asset.id, deadLetterOutboxEventId: 'evt_scan', expectedAssetRevision: 1,
  recoveryKey: 'recovery-scan-once', actorId: 'operator', reason: 'scanner recovered', scanMaxAttempts: 12,
  authorizationSnapshot: {
    schema_version: 1, decision_id: 'decision', actor_id: 'operator', workspace_id: 'ws_scan',
    context_id: 'workspace:ws_scan', context_version: 'ctx_1', policy_version: 'policy_1', grant_revision: 'grant_1',
    scope_hash: 'b'.repeat(64), capability: 'asset.scan.execute', resource_id: asset.id, authorized: true,
    decided_at: '2026-09-07T00:00:00.000Z',
  },
  commercialAccessSnapshot: {
    schema_version: 1, decision_id: 'commercial-decision', workspace_id: 'ws_scan', operation: 'asset.scan.execute',
    access_mode: 'POINT_REQUIRED_NO_CHARGE', access_revision: '1', balance_state: 'known',
    entitlement_snapshot_id: 'creative-point-access:ws_scan:1', entitlement_snapshot_checksum: 'c'.repeat(64),
    rate_version: null, quoted_points: 0, decided_at: '2026-09-07T00:00:00.000Z',
  },
}

describe('scan bootstrap PostgreSQL concurrency', () => {
  postgresIt('serializes a shared recovery key across assets and rolls back the conflicting request', async () => {
    const admin = new Pool({ connectionString: databaseUrl!, max: 2 })
    const appUrl = new URL(databaseUrl!)
    appUrl.username = 'merchant_app'
    appUrl.password = 'merchant_app_local_only'
    const app = new Pool({ connectionString: appUrl.toString(), max: 3 })
    const workspaceId = `ws_bootstrap_${randomUUID().replaceAll('-', '')}`
    try {
      await admin.query("INSERT INTO workspaces(id,status) VALUES ($1,'active')", [workspaceId])
      await admin.query('GRANT SELECT,INSERT,UPDATE ON business_entity_snapshots TO merchant_app')
      const assetIds = ['bootstrap_a', 'bootstrap_b']
      for (const id of assetIds) {
        await admin.query("INSERT INTO business_entity_snapshots(workspace_id,entity_type,entity_id,entity_version,payload) VALUES ($1,'asset',$2,1,$3::jsonb)",
          [workspaceId, id, JSON.stringify({ ...asset, id, workspaceId, scanStatus: 'unscanned', storageKey: `quarantine/${workspaceId}/${id}/source.png` })])
      }
      const repository = new PostgresAssetScanRedriveRepository(app)
      const request = (assetId: string) => ({ ...input, workspaceId, assetId,
        authorizationSnapshot: { ...input.authorizationSnapshot, workspace_id: workspaceId, context_id: `workspace:${workspaceId}`, resource_id: assetId },
        commercialAccessSnapshot: { ...input.commercialAccessSnapshot, workspace_id: workspaceId },
      })
      // Hold both asset rows so both requests enter the transaction before
      // either can commit. A key lock must serialize them before row locking.
      const blocker = await admin.connect()
      let outcomes: Awaited<ReturnType<typeof Promise.allSettled>>
      try {
        await blocker.query('BEGIN')
        await blocker.query("SELECT 1 FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='asset' FOR UPDATE", [workspaceId])
        const pending = assetIds.map(id => repository.bootstrapUnscanned(request(id)))
        const settled = Promise.allSettled(pending)
        let waiting = false
        for (let attempt = 0; attempt < 200; attempt++) {
          const result = await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename='merchant_app' AND wait_event_type='Lock'")
          if (Number(result.rows[0]?.count) >= 2) { waiting = true; break }
          await new Promise(resolve => setTimeout(resolve, 15))
        }
        await blocker.query('COMMIT')
        outcomes = await settled
        expect(waiting).toBe(true)
      } finally { await blocker.query('ROLLBACK'); blocker.release() }
      const successes = outcomes.filter(result => result.status === 'fulfilled')
      const failures = outcomes.filter(result => result.status === 'rejected')
      expect(successes).toHaveLength(1)
      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatchObject({ reason: { code: 'ASSET_SCAN_BOOTSTRAP_IDEMPOTENCY_CONFLICT' } })
      const rows = await admin.query("SELECT entity_version,payload->>'scanStatus' AS status FROM business_entity_snapshots WHERE workspace_id=$1 ORDER BY entity_version", [workspaceId])
      expect(rows.rows).toEqual([{ entity_version: 1, status: 'unscanned' }, { entity_version: 2, status: 'quarantined' }])
      for (const table of ['asset_scan_bootstraps', 'outbox_events', 'workspace_operation_audit']) {
        expect((await admin.query(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id=$1`, [workspaceId])).rows).toEqual([{ count: 1 }])
      }
    } finally { await app.end(); await admin.end() }
  }, 30_000)
})
