import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresMembersRepository } from './members-repository.js'
import type { SqlPool } from './repository.js'

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


describe('member directory snapshot and owner governance concurrency', () => {
  postgresIt('keeps directory totals and rows on one snapshot during a concurrent insert', async () => {
    const admin = new Pool({ connectionString: databaseUrlValue!, max: 2 })
    const workspaceId = `member_snapshot_${randomUUID()}`
    const opsUrl = new URL(databaseUrlValue!); opsUrl.username = 'merchant_ops'; opsUrl.password = 'merchant_ops_local_only'
    const ops = new Pool({ connectionString: opsUrl.toString(), max: 1 })
    try {
      await admin.query("INSERT INTO workspaces(id,status) VALUES ($1,'active')", [workspaceId])
      const insert = (subject: string) => admin.query("INSERT INTO workspace_members(id,workspace_id,external_subject,display_name,role,status,invited_by) VALUES ($1,$2,$3,$3,'operator','active','probe')", [randomUUID(), workspaceId, subject])
      await insert('before')
      let inserted = false
      const intercepted = { connect: async () => {
        const client = await ops.connect()
        return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values)
          if (sql.includes('count(DISTINCT "workspaceId")') && !inserted) { inserted = true; await insert('after') }
          return result
        } }
      } } as SqlPool
      const repository = new PostgresMembersRepository(admin, intercepted)
      const page = await repository.searchWindow!({ workspaceIds: [workspaceId], offset: 0, limit: 10 })
      expect(inserted).toBe(true)
      expect(page.total).toBe(1)
      expect(page.items.map(row => row.externalSubject)).toEqual(['before'])
      expect((await admin.query('SELECT count(*)::int AS count FROM workspace_members WHERE workspace_id=$1', [workspaceId])).rows[0].count).toBe(2)
    } finally { await ops.end(); await admin.end() }
  }, 30_000)

  postgresIt('keeps tenant page rows, total and owner count on one snapshot', async () => {
    const admin = new Pool({ connectionString: databaseUrlValue!, max: 2 })
    const workspaceId = `member_tenant_snapshot_${randomUUID()}`
    const appUrl = new URL(databaseUrlValue!); appUrl.username = 'merchant_app'; appUrl.password = 'merchant_app_local_only'
    const app = new Pool({ connectionString: appUrl.toString(), max: 1 })
    try {
      await admin.query("INSERT INTO workspaces(id,status) VALUES ($1,'active')", [workspaceId])
      const insert = (subject: string) => admin.query("INSERT INTO workspace_members(id,workspace_id,external_subject,display_name,role,status,invited_by) VALUES ($1,$2,$3,$3,'workspace_owner','active','probe')", [randomUUID(), workspaceId, subject])
      await insert('before')
      let inserted = false
      const intercepted = { connect: async () => {
        const client = await app.connect()
        return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values)
          if (sql.includes('LIMIT $2 OFFSET $3') && !inserted) { inserted = true; await insert('after') }
          return result
        } }
      } } as SqlPool
      const page = await new PostgresMembersRepository(intercepted).listPage(workspaceId, { offset: 0, limit: 10 })
      expect(inserted).toBe(true)
      expect(page).toMatchObject({ total: 1, activeOwnerCount: 1, hasMore: false })
      expect(page.items.map(row => row.externalSubject)).toEqual(['before'])
      expect((await admin.query('SELECT count(*)::int AS count FROM workspace_members WHERE workspace_id=$1', [workspaceId])).rows[0].count).toBe(2)
    } finally { await app.end(); await admin.end() }
  }, 30_000)

  postgresIt.each(['suspend', 'demote'] as const)('allows only one concurrent owner %s and audits only the committed change', async mode => {
    const admin = new Pool({ connectionString: databaseUrlValue!, max: 2 })
    const appUrl = new URL(databaseUrlValue!); appUrl.username = 'merchant_app'; appUrl.password = 'merchant_app_local_only'
    const app = new Pool({ connectionString: appUrl.toString(), max: 3 })
    const workspaceId = `member_owners_${randomUUID()}`
    try {
      await admin.query("INSERT INTO workspaces(id,status) VALUES ($1,'active')", [workspaceId])
      for (const subject of ['owner_a', 'owner_b']) await admin.query("INSERT INTO workspace_members(id,workspace_id,external_subject,display_name,role,status,invited_by) VALUES ($1,$2,$3,$3,'workspace_owner','active','probe')", [randomUUID(), workspaceId, subject])
      const repository = new PostgresMembersRepository(app)
      const blocker = await admin.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 FOR UPDATE', [workspaceId])
        const requests = ['owner_a', 'owner_b'].map(externalSubject => {
          const common = { workspaceId, externalSubject, expectedRevision: 1, actorId: externalSubject === 'owner_a' ? 'owner_b' : 'owner_a', action: 'member.governance', reason: 'concurrent governance verification', preserveActiveOwner: true }
          return mode === 'suspend'
            ? repository.changeStatusWithAudit({ ...common, targetStatus: 'suspended' })
            : repository.upsertWithAudit({ ...common, displayName: externalSubject, role: 'operator', status: 'active' })
        })
        const settled = Promise.allSettled(requests)
        let waiting = false
        for (let i = 0; i < 200; i++) {
          const row = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename='merchant_app' AND wait_event_type='Lock'")
          if (row.rows[0].count >= 2) { waiting = true; break }
          await new Promise(resolve => setTimeout(resolve, 15))
        }
        await blocker.query('COMMIT')
        const outcomes = await settled
        expect(waiting).toBe(true)
        expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1)
        expect(outcomes.filter(row => row.status === 'rejected')).toMatchObject([{ reason: { message: 'LAST_WORKSPACE_OWNER_REQUIRED' } }])
        expect((await admin.query("SELECT count(*)::int AS count FROM workspace_members WHERE workspace_id=$1 AND role='workspace_owner' AND status='active'", [workspaceId])).rows[0].count).toBe(1)
        expect((await admin.query('SELECT count(*)::int AS count FROM workspace_operation_audit WHERE workspace_id=$1', [workspaceId])).rows[0].count).toBe(1)
        const remaining = (await repository.list(workspaceId)).find(row => row.role === 'workspace_owner' && row.status === 'active')!
        await repository.changeStatusWithAudit({ workspaceId, externalSubject: remaining.externalSubject, targetStatus: 'suspended', expectedRevision: remaining.revision, actorId: 'platform-operator', action: 'platform.member.suspend', reason: 'explicit platform override verification', preserveActiveOwner: false })
        expect((await admin.query("SELECT count(*)::int AS count FROM workspace_members WHERE workspace_id=$1 AND role='workspace_owner' AND status='active'", [workspaceId])).rows[0].count).toBe(0)
        expect((await admin.query('SELECT count(*)::int AS count FROM workspace_operation_audit WHERE workspace_id=$1', [workspaceId])).rows[0].count).toBe(2)
      } finally { await blocker.query('ROLLBACK'); blocker.release() }
    } finally { await app.end(); await admin.end() }
  }, 30_000)
})
