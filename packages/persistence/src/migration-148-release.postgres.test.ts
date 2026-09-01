import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
  ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'

describe('migration 148 creative-point PostgreSQL release evidence', () => {
  it('forward-fills the immutable rate version and installs allocation bounds', async () => {
    const base = new URL(databaseUrlValue)
    const databaseName = `creative_points_148_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      await database.query('CREATE TABLE workspaces (id TEXT PRIMARY KEY)')
      await database.query(await readFile(new URL('./migrations/144_creative_point_ledger.sql', import.meta.url), 'utf8'))
      await database.query("INSERT INTO workspaces(id) VALUES ('ws-a')")
      await database.query(`INSERT INTO creative_point_operations
        (id,workspace_id,kind,idempotency_key,status,request)
        VALUES ('op-a','ws-a','reserve','reserve-a','pending','{"rate_card_version":"rate-v1"}'::jsonb)`)
      await database.query(`INSERT INTO creative_point_reservations
        (id,workspace_id,operation_id,action_key,points,status)
        VALUES ('reservation-a','ws-a','op-a','image.generate.standard',1,'active')`)
      await database.query(await readFile(new URL('./migrations/148_harden_creative_point_reservations.sql', import.meta.url), 'utf8'))

      expect((await database.query<{ rateCardVersion: string }>(
        `SELECT rate_card_version AS "rateCardVersion" FROM creative_point_reservations WHERE workspace_id='ws-a' AND id='reservation-a'`,
      )).rows).toEqual([{ rateCardVersion: 'rate-v1' }])
      expect((await database.query<{ installed: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='creative_point_allocations_validate' AND NOT tgisinternal) AS installed`,
      )).rows[0]?.installed).toBe(true)
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
