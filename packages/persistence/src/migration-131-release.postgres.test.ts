import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? process.env.BRAND_CANONICAL_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('persistence migration 131 task campaign item scope', () => {
  postgresIt('rejects a task whose campaign item scope differs from its canonical execution scope', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_131_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const databaseUrl = new URL(base); databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query(`
        INSERT INTO workspaces (id,status) VALUES ('ws_131','active');
        INSERT INTO platform_accounts (id,workspace_id,platform,remote_account_id,credential_ref,token_state)
        VALUES ('acct_131','ws_131','taobao','remote_131','secret://131','connected');
        INSERT INTO brands (id,workspace_id,name) VALUES ('brand_131','ws_131','Brand 131');
        INSERT INTO brand_store_bindings (workspace_id,brand_id,platform,platform_account_id)
        VALUES ('ws_131','brand_131','taobao','acct_131');
        INSERT INTO products (id,workspace_id,platform,platform_account_id,title,source,data)
        VALUES ('legacy_131','ws_131','taobao','acct_131','Legacy 131','fixture','{"brandId":"brand_131"}');
        INSERT INTO canonical_products (id,workspace_id,brand_id,title,legacy_product_id)
        VALUES ('canonical_131','ws_131','brand_131','Canonical 131','legacy_131');
        INSERT INTO product_listings (id,workspace_id,brand_id,canonical_product_id,platform,platform_account_id)
        VALUES ('listing_131','ws_131','brand_131','canonical_131','taobao','acct_131');
        INSERT INTO batch_campaigns (id,workspace_id,idempotency_key,manifest_hash,created_by)
        VALUES ('campaign_131','ws_131','idem_131',repeat('a',64),'test');
        INSERT INTO batch_campaign_items (id,workspace_id,campaign_id,brand_id,canonical_product_id,listing_id,legacy_product_id,platform,platform_account_id,ordinal)
        VALUES ('item_131','ws_131','campaign_131','brand_131','canonical_131','listing_131','legacy_131','taobao','acct_131',1);
      `)

      await expect(database.query(`
        INSERT INTO tasks (id,workspace_id,product_id,platform,platform_account_id,state,brand_id,canonical_product_id,listing_id,campaign_id,campaign_item_id)
        VALUES ('task_131_bad','ws_131','legacy_131','taobao','acct_131','draft','brand_131','canonical_131',NULL,'campaign_131','item_131')
      `)).rejects.toMatchObject({ code: '23514' })

      await expect(database.query(`
        INSERT INTO tasks (id,workspace_id,product_id,platform,platform_account_id,state,brand_id,canonical_product_id,listing_id,campaign_id,campaign_item_id)
        VALUES ('task_131_ok','ws_131','legacy_131','taobao','acct_131','draft','brand_131','canonical_131','listing_131','campaign_131','item_131')
      `)).resolves.toMatchObject({ rowCount: 1 })
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
