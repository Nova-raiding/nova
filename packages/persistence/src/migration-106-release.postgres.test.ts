import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'
const postgresIt = databaseUrlValue ? it : it.skip

const databaseConnection = (base: URL, database: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  return url.toString()
}

describe('canonical legacy brand integrity PostgreSQL boundary', () => {
  postgresIt('keeps canonical and legacy brands aligned on insert and legacy updates', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_canonical_brand_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseConnection(base, databaseName) })
      await new MigrationRunner(database, await loadMigrations()).run()

      await database.query("INSERT INTO workspaces (id,status) VALUES ('ws_canonical_brand','active')")
      await database.query(`INSERT INTO brands (id,workspace_id,name) VALUES
        ('brand_a','ws_canonical_brand','Brand A'), ('brand_b','ws_canonical_brand','Brand B')`)
      await database.query(`INSERT INTO products
        (id,workspace_id,platform,remote_product_id,title,source,data)
        VALUES ('legacy_product','ws_canonical_brand','taobao','remote_product','Product','fixture', $1)`, [{ brandId: 'brand_a' }])

      await expect(database.query(`INSERT INTO canonical_products
        (id,workspace_id,brand_id,title,legacy_product_id)
        VALUES ('canonical_valid','ws_canonical_brand','brand_a','Product','legacy_product')`)).resolves.toMatchObject({ rowCount: 1 })

      await expect(database.query(`INSERT INTO canonical_products
        (id,workspace_id,brand_id,title,legacy_product_id)
        VALUES ('canonical_cross_brand','ws_canonical_brand','brand_b','Product','legacy_product')`)).rejects.toMatchObject({ code: '23514' })

      await expect(database.query(`UPDATE products
        SET data = jsonb_set(data, '{brandId}', '"brand_b"'::jsonb)
        WHERE workspace_id='ws_canonical_brand' AND id='legacy_product'`)).rejects.toMatchObject({ code: '23503' })

      await expect(database.query(`UPDATE canonical_products SET brand_id='brand_b'
        WHERE workspace_id='ws_canonical_brand' AND id='canonical_valid'`)).rejects.toMatchObject({ code: '23514' })
      await expect(database.query(`SELECT brand_id FROM canonical_products
        WHERE workspace_id='ws_canonical_brand' AND id='canonical_valid'`)).resolves.toMatchObject({ rows: [{ brand_id: 'brand_a' }] })
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
