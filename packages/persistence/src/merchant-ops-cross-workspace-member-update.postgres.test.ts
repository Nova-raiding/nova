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

describe('merchant_ops cross-workspace workspace_members UPDATE RLS', () => {
  postgresIt('cannot activate or revise another workspace member, even with platform read scope', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_member_rls_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let ops: Pool | undefined
    const workspaceA = `member_rls_a_${randomUUID()}`
    const workspaceB = `member_rls_b_${randomUUID()}`
    const memberB = randomUUID()

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))

      await database.query("INSERT INTO workspaces (id,status) VALUES ($1,'active'),($2,'active')", [workspaceA, workspaceB])
      await database.query(`
        INSERT INTO workspace_members (id,workspace_id,external_subject,display_name,role,status,invited_by,revision)
        VALUES ($1,$2,'member-a','Member A','operator','invited','probe',1),
               ($3,$4,'member-b','Member B','operator','invited','probe',1)
      `, [randomUUID(), workspaceA, memberB, workspaceB])

      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only'), max: 1 })
      const statusUpdatePrivilege = await database.query<{ allowed: boolean }>(
        `SELECT has_column_privilege('merchant_ops','workspace_members','status','UPDATE') AS allowed`,
      )
      expect(statusUpdatePrivilege.rows[0]?.allowed).toBe(true)

      await ops.query('BEGIN')
      await ops.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceA])
      // Platform scope intentionally broadens SELECT, never tenant-scoped UPDATE.
      await ops.query("SELECT set_config('app.platform_scope','platform_ops',true)")
      expect((await ops.query('SELECT id FROM workspace_members WHERE id=$1', [memberB])).rows).toEqual([{ id: memberB }])
      const attemptedUpdate = await ops.query(
        `UPDATE workspace_members SET status='active', revision=revision+1, updated_at=now() WHERE id=$1`,
        [memberB],
      )
      expect(attemptedUpdate.rowCount).toBe(0)
      await ops.query('COMMIT')

      const persisted = await database.query<{ status: string; revision: number }>(
        'SELECT status,revision FROM workspace_members WHERE id=$1', [memberB],
      )
      expect(persisted.rows).toEqual([{ status: 'invited', revision: 1 }])
    } finally {
      if (ops) {
        try { await ops.query('ROLLBACK') } catch { /* transaction may already be committed */ }
        await ops.end()
      }
      await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
