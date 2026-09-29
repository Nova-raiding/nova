import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { PostgresAssetLifecycleRepository } from './asset-lifecycle-repository.js'
import { PostgresBusinessRepository } from './business-repository.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip
const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base); url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}
async function waitForLockWait(database: Pool, expectedBlockedSessions: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await database.query<{ blocked: number }>(
      `SELECT count(*)::int AS blocked FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND usename='merchant_app' AND wait_event_type='Lock'`,
    )
    if ((result.rows[0]?.blocked ?? 0) >= expectedBlockedSessions) return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error(`timed out waiting for ${expectedBlockedSessions} merchant_app PostgreSQL lock waits`)
}

describe('asset lifecycle PostgreSQL release evidence', () => {
  postgresIt('migrates 256 and enforces tenant RLS, lifecycle transitions, retention and immutable audit', async () => {
    const base = new URL(databaseUrl!)
    const databaseName = `asset_lifecycle_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(migrations.at(-1)).toMatchObject({ version: 256, name: 'asset_lifecycle' })
      // Model the supported bridge boundary explicitly: the application may
      // start with the complete 255 prefix, then the reviewed candidate applies
      // only migration 256. This catches accidental dependence on a fresh DB.
      await new MigrationRunner(database, migrations.slice(0, 255)).run()
      const prefix255 = await database.query('SELECT max(version)::int AS version, count(*)::int AS count FROM schema_migrations')
      expect(prefix255.rows).toEqual([{ version: 255, count: 255 }])
      await new MigrationRunner(database, migrations).run()
      expect((await database.query('SELECT max(version)::int AS version FROM schema_migrations')).rows).toEqual([{ version: 256 }])
      // Runtime role bootstrap grants scoped snapshot reads in production; the
      // test fixture provisions role credentials only, so reproduce that read
      // grant explicitly while forced RLS remains active.
      await database.query('GRANT SELECT, INSERT, UPDATE ON business_entity_snapshots TO merchant_app')
      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws_lifecycle_a','active'),('ws_lifecycle_b','active')")
      for (const workspaceId of ['ws_lifecycle_a', 'ws_lifecycle_b']) {
        await database.query(`INSERT INTO business_entity_snapshots(workspace_id,entity_type,entity_id,entity_version,payload)
          VALUES ($1,'asset','shared_asset',1,$2::jsonb)`, [workspaceId, JSON.stringify({ id: 'shared_asset', workspaceId, sourceRevision: 1, mimeType: 'image/png', scanStatus: 'quarantined', rightsStatus: 'pending', parseStatus: 'pending' })])
      }
      for (const assetId of ['early_purge_retry', 'early_purge_success']) {
        await database.query(`INSERT INTO business_entity_snapshots(workspace_id,entity_type,entity_id,entity_version,payload)
          VALUES ('ws_lifecycle_a','asset',$1,1,$2::jsonb)`, [assetId, JSON.stringify({ id: assetId, workspaceId: 'ws_lifecycle_a', sourceRevision: 1, mimeType: 'image/png', scanStatus: 'quarantined', rightsStatus: 'pending', parseStatus: 'pending' })])
      }
      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 3 })
      const repository = new PostgresAssetLifecycleRepository(app)
      const business = new PostgresBusinessRepository(app)
      const startedAt = Date.now()
      const at = (days: number) => new Date(startedAt + days * 86_400_000).toISOString()
      const trashed = await repository.trash({ workspaceId: 'ws_lifecycle_a', assetId: 'shared_asset', actorId: 'merchant-a', expectedRevision: 1, now: at(0) })
      expect(trashed).toMatchObject({ workspaceId: 'ws_lifecycle_a', deletedBy: 'merchant-a', expiresAt: at(7), revision: 1 })
      await expect(database.query(`DELETE FROM business_entity_snapshots WHERE workspace_id='ws_lifecycle_a' AND entity_type='asset' AND entity_id='shared_asset'`)).rejects.toThrow(/retained while lifecycle state exists/u)
      expect(await repository.listTrash('ws_lifecycle_a', { now: at(1) })).toMatchObject({ total: 1, items: [{ assetId: 'shared_asset' }] })
      await repository.trash({ workspaceId: 'ws_lifecycle_b', assetId: 'shared_asset', actorId: 'merchant-b', expectedRevision: 1, now: at(0) })
      expect(await repository.listTrash('ws_lifecycle_b', { now: at(1) })).toMatchObject({ total: 1, items: [{ workspaceId: 'ws_lifecycle_b' }] })
      await expect(repository.trash({ workspaceId: 'ws_lifecycle_a', assetId: 'not-in-a', actorId: 'merchant-a' })).rejects.toThrow('ASSET_LIFECYCLE_ASSET_NOT_FOUND')
      await expect(repository.restore({ workspaceId: 'ws_lifecycle_a', assetId: 'shared_asset', actorId: 'merchant-a', expectedRevision: 9, now: at(1) })).rejects.toThrow('ASSET_LIFECYCLE_RESTORE_UNAVAILABLE')

      const appClient = await app.connect()
      try {
        await appClient.query('BEGIN')
        await appClient.query("SELECT set_config('app.workspace_id','ws_lifecycle_a',true)")
        expect((await appClient.query(`SELECT workspace_id FROM merchant_asset_lifecycle WHERE asset_id='shared_asset' ORDER BY workspace_id`)).rows).toEqual([{ workspace_id: 'ws_lifecycle_a' }])
        await expect(appClient.query(`INSERT INTO merchant_asset_lifecycle(workspace_id,asset_id,deleted_at,expires_at,deleted_by)
          VALUES ('ws_lifecycle_b','shared_asset',now(),now()+interval '7 days','forged')`)).rejects.toMatchObject({ code: '23503' })
      } finally {
        await appClient.query('ROLLBACK')
        appClient.release()
      }

      const restored = await repository.restore({ workspaceId: 'ws_lifecycle_a', assetId: 'shared_asset', actorId: 'merchant-a', expectedRevision: 1, now: at(1) })
      expect(restored).toMatchObject({ revision: 2, restoredBy: 'merchant-a' })
      expect(await repository.isActive('ws_lifecycle_a', 'shared_asset')).toBe(true)
      const currentTime = new Date().toISOString()
      const trashedAgain = await repository.trash({ workspaceId: 'ws_lifecycle_a', assetId: 'shared_asset', actorId: 'merchant-a', expectedRevision: 2, now: currentTime })
      expect(trashedAgain).toMatchObject({ revision: 3, expiresAt: new Date(Date.parse(currentTime) + 7 * 86_400_000).toISOString() })
      await database.query(`UPDATE merchant_asset_lifecycle SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id='ws_lifecycle_a' AND asset_id='shared_asset'`)
      const [claim] = await repository.claimExpired({ workspaceId: 'ws_lifecycle_a', workerId: 'asset-cleaner', now: new Date().toISOString() })
      expect(claim).toMatchObject({ assetId: 'shared_asset', leaseToken: expect.any(String) })
      const expiredLeaseAt = new Date(Date.now() - 1_000).toISOString()
      await database.query(`UPDATE merchant_asset_lifecycle SET purge_lease_until=$2::timestamptz WHERE workspace_id=$1 AND asset_id='shared_asset'`, ['ws_lifecycle_a', expiredLeaseAt])
      await expect(repository.completePurge({ workspaceId: 'ws_lifecycle_a', assetId: 'shared_asset', workerId: 'stale-cleaner', leaseToken: claim!.leaseToken, now: new Date().toISOString() })).rejects.toThrow('ASSET_LIFECYCLE_PURGE_LEASE_CONFLICT')
      await expect(repository.failPurge({ workspaceId: 'ws_lifecycle_a', assetId: 'shared_asset', workerId: 'stale-cleaner', leaseToken: claim!.leaseToken, error: { code: 'STALE_WORKER' }, now: new Date().toISOString() })).rejects.toThrow('ASSET_LIFECYCLE_PURGE_LEASE_CONFLICT')
      const [renewedClaim] = await repository.claimExpired({ workspaceId: 'ws_lifecycle_a', workerId: 'asset-cleaner', now: new Date().toISOString() })
      expect(renewedClaim?.leaseToken).not.toBe(claim?.leaseToken)
      const purgedAt = new Date().toISOString()
      const purged = await repository.completePurge({ workspaceId: 'ws_lifecycle_a', assetId: 'shared_asset', workerId: 'asset-cleaner', leaseToken: renewedClaim!.leaseToken, now: purgedAt })
      expect(purged.purgedAt).toBe(purgedAt)
      expect(await repository.isActive('ws_lifecycle_a', 'shared_asset')).toBe(false)
      expect(await repository.isTrashed('ws_lifecycle_a', 'shared_asset')).toBe(true)
      expect(await repository.listTrashedAssetIds('ws_lifecycle_a', ['shared_asset'])).toEqual(new Set(['shared_asset']))
      await expect(repository.trash({ workspaceId: 'ws_lifecycle_a', assetId: 'shared_asset', actorId: 'merchant-a', expectedRevision: purged.revision })).rejects.toThrow('ASSET_LIFECYCLE_PURGED')

      const retryAsset = await repository.trash({ workspaceId: 'ws_lifecycle_a', assetId: 'early_purge_retry', actorId: 'merchant-a', now: new Date().toISOString() })
      const retryRequest = await repository.requestEarlyPurge({ workspaceId: 'ws_lifecycle_a', assetId: 'early_purge_retry', actorId: 'merchant-a', reason: '商家确认提前删除', expectedRevision: retryAsset.revision })
      const [leaseClaim] = await repository.claimExpired({ workspaceId: 'ws_lifecycle_a', workerId: 'asset-cleaner' })
      expect(leaseClaim?.assetId).toBe('early_purge_retry')
      const leaseLocked = await database.connect()
      await leaseLocked.query('BEGIN')
      await leaseLocked.query("SELECT set_config('app.workspace_id','ws_lifecycle_a',true)")
      await leaseLocked.query(`SELECT asset_id FROM merchant_asset_lifecycle WHERE workspace_id='ws_lifecycle_a' AND asset_id='early_purge_retry' FOR UPDATE`)
      let purgeWorkStarted = false
      const concurrentPurge = repository.withPurgeLease({ workspaceId: 'ws_lifecycle_a', assetId: 'early_purge_retry', leaseToken: leaseClaim!.leaseToken }, async () => { purgeWorkStarted = true })
      await waitForLockWait(database, 1)
      expect(purgeWorkStarted).toBe(false)
      await leaseLocked.query('COMMIT')
      leaseLocked.release()
      await concurrentPurge
      expect(purgeWorkStarted).toBe(true)
      expect(retryRequest).toMatchObject({ purgeRequestedBy: 'merchant-a', purgeRequestReason: '商家确认提前删除', revision: retryAsset.revision + 1 })
      expect(await repository.listTrash('ws_lifecycle_a')).toMatchObject({ items: [expect.objectContaining({ assetId: 'early_purge_retry', purgeRequestedAt: expect.any(String) })] })
      const retryClaim = leaseClaim
      expect(retryClaim).toMatchObject({ assetId: 'early_purge_retry', leaseToken: expect.any(String) })
      await repository.failPurge({ workspaceId: 'ws_lifecycle_a', assetId: 'early_purge_retry', workerId: 'asset-cleaner', leaseToken: retryClaim!.leaseToken, error: { code: 'ASSET_OBJECT_STILL_REFERENCED' } })
      expect(await repository.listTrash('ws_lifecycle_a')).toMatchObject({ items: [expect.objectContaining({ assetId: 'early_purge_retry', purgeError: { code: 'ASSET_OBJECT_STILL_REFERENCED' } })] })
      const cancelRequest = await repository.cancelEarlyPurge({ workspaceId: 'ws_lifecycle_a', assetId: 'early_purge_retry', actorId: 'merchant-a', expectedRevision: retryRequest.revision })
      expect(cancelRequest).toMatchObject({ revision: retryRequest.revision + 1 })
      expect(cancelRequest).not.toHaveProperty('purgeRequestedAt')
      expect(cancelRequest).not.toHaveProperty('purgeRequestReason')
      await repository.restore({ workspaceId: 'ws_lifecycle_a', assetId: 'early_purge_retry', actorId: 'merchant-a', expectedRevision: cancelRequest.revision })

      const immediateAsset = await repository.trash({ workspaceId: 'ws_lifecycle_a', assetId: 'early_purge_success', actorId: 'merchant-a' })
      const immediateRequest = await repository.requestEarlyPurge({ workspaceId: 'ws_lifecycle_a', assetId: 'early_purge_success', actorId: 'merchant-a', reason: '商家确认提前删除', expectedRevision: immediateAsset.revision })
      const [immediateClaim] = await repository.claimExpired({ workspaceId: 'ws_lifecycle_a', workerId: 'asset-cleaner' })
      expect(immediateClaim).toMatchObject({ assetId: 'early_purge_success' })
      const immediatePurge = await repository.completePurge({ workspaceId: 'ws_lifecycle_a', assetId: 'early_purge_success', workerId: 'asset-cleaner', leaseToken: immediateClaim!.leaseToken })
      expect(immediatePurge.purgedAt).toEqual(expect.any(String))
      expect(immediatePurge.revision).toBe(immediateRequest.revision + 1)
      await database.query(`DELETE FROM merchant_asset_lifecycle WHERE workspace_id='ws_lifecycle_a' AND asset_id='early_purge_success'`)
      await database.query(`DELETE FROM business_entity_snapshots WHERE workspace_id='ws_lifecycle_a' AND entity_type='asset' AND entity_id='early_purge_success'`)

      // Exercise the bind/trash lock order with real transactions. Binding
      // first commits before first-time trashing; purge lease row locking is
      // separately asserted above while competing cleanup workers serialize.
      const concurrencyAssets = [
        { assetId: 'bind_first_asset', productId: 'bind_first_product', remoteId: 'bind-first-remote' },
        { assetId: 'claim_first_asset', productId: 'claim_first_product', remoteId: 'claim-first-remote' },
      ]
      for (const item of concurrencyAssets) {
        await database.query(`INSERT INTO business_entity_snapshots(workspace_id,entity_type,entity_id,entity_version,payload)
          VALUES ('ws_lifecycle_a','asset',$1,1,$2::jsonb)`, [item.assetId, JSON.stringify({ id: item.assetId, workspaceId: 'ws_lifecycle_a', storageKey: `assets/ws_lifecycle_a/${item.assetId}`, mimeType: 'image/png' })])
        await database.query(`INSERT INTO products(id,workspace_id,platform,remote_product_id,title,source)
          VALUES ($1,'ws_lifecycle_a','jd',$2,$1,'fixture')`, [item.productId, item.remoteId])
        await database.query(`INSERT INTO business_entity_snapshots(workspace_id,entity_type,entity_id,entity_version,payload)
          VALUES ('ws_lifecycle_a','product',$1,1,$2::jsonb)`, [item.productId, JSON.stringify({ id: item.productId, workspaceId: 'ws_lifecycle_a', sourceAssetIds: [] })])
      }
      const bindInput = (assetId: string, productId: string) => ({ workspaceId: 'ws_lifecycle_a', assetId, productId, brandId: 'brand_lifecycle_test', assetRole: 'source' as const, expectedVersion: 1, actorId: 'merchant-a', reason: '并发清理回归测试' })

      // In bind-first ordering, let the entire binding transaction commit
      // before trash begins. A separate competing transaction would be blocked
      // by the shared asset row until the binding commits, then trash must see
      // the committed active reference during its later purge eligibility scan.
      await expect(business.bindProductAsset(bindInput('bind_first_asset', 'bind_first_product'))).resolves.toMatchObject({ assetId: 'bind_first_asset', status: 'active' })
      await expect(repository.trash({ workspaceId: 'ws_lifecycle_a', assetId: 'bind_first_asset', actorId: 'merchant-a' })).resolves.toMatchObject({ assetId: 'bind_first_asset', deletedBy: 'merchant-a' })
      await expect(business.listProductAssetBindings('ws_lifecycle_a', { assetId: 'bind_first_asset', status: 'active' })).resolves.toHaveLength(1)

      await repository.trash({ workspaceId: 'ws_lifecycle_a', assetId: 'claim_first_asset', actorId: 'merchant-a' })
      await expect(business.bindProductAsset(bindInput('claim_first_asset', 'claim_first_product'))).rejects.toThrow('ASSET_LIFECYCLE_ASSET_NOT_ACTIVE')
      await expect(business.listProductAssetBindings('ws_lifecycle_a', { assetId: 'claim_first_asset', status: 'active' })).resolves.toHaveLength(0)

      const events = await repository.listEvents('ws_lifecycle_a', 'shared_asset')
      expect(events.map(event => event.eventType).sort()).toEqual(['deleted', 'deleted', 'purge_claimed', 'purge_claimed', 'purged', 'restored'].sort())
      expect((await repository.listEvents('ws_lifecycle_b', 'shared_asset')).map(event => event.eventType)).toEqual(['deleted'])
      expect((await repository.listEvents('ws_lifecycle_a', 'early_purge_retry')).map(event => event.eventType)).toEqual(['deleted', 'early_purge_requested', 'purge_claimed', 'purge_failed', 'purge_request_cancelled', 'restored'])
      expect((await repository.listEvents('ws_lifecycle_a', 'early_purge_success')).map(event => event.eventType)).toEqual(['deleted', 'early_purge_requested', 'purge_claimed', 'purged'])
      await expect(database.query(`UPDATE merchant_asset_lifecycle_events SET actor_id='rewritten' WHERE workspace_id='ws_lifecycle_a' AND asset_id='shared_asset'`)).rejects.toThrow(/append-only/u)
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await app?.end()
        await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [() => admin.end()])
    }
  }, 240_000)
})
