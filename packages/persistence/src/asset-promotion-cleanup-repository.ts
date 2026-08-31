import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'

export interface AssetPromotionCleanupBinding {
  workspaceId: string
  receiptId: string
  assetId: string
  assetSourceRevision: number
  quarantineKey: string
  cleanKey: string
  scanEvidenceRef: string
  objectSha256: string
  sizeBytes: number
  readyOutboxEventId: string
}

export interface AssetPromotionCleanupTask extends AssetPromotionCleanupBinding {
  cleanupId: string
  status: 'pending' | 'completed'
  attempts: number
  nextAttemptAt: string
  leaseToken?: string
  leaseUntil?: string
  lastError?: Record<string, unknown>
  completedAt?: string
  createdAt: string
  updatedAt: string
}

export interface AssetPromotionCleanupRepository {
  getByReceipt(workspaceId: string, receiptId: string): Promise<AssetPromotionCleanupTask | undefined>
  claimPending(workspaceId: string, options?: { limit?: number; leaseMs?: number; now?: string }): Promise<AssetPromotionCleanupTask[]>
  markCompleted(input: { workspaceId: string; cleanupId: string; leaseToken?: string; completedAt?: string }): Promise<AssetPromotionCleanupTask>
  recordFailure(input: { workspaceId: string; cleanupId: string; leaseToken?: string; error: Record<string, unknown>; nextAttemptAt: string }): Promise<AssetPromotionCleanupTask>
}

export class AssetPromotionCleanupConflictError extends Error {
  readonly code = 'ASSET_PROMOTION_CLEANUP_CONFLICT'
  constructor() { super('ASSET_PROMOTION_CLEANUP_CONFLICT'); this.name = 'AssetPromotionCleanupConflictError' }
}

const SHA256 = /^[a-f0-9]{64}$/u
function text(value: string, code: string, max = 512) {
  if (!value?.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code)
  return value
}
function validateBinding(input: AssetPromotionCleanupBinding): AssetPromotionCleanupBinding {
  const workspaceId = requireWorkspaceScope(input.workspaceId)
  text(input.receiptId, 'ASSET_PROMOTION_RECEIPT_REQUIRED', 256)
  text(input.assetId, 'ASSET_PROMOTION_ASSET_REQUIRED', 256)
  if (!Number.isSafeInteger(input.assetSourceRevision) || input.assetSourceRevision < 1) throw new Error('ASSET_PROMOTION_SOURCE_REVISION_INVALID')
  if (!input.quarantineKey.startsWith(`quarantine/${workspaceId}/`) || !input.cleanKey.startsWith(`clean/${workspaceId}/`)) throw new Error('ASSET_PROMOTION_KEY_SCOPE_INVALID')
  if (!input.scanEvidenceRef.startsWith(`scan-receipt://${input.receiptId}/`)) throw new Error('ASSET_PROMOTION_EVIDENCE_INVALID')
  if (!SHA256.test(input.objectSha256)) throw new Error('ASSET_PROMOTION_SHA256_INVALID')
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error('ASSET_PROMOTION_SIZE_INVALID')
  text(input.readyOutboxEventId, 'ASSET_PROMOTION_OUTBOX_REQUIRED', 256)
  return structuredClone({ ...input, workspaceId })
}
function same(left: AssetPromotionCleanupBinding, right: AssetPromotionCleanupBinding) {
  return left.workspaceId === right.workspaceId && left.receiptId === right.receiptId && left.assetId === right.assetId
    && left.assetSourceRevision === right.assetSourceRevision && left.quarantineKey === right.quarantineKey
    && left.cleanKey === right.cleanKey && left.scanEvidenceRef === right.scanEvidenceRef
    && left.objectSha256 === right.objectSha256 && left.sizeBytes === right.sizeBytes
    && left.readyOutboxEventId === right.readyOutboxEventId
}

type Row = {
  cleanup_id: string; workspace_id: string; receipt_id: string; asset_id: string; asset_source_revision: number
  quarantine_key: string; clean_key: string; scan_evidence_ref: string; object_sha256: string; size_bytes: string | number
  ready_outbox_event_id: string; status: 'pending' | 'completed'; attempts: number; next_attempt_at: string | Date
  lease_token: string | null; lease_until: string | Date | null; last_error: Record<string, unknown> | null
  completed_at: string | Date | null; created_at: string | Date; updated_at: string | Date
}
const projection = `cleanup_id,workspace_id,receipt_id,asset_id,asset_source_revision,quarantine_key,clean_key,scan_evidence_ref,object_sha256,size_bytes,ready_outbox_event_id,status,attempts,next_attempt_at,lease_token,lease_until,last_error,completed_at,created_at,updated_at`
const taskProjection = projection.split(',').map(column => `task.${column}`).join(',')
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const map = (row: Row): AssetPromotionCleanupTask => ({
  cleanupId: row.cleanup_id, workspaceId: row.workspace_id, receiptId: row.receipt_id, assetId: row.asset_id,
  assetSourceRevision: row.asset_source_revision, quarantineKey: row.quarantine_key, cleanKey: row.clean_key,
  scanEvidenceRef: row.scan_evidence_ref, objectSha256: row.object_sha256, sizeBytes: Number(row.size_bytes),
  readyOutboxEventId: row.ready_outbox_event_id, status: row.status, attempts: row.attempts,
  nextAttemptAt: iso(row.next_attempt_at), ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
  ...(row.lease_until ? { leaseUntil: iso(row.lease_until) } : {}), ...(row.last_error ? { lastError: row.last_error } : {}),
  ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
})

export class PostgresAssetPromotionCleanupRepository implements AssetPromotionCleanupRepository {
  constructor(private readonly pool: SqlPool) {}

  async createInTransaction(client: SqlClient, raw: AssetPromotionCleanupBinding): Promise<{ created: boolean; task: AssetPromotionCleanupTask }> {
    const input = validateBinding(raw)
    const cleanupId = `cleanup_${randomUUID()}`
    const inserted = await client.query<Row>(
      `INSERT INTO asset_promotion_cleanup_tasks
       (cleanup_id,workspace_id,receipt_id,asset_id,asset_source_revision,quarantine_key,clean_key,scan_evidence_ref,object_sha256,size_bytes,ready_outbox_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING RETURNING ${projection}`,
      [cleanupId,input.workspaceId,input.receiptId,input.assetId,input.assetSourceRevision,input.quarantineKey,input.cleanKey,input.scanEvidenceRef,input.objectSha256,input.sizeBytes,input.readyOutboxEventId],
    )
    if (inserted.rows[0]) return { created: true, task: map(inserted.rows[0]) }
    const existing = await client.query<Row>(
      `SELECT ${projection} FROM asset_promotion_cleanup_tasks
       WHERE workspace_id=$1 AND (receipt_id=$2 OR (asset_id=$3 AND asset_source_revision=$4)) LIMIT 2`,
      [input.workspaceId,input.receiptId,input.assetId,input.assetSourceRevision],
    )
    if (existing.rows.length !== 1) throw new AssetPromotionCleanupConflictError()
    const task = map(existing.rows[0]!)
    if (!same(task, input)) throw new AssetPromotionCleanupConflictError()
    return { created: false, task }
  }

  async getByReceipt(workspaceId: string, receiptId: string) {
    const scope = requireWorkspaceScope(workspaceId); text(receiptId, 'ASSET_PROMOTION_RECEIPT_REQUIRED', 256)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<Row>(`SELECT ${projection} FROM asset_promotion_cleanup_tasks WHERE workspace_id=$1 AND receipt_id=$2`, [scope,receiptId])
      return result.rows[0] ? map(result.rows[0]) : undefined
    })
  }

  async claimPending(workspaceId: string, options: { limit?: number; leaseMs?: number; now?: string } = {}) {
    const scope = requireWorkspaceScope(workspaceId)
    const limit = options.limit ?? 10; const leaseMs = options.leaseMs ?? 30_000; const now = options.now ?? new Date().toISOString()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000) throw new RangeError('invalid asset promotion cleanup claim options')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const leaseToken = randomUUID()
      const result = await client.query<Row>(
        `WITH candidates AS (
           SELECT cleanup_id FROM asset_promotion_cleanup_tasks
           WHERE workspace_id=$1 AND status='pending' AND next_attempt_at <= $2::timestamptz
             AND (lease_until IS NULL OR lease_until <= $2::timestamptz)
           ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT $3
         )
         UPDATE asset_promotion_cleanup_tasks task
         SET lease_token=$4,lease_until=$2::timestamptz+($5::text||' milliseconds')::interval
         FROM candidates WHERE task.cleanup_id=candidates.cleanup_id RETURNING ${taskProjection}`,
        [scope,now,limit,leaseToken,leaseMs],
      )
      return result.rows.map(map)
    })
  }

  async markCompleted(input: { workspaceId: string; cleanupId: string; leaseToken?: string; completedAt?: string }) {
    const scope = requireWorkspaceScope(input.workspaceId); text(input.cleanupId, 'ASSET_PROMOTION_CLEANUP_ID_REQUIRED', 256)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<Row>(
        `UPDATE asset_promotion_cleanup_tasks SET status='completed',completed_at=COALESCE(completed_at,$3::timestamptz),lease_token=NULL,lease_until=NULL,last_error=NULL
         WHERE workspace_id=$1 AND cleanup_id=$2 AND status IN ('pending','completed') AND ($4::text IS NULL OR lease_token=$4 OR status='completed') RETURNING ${projection}`,
        [scope,input.cleanupId,input.completedAt ?? new Date().toISOString(),input.leaseToken ?? null],
      )
      if (!result.rows[0]) throw new AssetPromotionCleanupConflictError()
      return map(result.rows[0])
    })
  }

  async recordFailure(input: { workspaceId: string; cleanupId: string; leaseToken?: string; error: Record<string, unknown>; nextAttemptAt: string }) {
    const scope = requireWorkspaceScope(input.workspaceId); text(input.cleanupId, 'ASSET_PROMOTION_CLEANUP_ID_REQUIRED', 256)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<Row>(
        `UPDATE asset_promotion_cleanup_tasks SET attempts=attempts+1,next_attempt_at=$3::timestamptz,last_error=$4::jsonb,lease_token=NULL,lease_until=NULL
         WHERE workspace_id=$1 AND cleanup_id=$2 AND status='pending' AND ($5::text IS NULL OR lease_token=$5) RETURNING ${projection}`,
        [scope,input.cleanupId,input.nextAttemptAt,JSON.stringify(input.error),input.leaseToken ?? null],
      )
      if (!result.rows[0]) throw new AssetPromotionCleanupConflictError()
      return map(result.rows[0])
    })
  }
}

export class MemoryAssetPromotionCleanupRepository implements AssetPromotionCleanupRepository {
  private readonly tasks = new Map<string, AssetPromotionCleanupTask>()
  create(raw: AssetPromotionCleanupBinding) {
    const input = validateBinding(raw)
    const existing = [...this.tasks.values()].find(task => task.workspaceId === input.workspaceId && (task.receiptId === input.receiptId || (task.assetId === input.assetId && task.assetSourceRevision === input.assetSourceRevision)))
    if (existing) { if (!same(existing,input)) throw new AssetPromotionCleanupConflictError(); return { created: false, task: structuredClone(existing) } }
    const now = new Date().toISOString(); const task: AssetPromotionCleanupTask = { ...input, cleanupId: `cleanup_${randomUUID()}`, status: 'pending', attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }
    this.tasks.set(task.cleanupId,task); return { created: true, task: structuredClone(task) }
  }
  async getByReceipt(workspaceId: string, receiptId: string) { const task = [...this.tasks.values()].find(row => row.workspaceId === workspaceId && row.receiptId === receiptId); return task ? structuredClone(task) : undefined }
  async claimPending(workspaceId: string, options: { limit?: number; leaseMs?: number; now?: string } = {}) { const now = options.now ?? new Date().toISOString(); const token=randomUUID(); return [...this.tasks.values()].filter(task => task.workspaceId===workspaceId&&task.status==='pending'&&task.nextAttemptAt<=now&&(!task.leaseUntil||task.leaseUntil<=now)).slice(0,options.limit??10).map(task => { task.leaseToken=token; task.leaseUntil=new Date(Date.parse(now)+(options.leaseMs??30_000)).toISOString(); task.updatedAt=now; return structuredClone(task) }) }
  async markCompleted(input: { workspaceId: string; cleanupId: string; leaseToken?: string; completedAt?: string }) { const task=this.tasks.get(input.cleanupId); if(!task||task.workspaceId!==input.workspaceId||(input.leaseToken&&task.leaseToken!==input.leaseToken&&task.status!=='completed')) throw new AssetPromotionCleanupConflictError(); task.status='completed'; task.completedAt??=input.completedAt??new Date().toISOString(); delete task.leaseToken; delete task.leaseUntil; delete task.lastError; task.updatedAt=new Date().toISOString(); return structuredClone(task) }
  async recordFailure(input: { workspaceId: string; cleanupId: string; leaseToken?: string; error: Record<string, unknown>; nextAttemptAt: string }) { const task=this.tasks.get(input.cleanupId); if(!task||task.workspaceId!==input.workspaceId||task.status!=='pending'||(input.leaseToken&&task.leaseToken!==input.leaseToken)) throw new AssetPromotionCleanupConflictError(); task.attempts+=1; task.nextAttemptAt=input.nextAttemptAt; task.lastError=structuredClone(input.error); delete task.leaseToken; delete task.leaseUntil; task.updatedAt=new Date().toISOString(); return structuredClone(task) }
}
