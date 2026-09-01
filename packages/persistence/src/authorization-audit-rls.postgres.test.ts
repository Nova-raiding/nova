import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const databaseConnection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('authorization decision audit PostgreSQL reconstruction boundary', () => {
  postgresIt('reconstructs only the active workspace and rejects cross-scope or mutable audit access', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_authz_audit_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let ops: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseConnection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))

      await database.query(`GRANT SELECT, INSERT ON workspace_operation_audit TO merchant_app`)
      await database.query(`GRANT SELECT ON workspace_operation_audit TO merchant_ops`)
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('audit_scope_a','active'), ('audit_scope_b','active')`)
      const auditA = randomUUID()
      const auditB = randomUUID()
      await database.query(`
        INSERT INTO workspace_operation_audit
          (id,workspace_id,actor_id,action,resource_type,resource_id,after_json,reason)
        VALUES
          ($1,'audit_scope_a','actor-a','authz.decision','mcp_method','ops.member.list',
            '{"decision_id":"decision-a","result":"deny","request_id":"request-a","trace_id":"trace-a"}', 'scope probe'),
          ($2,'audit_scope_b','actor-b','authz.decision','mcp_method','ops.member.list',
            '{"decision_id":"decision-b","result":"allow","request_id":"request-b","trace_id":"trace-b"}', 'scope probe')
      `, [auditA, auditB])

      app = new Pool({ connectionString: databaseConnection(base, databaseName, 'merchant_app', 'merchant_app_local_only') })
      for (const workspaceId of ['audit_scope_a', 'audit_scope_b']) {
        await app.query('BEGIN')
        await app.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId])
        const rows = await app.query<{ id: string; workspace_id: string; decision_id: string }>(
          `SELECT id, workspace_id, after_json->>'decision_id' AS decision_id FROM workspace_operation_audit ORDER BY id`,
        )
        expect(rows.rows).toHaveLength(1)
        expect(rows.rows[0]).toMatchObject({ workspace_id: workspaceId, decision_id: workspaceId.endsWith('_a') ? 'decision-a' : 'decision-b' })
        await app.query('COMMIT')
      }

      await app.query('BEGIN')
      await app.query("SELECT set_config('app.workspace_id', 'audit_scope_a', true)")
      await expect(app.query(
        `INSERT INTO workspace_operation_audit (id,workspace_id,actor_id,action,resource_type,resource_id)
         VALUES ($1,'audit_scope_b','forged','authz.decision','mcp_method','ops.member.list')`,
        [randomUUID()],
      )).rejects.toMatchObject({ code: '42501' })
      await app.query('ROLLBACK')

      await expect(app.query(`UPDATE workspace_operation_audit SET reason='tampered' WHERE id=$1`, [auditA])).rejects.toMatchObject({ code: '42501' })
      await expect(app.query(`DELETE FROM workspace_operation_audit WHERE id=$1`, [auditA])).rejects.toMatchObject({ code: '42501' })
      await expect(app.query('TRUNCATE workspace_operation_audit')).rejects.toMatchObject({ code: '42501' })

      ops = new Pool({ connectionString: databaseConnection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only') })
      await ops.query('BEGIN')
      await ops.query("SELECT set_config('app.platform_scope', 'platform_ops', true)")
      expect((await ops.query('SELECT id FROM workspace_operation_audit ORDER BY id')).rows).toEqual([])
      await ops.query('COMMIT')

      expect((await database.query<{ count: number }>('SELECT count(*)::int AS count FROM workspace_operation_audit')).rows).toEqual([{ count: 2 }])
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
