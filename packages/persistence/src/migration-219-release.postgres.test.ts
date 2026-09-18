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
      await expect(ops.query(`DELETE FROM public_platform_rule_audits WHERE rule_version_id='public-219-a'`)).rejects.toMatchObject({ code: '55000' })
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
