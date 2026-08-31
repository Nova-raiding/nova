import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresKnowledgeHydrationRepository } from './knowledge-hydration-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('persistence migration 079 knowledge hydration acceptance', () => {
  postgresIt('applies 079 idempotently and verifies real merchant_app RLS and CAS', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_079_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let pool: Pool | undefined
    let app: Pool | undefined
    try {
      const role = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
        `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='merchant_app'`,
      )
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false, rolcanlogin: true }])
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      pool = new Pool({ connectionString: isolated.toString() })
      const migrations = (await loadMigrations()).filter(item => item.version <= 79)
      expect(migrations.at(-1)?.version).toBe(79)
      expect(await new MigrationRunner(pool, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(pool, migrations).run()).toEqual([])
      await pool.query(`INSERT INTO workspaces (id,status) VALUES ('ws_079_a','active'),('ws_079_b','active')`)
      expect((await pool.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='knowledge_hydration_snapshots'::regclass`)).rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true })

      const appUrl = new URL(isolated)
      appUrl.username = 'merchant_app'
      appUrl.password = 'merchant_app_local_only'
      app = new Pool({ connectionString: appUrl.toString(), max: 2 })
      const repository = new PostgresKnowledgeHydrationRepository(app)
      const first = await repository.save({
        workspaceId: 'ws_079_a', cursorCreatedAt: '2026-08-29T00:00:00.000Z', cursorEventId: 'evt_a',
        events: [{ id: 'evt_a', workspaceId: 'ws_079_a', aggregateId: 'rule_a', sequence: 1, eventType: 'knowledge.rule.created', payload: { id: 'rule_a', workspaceId: 'ws_079_a' }, createdAt: '2026-08-29T00:00:00.000Z' }],
      })
      expect(first.revision).toBe(1)
      expect((await repository.load('ws_079_a'))?.revision).toBe(1)
      expect(await repository.load('ws_079_b')).toBeUndefined()

      await expect(repository.save({
        workspaceId: 'ws_079_a', cursorCreatedAt: '2026-08-29T00:00:01.000Z', cursorEventId: 'evt_b', events: [], expectedRevision: 0,
      })).rejects.toThrow('KNOWLEDGE_SNAPSHOT_CONFLICT')
      const second = await repository.save({
        workspaceId: 'ws_079_a', cursorCreatedAt: '2026-08-29T00:00:01.000Z', cursorEventId: 'evt_b', events: [],
        expectedRevision: 1, expectedCursor: { createdAt: first.cursorCreatedAt, eventId: first.cursorEventId },
      })
      expect(second.revision).toBe(2)
      await expect(repository.save({
        workspaceId: 'ws_079_a', cursorCreatedAt: '2026-08-29T00:00:02.000Z', cursorEventId: 'evt_c', events: [],
        expectedRevision: 1, expectedCursor: { createdAt: first.cursorCreatedAt, eventId: first.cursorEventId },
      })).rejects.toThrow('KNOWLEDGE_SNAPSHOT_CONFLICT')

      const scoped = await app.connect()
      try {
        await scoped.query('BEGIN')
        await scoped.query("SELECT set_config('app.workspace_id','ws_079_a',true)")
        expect((await scoped.query('SELECT workspace_id FROM knowledge_hydration_snapshots ORDER BY workspace_id')).rows).toEqual([{ workspace_id: 'ws_079_a' }])
        await expect(scoped.query(`INSERT INTO knowledge_hydration_snapshots (workspace_id,snapshot_id,cursor_created_at,cursor_event_id,events,revision) VALUES ('ws_079_b','snap_b',now(),'evt_b','[]'::jsonb,1)`)).rejects.toMatchObject({ code: '42501' })
        await scoped.query('ROLLBACK')
      } finally {
        scoped.release()
      }
    } finally {
      await app?.end()
      await pool?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
