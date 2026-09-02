import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export interface ObjectStorageOrphan {
  id: string; workspaceId: string; objectKey: string; reason: string
  state: 'pending' | 'cleaned' | 'manual_attention'; attempts: number
  lastError?: string; nextAttemptAt: string; createdAt: string; updatedAt: string
  leaseToken?: string; leaseUntil?: string
}
export interface ObjectOrphanClaimOptions { limit?: number; leaseMs?: number; now?: string }
export interface ObjectOrphanRepository {
  enqueue(input: { workspaceId: string; objectKey: string; reason: string; lastError?: string }): Promise<ObjectStorageOrphan>
  listPending(workspaceId: string, limit?: number): Promise<ObjectStorageOrphan[]>
  claimPending(workspaceId: string, options?: ObjectOrphanClaimOptions): Promise<ObjectStorageOrphan[]>
  markCleaned(input: { workspaceId: string; id: string; leaseToken?: string }): Promise<void>
  markRetry(input: { workspaceId: string; id: string; error: string; nextAttemptAt: string; manualAttention?: boolean; leaseToken?: string }): Promise<void>
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const DEFAULT_LEASE_MS = 60_000
function optionsOf(options: ObjectOrphanClaimOptions = {}) {
  const limit = options.limit ?? DEFAULT_LIMIT; const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS; const now = options.now ?? new Date().toISOString()
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error('invalid orphan claim limit')
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) throw new Error('invalid orphan lease duration')
  if (!Number.isFinite(Date.parse(now))) throw new Error('invalid orphan claim time')
  return { limit, leaseMs, now }
}
function findRow(rows: Map<string, ObjectStorageOrphan>, workspaceId: string, id: string) { return [...rows.values()].find(row => row.workspaceId === workspaceId && row.id === id) }
function assertLease(row: ObjectStorageOrphan | undefined, token?: string) {
  if (!row || (row.leaseToken && (row.leaseToken !== token || !row.leaseUntil || Date.parse(row.leaseUntil) <= Date.now()))) throw new Error('ORPHAN_LEASE_LOST')
}

export class MemoryObjectOrphanRepository implements ObjectOrphanRepository {
  private readonly rows = new Map<string, ObjectStorageOrphan>()
  async enqueue(input: { workspaceId: string; objectKey: string; reason: string; lastError?: string }) {
    const key = `${input.workspaceId}:${input.objectKey}`; const current = this.rows.get(key); const timestamp = new Date().toISOString()
    const row: ObjectStorageOrphan = current ? { ...current, reason: input.reason, ...(input.lastError ? { lastError: input.lastError } : {}), attempts: current.attempts + 1, state: 'pending', leaseToken: undefined, leaseUntil: undefined, updatedAt: timestamp } : { id: `orphan_${randomUUID()}`, ...input, state: 'pending', attempts: 1, nextAttemptAt: timestamp, createdAt: timestamp, updatedAt: timestamp }
    this.rows.set(key, row); return { ...row }
  }
  async listPending(workspaceId: string, limit = DEFAULT_LIMIT) { const { limit: safeLimit } = optionsOf({ limit }); const now = Date.now(); return [...this.rows.values()].filter(row => row.workspaceId === workspaceId && row.state === 'pending' && Date.parse(row.nextAttemptAt) <= now && (!row.leaseUntil || Date.parse(row.leaseUntil) <= now)).slice(0, safeLimit).map(row => ({ ...row })) }
  async claimPending(workspaceId: string, options: ObjectOrphanClaimOptions = {}) {
    const { limit, leaseMs, now } = optionsOf(options); const nowMs = Date.parse(now); const leaseUntil = new Date(nowMs + leaseMs).toISOString(); const claimed: ObjectStorageOrphan[] = []
    for (const row of this.rows.values()) { if (claimed.length >= limit) break; if (row.workspaceId !== workspaceId || row.state !== 'pending' || Date.parse(row.nextAttemptAt) > nowMs || (row.leaseUntil && Date.parse(row.leaseUntil) > nowMs)) continue; row.leaseToken = `orphan_lease_${randomUUID()}`; row.leaseUntil = leaseUntil; row.updatedAt = now; claimed.push({ ...row }) }
    return claimed
  }
  async markCleaned(input: { workspaceId: string; id: string; leaseToken?: string }) { const row = findRow(this.rows, input.workspaceId, input.id); assertLease(row, input.leaseToken); if (row?.state === 'pending') { row.state = 'cleaned'; row.leaseToken = undefined; row.leaseUntil = undefined; row.updatedAt = new Date().toISOString() } }
  async markRetry(input: { workspaceId: string; id: string; error: string; nextAttemptAt: string; manualAttention?: boolean; leaseToken?: string }) { const row = findRow(this.rows, input.workspaceId, input.id); assertLease(row, input.leaseToken); if (row) { row.attempts += 1; row.lastError = input.error; row.nextAttemptAt = input.nextAttemptAt; row.state = input.manualAttention ? 'manual_attention' : 'pending'; row.leaseToken = undefined; row.leaseUntil = undefined; row.updatedAt = new Date().toISOString() } }
}

const projection = `id, workspace_id AS "workspaceId", object_key AS "objectKey", reason, state, attempts, last_error AS "lastError", next_attempt_at AS "nextAttemptAt", created_at AS "createdAt", updated_at AS "updatedAt", lease_token AS "leaseToken", lease_until AS "leaseUntil"`
export class PostgresObjectOrphanRepository implements ObjectOrphanRepository {
  constructor(private readonly pool: SqlPool) {}
  async enqueue(input: { workspaceId: string; objectKey: string; reason: string; lastError?: string }) { requireWorkspaceScope(input.workspaceId); return withWorkspaceTransaction(this.pool, input.workspaceId, async client => { const result = await client.query<ObjectStorageOrphan>(`INSERT INTO object_storage_orphans (id, workspace_id, object_key, reason, attempts, last_error) VALUES ($1,$2,$3,$4,1,$5) ON CONFLICT (workspace_id, object_key) DO UPDATE SET reason=EXCLUDED.reason, attempts=object_storage_orphans.attempts+1, last_error=EXCLUDED.last_error, state='pending', lease_token=NULL, lease_until=NULL, updated_at=now() RETURNING ${projection}`, [randomUUID(), input.workspaceId, input.objectKey, input.reason, input.lastError ?? null]); return result.rows[0]! }) }
  async listPending(workspaceId: string, limit = DEFAULT_LIMIT) { requireWorkspaceScope(workspaceId); const { limit: safeLimit } = optionsOf({ limit }); return withWorkspaceTransaction(this.pool, workspaceId, async client => (await client.query<ObjectStorageOrphan>(`SELECT ${projection} FROM object_storage_orphans WHERE workspace_id=$1 AND state='pending' AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY created_at LIMIT $2`, [workspaceId, safeLimit])).rows) }
  async claimPending(workspaceId: string, options: ObjectOrphanClaimOptions = {}) { requireWorkspaceScope(workspaceId); const { limit, leaseMs, now } = optionsOf(options); const token = `orphan_lease_${randomUUID()}`; return withWorkspaceTransaction(this.pool, workspaceId, async client => (await client.query<ObjectStorageOrphan>(`WITH candidates AS (SELECT id FROM object_storage_orphans WHERE workspace_id=$1 AND state='pending' AND next_attempt_at<=$2::timestamptz AND (lease_until IS NULL OR lease_until<=$2::timestamptz) ORDER BY next_attempt_at, created_at FOR UPDATE SKIP LOCKED LIMIT $3) UPDATE object_storage_orphans AS orphan SET lease_token=$4, lease_until=$2::timestamptz + ($5::text || ' milliseconds')::interval, updated_at=$2::timestamptz FROM candidates WHERE orphan.workspace_id=$1 AND orphan.id=candidates.id RETURNING ${projection}`, [workspaceId, now, limit, token, leaseMs])).rows) }
  async markCleaned(input: { workspaceId: string; id: string; leaseToken?: string }) { requireWorkspaceScope(input.workspaceId); await withWorkspaceTransaction(this.pool, input.workspaceId, async client => { const result = await client.query(`UPDATE object_storage_orphans SET state='cleaned', lease_token=NULL, lease_until=NULL, updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='pending' AND (($3::text IS NULL AND lease_token IS NULL) OR (lease_token=$3 AND lease_until>now()))`, [input.workspaceId, input.id, input.leaseToken ?? null]); if (result.rowCount !== 1) throw new Error('ORPHAN_LEASE_LOST') }) }
  async markRetry(input: { workspaceId: string; id: string; error: string; nextAttemptAt: string; manualAttention?: boolean; leaseToken?: string }) { requireWorkspaceScope(input.workspaceId); await withWorkspaceTransaction(this.pool, input.workspaceId, async client => { const result = await client.query(`UPDATE object_storage_orphans SET state=$3, attempts=attempts+1, last_error=$4, next_attempt_at=$5, lease_token=NULL, lease_until=NULL, updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='pending' AND (($6::text IS NULL AND lease_token IS NULL) OR (lease_token=$6 AND lease_until>now()))`, [input.workspaceId, input.id, input.manualAttention ? 'manual_attention' : 'pending', input.error, input.nextAttemptAt, input.leaseToken ?? null]); if (result.rowCount !== 1) throw new Error('ORPHAN_LEASE_LOST') }) }
}
