import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? process.env.BRAND_CANONICAL_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('persistence migration 130 canonical legacy identity uniqueness', () => {
  postgresIt('rejects a second canonical mapping in one workspace but permits the same legacy id in another workspace', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_130_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const databaseUrl = new URL(base)
      databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query(`
        INSERT INTO workspaces (id,status) VALUES ('ws_130_a','active'),('ws_130_b','active');
        INSERT INTO products (id,workspace_id,platform,remote_product_id,title,source,data)
        VALUES ('legacy_130_a','ws_130_a','taobao','remote_130_a','Legacy 130','fixture','{"brandId":"brand_130"}'),
               ('legacy_130_b','ws_130_b','taobao','remote_130_b','Legacy 130','fixture','{"brandId":"brand_130"}');
        INSERT INTO canonical_products (id,workspace_id,brand_id,title,legacy_product_id)
        VALUES ('canonical_130_a','ws_130_a','brand_130','Canonical 130 A','legacy_130_a');
      `)
      await expect(database.query(`INSERT INTO canonical_products (id,workspace_id,brand_id,title,legacy_product_id) VALUES ('canonical_130_duplicate','ws_130_a','brand_130','Duplicate','legacy_130_a')`)).rejects.toMatchObject({ code: '23505' })
      await expect(database.query(`INSERT INTO canonical_products (id,workspace_id,brand_id,title,legacy_product_id) VALUES ('canonical_130_other_workspace','ws_130_b','brand_130','Canonical 130 B','legacy_130_b')`)).resolves.toMatchObject({ rowCount: 1 })
      await expect(database.query(`INSERT INTO canonical_products (id,workspace_id,brand_id,title) VALUES ('canonical_130_native_a','ws_130_a','brand_130','Native A'),('canonical_130_native_b','ws_130_a','brand_130','Native B')`)).resolves.toMatchObject({ rowCount: 2 })
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
