import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner, type Migration } from './migration.js'
import { PostgresCreativePointRepository } from './creative-point-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseUrl(base: URL, name: string, user?: string, password?: string) {
  const result = new URL(base)
  result.pathname = `/${name}`
  if (user) result.username = user
  if (password) result.password = password
  return result.toString()
}

describe('creative-point PostgreSQL E2 release gate', () => {
  postgresIt('proves fresh/repeat/interrupted migration, FORCE RLS, tenant FKs, append-only facts, and 200-way reservation safety', async () => {
    const base = new URL(databaseUrlValue!)
    const suffix = randomUUID().replaceAll('-', '')
    const databaseName = `creative_point_e2_${suffix}`
    const interruptedName = `creative_point_interrupted_${suffix}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let interrupted: Pool | undefined
    let app: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      await admin.query(`CREATE DATABASE "${interruptedName}"`)
      database = new Pool({ connectionString: databaseUrl(base, databaseName) })
      interrupted = new Pool({ connectionString: databaseUrl(base, interruptedName) })
      const migrations = await loadMigrations()

      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])
      expect((await database.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version))
        .toEqual(migrations.map(item => item.version))

      const interruptedMigrations: Migration[] = [
        { version: 1, name: 'baseline', sql: 'CREATE TABLE retained_fact (id integer PRIMARY KEY)' },
        { version: 2, name: 'injected_failure', sql: 'CREATE TABLE must_rollback (id integer); SELECT 1/0' },
      ]
      await expect(new MigrationRunner(interrupted, interruptedMigrations).run()).rejects.toThrow()
      expect((await interrupted.query<{ name: string | null }>("SELECT to_regclass('public.retained_fact')::text AS name")).rows[0]?.name).toBe('retained_fact')
      expect((await interrupted.query<{ name: string | null }>("SELECT to_regclass('public.must_rollback')::text AS name")).rows[0]?.name).toBeNull()
      expect((await interrupted.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')).rows).toEqual([{ version: 1 }])
      const repairedMigrations: Migration[] = [
        interruptedMigrations[0]!,
        { version: 2, name: 'injected_failure', sql: 'CREATE TABLE recovered_fact (id integer PRIMARY KEY)' },
      ]
      await expect(new MigrationRunner(interrupted, repairedMigrations).run()).resolves.toEqual([2])
      await expect(new MigrationRunner(interrupted, repairedMigrations).run()).resolves.toEqual([])

      await database.query("INSERT INTO workspaces (id,status) VALUES ('creative_ws_a','active'),('creative_ws_b','active')")
      app = new Pool({
        connectionString: databaseUrl(base, databaseName, 'merchant_app', 'merchant_app_local_only'),
        max: 24,
      })
      const repository = new PostgresCreativePointRepository(app)
      await repository.grant({
        workspaceId: 'creative_ws_a', idempotencyKey: 'grant-a', sourceType: 'paid_order', sourceId: 'order-a', points: 100,
        expiresAt: '2026-10-01T00:00:00.000Z', at: '2026-09-01T00:00:00.000Z',
      })
      await repository.grant({
        workspaceId: 'creative_ws_a', idempotencyKey: 'grant-later', sourceType: 'paid_order', sourceId: 'order-later', points: 100,
        expiresAt: '2026-11-01T00:00:00.000Z', at: '2026-09-01T00:00:01.000Z',
      })
      await repository.grant({
        workspaceId: 'creative_ws_b', idempotencyKey: 'grant-b', sourceType: 'paid_order', sourceId: 'order-b', points: 1,
        at: '2026-09-01T00:00:00.000Z',
      })
      await repository.reserve({
        workspaceId: 'creative_ws_b', idempotencyKey: 'reserve-b', actionKey: 'image.generate.standard',
        rateCardVersion: 'rate-approved-v1', points: 1, at: '2026-09-01T00:00:01.000Z',
      })

      const policyState = await database.query<{
        tableName: string
        enabled: boolean
        forced: boolean
        usingPolicy: boolean
        checkPolicy: boolean
      }>(`SELECT c.relname AS "tableName", c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
          p.polqual IS NOT NULL AS "usingPolicy", p.polwithcheck IS NOT NULL AS "checkPolicy"
        FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
        JOIN pg_policy p ON p.polrelid=c.oid
       WHERE c.relname = ANY($1::text[])
       ORDER BY c.relname`, [[
        'creative_point_access_state', 'creative_point_allocations', 'creative_point_grants',
        'creative_point_ledger_events', 'creative_point_operations', 'creative_point_reservations',
      ]])
      expect(policyState.rows).toHaveLength(6)
      expect(policyState.rows.every(row => row.enabled && row.forced && row.usingPolicy && row.checkPolicy)).toBe(true)
      const tenantForeignKeys = await database.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname IN (
         'creative_point_grants_operation_fk', 'creative_point_reservations_operation_fk',
         'creative_point_allocations_reservation_fk', 'creative_point_allocations_grant_fk',
         'creative_point_ledger_operation_fk'
       )
       ORDER BY conname`)
      expect(tenantForeignKeys.rows).toHaveLength(5)
      expect(tenantForeignKeys.rows.every(row => row.definition.includes('FOREIGN KEY (workspace_id,')
        && row.definition.includes('REFERENCES') && row.definition.includes('(workspace_id, id)'))).toBe(true)
      expect((await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_trigger
        WHERE NOT tgisinternal AND tgname IN (
          'creative_point_grants_append_only','creative_point_grants_no_truncate',
          'creative_point_allocations_append_only','creative_point_allocations_no_truncate',
          'creative_point_ledger_events_append_only','creative_point_ledger_events_no_truncate'
        )`)).rows[0]?.count).toBe(6)

      const appClient = await app.connect()
      try {
        await appClient.query('BEGIN')
        await appClient.query("SELECT set_config('app.workspace_id','creative_ws_a',true)")
        expect((await appClient.query('SELECT DISTINCT workspace_id FROM creative_point_grants ORDER BY workspace_id')).rows)
          .toEqual([{ workspace_id: 'creative_ws_a' }])
        await expect(appClient.query(`INSERT INTO creative_point_operations
          (id,workspace_id,kind,idempotency_key,status,request,completed_at)
          VALUES ('forged-op','creative_ws_b','grant','forged','completed','{}'::jsonb,now())`))
          .rejects.toMatchObject({ code: '42501' })
        await appClient.query('ROLLBACK')

        const facts = await database.query<{
          grantId: string
          operationId: string
          reservationId: string
        }>(`SELECT g.id AS "grantId", g.operation_id AS "operationId", r.id AS "reservationId"
          FROM creative_point_grants g
          CROSS JOIN creative_point_reservations r
         WHERE g.workspace_id='creative_ws_a' AND g.source_id='order-a'
           AND r.workspace_id='creative_ws_b'
         LIMIT 1`)
        const fact = facts.rows[0]!
        await appClient.query('BEGIN')
        await appClient.query("SELECT set_config('app.workspace_id','creative_ws_a',true)")
        await expect(appClient.query(`INSERT INTO creative_point_allocations
          (id,workspace_id,reservation_id,grant_id,allocation_type,points_delta)
          VALUES ('cross-tenant-allocation','creative_ws_a',$1,$2,'reserve',1)`, [fact.reservationId, fact.grantId]))
          .rejects.toMatchObject({ code: '23514' })
        await appClient.query('ROLLBACK')
      } finally {
        appClient.release()
      }

      const reservations = await Promise.allSettled(Array.from({ length: 200 }, (_, index) => repository.reserve({
        workspaceId: 'creative_ws_a', idempotencyKey: `reserve-${index}`, actionKey: 'image.generate.standard',
        rateCardVersion: 'rate-approved-v1', points: 1, at: '2026-09-02T00:00:00.000Z',
      })))
      expect(reservations.filter(result => result.status === 'fulfilled')).toHaveLength(200)
      expect(await repository.getBalance('creative_ws_a', '2026-09-02T00:00:00.000Z'))
        .toMatchObject({ availablePoints: 0, reservedPoints: 200, settledPoints: 0, revision: 202 })
      const allocationOrder = await database.query<{ sourceId: string; allocated: string }>(`SELECT g.source_id AS "sourceId", sum(a.points_delta)::text AS allocated
        FROM creative_point_allocations a
        JOIN creative_point_grants g ON g.workspace_id=a.workspace_id AND g.id=a.grant_id
       WHERE a.workspace_id='creative_ws_a'
       GROUP BY g.source_id,g.expires_at
       ORDER BY g.expires_at`)
      expect(allocationOrder.rows).toEqual([
        { sourceId: 'order-a', allocated: '100' },
        { sourceId: 'order-later', allocated: '100' },
      ])
      const overflow = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => repository.reserve({
        workspaceId: 'creative_ws_a', idempotencyKey: `overflow-${index}`, actionKey: 'image.generate.standard',
        rateCardVersion: 'rate-approved-v1', points: 1, at: '2026-09-02T00:00:01.000Z',
      })))
      expect(overflow.every(result => result.status === 'rejected')).toBe(true)
      expect(await repository.getBalance('creative_ws_a', '2026-09-02T00:00:01.000Z'))
        .toMatchObject({ availablePoints: 0, reservedPoints: 200 })

      const immutableClient = await app.connect()
      try {
        await immutableClient.query('BEGIN')
        await immutableClient.query("SELECT set_config('app.workspace_id','creative_ws_a',true)")
        for (const table of ['creative_point_grants', 'creative_point_allocations', 'creative_point_ledger_events']) {
          await expect(immutableClient.query(`UPDATE ${table} SET created_at=created_at`)).rejects.toMatchObject({ code: '42501' })
          await immutableClient.query('ROLLBACK')
          await immutableClient.query('BEGIN')
          await immutableClient.query("SELECT set_config('app.workspace_id','creative_ws_a',true)")
          await expect(immutableClient.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '42501' })
          await immutableClient.query('ROLLBACK')
          await immutableClient.query('BEGIN')
          await immutableClient.query("SELECT set_config('app.workspace_id','creative_ws_a',true)")
          await expect(immutableClient.query(`TRUNCATE ${table}`)).rejects.toMatchObject({ code: '42501' })
          await immutableClient.query('ROLLBACK')
          await immutableClient.query('BEGIN')
          await immutableClient.query("SELECT set_config('app.workspace_id','creative_ws_a',true)")
        }
        await immutableClient.query('ROLLBACK')
      } finally {
        immutableClient.release()
      }
      for (const table of ['creative_point_grants', 'creative_point_allocations', 'creative_point_ledger_events']) {
        await expect(database.query(`UPDATE ${table} SET created_at=created_at`)).rejects.toMatchObject({ code: '55000' })
        await expect(database.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '55000' })
        const truncateError = await database.query(`TRUNCATE ${table}`).then(() => undefined, error => error as { code?: string })
        expect(['55000', '0A000']).toContain(truncateError?.code)
      }
    } finally {
      await app?.end()
      await database?.end()
      await interrupted?.end()
      for (const name of [databaseName, interruptedName]) {
        let active = 1
        for (let attempt = 0; attempt < 80 && active > 0; attempt += 1) {
          active = Number((await admin.query<{ count: string }>('SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1', [name])).rows[0]?.count ?? 0)
          if (active > 0) await new Promise(resolve => setTimeout(resolve, 25))
        }
        expect(active, `database clients did not close for ${name}`).toBe(0)
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      }
      await admin.end()
    }
  }, 300_000)
})
