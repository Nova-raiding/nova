import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresBrandUnitRepository } from './brand-unit-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? process.env.BRAND_CANONICAL_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('persistence migration 128 listing identity uniqueness', () => {
  postgresIt('enforces the canonical listing five-tuple across repository instances', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_128_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const databaseUrl = new URL(base)
      databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })
      const migrations = await loadMigrations()
      await new MigrationRunner(database, migrations).run()

      await database.query(`INSERT INTO workspaces (id,status) VALUES ('ws_128','active')`)
      await database.query(`INSERT INTO platform_accounts (id,workspace_id,platform,remote_account_id,credential_ref,token_state)
        VALUES ('acct_128','ws_128','taobao','remote_128','secret://128','connected')`)
      await database.query(`INSERT INTO brands (id,workspace_id,name) VALUES ('brand_128','ws_128','Brand 128')`)
      await database.query(`INSERT INTO brand_store_bindings (workspace_id,brand_id,platform,platform_account_id)
        VALUES ('ws_128','brand_128','taobao','acct_128')`)
      await database.query(`INSERT INTO canonical_products (id,workspace_id,brand_id,title)
        VALUES ('canonical_128','ws_128','brand_128','Canonical 128')`)

      const repository = new PostgresBrandUnitRepository(database)
      await expect(repository.createListing({ workspaceId: 'ws_128', id: 'listing_128_a', brandId: 'brand_128', canonicalProductId: 'canonical_128', platform: 'taobao', accountId: 'acct_128' })).resolves.toMatchObject({ id: 'listing_128_a' })
      await expect(database.query(`INSERT INTO product_listings (id,workspace_id,brand_id,canonical_product_id,platform,platform_account_id)
        VALUES ('listing_128_b','ws_128','brand_128','canonical_128','taobao','acct_128')`)).rejects.toMatchObject({ code: '23505', constraint: 'product_listings_canonical_identity_key' })
      await expect(repository.createListing({ workspaceId: 'ws_128', id: 'listing_128_c', brandId: 'brand_128', canonicalProductId: 'canonical_128', platform: 'taobao', accountId: 'acct_128' })).rejects.toThrow('PRODUCT_LISTING_IDENTITY_CONFLICT')
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
