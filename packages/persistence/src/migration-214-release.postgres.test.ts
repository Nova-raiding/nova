import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseUrl(base: URL, databaseName: string) {
  const url = new URL(base)
  url.pathname = `/${databaseName}`
  return url.toString()
}

describe('migration 214 PostgreSQL embedding accounting acceptance', () => {
  postgresIt('upgrades 213 without rewriting accounting rows and admits embedding usage and reservations', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_214_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseUrl(base, databaseName) })
      const migrations = await loadMigrations()
      const through213 = migrations.filter(migration => migration.version <= 213)
      const migration214 = migrations.filter(migration => migration.version === 214)
      expect(migration214).toHaveLength(1)
      expect(await new MigrationRunner(database, through213).run()).toEqual(through213.map(migration => migration.version))

      await database.query("INSERT INTO workspaces(id,status) VALUES('ws_214','active')")
      await database.query(`INSERT INTO model_usage_ledger
        (id,workspace_id,receipt_key,receipt_hash,modality,model,settlement_status)
        VALUES ('usage_text_214','ws_214','receipt_text_214','hash_text_214','text','relay-text','pending_wallet')`)
      const accountingBefore = (await database.query("SELECT id,modality,model,settlement_status FROM model_usage_ledger WHERE id='usage_text_214'")).rows
      await expect(database.query(`INSERT INTO model_usage_ledger
        (id,workspace_id,receipt_key,receipt_hash,modality,model,settlement_status)
        VALUES ('usage_embedding_before_214','ws_214','receipt_embedding_before_214','hash_embedding_before_214','embedding','relay-embedding','pending_wallet')`))
        .rejects.toMatchObject({ code: '23514' })

      expect(await new MigrationRunner(database, migration214).run()).toEqual([214])
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])
      expect((await database.query("SELECT id,modality,model,settlement_status FROM model_usage_ledger WHERE id='usage_text_214'")).rows)
        .toEqual(accountingBefore)
      await expect(database.query(`INSERT INTO model_usage_ledger
        (id,workspace_id,receipt_key,receipt_hash,modality,model,settlement_status)
        VALUES ('usage_embedding_214','ws_214','receipt_embedding_214','hash_embedding_214','embedding','relay-embedding','pending_wallet')`))
        .resolves.toMatchObject({ rowCount: 1 })
      await expect(database.query(`INSERT INTO model_cost_budget_reservations
        (workspace_id,budget_date,reservation_key,run_key,modality,model,estimate_cny,estimate_version,daily_limit_cny,run_limit_cny,status)
        VALUES ('ws_214','2026-09-16','embedding_reservation_214','embedding_run_214','embedding','relay-embedding',0.01,'pricing-v1',10,1,'active')`))
        .resolves.toMatchObject({ rowCount: 1 })
      expect((await database.query('SELECT max(version)::int AS version FROM schema_migrations')).rows).toEqual([{ version: 214 }])
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
