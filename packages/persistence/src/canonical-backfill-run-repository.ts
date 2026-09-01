import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type CanonicalBackfillRunStatus = 'planned' | 'running' | 'paused' | 'completed' | 'failed'
export interface CanonicalBackfillRun { id: string; workspaceId: string; status: CanonicalBackfillRunStatus; dryRun: boolean; batchLimit?: number; cursorProductId?: string; lastResult: Record<string, unknown>; revision: number; createdBy: string; reason: string; createdAt: string; updatedAt: string }
export interface CreateCanonicalBackfillRun { workspaceId: string; dryRun: boolean; batchLimit?: number; createdBy: string; reason: string }
export interface UpdateCanonicalBackfillRun { id: string; workspaceId: string; expectedRevision: number; status?: CanonicalBackfillRunStatus; cursorProductId?: string; lastResult?: Record<string, unknown> }
export interface CanonicalBackfillRunRepository { create(input: CreateCanonicalBackfillRun): Promise<CanonicalBackfillRun>; get(input: { workspaceId: string; id: string }): Promise<CanonicalBackfillRun | undefined>; update(input: UpdateCanonicalBackfillRun): Promise<CanonicalBackfillRun> }
const clone = <T>(value: T): T => structuredClone(value)
const required = (value: string, code: string) => { if (!value.trim()) throw new Error(code); return value.trim() }
const validateCreate = (input: CreateCanonicalBackfillRun) => { const workspaceId = requireWorkspaceScope(input.workspaceId); if (input.batchLimit !== undefined && (!Number.isSafeInteger(input.batchLimit) || input.batchLimit < 1 || input.batchLimit > 5000)) throw new Error('CANONICAL_BACKFILL_BATCH_LIMIT_INVALID'); return { ...input, workspaceId, createdBy: required(input.createdBy, 'CANONICAL_BACKFILL_ACTOR_REQUIRED'), reason: required(input.reason, 'CANONICAL_BACKFILL_REASON_REQUIRED') } }
type Row = { id: string; workspace_id: string; status: CanonicalBackfillRunStatus; dry_run: boolean; batch_limit: number | null; cursor_product_id: string | null; last_result: Record<string, unknown>; revision: number; created_by: string; reason: string; created_at: string | Date; updated_at: string | Date }
const map = (row: Row): CanonicalBackfillRun => ({ id: row.id, workspaceId: row.workspace_id, status: row.status, dryRun: row.dry_run, ...(row.batch_limit === null ? {} : { batchLimit: row.batch_limit }), ...(row.cursor_product_id === null ? {} : { cursorProductId: row.cursor_product_id }), lastResult: row.last_result, revision: row.revision, createdBy: row.created_by, reason: row.reason, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at), updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at) })
const projection = 'id,workspace_id,status,dry_run,batch_limit,cursor_product_id,last_result,revision,created_by,reason,created_at,updated_at'
export class CanonicalBackfillRunRevisionConflictError extends Error { constructor() { super('CANONICAL_BACKFILL_RUN_REVISION_CONFLICT'); this.name = 'CanonicalBackfillRunRevisionConflictError' } }
export class CanonicalBackfillRunStateError extends Error { constructor(status: CanonicalBackfillRunStatus, nextStatus: CanonicalBackfillRunStatus) { super(`CANONICAL_BACKFILL_RUN_STATE_INVALID:${status}->${nextStatus}`); this.name = 'CanonicalBackfillRunStateError' } }
const allowedTransitions: Record<CanonicalBackfillRunStatus, readonly CanonicalBackfillRunStatus[]> = {
  planned: ['planned', 'running', 'paused', 'failed'],
  running: ['running', 'paused', 'completed', 'failed'],
  paused: ['paused', 'running', 'failed'],
  completed: ['completed'],
  failed: ['failed', 'running'],
}
const validateTransition = (current: CanonicalBackfillRunStatus, next: CanonicalBackfillRunStatus) => {
  if (!allowedTransitions[current].includes(next)) throw new CanonicalBackfillRunStateError(current, next)
}
const canRetryFailedRun = (run: CanonicalBackfillRun, nextStatus: CanonicalBackfillRunStatus) => {
  if (run.status !== 'failed' || nextStatus !== 'running') return
  if (typeof run.lastResult.error !== 'string' || !run.lastResult.error.trim() || Array.isArray(run.lastResult.conflicts)) {
    throw new CanonicalBackfillRunStateError(run.status, nextStatus)
  }
}
export class MemoryCanonicalBackfillRunRepository implements CanonicalBackfillRunRepository {
  private readonly rows = new Map<string, CanonicalBackfillRun>()
  async create(input: CreateCanonicalBackfillRun) { const value = validateCreate(input); const now = new Date().toISOString(); const run: CanonicalBackfillRun = { id: `backfill_${randomUUID()}`, workspaceId: value.workspaceId, status: 'planned', dryRun: value.dryRun, ...(value.batchLimit === undefined ? {} : { batchLimit: value.batchLimit }), lastResult: {}, revision: 1, createdBy: value.createdBy, reason: value.reason, createdAt: now, updatedAt: now }; this.rows.set(run.id, run); return clone(run) }
  async get(input: { workspaceId: string; id: string }) { const workspaceId = requireWorkspaceScope(input.workspaceId); const run = this.rows.get(required(input.id, 'CANONICAL_BACKFILL_RUN_ID_REQUIRED')); return run?.workspaceId === workspaceId ? clone(run) : undefined }
  async update(input: UpdateCanonicalBackfillRun) { const workspaceId = requireWorkspaceScope(input.workspaceId); const run = this.rows.get(required(input.id, 'CANONICAL_BACKFILL_RUN_ID_REQUIRED')); if (!run || run.workspaceId !== workspaceId) throw new Error('CANONICAL_BACKFILL_RUN_NOT_FOUND'); if (run.revision !== input.expectedRevision) throw new CanonicalBackfillRunRevisionConflictError(); if (input.status !== undefined) { validateTransition(run.status, input.status); canRetryFailedRun(run, input.status) } const next = { ...run, ...(input.status === undefined ? {} : { status: input.status }), ...(input.cursorProductId === undefined ? {} : { cursorProductId: input.cursorProductId }), ...(input.lastResult === undefined ? {} : { lastResult: clone(input.lastResult) }), revision: run.revision + 1, updatedAt: new Date().toISOString() }; this.rows.set(run.id, next); return clone(next) }
}
export class PostgresCanonicalBackfillRunRepository implements CanonicalBackfillRunRepository {
  constructor(private readonly pool: SqlPool) {}
  async create(input: CreateCanonicalBackfillRun) { const value = validateCreate(input); return withWorkspaceTransaction(this.pool, value.workspaceId, async client => { const result = await client.query<Row>(`INSERT INTO canonical_backfill_runs (id,workspace_id,dry_run,batch_limit,created_by,reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${projection}`, [`backfill_${randomUUID()}`, value.workspaceId, value.dryRun, value.batchLimit ?? null, value.createdBy, value.reason]); return map(result.rows[0]!) }) }
  async get(input: { workspaceId: string; id: string }) { const workspaceId = requireWorkspaceScope(input.workspaceId); const id = required(input.id, 'CANONICAL_BACKFILL_RUN_ID_REQUIRED'); return withWorkspaceTransaction(this.pool, workspaceId, async client => { const result = await client.query<Row>(`SELECT ${projection} FROM canonical_backfill_runs WHERE workspace_id=$1 AND id=$2`, [workspaceId, id]); return result.rows[0] ? map(result.rows[0]) : undefined }) }
  async update(input: UpdateCanonicalBackfillRun) { const workspaceId = requireWorkspaceScope(input.workspaceId); const id = required(input.id, 'CANONICAL_BACKFILL_RUN_ID_REQUIRED'); return withWorkspaceTransaction(this.pool, workspaceId, async client => { const current = await client.query<Row>(`SELECT ${projection} FROM canonical_backfill_runs WHERE workspace_id=$1 AND id=$2`, [workspaceId, id]); if (!current.rows[0]) throw new Error('CANONICAL_BACKFILL_RUN_NOT_FOUND'); const run = map(current.rows[0]); if (input.status !== undefined) { validateTransition(run.status, input.status); canRetryFailedRun(run, input.status) } const result = await client.query<Row>(`UPDATE canonical_backfill_runs SET status=COALESCE($3,status),cursor_product_id=COALESCE($4,cursor_product_id),last_result=COALESCE($5::jsonb,last_result),revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND revision=$6 RETURNING ${projection}`, [workspaceId, id, input.status ?? null, input.cursorProductId ?? null, input.lastResult ? JSON.stringify(input.lastResult) : null, input.expectedRevision]); if (!result.rows[0]) { const exists = await client.query('SELECT 1 FROM canonical_backfill_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, id]); if (!exists.rowCount) throw new Error('CANONICAL_BACKFILL_RUN_NOT_FOUND'); throw new CanonicalBackfillRunRevisionConflictError() } return map(result.rows[0]) }) }
}
