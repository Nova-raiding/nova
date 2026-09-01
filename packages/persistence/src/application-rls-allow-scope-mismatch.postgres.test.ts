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

describe('application PostgreSQL RLS allow/scope mismatch probe', () => {
  postgresIt('keeps an allowed tenant read bounded when the requested scope is foreign', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_app_rls_scope_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))

      // This is an application-allow probe: the role has the normal catalog
      // privileges, while forced RLS remains the final tenant boundary.
      await database.query('GRANT SELECT, INSERT ON workspaces, brands TO merchant_app')
      await database.query(`
        INSERT INTO workspaces (id, status) VALUES ('app_scope_a', 'active'), ('app_scope_b', 'active')
      `)
      await database.query(`
        INSERT INTO brands (id, workspace_id, name) VALUES
          ('app_scope_brand_a', 'app_scope_a', 'Scope A'),
          ('app_scope_brand_b', 'app_scope_b', 'Scope B')
      `)

      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 1 })
      await app.query('BEGIN')
      await app.query("SELECT set_config('app.workspace_id', 'app_scope_a', true)")

      // The role is allowed to read brands, but a query explicitly naming the
      // other tenant must still return no row through the RLS policy.
      expect((await app.query('SELECT id FROM brands WHERE id = $1', ['app_scope_brand_a'])).rows).toEqual([{ id: 'app_scope_brand_a' }])
      expect((await app.query('SELECT id FROM brands WHERE id = $1', ['app_scope_brand_b'])).rows).toEqual([])
      expect((await app.query('SELECT id FROM brands ORDER BY id')).rows).toEqual([{ id: 'app_scope_brand_a' }])

      // A tenant connection cannot turn a platform-looking setting into an
      // elevation; platform scope is bound to the separate merchant_ops role.
      await app.query("SELECT set_config('app.platform_scope', 'platform_ops', true)")
      expect((await app.query('SELECT id FROM brands ORDER BY id')).rows).toEqual([{ id: 'app_scope_brand_a' }])

      await expect(app.query(
        `INSERT INTO brands (id, workspace_id, name) VALUES ('app_scope_forged', 'app_scope_b', 'forged')`,
      )).rejects.toMatchObject({ code: '42501' })
      await app.query('ROLLBACK')

      // SET LOCAL must not leak the tenant or platform scope to the pooled
      // connection after the request transaction completes.
      expect((await app.query('SELECT id FROM brands ORDER BY id')).rows).toEqual([])
    } finally {
      await app?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
