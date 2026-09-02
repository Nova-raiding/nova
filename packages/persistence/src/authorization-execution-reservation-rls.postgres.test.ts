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

describe('authorization execution reservation RLS/ACL PostgreSQL probe', () => {
  postgresIt('fails closed for app writes, requires platform scope, and keeps reservations append-only', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_authz_reservation_acl_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let ops: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])

      const subjectIdentityId = randomUUID()
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('authz_reservation_ws','active')`)
      await database.query(
        `INSERT INTO platform_identities (id,issuer,external_subject,display_name) VALUES ($1,'reservation-rls-probe',$2,'Reservation RLS Probe')`,
        [subjectIdentityId, `reservation-${subjectIdentityId}`],
      )

      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 1 })
      await expect(app.query(`
        INSERT INTO authorization_execution_reservations
          (reservation_id,event_id,decision_id,subject_identity_id,workspace_id,capability,resource_id,scope_hash,authorization_revision,reserved_at)
        VALUES
          ('app-denied-reservation','app-denied-event','app-denied-decision',$1,'authz_reservation_ws','customer.content.update','task-app-denied',$2,0,'2026-09-02T10:00:00.000Z')
      `, [subjectIdentityId, 'a'.repeat(64)])).rejects.toMatchObject({ code: '42501' })

      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only'), max: 1 })
      await expect(ops.query(`
        INSERT INTO authorization_execution_reservations
          (reservation_id,event_id,decision_id,subject_identity_id,workspace_id,capability,resource_id,scope_hash,authorization_revision,reserved_at)
        VALUES
          ('ops-unscoped-reservation','ops-unscoped-event','ops-unscoped-decision',$1,'authz_reservation_ws','customer.content.update','task-unscoped',$2,0,'2026-09-02T10:00:00.000Z')
      `, [subjectIdentityId, 'b'.repeat(64)])).rejects.toMatchObject({ code: '42501' })

      const insertedReservationId = `reservation-${subjectIdentityId}`
      await ops.query('BEGIN')
      await ops.query("SELECT set_config('app.platform_scope', 'platform_ops', true)")
      const inserted = await ops.query<{ reservation_id: string }>(`
        INSERT INTO authorization_execution_reservations
          (reservation_id,event_id,decision_id,subject_identity_id,workspace_id,capability,resource_id,scope_hash,authorization_revision,reserved_at)
        VALUES
          ($1,$2,$3,$4,'authz_reservation_ws','customer.content.update','task-scoped',$5,0,'2026-09-02T10:00:00.000Z')
        RETURNING reservation_id
      `, [insertedReservationId, `event-${subjectIdentityId}`, `decision-${subjectIdentityId}`, subjectIdentityId, 'c'.repeat(64)])
      expect(inserted.rows).toEqual([{ reservation_id: insertedReservationId }])
      await ops.query('COMMIT')

      await ops.query('BEGIN')
      await ops.query("SELECT set_config('app.platform_scope', 'platform_ops', true)")
      await expect(ops.query(
        `UPDATE authorization_execution_reservations SET resource_id='task-mutated' WHERE reservation_id=$1`,
        [insertedReservationId],
      )).rejects.toMatchObject({ code: '42501' })
      await ops.query('ROLLBACK')

      await ops.query('BEGIN')
      await ops.query("SELECT set_config('app.platform_scope', 'platform_ops', true)")
      await expect(ops.query(
        `DELETE FROM authorization_execution_reservations WHERE reservation_id=$1`,
        [insertedReservationId],
      )).rejects.toMatchObject({ code: '42501' })
      await ops.query('ROLLBACK')

      expect((await database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM authorization_execution_reservations WHERE reservation_id=$1`,
        [insertedReservationId],
      )).rows).toEqual([{ count: '1' }])

      const acl = await database.query<{ role: string; can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }>(`
        SELECT role_name AS role,
               has_table_privilege(role_name, 'authorization_execution_reservations', 'SELECT') AS can_select,
               has_table_privilege(role_name, 'authorization_execution_reservations', 'INSERT') AS can_insert,
               has_table_privilege(role_name, 'authorization_execution_reservations', 'UPDATE') AS can_update,
               has_table_privilege(role_name, 'authorization_execution_reservations', 'DELETE') AS can_delete
        FROM unnest(ARRAY['merchant_app','merchant_ops']::text[]) AS roles(role_name)
        ORDER BY role_name
      `)
      expect(acl.rows).toEqual([
        { role: 'merchant_app', can_select: false, can_insert: false, can_update: false, can_delete: false },
        { role: 'merchant_ops', can_select: true, can_insert: true, can_update: false, can_delete: false },
      ])
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
