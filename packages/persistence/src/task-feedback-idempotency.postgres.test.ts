import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresBusinessRepository } from './business-repository.js'
import { PostgresOutboxRepository, withWorkspaceTransaction } from './repository.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { TaskFeedbackIdempotencyRepository } from './task-feedback-idempotency-repository.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = source ? it : it.skip

describe('task feedback idempotency on isolated PostgreSQL', () => {
  postgresIt('replays same intent atomically, rejects changed intent, and keeps RLS workspace scoped', async () => {
    const databaseName = `task_feedback_idem_${randomUUID().replaceAll('-', '')}`
    const workspaceA = `feedback-a-${randomUUID()}`
    const workspaceB = `feedback-b-${randomUUID()}`
    const admin = new Pool({ connectionString: source!, connectionTimeoutMillis: 10000 })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const url = new URL(source!); url.pathname = `/${databaseName}`
      database = new Pool({ connectionString: url.toString(), max: 4 })
      await database.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
      await new MigrationRunner(database, await loadMigrations()).run()
      const appUrl = new URL(url); appUrl.username = 'merchant_app'; appUrl.password = 'merchant_app_local_only'
      app = new Pool({ connectionString: appUrl.toString(), max: 4 })
      await database.query("INSERT INTO workspaces(id,status) VALUES($1,'active'),($2,'active')", [workspaceA, workspaceB])
      const business = new PostgresBusinessRepository(app, { normalizedProjection: true })
      const outbox = new PostgresOutboxRepository(app)
      const repo = new TaskFeedbackIdempotencyRepository(app, business, outbox)
      const keyHash = 'a'.repeat(64)
      const feedback = { id: 'feedback_pg_idempotency_1', workspaceId: workspaceA, taskId: 'task-1', rating: 'liked' as const, actorId: 'merchant-1', createdAt: new Date().toISOString(), revision: 1 }
      const first = await repo.submit({ workspaceId: workspaceA, keyHash, requestHash: 'b'.repeat(64), feedback, eventPayload: { task_id: 'task-1', rating: 'liked' } })
      const replay = await repo.submit({ workspaceId: workspaceA, keyHash, requestHash: 'b'.repeat(64), feedback: { ...feedback, id: 'different-feedback-id' }, eventPayload: { task_id: 'task-1', rating: 'liked' } })
      expect(first).toEqual({ feedback, replayed: false })
      expect(replay).toEqual({ feedback, replayed: true })
      await expect(repo.submit({ workspaceId: workspaceA, keyHash, requestHash: 'c'.repeat(64), feedback, eventPayload: {} })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
      const counts = await withWorkspaceTransaction(app, workspaceA, async client => ({
        feedback: await client.query<{ count: string }>('SELECT count(*)::text AS count FROM task_feedback WHERE workspace_id=$1', [workspaceA]),
        events: await client.query<{ count: string }>("SELECT count(*)::text AS count FROM outbox_events WHERE workspace_id=$1 AND aggregate_id=$2", [workspaceA, feedback.id]),
      }))
      expect(counts.feedback.rows[0]?.count).toBe('1')
      expect(counts.events.rows[0]?.count).toBe('2')
      const foreignRead = await withWorkspaceTransaction(app, workspaceB, client => client.query('SELECT id FROM task_feedback WHERE workspace_id=$1', [workspaceA]))
      expect(foreignRead.rows).toEqual([])
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await app?.end(); await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, undefined, [async () => { await admin.end() }])
    }
  }, 120000)
})
