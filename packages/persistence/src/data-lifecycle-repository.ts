import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type DataDeletionScope = 'workspace' | 'assets' | 'business'
export type DataDeletionStatus = 'pending' | 'approved' | 'cancelled' | 'completed' | 'incomplete'
export interface DataDeletionApproval { actorId: string; approvedAt: string; reason: string }
export interface DataDeletionRequest { id: string; workspaceId: string; scope: DataDeletionScope; reason: string; requestedBy: string; requestedAt: string; gracePeriodDays: number; scheduledFor: string; status: DataDeletionStatus; approvals: DataDeletionApproval[]; cancelledBy?: string; cancelledAt?: string; cancellationReason?: string; completedBy?: string; completedAt?: string; executionProofRef?: string }
export interface DataLifecycleRepository { request(input: { workspaceId: string; scope: DataDeletionScope; reason: string; requestedBy: string; gracePeriodDays: number; idempotencyKey: string }): Promise<DataDeletionRequest>; list(workspaceId: string, limit?: number): Promise<DataDeletionRequest[]>; cancel(input: { workspaceId: string; id: string; actorId: string; reason: string }): Promise<DataDeletionRequest>; approve(input: { workspaceId: string; id: string; actorId: string; reason: string }): Promise<DataDeletionRequest>; complete(input: { workspaceId: string; id: string; workerId: string; proofRef: string; now?: string }): Promise<DataDeletionRequest> }

export class DataDeletionIdempotencyConflictError extends Error {
  readonly code = 'DATA_DELETION_IDEMPOTENCY_CONFLICT'
  constructor() { super('data deletion idempotency key is already bound to a different request') }
}

function deletionIntent(input: { scope: DataDeletionScope; reason: string; requestedBy: string; gracePeriodDays: number }) {
  return JSON.stringify({ scope: input.scope, reason: input.reason, requestedBy: input.requestedBy, gracePeriodDays: input.gracePeriodDays })
}

export class MemoryDataLifecycleRepository implements DataLifecycleRepository {
  private readonly rows = new Map<string, DataDeletionRequest>()
  private readonly idempotency = new Map<string, string>()
  async request(input: { workspaceId: string; scope: DataDeletionScope; reason: string; requestedBy: string; gracePeriodDays: number; idempotencyKey: string }) {
    const key = `${input.workspaceId}:${input.idempotencyKey}`
    const existing = this.idempotency.get(key)
    if (existing) {
      const row = this.rows.get(existing)!
      if (deletionIntent(row) !== deletionIntent(input)) throw new DataDeletionIdempotencyConflictError()
      return row
    }
    const requestedAt = new Date().toISOString()
    const scheduledFor = new Date(Date.now() + input.gracePeriodDays * 86400000).toISOString()
    const row: DataDeletionRequest = { id: `deletion_${randomUUID()}`, workspaceId: input.workspaceId, scope: input.scope, reason: input.reason, requestedBy: input.requestedBy, requestedAt, gracePeriodDays: input.gracePeriodDays, scheduledFor, status: 'pending', approvals: [] }
    this.rows.set(row.id, row); this.idempotency.set(key, row.id); return row
  }
  async list(workspaceId: string, limit = 100) { return [...this.rows.values()].filter(row => row.workspaceId === workspaceId).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).slice(0, Math.min(500, Math.max(1, limit))) }
  async cancel(input: { workspaceId: string; id: string; actorId: string; reason: string }) {
    const row = this.rows.get(input.id)
    if (!row || row.workspaceId !== input.workspaceId) throw new Error('DATA_DELETION_REQUEST_NOT_FOUND')
    if (row.status !== 'pending') throw new Error('DATA_DELETION_REQUEST_NOT_PENDING')
    const updated = { ...row, status: 'cancelled' as const, cancelledBy: input.actorId, cancelledAt: new Date().toISOString(), cancellationReason: input.reason }
    this.rows.set(row.id, updated); return updated
  }
  async approve(input: { workspaceId: string; id: string; actorId: string; reason: string }) {
    const row = this.rows.get(input.id)
    if (!row || row.workspaceId !== input.workspaceId) throw new Error('DATA_DELETION_REQUEST_NOT_FOUND')
    if (row.status !== 'pending') throw new Error('DATA_DELETION_REQUEST_NOT_PENDING')
    if (!input.reason.trim()) throw new Error('DATA_DELETION_APPROVAL_REASON_REQUIRED')
    if (row.requestedBy === input.actorId || row.approvals.some(approval => approval.actorId === input.actorId)) throw new Error('DATA_DELETION_APPROVAL_SEPARATION_REQUIRED')
    const approvals = [...row.approvals, { actorId: input.actorId, approvedAt: new Date().toISOString(), reason: input.reason }]
    const updated = { ...row, approvals, status: approvals.length >= 2 ? 'approved' as const : 'pending' as const }
    this.rows.set(row.id, updated); return updated
  }
  async complete(input: { workspaceId: string; id: string; workerId: string; proofRef: string; now?: string }) {
    const row = this.rows.get(input.id)
    if (!row || row.workspaceId !== input.workspaceId) throw new Error('DATA_DELETION_REQUEST_NOT_FOUND')
    if (row.status !== 'approved') throw new Error('DATA_DELETION_REQUEST_NOT_APPROVED')
    if (row.approvals.length < 2) throw new Error('DATA_DELETION_APPROVALS_INCOMPLETE')
    if (!input.workerId.trim() || !input.proofRef.trim()) throw new Error('DATA_DELETION_EXECUTION_PROOF_REQUIRED')
    if (Date.parse(row.scheduledFor) > Date.parse(input.now ?? new Date().toISOString())) throw new Error('DATA_DELETION_GRACE_PERIOD_ACTIVE')
    const updated = { ...row, status: 'completed' as const, completedBy: input.workerId.trim(), completedAt: new Date().toISOString(), executionProofRef: input.proofRef.trim() }
    this.rows.set(row.id, updated); return updated
  }
}

const projection = `id, workspace_id AS "workspaceId", scope, reason, requested_by AS "requestedBy", requested_at AS "requestedAt", grace_period_days AS "gracePeriodDays", scheduled_for AS "scheduledFor", status, approvals, cancelled_by AS "cancelledBy", cancelled_at AS "cancelledAt", cancellation_reason AS "cancellationReason", completed_by AS "completedBy", completed_at AS "completedAt", execution_proof_ref AS "executionProofRef"`
export class PostgresDataLifecycleRepository implements DataLifecycleRepository {
  constructor(private readonly pool: SqlPool) {}
  async request(input: { workspaceId: string; scope: DataDeletionScope; reason: string; requestedBy: string; gracePeriodDays: number; idempotencyKey: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const existing = await client.query<DataDeletionRequest>(`SELECT ${projection} FROM workspace_data_deletion_requests WHERE workspace_id=$1 AND idempotency_key=$2`, [input.workspaceId, input.idempotencyKey])
      if (existing.rows[0]) {
        if (deletionIntent(existing.rows[0]) !== deletionIntent(input)) throw new DataDeletionIdempotencyConflictError()
        return existing.rows[0]
      }
      const result = await client.query<DataDeletionRequest>(`INSERT INTO workspace_data_deletion_requests (id, workspace_id, scope, reason, requested_by, grace_period_days, scheduled_for, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,now() + ($6::text || ' days')::interval,$7) RETURNING ${projection}`, [randomUUID(), input.workspaceId, input.scope, input.reason, input.requestedBy, input.gracePeriodDays, input.idempotencyKey])
      return result.rows[0]!
    })
  }
  async list(workspaceId: string, limit = 100) { requireWorkspaceScope(workspaceId); return withWorkspaceTransaction(this.pool, workspaceId, async client => (await client.query<DataDeletionRequest>(`SELECT ${projection} FROM workspace_data_deletion_requests WHERE workspace_id=$1 ORDER BY requested_at DESC,id DESC LIMIT $2`, [workspaceId, Math.min(500, Math.max(1, limit))])).rows) }
  async cancel(input: { workspaceId: string; id: string; actorId: string; reason: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<DataDeletionRequest>(`UPDATE workspace_data_deletion_requests SET status='cancelled', cancelled_by=$3, cancelled_at=now(), cancellation_reason=$4 WHERE workspace_id=$1 AND id=$2 AND status='pending' RETURNING ${projection}`, [input.workspaceId, input.id, input.actorId, input.reason])
      if (!result.rows[0]) throw new Error('DATA_DELETION_REQUEST_NOT_FOUND_OR_NOT_PENDING')
      return result.rows[0]
    })
  }
  async approve(input: { workspaceId: string; id: string; actorId: string; reason: string }) {
    requireWorkspaceScope(input.workspaceId)
    if (!input.reason.trim()) throw new Error('DATA_DELETION_APPROVAL_REASON_REQUIRED')
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const existing = await client.query<DataDeletionRequest>(`SELECT ${projection} FROM workspace_data_deletion_requests WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [input.workspaceId, input.id])
      const row = existing.rows[0]
      if (!row) throw new Error('DATA_DELETION_REQUEST_NOT_FOUND')
      if (row.status !== 'pending') throw new Error('DATA_DELETION_REQUEST_NOT_PENDING')
      const approvals = Array.isArray(row.approvals) ? row.approvals : []
      if (row.requestedBy === input.actorId || approvals.some(approval => approval.actorId === input.actorId)) throw new Error('DATA_DELETION_APPROVAL_SEPARATION_REQUIRED')
      const nextApprovals = [...approvals, { actorId: input.actorId, approvedAt: new Date().toISOString(), reason: input.reason }]
      const result = await client.query<DataDeletionRequest>(`UPDATE workspace_data_deletion_requests SET approvals=$3::jsonb, status=$4 WHERE workspace_id=$1 AND id=$2 RETURNING ${projection}`, [input.workspaceId, input.id, JSON.stringify(nextApprovals), nextApprovals.length >= 2 ? 'approved' : 'pending'])
      return result.rows[0]!
    })
  }
  async complete(input: { workspaceId: string; id: string; workerId: string; proofRef: string; now?: string }) {
    requireWorkspaceScope(input.workspaceId)
    if (!input.workerId.trim() || !input.proofRef.trim()) throw new Error('DATA_DELETION_EXECUTION_PROOF_REQUIRED')
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<DataDeletionRequest>(`UPDATE workspace_data_deletion_requests SET status='completed', completed_by=$3, completed_at=now(), execution_proof_ref=$4 WHERE workspace_id=$1 AND id=$2 AND status='approved' AND jsonb_array_length(approvals) >= 2 AND scheduled_for <= $5::timestamptz RETURNING ${projection}`, [input.workspaceId, input.id, input.workerId.trim(), input.proofRef.trim(), input.now ?? new Date().toISOString()])
      if (!result.rows[0]) throw new Error('DATA_DELETION_REQUEST_NOT_APPROVED_OR_GRACE_PERIOD_ACTIVE')
      return result.rows[0]
    })
  }
}
