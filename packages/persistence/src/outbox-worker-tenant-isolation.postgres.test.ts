import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresOutboxRepository, type SqlPool } from './repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('worker outbox claim tenant boundary (isolated PostgreSQL)', () => {
  postgresIt('leases only the authenticated workspace events and leaves the other tenant untouched', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `outbox_tenant_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString(), max: 4 })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))

      const workspaceA = `ws_outbox_a_${randomUUID()}`
      const workspaceB = `ws_outbox_b_${randomUUID()}`
      await database.query('INSERT INTO workspaces (id,status) VALUES ($1,$3),($2,$3)', [workspaceA, workspaceB, 'active'])
      const outbox = new PostgresOutboxRepository(database as unknown as SqlPool)
      const [eventA, eventB] = await Promise.all([
        outbox.append({ workspaceId: workspaceA, aggregateId: 'task-a', eventType: 'task.created', sequence: 1, payload: { id: 'task-a', workspaceId: workspaceA } }),
        outbox.append({ workspaceId: workspaceB, aggregateId: 'task-b', eventType: 'task.created', sequence: 1, payload: { id: 'task-b', workspaceId: workspaceB } }),
      ])

      const claimedByA = await outbox.claimPending(workspaceA, { limit: 10 })
      expect(claimedByA.map(event => event.id)).toEqual([eventA.id])
      expect(claimedByA[0]).toMatchObject({ workspaceId: workspaceA, aggregateId: 'task-a' })

      // A worker cannot acknowledge a foreign event by supplying its id under A's scope.
      await expect(outbox.markPublished(workspaceA, eventB.id)).rejects.toThrow()
      const bState = await outbox.pending(workspaceB, 10)
      expect(bState).toHaveLength(1)
      expect(bState[0]).toMatchObject({ id: eventB.id, workspaceId: workspaceB })
      const bRow = await database.query('SELECT lease_token, published_at FROM outbox_events WHERE workspace_id=$1 AND id=$2', [workspaceB, eventB.id])
      expect(bRow.rows).toEqual([{ lease_token: null, published_at: null }])

      // Exact event lookup must bypass the default page limit while retaining
      // the caller's workspace scope. Keep this in the owned isolated DB so
      // the test never touches the demo database or shared business data.
      const oldEventId = `old-event-${randomUUID()}`
      await database.query(
        `INSERT INTO outbox_events (id, workspace_id, aggregate_id, event_type, sequence, payload)
         SELECT CASE WHEN sequence = 1 THEN $1 ELSE $2 || sequence::text END,
                $3, 'large-aggregate', 'task.snapshot', sequence, '{}'::jsonb
           FROM generate_series(1, 1_005) AS sequence`,
        [oldEventId, `later-event-${randomUUID()}-`, workspaceA],
      )
      expect(await outbox.listAggregateEvents(workspaceA, 'large-aggregate', 1, oldEventId)).toMatchObject([
        { id: oldEventId, workspaceId: workspaceA, aggregateId: 'large-aggregate' },
      ])
      expect(await outbox.listAggregateEvents(workspaceB, 'large-aggregate', 1, oldEventId)).toEqual([])
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
