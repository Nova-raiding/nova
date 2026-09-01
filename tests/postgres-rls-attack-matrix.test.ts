import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from '../packages/persistence/src/migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const databaseConnection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

const scopedReadTables = [
  { name: 'workspaces', scopeColumn: 'id', prefix: 'rls_matrix_ws_' },
  { name: 'brands', scopeColumn: 'workspace_id', prefix: 'rls_matrix_brand_' },
  { name: 'platform_accounts', scopeColumn: 'workspace_id', prefix: 'rls_matrix_account_' },
  { name: 'canonical_products', scopeColumn: 'workspace_id', prefix: 'rls_matrix_canonical_' },
  { name: 'product_listings', scopeColumn: 'workspace_id', prefix: 'rls_matrix_listing_' },
] as const

describe('PostgreSQL RLS cross-scope attack matrix', () => {
  postgresIt('keeps workspace, brand, account, canonical, and listing rows tenant isolated', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_rls_matrix_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseConnection(base, databaseName) })
      await new MigrationRunner(database, await loadMigrations()).run()

      // The test grants only the table privileges needed to exercise RLS. It
      // does not change policies, migrations, or the role's bypass settings.
      await database.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON workspaces, brands, platform_accounts, brand_store_bindings, canonical_products, product_listings TO merchant_app`)

      await database.query(`
        INSERT INTO workspaces (id, status) VALUES
          ('rls_matrix_ws_a', 'active'), ('rls_matrix_ws_b', 'active')
      `)
      await database.query(`
        INSERT INTO platform_accounts (id, workspace_id, platform, remote_account_id, credential_ref, token_state) VALUES
          ('rls_matrix_account_a', 'rls_matrix_ws_a', 'jd', 'remote-a', 'credential-a', 'valid'),
          ('rls_matrix_account_b', 'rls_matrix_ws_b', 'jd', 'remote-b', 'credential-b', 'valid')
      `)
      await database.query(`
        INSERT INTO brands (id, workspace_id, name) VALUES
          ('rls_matrix_brand_a', 'rls_matrix_ws_a', 'Brand A'),
          ('rls_matrix_brand_b', 'rls_matrix_ws_b', 'Brand B')
      `)
      await database.query(`
        INSERT INTO brand_store_bindings (workspace_id, brand_id, platform, platform_account_id) VALUES
          ('rls_matrix_ws_a', 'rls_matrix_brand_a', 'jd', 'rls_matrix_account_a'),
          ('rls_matrix_ws_b', 'rls_matrix_brand_b', 'jd', 'rls_matrix_account_b')
      `)
      await database.query(`
        INSERT INTO canonical_products (id, workspace_id, brand_id, title) VALUES
          ('rls_matrix_canonical_a', 'rls_matrix_ws_a', 'rls_matrix_brand_a', 'Canonical A'),
          ('rls_matrix_canonical_b', 'rls_matrix_ws_b', 'rls_matrix_brand_b', 'Canonical B')
      `)
      await database.query(`
        INSERT INTO product_listings (id, workspace_id, brand_id, canonical_product_id, platform, platform_account_id, state) VALUES
          ('rls_matrix_listing_a', 'rls_matrix_ws_a', 'rls_matrix_brand_a', 'rls_matrix_canonical_a', 'jd', 'rls_matrix_account_a', 'active'),
          ('rls_matrix_listing_b', 'rls_matrix_ws_b', 'rls_matrix_brand_b', 'rls_matrix_canonical_b', 'jd', 'rls_matrix_account_b', 'active')
      `)

      const appUrl = new URL(databaseConnection(base, databaseName, 'merchant_app', 'merchant_app_local_only'))
      app = new Pool({ connectionString: appUrl.toString(), max: 2 })

      for (const workspaceId of ['rls_matrix_ws_a', 'rls_matrix_ws_b']) {
        await app.query('BEGIN')
        await app.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId])

        for (const table of scopedReadTables) {
          const expectedId = `${table.prefix}${workspaceId.endsWith('_a') ? 'a' : 'b'}`
          const result = await app.query(
            `SELECT id FROM ${table.name} WHERE ${table.scopeColumn} = $1 ORDER BY id`,
            [workspaceId],
          )
          expect(result.rows).toHaveLength(1)
          expect(result.rows[0].id).toBe(expectedId)

          const allRows = await app.query(`SELECT id FROM ${table.name} ORDER BY id`)
          expect(allRows.rows, `${table.name} leaked across ${workspaceId}`).toEqual([{ id: expectedId }])
        }
        await app.query('COMMIT')
      }

      // A forged workspace_id must be rejected by WITH CHECK, even when the
      // caller knows valid foreign keys from the other tenant.
      await app.query('BEGIN')
      await app.query("SELECT set_config('app.workspace_id', 'rls_matrix_ws_a', true)")
      await expect(app.query(
        `INSERT INTO brands (id, workspace_id, name) VALUES ('rls_matrix_attack_brand', 'rls_matrix_ws_b', 'forged')`,
      )).rejects.toMatchObject({ code: '42501' })
      await app.query('ROLLBACK')

      await app.query('BEGIN')
      await app.query("SELECT set_config('app.workspace_id', 'rls_matrix_ws_a', true)")
      await expect(app.query(
        `INSERT INTO product_listings (id, workspace_id, brand_id, canonical_product_id, platform, platform_account_id, state)
         VALUES ('rls_matrix_attack_listing', 'rls_matrix_ws_b', 'rls_matrix_brand_b', 'rls_matrix_canonical_b', 'jd', 'rls_matrix_account_b', 'active')`,
      )).rejects.toMatchObject({ code: '42501' })
      await app.query('ROLLBACK')

      await expect(app.query("SELECT set_config('app.workspace_id', 'rls_matrix_ws_a', true)")).resolves.toBeDefined()
      const unscoped = await app.query('SELECT id FROM product_listings ORDER BY id')
      expect(unscoped.rows).toEqual([])
    } finally {
      await app?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
