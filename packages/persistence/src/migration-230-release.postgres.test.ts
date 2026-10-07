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

describe('migration 230 public platform rule tenant DML boundary', () => {
  postgresIt('keeps merchant_app read-only and keeps the public audit ledger append-only after the final ACL migrations', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_230_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let ops: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      await new MigrationRunner(database, (await loadMigrations()).filter(item => item.version <= 230)).run()
      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only') })
      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only') })

      await ops.query(`INSERT INTO public_platform_rule_versions
        (id,platform,pack_id,name,version,status,source_kind,source_reference,source_checked_at,checksum,checks,created_by)
        VALUES ('public-230-a','pinduoduo','pdd-230','规则 230','1','draft','internal','manual://230',now(),repeat('a',64),'{}','ops-230')`)
      await ops.query(`INSERT INTO public_platform_rule_audits
        (id,rule_version_id,platform,version,action,actor_id,reason)
        VALUES ('public-230-audit','public-230-a','pinduoduo','1','created','ops-230','审计边界')`)

      expect((await app.query(`SELECT id FROM public_platform_rule_versions WHERE id='public-230-a'`)).rows).toEqual([{ id: 'public-230-a' }])
      expect((await database.query(`SELECT
        has_table_privilege('merchant_app','public_platform_rule_versions','SELECT') AS app_version_select,
        has_table_privilege('merchant_app','public_platform_rule_versions','INSERT') AS app_version_insert,
        has_table_privilege('merchant_app','public_platform_rule_versions','UPDATE') AS app_version_update,
        has_table_privilege('merchant_app','public_platform_rule_versions','DELETE') AS app_version_delete,
        has_table_privilege('merchant_app','public_platform_rule_audits','SELECT') AS app_audit_select,
        has_table_privilege('merchant_app','public_platform_rule_audits','INSERT') AS app_audit_insert,
        has_table_privilege('merchant_ops','public_platform_rule_audits','INSERT') AS ops_audit_insert,
        has_table_privilege('merchant_ops','public_platform_rule_audits','UPDATE') AS ops_audit_update,
        has_table_privilege('merchant_ops','public_platform_rule_audits','DELETE') AS ops_audit_delete,
        has_table_privilege('merchant_ops','public_platform_rule_audits','TRUNCATE') AS ops_audit_truncate`)).rows).toEqual([{
        app_version_select: true, app_version_insert: false, app_version_update: false, app_version_delete: false,
        app_audit_select: true, app_audit_insert: false,
        ops_audit_insert: true, ops_audit_update: false, ops_audit_delete: false, ops_audit_truncate: false,
      }])
      await expect(app.query(`INSERT INTO public_platform_rule_audits
        (id,rule_version_id,platform,version,action,actor_id,reason)
        VALUES ('public-230-forged','public-230-a','pinduoduo','1','activated','merchant','伪造审计')`)).rejects.toMatchObject({ code: '42501' })
      await expect(ops.query(`TRUNCATE public_platform_rule_audits`)).rejects.toMatchObject({ code: '42501' })
      await expect(database.query(`TRUNCATE public_platform_rule_audits`)).rejects.toMatchObject({ code: '55000' })
      expect((await ops.query(`SELECT id, action, actor_id FROM public_platform_rule_audits WHERE id='public-230-audit'`)).rows).toEqual([{ id: 'public-230-audit', action: 'created', actor_id: 'ops-230' }])
    } finally {
      await app?.end()
      await ops?.end()
      await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
