import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseUrl(base: URL, databaseName: string) {
  const url = new URL(base)
  url.pathname = `/${databaseName}`
  return url.toString()
}

describe('migration 217 PostgreSQL embedding accounting acceptance', () => {
  postgresIt('upgrades 213 without rewriting accounting rows and admits embedding usage and reservations', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_217_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseUrl(base, databaseName) })
      const migrations = await loadMigrations()
      const through213 = migrations.filter(migration => migration.version <= 216)
      const migration214 = migrations.filter(migration => migration.version === 217)
      expect(migration214).toHaveLength(1)
      expect(await new MigrationRunner(database, through213).run()).toEqual(through213.map(migration => migration.version))

      await database.query("INSERT INTO workspaces(id,status) VALUES('ws_217','active')")
      await database.query(`INSERT INTO model_usage_ledger
        (id,workspace_id,receipt_key,receipt_hash,modality,model,settlement_status)
        VALUES ('usage_text_217','ws_217','receipt_text_217','hash_text_217','text','relay-text','pending_wallet')`)
      const accountingBefore = (await database.query("SELECT id,modality,model,settlement_status FROM model_usage_ledger WHERE id='usage_text_217'")).rows
      await expect(database.query(`INSERT INTO model_usage_ledger
        (id,workspace_id,receipt_key,receipt_hash,modality,model,settlement_status)
        VALUES ('usage_embedding_before_217','ws_217','receipt_embedding_before_217','hash_embedding_before_217','embedding','relay-embedding','pending_wallet')`))
        .rejects.toMatchObject({ code: '23514' })

      await database.query(`ALTER TABLE model_usage_ledger
        RENAME CONSTRAINT model_usage_ledger_modality_check TO legacy_usage_modality_check_217`)
      await database.query(`ALTER TABLE model_cost_budget_reservations
        RENAME CONSTRAINT model_cost_budget_reservations_modality_check TO legacy_budget_modality_check_217`)

      expect(await new MigrationRunner(database, migration214).run()).toEqual([214])
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])
      expect((await database.query("SELECT id,modality,model,settlement_status FROM model_usage_ledger WHERE id='usage_text_217'")).rows)
        .toEqual(accountingBefore)
      await expect(database.query(`INSERT INTO model_usage_ledger
        (id,workspace_id,receipt_key,receipt_hash,modality,model,settlement_status)
        VALUES ('usage_embedding_217','ws_217','receipt_embedding_217','hash_embedding_217','embedding','relay-embedding','pending_wallet')`))
        .resolves.toMatchObject({ rowCount: 1 })
      await expect(database.query(`INSERT INTO model_cost_budget_reservations
        (workspace_id,budget_date,reservation_key,run_key,modality,model,estimate_cny,estimate_version,daily_limit_cny,run_limit_cny,status)
        VALUES ('ws_217','2026-09-16','embedding_reservation_217','embedding_run_217','embedding','relay-embedding',0.01,'pricing-v1',10,1,'active')`))
        .resolves.toMatchObject({ rowCount: 1 })
      expect((await database.query(`SELECT conrelid::regclass::text AS table_name, conname, convalidated
        FROM pg_constraint
        WHERE conname IN ('model_usage_ledger_modality_check', 'model_cost_budget_reservations_modality_check')
        ORDER BY conname`)).rows).toEqual([
        { table_name: 'model_cost_budget_reservations', conname: 'model_cost_budget_reservations_modality_check', convalidated: true },
        { table_name: 'model_usage_ledger', conname: 'model_usage_ledger_modality_check', convalidated: true },
      ])
      expect((await database.query(`SELECT count(*)::int AS count FROM pg_constraint
        WHERE conname IN ('legacy_usage_modality_check_217', 'legacy_budget_modality_check_217')`)).rows)
        .toEqual([{ count: 0 }])
      expect((await database.query('SELECT max(version)::int AS version FROM schema_migrations')).rows).toEqual([{ version: 217 }])
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [() => admin.end()])
    }
  }, 240_000)
})
