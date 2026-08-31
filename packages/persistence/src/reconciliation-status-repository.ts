import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type ReconciliationStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'manual_attention'

export interface ReconciliationStatusRecord {
  workspaceId: string
  resourceType: string
  resourceId: string
  status: ReconciliationStatus
  lastIdempotencyKey: string
  details: Record<string, unknown>
  observedAt: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface ReconciliationStatusRepository {
  upsert(input: { workspaceId: string; resourceType: string; resourceId: string; status: ReconciliationStatus; idempotencyKey: string; details?: Record<string, unknown>; observedAt?: string }): Promise<ReconciliationStatusRecord>
  getLatest(input: { workspaceId: string; resourceType?: string; resourceId?: string }): Promise<ReconciliationStatusRecord | undefined>
  list(input: { workspaceId: string; resourceType?: string; limit?: number }): Promise<ReconciliationStatusRecord[]>
}

const text = (value: string, code: string, max = 512) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(code)
  return value.trim()
}
const timestamp = (value: string | undefined) => {
  const result = value ?? new Date().toISOString()
  if (Number.isNaN(Date.parse(result))) throw new Error('RECONCILIATION_OBSERVED_AT_INVALID')
  return result
}
const isStaleObservation = (current: Pick<ReconciliationStatusRecord, 'observedAt'> | Pick<Row, 'observed_at'>, incoming: string) => {
  const currentObservedAt = 'observedAt' in current ? current.observedAt : iso(current.observed_at)
  return Date.parse(incoming) < Date.parse(currentObservedAt)
}
const validate = (input: Parameters<ReconciliationStatusRepository['upsert']>[0]) => ({
  workspaceId: requireWorkspaceScope(input.workspaceId),
  resourceType: text(input.resourceType, 'RECONCILIATION_RESOURCE_TYPE_REQUIRED', 128),
  resourceId: text(input.resourceId, 'RECONCILIATION_RESOURCE_ID_REQUIRED', 256),
  idempotencyKey: text(input.idempotencyKey, 'RECONCILIATION_IDEMPOTENCY_KEY_REQUIRED'),
  status: input.status,
  details: input.details ?? {},
  observedAt: timestamp(input.observedAt),
})
const keyOf = (input: { workspaceId: string; resourceType: string; resourceId: string }) => `${input.workspaceId}\0${input.resourceType}\0${input.resourceId}`

export class ReconciliationIdempotencyConflictError extends Error {
  constructor() { super('RECONCILIATION_IDEMPOTENCY_CONFLICT'); this.name = 'ReconciliationIdempotencyConflictError' }
}

export class MemoryReconciliationStatusRepository implements ReconciliationStatusRepository {
  private readonly rows = new Map<string, ReconciliationStatusRecord>()
  async upsert(input: Parameters<ReconciliationStatusRepository['upsert']>[0]) {
    const value = validate(input)
    const key = keyOf(value)
    const current = this.rows.get(key)
    if (current?.lastIdempotencyKey === value.idempotencyKey) {
      if (current.status !== value.status || JSON.stringify(current.details) !== JSON.stringify(value.details)) throw new ReconciliationIdempotencyConflictError()
      return structuredClone(current)
    }
    // A delayed report must never move the projection backwards. Return the
    // current snapshot as a no-op so callers retain idempotent retry semantics.
    if (current && isStaleObservation(current, value.observedAt)) return structuredClone(current)
    const now = new Date().toISOString()
    const next: ReconciliationStatusRecord = {
      workspaceId: value.workspaceId, resourceType: value.resourceType, resourceId: value.resourceId, status: value.status,
      lastIdempotencyKey: value.idempotencyKey, details: structuredClone(value.details), observedAt: value.observedAt,
      revision: (current?.revision ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now,
    }
    this.rows.set(key, next)
    return structuredClone(next)
  }
  async getLatest(input: { workspaceId: string; resourceType?: string; resourceId?: string }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const row = [...this.rows.values()]
      .filter(row => row.workspaceId === workspaceId && (!input.resourceType || row.resourceType === input.resourceType) && (!input.resourceId || row.resourceId === input.resourceId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.resourceType.localeCompare(a.resourceType) || b.resourceId.localeCompare(a.resourceId))[0]
    return row ? structuredClone(row) : undefined
  }
  async list(input: { workspaceId: string; resourceType?: string; limit?: number }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const limit = input.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError('RECONCILIATION_LIST_LIMIT_INVALID')
    return [...this.rows.values()]
      .filter(row => row.workspaceId === workspaceId && (!input.resourceType || row.resourceType === input.resourceType))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.resourceType.localeCompare(b.resourceType) || a.resourceId.localeCompare(b.resourceId))
      .slice(0, limit)
      .map(row => structuredClone(row))
  }
}

type Row = { workspace_id: string; resource_type: string; resource_id: string; status: ReconciliationStatus; last_idempotency_key: string; details: Record<string, unknown>; observed_at: string | Date; revision: number; created_at: string | Date; updated_at: string | Date }
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const map = (row: Row): ReconciliationStatusRecord => ({ workspaceId: row.workspace_id, resourceType: row.resource_type, resourceId: row.resource_id, status: row.status, lastIdempotencyKey: row.last_idempotency_key, details: row.details, observedAt: iso(row.observed_at), revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const projection = 'workspace_id,resource_type,resource_id,status,last_idempotency_key,details,observed_at,revision,created_at,updated_at'

export class PostgresReconciliationStatusRepository implements ReconciliationStatusRepository {
  constructor(private readonly pool: SqlPool) {}
  async upsert(input: Parameters<ReconciliationStatusRepository['upsert']>[0]) {
    const value = validate(input)
    return withWorkspaceTransaction(this.pool, value.workspaceId, async client => {
      const existing = await client.query<Row>(`SELECT ${projection} FROM workspace_reconciliation_status WHERE workspace_id=$1 AND resource_type=$2 AND resource_id=$3 FOR UPDATE`, [value.workspaceId, value.resourceType, value.resourceId])
      if (existing.rows[0]?.last_idempotency_key === value.idempotencyKey) {
        const row = existing.rows[0]!
        if (row.status !== value.status || JSON.stringify(row.details) !== JSON.stringify(value.details)) throw new ReconciliationIdempotencyConflictError()
        return map(row)
      }
      // The row lock makes this comparison safe against concurrent reports.
      // A late provider response is a successful no-op, not a new revision.
      if (existing.rows[0] && isStaleObservation(existing.rows[0], value.observedAt)) return map(existing.rows[0])
      const result = await client.query<Row>(
        `INSERT INTO workspace_reconciliation_status (workspace_id,resource_type,resource_id,status,last_idempotency_key,details,observed_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)
         ON CONFLICT (workspace_id,resource_type,resource_id) DO UPDATE SET status=EXCLUDED.status,last_idempotency_key=EXCLUDED.last_idempotency_key,details=EXCLUDED.details,observed_at=EXCLUDED.observed_at,revision=workspace_reconciliation_status.revision+1,updated_at=now()
         RETURNING ${projection}`,
        [value.workspaceId, value.resourceType, value.resourceId, value.status, value.idempotencyKey, JSON.stringify(value.details), value.observedAt],
      )
      return map(result.rows[0]!)
    })
  }
  async getLatest(input: { workspaceId: string; resourceType?: string; resourceId?: string }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<Row>(`SELECT ${projection} FROM workspace_reconciliation_status WHERE workspace_id=$1 AND ($2::text IS NULL OR resource_type=$2) AND ($3::text IS NULL OR resource_id=$3) ORDER BY updated_at DESC, resource_type DESC, resource_id DESC LIMIT 1`, [workspaceId, input.resourceType ?? null, input.resourceId ?? null])
      return result.rows[0] ? map(result.rows[0]) : undefined
    })
  }
  async list(input: { workspaceId: string; resourceType?: string; limit?: number }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const limit = input.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError('RECONCILIATION_LIST_LIMIT_INVALID')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<Row>(`SELECT ${projection} FROM workspace_reconciliation_status WHERE workspace_id=$1 AND ($2::text IS NULL OR resource_type=$2) ORDER BY updated_at DESC, resource_type ASC, resource_id ASC LIMIT $3`, [workspaceId, input.resourceType ?? null, limit])
      return result.rows.map(map)
    })
  }
}

export const InMemoryReconciliationStatusRepository = MemoryReconciliationStatusRepository
