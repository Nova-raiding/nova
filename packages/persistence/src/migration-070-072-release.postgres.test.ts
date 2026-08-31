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

async function verifyProductAssetBindingIntegrity(pool: Pool) {
  const schema = await pool.query(`SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'product_asset_bindings'`)
  expect(schema.rows).toEqual([{ table_name: 'product_asset_bindings', relrowsecurity: true, relforcerowsecurity: true }])

  const triggers = await pool.query(`SELECT tgname, pg_get_triggerdef(oid, true) AS definition
    FROM pg_trigger
    WHERE tgrelid = 'product_asset_bindings'::regclass AND NOT tgisinternal
    ORDER BY tgname`)
  expect(triggers.rows).toEqual([
    expect.objectContaining({ tgname: 'product_asset_bindings_asset_validate' }),
  ])
  expect(triggers.rows[0]?.definition).toContain('BEFORE INSERT OR UPDATE OF workspace_id, asset_id')

  const productTrigger = await pool.query(`SELECT pg_get_triggerdef(oid, true) AS definition
    FROM pg_trigger
    WHERE tgrelid = 'products'::regclass AND tgname = 'products_asset_bindings_sync'`)
  expect(productTrigger.rows).toHaveLength(1)
}

describe('persistence migrations 070/072 release acceptance', () => {
  postgresIt('verifies fresh install, 069 upgrade, idempotency, malformed JSON, curated roles, and tenant-safe writes', async () => {
    const base = new URL(databaseUrlValue!)
    const suffix = randomUUID().replaceAll('-', '')
    const freshName = `release_070_072_fresh_${suffix}`
    const upgradeName = `release_070_072_upgrade_${suffix}`
    const admin = new Pool({ connectionString: base.toString() })
    let fresh: Pool | undefined
    let upgrade: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${freshName}"`)
      await admin.query(`CREATE DATABASE "${upgradeName}"`)
      fresh = new Pool({ connectionString: databaseUrl(base, freshName) })
      upgrade = new Pool({ connectionString: databaseUrl(base, upgradeName) })
      const migrations = await loadMigrations()
      const until69 = migrations.filter(item => item.version <= 69)
      const finalMigrations = migrations.filter(item => item.version <= 72)

      expect(await new MigrationRunner(fresh, finalMigrations).run()).toEqual(finalMigrations.map(item => item.version))
      expect(await new MigrationRunner(fresh, finalMigrations).run()).toEqual([])
      await verifyProductAssetBindingIntegrity(fresh)

      expect(await new MigrationRunner(upgrade, until69).run()).toEqual(until69.map(item => item.version))
      await upgrade.query("INSERT INTO workspaces (id,status) VALUES ('ws_070_upgrade','active')")
      await upgrade.query(`INSERT INTO business_entity_snapshots (workspace_id, entity_type, entity_id, entity_version, payload)
        VALUES
          ('ws_070_upgrade','asset','asset_070_valid',1,'{"id":"asset_070_valid","workspaceId":"ws_070_upgrade"}'::jsonb),
          ('ws_070_upgrade','asset','asset_070_curated',1,'{"id":"asset_070_curated","workspaceId":"ws_070_upgrade"}'::jsonb)`)
      await upgrade.query(`INSERT INTO products (id,workspace_id,platform,remote_product_id,title,source,version,data)
        VALUES ('product_070_upgrade','ws_070_upgrade','taobao','remote_070_upgrade','Upgrade','fixture',1,
          '{"sourceAssetIds":["asset_070_valid"]}'::jsonb)`)

      expect(await new MigrationRunner(upgrade, finalMigrations).run()).toEqual([70, 71, 72])
      expect(await new MigrationRunner(upgrade, finalMigrations).run()).toEqual([])
      await verifyProductAssetBindingIntegrity(upgrade)

      const seeded = await upgrade.query(`SELECT asset_id, asset_role, ordinal, status
        FROM product_asset_bindings
        WHERE workspace_id='ws_070_upgrade' AND product_id='product_070_upgrade'
        ORDER BY asset_id`)
      expect(seeded.rows).toEqual([{ asset_id: 'asset_070_valid', asset_role: 'source', ordinal: 1, status: 'active' }])

      await upgrade.query(`INSERT INTO product_asset_bindings (workspace_id,product_id,asset_id,asset_role,ordinal,status)
        VALUES
          ('ws_070_upgrade','product_070_upgrade','asset_070_valid','source',1,'disabled'),
          ('ws_070_upgrade','product_070_upgrade','asset_070_curated','main',1,'active')
        ON CONFLICT (workspace_id,product_id,asset_id,asset_role) DO UPDATE SET status=EXCLUDED.status`)
      await upgrade.query(`UPDATE products SET data='{"sourceAssetIds": {"not": "an array"}}'::jsonb
        WHERE workspace_id='ws_070_upgrade' AND id='product_070_upgrade'`)
      const malformed = await upgrade.query(`SELECT asset_id,asset_role,status
        FROM product_asset_bindings
        WHERE workspace_id='ws_070_upgrade' AND product_id='product_070_upgrade'
        ORDER BY asset_role,asset_id`)
      expect(malformed.rows).toEqual([
        { asset_id: 'asset_070_curated', asset_role: 'main', status: 'active' },
        { asset_id: 'asset_070_valid', asset_role: 'source', status: 'disabled' },
      ])

      await upgrade.query(`UPDATE products SET data='{"sourceAssetIds": []}'::jsonb
        WHERE workspace_id='ws_070_upgrade' AND id='product_070_upgrade'`)
      const preserved = await upgrade.query(`SELECT asset_id,asset_role,status
        FROM product_asset_bindings
        WHERE workspace_id='ws_070_upgrade' AND product_id='product_070_upgrade'
        ORDER BY asset_role,asset_id`)
      expect(preserved.rows).toEqual([
        { asset_id: 'asset_070_curated', asset_role: 'main', status: 'active' },
        { asset_id: 'asset_070_valid', asset_role: 'source', status: 'disabled' },
      ])

      const client = await upgrade.connect()
      try {
        await client.query('BEGIN')
        await client.query("SET LOCAL ROLE merchant_app")
        await client.query("SELECT set_config('app.workspace_id','ws_070_upgrade',true)")
        await expect(client.query(`INSERT INTO product_asset_bindings (workspace_id,product_id,asset_id)
          VALUES ('ws_070_upgrade','product_070_upgrade','asset_070_other_tenant')`)).rejects.toMatchObject({ code: '23503' })
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
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
