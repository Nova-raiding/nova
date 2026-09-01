import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? process.env.BRAND_CANONICAL_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('persistence migration 137 task canonical listing identity', () => {
  postgresIt('rejects partial or cross-identity canonical tasks while preserving legacy-only tasks', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_137_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const databaseUrl = new URL(base); databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query(`
        INSERT INTO workspaces (id,status) VALUES ('ws_137','active');
        INSERT INTO platform_accounts (id,workspace_id,platform,remote_account_id,credential_ref,token_state)
        VALUES ('acct_137','ws_137','taobao','remote_137','secret://137','connected');
        INSERT INTO brands (id,workspace_id,name) VALUES ('brand_137','ws_137','Brand 137');
        INSERT INTO brand_store_bindings (workspace_id,brand_id,platform,platform_account_id)
        VALUES ('ws_137','brand_137','taobao','acct_137');
        INSERT INTO products (id,workspace_id,platform,platform_account_id,title,source,data)
        VALUES ('legacy_137','ws_137','taobao','acct_137','Legacy 137','fixture','{"brandId":"brand_137"}');
        INSERT INTO canonical_products (id,workspace_id,brand_id,title,legacy_product_id)
        VALUES ('canonical_137','ws_137','brand_137','Canonical 137','legacy_137');
        INSERT INTO product_listings (id,workspace_id,brand_id,canonical_product_id,platform,platform_account_id)
        VALUES ('listing_137','ws_137','brand_137','canonical_137','taobao','acct_137');
      `)

      await expect(database.query(`
        INSERT INTO tasks (id,workspace_id,product_id,platform,platform_account_id,state,brand_id,canonical_product_id)
        VALUES ('task_137_partial','ws_137','legacy_137','taobao','acct_137','publish_prepared','brand_137','canonical_137')
      `)).rejects.toMatchObject({ code: '23514' })

      await expect(database.query(`
        INSERT INTO tasks (id,workspace_id,product_id,platform,platform_account_id,state,brand_id,canonical_product_id,listing_id)
        VALUES ('task_137_bad','ws_137','other_legacy','taobao','acct_137','publish_prepared','brand_137','canonical_137','listing_137')
      `)).rejects.toMatchObject({ code: '23514' })

      await expect(database.query(`
        INSERT INTO tasks (id,workspace_id,product_id,platform,platform_account_id,state,brand_id,canonical_product_id,listing_id)
        VALUES ('task_137_ok','ws_137','legacy_137','taobao','acct_137','publish_prepared','brand_137','canonical_137','listing_137')
      `)).resolves.toMatchObject({ rowCount: 1 })

      await expect(database.query(`
        INSERT INTO tasks (id,workspace_id,product_id,platform,state)
        VALUES ('task_137_legacy','ws_137','legacy_137','taobao','draft')
      `)).resolves.toMatchObject({ rowCount: 1 })
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
