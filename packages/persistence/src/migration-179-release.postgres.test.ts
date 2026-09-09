import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? process.env.BRAND_CANONICAL_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('persistence migration 179 campaign item task scope integrity', () => {
  postgresIt('rejects a task link from another campaign item and allows the exact cold-start link', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_179_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const databaseUrl = new URL(base); databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query(`
        INSERT INTO workspaces (id,status) VALUES ('ws_179','active');
        INSERT INTO platform_accounts (id,workspace_id,platform,remote_account_id,credential_ref,token_state)
        VALUES ('acct_179','ws_179','taobao','remote_179','secret://179','connected');
        INSERT INTO brands (id,workspace_id,name) VALUES ('brand_179','ws_179','Brand 179');
        INSERT INTO brand_store_bindings (workspace_id,brand_id,platform,platform_account_id)
        VALUES ('ws_179','brand_179','taobao','acct_179');
        INSERT INTO products (id,workspace_id,platform,platform_account_id,title,source,data)
        VALUES ('legacy_179','ws_179','taobao','acct_179','Legacy 179','fixture','{"brandId":"brand_179"}');
        INSERT INTO canonical_products (id,workspace_id,brand_id,title,legacy_product_id)
        VALUES ('canonical_179','ws_179','brand_179','Canonical 179','legacy_179');
        INSERT INTO product_listings (id,workspace_id,brand_id,canonical_product_id,platform,platform_account_id)
        VALUES ('listing_179','ws_179','brand_179','canonical_179','taobao','acct_179');
        INSERT INTO batch_campaigns (id,workspace_id,idempotency_key,manifest_hash,created_by,data)
        VALUES ('campaign_179','ws_179','idem_179',repeat('a',64),'test','{"brandId":"brand_179","platform":"taobao","accountId":"acct_179","productIds":["legacy_179"]}');
        INSERT INTO batch_campaign_items (id,workspace_id,campaign_id,brand_id,canonical_product_id,listing_id,legacy_product_id,platform,platform_account_id)
        VALUES ('item_179','ws_179','campaign_179','brand_179','canonical_179','listing_179','legacy_179','taobao','acct_179');
        INSERT INTO tasks (id,workspace_id,product_id,platform,platform_account_id,state,brand_id,canonical_product_id,listing_id,campaign_id,campaign_item_id)
        VALUES ('task_179','ws_179','legacy_179','taobao','acct_179','generating','brand_179','canonical_179','listing_179','campaign_179','item_179');
      `)

      await expect(database.query(`UPDATE batch_campaign_items SET task_id='task_179' WHERE workspace_id='ws_179' AND campaign_id='campaign_179' AND id='item_179'`))
        .resolves.toMatchObject({ rowCount: 1 })

      await expect(database.query(`INSERT INTO batch_campaign_items (id,workspace_id,campaign_id,brand_id,canonical_product_id,listing_id,legacy_product_id,platform,platform_account_id,task_id)
        VALUES ('item_179_bad','ws_179','campaign_179','brand_179','canonical_179','listing_179','legacy_179','taobao','acct_179','task_179')`))
        .rejects.toMatchObject({ code: '23514' })

      await expect(database.query(`SELECT item.task_id, task.campaign_item_id
        FROM batch_campaign_items item JOIN tasks task ON task.workspace_id=item.workspace_id AND task.id=item.task_id
        WHERE item.workspace_id='ws_179' AND item.id='item_179'`)).resolves.toMatchObject({ rows: [{ task_id: 'task_179', campaign_item_id: 'item_179' }] })
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
