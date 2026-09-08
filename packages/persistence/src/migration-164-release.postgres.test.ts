import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
  ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'
const postgresIt = databaseUrlValue ? it : it.skip

describe('migration 164 onboarding grant schedule PostgreSQL release evidence', () => {
  postgresIt('keeps unresolved schedules blocked and constrains activated schedules to the frozen policy', async () => {
    const base = new URL(databaseUrlValue)
    const databaseName = `onboarding_schedule_164_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      await database.query(`
        CREATE TABLE onboarding_point_grant_schedules_v2 (
          id text PRIMARY KEY,
          workspace_id text NOT NULL,
          status text NOT NULL,
          due_at timestamptz,
          expires_at timestamptz,
          policy_ref text,
          blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
          grant_id text
        )
      `)
      const sql = await readFile(new URL('./migrations/164_onboarding_grant_schedule_activation.sql', import.meta.url), 'utf8')
      await database.query(sql)

      await database.query(`INSERT INTO onboarding_point_grant_schedules_v2
        (id, workspace_id, status, blockers)
        VALUES ('blocked-1', 'ws-164', 'blocked_policy_unresolved', '["ORDER_TERMS_REQUIRED"]'::jsonb)`)
      await database.query(`INSERT INTO onboarding_point_grant_schedules_v2
        (id, workspace_id, status, due_at, expires_at, policy_ref)
        VALUES ('scheduled-1', 'ws-164', 'scheduled', now(), now() + interval '1 day', 'commercial.onboarding.v1')`)
      await database.query(`INSERT INTO onboarding_point_grant_schedules_v2
        (id, workspace_id, status, due_at, expires_at, policy_ref)
        VALUES ('canceled-1', 'ws-164', 'canceled', now(), now() + interval '1 day', 'commercial.onboarding.v1')`)

      await expect(database.query(`INSERT INTO onboarding_point_grant_schedules_v2
        (id, workspace_id, status, due_at, expires_at, policy_ref)
        VALUES ('bad-policy', 'ws-164', 'scheduled', now(), now() + interval '1 day', 'unapproved.policy')`)).rejects.toMatchObject({ code: '23514' })
      await expect(database.query(`INSERT INTO onboarding_point_grant_schedules_v2
        (id, workspace_id, status, due_at, expires_at, policy_ref)
        VALUES ('bad-window', 'ws-164', 'scheduled', now(), now() - interval '1 day', 'commercial.onboarding.v1')`)).rejects.toMatchObject({ code: '23514' })

      const index = await database.query<{ exists: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='onboarding_grant_schedule_due_idx'
      ) AS exists`)
      expect(index.rows[0]?.exists).toBe(true)
      expect((await database.query<{ status: string; count: number }>(`
        SELECT status, count(*)::int AS count
        FROM onboarding_point_grant_schedules_v2 GROUP BY status ORDER BY status
      `)).rows).toEqual([
        { status: 'blocked_policy_unresolved', count: 1 },
        { status: 'canceled', count: 1 },
        { status: 'scheduled', count: 1 },
      ])
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
