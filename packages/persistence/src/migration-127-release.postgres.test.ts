import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'
const postgresIt = databaseUrlValue ? it : it.skip

const connection = (base: URL, database: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  return url.toString()
}

describe('migration 127 platform role shadow boundary PostgreSQL release acceptance', () => {
  postgresIt('stops on historical platform membership drift and resumes only after audited repair', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_127_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      const through123 = migrations.filter(migration => migration.version <= 123)

      await expect(new MigrationRunner(database, through123).run()).resolves.toEqual(through123.map(migration => migration.version))
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('ws_role_shadow','active')`)
      await database.query(`INSERT INTO workspace_members (id,workspace_id,external_subject,display_name,role,status,invited_by) VALUES ($1,'ws_role_shadow','legacy-platform','Legacy platform operator','platform_ops','active','migration-fixture')`, [randomUUID()])

      // The NOT VALID constraint from 124 blocks new drift, while 127 must
      // stop the release before recording itself when historical drift exists.
      await expect(new MigrationRunner(database, migrations).run()).rejects.toThrow(/workspace_members_no_platform_role/u)
      expect((await database.query<{ version: number }>(`SELECT version FROM schema_migrations WHERE version = 127`)).rows).toHaveLength(0)

      // Repair is explicit and auditable outside the migration. Only then may
      // the deferred validation pass and the release become runnable.
      await database.query(`UPDATE workspace_members SET role='operator',updated_at=now() WHERE workspace_id='ws_role_shadow' AND external_subject='legacy-platform'`)
      await expect(new MigrationRunner(database, migrations).run()).resolves.toEqual(migrations.filter(migration => migration.version > 126).map(migration => migration.version))
      await expect(new MigrationRunner(database, migrations).run()).resolves.toEqual([])
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
