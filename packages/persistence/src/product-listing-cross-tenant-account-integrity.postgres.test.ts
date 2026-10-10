import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { assertOwnedPostgresTestBinding } from '../../../tests/fixtures/owned-postgres-binding.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const base = assertOwnedPostgresTestBinding(
  process.env.PERSISTENCE_RELEASE_DATABASE_URL,
  process.env.MERCHANT_ISOLATED_POSTGRES_RUN_ID,
)

const databaseConnection = (database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('product listing cross-tenant account integrity', () => {
  it('rejects a workspace A listing that references workspace B account', async () => {
    const databaseName = `probe_listing_account_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseConnection(databaseName) })
      await new MigrationRunner(database, await loadMigrations()).run()

      await database.query(`
        GRANT SELECT, INSERT ON product_listings TO merchant_app;
        INSERT INTO workspaces (id, status) VALUES
          ('listing_scope_ws_a', 'active'), ('listing_scope_ws_b', 'active');
        INSERT INTO platform_accounts (id, workspace_id, platform, remote_account_id, credential_ref, token_state) VALUES
          ('listing_scope_account_a', 'listing_scope_ws_a', 'jd', 'remote-a', 'credential-a', 'valid'),
          ('listing_scope_account_b', 'listing_scope_ws_b', 'jd', 'remote-b', 'credential-b', 'valid');
        INSERT INTO brands (id, workspace_id, name) VALUES
          ('listing_scope_brand_a', 'listing_scope_ws_a', 'Brand A'),
          ('listing_scope_brand_b', 'listing_scope_ws_b', 'Brand B');
        INSERT INTO brand_store_bindings (workspace_id, brand_id, platform, platform_account_id) VALUES
          ('listing_scope_ws_a', 'listing_scope_brand_a', 'jd', 'listing_scope_account_a'),
          ('listing_scope_ws_b', 'listing_scope_brand_b', 'jd', 'listing_scope_account_b');
        INSERT INTO canonical_products (id, workspace_id, brand_id, title) VALUES
          ('listing_scope_canonical_a', 'listing_scope_ws_a', 'listing_scope_brand_a', 'Canonical A'),
          ('listing_scope_canonical_b', 'listing_scope_ws_b', 'listing_scope_brand_b', 'Canonical B');
      `)

      app = new Pool({
        connectionString: databaseConnection(databaseName, 'merchant_app', 'merchant_app_local_only'),
        max: 1,
      })
      const client = await app.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT set_config('app.workspace_id', $1, true)", ['listing_scope_ws_a'])
        await client.query('SAVEPOINT cross_tenant_account_probe')

        await expect(client.query(`
          INSERT INTO product_listings
            (id, workspace_id, brand_id, canonical_product_id, platform, platform_account_id, state)
          VALUES
            ('listing_scope_attack', 'listing_scope_ws_a', 'listing_scope_brand_a',
             'listing_scope_canonical_a', 'jd', 'listing_scope_account_b', 'active')
        `)).rejects.toMatchObject({
          code: '23503',
          constraint: 'product_listings_brand_store_fk',
        })

        await client.query('ROLLBACK TO SAVEPOINT cross_tenant_account_probe')
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }

      const persisted = await database.query(
        "SELECT id FROM product_listings WHERE id = 'listing_scope_attack'",
      )
      expect(persisted.rows).toEqual([])
    } finally {
      await app?.end()
      await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
