import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const specialPolicyTables = [
  'commercial_rollouts',
  'workspace_members',
  'workspace_identity_bindings',
  'workspace_commercial_settings',
  'workspace_subscriptions',
  'ops_access_grants',
  'ops_access_grant_events',
  'authorization_execution_reservations',
  'mcp_oauth_authorization_codes',
  'mcp_oauth_tokens',
] as const

describe('complete migration workspace RLS integrity gate', () => {
  postgresIt('forces safe workspace policies on every ordinary tenant table', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_migration_integrity_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })

      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(migration => migration.version))

      const tenantTables = await database.query<{ table_name: string }>(`
        SELECT c.relname AS table_name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid
           AND a.attname = 'workspace_id'
           AND NOT a.attisdropped
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p')
           AND c.relname <> ALL($1::text[])
         ORDER BY c.relname
      `, [[...specialPolicyTables]])
      expect(tenantTables.rows.length).toBeGreaterThan(0)

      const failures = await database.query<{ table_name: string }>(`
        WITH tenant_tables AS (
          SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = c.oid
             AND a.attname = 'workspace_id'
             AND NOT a.attisdropped
           WHERE n.nspname = 'public'
             AND c.relkind IN ('r', 'p')
             AND c.relname <> ALL($1::text[])
        ), policy_state AS (
          SELECT tablename,
                 count(*)::integer AS policy_count,
                 bool_or(
                   permissive <> 'PERMISSIVE'
                   OR roles <> ARRAY['public']::name[]
                   OR coalesce(qual, '') <> '(workspace_id = current_setting(''app.workspace_id''::text, true))'
                   OR (with_check IS NOT NULL AND with_check <> '(workspace_id = current_setting(''app.workspace_id''::text, true))')
                 ) AS unsafe_policy
            FROM pg_policies
           WHERE schemaname = 'public'
           GROUP BY tablename
        )
        SELECT t.relname AS table_name
          FROM tenant_tables t
          LEFT JOIN policy_state p ON p.tablename = t.relname
         WHERE NOT t.relrowsecurity
            OR NOT t.relforcerowsecurity
            OR coalesce(p.policy_count, 0) = 0
            OR coalesce(p.unsafe_policy, true)
         ORDER BY t.relname
      `, [[...specialPolicyTables]])
      expect(failures.rows).toEqual([])
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [
        () => admin.end(),
      ])
    }
  }, 240_000)
})
