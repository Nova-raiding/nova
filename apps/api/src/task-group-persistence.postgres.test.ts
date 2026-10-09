import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { PostgresBusinessRepository } from '../../../packages/persistence/src/business-repository.js'
import { PostgresOutboxRepository } from '../../../packages/persistence/src/repository.js'
import { persistTaskGroupTransaction } from './task-group-persistence.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip

describe('task-group persistence PostgreSQL transaction boundary', () => {
  const pools: Pool[] = []
  afterEach(async () => { await Promise.all(pools.splice(0).map(pool => pool.end())) })

  postgresIt('rolls back partial snapshots and outbox writes, then persists the same group on retry', async () => {
    if (!databaseUrl) throw new Error('PERSISTENCE_RELEASE_DATABASE_URL_REQUIRED')
    const admin = new Pool({ connectionString: databaseUrl, max: 1 })
    const appUrl = new URL(databaseUrl)
    appUrl.username = 'merchant_app'
    appUrl.password = 'merchant_app_local_only'
    const app = new Pool({ connectionString: appUrl.toString(), max: 1 })
    pools.push(admin, app)

    const workspaceId = `task_group_pg_${randomUUID().replaceAll('-', '')}`
    const productId = `product_${randomUUID().replaceAll('-', '')}`
    const taskIds = [`task_${randomUUID().replaceAll('-', '')}`, `task_${randomUUID().replaceAll('-', '')}`]
    const groupId = `group_${randomUUID().replaceAll('-', '')}`
    await admin.query(`INSERT INTO workspaces (id,status) VALUES ($1,'active')`, [workspaceId])
    await admin.query(
      `INSERT INTO products (id,workspace_id,platform,remote_product_id,title,source)
       VALUES ($1,$2,'jd',$3,'隔离验收商品','fixture')`,
      [productId, workspaceId, productId],
    )

    const business = new PostgresBusinessRepository(app, { normalizedProjection: true })
    const outbox = new PostgresOutboxRepository(app)
    const snapshots = taskIds.map((id, index) => ({
      entityType: 'task' as const,
      entityId: id,
      entityVersion: 1,
      payload: { id, workspaceId, productId, platform: 'jd', state: 'draft', version: 1, task_group_id: groupId, index },
    }))
    const events = taskIds.map((aggregateId, index) => ({
      aggregateId,
      eventType: 'task.created',
      sequence: 1,
      payload: { id: aggregateId, task_group_id: groupId, workspace_id: workspaceId, position: index },
    }))
    const ensureWorkspace = async () => undefined
    const mapVersionConflict = (error: Error) => error
    const mapStaleSnapshot = () => new Error('BUSINESS_SNAPSHOT_VERSION_CONFLICT')
    const persist = (appendEvent: typeof outbox.appendInTransaction) => persistTaskGroupTransaction({
      pool: app,
      workspaceId,
      snapshots,
      events,
      ensureWorkspace,
      saveSnapshot: (transaction, snapshot) => business.saveInTransaction(transaction, { workspaceId, ...snapshot }),
      appendEvent,
      mapVersionConflict,
      mapStaleSnapshot,
    })

    let injected = false
    await expect(persist(async (client, event) => {
      const saved = await outbox.appendInTransaction(client, event)
      if (!injected) {
        injected = true
        throw new Error('INJECTED_TASK_GROUP_MID_TRANSACTION_FAILURE')
      }
      return saved
    })).rejects.toThrow('INJECTED_TASK_GROUP_MID_TRANSACTION_FAILURE')

    const afterFailure = await admin.query<{ snapshots: number; tasks: number; events: number }>(
      `SELECT
         (SELECT count(*)::int FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='task') AS snapshots,
         (SELECT count(*)::int FROM tasks WHERE workspace_id=$1) AS tasks,
         (SELECT count(*)::int FROM outbox_events WHERE workspace_id=$1 AND event_type='task.created') AS events`,
      [workspaceId],
    )
    expect(afterFailure.rows[0]).toEqual({ snapshots: 0, tasks: 0, events: 0 })

    await persist((client, event) => outbox.appendInTransaction(client, event))
    const afterRetry = await admin.query<{ snapshots: number; tasks: number; events: number; task_ids: string[] }>(
      `SELECT
         (SELECT count(*)::int FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='task') AS snapshots,
         (SELECT count(*)::int FROM tasks WHERE workspace_id=$1) AS tasks,
         (SELECT count(*)::int FROM outbox_events WHERE workspace_id=$1 AND event_type='task.created') AS events,
         (SELECT array_agg(aggregate_id ORDER BY aggregate_id) FROM outbox_events WHERE workspace_id=$1 AND event_type='task.created') AS task_ids`,
      [workspaceId],
    )
    expect(afterRetry.rows[0]).toEqual({ snapshots: 2, tasks: 2, events: 2, task_ids: [...taskIds].sort() })

    // Replaying the group is safe: snapshots remain at the same version and
    // task.created lifecycle markers stay unique per task.
    await persist((client, event) => outbox.appendInTransaction(client, event))
    const afterReplay = await admin.query<{ snapshots: number; tasks: number; events: number }>(
      `SELECT
         (SELECT count(*)::int FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='task') AS snapshots,
         (SELECT count(*)::int FROM tasks WHERE workspace_id=$1) AS tasks,
         (SELECT count(*)::int FROM outbox_events WHERE workspace_id=$1 AND event_type='task.created') AS events`,
      [workspaceId],
    )
    expect(afterReplay.rows[0]).toEqual({ snapshots: 2, tasks: 2, events: 2 })
  }, 120_000)
})
