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

describe('authorization RLS/ACL boundary PostgreSQL probe', () => {
  postgresIt('does not leak platform scope and protects both authorization event ledgers', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_authz_boundary_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let ops: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))

      const identityId = randomUUID()
      const assignmentId = randomUUID()
      const grantId = randomUUID()
      const now = '2026-09-01T10:00:00.000Z'
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('boundary_ws','active')`)
      await database.query(`INSERT INTO platform_identities (id,issuer,external_subject,display_name) VALUES ($1,'boundary-probe',$2,'Boundary Probe')`, [identityId, `subject-${identityId}`])
      await database.query(`INSERT INTO authorization_revisions (subject_identity_id,revision,updated_by,update_reason) VALUES ($1,1,'probe','boundary regression')`, [identityId])
      await database.query(`INSERT INTO platform_role_assignments (id,subject_identity_id,role,assigned_by,reason,valid_from,authorization_revision) VALUES ($1,$2,'support_agent','probe','boundary regression',$3,1)`, [assignmentId, identityId, now])
      await database.query(`INSERT INTO ops_access_grants (id,grant_kind,access_mode,subject_identity_id,workspace_id,capabilities,resource_scope,scope_hash,reason,ticket_ref,issued_by,approved_by,approved_at,issued_at,expires_at,max_uses,authorization_revision) VALUES ($1,'support','read',$2,'boundary_ws',ARRAY['customer.content.read'], '{"ticket_ids":["boundary-ticket"]}', $3,'boundary regression','BOUNDARY-1','issuer','approver',$4,$4,$5,1,1)`, [grantId, identityId, 'a'.repeat(64), now, '2026-09-01T10:15:00.000Z'])
      await database.query(`INSERT INTO platform_role_assignment_events (id,assignment_id,subject_identity_id,event_type,actor_id,reason,authorization_revision,assignment_revision,snapshot_json,created_at) VALUES ($1,$2,$3,'assigned','probe','boundary regression',1,1,'{}',$4)`, [randomUUID(), assignmentId, identityId, now])
      await database.query(`INSERT INTO ops_access_grant_events (id,grant_id,subject_identity_id,workspace_id,event_type,actor_id,reason,authorization_revision,grant_revision,snapshot_json,created_at) VALUES ($1,$2,$3,'boundary_ws','issued','probe','boundary regression',1,1,'{}',$4)`, [randomUUID(), grantId, identityId, now])

      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only') })
      for (const table of ['platform_role_assignments', 'platform_role_assignment_events', 'ops_access_grants', 'ops_access_grant_events']) {
        await expect(app.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: '42501' })
      }

      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only') })
      await ops.query('BEGIN')
      await ops.query("SELECT set_config('app.platform_scope','platform_ops',true)")
      const summaries = await ops.query('SELECT workspace_id, status, plan_name, used_tasks, included_tasks, subscription_status, member_count, created_at FROM ops_workspace_summaries ORDER BY workspace_id')
      expect(summaries.rows).toHaveLength(1)
      expect(summaries.rows[0]).toMatchObject({ workspace_id: 'boundary_ws', status: 'active' })
      expect(Object.keys(summaries.rows[0]!).sort()).toEqual([
        'created_at', 'included_tasks', 'member_count', 'plan_name', 'status',
        'subscription_status', 'used_tasks', 'workspace_id',
      ])
      await ops.query('COMMIT')
      for (const table of ['workspace_operation_audit', 'products', 'content_versions']) {
        await expect(ops.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: '42501' })
      }
      expect((await ops.query('SELECT * FROM ops_access_grants')).rows).toEqual([])
      await ops.query('BEGIN')
      await ops.query("SELECT set_config('app.platform_scope','not-platform',true)")
      expect((await ops.query('SELECT * FROM ops_access_grants')).rows).toEqual([])
      await expect(ops.query(`INSERT INTO authorization_revisions (subject_identity_id,revision,updated_by,update_reason) VALUES ($1,2,'probe','wrong scope')`, [identityId])).rejects.toMatchObject({ code: '42501' })
      await ops.query('ROLLBACK')

      await ops.query('BEGIN')
      await ops.query("SELECT set_config('app.platform_scope','platform_ops',true)")
      expect((await ops.query('SELECT id FROM ops_access_grants WHERE id=$1', [grantId])).rows).toEqual([{ id: grantId }])
      await ops.query('COMMIT')
      expect((await ops.query('SELECT * FROM ops_access_grants')).rows).toEqual([])

      const eventIds = await database.query<{ role_event_id: string; grant_event_id: string }>(`SELECT
        (SELECT id FROM platform_role_assignment_events WHERE assignment_id=$1) AS role_event_id,
        (SELECT id FROM ops_access_grant_events WHERE grant_id=$2) AS grant_event_id`, [assignmentId, grantId])
      const eventRow = eventIds.rows[0]
      expect(eventRow).toBeDefined()
      const { role_event_id: roleEventId, grant_event_id: grantEventId } = eventRow!
      await expect(database.query(`UPDATE platform_role_assignment_events SET reason='tampered' WHERE id=$1`, [roleEventId])).rejects.toThrow(/append-only/u)
      await expect(database.query(`DELETE FROM ops_access_grant_events WHERE id=$1`, [grantEventId])).rejects.toThrow(/append-only/u)
      const acl = await database.query(`SELECT
        has_table_privilege('merchant_ops','platform_role_assignment_events','UPDATE') AS role_update,
        has_table_privilege('merchant_ops','ops_access_grant_events','DELETE') AS grant_delete`)
      expect(acl.rows).toEqual([{ role_update: false, grant_delete: false }])
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
