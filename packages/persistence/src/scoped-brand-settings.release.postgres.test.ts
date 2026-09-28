import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { parseScopedBrandSettings } from '../../application/src/scoped-brand-settings.js'
import { loadMigrations, MigrationRunner, verifyAppliedMigrations, verifyBridgeMigrationPrefix } from './migration.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { PostgresScopedBrandSettingsRepository, ScopedBrandRevisionConflictError } from './scoped-brand-settings-repository.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip
const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('scoped brand PostgreSQL release evidence', () => {
  postgresIt('keeps all four scopes durable, tenant-isolated and revision protected', async () => {
    const base = new URL(databaseUrl!)
    const databaseName = `brand_profile_assoc_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      const previousRelease = migrations.slice(0, 254)
      expect(previousRelease.at(-1)?.version).toBe(254)
      expect(migrations.at(-1)?.version).toBe(255)
      expect(await new MigrationRunner(database, previousRelease).run()).toEqual(previousRelease.map(item => item.version))
      expect((await database.query<{ version: number }>('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.version).toBe(254)
      const previousRows = await database.query<{ version: number; name: string; checksum: string }>('SELECT version,name,checksum FROM schema_migrations ORDER BY version')
      expect(verifyBridgeMigrationPrefix(previousRows.rows, migrations, 'prefix_254_or_255')).toBe(254)
      expect(await new MigrationRunner(database, migrations).run()).toEqual([255])
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])
      const applied = await database.query<{ version: number; name: string; checksum: string }>('SELECT version,name,checksum FROM schema_migrations ORDER BY version')
      expect(verifyBridgeMigrationPrefix(applied.rows, migrations, 'prefix_254_or_255')).toBe(255)
      expect(() => verifyAppliedMigrations(applied.rows, previousRelease)).toThrowError(expect.objectContaining({ code: 'MIGRATION_VERSION_UNKNOWN', version: 255 }))
      // A fresh migration database has not run the post-migration runtime ACL
      // normalization. Grant only the backing reads and row locks exercised by
      // this repository; tenant RLS remains forced on both tables.
      await database.query('GRANT SELECT, UPDATE ON business_entity_snapshots, platform_accounts TO merchant_app')
      await database.query("INSERT INTO workspaces(id,status) VALUES ('brand_alpha','active'),('brand_beta','active')")
      await database.query(`INSERT INTO platform_accounts(id,workspace_id,platform,remote_account_id,credential_ref,token_state)
        VALUES ('store_alpha','brand_alpha','jd','remote-alpha','fixture://alpha','connected'),
               ('store_beta','brand_beta','jd','remote-beta','fixture://beta','connected')`)
      for (const workspaceId of ['brand_alpha', 'brand_beta']) {
        await database.query(`INSERT INTO business_entity_snapshots(workspace_id,entity_type,entity_id,entity_version,payload)
          VALUES ($1,'asset','shared_image',1,$2::jsonb)`, [workspaceId, JSON.stringify({ id: 'shared_image', workspaceId, mimeType: 'image/png', scanStatus: 'quarantined', rightsStatus: 'pending', parseStatus: 'pending' })])
      }
      const approvedAssetId = 'approved_logo'
      const quarantineKey = `quarantine/brand_alpha/${approvedAssetId}/source.png`
      const receipt = {
        schema_version: 'asset-scan-receipt/1.0', receipt_id: `receipt_${approvedAssetId}`,
        subject: { workspace_id: 'brand_alpha', asset_id: approvedAssetId, asset_source_revision: 1, object_key: quarantineKey, sha256: 'a'.repeat(64), size_bytes: 4, mime_type: 'image/png' },
        scan: { verdict: 'clean' },
      }
      await database.query(`INSERT INTO asset_scan_receipts
        (receipt_id,workspace_id,asset_id,asset_source_revision,receipt_digest,signature,verdict,object_key,object_sha256,canonical_payload,receipt)
        VALUES ($1,'brand_alpha',$2,1,$3,'fixture-signature','clean',$4,$5,$6::text,$6::jsonb)`, [receipt.receipt_id, approvedAssetId, 'b'.repeat(64), quarantineKey, 'a'.repeat(64), JSON.stringify(receipt)])
      await database.query(`INSERT INTO business_entity_snapshots(workspace_id,entity_type,entity_id,entity_version,payload)
        VALUES ('brand_alpha','asset',$1,1,$2::jsonb)`, [approvedAssetId, JSON.stringify({
        id: approvedAssetId, workspaceId: 'brand_alpha', mimeType: 'image/png', sha256: 'a'.repeat(64), sizeBytes: 4, sourceRevision: 1,
        storageKey: `clean/brand_alpha/${approvedAssetId}/source.png`, scanStatus: 'clean', scanVerdict: 'clean', scanReceiptId: receipt.receipt_id, scanReceiptDigest: 'b'.repeat(64),
        rightsStatus: 'approved', rightsScope: 'owned', parseStatus: 'succeeded', factsConfirmedBy: 'merchant-owner', factsConfirmedAt: '2026-09-28T00:00:00.000Z',
      })])
      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 2 })
      const repository = new PostgresScopedBrandSettingsRepository(app)

      const series = await repository.createSeries({ workspaceId: 'brand_alpha', accountId: 'store_alpha', name: '秋冬系列' })
      expect(series).toMatchObject({ accountId: 'store_alpha', name: '秋冬系列', revision: 1 })
      expect(await repository.listSeries('brand_alpha', 'store_alpha')).toEqual([series])
      expect(await repository.listSeries('brand_beta', 'store_beta')).toEqual([])
      const assignment = await repository.assignAsset({ workspaceId: 'brand_alpha', assetId: 'shared_image', accountId: 'store_alpha', seriesId: series.id, expectedRevision: 0 })
      expect(assignment).toMatchObject({ assetId: 'shared_image', accountId: 'store_alpha', seriesId: series.id, revision: 1 })
      await expect(repository.assignAsset({ workspaceId: 'brand_alpha', assetId: 'shared_image', accountId: 'store_alpha', seriesId: series.id, expectedRevision: 0 })).rejects.toThrow()

      const candidate = { schemaVersion: 1,
        global: { enabled: true, values: { color: '#aabbcc', persona: '全局受众' } },
        stores: { store_alpha: { enabled: true, values: { persona: '店铺受众' } } },
        series: { store_alpha: { [series.id]: { enabled: true, values: { sellingPoints: '系列卖点' } } } },
        images: { shared_image: { enabled: true, values: { color: '#112233' } } },
      }
      const save = (workspaceId: string, settings: unknown, expectedRevision: number) => repository.save({ workspaceId, settings, expectedRevision, actorId: 'merchant-owner', validate: parseScopedBrandSettings })
      const first = await save('brand_alpha', candidate, 0)
      expect(first.revision).toBe(1)
      expect(await repository.get('brand_alpha')).toMatchObject({ settings: candidate, revision: 1 })
      await expect(save('brand_alpha', candidate, 0)).rejects.toBeInstanceOf(ScopedBrandRevisionConflictError)
      const second = await save('brand_alpha', { ...candidate, global: { enabled: false, values: {} } }, 1)
      expect(second.revision).toBe(2)
      const approved = await save('brand_alpha', { ...candidate, global: { enabled: true, values: { logoAssetId: approvedAssetId } } }, 2)
      expect(approved).toMatchObject({ revision: 3, settings: { global: { values: { logoAssetId: approvedAssetId } } } })
      await expect(save('brand_alpha', candidate, 1)).rejects.toBeInstanceOf(ScopedBrandRevisionConflictError)
      await database.query(`INSERT INTO platform_accounts(id,workspace_id,platform,remote_account_id,credential_ref,token_state)
        VALUES ('store_other','brand_alpha','jd','remote-other','fixture://other','connected')`)
      await repository.assignAsset({ workspaceId: 'brand_alpha', assetId: approvedAssetId, accountId: 'store_other', expectedRevision: 0 })
      await expect(repository.resolveForTask({ workspaceId: 'brand_alpha', accountId: 'store_alpha', selectedAssetIds: ['shared_image', approvedAssetId], validate: parseScopedBrandSettings }))
        .rejects.toMatchObject({ code: 'BRAND_SCOPE_STORE_MISMATCH' })
      const singleImage = await repository.resolveForTask({ workspaceId: 'brand_alpha', accountId: 'store_alpha', selectedAssetIds: ['shared_image'], validate: parseScopedBrandSettings })
      expect(singleImage?.context).toMatchObject({ accountId: 'store_alpha', seriesKey: series.id, assetId: 'shared_image' })
      await expect(repository.get('brand_beta')).resolves.toBeUndefined()
      await expect(save('brand_beta', candidate, 0)).rejects.toThrow(/店铺不存在/)
      await expect(save('brand_alpha', { schemaVersion: 1, global: { enabled: true, values: { logoAssetId: 'shared_image' } } }, 3)).rejects.toThrow(/尚未通过扫描/)
      await expect(repository.assignAsset({ workspaceId: 'brand_beta', assetId: 'shared_image', accountId: 'store_alpha', expectedRevision: 0 })).rejects.toMatchObject({ code: '23503' })

      const client = await app.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT set_config('app.workspace_id','brand_beta',true)")
        await expect(client.query(`INSERT INTO merchant_brand_scoped_settings(workspace_id,settings,updated_by_actor_id)
          VALUES ('brand_alpha','{"schemaVersion":1}'::jsonb,'forged')`)).rejects.toMatchObject({ code: '42501' })
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
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
