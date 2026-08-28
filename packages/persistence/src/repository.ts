import { randomUUID } from 'node:crypto'

export interface OutboxEvent {
  id: string
  workspaceId: string
  aggregateId: string
  eventType: string
  sequence: number
  payload: Record<string, unknown>
  publishedAt?: string
  createdAt: string
  attempts?: number
  nextAttemptAt?: string
  leaseToken?: string
  leaseUntil?: string
  lastError?: Record<string, unknown>
  unknownAt?: string
}

export type OutboxEventInput = Omit<OutboxEvent, 'id' | 'createdAt'>

/**
 * A deliberately small structural subset of pg's Pool/PoolClient API.
 *
 * Keeping this port local means applications can pass a `pg.Pool` without
 * making `pg` a dependency of this package (or of local tests/builds).
 */
export interface SqlQueryResult<Row = Record<string, unknown>> {
  rows: Row[]
  rowCount?: number | null
}

export interface SqlClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>
  release?: () => void
}

export interface SqlPool {
  connect(): Promise<SqlClient>
}

export interface OutboxRepository {
  append(input: OutboxEventInput): Promise<OutboxEvent>
  pending(workspaceId: string, limit?: number): Promise<OutboxEvent[]>
  markPublished(workspaceId: string, id: string, publishedAt?: string): Promise<OutboxEvent>
  listAggregateEvents(workspaceId: string, aggregateId: string, limit?: number): Promise<OutboxEvent[]>
  listWorkspaceEvents?(workspaceId: string, limit?: number): Promise<OutboxEvent[]>
}

export interface OutboxFailure {
  code: string
  message: string
  retryable: boolean
  unknown?: boolean
}

export interface DurableOutboxRepository extends OutboxRepository {
  claimPending(workspaceId: string, options?: OutboxClaimOptions): Promise<OutboxEvent[]>
  recordFailure(workspaceId: string, id: string, failure: OutboxFailure, nextAttemptAt: string, leaseToken?: string): Promise<OutboxEvent>
  markUnknown(workspaceId: string, id: string, failure: OutboxFailure, leaseToken?: string): Promise<OutboxEvent>
  ack(workspaceId: string, id: string, leaseToken?: string, publishedAt?: string): Promise<OutboxEvent>
  loadStateSnapshots(workspaceId: string): Promise<Array<{ aggregateId: string; sequence: number; payload: Record<string, unknown> }>>
  listActiveWorkspaceIds(): Promise<string[]>
}

/** Optional routing constraints used by independently scaled worker pools. */
export interface OutboxClaimOptions {
  limit?: number
  leaseMs?: number
  now?: string
  eventTypes?: readonly string[]
  snapshotEntityTypes?: readonly string[]
}

export class TenantScopeError extends Error { constructor() { super('workspace scope is required') } }

export class OutboxEventNotFoundError extends Error {
  readonly code = 'OUTBOX_EVENT_NOT_FOUND'
  constructor() {
    super('outbox event not found')
    this.name = 'OutboxEventNotFoundError'
  }
}

export class InMemoryOutbox {
  private readonly events: OutboxEvent[] = []
  append(input: OutboxEventInput) {
    if (!input.workspaceId) throw new TenantScopeError()
    const duplicate = this.events.find(event => event.workspaceId === input.workspaceId && event.aggregateId === input.aggregateId && event.eventType === input.eventType && event.sequence === input.sequence)
    if (duplicate) return duplicate
    const event: OutboxEvent = { ...input, id: `evt_${randomUUID()}`, createdAt: new Date().toISOString() }
    this.events.push(event)
    return event
  }
  pending(limit = 100) { return this.events.filter(event => !event.publishedAt).slice(0, limit) }
  markPublished(id: string) { const event = this.events.find(item => item.id === id); if (!event) throw new Error('outbox event not found'); event.publishedAt = new Date().toISOString(); return event }
  all() { return [...this.events] }
  listAggregateEvents(workspaceId: string, aggregateId: string, limit = 100) {
    if (!workspaceId.trim()) throw new TenantScopeError()
    if (!aggregateId.trim()) throw new Error('aggregate id is required')
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    return this.events.filter(event => event.workspaceId === workspaceId && event.aggregateId === aggregateId).sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt)).slice(-limit)
  }
  listWorkspaceEvents(workspaceId: string, limit = 1000) {
    if (!workspaceId.trim()) throw new TenantScopeError()
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    return this.events.filter(event => event.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(-limit)
  }
}

export function requireWorkspaceScope(workspaceId: string | undefined): string {
  if (!workspaceId || workspaceId.trim() === '') throw new TenantScopeError()
  return workspaceId
}

type OutboxRow = {
  id: string
  workspace_id: string
  aggregate_id: string
  event_type: string
  sequence: number
  payload: Record<string, unknown>
  published_at: string | Date | null
  created_at: string | Date
  attempts?: number
  next_attempt_at?: string | Date | null
  lease_token?: string | null
  lease_until?: string | Date | null
  last_error?: Record<string, unknown> | null
  unknown_at?: string | Date | null
}

function timestamp(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  return value instanceof Date ? value.toISOString() : String(value)
}

function toOutboxEvent(row: OutboxRow): OutboxEvent {
  const publishedAt = timestamp(row.published_at)
  const nextAttemptAt = timestamp(row.next_attempt_at)
  const leaseUntil = timestamp(row.lease_until)
  const unknownAt = timestamp(row.unknown_at)
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    sequence: row.sequence,
    payload: row.payload,
    ...(publishedAt ? { publishedAt } : {}),
    createdAt: timestamp(row.created_at)!,
    ...(row.attempts !== undefined ? { attempts: row.attempts } : {}),
    ...(nextAttemptAt ? { nextAttemptAt } : {}),
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(leaseUntil ? { leaseUntil } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(unknownAt ? { unknownAt } : {}),
  }
}

/**
 * PostgreSQL-backed outbox repository. Every public operation owns a short
 * transaction so the RLS setting cannot leak between pooled connections.
 */
export class PostgresOutboxRepository implements DurableOutboxRepository {
  constructor(private readonly pool: SqlPool) {}

  async append(input: OutboxEventInput): Promise<OutboxEvent> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, client => this.appendInTransaction(client, input))
  }

  /** Append inside a caller-owned transaction for atomic business+outbox writes. */
  async appendInTransaction(client: SqlClient, input: OutboxEventInput): Promise<OutboxEvent> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const id = `evt_${randomUUID()}`
    const inserted = await client.query<OutboxRow>(
      `INSERT INTO outbox_events
        (id, workspace_id, aggregate_id, event_type, sequence, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (workspace_id, aggregate_id, event_type, sequence)
       DO NOTHING
       RETURNING id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                 attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at`,
      [id, workspaceId, input.aggregateId, input.eventType, input.sequence, JSON.stringify(input.payload)],
    )
    if (inserted.rows[0]) return toOutboxEvent(inserted.rows[0])
    const existing = await client.query<OutboxRow>(
      `SELECT id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                  attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at
         FROM outbox_events
        WHERE workspace_id = $1 AND aggregate_id = $2 AND event_type = $3 AND sequence = $4
        LIMIT 1`,
      [workspaceId, input.aggregateId, input.eventType, input.sequence],
    )
    if (!existing.rows[0]) throw new Error('outbox duplicate disappeared before lookup')
    return toOutboxEvent(existing.rows[0])
  }

  async pending(workspaceId: string, limit = 100): Promise<OutboxEvent[]> {
    const scope = requireWorkspaceScope(workspaceId)
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<OutboxRow>(
        `SELECT id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                    attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at
          FROM outbox_events
          WHERE workspace_id = $1 AND published_at IS NULL AND unknown_at IS NULL
            AND next_attempt_at <= now()
          ORDER BY created_at ASC, id ASC
          LIMIT $2`,
        [scope, limit],
      )
      return result.rows.map(toOutboxEvent)
    })
  }

  async markPublished(workspaceId: string, id: string, publishedAt = new Date().toISOString()): Promise<OutboxEvent> {
    const scope = requireWorkspaceScope(workspaceId)
    if (!id) throw new Error('outbox event id is required')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<OutboxRow>(
        `UPDATE outbox_events
            SET published_at = COALESCE(published_at, $3::timestamptz), lease_token = NULL, lease_until = NULL
          WHERE workspace_id = $1 AND id = $2
          RETURNING id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at`,
        [scope, id, publishedAt],
      )
      if (!result.rows[0]) throw new OutboxEventNotFoundError()
      return toOutboxEvent(result.rows[0])
    })
  }

  async listAggregateEvents(workspaceId: string, aggregateId: string, limit = 100): Promise<OutboxEvent[]> {
    const scope = requireWorkspaceScope(workspaceId)
    if (!aggregateId.trim()) throw new Error('aggregate id is required')
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<OutboxRow>(
        `SELECT id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at
           FROM outbox_events
          WHERE workspace_id = $1 AND aggregate_id = $2
          ORDER BY sequence ASC, created_at ASC, id ASC
          LIMIT $3`,
        [scope, aggregateId, limit],
      )
      return result.rows.map(toOutboxEvent)
    })
  }

  async listWorkspaceEvents(workspaceId: string, limit = 1000): Promise<OutboxEvent[]> {
    const scope = requireWorkspaceScope(workspaceId)
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<OutboxRow>(
        `SELECT id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at
           FROM outbox_events
          WHERE workspace_id = $1
          ORDER BY created_at ASC, id ASC
          LIMIT $2`,
        [scope, limit],
      )
      return result.rows.map(toOutboxEvent)
    })
  }

  async claimPending(workspaceId: string, options: OutboxClaimOptions = {}): Promise<OutboxEvent[]> {
    const scope = requireWorkspaceScope(workspaceId)
    const limit = options.limit ?? 100
    const leaseMs = options.leaseMs ?? 30_000
    const now = options.now ?? new Date().toISOString()
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new RangeError('leaseMs must be a positive integer')
    const eventTypes = options.eventTypes?.filter(Boolean)
    const snapshotEntityTypes = options.snapshotEntityTypes?.filter(Boolean)
    if (eventTypes && eventTypes.length === 0) throw new RangeError('eventTypes must contain at least one event type')
    if (snapshotEntityTypes && snapshotEntityTypes.length === 0) throw new RangeError('snapshotEntityTypes must contain at least one entity type')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const values: unknown[] = [scope, now]
      const filters = [
        'workspace_id = $1',
        'published_at IS NULL',
        'unknown_at IS NULL',
        'next_attempt_at <= $2::timestamptz',
        '(lease_until IS NULL OR lease_until <= $2::timestamptz)',
      ]
      if (eventTypes) {
        values.push(eventTypes)
        filters.push(`event_type = ANY($${values.length}::text[])`)
      }
      if (snapshotEntityTypes) {
        values.push(snapshotEntityTypes)
        filters.push(`(event_type <> 'state.snapshot' OR payload->>'entityType' = ANY($${values.length}::text[]))`)
      }
      const limitIndex = values.push(limit)
      const leaseTokenIndex = values.push(`lease_${randomUUID()}`)
      const leaseMsIndex = values.push(leaseMs)
      const result = await client.query<OutboxRow>(
        `WITH candidates AS (
           SELECT id FROM outbox_events
            WHERE ${filters.join('\n              AND ')}
            ORDER BY created_at ASC, id ASC
            LIMIT $${limitIndex}
            FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_events AS event
            SET lease_token = $${leaseTokenIndex},
                lease_until = $2::timestamptz + ($${leaseMsIndex} * interval '1 millisecond')
           FROM candidates
          WHERE event.id = candidates.id
         RETURNING event.id, event.workspace_id, event.aggregate_id, event.event_type, event.sequence,
                   event.payload, event.published_at, event.created_at, event.attempts,
                   event.next_attempt_at, event.lease_token, event.lease_until, event.last_error, event.unknown_at`,
        values,
      )
      return result.rows.map(toOutboxEvent)
    })
  }

  async recordFailure(workspaceId: string, id: string, failure: OutboxFailure, nextAttemptAt: string, leaseToken?: string): Promise<OutboxEvent> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<OutboxRow>(
        `UPDATE outbox_events
            SET attempts = attempts + 1,
                next_attempt_at = $4::timestamptz,
                last_error = $5::jsonb,
                lease_token = NULL,
                lease_until = NULL
          WHERE workspace_id = $1 AND id = $2 AND published_at IS NULL
            AND unknown_at IS NULL AND ($3::text IS NULL OR lease_token = $3)
          RETURNING id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                    attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at`,
        [scope, id, leaseToken ?? null, nextAttemptAt, JSON.stringify(failure)],
      )
      if (!result.rows[0]) throw new OutboxEventNotFoundError()
      return toOutboxEvent(result.rows[0])
    })
  }

  async markUnknown(workspaceId: string, id: string, failure: OutboxFailure, leaseToken?: string): Promise<OutboxEvent> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<OutboxRow>(
        `UPDATE outbox_events
            SET attempts = attempts + 1,
                unknown_at = COALESCE(unknown_at, now()),
                last_error = $4::jsonb,
                lease_token = NULL,
                lease_until = NULL
          WHERE workspace_id = $1 AND id = $2 AND published_at IS NULL
            AND ($3::text IS NULL OR lease_token = $3)
          RETURNING id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                    attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at`,
        [scope, id, leaseToken ?? null, JSON.stringify(failure)],
      )
      if (!result.rows[0]) throw new OutboxEventNotFoundError()
      return toOutboxEvent(result.rows[0])
    })
  }

  async ack(workspaceId: string, id: string, leaseToken?: string, publishedAt = new Date().toISOString()): Promise<OutboxEvent> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<OutboxRow>(
        `UPDATE outbox_events
            SET published_at = COALESCE(published_at, $4::timestamptz), lease_token = NULL, lease_until = NULL
          WHERE workspace_id = $1 AND id = $2
            AND (published_at IS NOT NULL OR $3::text IS NULL OR lease_token = $3)
          RETURNING id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                    attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at`,
        [scope, id, leaseToken ?? null, publishedAt],
      )
      if (!result.rows[0]) throw new OutboxEventNotFoundError()
      return toOutboxEvent(result.rows[0])
    })
  }

  async loadStateSnapshots(workspaceId: string) {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<{ aggregate_id: string; sequence: number; payload: Record<string, unknown> }>(
        `SELECT aggregate_id, sequence, payload
           FROM outbox_events
          WHERE workspace_id = $1 AND event_type = 'state.snapshot'
          ORDER BY aggregate_id ASC, sequence ASC, created_at ASC`,
        [scope],
      )
      return result.rows.map(row => ({ aggregateId: row.aggregate_id, sequence: row.sequence, payload: row.payload }))
    })
  }

  async listActiveWorkspaceIds(): Promise<string[]> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<{ id: string }>("SELECT id FROM workspaces WHERE status = 'active' ORDER BY id")
      return result.rows.map(row => row.id)
    } finally { client.release?.() }
  }
}

/**
 * Runs work with an RLS scope local to the current transaction.
 * `set_config(..., true)` is PostgreSQL's parameter-safe equivalent of
 * `SET LOCAL app.workspace_id = ...`; unlike string interpolation it keeps
 * arbitrary workspace ids out of SQL text.
 */
export async function withWorkspaceTransaction<T>(
  pool: SqlPool,
  workspaceId: string | undefined,
  work: (client: SqlClient) => Promise<T>,
): Promise<T> {
  const scope = requireWorkspaceScope(workspaceId)
  const client = await pool.connect()
  let committed = false
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [scope])
    const result = await work(client)
    await client.query('COMMIT')
    committed = true
    return result
  } catch (error) {
    if (!committed) {
      try { await client.query('ROLLBACK') } catch { /* preserve the original error */ }
    }
    throw error
  } finally {
    client.release?.()
  }
}
