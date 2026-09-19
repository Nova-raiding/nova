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

/**
 * Migration 219 grants `merchant_ops` SELECT, INSERT on
 * `public_platform_rule_audits` and nothing else, which is the schema's uniform
 * ACL for an ops-owned append-only audit ledger. The append-only trigger is not
 * dead code under that grant: it is the guard for the table owner, which is the
 * role that actually holds UPDATE/DELETE (see migration 136's owner-level
 * truncate test). Both halves are asserted below, so a mutation attempt is
 * refused either by privilege (runtime role, 42501) or by the trigger (owner,
 * 55000) and never silently succeeds.
 */
describe('migration 219 PostgreSQL public platform rules acceptance', () => {
  postgresIt('allows merchant reads, denies merchant writes, and keeps operations auditable', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_219_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let ops: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      await new MigrationRunner(database, migrations.filter(item => item.version <= 218)).run()
      await new MigrationRunner(database, migrations.filter(item => item.version === 219)).run()
      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only') })
      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only') })

      await ops.query(`INSERT INTO public_platform_rule_versions
        (id,platform,pack_id,name,version,status,source_kind,source_reference,source_checked_at,checksum,checks,created_by)
        VALUES ('public-219-a','pinduoduo','pdd-manual-1','拼多多规则','1.0.0','active','official','https://example.test/pdd',now(),repeat('a',64),'{}','ops-219')`)
      expect((await app.query(`SELECT platform, pack_id, version FROM public_platform_rule_versions WHERE status='active'`)).rows).toEqual([{ platform: 'pinduoduo', pack_id: 'pdd-manual-1', version: '1.0.0' }])
      await expect(app.query(`INSERT INTO public_platform_rule_versions
        (id,platform,pack_id,name,version,status,source_kind,source_reference,source_checked_at,checksum,checks,created_by)
        VALUES ('public-219-denied','pinduoduo','pdd-denied','禁止写入','1.0.0','draft','internal','manual://denied',now(),repeat('b',64),'{}','merchant')`)).rejects.toMatchObject({ code: '42501' })
      expect((await ops.query(`SELECT action, actor_id FROM public_platform_rule_audits WHERE rule_version_id='public-219-a'`)).rowCount).toBe(0)

      // The runtime role must never hold UPDATE/DELETE on an append-only audit
      // ledger: it is denied by privilege (42501) *before* the trigger is ever
      // reached, exactly like every other ops audit ledger in this schema
      // (`platform_identity_events`, `platform_authorization_audit`,
      // `platform_media_spec_audit`, `rule_audit_events`). Granting the
      // mutation right so the trigger can reject it would be a regression, and
      // migration 132/184 go the other way: they revoke it explicitly.
      expect((await database.query<{ privilege_type: string }>(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='public_platform_rule_audits' AND grantee='merchant_ops' ORDER BY privilege_type`)).rows.map(row => row.privilege_type)).toEqual(['INSERT', 'SELECT'])
      expect((await database.query<{ privilege_type: string }>(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='platform_identity_events' AND grantee='merchant_ops' ORDER BY privilege_type`)).rows.map(row => row.privilege_type)).toEqual(['INSERT', 'SELECT'])
      await expect(ops.query(`DELETE FROM public_platform_rule_audits WHERE rule_version_id='public-219-a'`)).rejects.toMatchObject({ code: '42501' })
      await expect(ops.query(`UPDATE public_platform_rule_audits SET reason='rewritten' WHERE rule_version_id='public-219-a'`)).rejects.toMatchObject({ code: '42501' })
      expect((await ops.query(`SELECT count(*)::int AS count FROM public_platform_rule_audits`)).rows).toEqual([{ count: 0 }])
      // The append-only trigger is the owner-facing half of the same guarantee:
      // migration 132 and 184 install theirs for exactly this path, and the
      // owner is the role that actually holds UPDATE/DELETE here.
      await database.query(`INSERT INTO public_platform_rule_audits (id,rule_version_id,platform,version,action,actor_id,reason) VALUES ('public-219-audit','public-219-a','pinduoduo','1.0.0','activated','ops-219','promote to active')`)
      await expect(database.query(`DELETE FROM public_platform_rule_audits WHERE id='public-219-audit'`)).rejects.toMatchObject({ code: '55000' })
      await expect(database.query(`UPDATE public_platform_rule_audits SET reason='rewritten' WHERE id='public-219-audit'`)).rejects.toMatchObject({ code: '55000' })
      expect((await database.query(`SELECT action, actor_id, reason FROM public_platform_rule_audits WHERE id='public-219-audit'`)).rows).toEqual([{ action: 'activated', actor_id: 'ops-219', reason: 'promote to active' }])
      expect((await database.query('SELECT max(version)::int AS version FROM schema_migrations')).rows).toEqual([{ version: 219 }])
    } finally {
      await app?.end()
      await ops?.end()
      await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
