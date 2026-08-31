import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export interface KnowledgeHydrationEvent {
  id: string
  workspaceId: string
  aggregateId: string
  sequence: number
  eventType: string
  payload: Record<string, unknown>
  createdAt: string
}

export interface KnowledgeHydrationSnapshot {
  workspaceId: string
  snapshotId: string
  cursorCreatedAt: string
  cursorEventId: string
  events: KnowledgeHydrationEvent[]
  updatedAt: string
  revision: number
}

export interface SaveKnowledgeHydrationSnapshotInput {
  workspaceId: string
  cursorCreatedAt: string
  cursorEventId: string
  events: KnowledgeHydrationEvent[]
  snapshotId?: string
  expectedRevision?: number | null
  expectedCursor?: { createdAt: string; eventId: string } | null
}

export interface KnowledgeHydrationRepository {
  load(workspaceId: string): Promise<KnowledgeHydrationSnapshot | undefined>
  save(input: SaveKnowledgeHydrationSnapshotInput): Promise<KnowledgeHydrationSnapshot>
}

function validate(input: SaveKnowledgeHydrationSnapshotInput) {
  const workspaceId = requireWorkspaceScope(input.workspaceId)
  if (!input.cursorCreatedAt.trim() || !input.cursorEventId.trim()) throw new Error('KNOWLEDGE_CURSOR_REQUIRED')
  if (!Array.isArray(input.events) || input.events.some(event => event.workspaceId !== workspaceId || !event.id || !event.eventType)) throw new Error('KNOWLEDGE_SNAPSHOT_EVENT_INVALID')
  return workspaceId
}

export class MemoryKnowledgeHydrationRepository implements KnowledgeHydrationRepository {
  private readonly snapshots = new Map<string, KnowledgeHydrationSnapshot>()
  async load(workspaceId: string) { return this.snapshots.get(requireWorkspaceScope(workspaceId)) }
  async save(input: SaveKnowledgeHydrationSnapshotInput) {
    const workspaceId = validate(input)
    const existing = this.snapshots.get(workspaceId)
    const expectedRevision = input.expectedRevision ?? null
    const expectedCursor = input.expectedCursor ?? null
    if (existing && (expectedRevision === null || existing.revision !== expectedRevision)) throw new Error('KNOWLEDGE_SNAPSHOT_CONFLICT')
    if (!existing && expectedRevision !== null) throw new Error('KNOWLEDGE_SNAPSHOT_CONFLICT')
    if (existing && (!expectedCursor || existing.cursorCreatedAt !== expectedCursor.createdAt || existing.cursorEventId !== expectedCursor.eventId)) throw new Error('KNOWLEDGE_SNAPSHOT_CONFLICT')
    if (!existing && expectedCursor !== null) throw new Error('KNOWLEDGE_SNAPSHOT_CONFLICT')
    if (existing && (input.cursorCreatedAt < existing.cursorCreatedAt || (input.cursorCreatedAt === existing.cursorCreatedAt && input.cursorEventId <= existing.cursorEventId))) throw new Error('KNOWLEDGE_CURSOR_NOT_MONOTONIC')
    const snapshot: KnowledgeHydrationSnapshot = {
      workspaceId,
      snapshotId: input.snapshotId ?? existing?.snapshotId ?? `knowledge_snapshot_${randomUUID()}`,
      cursorCreatedAt: input.cursorCreatedAt,
      cursorEventId: input.cursorEventId,
      events: structuredClone(input.events),
      updatedAt: new Date().toISOString(),
      revision: (existing?.revision ?? 0) + 1,
    }
    this.snapshots.set(workspaceId, snapshot)
    return structuredClone(snapshot)
  }
}

/** Backwards-compatible name used by the in-memory contract tests and fixtures. */
export const InMemoryKnowledgeHydrationRepository = MemoryKnowledgeHydrationRepository

type SnapshotRow = { workspace_id: string; snapshot_id: string; cursor_created_at: string | Date; cursor_event_id: string; events: KnowledgeHydrationEvent[]; updated_at: string | Date; revision: number }
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const map = (row: SnapshotRow): KnowledgeHydrationSnapshot => ({ workspaceId: row.workspace_id, snapshotId: row.snapshot_id, cursorCreatedAt: iso(row.cursor_created_at), cursorEventId: row.cursor_event_id, events: row.events, updatedAt: iso(row.updated_at), revision: row.revision })

export class PostgresKnowledgeHydrationRepository implements KnowledgeHydrationRepository {
  constructor(private readonly pool: SqlPool) {}
  async load(workspaceId: string) {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<SnapshotRow>(`SELECT workspace_id, snapshot_id, cursor_created_at, cursor_event_id, events, updated_at, revision FROM knowledge_hydration_snapshots WHERE workspace_id=$1`, [scope])
      return result.rows[0] ? map(result.rows[0]) : undefined
    })
  }
  async save(input: SaveKnowledgeHydrationSnapshotInput) {
    const workspaceId = validate(input)
    const snapshotId = input.snapshotId ?? `knowledge_snapshot_${randomUUID()}`
    const expectedRevision = input.expectedRevision ?? null
    const expectedCursor = input.expectedCursor ?? null
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const current = await client.query<{ revision: number; cursor_created_at: string | Date; cursor_event_id: string }>(
        `SELECT revision, cursor_created_at, cursor_event_id FROM knowledge_hydration_snapshots WHERE workspace_id=$1 FOR UPDATE`,
        [workspaceId],
      )
      if (!current.rows[0] && (expectedRevision !== null || expectedCursor !== null)) throw new Error('KNOWLEDGE_SNAPSHOT_CONFLICT')
      const result = await client.query<SnapshotRow>(
        `INSERT INTO knowledge_hydration_snapshots (workspace_id,snapshot_id,cursor_created_at,cursor_event_id,events,revision)
         VALUES ($1,$2,$3::timestamptz,$4,$5::jsonb,1)
         ON CONFLICT (workspace_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,cursor_created_at=EXCLUDED.cursor_created_at,cursor_event_id=EXCLUDED.cursor_event_id,events=EXCLUDED.events,revision=knowledge_hydration_snapshots.revision+1,updated_at=now()
         WHERE $6::integer IS NOT NULL AND knowledge_hydration_snapshots.revision=$6
           AND $7::timestamptz IS NOT NULL AND knowledge_hydration_snapshots.cursor_created_at=$7::timestamptz AND knowledge_hydration_snapshots.cursor_event_id=$8
           AND (EXCLUDED.cursor_created_at > knowledge_hydration_snapshots.cursor_created_at OR (EXCLUDED.cursor_created_at = knowledge_hydration_snapshots.cursor_created_at AND EXCLUDED.cursor_event_id > knowledge_hydration_snapshots.cursor_event_id))
         RETURNING workspace_id,snapshot_id,cursor_created_at,cursor_event_id,events,updated_at,revision`,
        [workspaceId, snapshotId, input.cursorCreatedAt, input.cursorEventId, JSON.stringify(input.events), expectedRevision, expectedCursor?.createdAt ?? null, expectedCursor?.eventId ?? null],
      )
      if (!result.rows[0]) throw new Error('KNOWLEDGE_SNAPSHOT_CONFLICT')
      return map(result.rows[0])
    })
  }
}
