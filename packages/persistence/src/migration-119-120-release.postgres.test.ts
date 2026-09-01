import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function isolatedConnection(base: URL, databaseName: string) {
  const url = new URL(base)
  url.pathname = `/${databaseName}`
  return url.toString()
}

describe('migrations 119 and 120 PostgreSQL release acceptance', () => {
  postgresIt('applies the complete chain, preserves the dispatch fence, and installs durable reservation controls', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_119_120_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: isolatedConnection(base, databaseName), max: 4 })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])

      const constraints = await database.query<{ conname: string; convalidated: boolean; definition: string }>(`
        SELECT c.conname, c.convalidated, pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        WHERE c.conname IN ('image_generation_execution_state_check', 'authorization_execution_reservations_grant_workspace_fk')
        ORDER BY c.conname`)
      expect(constraints.rows).toEqual([
        expect.objectContaining({
          conname: 'authorization_execution_reservations_grant_workspace_fk',
          convalidated: true,
          definition: expect.stringContaining('FOREIGN KEY (workspace_id, grant_id)'),
        }),
        expect.objectContaining({
          conname: 'image_generation_execution_state_check',
          convalidated: true,
          definition: expect.stringContaining("'provider_reserved'::text"),
        }),
      ])

      const recoveryIndex = await database.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'image_generation_executions'
          AND indexname = 'image_generation_execution_dispatch_recovery_idx'`)
      expect(recoveryIndex.rows).toEqual([{ indexname: 'image_generation_execution_dispatch_recovery_idx' }])

      const reservationTable = await database.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
        SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'authorization_execution_reservations'`)
      expect(reservationTable.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])

      const policy = await database.query<{ policyname: string; roles: string; using_expression: string; check_expression: string }>(`
        SELECT policyname, array_to_string(roles, ',' ) AS roles,
          COALESCE(qual::text, '') AS using_expression,
          COALESCE(with_check::text, '') AS check_expression
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'authorization_execution_reservations'`)
      expect(policy.rows).toEqual([expect.objectContaining({
        policyname: 'authorization_execution_reservations_platform_ops',
        roles: 'public',
        using_expression: expect.stringContaining("current_setting('app.platform_scope'::text, true) = 'platform_ops'"),
        check_expression: expect.stringContaining("current_setting('app.platform_scope'::text, true) = 'platform_ops'"),
      })])

      const acl = await database.query<{ privilege_type: string }>(`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = 'authorization_execution_reservations'
          AND grantee = 'merchant_ops' ORDER BY privilege_type`)
      expect(acl.rows).toEqual([{ privilege_type: 'INSERT' }, { privilege_type: 'SELECT' }])
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
