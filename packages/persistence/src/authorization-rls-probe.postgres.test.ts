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

const authorizationTables = [
  'authorization_revisions',
  'platform_role_assignments',
  'platform_role_assignment_events',
  'ops_access_grants',
  'ops_access_grant_events',
  'authorization_execution_reservations',
] as const

describe('authorization/RLS local PostgreSQL probe', () => {
  postgresIt('proves current migration tail and non-superuser authorization boundaries', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_authz_rls_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let ops: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])

      const identityId = randomUUID()
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('probe_ws_a','active') ON CONFLICT (id) DO NOTHING`)
      await database.query(`INSERT INTO platform_identities (id,issuer,external_subject,display_name) VALUES ($1,'local-rls-probe',$2,'Local RLS Probe')`, [identityId, `probe-${identityId}`])
      await database.query(`
        INSERT INTO authorization_revisions (subject_identity_id,revision,updated_by,update_reason)
        VALUES ($1,1,'probe','local authorization RLS probe')
      `, [identityId])

      const metadata = await database.query<{
        relname: string
        relrowsecurity: boolean
        relforcerowsecurity: boolean
      }>(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname = ANY($1::text[])
         ORDER BY c.relname`, [authorizationTables])
      expect(metadata.rows).toHaveLength(authorizationTables.length)
      expect(metadata.rows.every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true)

      const roles = await database.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
        [['merchant_app', 'merchant_ops']],
      )
      expect(roles.rows).toEqual([
        { rolname: 'merchant_app', rolsuper: false, rolbypassrls: false },
        { rolname: 'merchant_ops', rolsuper: false, rolbypassrls: false },
      ])

      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only') })
      for (const table of authorizationTables) {
        await expect(app.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: '42501' })
      }

      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only') })
      for (const table of authorizationTables) {
        const unscoped = await ops.query(`SELECT * FROM ${table}`)
        expect(unscoped.rows, `${table} must be hidden without platform scope`).toEqual([])
      }
      await ops.query('BEGIN')
      await ops.query("SELECT set_config('app.platform_scope','platform_ops',true)")
      const scoped = await ops.query("SELECT subject_identity_id,revision::integer AS revision FROM authorization_revisions WHERE subject_identity_id=$1", [identityId])
      expect(scoped.rows).toEqual([{ subject_identity_id: identityId, revision: 1 }])
      await ops.query('COMMIT')
      await expect(ops.query("INSERT INTO authorization_revisions (subject_identity_id,revision,updated_by,update_reason) VALUES ($1,2,'probe','scope must be transaction local')", [identityId])).rejects.toMatchObject({ code: '42501' })
    } finally {
      await app?.end()
      await ops?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
