import { deletionMatchesReservation, parseReservationKey } from '../../storage/src/reservation-key.js'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type StorageQuotaReservationStatus = 'active' | 'settled' | 'released' | 'over_limit'

export interface StorageQuotaReservation {
  workspaceId: string
  reservationKey: string
  assetId: string
  reservedBytes: number
  actualBytes?: number
  status: StorageQuotaReservationStatus
  revision: number
  createdAt: string
  updatedAt: string
}

export interface StorageQuotaSnapshot {
  usedBytes: number
  reservedBytes: number
  requestBytes: number
  limitBytes: number
}

export interface StoragePhysicalDeletionReceipt {
  objectKey: string
  deletedAt: string
  verification: 'delete_ack' | 'head_absent'
}

export class StorageQuotaExceededError extends Error {
  readonly code = 'STORAGE_QUOTA_EXCEEDED'
  constructor(readonly details: StorageQuotaSnapshot) {
    super('workspace storage quota would be exceeded')
    this.name = 'StorageQuotaExceededError'
  }
}

export class StorageQuotaActualExceededError extends Error {
  readonly code = 'STORAGE_QUOTA_ACTUAL_EXCEEDED'
  readonly providerSucceeded = true
  constructor(readonly details: StorageQuotaSnapshot) {
    super('actual object bytes exceeded the workspace storage quota')
    this.name = 'StorageQuotaActualExceededError'
  }
}

export interface StorageQuotaRepository {
  getSnapshot(workspaceId: string): Promise<{ limitBytes: number; usedBytes: number; reservedBytes: number } | undefined>
  reserve(input: { workspaceId: string; reservationKey: string; assetId: string; bytes: number; limitBytes: number; at?: string }): Promise<{ reservation: StorageQuotaReservation; snapshot: StorageQuotaSnapshot; reused: boolean }>
  settle(input: { workspaceId: string; reservationKey: string; actualBytes: number; at?: string }): Promise<{ reservation: StorageQuotaReservation; snapshot: StorageQuotaSnapshot }>
  release(input: { workspaceId: string; reservationKey: string; at?: string }): Promise<StorageQuotaReservation | undefined>
  releaseAfterPhysicalDeletion(input: { workspaceId: string; reservationKey: string; receipt: StoragePhysicalDeletionReceipt; at?: string }): Promise<StorageQuotaReservation | undefined>
}

function validBytes(value: number, allowZero = false) {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0)
}

function validateReserve(input: Parameters<StorageQuotaRepository['reserve']>[0]) {
  const workspaceId = requireWorkspaceScope(input.workspaceId)
  if (!input.reservationKey.trim() || !input.assetId.trim() || !validBytes(input.bytes, true) || !validBytes(input.limitBytes, true)) throw new Error('STORAGE_QUOTA_INPUT_INVALID')
  return workspaceId
}

function validateSettlement(input: Parameters<StorageQuotaRepository['settle']>[0]) {
  const workspaceId = requireWorkspaceScope(input.workspaceId)
  if (!input.reservationKey.trim() || !validBytes(input.actualBytes, true)) throw new Error('STORAGE_QUOTA_SETTLEMENT_INVALID')
  return workspaceId
}

function validatePhysicalDeletion(input: Parameters<StorageQuotaRepository['releaseAfterPhysicalDeletion']>[0]) {
  const workspaceId = requireWorkspaceScope(input.workspaceId)
  const receipt = input.receipt
  if (!input.reservationKey.trim() || !receipt || !isSafePhysicalObjectKey(receipt.objectKey, workspaceId) || !['delete_ack', 'head_absent'].includes(receipt.verification) || !Number.isFinite(Date.parse(receipt.deletedAt))) throw new Error('STORAGE_QUOTA_DELETION_RECEIPT_INVALID')
  return workspaceId
}

/**
 * A settled row may only be released by the deletion of the object it describes.
 *
 * The ledger key is derived from the object key, so the two must agree: a caller
 * that hands over a reservation key belonging to object A together with a
 * deletion receipt for object B is describing two different objects, and
 * honouring it would credit bytes that are still stored. Keys this build cannot
 * parse (a legacy bare row) carry no object claim, and the caller is the one
 * that established which asset's object was deleted.
 */
function assertDeletionIdentity(input: { workspaceId: string; reservationKey: string; receipt: StoragePhysicalDeletionReceipt }) {
  if (!deletionMatchesReservation({ workspaceId: input.workspaceId, reservationKey: input.reservationKey, objectKey: input.receipt.objectKey })) {
    throw new Error('STORAGE_QUOTA_DELETION_IDENTITY_MISMATCH')
  }
}

function isSafePhysicalObjectKey(objectKey: unknown, workspaceId: string): objectKey is string {
  if (typeof objectKey !== 'string' || !objectKey.trim() || objectKey.startsWith('/') || objectKey.includes('\\') || /[\u0000-\u001f\u007f\r\n]/u.test(objectKey)) return false
  const parts = objectKey.split('/')
  return parts.length >= 3
    && (parts[0] === 'quarantine' || parts[0] === 'clean')
    && parts[1] === workspaceId
    && parts.every(part => part.length > 0 && part !== '.' && part !== '..')
}

const now = () => new Date().toISOString()

export class MemoryStorageQuotaRepository implements StorageQuotaRepository {
  private readonly reservations = new Map<string, StorageQuotaReservation>()
  private readonly totals = new Map<string, { limitBytes: number; usedBytes: number; reservedBytes: number }>()

  async getSnapshot(workspaceId: string) {
    const scope = requireWorkspaceScope(workspaceId)
    const total = this.totals.get(scope)
    return total ? { ...total } : undefined
  }

  async reserve(input: Parameters<StorageQuotaRepository['reserve']>[0]) {
    const workspaceId = validateReserve(input)
    const key = `${workspaceId}:${input.reservationKey}`
    const total = this.totals.get(workspaceId) ?? { limitBytes: input.limitBytes, usedBytes: 0, reservedBytes: 0 }
    if (total.limitBytes !== input.limitBytes) throw new Error('STORAGE_QUOTA_LIMIT_CONFLICT')
    const existing = this.reservations.get(key)
    if (existing && existing.assetId !== input.assetId) throw new Error('STORAGE_QUOTA_IDEMPOTENCY_CONFLICT')
    if (existing && existing.status !== 'released') return { reservation: structuredClone(existing), snapshot: { usedBytes: total.usedBytes, reservedBytes: total.reservedBytes, requestBytes: input.bytes, limitBytes: total.limitBytes }, reused: true }
    const available = total.usedBytes + total.reservedBytes + input.bytes
    const snapshot = { usedBytes: total.usedBytes, reservedBytes: total.reservedBytes, requestBytes: input.bytes, limitBytes: total.limitBytes }
    if (available > total.limitBytes) throw new StorageQuotaExceededError(snapshot)
    const at = input.at ?? now()
    const reservation: StorageQuotaReservation = existing
      ? { ...existing, reservedBytes: input.bytes, actualBytes: undefined, status: 'active', revision: existing.revision + 1, updatedAt: at }
      : { workspaceId, reservationKey: input.reservationKey, assetId: input.assetId, reservedBytes: input.bytes, status: 'active', revision: 1, createdAt: at, updatedAt: at }
    total.reservedBytes += input.bytes
    this.totals.set(workspaceId, total)
    this.reservations.set(key, reservation)
    return { reservation: structuredClone(reservation), snapshot, reused: false }
  }

  async settle(input: Parameters<StorageQuotaRepository['settle']>[0]) {
    const workspaceId = validateSettlement(input)
    const key = `${workspaceId}:${input.reservationKey}`
    const reservation = this.reservations.get(key)
    if (!reservation) throw new Error('STORAGE_QUOTA_RESERVATION_NOT_FOUND')
    const total = this.totals.get(workspaceId)!
    if (reservation.status === 'released') throw new Error('STORAGE_QUOTA_RESERVATION_RELEASED')
    if (reservation.status === 'settled' || reservation.status === 'over_limit') {
      if (reservation.actualBytes === input.actualBytes) return { reservation: structuredClone(reservation), snapshot: { usedBytes: total.usedBytes, reservedBytes: total.reservedBytes, requestBytes: input.actualBytes, limitBytes: total.limitBytes } }
      throw new Error('STORAGE_QUOTA_SETTLEMENT_CONFLICT')
    }
    const snapshot = { usedBytes: total.usedBytes, reservedBytes: Math.max(0, total.reservedBytes - reservation.reservedBytes), requestBytes: input.actualBytes, limitBytes: total.limitBytes }
    total.reservedBytes -= reservation.reservedBytes
    total.usedBytes += input.actualBytes
    reservation.actualBytes = input.actualBytes
    reservation.reservedBytes = 0
    reservation.status = total.usedBytes > total.limitBytes ? 'over_limit' : 'settled'
    reservation.revision += 1
    reservation.updatedAt = input.at ?? now()
    if (reservation.status === 'over_limit') {
      this.totals.set(workspaceId, total)
      throw new StorageQuotaActualExceededError({ ...snapshot, usedBytes: total.usedBytes })
    }
    this.totals.set(workspaceId, total)
    return { reservation: structuredClone(reservation), snapshot: { ...snapshot, usedBytes: total.usedBytes } }
  }

  async release(input: Parameters<StorageQuotaRepository['release']>[0]) {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    if (!input.reservationKey.trim()) throw new Error('STORAGE_QUOTA_RESERVATION_REQUIRED')
    const key = `${workspaceId}:${input.reservationKey}`
    const reservation = this.reservations.get(key)
    if (!reservation) return undefined
    if (reservation.status === 'released') return structuredClone(reservation)
    if (reservation.status !== 'active') throw new Error('STORAGE_QUOTA_SETTLED_RELEASE_REQUIRES_PHYSICAL_DELETION')
    const total = this.totals.get(workspaceId)!
    total.reservedBytes -= reservation.reservedBytes
    reservation.reservedBytes = 0
    reservation.actualBytes = undefined
    reservation.status = 'released'
    reservation.revision += 1
    reservation.updatedAt = input.at ?? now()
    this.totals.set(workspaceId, total)
    return structuredClone(reservation)
  }

  async releaseAfterPhysicalDeletion(input: Parameters<StorageQuotaRepository['releaseAfterPhysicalDeletion']>[0]) {
    const workspaceId = validatePhysicalDeletion(input)
    assertDeletionIdentity({ workspaceId, reservationKey: input.reservationKey, receipt: input.receipt })
    const key = `${workspaceId}:${input.reservationKey}`
    const reservation = this.reservations.get(key)
    if (!reservation) return undefined
    if (reservation.status === 'released') return structuredClone(reservation)
    const total = this.totals.get(workspaceId)!
    if (reservation.status === 'active') total.reservedBytes -= reservation.reservedBytes
    else if (reservation.status === 'settled' || reservation.status === 'over_limit') total.usedBytes -= reservation.actualBytes ?? 0
    reservation.reservedBytes = 0
    reservation.actualBytes = undefined
    reservation.status = 'released'
    reservation.revision += 1
    reservation.updatedAt = input.at ?? input.receipt.deletedAt
    this.totals.set(workspaceId, total)
    return structuredClone(reservation)
  }
}

type QuotaRow = { workspace_id: string; reservation_key: string; asset_id: string; reserved_bytes: number | string; actual_bytes: number | string | null; status: StorageQuotaReservationStatus; revision: number; created_at: string | Date; updated_at: string | Date }
type TotalRow = { limit_bytes: number | string; used_bytes: number | string; reserved_bytes: number | string }
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const map = (row: QuotaRow): StorageQuotaReservation => ({ workspaceId: row.workspace_id, reservationKey: row.reservation_key, assetId: row.asset_id, reservedBytes: Number(row.reserved_bytes), ...(row.actual_bytes !== null ? { actualBytes: Number(row.actual_bytes) } : {}), status: row.status, revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const projection = 'workspace_id,reservation_key,asset_id,reserved_bytes,actual_bytes,status,revision,created_at,updated_at'

/**
 * The legacy key a per-object reservation key may fall back to.
 *
 * A reservation key is bound to one physical object
 * (`asset:<assetId>/<canonical file name>`, see `reservationKeyFor` in
 * packages/storage/src/reservation-key.ts), and `reservation_key` is half of
 * the table's primary key. Rows written before that shape existed carry
 * `asset:<assetId>` instead: migration 231 rewrites the ones whose object it can
 * name, and migration 232 names more of the rest, but a row whose asset has no
 * durable object record left keeps the old key. Without a fallback such a row is
 * unreachable forever and `used_bytes` never falls - the workspace then reports
 * STORAGE_QUOTA_EXCEEDED while holding far less than its limit.
 *
 * The fallback is the *bare* key only, and the caller has to prove the row
 * belongs to the asset that owns the deleted object (`asset_id=$3`). It must
 * never be a prefix match: `LIKE 'asset:<assetId>/%'` also matches the
 * reservations of the asset's *other* objects, so deleting one object released
 * a sibling's row while that sibling was still stored and the ledger silently
 * under-counted. A row that only a prefix can reach is not reclaimable by a
 * deletion, and the migration that can name it is where that is repaired.
 */
function legacyReservationKeyCandidate(reservationKey: string): { key: string; assetId: string } | undefined {
  const identity = parseReservationKey(reservationKey)
  if (!identity) return undefined
  return { key: `asset:${identity.assetId}`, assetId: identity.assetId }
}

export class PostgresStorageQuotaRepository implements StorageQuotaRepository {
  constructor(private readonly pool: SqlPool) {}

  async getSnapshot(workspaceId: string) {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<TotalRow>('SELECT limit_bytes,used_bytes,reserved_bytes FROM workspace_storage_quotas WHERE workspace_id=$1', [scope])
      const row = result.rows[0]
      return row ? { limitBytes: Number(row.limit_bytes), usedBytes: Number(row.used_bytes), reservedBytes: Number(row.reserved_bytes) } : undefined
    })
  }

  async reserve(input: Parameters<StorageQuotaRepository['reserve']>[0]) {
    const workspaceId = validateReserve(input)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      await client.query(`INSERT INTO workspace_storage_quotas (workspace_id,limit_bytes) VALUES ($1,$2) ON CONFLICT (workspace_id) DO NOTHING`, [workspaceId, input.limitBytes])
      const quota = await client.query<TotalRow>(`SELECT limit_bytes,used_bytes,reserved_bytes FROM workspace_storage_quotas WHERE workspace_id=$1 FOR UPDATE`, [workspaceId])
      if (!quota.rows[0]) throw new Error('STORAGE_QUOTA_NOT_CONFIGURED')
      const total = quota.rows[0]
      if (Number(total.limit_bytes) !== input.limitBytes) throw new Error('STORAGE_QUOTA_LIMIT_CONFLICT')
      const found = await client.query<QuotaRow>(`SELECT ${projection} FROM storage_quota_reservations WHERE workspace_id=$1 AND reservation_key=$2 FOR UPDATE`, [workspaceId, input.reservationKey])
      const existing = found.rows[0] ? map(found.rows[0]) : undefined
      if (existing && existing.assetId !== input.assetId) throw new Error('STORAGE_QUOTA_IDEMPOTENCY_CONFLICT')
      if (existing && existing.status !== 'released') return { reservation: existing, snapshot: { usedBytes: Number(total.used_bytes), reservedBytes: Number(total.reserved_bytes), requestBytes: input.bytes, limitBytes: Number(total.limit_bytes) }, reused: true }
      const snapshot = { usedBytes: Number(total.used_bytes), reservedBytes: Number(total.reserved_bytes), requestBytes: input.bytes, limitBytes: Number(total.limit_bytes) }
      if (snapshot.usedBytes + snapshot.reservedBytes + input.bytes > snapshot.limitBytes) throw new StorageQuotaExceededError(snapshot)
      const at = input.at ?? now()
      const row = existing
        ? await client.query<QuotaRow>(`UPDATE storage_quota_reservations SET reserved_bytes=$3,actual_bytes=NULL,status='active',revision=revision+1,updated_at=$4 WHERE workspace_id=$1 AND reservation_key=$2 RETURNING ${projection}`, [workspaceId, input.reservationKey, input.bytes, at])
        : await client.query<QuotaRow>(`INSERT INTO storage_quota_reservations (workspace_id,reservation_key,asset_id,reserved_bytes,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',$5,$5) RETURNING ${projection}`, [workspaceId, input.reservationKey, input.assetId, input.bytes, at])
      await client.query(`UPDATE workspace_storage_quotas SET reserved_bytes=reserved_bytes+$2,revision=revision+1,updated_at=$3 WHERE workspace_id=$1`, [workspaceId, input.bytes, at])
      return { reservation: map(row.rows[0]!), snapshot, reused: false }
    })
  }

  async settle(input: Parameters<StorageQuotaRepository['settle']>[0]) {
    const workspaceId = validateSettlement(input)
    const outcome = await withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const quota = await client.query<TotalRow>(`SELECT limit_bytes,used_bytes,reserved_bytes FROM workspace_storage_quotas WHERE workspace_id=$1 FOR UPDATE`, [workspaceId])
      if (!quota.rows[0]) throw new Error('STORAGE_QUOTA_NOT_CONFIGURED')
      const total = quota.rows[0]
      const found = await client.query<QuotaRow>(`SELECT ${projection} FROM storage_quota_reservations WHERE workspace_id=$1 AND reservation_key=$2 FOR UPDATE`, [workspaceId, input.reservationKey])
      const current = found.rows[0] ? map(found.rows[0]) : undefined
      if (!current) throw new Error('STORAGE_QUOTA_RESERVATION_NOT_FOUND')
      if (current.status === 'released') throw new Error('STORAGE_QUOTA_RESERVATION_RELEASED')
      if ((current.status === 'settled' || current.status === 'over_limit') && current.actualBytes === input.actualBytes) {
        return {
          current,
          total,
          exceeded: current.status === 'over_limit',
          replayed: true,
          snapshot: { usedBytes: Number(total.used_bytes), reservedBytes: Number(total.reserved_bytes), requestBytes: input.actualBytes, limitBytes: Number(total.limit_bytes) },
        }
      }
      if (current.status === 'settled' || current.status === 'over_limit') throw new Error('STORAGE_QUOTA_SETTLEMENT_CONFLICT')
      const reservedBytesBefore = current.reservedBytes
      const snapshot = { usedBytes: Number(total.used_bytes), reservedBytes: Math.max(0, Number(total.reserved_bytes) - current.reservedBytes), requestBytes: input.actualBytes, limitBytes: Number(total.limit_bytes) }
      const exceeded = snapshot.usedBytes + input.actualBytes > snapshot.limitBytes
      const at = input.at ?? now()
      const updated = await client.query<QuotaRow>(`UPDATE storage_quota_reservations SET reserved_bytes=0,actual_bytes=$3,status=$4,revision=revision+1,updated_at=$5 WHERE workspace_id=$1 AND reservation_key=$2 RETURNING ${projection}`, [workspaceId, input.reservationKey, input.actualBytes, exceeded ? 'over_limit' : 'settled', at])
      await client.query(`UPDATE workspace_storage_quotas SET reserved_bytes=reserved_bytes-$2,used_bytes=used_bytes+$3,revision=revision+1,updated_at=$4 WHERE workspace_id=$1`, [workspaceId, current.reservedBytes, input.actualBytes, at])
      return { current: map(updated.rows[0]!), total, exceeded, replayed: false, reservedBytesBefore, snapshot: { ...snapshot, usedBytes: snapshot.usedBytes + input.actualBytes } }
    })
    if (outcome.exceeded) throw new StorageQuotaActualExceededError(outcome.snapshot)
    return { reservation: outcome.current, snapshot: outcome.replayed
      ? outcome.snapshot
      : { usedBytes: Number(outcome.total.used_bytes) + input.actualBytes, reservedBytes: Math.max(0, Number(outcome.total.reserved_bytes) - (outcome.reservedBytesBefore ?? 0)), requestBytes: input.actualBytes, limitBytes: Number(outcome.total.limit_bytes) } }
  }

  private async releaseInternal(input: { workspaceId: string; reservationKey: string; at?: string }, allowSettled: boolean) {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    if (!input.reservationKey.trim()) throw new Error('STORAGE_QUOTA_RESERVATION_REQUIRED')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const quota = await client.query<TotalRow>(`SELECT limit_bytes,used_bytes,reserved_bytes FROM workspace_storage_quotas WHERE workspace_id=$1 FOR UPDATE`, [workspaceId])
      if (!quota.rows[0]) throw new Error('STORAGE_QUOTA_NOT_CONFIGURED')
      const found = await client.query<QuotaRow>(`SELECT ${projection} FROM storage_quota_reservations WHERE workspace_id=$1 AND reservation_key=$2 FOR UPDATE`, [workspaceId, input.reservationKey])
      let current = found.rows[0] ? map(found.rows[0]) : undefined
      // The exact key is the reservation for this object. Only when it is
      // absent - a row written before reservation keys became per-object, and
      // which migration 231 (and 232) could not name - is the asset's bare
      // legacy key considered (see `legacyReservationKeyCandidate`). The match
      // is exact and the row has to carry the same asset id, so a release can
      // never reach a *sibling object's* reservation by prefix.
      if (!current) {
        const legacy = legacyReservationKeyCandidate(input.reservationKey)
        if (legacy) {
          const fallback = await client.query<QuotaRow>(`SELECT ${projection} FROM storage_quota_reservations WHERE workspace_id=$1 AND status<>'released' AND reservation_key=$2 AND asset_id=$3 ORDER BY updated_at DESC, revision DESC FOR UPDATE`, [workspaceId, legacy.key, legacy.assetId])
          current = fallback.rows[0] ? map(fallback.rows[0]) : undefined
        }
      }
      if (!current || current.status === 'released') return current
      if (!allowSettled && current.status !== 'active') throw new Error('STORAGE_QUOTA_SETTLED_RELEASE_REQUIRES_PHYSICAL_DELETION')
      const at = input.at ?? now()
      const updated = await client.query<QuotaRow>(`UPDATE storage_quota_reservations SET reserved_bytes=0,actual_bytes=NULL,status='released',revision=revision+1,updated_at=$3 WHERE workspace_id=$1 AND reservation_key=$2 RETURNING ${projection}`, [workspaceId, current.reservationKey, at])
      const releasedBytes = current.status === 'active' ? current.reservedBytes : 0
      const settledBytes = current.status === 'active' ? 0 : (current.actualBytes ?? 0)
      await client.query(`UPDATE workspace_storage_quotas SET reserved_bytes=reserved_bytes-$2,used_bytes=used_bytes-$3,revision=revision+1,updated_at=$4 WHERE workspace_id=$1`, [workspaceId, releasedBytes, settledBytes, at])
      return map(updated.rows[0]!)
    })
  }

  async release(input: Parameters<StorageQuotaRepository['release']>[0]) {
    return this.releaseInternal(input, false)
  }

  async releaseAfterPhysicalDeletion(input: Parameters<StorageQuotaRepository['releaseAfterPhysicalDeletion']>[0]) {
    const workspaceId = validatePhysicalDeletion(input)
    assertDeletionIdentity({ workspaceId, reservationKey: input.reservationKey, receipt: input.receipt })
    return this.releaseInternal({ ...input, at: input.at ?? input.receipt.deletedAt }, true)
  }
}
