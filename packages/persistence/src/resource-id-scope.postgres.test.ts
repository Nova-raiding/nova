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

describe('resource ID scope PostgreSQL probe', () => {
  postgresIt('keeps an allowed app read bounded to the exact workspace and platform account', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_resource_scope_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))

      // This is an application-allow probe: SELECT is granted, but forced RLS
      // remains the final boundary for both tenant and resource identity.
      await database.query('GRANT SELECT ON platform_accounts, products TO merchant_app')
      await database.query(`
        INSERT INTO workspaces (id, status)
        VALUES ('resource_scope_a', 'active'), ('resource_scope_b', 'active')
      `)
      await database.query(`
        INSERT INTO platform_accounts
          (id, workspace_id, platform, remote_account_id, credential_ref, token_state)
        VALUES
          ('resource_scope_account_a1', 'resource_scope_a', 'taobao', 'remote-a1', 'secret://a1', 'connected'),
          ('resource_scope_account_a2', 'resource_scope_a', 'taobao', 'remote-a2', 'secret://a2', 'connected'),
          ('resource_scope_account_b1', 'resource_scope_b', 'taobao', 'remote-b1', 'secret://b1', 'connected')
      `)
      await database.query(`
        INSERT INTO products
          (id, workspace_id, platform, platform_account_id, store_name, remote_product_id, title, source)
        VALUES
          ('resource_scope_product_a1', 'resource_scope_a', 'taobao', 'resource_scope_account_a1', 'A1', 'remote-product-a1', 'A1 product', 'fixture'),
          ('resource_scope_product_a2', 'resource_scope_a', 'taobao', 'resource_scope_account_a2', 'A2', 'remote-product-a2', 'A2 product', 'fixture'),
          ('resource_scope_product_b1', 'resource_scope_b', 'taobao', 'resource_scope_account_b1', 'B1', 'remote-product-b1', 'B1 product', 'fixture')
      `)

      app = new Pool({
        connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'),
        max: 1,
      })
      await app.query('BEGIN')
      await app.query("SELECT set_config('app.workspace_id', 'resource_scope_a', true)")

      expect((await app.query('SELECT id FROM platform_accounts WHERE id=$1', ['resource_scope_account_a1'])).rows)
        .toEqual([{ id: 'resource_scope_account_a1' }])
      expect((await app.query('SELECT id FROM platform_accounts WHERE id=$1', ['resource_scope_account_a2'])).rows)
        .toEqual([{ id: 'resource_scope_account_a2' }])
      expect((await app.query('SELECT id FROM platform_accounts WHERE id=$1', ['resource_scope_account_b1'])).rows)
        .toEqual([])

      // A resolver may narrow an allowed tenant read to an exact account ID;
      // RLS must still prevent the request from loading another workspace.
      expect((await app.query('SELECT id FROM products WHERE platform_account_id=$1', ['resource_scope_account_a1'])).rows)
        .toEqual([{ id: 'resource_scope_product_a1' }])
      expect((await app.query('SELECT id FROM products WHERE platform_account_id=$1', ['resource_scope_account_a2'])).rows)
        .toEqual([{ id: 'resource_scope_product_a2' }])
      expect((await app.query('SELECT id FROM products WHERE platform_account_id=$1', ['resource_scope_account_b1'])).rows)
        .toEqual([])
      expect((await app.query('SELECT id FROM products WHERE id=$1', ['resource_scope_product_b1'])).rows)
        .toEqual([])

      // Client-controlled platform scope cannot turn an app connection into a
      // platform aggregate connection or expose another tenant's resources.
      await app.query("SELECT set_config('app.platform_scope', 'platform_ops', true)")
      expect((await app.query('SELECT id FROM products ORDER BY id')).rows).toEqual([
        { id: 'resource_scope_product_a1' },
        { id: 'resource_scope_product_a2' },
      ])
      await app.query('ROLLBACK')

      // SET LOCAL context must not leak after the request transaction ends.
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
