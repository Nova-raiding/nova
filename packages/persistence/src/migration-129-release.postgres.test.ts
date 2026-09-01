import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresBrandUnitRepository } from './brand-unit-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? process.env.BRAND_CANONICAL_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('persistence migration 129 campaign item listing scope', () => {
  postgresIt('rejects missing or cross-scope listings while preserving legacy-only rows', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_129_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const databaseUrl = new URL(base); databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('ws_129','active')`)
      await database.query(`INSERT INTO platform_accounts (id,workspace_id,platform,remote_account_id,credential_ref,token_state) VALUES ('acct_129','ws_129','taobao','remote_129','secret://129','connected')`)
      await database.query(`INSERT INTO brands (id,workspace_id,name) VALUES ('brand_129','ws_129','Brand 129')`)
      await database.query(`INSERT INTO brand_store_bindings (workspace_id,brand_id,platform,platform_account_id) VALUES ('ws_129','brand_129','taobao','acct_129')`)
      await database.query(`INSERT INTO canonical_products (id,workspace_id,brand_id,title) VALUES ('canonical_129','ws_129','brand_129','Canonical 129')`)
      await database.query(`INSERT INTO product_listings (id,workspace_id,brand_id,canonical_product_id,platform,platform_account_id) VALUES ('listing_129','ws_129','brand_129','canonical_129','taobao','acct_129')`)
      await database.query(`INSERT INTO batch_campaigns (id,workspace_id,idempotency_key,manifest_hash,created_by) VALUES ('campaign_129','ws_129','idem_129',repeat('a',64),'test')`)
      const repository = new PostgresBrandUnitRepository(database)
      await expect(repository.createCampaign({ id: 'campaign_129_repo_bad', workspaceId: 'ws_129', brandId: 'brand_129', platform: 'jd', accountId: 'acct_129', productIds: ['legacy_129'], targets: [{ productId: 'legacy_129', canonicalProductId: 'canonical_129', listingId: 'listing_129', platform: 'jd', accountId: 'acct_129' }], state: 'draft' })).rejects.toThrow('CAMPAIGN_ITEM_LISTING_SCOPE_INVALID')
      await expect(database.query(`INSERT INTO batch_campaign_items (id,workspace_id,campaign_id,brand_id,canonical_product_id,listing_id,platform,platform_account_id,ordinal) VALUES ('item_129_missing','ws_129','campaign_129','brand_129','canonical_129',NULL,'taobao','acct_129',1)`)).rejects.toMatchObject({ code: '23514' })
      await expect(database.query(`INSERT INTO batch_campaign_items (id,workspace_id,campaign_id,brand_id,canonical_product_id,listing_id,platform,platform_account_id,ordinal) VALUES ('item_129_scope','ws_129','campaign_129','brand_129','canonical_129','listing_129','jd','acct_129',2)`)).rejects.toMatchObject({ code: '23514' })
      await expect(database.query(`INSERT INTO batch_campaign_items (id,workspace_id,campaign_id,brand_id,canonical_product_id,listing_id,platform,platform_account_id,ordinal) VALUES ('item_129_ok','ws_129','campaign_129','brand_129','canonical_129','listing_129','taobao','acct_129',3)`)).resolves.toMatchObject({ rowCount: 1 })
      await expect(database.query(`INSERT INTO batch_campaign_items (id,workspace_id,campaign_id,brand_id,legacy_product_id,platform,platform_account_id,ordinal) VALUES ('item_129_legacy','ws_129','campaign_129','brand_129','missing_legacy','taobao','acct_129',4)`)).rejects.toMatchObject({ code: '23503' })
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
