import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
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

describe('local plugin install RLS PostgreSQL release acceptance', () => {
  postgresIt('isolates connection and install records to platform ops and enforces append-only ACLs', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_plugin_rls_${randomUUID().replaceAll('-', '')}`
    const legacyDatabaseName = `release_plugin_rls_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let legacyDatabase: Pool | undefined
    let legacyDatabaseCreated = false
    let app: Pool | undefined
    let ops: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))

      const opsOnlyTables = ['local_plugin_connection_requests', 'local_plugin_install_instances', 'local_plugin_install_challenges', 'local_plugin_install_audit']
      const rlsCatalog = await database.query<{ table_name: string; row_security: boolean; force_row_security: boolean; policy_count: number }>(`
        SELECT expected.table_name, c.relrowsecurity AS row_security,
               c.relforcerowsecurity AS force_row_security, count(p.policyname)::int AS policy_count
          FROM unnest($1::text[]) AS expected(table_name)
          JOIN pg_class c ON c.relname=expected.table_name
          JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
          LEFT JOIN pg_policies p ON p.schemaname='public' AND p.tablename=expected.table_name
         GROUP BY expected.table_name,c.relrowsecurity,c.relforcerowsecurity
         ORDER BY expected.table_name
      `, [opsOnlyTables])
      expect(rlsCatalog.rows).toHaveLength(opsOnlyTables.length)
      expect(rlsCatalog.rows.every(row => row.row_security && row.force_row_security && row.policy_count === 1)).toBe(true)

      const accountId = randomUUID()
      const identityId = randomUUID()
      const requestId = randomUUID()
      const instanceId = randomUUID()
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('plugin_rls_a','active'),('plugin_rls_b','active')`)
      await database.query(`INSERT INTO platform_identities (id,issuer,external_subject,display_name) VALUES ($1,'plugin-rls-probe',$2,'RLS probe')`, [identityId, `subject-${identityId}`])
      await database.query(`INSERT INTO platform_password_accounts (id,identity_id,login_identifier,account_type,password_hash,status,workspace_ids) VALUES ($1,$2,$3,'platform','$argon2id$rls-probe','active',ARRAY['plugin_rls_a'])`, [accountId, identityId, `plugin-rls-${accountId}@example.invalid`])
      await database.query(`INSERT INTO local_plugin_connection_requests (id,account_id,identity_id,workspace_id,expires_at) VALUES ($1,$2,$3,'plugin_rls_a',now()+interval '5 minutes')`, [requestId, accountId, identityId])
      await database.query(`INSERT INTO local_plugin_install_instances (id,platform,public_key,public_key_fingerprint,pairing_token_hash,pairing_expires_at) VALUES ($1,'macos','probe-key','${'a'.repeat(43)}','${'b'.repeat(43)}',now()+interval '5 minutes')`, [instanceId])
      await database.query(`INSERT INTO local_plugin_install_challenges (id,instance_id,request_id,challenge_hash,expires_at) VALUES ($1,$2,$3,$4,now()+interval '2 minutes')`, [randomUUID(), instanceId, requestId, 'c'.repeat(43)])
      await database.query(`INSERT INTO local_plugin_install_audit (id,instance_id,event_type,evidence_json) VALUES ($1,$2,'probe.created','{}'::jsonb)`, [randomUUID(), instanceId])

      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 1 })
      for (const table of ['local_plugin_connection_requests', 'local_plugin_install_instances', 'local_plugin_install_challenges', 'local_plugin_install_audit']) {
        await expect(app.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: '42501' })
      }

      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only'), max: 1 })
      for (const table of ['local_plugin_connection_requests', 'local_plugin_install_instances', 'local_plugin_install_challenges', 'local_plugin_install_audit']) {
        expect((await ops.query(`SELECT * FROM ${table}`)).rows).toEqual([])
      }
      await ops.query('BEGIN')
      await ops.query("SELECT set_config('app.platform_scope','platform_ops',true)")
      for (const table of ['local_plugin_connection_requests', 'local_plugin_install_instances', 'local_plugin_install_challenges', 'local_plugin_install_audit']) {
        expect((await ops.query(`SELECT * FROM ${table}`)).rowCount).toBe(1)
      }
      await ops.query('COMMIT')
      for (const table of ['local_plugin_connection_requests', 'local_plugin_install_instances', 'local_plugin_install_challenges', 'local_plugin_install_audit']) {
        expect((await ops.query(`SELECT * FROM ${table}`)).rows).toEqual([])
      }

      const acl = await database.query<{ request_delete: boolean; instance_truncate: boolean; challenge_delete: boolean; audit_update: boolean; audit_truncate: boolean }>(`
        SELECT has_table_privilege('merchant_ops','local_plugin_connection_requests','DELETE') AS request_delete,
          has_table_privilege('merchant_ops','local_plugin_install_instances','TRUNCATE') AS instance_truncate,
          has_table_privilege('merchant_ops','local_plugin_install_challenges','DELETE') AS challenge_delete,
          has_table_privilege('merchant_ops','local_plugin_install_audit','UPDATE') AS audit_update,
          has_table_privilege('merchant_ops','local_plugin_install_audit','TRUNCATE') AS audit_truncate`)
      expect(acl.rows).toEqual([{ request_delete: false, instance_truncate: false, challenge_delete: false, audit_update: false, audit_truncate: false }])
      await expect(database.query(`UPDATE local_plugin_install_audit SET event_type='tampered' WHERE instance_id=$1`, [instanceId])).rejects.toThrow(/append-only/u)

      // Recreate the exact pre-245 history that the 243 CHECK allowed: an
      // authorized row with no authorization timestamp. Migration 245 must
      // reject that legacy state transactionally rather than silently invent
      // audit data or record a migration it did not apply.
      await admin.query(`CREATE DATABASE "${legacyDatabaseName}"`)
      legacyDatabaseCreated = true
      legacyDatabase = new Pool({ connectionString: connection(base, legacyDatabaseName) })
      const prefix = migrations.filter(migration => migration.version <= 244)
      const through245 = migrations.filter(migration => migration.version <= 245)
      expect(await new MigrationRunner(legacyDatabase, prefix).run()).toEqual(prefix.map(migration => migration.version))
      const legacyIdentityId = randomUUID()
      const legacyAccountId = randomUUID()
      const legacyRequestId = randomUUID()
      await legacyDatabase.query(`INSERT INTO workspaces (id,status) VALUES ('plugin_migration_245','active')`)
      await legacyDatabase.query(`INSERT INTO platform_identities (id,issuer,external_subject,display_name) VALUES ($1,'plugin-migration-245',$2,'Migration probe')`, [legacyIdentityId, `subject-${legacyIdentityId}`])
      await legacyDatabase.query(`INSERT INTO platform_password_accounts (id,identity_id,login_identifier,account_type,password_hash,status,workspace_ids) VALUES ($1,$2,$3,'platform','$argon2id$migration-probe','active',ARRAY['plugin_migration_245'])`, [legacyAccountId, legacyIdentityId, `migration-245-${legacyAccountId}@example.invalid`])
      await legacyDatabase.query(`INSERT INTO local_plugin_connection_requests (id,account_id,identity_id,workspace_id,status,created_at,expires_at,authorized_at,exchanged_at) VALUES ($1,$2,$3,'plugin_migration_245','authorized',now()-interval '10 minutes',now()-interval '5 minutes',NULL,NULL)`, [legacyRequestId, legacyAccountId, legacyIdentityId])

      await expect(new MigrationRunner(legacyDatabase, migrations).run()).rejects.toMatchObject({
        code: '23514',
        constraint: 'local_plugin_connection_requests_authorized_timestamp_check',
      })
      const appliedAfterRejectedMigration = await legacyDatabase.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
      expect(appliedAfterRejectedMigration.rows.map(row => row.version)).toEqual(prefix.map(migration => migration.version))
      expect((await legacyDatabase.query(`SELECT status,authorized_at FROM local_plugin_connection_requests WHERE id=$1`, [legacyRequestId])).rows)
        .toEqual([{ status: 'authorized', authorized_at: null }])

      // A reviewed legacy-state correction makes the forward-only migration
      // applicable; the resulting constraint rejects future invalid writes.
      await legacyDatabase.query(`UPDATE local_plugin_connection_requests SET status='expired' WHERE id=$1`, [legacyRequestId])
      expect(await new MigrationRunner(legacyDatabase, through245).run()).toEqual([245])
      await expect(legacyDatabase.query(`INSERT INTO local_plugin_connection_requests (id,account_id,identity_id,workspace_id,status,expires_at,authorized_at,exchanged_at) VALUES ($1,$2,$3,'plugin_migration_245','authorized',now()+interval '5 minutes',NULL,NULL)`, [randomUUID(), legacyAccountId, legacyIdentityId]))
        .rejects.toMatchObject({ code: '23514', constraint: 'local_plugin_connection_requests_authorized_timestamp_check' })
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await app?.end()
        await ops?.end()
        await legacyDatabase?.end()
        await database?.end()
        if (legacyDatabaseCreated) await dropDrainedPostgresFixture(admin, legacyDatabaseName)
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [() => admin.end()])
    }
  }, 240_000)
})
