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
  /**
   * pg.Client.release accepts an error to destroy a connection that may still
   * be inside a failed transaction. Adapters that do not need this signal can
   * ignore the optional argument.
   */
  release?: (error?: Error) => void
}

export interface SqlPool {
  connect(): Promise<SqlClient>
}

/**
 * Serializes workspace lifecycle changes with decisions that bind identities
 * to currently active workspaces. The advisory transaction lock needs no
 * table UPDATE grant, so both the merchant_ops auth pool and tenant pool can
 * participate. Every multi-workspace caller acquires these locks in sorted
 * order to avoid lock-order deadlocks.
 */
export async function acquireWorkspaceStatusLocks(client: SqlClient, workspaceIds: readonly string[]): Promise<void> {
  const sortedIds = [...new Set(workspaceIds.filter(id => id.trim().length > 0))].sort()
  for (const workspaceId of sortedIds) {
    await client.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('merchant_workspace_status_v1'), pg_catalog.hashtext($1))",
      [workspaceId],
    )
  }
}

export interface CompletedImageUnknownAck {
  workspaceId: string; eventId: string; jobId: string; providerRequestId: string;
  intentHash: string; expectedUnknownAt: string; expectedAttempt: number;
  expectedJob: Record<string, unknown>; expectedEventPayload: Record<string, unknown>;
}

export interface OutboxRepository {
  listCompletedImageUnknown?(workspaceId: string, limit: number, after?: { unknownAt: string; eventId: string }): Promise<OutboxEvent[]>
  ackCompletedImageUnknown?(input: CompletedImageUnknownAck): Promise<boolean>
  append(input: OutboxEventInput): Promise<OutboxEvent>
  pending(workspaceId: string, limit?: number): Promise<OutboxEvent[]>
  markPublished(workspaceId: string, id: string, publishedAt?: string): Promise<OutboxEvent>
  listAggregateEvents(workspaceId: string, aggregateId: string, limit?: number, eventId?: string): Promise<OutboxEvent[]>
  listWorkspaceEvents?(workspaceId: string, limit?: number): Promise<OutboxEvent[]>
  listWorkspaceEventsAfter?(workspaceId: string, cursor: { createdAt: string; eventId: string } | undefined, limit?: number): Promise<OutboxEvent[]>
  metrics?(workspaceId: string): Promise<{ pending: number; connectorErrors: Record<string, number> }>
}

export interface OutboxFailure {
  code: string
  message: string
  retryable: boolean
  unknown?: boolean
}

export interface DurableOutboxRepository extends OutboxRepository {
  claimPending(workspaceId: string, options?: OutboxClaimOptions): Promise<OutboxEvent[]>
  validateLease(workspaceId: string, id: string, leaseToken: string, now?: string): Promise<OutboxEvent>
  renewLease(workspaceId: string, id: string, leaseToken: string, leaseMs: number, now?: string): Promise<OutboxEvent>
  recordFailure(workspaceId: string, id: string, failure: OutboxFailure, nextAttemptAt: string, leaseToken?: string): Promise<OutboxEvent>
  deadLetter(workspaceId: string, id: string, failure: OutboxFailure, leaseToken?: string): Promise<OutboxEvent>
  markUnknown(workspaceId: string, id: string, failure: OutboxFailure, leaseToken?: string): Promise<OutboxEvent>
  ack(workspaceId: string, id: string, leaseToken?: string, publishedAt?: string): Promise<OutboxEvent>
  /**
   * Reverts a claim that never became work because the queue refused its
   * delivery. Nothing carries this token, so no handler can run under it;
   * leaving the counter incremented would spend the retry budget on an
   * execution that never started.
   */
  releaseClaim(workspaceId: string, id: string, leaseToken: string): Promise<OutboxEvent>
  loadStateSnapshots(workspaceId: string, options?: { excludeEntityTypes?: readonly string[] }): Promise<Array<{ aggregateId: string; sequence: number; payload: Record<string, unknown> }>>
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

// Outcome writes without a token are reserved for unclaimed/reconciled rows.
// Call lockOutboxRow before the conditional UPDATE so its clock_timestamp()
// check runs after any row-lock wait; UPDATE may qualify before waiting.
const outboxOutcomeLeasePredicate = `(($3::text IS NULL AND lease_token IS NULL AND lease_until IS NULL)
              OR ($3::text IS NOT NULL AND lease_token = $3 AND lease_until > clock_timestamp()))`

export class TenantScopeError extends Error { constructor() { super('workspace scope is required') } }

export class OutboxEventNotFoundError extends Error {
  readonly code = 'OUTBOX_EVENT_NOT_FOUND'
  constructor() {
    super('outbox event not found')
    this.name = 'OutboxEventNotFoundError'
  }
}

async function lockOutboxRow(client: SqlClient, workspaceId: string, id: string): Promise<void> {
  const result = await client.query<{ id: string }>(
    'SELECT id FROM outbox_events WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    [workspaceId, id],
  )
  if (!result.rows[0]) throw new OutboxEventNotFoundError()
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
  pending(workspaceId: string, limit = 100) {
    const scope = requireWorkspaceScope(workspaceId)
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    return this.events.filter(event => event.workspaceId === scope && !event.publishedAt).slice(0, limit)
  }
  markPublished(workspaceId: string, id: string) {
    const scope = requireWorkspaceScope(workspaceId)
    const event = this.events.find(item => item.workspaceId === scope && item.id === id)
    if (!event) throw new OutboxEventNotFoundError()
    event.publishedAt = new Date().toISOString()
    return event
  }
  all() { return [...this.events] }
  listAggregateEvents(workspaceId: string, aggregateId: string, limit = 100, eventId?: string) {
    if (!workspaceId.trim()) throw new TenantScopeError()
    if (!aggregateId.trim()) throw new Error('aggregate id is required')
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    const events = this.events.filter(event => event.workspaceId === workspaceId && event.aggregateId === aggregateId && (eventId === undefined || event.id === eventId)).sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt))
    return eventId === undefined ? events.slice(-limit) : events.slice(0, 1)
  }
  listWorkspaceEvents(workspaceId: string, limit = 1000) {
    if (!workspaceId.trim()) throw new TenantScopeError()
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    return this.events.filter(event => event.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(-limit)
  }
  listWorkspaceEventsAfter(workspaceId: string, cursor: { createdAt: string; eventId: string } | undefined, limit = 1000) {
    if (!workspaceId.trim()) throw new TenantScopeError()
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    return this.events.filter(event => event.workspaceId === workspaceId
      && (!cursor || event.createdAt > cursor.createdAt || (event.createdAt === cursor.createdAt && event.id > cursor.eventId)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(0, limit)
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

  async listCompletedImageUnknown(workspaceId: string, limit: number, after?: { unknownAt: string; eventId: string }): Promise<OutboxEvent[]> {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(workspaceId), async client => {
      const result = await client.query<OutboxRow & { exact_unknown_at: string }>(`SELECT o.*, o.unknown_at::text AS exact_unknown_at
        FROM outbox_events o JOIN image_generation_executions e ON e.workspace_id=o.workspace_id AND e.job_id=o.aggregate_id AND e.event_id=o.id
        WHERE o.workspace_id=$1 AND o.event_type='image.generation.requested' AND o.published_at IS NULL AND o.unknown_at IS NOT NULL
          AND o.lease_token IS NULL AND o.lease_until IS NULL AND e.state='completed'
          AND ($3::timestamptz IS NULL OR (o.unknown_at,o.id)>($3::timestamptz,$4::text))
        ORDER BY o.unknown_at,o.id LIMIT $2`, [workspaceId, limit, after?.unknownAt ?? null, after?.eventId ?? null])
      return result.rows.map(row => ({ ...toOutboxEvent(row), unknownAt: row.exact_unknown_at }))
    })
  }

  async ackCompletedImageUnknown(input: CompletedImageUnknownAck): Promise<boolean> {
    const { workspaceId, eventId, jobId, providerRequestId, intentHash, expectedUnknownAt, expectedAttempt, expectedJob, expectedEventPayload } = input
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(workspaceId), async client => {
      // Lock all identity/projection rows. The verified snapshot must still be
      // byte-for-byte JSON-equivalent at the ACK boundary, including receipts.
      const locked = await client.query(`SELECT o.id FROM outbox_events o
        JOIN image_generation_executions e ON e.workspace_id=o.workspace_id AND e.job_id=o.aggregate_id AND e.event_id=o.id
        JOIN business_entity_snapshots j ON j.workspace_id=o.workspace_id AND j.entity_type='image_generation_job' AND j.entity_id=e.job_id
        WHERE o.workspace_id=$1 AND o.id=$2 AND o.aggregate_id=$3 AND o.event_type='image.generation.requested'
          AND o.published_at IS NULL AND o.unknown_at=$4::timestamptz AND o.lease_token IS NULL AND o.lease_until IS NULL
          AND o.payload->>'intent_hash'=$5 AND o.payload=$9::jsonb AND e.state='completed' AND e.provider_request_id=$6 AND e.attempt=$7
          AND e.owner_token IS NULL AND e.lease_expires_at IS NULL AND j.payload=$8::jsonb
          AND j.payload->>'state'='succeeded' AND j.payload->>'archiveState'='archived'
          AND j.payload->>'intentHash'=$5 AND j.payload->>'workspaceId'=$1 AND j.payload->>'id'=$3
        FOR UPDATE OF o,e,j`, [workspaceId,eventId,jobId,expectedUnknownAt,intentHash,providerRequestId,expectedAttempt,JSON.stringify(expectedJob),JSON.stringify(expectedEventPayload)])
      if (!locked.rows.length) return false
      const auditId = randomUUID()
      const updated = await client.query<{ published_at: string }>(`UPDATE outbox_events SET published_at=now()
        WHERE workspace_id=$1 AND id=$2 AND published_at IS NULL RETURNING published_at::text`, [workspaceId,eventId])
      await client.query(`INSERT INTO workspace_operation_audit
        (id,workspace_id,actor_id,action,resource_type,resource_id,before_json,after_json,reason)
        VALUES ($1,$2,'worker:image-reconciliation','image.completed_unknown.ack','outbox_event',$3,$4,$5,$6)`,
        [auditId,workspaceId,eventId,{ unknown_at: expectedUnknownAt, published_at: null },
          { event_id:eventId,job_id:jobId,provider_request_id:providerRequestId,intent_hash:intentHash,execution_attempt:expectedAttempt,
            published_at:updated.rows[0]!.published_at,outputs:expectedJob.outputs,job_revision:expectedJob.revision,provider_called:false },
          'Verified archived bytes, archive receipts and original delivery settlement; acknowledge completed original event only'])
      return true
    })
  }

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
            AND COALESCE(last_error->>'terminal', 'false') <> 'true'
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
      await lockOutboxRow(client, scope, id)
      const result = await client.query<OutboxRow>(
        `UPDATE outbox_events
            SET published_at = COALESCE(published_at, $3::timestamptz), lease_token = NULL, lease_until = NULL
          WHERE workspace_id = $1 AND id = $2
            AND (published_at IS NOT NULL OR (unknown_at IS NULL AND lease_token IS NULL AND lease_until IS NULL))
          RETURNING id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at`,
        [scope, id, publishedAt],
      )
      if (!result.rows[0]) throw new OutboxEventNotFoundError()
      return toOutboxEvent(result.rows[0])
    })
  }

  async listAggregateEvents(workspaceId: string, aggregateId: string, limit = 100, eventId?: string): Promise<OutboxEvent[]> {
    const scope = requireWorkspaceScope(workspaceId)
    if (!aggregateId.trim()) throw new Error('aggregate id is required')
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = eventId !== undefined
        ? await client.query<OutboxRow>(
          `SELECT id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                  attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at
             FROM outbox_events
            WHERE workspace_id = $1 AND aggregate_id = $2 AND id = $3
            LIMIT 1`,
          [scope, aggregateId, eventId],
        )
        : await client.query<OutboxRow>(
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
        `SELECT * FROM (
           SELECT id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                  attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at
             FROM outbox_events
            WHERE workspace_id = $1
            ORDER BY created_at DESC, id DESC
            LIMIT $2
         ) recent
         ORDER BY created_at ASC, id ASC`,
        [scope, limit],
      )
      return result.rows.map(toOutboxEvent)
    })
  }

  async listWorkspaceEventsAfter(workspaceId: string, cursor: { createdAt: string; eventId: string } | undefined, limit = 1000): Promise<OutboxEvent[]> {
    const scope = requireWorkspaceScope(workspaceId)
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<OutboxRow>(
        `SELECT id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at
           FROM outbox_events
          WHERE workspace_id = $1
            AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz OR (created_at = $2::timestamptz AND id > $3))
          ORDER BY created_at ASC, id ASC
          LIMIT $4`,
        [scope, cursor?.createdAt ?? null, cursor?.eventId ?? '', limit],
      )
      return result.rows.map(toOutboxEvent)
    })
  }

  async claimPending(workspaceId: string, options: OutboxClaimOptions = {}): Promise<OutboxEvent[]> {
    const scope = requireWorkspaceScope(workspaceId)
    const limit = options.limit ?? 100
    const leaseMs = options.leaseMs ?? 30_000
    // Use the database clock when callers do not provide a deterministic
    // probe time.  App and PostgreSQL clocks can differ by a few milliseconds;
    // using a client timestamp can otherwise miss rows inserted by `now()`.
    const now = options.now ?? null
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
        // Published events are terminal delivery evidence. They must never be
        // leased or updated again because migration 109 makes that evidence
        // immutable; recovery uses a new outbox event instead.
        'published_at IS NULL',
        'unknown_at IS NULL',
        // A normal retry keeps its error evidence after releasing the lease.
        // Reclaim only explicit, non-unknown retries; malformed/legacy errors
        // still require reconciliation rather than an automatic side effect.
        "(last_error IS NULL OR (last_error->'retryable' = 'true'::jsonb AND COALESCE(last_error->'unknown', 'false'::jsonb) = 'false'::jsonb))",
        "COALESCE(last_error->>'terminal', 'false') <> 'true'",
        'next_attempt_at <= COALESCE($2::timestamptz, now())',
        '(lease_until IS NULL OR lease_until <= COALESCE($2::timestamptz, now()))',
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
                lease_until = COALESCE($2::timestamptz, now()) + ($${leaseMsIndex} * interval '1 millisecond'),
                -- The claim counter is the only durable evidence of an attempt
                -- that ends without an outcome (crash, OOM kill, hard restart).
                -- Incrementing it here - atomically with the lease - is what
                -- makes a crash loop reach a terminal state instead of being
                -- reclaimed until the provider gives up on us.
                attempts = event.attempts + 1
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

  async validateLease(workspaceId: string, id: string, leaseToken: string, now = new Date().toISOString()): Promise<OutboxEvent> {
    const scope = requireWorkspaceScope(workspaceId)
    if (!id) throw new Error('outbox event id is required')
    if (!leaseToken) throw new OutboxEventNotFoundError()
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<OutboxRow>(
        `SELECT id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at
           FROM outbox_events
          WHERE workspace_id = $1 AND id = $2 AND published_at IS NULL AND unknown_at IS NULL
            AND lease_token = $3 AND lease_until > GREATEST($4::timestamptz, clock_timestamp())
          LIMIT 1`,
        [scope, id, leaseToken, now],
      )
      if (!result.rows[0]) throw new OutboxEventNotFoundError()
      return toOutboxEvent(result.rows[0])
    })
  }

  async renewLease(workspaceId: string, id: string, leaseToken: string, leaseMs: number, now = new Date().toISOString()): Promise<OutboxEvent> {
    const scope = requireWorkspaceScope(workspaceId)
    if (!id) throw new Error('outbox event id is required')
    if (!leaseToken) throw new OutboxEventNotFoundError()
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new RangeError('leaseMs must be a positive integer')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      await lockOutboxRow(client, scope, id)
      const result = await client.query<OutboxRow>(
        `UPDATE outbox_events
            SET lease_until = GREATEST($4::timestamptz, clock_timestamp()) + ($5 * interval '1 millisecond')
          WHERE workspace_id = $1 AND id = $2
            AND published_at IS NULL AND unknown_at IS NULL
            AND lease_token = $3 AND lease_until > GREATEST($4::timestamptz, clock_timestamp())
          RETURNING id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                    attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at`,
        [scope, id, leaseToken, now, leaseMs],
      )
      if (!result.rows[0]) throw new OutboxEventNotFoundError()
      return toOutboxEvent(result.rows[0])
    })
  }

  async recordFailure(workspaceId: string, id: string, failure: OutboxFailure, nextAttemptAt: string, leaseToken?: string): Promise<OutboxEvent> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      await lockOutboxRow(client, scope, id)
      const result = await client.query<OutboxRow>(
        // This attempt was already counted by claimPending; incrementing again
        // here would spend the retry budget twice as fast as configured.
        `UPDATE outbox_events
            SET next_attempt_at = $4::timestamptz,
                last_error = $5::jsonb,
                lease_token = NULL,
                lease_until = NULL
          WHERE workspace_id = $1 AND id = $2 AND published_at IS NULL
            AND unknown_at IS NULL
            AND ${outboxOutcomeLeasePredicate}
          RETURNING id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                    attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at`,
        [scope, id, leaseToken ?? null, nextAttemptAt, JSON.stringify(failure)],
      )
      if (!result.rows[0]) throw new OutboxEventNotFoundError()
      return toOutboxEvent(result.rows[0])
    })
  }

  async deadLetter(workspaceId: string, id: string, failure: OutboxFailure, leaseToken?: string): Promise<OutboxEvent> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      await lockOutboxRow(client, scope, id)
      const result = await client.query<OutboxRow>(
        `UPDATE outbox_events
            SET last_error = COALESCE($4::jsonb, '{}'::jsonb) || '{"terminal":true}'::jsonb,
                lease_token = NULL,
                lease_until = NULL
          WHERE workspace_id = $1 AND id = $2 AND published_at IS NULL
            AND unknown_at IS NULL
            AND ${outboxOutcomeLeasePredicate}
          RETURNING id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                    attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at`,
        [scope, id, leaseToken ?? null, JSON.stringify(failure)],
      )
      if (!result.rows[0]) throw new OutboxEventNotFoundError()
      return toOutboxEvent(result.rows[0])
    })
  }

  async markUnknown(workspaceId: string, id: string, failure: OutboxFailure, leaseToken?: string): Promise<OutboxEvent> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      await lockOutboxRow(client, scope, id)
      const result = await client.query<OutboxRow>(
        `UPDATE outbox_events
            SET unknown_at = COALESCE(unknown_at, clock_timestamp()),
                last_error = $4::jsonb,
                lease_token = NULL,
                lease_until = NULL
          WHERE workspace_id = $1 AND id = $2 AND published_at IS NULL
            AND unknown_at IS NULL
            AND ${outboxOutcomeLeasePredicate}
          RETURNING id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                    attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at`,
        [scope, id, leaseToken ?? null, JSON.stringify(failure)],
      )
      if (!result.rows[0]) throw new OutboxEventNotFoundError()
      return toOutboxEvent(result.rows[0])
    })
  }

  async releaseClaim(workspaceId: string, id: string, leaseToken: string): Promise<OutboxEvent> {
    const scope = requireWorkspaceScope(workspaceId)
    if (!id) throw new Error('outbox event id is required')
    if (!leaseToken) throw new OutboxEventNotFoundError()
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<OutboxRow>(
        // The claim never produced a delivery, so the attempt it counted never
        // started: give it back instead of letting a full queue dead-letter an
        // event that no handler ever saw.
        `UPDATE outbox_events
            SET attempts = GREATEST(attempts - 1, 0),
                lease_token = NULL,
                lease_until = NULL
          WHERE workspace_id = $1 AND id = $2 AND published_at IS NULL
            AND unknown_at IS NULL AND lease_token = $3 AND attempts > 0
          RETURNING id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                    attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at`,
        [scope, id, leaseToken],
      )
      if (!result.rows[0]) throw new OutboxEventNotFoundError()
      return toOutboxEvent(result.rows[0])
    })
  }

  async ack(workspaceId: string, id: string, leaseToken?: string, publishedAt = new Date().toISOString()): Promise<OutboxEvent> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      await lockOutboxRow(client, scope, id)
      const result = await client.query<OutboxRow>(
        `UPDATE outbox_events
            SET published_at = COALESCE(published_at, $4::timestamptz), lease_token = NULL, lease_until = NULL
          WHERE workspace_id = $1 AND id = $2
            AND (published_at IS NOT NULL OR (unknown_at IS NULL AND ${outboxOutcomeLeasePredicate}))
          RETURNING id, workspace_id, aggregate_id, event_type, sequence, payload, published_at, created_at,
                    attempts, next_attempt_at, lease_token, lease_until, last_error, unknown_at`,
        [scope, id, leaseToken ?? null, publishedAt],
      )
      if (!result.rows[0]) throw new OutboxEventNotFoundError()
      return toOutboxEvent(result.rows[0])
    })
  }

  async loadStateSnapshots(workspaceId: string, options: { excludeEntityTypes?: readonly string[] } = {}) {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<{ aggregate_id: string; sequence: number; payload: Record<string, unknown> }>(
        `SELECT aggregate_id, sequence, payload
           FROM outbox_events
          WHERE workspace_id = $1 AND event_type = 'state.snapshot'
            AND NOT (coalesce(payload->>'entityType', '') = ANY($2::text[]))
          ORDER BY aggregate_id ASC, sequence ASC, created_at ASC`,
        [scope, options.excludeEntityTypes ?? []],
      )
      return result.rows.map(row => ({ aggregateId: row.aggregate_id, sequence: row.sequence, payload: row.payload }))
    })
  }

  async listActiveWorkspaceIds(): Promise<string[]> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM public.worker_active_workspace_catalog()',
      )
      return result.rows.map(row => row.workspace_id)
    } finally { client.release?.() }
  }

  async metrics(workspaceId: string): Promise<{ pending: number; connectorErrors: Record<string, number> }> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<{ pending: string | number; rate_limited: string | number; timeout: string | number }>(
        `SELECT count(*) FILTER (WHERE published_at IS NULL AND unknown_at IS NULL) AS pending,
                coalesce(sum(attempts) FILTER (WHERE last_error->>'code' = 'RATE_LIMITED'), 0) AS rate_limited,
                coalesce(sum(attempts) FILTER (WHERE last_error->>'code' = 'TIMEOUT'), 0) AS timeout
           FROM outbox_events
          WHERE workspace_id = $1`,
        [scope],
      )
      const row = result.rows[0] ?? { pending: 0, rate_limited: 0, timeout: 0 }
      return { pending: Number(row.pending), connectorErrors: { RATE_LIMITED: Number(row.rate_limited), TIMEOUT: Number(row.timeout) } }
    })
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
  let releaseError: Error | undefined
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [scope])
    const result = await work(client)
    await client.query('COMMIT')
    committed = true
    return result
  } catch (error) {
    if (!committed) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        // A failed rollback means the client cannot safely return to the pool:
        // pg will otherwise make the transaction state available to the next
        // workspace request. Passing an error to release destroys that client.
        releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
      }
    }
    throw error
  } finally {
    client.release?.(releaseError)
  }
}
