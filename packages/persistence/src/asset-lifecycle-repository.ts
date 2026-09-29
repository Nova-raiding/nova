import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, withWorkspaceTransaction, type SqlClient, type SqlPool } from './repository.js'

export interface MerchantAssetLifecycle {
  workspaceId: string
  assetId: string
  deletedAt?: string
  expiresAt?: string
  deletedBy?: string
  purgeRequestedAt?: string
  purgeRequestedBy?: string
  purgeRequestReason?: string
  restoredAt?: string
  restoredBy?: string
  purgedAt?: string
  purgeAttempts: number
  revision: number
  purgeError?: Record<string, unknown>
}

export interface MerchantAssetLifecycleEvent {
  eventId: string
  workspaceId: string
  assetId: string
  eventType: 'deleted' | 'restored' | 'early_purge_requested' | 'purge_request_cancelled' | 'purge_claimed' | 'purge_failed' | 'purged'
  actorId: string
  occurredAt: string
  details: Record<string, unknown>
}

export interface AssetLifecyclePage {
  items: MerchantAssetLifecycle[]
  total: number
  limit: number
  offset: number
}

type LifecycleRow = {
  workspace_id: string; asset_id: string; deleted_at: string | Date | null; expires_at: string | Date | null
  deleted_by: string | null; purge_requested_at: string | Date | null; purge_requested_by: string | null; purge_request_reason: string | null
  restored_at: string | Date | null; restored_by: string | null; purged_at: string | Date | null
  purge_lease_token: string | null; purge_lease_until: string | Date | null
  purge_attempts: number; purge_error: Record<string, unknown> | null; revision: number
}
type EventRow = {
  event_id: string; workspace_id: string; asset_id: string; event_type: MerchantAssetLifecycleEvent['eventType']
  actor_id: string; occurred_at: string | Date; details: Record<string, unknown>
}
const projection = 'workspace_id,asset_id,deleted_at,expires_at,deleted_by,purge_requested_at,purge_requested_by,purge_request_reason,restored_at,restored_by,purged_at,purge_attempts,purge_error,revision'
const lifecycleProjection = projection.split(',').map(column => `lifecycle.${column}`).join(',')
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const optionalIso = (value: string | Date | null) => value == null ? undefined : iso(value)
const mapLifecycle = (row: LifecycleRow): MerchantAssetLifecycle => ({
  workspaceId: row.workspace_id, assetId: row.asset_id,
  ...(optionalIso(row.deleted_at) ? { deletedAt: optionalIso(row.deleted_at) } : {}),
  ...(optionalIso(row.expires_at) ? { expiresAt: optionalIso(row.expires_at) } : {}),
  ...(row.deleted_by ? { deletedBy: row.deleted_by } : {}),
  ...(optionalIso(row.purge_requested_at) ? { purgeRequestedAt: optionalIso(row.purge_requested_at) } : {}),
  ...(row.purge_requested_by ? { purgeRequestedBy: row.purge_requested_by } : {}),
  ...(row.purge_request_reason ? { purgeRequestReason: row.purge_request_reason } : {}),
  ...(optionalIso(row.restored_at) ? { restoredAt: optionalIso(row.restored_at) } : {}),
  ...(row.restored_by ? { restoredBy: row.restored_by } : {}),
  ...(optionalIso(row.purged_at) ? { purgedAt: optionalIso(row.purged_at) } : {}),
  purgeAttempts: row.purge_attempts, revision: row.revision, ...(row.purge_error ? { purgeError: row.purge_error } : {}),
})
const mapEvent = (row: EventRow): MerchantAssetLifecycleEvent => ({
  eventId: row.event_id, workspaceId: row.workspace_id, assetId: row.asset_id, eventType: row.event_type,
  actorId: row.actor_id, occurredAt: iso(row.occurred_at), details: row.details,
})
function requiredText(value: string, code: string, max = 256) {
  if (!value?.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code)
  return value
}
function retentionWindow(now: string, retentionDays: number) {
  const date = new Date(now)
  if (!Number.isFinite(date.getTime())) throw new Error('ASSET_LIFECYCLE_TIME_INVALID')
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 30) throw new Error('ASSET_LIFECYCLE_RETENTION_INVALID')
  return new Date(date.getTime() + retentionDays * 86_400_000).toISOString()
}

/** Tenant scoped durable soft-delete state. Asset snapshots and their links stay untouched. */
export class PostgresAssetLifecycleRepository {
  constructor(private readonly pool: SqlPool) {}

  async trash(input: { workspaceId: string; assetId: string; actorId: string; expectedRevision?: number; now?: string }): Promise<MerchantAssetLifecycle> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const assetId = requiredText(input.assetId, 'ASSET_LIFECYCLE_ASSET_REQUIRED')
    const actorId = requiredText(input.actorId, 'ASSET_LIFECYCLE_ACTOR_REQUIRED')
    const now = input.now ?? new Date().toISOString()
    const expiresAt = retentionWindow(now, 7)
    if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) throw new Error('ASSET_LIFECYCLE_REVISION_INVALID')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      // A bind transaction holds FOR SHARE on this snapshot while checking
      // lifecycle state. Taking FOR UPDATE here serializes first-time trashing
      // against a concurrent bind even when no lifecycle row exists yet.
      await this.requireAssetSnapshot(client, workspaceId, assetId, 'UPDATE')
      const result = await client.query<LifecycleRow>(
        `INSERT INTO merchant_asset_lifecycle (workspace_id,asset_id,deleted_at,expires_at,deleted_by,purge_requested_at,purge_requested_by,purge_request_reason,restored_at,restored_by,purged_at,purge_lease_token,purge_lease_until,purge_attempts,purge_error,revision,updated_at)
         VALUES ($1,$2,$3::timestamptz,$4::timestamptz,$5,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,1,now())
         ON CONFLICT (workspace_id,asset_id) DO UPDATE SET deleted_at=EXCLUDED.deleted_at,expires_at=EXCLUDED.expires_at,deleted_by=EXCLUDED.deleted_by,purge_requested_at=NULL,purge_requested_by=NULL,purge_request_reason=NULL,restored_at=NULL,restored_by=NULL,purged_at=NULL,purge_lease_token=NULL,purge_lease_until=NULL,purge_error=NULL,revision=merchant_asset_lifecycle.revision+1,updated_at=now()
         WHERE merchant_asset_lifecycle.deleted_at IS NULL AND merchant_asset_lifecycle.purged_at IS NULL
           AND ($6::integer IS NULL OR merchant_asset_lifecycle.revision=$6)
         RETURNING ${projection}`,
        [workspaceId, assetId, now, expiresAt, actorId, input.expectedRevision ?? null],
      )
      if (!result.rows[0]) {
        const existing = await client.query<LifecycleRow>(`SELECT ${projection} FROM merchant_asset_lifecycle WHERE workspace_id=$1 AND asset_id=$2`, [workspaceId, assetId])
        if (!existing.rows[0]) throw new Error('ASSET_LIFECYCLE_CONFLICT')
        if (input.expectedRevision !== undefined && existing.rows[0].revision !== input.expectedRevision) throw new Error('ASSET_LIFECYCLE_REVISION_CONFLICT')
        if (existing.rows[0].purged_at) throw new Error('ASSET_LIFECYCLE_PURGED')
        return mapLifecycle(existing.rows[0])
      }
      await this.appendEvent(client, { workspaceId, assetId, eventType: 'deleted', actorId, occurredAt: now, details: { expires_at: expiresAt } })
      return mapLifecycle(result.rows[0])
    })
  }

  async requestEarlyPurge(input: { workspaceId: string; assetId: string; actorId: string; reason: string; expectedRevision: number; now?: string }): Promise<MerchantAssetLifecycle> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const assetId = requiredText(input.assetId, 'ASSET_LIFECYCLE_ASSET_REQUIRED')
    const actorId = requiredText(input.actorId, 'ASSET_LIFECYCLE_ACTOR_REQUIRED')
    const reason = requiredText(input.reason, 'ASSET_LIFECYCLE_PURGE_REASON_REQUIRED', 500).trim()
    const now = input.now ?? new Date().toISOString()
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('ASSET_LIFECYCLE_REVISION_INVALID')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<LifecycleRow>(
        `UPDATE merchant_asset_lifecycle SET purge_requested_at=$4::timestamptz,purge_requested_by=$5,purge_request_reason=$6,revision=revision+1,updated_at=now()
         WHERE workspace_id=$1 AND asset_id=$2 AND revision=$3 AND deleted_at IS NOT NULL AND purged_at IS NULL
           AND purge_requested_at IS NULL AND purge_lease_token IS NULL
         RETURNING ${projection}`,
        [workspaceId, assetId, input.expectedRevision, now, actorId, reason],
      )
      if (!result.rows[0]) {
        const existing = await client.query<LifecycleRow>(`SELECT ${projection} FROM merchant_asset_lifecycle WHERE workspace_id=$1 AND asset_id=$2`, [workspaceId, assetId])
        if (!existing.rows[0]) throw new Error('ASSET_LIFECYCLE_ASSET_NOT_FOUND')
        if (existing.rows[0].revision !== input.expectedRevision) throw new Error('ASSET_LIFECYCLE_REVISION_CONFLICT')
        if (existing.rows[0].purge_lease_token) throw new Error('ASSET_LIFECYCLE_PURGE_IN_PROGRESS')
        throw new Error('ASSET_LIFECYCLE_PURGE_REQUEST_UNAVAILABLE')
      }
      await this.appendEvent(client, { workspaceId, assetId, eventType: 'early_purge_requested', actorId, occurredAt: now, details: { reason } })
      return mapLifecycle(result.rows[0])
    })
  }

  async cancelEarlyPurge(input: { workspaceId: string; assetId: string; actorId: string; expectedRevision: number; now?: string }): Promise<MerchantAssetLifecycle> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const assetId = requiredText(input.assetId, 'ASSET_LIFECYCLE_ASSET_REQUIRED')
    const actorId = requiredText(input.actorId, 'ASSET_LIFECYCLE_ACTOR_REQUIRED')
    const now = input.now ?? new Date().toISOString()
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('ASSET_LIFECYCLE_REVISION_INVALID')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<LifecycleRow>(
        `UPDATE merchant_asset_lifecycle SET purge_requested_at=NULL,purge_requested_by=NULL,purge_request_reason=NULL,revision=revision+1,updated_at=now()
         WHERE workspace_id=$1 AND asset_id=$2 AND revision=$3 AND deleted_at IS NOT NULL AND purged_at IS NULL
           AND purge_requested_at IS NOT NULL AND purge_lease_token IS NULL
           AND expires_at>GREATEST($4::timestamptz,clock_timestamp())
         RETURNING ${projection}`,
        [workspaceId, assetId, input.expectedRevision, now],
      )
      if (!result.rows[0]) throw new Error('ASSET_LIFECYCLE_PURGE_CANCEL_UNAVAILABLE')
      await this.appendEvent(client, { workspaceId, assetId, eventType: 'purge_request_cancelled', actorId, occurredAt: now, details: {} })
      return mapLifecycle(result.rows[0])
    })
  }

  async restore(input: { workspaceId: string; assetId: string; actorId: string; expectedRevision?: number; now?: string }): Promise<MerchantAssetLifecycle> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const assetId = requiredText(input.assetId, 'ASSET_LIFECYCLE_ASSET_REQUIRED')
    const actorId = requiredText(input.actorId, 'ASSET_LIFECYCLE_ACTOR_REQUIRED')
    const now = input.now ?? new Date().toISOString()
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      await this.requireAssetSnapshot(client, workspaceId, assetId)
      const result = await client.query<LifecycleRow>(
        `UPDATE merchant_asset_lifecycle SET deleted_at=NULL,expires_at=NULL,restored_at=$3::timestamptz,restored_by=$4,purge_lease_token=NULL,purge_lease_until=NULL,revision=revision+1,updated_at=now()
         WHERE workspace_id=$1 AND asset_id=$2 AND deleted_at IS NOT NULL
           AND expires_at>GREATEST($3::timestamptz, clock_timestamp())
           AND purged_at IS NULL AND purge_lease_token IS NULL AND purge_requested_at IS NULL
           AND ($5::integer IS NULL OR revision=$5)
         RETURNING ${projection}`,
        [workspaceId, assetId, now, actorId, input.expectedRevision ?? null],
      )
      if (!result.rows[0]) throw new Error('ASSET_LIFECYCLE_RESTORE_UNAVAILABLE')
      await this.appendEvent(client, { workspaceId, assetId, eventType: 'restored', actorId, occurredAt: now, details: {} })
      return mapLifecycle(result.rows[0])
    })
  }

  async listTrash(workspaceId: string, options: { limit?: number; offset?: number; now?: string; assetIds?: readonly string[] } = {}): Promise<AssetLifecyclePage> {
    const scope = requireWorkspaceScope(workspaceId)
    const limit = options.limit ?? 50; const offset = options.offset ?? 0; const now = options.now ?? new Date().toISOString()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new RangeError('invalid asset lifecycle page')
    if (options.assetIds && options.assetIds.length > 500) throw new RangeError('asset id lookup limit exceeded')
    options.assetIds?.forEach(id => requiredText(id, 'ASSET_LIFECYCLE_ASSET_REQUIRED'))
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const idsFilter = options.assetIds === undefined ? '' : ' AND asset_id=ANY($3::text[])'
      const countValues = options.assetIds === undefined ? [scope, now] : [scope, now, options.assetIds]
      const count = await client.query<{ total: string | number }>(`SELECT count(*)::int AS total FROM merchant_asset_lifecycle WHERE workspace_id=$1 AND deleted_at IS NOT NULL AND (expires_at>$2::timestamptz OR purge_requested_at IS NOT NULL) AND purged_at IS NULL${idsFilter}`, countValues)
      const pageValues = options.assetIds === undefined ? [scope, now, limit, offset] : [scope, now, options.assetIds, limit, offset]
      const limitParameter = options.assetIds === undefined ? '$3' : '$4'
      const offsetParameter = options.assetIds === undefined ? '$4' : '$5'
      const rows = await client.query<LifecycleRow>(`SELECT ${projection} FROM merchant_asset_lifecycle WHERE workspace_id=$1 AND deleted_at IS NOT NULL AND (expires_at>$2::timestamptz OR purge_requested_at IS NOT NULL) AND purged_at IS NULL${idsFilter} ORDER BY deleted_at DESC,asset_id LIMIT ${limitParameter} OFFSET ${offsetParameter}`, pageValues)
      return { items: rows.rows.map(mapLifecycle), total: Number(count.rows[0]?.total ?? 0), limit, offset }
    })
  }

  async listExpired(workspaceId: string, input: { limit?: number; now?: string } = {}): Promise<MerchantAssetLifecycle[]> {
    const scope = requireWorkspaceScope(workspaceId); const limit = input.limit ?? 25; const now = input.now ?? new Date().toISOString()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('invalid asset lifecycle expiry limit')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const rows = await client.query<LifecycleRow>(`SELECT ${projection} FROM merchant_asset_lifecycle WHERE workspace_id=$1 AND deleted_at IS NOT NULL AND expires_at<=$2::timestamptz AND purged_at IS NULL ORDER BY expires_at,asset_id LIMIT $3`, [scope, now, limit])
      return rows.rows.map(mapLifecycle)
    })
  }

  /** Atomically leases expired rows so multiple cleanup workers cannot claim the same object. */
  async claimExpired(input: { workspaceId: string; workerId: string; limit?: number; leaseMs?: number; now?: string }): Promise<Array<MerchantAssetLifecycle & { leaseToken: string; leaseUntil: string }>> {
    const scope = requireWorkspaceScope(input.workspaceId); const workerId = requiredText(input.workerId, 'ASSET_LIFECYCLE_ACTOR_REQUIRED')
    const limit = input.limit ?? 25; const leaseMs = input.leaseMs ?? 30_000; const now = input.now ?? new Date().toISOString()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) throw new RangeError('invalid asset lifecycle claim options')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const token = randomUUID()
      const result = await client.query<LifecycleRow & { purge_lease_token: string; purge_lease_until: string | Date }>(
        `WITH candidates AS (
           SELECT workspace_id,asset_id FROM merchant_asset_lifecycle
           WHERE workspace_id=$1 AND deleted_at IS NOT NULL AND (expires_at<=$2::timestamptz OR purge_requested_at IS NOT NULL) AND purged_at IS NULL
             AND (purge_lease_until IS NULL OR purge_lease_until<=$2::timestamptz)
           ORDER BY expires_at,asset_id FOR UPDATE SKIP LOCKED LIMIT $3
         )
         UPDATE merchant_asset_lifecycle lifecycle SET purge_lease_token=$4,purge_lease_until=$2::timestamptz+($5::text||' milliseconds')::interval,updated_at=now()
         FROM candidates WHERE lifecycle.workspace_id=candidates.workspace_id AND lifecycle.asset_id=candidates.asset_id
         RETURNING ${lifecycleProjection},lifecycle.purge_lease_token,lifecycle.purge_lease_until`, [scope, now, limit, token, leaseMs],
      )
      const claimed = result.rows.map(row => ({ ...mapLifecycle(row), leaseToken: row.purge_lease_token, leaseUntil: iso(row.purge_lease_until) }))
      for (const row of claimed) await this.appendEvent(client, { workspaceId: scope, assetId: row.assetId, eventType: 'purge_claimed', actorId: workerId, occurredAt: now, details: { lease_until: row.leaseUntil } })
      return claimed
    })
  }

  /** Call only after object storage confirms deletion or authoritative absence. */
  async completePurge(input: { workspaceId: string; assetId: string; workerId: string; leaseToken: string; now?: string }, transactionClient?: SqlClient): Promise<MerchantAssetLifecycle> {
    const scope = requireWorkspaceScope(input.workspaceId); const assetId = requiredText(input.assetId, 'ASSET_LIFECYCLE_ASSET_REQUIRED'); const workerId = requiredText(input.workerId, 'ASSET_LIFECYCLE_ACTOR_REQUIRED'); const now = input.now ?? new Date().toISOString(); const token = requiredText(input.leaseToken, 'ASSET_LIFECYCLE_LEASE_REQUIRED')
    const complete = async (client: SqlClient) => {
      const result = await client.query<LifecycleRow>(`UPDATE merchant_asset_lifecycle SET purged_at=$4::timestamptz,purge_lease_token=NULL,purge_lease_until=NULL,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND asset_id=$2 AND (expires_at<=$4::timestamptz OR purge_requested_at IS NOT NULL) AND purged_at IS NULL AND purge_lease_token=$3 AND purge_lease_until>GREATEST($4::timestamptz,clock_timestamp()) RETURNING ${projection}`, [scope, assetId, token, now])
      if (!result.rows[0]) throw new Error('ASSET_LIFECYCLE_PURGE_LEASE_CONFLICT')
      await this.appendEvent(client, { workspaceId: scope, assetId, eventType: 'purged', actorId: workerId, occurredAt: now, details: {} })
      return mapLifecycle(result.rows[0])
    }
    return transactionClient ? complete(transactionClient) : withWorkspaceTransaction(this.pool, scope, complete)
  }

  async failPurge(input: { workspaceId: string; assetId: string; workerId: string; leaseToken: string; error: Record<string, unknown>; now?: string }, transactionClient?: SqlClient): Promise<MerchantAssetLifecycle> {
    const scope = requireWorkspaceScope(input.workspaceId); const assetId = requiredText(input.assetId, 'ASSET_LIFECYCLE_ASSET_REQUIRED'); const workerId = requiredText(input.workerId, 'ASSET_LIFECYCLE_ACTOR_REQUIRED'); const now = input.now ?? new Date().toISOString(); const token = requiredText(input.leaseToken, 'ASSET_LIFECYCLE_LEASE_REQUIRED')
    const fail = async (client: SqlClient) => {
      const result = await client.query<LifecycleRow>(`UPDATE merchant_asset_lifecycle SET purge_attempts=purge_attempts+1,purge_error=$4::jsonb,purge_lease_token=NULL,purge_lease_until=NULL,updated_at=now() WHERE workspace_id=$1 AND asset_id=$2 AND purged_at IS NULL AND purge_lease_token=$3 AND purge_lease_until>GREATEST($5::timestamptz,clock_timestamp()) RETURNING ${projection}`, [scope, assetId, token, JSON.stringify(input.error), now])
      if (!result.rows[0]) throw new Error('ASSET_LIFECYCLE_PURGE_LEASE_CONFLICT')
      await this.appendEvent(client, { workspaceId: scope, assetId, eventType: 'purge_failed', actorId: workerId, occurredAt: now, details: input.error })
      return mapLifecycle(result.rows[0])
    }
    return transactionClient ? fail(transactionClient) : withWorkspaceTransaction(this.pool, scope, fail)
  }

  async listEvents(workspaceId: string, assetId: string): Promise<MerchantAssetLifecycleEvent[]> {
    const scope = requireWorkspaceScope(workspaceId); requiredText(assetId, 'ASSET_LIFECYCLE_ASSET_REQUIRED')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const rows = await client.query<EventRow>(`SELECT event_id,workspace_id,asset_id,event_type,actor_id,occurred_at,details FROM merchant_asset_lifecycle_events WHERE workspace_id=$1 AND asset_id=$2 ORDER BY occurred_at,event_id`, [scope, assetId])
      return rows.rows.map(mapEvent)
    })
  }

  async isActive(workspaceId: string, assetId: string): Promise<boolean> {
    const scope = requireWorkspaceScope(workspaceId); requiredText(assetId, 'ASSET_LIFECYCLE_ASSET_REQUIRED')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<{ active: boolean }>(`SELECT NOT EXISTS (SELECT 1 FROM merchant_asset_lifecycle WHERE workspace_id=$1 AND asset_id=$2 AND deleted_at IS NOT NULL) AS active`, [scope, assetId])
      return result.rows[0]?.active ?? true
    })
  }

  /**
   * Holds the purge lease row lock across reference validation and object-store
   * deletion. Binding/import admission takes FOR SHARE on the same lifecycle
   * row, so it cannot create a new reference after the purge check succeeds.
   */
  async withPurgeLease<T>(input: { workspaceId: string; assetId: string; leaseToken: string }, work: (client: SqlClient) => Promise<T>): Promise<T> {
    const scope = requireWorkspaceScope(input.workspaceId)
    const assetId = requiredText(input.assetId, 'ASSET_LIFECYCLE_ASSET_REQUIRED')
    const leaseToken = requiredText(input.leaseToken, 'ASSET_LIFECYCLE_LEASE_REQUIRED')
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<{ active: boolean }>(
        `SELECT (purged_at IS NULL AND purge_lease_token=$3 AND purge_lease_until>clock_timestamp()) AS active
           FROM merchant_asset_lifecycle
          WHERE workspace_id=$1 AND asset_id=$2
          FOR UPDATE`,
        [scope, assetId, leaseToken],
      )
      if (!result.rows[0]?.active) throw new Error('ASSET_LIFECYCLE_PURGE_LEASE_CONFLICT')
      return work(client)
    })
  }

  isTrashed(workspaceId: string, assetId: string) { return this.isActive(workspaceId, assetId).then(active => !active) }

  async listTrashedAssetIds(workspaceId: string, assetIds: readonly string[], now = new Date().toISOString()): Promise<ReadonlySet<string>> {
    const scope = requireWorkspaceScope(workspaceId)
    if (!assetIds.length) return new Set()
    if (assetIds.length > 500) throw new RangeError('asset id lookup limit exceeded')
    assetIds.forEach(id => requiredText(id, 'ASSET_LIFECYCLE_ASSET_REQUIRED'))
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<{ asset_id: string }>(`SELECT asset_id FROM merchant_asset_lifecycle WHERE workspace_id=$1 AND asset_id=ANY($2::text[]) AND deleted_at IS NOT NULL`, [scope, assetIds])
      return new Set(result.rows.map(row => row.asset_id))
    })
  }

  private async requireAssetSnapshot(client: SqlClient, workspaceId: string, assetId: string, lock: 'KEY SHARE' | 'UPDATE' = 'KEY SHARE') {
    const result = await client.query<{ entity_id: string }>(`SELECT entity_id FROM business_entity_snapshots WHERE workspace_id=$1 AND entity_type='asset' AND entity_id=$2 FOR ${lock}`, [workspaceId, assetId])
    if (!result.rows[0]) throw new Error('ASSET_LIFECYCLE_ASSET_NOT_FOUND')
  }

  private async appendEvent(client: SqlClient, input: Omit<MerchantAssetLifecycleEvent, 'eventId'>) {
    await client.query(`INSERT INTO merchant_asset_lifecycle_events (event_id,workspace_id,asset_id,event_type,actor_id,occurred_at,details) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::jsonb)`, [randomUUID(), input.workspaceId, input.assetId, input.eventType, input.actorId, input.occurredAt, JSON.stringify(input.details)])
  }
}
