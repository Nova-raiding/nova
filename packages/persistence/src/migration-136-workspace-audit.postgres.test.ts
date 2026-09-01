import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const databaseConnection = (base: URL, database: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  return url.toString()
}

describe('migration 136 workspace audit truncate guard', () => {
  it('registers an owner-safe append-only truncate guard', async () => {
    const sql = await (await import('node:fs/promises')).readFile(new URL('./migrations/136_workspace_operation_audit_truncate_guard.sql', import.meta.url), 'utf8')
    expect((await loadMigrations()).find(item => item.version === 136)).toMatchObject({ version: 136, name: 'workspace_operation_audit_truncate_guard' })
    expect(sql).toContain('BEFORE TRUNCATE ON workspace_operation_audit')
    expect(sql).toContain("RAISE EXCEPTION 'workspace operation audit is append-only'")
    expect(sql).toContain('REVOKE TRUNCATE ON workspace_operation_audit FROM PUBLIC')
    expect(sql).not.toMatch(/DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE/iu)
  })

  postgresIt('rejects owner-level truncate after the complete migration chain', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_workspace_audit_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    const database = new Pool({ connectionString: databaseConnection(base, databaseName) })
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toContain(136)
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('audit_guard_ws','active')`)
      await database.query(`INSERT INTO workspace_operation_audit (id,workspace_id,actor_id,action,resource_type,resource_id) VALUES ($1,'audit_guard_ws','probe','read','workspace','audit_guard_ws')`, [randomUUID()])
      await expect(database.query('TRUNCATE workspace_operation_audit CASCADE')).rejects.toMatchObject({ code: '55000' })
      expect((await database.query('SELECT count(*)::int AS count FROM workspace_operation_audit')).rows).toEqual([{ count: 1 }])
    } finally {
      await database.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
