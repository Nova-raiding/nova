import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
  ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'

describe('creative-point PostgreSQL upgrade release evidence', () => {
  it('forward-fills rate evidence and repairs the legacy allocation column without losing facts', async () => {
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
      await database.query('ALTER TABLE creative_point_allocations RENAME COLUMN points_delta TO points')
      await database.query("INSERT INTO workspaces(id) VALUES ('ws-a')")
      await database.query("INSERT INTO creative_point_access_state(workspace_id,available_points,reserved_points,settled_points) VALUES ('ws-a',10,0,0)")
      await database.query(`INSERT INTO creative_point_operations
        (id,workspace_id,kind,idempotency_key,status,request,completed_at)
        VALUES ('grant-op-a','ws-a','grant','grant-a','completed','{}'::jsonb,now())`)
      await database.query(`INSERT INTO creative_point_grants
        (id,workspace_id,operation_id,source_type,source_id,points)
        VALUES ('grant-a','ws-a','grant-op-a','paid_order','order-a',10)`)
      await database.query(`INSERT INTO creative_point_operations
        (id,workspace_id,kind,idempotency_key,status,request)
        VALUES ('op-a','ws-a','reserve','reserve-a','pending','{"rate_card_version":"rate-v1"}'::jsonb)`)
      await database.query(`INSERT INTO creative_point_reservations
        (id,workspace_id,operation_id,action_key,points,status)
        VALUES ('reservation-a','ws-a','op-a','image.generate.standard',1,'active')`)
      await database.query(await readFile(new URL('./migrations/148_harden_creative_point_reservations.sql', import.meta.url), 'utf8'))
      await database.query(await readFile(new URL('./migrations/150_repair_legacy_creative_point_allocations.sql', import.meta.url), 'utf8'))
      await database.query(await readFile(new URL('./migrations/151_repair_legacy_creative_point_allocation_constraint.sql', import.meta.url), 'utf8'))
      await database.query(`INSERT INTO creative_point_allocations
        (id,workspace_id,reservation_id,grant_id,allocation_type,points_delta)
        VALUES ('allocation-a','ws-a','reservation-a','grant-a','reserve',1)`)
      await database.query(`INSERT INTO creative_point_allocations
        (id,workspace_id,reservation_id,grant_id,allocation_type,points_delta)
        VALUES ('allocation-release-a','ws-a','reservation-a','grant-a','release',-1)`)

      expect((await database.query<{ rateCardVersion: string }>(
        `SELECT rate_card_version AS "rateCardVersion" FROM creative_point_reservations WHERE workspace_id='ws-a' AND id='reservation-a'`,
      )).rows).toEqual([{ rateCardVersion: 'rate-v1' }])
      expect((await database.query<{ installed: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='creative_point_allocations_validate' AND NOT tgisinternal) AS installed`,
      )).rows[0]?.installed).toBe(true)
      expect((await database.query<{ columnName: string }>(
        `SELECT column_name AS "columnName" FROM information_schema.columns
          WHERE table_name='creative_point_allocations' AND column_name IN ('points','points_delta')`,
      )).rows).toEqual([{ columnName: 'points_delta' }])
      expect((await database.query<{ allocated: string }>(
        `SELECT sum(points_delta)::text AS allocated FROM creative_point_allocations WHERE workspace_id='ws-a'`,
      )).rows).toEqual([{ allocated: '0' }])
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
