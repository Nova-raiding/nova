import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('product tenant RLS PostgreSQL probe', () => {
  postgresIt('keeps customer rows isolated and rejects platform-scope spoofing', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_product_rls_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])

      // The release database deliberately starts with runtime table grants
      // revoked. Establish only the application privileges this probe needs;
      // RLS remains forced and is the boundary under test.
      await database.query('GRANT SELECT, INSERT ON products TO merchant_app')

      await database.query(`
        INSERT INTO workspaces (id, status)
        VALUES ('product_rls_alpha', 'active'), ('product_rls_beta', 'active')
      `)
      await database.query(`
        INSERT INTO platform_accounts
          (id, workspace_id, platform, remote_account_id, credential_ref, token_state)
        VALUES
          ('product_rls_account_alpha', 'product_rls_alpha', 'jd', 'remote-alpha', 'secret://alpha', 'connected'),
          ('product_rls_account_beta', 'product_rls_beta', 'jd', 'remote-beta', 'secret://beta', 'connected')
      `)
      await database.query(`
        INSERT INTO products
          (id, workspace_id, platform, platform_account_id, store_name, remote_product_id, title, source)
        VALUES
          ('product_rls_alpha_row', 'product_rls_alpha', 'jd', 'product_rls_account_alpha', 'Alpha store', 'remote-alpha-product', 'Alpha customer product', 'fixture'),
          ('product_rls_beta_row', 'product_rls_beta', 'jd', 'product_rls_account_beta', 'Beta store', 'remote-beta-product', 'Beta customer product', 'fixture')
      `)

      app = new Pool({
        connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'),
        max: 1,
      })
      await app.query('BEGIN')
      await app.query("SELECT set_config('app.workspace_id', 'product_rls_alpha', true)")

      expect((await app.query('SELECT id, workspace_id FROM products ORDER BY id')).rows).toEqual([
        { id: 'product_rls_alpha_row', workspace_id: 'product_rls_alpha' },
      ])
      expect((await app.query('SELECT id FROM products WHERE id=$1', ['product_rls_beta_row'])).rows).toEqual([])

      // A tenant request must not turn a client-controlled platform-looking
      // setting into an elevation or expose the other workspace.
      await app.query("SELECT set_config('app.platform_scope', 'platform_ops', true)")
      expect((await app.query('SELECT id FROM products ORDER BY id')).rows).toEqual([
        { id: 'product_rls_alpha_row' },
      ])
      await expect(app.query(`
        INSERT INTO products
          (id, workspace_id, platform, platform_account_id, remote_product_id, title, source)
        VALUES ('product_rls_forged', 'product_rls_beta', 'jd', 'product_rls_account_beta', 'remote-forged', 'forged', 'fixture')
      `)).rejects.toMatchObject({ code: '42501' })
      await app.query('ROLLBACK')

      // SET LOCAL context must be cleared before a pooled connection is reused.
      expect((await app.query('SELECT id FROM products ORDER BY id')).rows).toEqual([])
    } finally {
      await app?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
