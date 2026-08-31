import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { PostgresBrandUnitRepository } from './brand-unit-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const postgresIt = process.env.BRAND_CANONICAL_DATABASE_URL ? it : it.skip

describe('063 product listing brand/canonical integrity', () => {
  it('adds a validated composite foreign key and refuses to rewrite bad data', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 63)
    const sql = migration?.sql ?? ''

    expect(migration).toMatchObject({ name: 'product_listing_brand_canonical_integrity' })
    expect(sql).toContain('product_listings contains a cross-brand canonical product reference')
    expect(sql).toContain('FOREIGN KEY (workspace_id, brand_id, canonical_product_id)')
    expect(sql).toContain('REFERENCES canonical_products (workspace_id, brand_id, id)')
    expect(sql).toContain('VALIDATE CONSTRAINT product_listings_brand_canonical_fk')
    expect(sql).not.toMatch(/UPDATE\s+product_listings|DELETE\s+FROM\s+product_listings/i)
  })

  postgresIt('rejects existing and new cross-brand combinations on real PostgreSQL', async () => {
    const adminUrl = new URL(process.env.BRAND_CANONICAL_DATABASE_URL!)
    const databaseName = `brand_canonical_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: adminUrl.toString() })
    let database: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const databaseUrl = new URL(adminUrl)
      databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })
      const migrations = await loadMigrations()
      await new MigrationRunner(database, migrations.filter(item => item.version <= 62)).run()

      await database.query(`INSERT INTO workspaces (id, status) VALUES ('ws_shared', 'active')`)
      await database.query(`INSERT INTO platform_accounts (id, workspace_id, platform, remote_account_id, credential_ref, token_state)
        VALUES ('acct_shared', 'ws_shared', 'taobao', 'remote_shared', 'secret://shared', 'connected')`)
      await database.query(`INSERT INTO brands (id, workspace_id, name)
        VALUES ('brand_a', 'ws_shared', 'Brand A'), ('brand_b', 'ws_shared', 'Brand B')`)
      await database.query(`INSERT INTO brand_store_bindings (workspace_id, brand_id, platform, platform_account_id)
        VALUES ('ws_shared', 'brand_b', 'taobao', 'acct_shared')`)
      await database.query(`INSERT INTO canonical_products (id, workspace_id, brand_id, title)
        VALUES ('canonical_a', 'ws_shared', 'brand_a', 'Canonical A'), ('canonical_b', 'ws_shared', 'brand_b', 'Canonical B')`)

      await database.query(`INSERT INTO product_listings (id, workspace_id, brand_id, canonical_product_id, platform, platform_account_id)
        VALUES ('listing_legacy_bad', 'ws_shared', 'brand_b', 'canonical_a', 'taobao', 'acct_shared')`)
      await expect(new MigrationRunner(database, migrations.filter(item => item.version === 63)).run())
        .rejects.toThrow('product_listings contains a cross-brand canonical product reference')
      await expect(database.query(`SELECT max(version)::int AS version FROM schema_migrations`))
        .resolves.toMatchObject({ rows: [{ version: 62 }] })

      await database.query(`DELETE FROM product_listings WHERE workspace_id='ws_shared' AND id='listing_legacy_bad'`)
      await expect(new MigrationRunner(database, migrations.filter(item => item.version === 63)).run()).resolves.toEqual([63])
      await expect(database.query(`INSERT INTO product_listings (id, workspace_id, brand_id, canonical_product_id, platform, platform_account_id)
        VALUES ('listing_direct_bad', 'ws_shared', 'brand_b', 'canonical_a', 'taobao', 'acct_shared')`))
        .rejects.toMatchObject({ code: '23503', constraint: 'product_listings_brand_canonical_fk' })

      const repository = new PostgresBrandUnitRepository(database)
      await expect(repository.createListing({ workspaceId: 'ws_shared', id: 'listing_repository_bad', brandId: 'brand_b', canonicalProductId: 'canonical_a', platform: 'taobao', accountId: 'acct_shared' }))
        .rejects.toThrow('PRODUCT_LISTING_CANONICAL_NOT_FOUND')
      await expect(repository.createListing({ workspaceId: 'ws_shared', id: 'listing_repository_good', brandId: 'brand_b', canonicalProductId: 'canonical_b', platform: 'taobao', accountId: 'acct_shared' }))
        .resolves.toMatchObject({ id: 'listing_repository_good', workspaceId: 'ws_shared', brandId: 'brand_b', canonicalProductId: 'canonical_b' })
    } finally {
      await database?.end()
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`, [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 120_000)
})
