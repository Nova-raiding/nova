import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { canonicalProductIdFor, runCanonicalProductBackfill } from './canonical-product-backfill.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'

const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('canonical product backfill PostgreSQL replay contract', () => {
  it('keeps dry-runs side-effect free and replays bounded batches idempotently', async () => {
    const base = new URL(databaseUrlValue)
    const databaseName = `probe_canonical_backfill_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])

      await database.query('GRANT SELECT, UPDATE ON products TO merchant_app')
      await database.query('GRANT SELECT, INSERT ON canonical_products TO merchant_app')

      await database.query(`
        INSERT INTO workspaces (id, status)
        VALUES ('ws_backfill_probe', 'active')
      `)
      await database.query(`
        INSERT INTO platform_accounts
          (id, workspace_id, platform, remote_account_id, credential_ref, token_state)
        VALUES
          ('acct_backfill_probe', 'ws_backfill_probe', 'taobao', 'remote-backfill-probe', 'secret://backfill-probe', 'connected')
      `)
      await database.query(`
        INSERT INTO brands (id, workspace_id, name)
        VALUES ('brand_backfill_probe', 'ws_backfill_probe', 'Backfill Probe Brand')
      `)
      await database.query(`
        INSERT INTO products
          (id, workspace_id, platform, platform_account_id, remote_product_id, title, source, data)
        VALUES
          ('legacy_001', 'ws_backfill_probe', 'taobao', 'acct_backfill_probe', 'remote-001', 'Legacy Product 1', 'official_api', '{"brandId":"brand_backfill_probe"}'),
          ('legacy_002', 'ws_backfill_probe', 'taobao', 'acct_backfill_probe', 'remote-002', 'Legacy Product 2', 'official_api', '{"brandId":"brand_backfill_probe"}'),
          ('legacy_003', 'ws_backfill_probe', 'taobao', 'acct_backfill_probe', 'remote-003', 'Legacy Product 3', 'official_api', '{"brandId":"brand_backfill_probe"}')
      `)

      app = new Pool({
        connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'),
        max: 1,
      })

      const preview = await runCanonicalProductBackfill(app, {
        workspaceId: 'ws_backfill_probe',
        dryRun: true,
        limit: 2,
      })
      expect(preview).toMatchObject({
        dryRun: true,
        insertedIds: [],
        nextProductId: 'legacy_002',
        creates: [
          { legacyProductId: 'legacy_001' },
          { legacyProductId: 'legacy_002' },
        ],
      })
      expect((await database.query<{ count: number }>('SELECT count(*)::int AS count FROM canonical_products WHERE workspace_id=$1', ['ws_backfill_probe'])).rows[0]?.count).toBe(0)

      const firstApply = await runCanonicalProductBackfill(app, {
        workspaceId: 'ws_backfill_probe',
        limit: 2,
      })
      expect(firstApply).toMatchObject({
        dryRun: false,
        nextProductId: 'legacy_002',
        insertedIds: [
          canonicalProductIdFor('ws_backfill_probe', 'legacy_001', 'brand_backfill_probe'),
          canonicalProductIdFor('ws_backfill_probe', 'legacy_002', 'brand_backfill_probe'),
        ],
        unchanged: ['legacy_001', 'legacy_002'],
      })
      expect((await database.query<{ count: number }>('SELECT count(*)::int AS count FROM canonical_products WHERE workspace_id=$1', ['ws_backfill_probe'])).rows[0]?.count).toBe(2)

      const replay = await runCanonicalProductBackfill(app, {
        workspaceId: 'ws_backfill_probe',
        limit: 2,
      })
      expect(replay).toMatchObject({
        dryRun: false,
        insertedIds: [],
        nextProductId: 'legacy_002',
        unchanged: ['legacy_001', 'legacy_002'],
      })
      expect((await database.query<{ count: number }>('SELECT count(*)::int AS count FROM canonical_products WHERE workspace_id=$1', ['ws_backfill_probe'])).rows[0]?.count).toBe(2)

      const resumed = await runCanonicalProductBackfill(app, {
        workspaceId: 'ws_backfill_probe',
        afterProductId: preview.nextProductId,
        limit: 2,
      })
      expect(resumed).toMatchObject({
        dryRun: false,
        insertedIds: [canonicalProductIdFor('ws_backfill_probe', 'legacy_003', 'brand_backfill_probe')],
        unchanged: ['legacy_003'],
      })
      expect(resumed.nextProductId).toBeUndefined()
      expect((await database.query<{ count: number }>('SELECT count(*)::int AS count FROM canonical_products WHERE workspace_id=$1', ['ws_backfill_probe'])).rows[0]?.count).toBe(3)

      const resumedReplay = await runCanonicalProductBackfill(app, {
        workspaceId: 'ws_backfill_probe',
        afterProductId: preview.nextProductId,
        limit: 2,
      })
      expect(resumedReplay).toMatchObject({
        dryRun: false,
        insertedIds: [],
        unchanged: ['legacy_003'],
      })
      expect(resumedReplay.nextProductId).toBeUndefined()
    } finally {
      await app?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
