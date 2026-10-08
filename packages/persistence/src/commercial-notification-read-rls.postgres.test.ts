import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL

describe.skipIf(!source)('commercial notification read-state tenant/member RLS', () => {
  const databaseName = `notification_read_rls_${randomUUID().replaceAll('-', '')}`
  const workspaceA = `notification-read-a-${randomUUID()}`
  const workspaceB = `notification-read-b-${randomUUID()}`
  const memberA = randomUUID()
  const memberOther = randomUUID()
  const memberB = randomUUID()
  let admin: Pool | undefined
  let database: Pool | undefined
  let app: Pool | undefined

  beforeAll(async () => {
    const base = new URL(source!)
    admin = new Pool({ connectionString: base.toString(), connectionTimeoutMillis: 10_000 })
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    base.pathname = `/${databaseName}`
    database = new Pool({ connectionString: base.toString(), max: 4 })
    await database.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
    const migrations = await loadMigrations()
    await new MigrationRunner(database, migrations).run()
    await database.query("INSERT INTO workspaces(id,status) VALUES ($1,'active'),($2,'active')", [workspaceA, workspaceB])
    await database.query(`
      INSERT INTO workspace_members(id,workspace_id,external_subject,display_name,role,status,invited_by)
      VALUES ($1,$4,'read-a','Member A','merchant_admin','active','fixture'),
             ($2,$4,'read-other','Other Member','merchant_admin','active','fixture'),
             ($3,$5,'read-b','Member B','merchant_admin','active','fixture')
    `, [memberA, memberOther, memberB, workspaceA, workspaceB])
    await database.query(`
      INSERT INTO workspace_commercial_notification_reads(workspace_id,member_id,notification_id)
      VALUES ($1,$2,'notification-a'),($1,$3,'notification-other'),($4,$5,'notification-b')
    `, [workspaceA, memberA, memberOther, workspaceB, memberB])
    const appUrl = new URL(base)
    appUrl.username = 'merchant_app'
    appUrl.password = 'merchant_app_local_only'
    app = new Pool({ connectionString: appUrl.toString(), max: 1 })
  }, 120_000)

  afterAll(async () => {
    await app?.end()
    await database?.end()
    if (admin) {
      try { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`) }
      finally { await admin.end() }
    }
  }, 60_000)

  it('limits read receipts and idempotency requests to the current workspace and member', async () => {
    const client = await app!.connect()
    await client.query('BEGIN')
    try {
      await client.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.member_id',$2,true)", [workspaceA, memberA])
      expect((await client.query('SELECT notification_id FROM workspace_commercial_notification_reads ORDER BY notification_id')).rows)
        .toEqual([{ notification_id: 'notification-a' }])

      await client.query("SELECT set_config('app.member_id',$1,true)", [memberOther])
      expect((await client.query('SELECT notification_id FROM workspace_commercial_notification_reads ORDER BY notification_id')).rows)
        .toEqual([{ notification_id: 'notification-other' }])
      await client.query("SELECT set_config('app.member_id',$1,true)", [memberA])

      await client.query(`INSERT INTO workspace_commercial_notification_reads(workspace_id,member_id,notification_id) VALUES($1,$2,'notification-new')`, [workspaceA, memberA])
      await client.query(`INSERT INTO workspace_commercial_notification_read_requests(workspace_id,member_id,idempotency_key,notification_id,read_at) VALUES($1,$2,'read-request-owned','notification-new',now())`, [workspaceA, memberA])
      expect((await client.query('SELECT idempotency_key FROM workspace_commercial_notification_read_requests')).rows)
        .toEqual([{ idempotency_key: 'read-request-owned' }])

      await client.query('SAVEPOINT reject_foreign_member_read')
      await expect(client.query(`INSERT INTO workspace_commercial_notification_reads(workspace_id,member_id,notification_id) VALUES($1,$2,'forged-member')`, [workspaceA, memberOther]))
        .rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT reject_foreign_member_read')
      await client.query('RELEASE SAVEPOINT reject_foreign_member_read')

      await client.query('SAVEPOINT reject_foreign_workspace_read')
      await expect(client.query(`INSERT INTO workspace_commercial_notification_reads(workspace_id,member_id,notification_id) VALUES($1,$2,'forged-workspace')`, [workspaceB, memberB]))
        .rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT reject_foreign_workspace_read')
      await client.query('RELEASE SAVEPOINT reject_foreign_workspace_read')

      await client.query('SAVEPOINT reject_foreign_member_request')
      await expect(client.query(`INSERT INTO workspace_commercial_notification_read_requests(workspace_id,member_id,idempotency_key,notification_id,read_at) VALUES($1,$2,'foreign-member-request','notification-other',now())`, [workspaceA, memberOther]))
        .rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT reject_foreign_member_request')
      await client.query('RELEASE SAVEPOINT reject_foreign_member_request')

      await client.query('SAVEPOINT reject_foreign_workspace_request')
      await expect(client.query(`INSERT INTO workspace_commercial_notification_read_requests(workspace_id,member_id,idempotency_key,notification_id,read_at) VALUES($1,$2,'foreign-space-request','notification-b',now())`, [workspaceB, memberB]))
        .rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT reject_foreign_workspace_request')
      await client.query('RELEASE SAVEPOINT reject_foreign_workspace_request')
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }

    // Request-local scope must not survive reuse of the same pooled connection.
    expect((await app!.query('SELECT notification_id FROM workspace_commercial_notification_reads')).rows).toEqual([])
    expect((await app!.query('SELECT idempotency_key FROM workspace_commercial_notification_read_requests')).rows).toEqual([])
  }, 30_000)
})
