import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner, type Migration } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseUrl(base: URL, databaseName: string) {
  const url = new URL(base)
  url.pathname = `/${databaseName}`
  return url.toString()
}

async function dropIsolatedDatabase(admin: Pool, database: Pool | undefined, databaseName: string) {
  await database?.end()
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
  await admin.end()
}

async function insertWorkspace(database: Pool, workspaceId: string) {
  await database.query('INSERT INTO workspaces (id,status) VALUES ($1,$2)', [workspaceId, 'active'])
}

async function insertReservation(database: Pool, input: { workspaceId: string; reservationKey: string; runKey: string }) {
  await database.query(`INSERT INTO model_cost_budget_reservations
    (workspace_id,budget_date,reservation_key,run_key,modality,model,estimate_cny,estimate_version,daily_limit_cny,run_limit_cny,status)
    VALUES ($1,'2026-08-31',$2,$3,'text','relay-text',0.1,'pricing-v1',10,1,'active')`,
  [input.workspaceId, input.reservationKey, input.runKey])
}

async function insertUsage(database: Pool | PoolClient, input: { id: string; workspaceId: string; reservationKey?: string; runKey?: string }) {
  await database.query(`INSERT INTO model_usage_ledger
    (id,workspace_id,receipt_key,receipt_hash,modality,model,provider_request_id,cost_cny,settlement_status,budget_reservation_key,budget_run_key)
    VALUES ($1,$2,$3,$4,'text','relay-text',$5,0.01,'pending_wallet',$6,$7)`, [
    input.id,
    input.workspaceId,
    `receipt:${input.id}`,
    `hash:${input.id}`,
    `provider:${input.id}`,
    input.reservationKey ?? null,
    input.runKey ?? null,
  ])
}

function migration118(migrations: readonly Migration[]) {
  const migration = migrations.find(item => item.version === 118)
  if (!migration) throw new Error('migration 118 is not registered')
  return migration
}

describe('migration 118 PostgreSQL model usage budget run linkage', () => {
  postgresIt('blocks mismatched historical linkage without rewriting accounting data or recording the migration', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_118_bad_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseUrl(base, databaseName) })
      const migrations = await loadMigrations()
      const prefix = migrations.filter(item => item.version <= 117)
      expect(await new MigrationRunner(database, prefix).run()).toEqual(prefix.map(item => item.version))

      await insertWorkspace(database, 'ws_bad_history')
      await insertReservation(database, { workspaceId: 'ws_bad_history', reservationKey: 'reservation_bad', runKey: 'run_authoritative' })
      await insertUsage(database, { id: 'usage_bad_history', workspaceId: 'ws_bad_history', reservationKey: 'reservation_bad', runKey: 'run_drifted' })
      const before = (await database.query(`SELECT id,workspace_id,receipt_key,cost_cny::text,settlement_status,budget_reservation_key,budget_run_key,revision
        FROM model_usage_ledger WHERE id='usage_bad_history'`)).rows

      await expect(new MigrationRunner(database, [migration118(migrations)]).run()).rejects.toMatchObject({
        code: '23503',
      })

      expect((await database.query(`SELECT id,workspace_id,receipt_key,cost_cny::text,settlement_status,budget_reservation_key,budget_run_key,revision
        FROM model_usage_ledger WHERE id='usage_bad_history'`)).rows).toEqual(before)
      expect((await database.query('SELECT version FROM schema_migrations WHERE version=118')).rows).toEqual([])
      expect((await database.query(`SELECT conname FROM pg_constraint WHERE conname IN
        ('model_cost_budget_reservation_run_unique','model_usage_budget_reservation_run_fk')`)).rows).toEqual([])
    } finally {
      await dropIsolatedDatabase(admin, database, databaseName)
    }
  }, 240_000)

  postgresIt('accepts exact tuples and enforces the deferred triple across tenants on the complete chain', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_118_valid_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let client: PoolClient | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseUrl(base, databaseName), max: 4 })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])

      await insertWorkspace(database, 'ws_tuple_a')
      await insertWorkspace(database, 'ws_tuple_b')
      await insertReservation(database, { workspaceId: 'ws_tuple_a', reservationKey: 'reservation_shared', runKey: 'run_a' })
      await insertReservation(database, { workspaceId: 'ws_tuple_b', reservationKey: 'reservation_shared', runKey: 'run_b' })
      await insertUsage(database, { id: 'usage_tuple_a', workspaceId: 'ws_tuple_a', reservationKey: 'reservation_shared', runKey: 'run_a' })
      await insertUsage(database, { id: 'usage_tuple_b', workspaceId: 'ws_tuple_b', reservationKey: 'reservation_shared', runKey: 'run_b' })
      await insertUsage(database, { id: 'usage_without_budget', workspaceId: 'ws_tuple_a' })

      expect((await database.query(`SELECT id,budget_reservation_key,budget_run_key FROM model_usage_ledger
        WHERE id IN ('usage_tuple_a','usage_tuple_b','usage_without_budget') ORDER BY id`)).rows).toEqual([
        { id: 'usage_tuple_a', budget_reservation_key: 'reservation_shared', budget_run_key: 'run_a' },
        { id: 'usage_tuple_b', budget_reservation_key: 'reservation_shared', budget_run_key: 'run_b' },
        { id: 'usage_without_budget', budget_reservation_key: null, budget_run_key: null },
      ])

      client = await database.connect()
      await client.query('BEGIN')
      await expect(insertUsage(client, { id: 'usage_cross_tenant_run', workspaceId: 'ws_tuple_a', reservationKey: 'reservation_shared', runKey: 'run_b' })).resolves.toBeUndefined()
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23503', constraint: 'model_usage_budget_reservation_run_fk' })
      await client.query('ROLLBACK')
      client.release()
      client = undefined

      expect((await database.query(`SELECT id FROM model_usage_ledger WHERE id='usage_cross_tenant_run'`)).rows).toEqual([])
      const constraints = await database.query<{ conname: string; convalidated: boolean; condeferrable: boolean; condeferred: boolean; definition: string }>(`SELECT
          constraint_row.conname,
          constraint_row.convalidated,
          constraint_row.condeferrable,
          constraint_row.condeferred,
          pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint constraint_row
        WHERE constraint_row.conname IN ('model_cost_budget_reservation_run_unique','model_usage_budget_reservation_run_fk')
        ORDER BY constraint_row.conname`)
      expect(constraints.rows).toEqual([
        expect.objectContaining({
          conname: 'model_cost_budget_reservation_run_unique',
          convalidated: true,
          definition: expect.stringContaining('UNIQUE (workspace_id, reservation_key, run_key)'),
        }),
        expect.objectContaining({
          conname: 'model_usage_budget_reservation_run_fk',
          convalidated: true,
          condeferrable: true,
          condeferred: true,
          definition: expect.stringContaining('FOREIGN KEY (workspace_id, budget_reservation_key, budget_run_key)'),
        }),
      ])
    } finally {
      client?.release()
      await dropIsolatedDatabase(admin, database, databaseName)
    }
  }, 240_000)
})
