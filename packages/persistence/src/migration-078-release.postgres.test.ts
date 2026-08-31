import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseUrl(base: URL, name: string) {
  const result = new URL(base)
  result.pathname = `/${name}`
  return result.toString()
}

async function seedProduct(pool: Pool, workspaceId: string, productId: string, assetIds: string[]) {
  await pool.query(`INSERT INTO workspaces (id,status) VALUES ($1,'active') ON CONFLICT (id) DO NOTHING`, [workspaceId])
  await pool.query(`INSERT INTO products (id,workspace_id,platform,remote_product_id,title,source,version,data)
    VALUES ($1,$2,'taobao',$3,$4,'fixture',1,$5::jsonb)`, [productId, workspaceId, `remote-${productId}`, productId, JSON.stringify({ sourceAssetIds: assetIds })])
}

describe('persistence migration 078 late asset binding acceptance', () => {
  postgresIt('applies fresh and from 077, repairs existing rows, and keeps the trigger workspace-scoped', async () => {
    const base = new URL(databaseUrlValue!)
    const suffix = randomUUID().replaceAll('-', '')
    const freshName = `release_078_fresh_${suffix}`
    const upgradeName = `release_078_upgrade_${suffix}`
    const admin = new Pool({ connectionString: base.toString() })
    let fresh: Pool | undefined
    let upgrade: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${freshName}"`)
      await admin.query(`CREATE DATABASE "${upgradeName}"`)
      fresh = new Pool({ connectionString: databaseUrl(base, freshName) })
      upgrade = new Pool({ connectionString: databaseUrl(base, upgradeName) })
      const migrations = await loadMigrations()
      const until77 = migrations.filter(item => item.version <= 77)
      const until78 = migrations.filter(item => item.version <= 78)

      expect(until78.at(-1)?.version).toBe(78)
      expect(await new MigrationRunner(fresh, until78).run()).toEqual(until78.map(item => item.version))
      expect(await new MigrationRunner(fresh, until78).run()).toEqual([])

      await seedProduct(fresh, 'ws_078_a', 'product_078_late', ['asset_078_shared'])
      await seedProduct(fresh, 'ws_078_b', 'product_078_other', ['asset_078_shared'])
      await fresh.query(`INSERT INTO business_entity_snapshots
        (workspace_id,entity_type,entity_id,entity_version,payload)
        VALUES ('ws_078_b','asset','asset_078_shared',1,'{"id":"asset_078_shared"}'::jsonb)`)
      expect((await fresh.query(`SELECT workspace_id,product_id FROM product_asset_bindings ORDER BY workspace_id`)).rows)
        .toEqual([{ workspace_id: 'ws_078_b', product_id: 'product_078_other' }])
      await fresh.query(`INSERT INTO business_entity_snapshots
        (workspace_id,entity_type,entity_id,entity_version,payload)
        VALUES ('ws_078_a','asset','asset_078_shared',1,'{"id":"asset_078_shared"}'::jsonb)`)
      expect((await fresh.query(`SELECT workspace_id,product_id FROM product_asset_bindings ORDER BY workspace_id`)).rows)
        .toEqual([
          { workspace_id: 'ws_078_a', product_id: 'product_078_late' },
          { workspace_id: 'ws_078_b', product_id: 'product_078_other' },
        ])

      expect(await new MigrationRunner(upgrade, until77).run()).toEqual(until77.map(item => item.version))
      await seedProduct(upgrade, 'ws_078_upgrade', 'product_078_upgrade', ['asset_078_existing'])
      await upgrade.query(`INSERT INTO business_entity_snapshots
        (workspace_id,entity_type,entity_id,entity_version,payload)
        VALUES ('ws_078_upgrade','asset','asset_078_existing',1,'{"id":"asset_078_existing"}'::jsonb)`)
      expect((await upgrade.query(`SELECT count(*)::int AS count FROM product_asset_bindings`)).rows).toEqual([{ count: 0 }])
      expect(await new MigrationRunner(upgrade, until78).run()).toEqual([78])
      expect(await new MigrationRunner(upgrade, until78).run()).toEqual([])
      expect((await upgrade.query(`SELECT asset_id,status FROM product_asset_bindings`)).rows)
        .toEqual([{ asset_id: 'asset_078_existing', status: 'active' }])
      expect((await upgrade.query(`SELECT count(*)::int AS count,min(version)::int AS min,max(version)::int AS max FROM schema_migrations`)).rows)
        .toEqual([{ count: 78, min: 1, max: 78 }])
    } finally {
      await Promise.all([fresh?.end(), upgrade?.end()])
      for (const name of [freshName, upgradeName]) {
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [name])
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      }
      await admin.end()
    }
  }, 240_000)
})
