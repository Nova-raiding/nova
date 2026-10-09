import { BusinessSnapshotVersionConflictError, type BusinessEntityType } from '../../../packages/persistence/src/business-repository.js'
import type { SqlClient, SqlPool } from '../../../packages/persistence/src/repository.js'
import { withWorkspaceTransaction } from '../../../packages/persistence/src/repository.js'

export interface TaskGroupPersistenceSnapshot {
  entityType: BusinessEntityType
  entityId: string
  entityVersion: number
  payload: Record<string, unknown>
}

export interface TaskGroupPersistenceEvent {
  aggregateId: string
  eventType: string
  sequence: number
  payload: Record<string, unknown>
}

/** Persist task-group snapshots and lifecycle events in the same RLS transaction. */
export async function persistTaskGroupTransaction(input: {
  pool: SqlPool
  workspaceId: string
  snapshots: TaskGroupPersistenceSnapshot[]
  events: TaskGroupPersistenceEvent[]
  ensureWorkspace(workspaceId: string): Promise<void>
  saveSnapshot(client: SqlClient, snapshot: TaskGroupPersistenceSnapshot): Promise<{ entityVersion: number; payload: Record<string, unknown> }>
  appendEvent(client: SqlClient, event: { workspaceId: string } & TaskGroupPersistenceEvent): Promise<unknown>
  mapVersionConflict(error: BusinessSnapshotVersionConflictError): Error
  mapStaleSnapshot(snapshot: TaskGroupPersistenceSnapshot, currentVersion: number): Error
}): Promise<void> {
  await input.ensureWorkspace(input.workspaceId)
  await withWorkspaceTransaction(input.pool, input.workspaceId, async client => {
    const durableTasks = new Map<string, Record<string, unknown>>()
    for (const snapshot of input.snapshots) {
      let saved
      try {
        saved = await input.saveSnapshot(client, snapshot)
      } catch (error) {
        if (error instanceof BusinessSnapshotVersionConflictError) throw input.mapVersionConflict(error)
        throw error
      }
      if (saved.entityVersion < snapshot.entityVersion) {
        throw input.mapStaleSnapshot(snapshot, saved.entityVersion)
      }
      if (snapshot.entityType === 'task') durableTasks.set(snapshot.entityId, saved.payload)
    }
    for (const event of input.events) {
      if (event.eventType === 'task.created') {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${input.workspaceId}:${event.aggregateId}:task.created`])
        const prior = await client.query<{ id: string }>(`SELECT id FROM outbox_events
          WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='task.created' LIMIT 1`, [input.workspaceId, event.aggregateId])
        if (prior.rows[0]) continue
        const durable = durableTasks.get(event.aggregateId)
        const payload = durable ? { ...event.payload, ...durable } : event.payload
        await input.appendEvent(client, { workspaceId: input.workspaceId, ...event, payload })
        continue
      }
      if (event.eventType === 'task.sku_split') {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${input.workspaceId}:${event.aggregateId}:task.sku_split`])
        const prior = await client.query<{ id: string }>(`SELECT id FROM outbox_events
          WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='task.sku_split' AND payload->>'task_group_id'=$3 LIMIT 1`,
        [input.workspaceId, event.aggregateId, String(event.payload.task_group_id ?? '')])
        if (prior.rows[0]) continue
        const nextSequence = await client.query<{ sequence: number }>(`SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM outbox_events
          WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='task.sku_split'`, [input.workspaceId, event.aggregateId])
        await input.appendEvent(client, { workspaceId: input.workspaceId, ...event, sequence: nextSequence.rows[0]!.sequence })
        continue
      }
      await input.appendEvent(client, { workspaceId: input.workspaceId, ...event })
    }
  })
}

/** Keep a fresh in-memory task group retryable when its durable write fails. */
export async function persistTaskGroupOrRollback<T>(input: {
  taskIds: string[]
  groupId?: string
  replayed?: boolean
  rollbackOnFailure?: () => boolean
  persist: () => Promise<T>
  rollback: (taskIds: string[], groupId?: string) => void
}): Promise<T> {
  try {
    return await input.persist()
  } catch (error) {
    if (!input.replayed && (input.rollbackOnFailure?.() ?? true)) input.rollback(input.taskIds, input.groupId)
    throw error
  }
}
