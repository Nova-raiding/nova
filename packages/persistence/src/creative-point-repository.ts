import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'

export interface CreativePointBalance {
  workspaceId: string
  availablePoints: number | null
  reservedPoints: number | null
  settledPoints: number | null
  revision: number
  updatedAt?: string
}
export interface CreativePointBalanceDetails extends CreativePointBalance {
  nextExpiry: string | null
  expiringPoints: number | null
}

export interface CreativePointStatementCursor { createdAt: string; id: string }
export interface CreativePointStatementEntry {
  id: string
  workspaceId: string
  operationId: string
  eventType: 'granted' | 'reserved' | 'released' | 'settled'
  pointsDelta: number
  availableAfter: number | null
  reservedAfter: number | null
  settledAfter: number | null
  accessRevision: number
  createdAt: string
  intent: Record<string, unknown>
  grantSourceType: string | null
  grantSourceId: string | null
}
export interface CreativePointStatementPage { items: CreativePointStatementEntry[]; nextCursor: CreativePointStatementCursor | null }

export interface CreativePointGrant {
  id: string
  workspaceId: string
  operationId: string
  sourceType: string
  sourceId: string
  points: number
  expiresAt: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export type CreativePointReservationStatus = 'active' | 'released' | 'settled'
export interface CreativePointReservation {
  id: string
  workspaceId: string
  operationId: string
  actionKey: string
  rateCardVersion: string
  points: number
  status: CreativePointReservationStatus
  settledPoints: number | null
  createdAt: string
  finalizedAt: string | null
}

export type CreativePointReservationCurrentStatus = CreativePointReservationStatus | 'expired'
export interface CreativePointReservationFact extends Omit<CreativePointReservation, 'status'> {
  status: CreativePointReservationCurrentStatus
  persistedStatus: CreativePointReservationStatus
  intent: Record<string, unknown>
}

export interface CreativePointMutation<T> { value: T; balance: CreativePointBalance }
export interface GrantCreativePointsInput { workspaceId: string; idempotencyKey: string; sourceType: string; sourceId: string; points: number; expiresAt?: string | null; metadata?: Record<string, unknown>; at?: string }
export interface ReserveCreativePointsInput { workspaceId: string; idempotencyKey: string; actionKey: string; points: number; rateCardVersion: string; at?: string }
export interface ReleaseCreativePointsInput { workspaceId: string; idempotencyKey: string; reservationId: string; at?: string }
export interface SettleCreativePointsInput { workspaceId: string; idempotencyKey: string; reservationId: string; actualPoints: number; metadata?: Record<string, unknown>; at?: string }

export interface CreativePointRepository {
  getBalance(workspaceId: string, at?: string): Promise<CreativePointBalance>
  getBalanceDetails(workspaceId: string, at?: string): Promise<CreativePointBalanceDetails>
  getReservation(workspaceId: string, reservationId: string, at?: string): Promise<CreativePointReservationFact | null>
  listStatement(workspaceId: string, options?: { limit?: number; cursor?: CreativePointStatementCursor }): Promise<CreativePointStatementPage>
  grant(input: GrantCreativePointsInput): Promise<CreativePointMutation<CreativePointGrant>>
  reserve(input: ReserveCreativePointsInput): Promise<CreativePointMutation<CreativePointReservation>>
  release(input: ReleaseCreativePointsInput): Promise<CreativePointMutation<CreativePointReservation>>
  settle(input: SettleCreativePointsInput): Promise<CreativePointMutation<CreativePointReservation>>
}

export type CreativePointErrorCode = 'CREATIVE_POINT_INPUT_INVALID' | 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' | 'CREATIVE_POINT_BALANCE_UNKNOWN' | 'CREATIVE_POINT_INSUFFICIENT' | 'CREATIVE_POINT_RESERVATION_NOT_FOUND' | 'CREATIVE_POINT_RESERVATION_FINALIZED' | 'CREATIVE_POINT_ALLOCATION_FAILED'
export class CreativePointRepositoryError extends Error {
  constructor(readonly code: CreativePointErrorCode, message: string) { super(message); this.name = 'CreativePointRepositoryError' }
}

const now = () => new Date().toISOString()
function positivePoints(value: number, field = 'points'): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new CreativePointRepositoryError('CREATIVE_POINT_INPUT_INVALID', `${field} must be a positive safe integer`)
  return value
}
function nonNegativePoints(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new CreativePointRepositoryError('CREATIVE_POINT_INPUT_INVALID', 'actualPoints must be a non-negative safe integer')
  return value
}
function required(value: string, field: string): string {
  if (!value.trim()) throw new CreativePointRepositoryError('CREATIVE_POINT_INPUT_INVALID', `${field} is required`)
  return value
}
function instant(value: string | undefined): string {
  const result = value ?? now()
  if (!Number.isFinite(Date.parse(result))) throw new CreativePointRepositoryError('CREATIVE_POINT_INPUT_INVALID', 'timestamp is invalid')
  return result
}
function optionalInstant(value: string | null | undefined): string | null {
  if (value == null) return null
  if (!Number.isFinite(Date.parse(value))) throw new CreativePointRepositoryError('CREATIVE_POINT_INPUT_INVALID', 'expiresAt is invalid')
  return new Date(value).toISOString()
}
function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, normalize(nested)]))
    return item
  }
  return JSON.stringify(normalize(value))
}
function currentReservationFact(reservation: CreativePointReservation, intent: Record<string, unknown>, at: string): CreativePointReservationFact {
  void at
  return {
    ...reservation,
    status: reservation.status,
    persistedStatus: reservation.status,
    intent: structuredClone(intent),
  }
}
function statementLimit(value: number | undefined): number {
  const limit = value ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CreativePointRepositoryError('CREATIVE_POINT_INPUT_INVALID', 'statement limit must be between 1 and 100')
  return limit
}

type MemoryGrant = CreativePointGrant & { allocated: number }
export class MemoryCreativePointRepository implements CreativePointRepository {
  private readonly grants = new Map<string, MemoryGrant>()
  private readonly reservations = new Map<string, CreativePointReservation>()
  private readonly reservationIntents = new Map<string, Record<string, unknown>>()
  private readonly allocations = new Map<string, Map<string, number>>()
  private readonly operationResults = new Map<string, CreativePointMutation<CreativePointGrant | CreativePointReservation>>()
  private readonly operationIntents = new Map<string, string>()
  private readonly statement: CreativePointStatementEntry[] = []
  private readonly revisions = new Map<string, number>()

  private operationKey(workspaceId: string, kind: string, key: string) { return `${workspaceId}\u0000${kind}\u0000${key}` }
  private replay<T extends CreativePointGrant | CreativePointReservation>(key: string, intent: Record<string, unknown>): CreativePointMutation<T> | undefined {
    const result = this.operationResults.get(key)
    if (!result) return undefined
    if (this.operationIntents.get(key) !== canonicalJson(intent)) throw new CreativePointRepositoryError('CREATIVE_POINT_IDEMPOTENCY_CONFLICT', 'idempotency key was already used for a different creative point intent')
    return result as CreativePointMutation<T>
  }
  private remember(key: string, intent: Record<string, unknown>, result: CreativePointMutation<CreativePointGrant | CreativePointReservation>) { this.operationIntents.set(key, canonicalJson(intent)); this.operationResults.set(key, result) }
  private balance(workspaceId: string, at: string): CreativePointBalance {
    const scoped = [...this.grants.values()].filter(item => item.workspaceId === workspaceId)
    if (scoped.length === 0 && !this.revisions.has(workspaceId)) return { workspaceId, availablePoints: null, reservedPoints: null, settledPoints: null, revision: 0 }
    const availableGrantPoints = scoped.filter(item => item.expiresAt === null || item.expiresAt > at).reduce((sum, item) => sum + item.points - item.allocated, 0)
    const reservedPoints = [...this.reservations.values()].filter(item => item.workspaceId === workspaceId && item.status === 'active').reduce((sum, item) => sum + item.points, 0)
    const settledPoints = [...this.reservations.values()].filter(item => item.workspaceId === workspaceId && item.status === 'settled').reduce((sum, item) => sum + (item.settledPoints ?? 0), 0)
    return { workspaceId, availablePoints: Math.max(0, availableGrantPoints), reservedPoints, settledPoints, revision: this.revisions.get(workspaceId) ?? 0, updatedAt: at }
  }
  private advance(workspaceId: string, at: string) { this.revisions.set(workspaceId, (this.revisions.get(workspaceId) ?? 0) + 1); return this.balance(workspaceId, at) }
  private appendStatement(workspaceId: string, operationId: string, eventType: CreativePointStatementEntry['eventType'], pointsDelta: number, balance: CreativePointBalance, intent: Record<string, unknown>, createdAt: string, grant?: CreativePointGrant) { this.statement.push({ id: `cpl_${randomUUID()}`, workspaceId, operationId, eventType, pointsDelta, availableAfter: balance.availablePoints, reservedAfter: balance.reservedPoints, settledAfter: balance.settledPoints, accessRevision: balance.revision, createdAt, intent: structuredClone(intent), grantSourceType: grant?.sourceType ?? null, grantSourceId: grant?.sourceId ?? null }) }
  async getBalance(workspaceId: string, at = now()) { return this.balance(requireWorkspaceScope(workspaceId), instant(at)) }
  async getBalanceDetails(workspaceId: string, at = now()): Promise<CreativePointBalanceDetails> {
    const scope = requireWorkspaceScope(workspaceId); const observedAt = instant(at); const balance = this.balance(scope, observedAt)
    if (balance.availablePoints === null) return { ...balance, nextExpiry: null, expiringPoints: null }
    const live = [...this.grants.values()].filter(item => item.workspaceId === scope && item.expiresAt !== null && item.expiresAt > observedAt && item.points > item.allocated).sort((left, right) => left.expiresAt!.localeCompare(right.expiresAt!))
    const nextExpiry = live[0]?.expiresAt ?? null
    return { ...balance, nextExpiry, expiringPoints: nextExpiry === null ? 0 : live.filter(item => item.expiresAt === nextExpiry).reduce((sum, item) => sum + item.points-item.allocated, 0) }
  }
  async getReservation(workspaceId: string, reservationId: string, at = now()): Promise<CreativePointReservationFact | null> {
    const scope = requireWorkspaceScope(workspaceId); required(reservationId, 'reservationId'); const observedAt = instant(at)
    const reservation = this.reservations.get(reservationId)
    if (!reservation || reservation.workspaceId !== scope) return null
    return currentReservationFact(reservation, this.reservationIntents.get(reservation.id) ?? { action_key: reservation.actionKey, points: reservation.points }, observedAt)
  }
  async listStatement(workspaceId: string, options: { limit?: number; cursor?: CreativePointStatementCursor } = {}): Promise<CreativePointStatementPage> {
    const scope = requireWorkspaceScope(workspaceId); const limit = statementLimit(options.limit)
    if (options.cursor) { instant(options.cursor.createdAt); required(options.cursor.id, 'cursor.id') }
    const candidates = this.statement.filter(item => item.workspaceId === scope && (!options.cursor || item.createdAt < options.cursor.createdAt || (item.createdAt === options.cursor.createdAt && item.id < options.cursor.id))).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    const items = candidates.slice(0, limit); const last = items.at(-1)
    return { items, nextCursor: candidates.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null }
  }
  async grant(input: GrantCreativePointsInput): Promise<CreativePointMutation<CreativePointGrant>> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const at = instant(input.at); positivePoints(input.points); required(input.idempotencyKey, 'idempotencyKey'); required(input.sourceType, 'sourceType'); required(input.sourceId, 'sourceId')
    const intent = { source_type: input.sourceType, source_id: input.sourceId, points: input.points, expires_at: optionalInstant(input.expiresAt), metadata: input.metadata ?? {} }
    const key = this.operationKey(workspaceId, 'grant', input.idempotencyKey); const replay = this.replay<CreativePointGrant>(key, intent)
    if (replay) return replay
    const existing = [...this.grants.values()].find(item => item.workspaceId === workspaceId && item.sourceType === input.sourceType && item.sourceId === input.sourceId)
    if (existing) { if (existing.points !== input.points || existing.expiresAt !== intent.expires_at) throw new CreativePointRepositoryError('CREATIVE_POINT_IDEMPOTENCY_CONFLICT', 'creative point grant source was already recorded with different facts'); return { value: existing, balance: this.balance(workspaceId, at) } }
    const grant: MemoryGrant = { id: `cpg_${randomUUID()}`, workspaceId, operationId: `cpo_${randomUUID()}`, sourceType: input.sourceType, sourceId: input.sourceId, points: input.points, expiresAt: intent.expires_at, metadata: input.metadata ?? {}, createdAt: at, allocated: 0 }
    this.grants.set(grant.id, grant); const result = { value: grant, balance: this.advance(workspaceId, at) }; this.appendStatement(workspaceId,grant.operationId,'granted',grant.points,result.balance,intent,at,grant); this.remember(key, intent, result); return result
  }
  async reserve(input: ReserveCreativePointsInput): Promise<CreativePointMutation<CreativePointReservation>> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const at = instant(input.at); positivePoints(input.points); required(input.idempotencyKey, 'idempotencyKey'); required(input.actionKey, 'actionKey')
    const rateCardVersion = required(input.rateCardVersion, 'rateCardVersion')
    const intent = { action_key: input.actionKey, points: input.points, rate_card_version: rateCardVersion }
    const key = this.operationKey(workspaceId, 'reserve', input.idempotencyKey); const replay = this.replay<CreativePointReservation>(key, intent)
    if (replay) return replay
    const before = this.balance(workspaceId, at)
    if (before.availablePoints === null) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN', 'creative point balance is unknown')
    if (before.availablePoints < input.points) throw new CreativePointRepositoryError('CREATIVE_POINT_INSUFFICIENT', 'creative points are insufficient')
    const reservation: CreativePointReservation = { id: `cpr_${randomUUID()}`, workspaceId, operationId: `cpo_${randomUUID()}`, actionKey: input.actionKey, rateCardVersion, points: input.points, status: 'active', settledPoints: null, createdAt: at, finalizedAt: null }
    const reservationAllocations = new Map<string, number>()
    let remaining = input.points
    const grants = [...this.grants.values()].filter(item => item.workspaceId === workspaceId && (item.expiresAt === null || item.expiresAt > at) && item.allocated < item.points).sort((a, b) => (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    for (const grant of grants) { const allocation = Math.min(remaining, grant.points - grant.allocated); grant.allocated += allocation; reservationAllocations.set(grant.id, allocation); remaining -= allocation; if (remaining === 0) break }
    if (remaining !== 0) throw new CreativePointRepositoryError('CREATIVE_POINT_ALLOCATION_FAILED', 'creative point grants could not cover reservation')
    this.allocations.set(reservation.id, reservationAllocations); this.reservationIntents.set(reservation.id, intent); this.reservations.set(reservation.id, reservation); const result = { value: reservation, balance: this.advance(workspaceId, at) }; this.appendStatement(workspaceId,reservation.operationId,'reserved',-reservation.points,result.balance,intent,at); this.remember(key, intent, result); return result
  }
  async release(input: ReleaseCreativePointsInput): Promise<CreativePointMutation<CreativePointReservation>> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const at = instant(input.at); required(input.idempotencyKey, 'idempotencyKey')
    const intent = { reservation_id: input.reservationId }
    const key = this.operationKey(workspaceId, 'release', input.idempotencyKey); const replay = this.replay<CreativePointReservation>(key, intent)
    if (replay) return replay
    const current = this.reservations.get(input.reservationId)
    if (!current || current.workspaceId !== workspaceId) throw new CreativePointRepositoryError('CREATIVE_POINT_RESERVATION_NOT_FOUND', 'creative point reservation was not found')
    if (current.status !== 'active') throw new CreativePointRepositoryError('CREATIVE_POINT_RESERVATION_FINALIZED', 'creative point reservation is already finalized')
    let remaining = current.points
    const reservationAllocations = this.allocations.get(current.id) ?? new Map<string, number>()
    for (const [grantId, allocated] of reservationAllocations) { const grant = this.grants.get(grantId); if (!grant) continue; const released = Math.min(remaining, allocated); grant.allocated -= released; reservationAllocations.set(grantId, allocated-released); remaining -= released; if (remaining === 0) break }
    if (remaining !== 0) throw new CreativePointRepositoryError('CREATIVE_POINT_ALLOCATION_FAILED', 'creative point reservation allocations are incomplete')
    const value = { ...current, status: 'released' as const, finalizedAt: at }; this.reservations.set(value.id, value)
    const result = { value, balance: this.advance(workspaceId, at) }; this.appendStatement(workspaceId,`cpo_${randomUUID()}`,'released',current.points,result.balance,intent,at); this.remember(key, intent, result); return result
  }
  async settle(input: SettleCreativePointsInput): Promise<CreativePointMutation<CreativePointReservation>> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const at = instant(input.at); nonNegativePoints(input.actualPoints); required(input.idempotencyKey, 'idempotencyKey')
    const intent = { reservation_id: input.reservationId, actual_points: input.actualPoints, metadata: input.metadata ?? {} }
    const key = this.operationKey(workspaceId, 'settle', input.idempotencyKey); const replay = this.replay<CreativePointReservation>(key, intent)
    if (replay) return replay
    const current = this.reservations.get(input.reservationId)
    if (!current || current.workspaceId !== workspaceId) throw new CreativePointRepositoryError('CREATIVE_POINT_RESERVATION_NOT_FOUND', 'creative point reservation was not found')
    if (current.status !== 'active') throw new CreativePointRepositoryError('CREATIVE_POINT_RESERVATION_FINALIZED', 'creative point reservation is already finalized')
    const before = this.balance(workspaceId, at); const capacity = (before.availablePoints ?? 0) + current.points
    if (before.availablePoints === null) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN', 'creative point balance is unknown')
    if (input.actualPoints > capacity) throw new CreativePointRepositoryError('CREATIVE_POINT_INSUFFICIENT', 'creative points are insufficient for settlement')
    let adjustment = input.actualPoints - current.points
    const reservationAllocations = this.allocations.get(current.id) ?? new Map<string, number>()
    const grants = [...this.grants.values()].filter(item => item.workspaceId === workspaceId).sort((a, b) => (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    if (adjustment < 0) { let release = -adjustment; for (const grant of grants.filter(item => (reservationAllocations.get(item.id) ?? 0) > 0).reverse()) { const allocated = reservationAllocations.get(grant.id) ?? 0; const amount = Math.min(release, allocated); grant.allocated -= amount; reservationAllocations.set(grant.id, allocated-amount); release -= amount; if (release === 0) break } if (release !== 0) throw new CreativePointRepositoryError('CREATIVE_POINT_ALLOCATION_FAILED', 'creative point reservation allocations are incomplete') }
    if (adjustment > 0) { for (const grant of grants.filter(item => (item.expiresAt === null || item.expiresAt > at) && item.allocated < item.points)) { const amount = Math.min(adjustment, grant.points - grant.allocated); grant.allocated += amount; reservationAllocations.set(grant.id, (reservationAllocations.get(grant.id) ?? 0)+amount); adjustment -= amount; if (adjustment === 0) break } if (adjustment !== 0) throw new CreativePointRepositoryError('CREATIVE_POINT_ALLOCATION_FAILED', 'creative point grants could not cover settlement') }
    const value = { ...current, status: 'settled' as const, settledPoints: input.actualPoints, finalizedAt: at }; this.reservations.set(value.id, value)
    const result = { value, balance: this.advance(workspaceId, at) }; this.appendStatement(workspaceId,`cpo_${randomUUID()}`,'settled',current.points-input.actualPoints,result.balance,intent,at); this.remember(key, intent, result); return result
  }
}

type BalanceRow = { workspaceId: string; availablePoints: string | number | null; reservedPoints: string | number | null; settledPoints: string | number | null; revision: string | number; updatedAt?: string | Date }
type GrantRow = { id: string; workspaceId: string; operationId: string; sourceType: string; sourceId: string; points: string | number; expiresAt: string | Date | null; metadata: Record<string, unknown>; createdAt: string | Date }
type ReservationRow = { id: string; workspaceId: string; operationId: string; actionKey: string; rateCardVersion: string; points: string | number; status: CreativePointReservationStatus; settledPoints: string | number | null; createdAt: string | Date; finalizedAt: string | Date | null }
const integer = (value: string | number) => {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN', 'creative point value is outside the safe integer range')
  return result
}
const timestampValue = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const balanceFromRow = (row: BalanceRow): CreativePointBalance => ({ workspaceId: row.workspaceId, availablePoints: row.availablePoints === null ? null : integer(row.availablePoints), reservedPoints: row.reservedPoints === null ? null : integer(row.reservedPoints), settledPoints: row.settledPoints === null ? null : integer(row.settledPoints), revision: integer(row.revision), ...(row.updatedAt ? { updatedAt: timestampValue(row.updatedAt) } : {}) })
const grantFromRow = (row: GrantRow): CreativePointGrant => ({ ...row, points: integer(row.points), expiresAt: row.expiresAt == null ? null : timestampValue(row.expiresAt), createdAt: timestampValue(row.createdAt) })
const reservationFromRow = (row: ReservationRow): CreativePointReservation => ({ ...row, points: integer(row.points), settledPoints: row.settledPoints === null ? null : integer(row.settledPoints), createdAt: timestampValue(row.createdAt), finalizedAt: row.finalizedAt == null ? null : timestampValue(row.finalizedAt) })
const balanceProjection = `workspace_id AS "workspaceId", available_points AS "availablePoints", reserved_points AS "reservedPoints", settled_points AS "settledPoints", revision, updated_at AS "updatedAt"`
const grantProjection = `id, workspace_id AS "workspaceId", operation_id AS "operationId", source_type AS "sourceType", source_id AS "sourceId", points, expires_at AS "expiresAt", metadata, created_at AS "createdAt"`
const reservationProjection = `id, workspace_id AS "workspaceId", operation_id AS "operationId", action_key AS "actionKey", rate_card_version AS "rateCardVersion", points, status, settled_points AS "settledPoints", created_at AS "createdAt", finalized_at AS "finalizedAt"`
const reservationFactProjection = `r.id, r.workspace_id AS "workspaceId", r.operation_id AS "operationId", r.action_key AS "actionKey", r.rate_card_version AS "rateCardVersion", r.points, r.status, r.settled_points AS "settledPoints", r.created_at AS "createdAt", r.finalized_at AS "finalizedAt"`

export class PostgresCreativePointRepository implements CreativePointRepository {
  constructor(private readonly pool: SqlPool) {}
  async getBalance(workspaceId: string, at = now()) { const scope = requireWorkspaceScope(workspaceId); return withWorkspaceTransaction(this.pool, scope, async client => { const rows = await client.query<BalanceRow>(`SELECT ${balanceProjection} FROM creative_point_access_state WHERE workspace_id=$1`, [scope]); if (!rows.rows[0]) return { workspaceId: scope, availablePoints: null, reservedPoints: null, settledPoints: null, revision: 0 }; return this.refreshBalance(client, scope, instant(at), false) }) }
  async getBalanceDetails(workspaceId: string, at = now()): Promise<CreativePointBalanceDetails> {
    const scope = requireWorkspaceScope(workspaceId); const observedAt = instant(at)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const state = await client.query<BalanceRow>(`SELECT ${balanceProjection} FROM creative_point_access_state WHERE workspace_id=$1`, [scope])
      if (!state.rows[0]) return { workspaceId: scope, availablePoints: null, reservedPoints: null, settledPoints: null, revision: 0, nextExpiry: null, expiringPoints: null }
      const balance = await this.refreshBalance(client, scope, observedAt, false)
      if (balance.availablePoints === null) return { ...balance, nextExpiry: null, expiringPoints: null }
      const expiry = await client.query<{ nextExpiry: string | Date; expiringPoints: string | number }>(
        `WITH remaining AS (
           SELECT g.expires_at, GREATEST(g.points-COALESCE(sum(a.points_delta),0),0) AS points
             FROM creative_point_grants g
             LEFT JOIN creative_point_allocations a ON a.workspace_id=g.workspace_id AND a.grant_id=g.id
            WHERE g.workspace_id=$1 AND g.expires_at>$2::timestamptz
            GROUP BY g.id, g.points, g.expires_at
         ), next_expiry AS (SELECT min(expires_at) AS expires_at FROM remaining WHERE points>0)
         SELECT n.expires_at AS "nextExpiry", sum(r.points) AS "expiringPoints"
           FROM next_expiry n JOIN remaining r ON r.expires_at=n.expires_at
          GROUP BY n.expires_at`,
        [scope, observedAt],
      )
      const row = expiry.rows[0]
      return { ...balance, nextExpiry: row ? timestampValue(row.nextExpiry) : null, expiringPoints: row ? integer(row.expiringPoints) : 0 }
    })
  }
  async getReservation(workspaceId: string, reservationId: string, at = now()): Promise<CreativePointReservationFact | null> {
    const scope = requireWorkspaceScope(workspaceId); required(reservationId, 'reservationId'); const observedAt = instant(at)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<ReservationRow & { intent: Record<string, unknown> }>(
        `SELECT ${reservationFactProjection}, o.request AS intent
           FROM creative_point_reservations r
           JOIN creative_point_operations o
             ON o.workspace_id=r.workspace_id AND o.id=r.operation_id
          WHERE r.workspace_id=$1 AND r.id=$2
          LIMIT 1`,
        [scope, reservationId],
      )
      const row = result.rows[0]
      return row ? currentReservationFact(reservationFromRow(row), row.intent, observedAt) : null
    })
  }
  async listStatement(workspaceId: string, options: { limit?: number; cursor?: CreativePointStatementCursor } = {}): Promise<CreativePointStatementPage> {
    const scope = requireWorkspaceScope(workspaceId); const limit = statementLimit(options.limit)
    const cursorAt = options.cursor ? instant(options.cursor.createdAt) : null; const cursorId = options.cursor ? required(options.cursor.id, 'cursor.id') : null
    return withWorkspaceTransaction(this.pool, scope, async client => {
      type Row = { id: string; workspaceId: string; operationId: string; eventType: CreativePointStatementEntry['eventType']; pointsDelta: string | number; availableAfter: string | number | null; reservedAfter: string | number | null; settledAfter: string | number | null; accessRevision: string | number; createdAt: string | Date; intent: Record<string, unknown>; grantSourceType: string | null; grantSourceId: string | null }
      const result = await client.query<Row>(
        `SELECT e.id, e.workspace_id AS "workspaceId", e.operation_id AS "operationId",
                e.event_type AS "eventType", e.points_delta AS "pointsDelta",
                e.available_after AS "availableAfter", e.reserved_after AS "reservedAfter",
                e.settled_after AS "settledAfter", e.access_revision AS "accessRevision",
                e.created_at AS "createdAt", o.request AS intent,
                g.source_type AS "grantSourceType", g.source_id AS "grantSourceId"
           FROM creative_point_ledger_events e
           JOIN creative_point_operations o ON o.workspace_id=e.workspace_id AND o.id=e.operation_id
           LEFT JOIN creative_point_grants g ON g.workspace_id=e.workspace_id AND g.operation_id=e.operation_id
          WHERE e.workspace_id=$1
            AND ($2::timestamptz IS NULL OR (e.created_at,e.id)<($2::timestamptz,$3::text))
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT $4`,
        [scope, cursorAt, cursorId, limit+1],
      )
      const mapped = result.rows.map(row => ({ id: row.id, workspaceId: row.workspaceId, operationId: row.operationId, eventType: row.eventType, pointsDelta: integer(row.pointsDelta), availableAfter: row.availableAfter===null?null:integer(row.availableAfter), reservedAfter: row.reservedAfter===null?null:integer(row.reservedAfter), settledAfter: row.settledAfter===null?null:integer(row.settledAfter), accessRevision: integer(row.accessRevision), createdAt: timestampValue(row.createdAt), intent: row.intent, grantSourceType: row.grantSourceType, grantSourceId: row.grantSourceId }))
      const items = mapped.slice(0, limit); const last = items.at(-1)
      return { items, nextCursor: mapped.length>limit&&last?{createdAt:last.createdAt,id:last.id}:null }
    })
  }
  private async lockState(client: SqlClient, workspaceId: string) { await client.query('INSERT INTO creative_point_access_state (workspace_id,available_points,reserved_points,settled_points) VALUES ($1,NULL,NULL,NULL) ON CONFLICT (workspace_id) DO NOTHING', [workspaceId]); await client.query('SELECT workspace_id FROM creative_point_access_state WHERE workspace_id=$1 FOR UPDATE', [workspaceId]) }
  private async refreshBalance(client: SqlClient, workspaceId: string, at: string, advance: boolean): Promise<CreativePointBalance> {
    const computed = await client.query<{ available: string | null; reserved: string | null; settled: string | null; known: boolean }>(`SELECT EXISTS(SELECT 1 FROM creative_point_grants WHERE workspace_id=$1) AS known, COALESCE((SELECT sum(GREATEST(g.points-COALESCE(a.points,0),0)) FROM creative_point_grants g LEFT JOIN (SELECT workspace_id,grant_id,sum(points_delta) points FROM creative_point_allocations WHERE workspace_id=$1 GROUP BY workspace_id,grant_id) a ON a.workspace_id=g.workspace_id AND a.grant_id=g.id WHERE g.workspace_id=$1 AND (g.expires_at IS NULL OR g.expires_at>$2::timestamptz)),0) AS available, COALESCE((SELECT sum(points) FROM creative_point_reservations WHERE workspace_id=$1 AND status='active'),0) AS reserved, COALESCE((SELECT sum(settled_points) FROM creative_point_reservations WHERE workspace_id=$1 AND status='settled'),0) AS settled`, [workspaceId, at])
    const values = computed.rows[0]!; const available = values.known ? integer(values.available!) : null
    if (available !== null && available < 0) throw new CreativePointRepositoryError('CREATIVE_POINT_INSUFFICIENT', 'creative point allocation exceeds grant capacity')
    const result = await client.query<BalanceRow>(`UPDATE creative_point_access_state SET available_points=$2,reserved_points=$3,settled_points=$4,revision=revision+$5,updated_at=$6::timestamptz WHERE workspace_id=$1 RETURNING ${balanceProjection}`, [workspaceId, available, values.known ? integer(values.reserved!) : null, values.known ? integer(values.settled!) : null, advance ? 1 : 0, at]); return balanceFromRow(result.rows[0]!)
  }
  private async replay<T>(client: SqlClient, workspaceId: string, kind: string, key: string, request: Record<string, unknown>, projection: string, table: string): Promise<T | undefined> { const op = await client.query<{ result: { entity_id?: string } | null; requestMatches: boolean }>('SELECT result, request=$4::jsonb AS "requestMatches" FROM creative_point_operations WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3 AND status=\'completed\'', [workspaceId, kind, key, JSON.stringify(request)]); if(op.rows[0]&&!op.rows[0].requestMatches) throw new CreativePointRepositoryError('CREATIVE_POINT_IDEMPOTENCY_CONFLICT','idempotency key was already used for a different creative point intent'); const id = op.rows[0]?.result?.entity_id; if (!id) return undefined; const result = await client.query<T>(`SELECT ${projection} FROM ${table} WHERE workspace_id=$1 AND id=$2`, [workspaceId, id]); return result.rows[0] }
  private async insertOperation(client: SqlClient, id: string, workspaceId: string, kind: string, key: string, request: Record<string, unknown>) { await client.query('INSERT INTO creative_point_operations (id,workspace_id,kind,idempotency_key,status,request) VALUES ($1,$2,$3,$4,\'pending\',$5::jsonb)', [id, workspaceId, kind, key, JSON.stringify(request)]) }
  private async complete(client: SqlClient, workspaceId: string, operationId: string, entityId: string, at: string) { await client.query("UPDATE creative_point_operations SET status='completed',result=jsonb_build_object('entity_id',$3::text),completed_at=$4::timestamptz WHERE workspace_id=$1 AND id=$2", [workspaceId, operationId, entityId, at]) }
  private async ledger(client: SqlClient, workspaceId: string, operationId: string, type: string, delta: number, balance: CreativePointBalance, metadata: Record<string, unknown> = {}) { await client.query('INSERT INTO creative_point_ledger_events (id,workspace_id,operation_id,event_type,points_delta,available_after,reserved_after,settled_after,access_revision,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)', [`cpl_${randomUUID()}`, workspaceId, operationId, type, delta, balance.availablePoints, balance.reservedPoints, balance.settledPoints, balance.revision, JSON.stringify(metadata)]) }
  private async allocate(client: SqlClient, workspaceId: string, reservationId: string, points: number, at: string, allocationType: 'reserve' | 'settle_adjustment') {
    let remaining = points
    const grants = await client.query<{ id: string; remaining: string | number }>(
      `SELECT g.id, g.points-COALESCE(a.points,0) AS remaining
         FROM creative_point_grants g
         LEFT JOIN LATERAL (
           SELECT sum(points_delta) AS points
             FROM creative_point_allocations
            WHERE workspace_id=g.workspace_id AND grant_id=g.id
         ) a ON true
        WHERE g.workspace_id=$1
          AND (g.expires_at IS NULL OR g.expires_at>$2::timestamptz)
          AND g.points-COALESCE(a.points,0)>0
        ORDER BY g.expires_at NULLS LAST, g.created_at, g.id`,
      [workspaceId, at],
    )
    for (const grant of grants.rows) {
      const amount = Math.min(remaining, integer(grant.remaining))
      if (amount > 0) {
        await client.query(
          'INSERT INTO creative_point_allocations (id,workspace_id,reservation_id,grant_id,allocation_type,points_delta,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)',
          [`cpa_${randomUUID()}`, workspaceId, reservationId, grant.id, allocationType, amount, at],
        )
        remaining -= amount
      }
      if (remaining === 0) break
    }
    if (remaining !== 0) throw new CreativePointRepositoryError('CREATIVE_POINT_ALLOCATION_FAILED', 'creative point grants could not cover allocation')
  }
  private async reverseAllocation(client: SqlClient, workspaceId: string, reservationId: string, points: number, at: string, allocationType: 'release' | 'settle_adjustment') {
    let remaining = points
    const allocations = await client.query<{ grantId: string; allocated: string | number }>(
      `SELECT a.grant_id AS "grantId", sum(a.points_delta) AS allocated
         FROM creative_point_allocations a
         JOIN creative_point_grants g ON g.workspace_id=a.workspace_id AND g.id=a.grant_id
        WHERE a.workspace_id=$1 AND a.reservation_id=$2
        GROUP BY a.grant_id, g.expires_at, g.created_at
       HAVING sum(a.points_delta)>0
        ORDER BY g.expires_at DESC NULLS FIRST, g.created_at DESC, a.grant_id DESC`,
      [workspaceId, reservationId],
    )
    for (const allocation of allocations.rows) {
      const amount = Math.min(remaining, integer(allocation.allocated))
      if (amount > 0) {
        await client.query(
          'INSERT INTO creative_point_allocations (id,workspace_id,reservation_id,grant_id,allocation_type,points_delta,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)',
          [`cpa_${randomUUID()}`, workspaceId, reservationId, allocation.grantId, allocationType, -amount, at],
        )
        remaining -= amount
      }
      if (remaining === 0) break
    }
    if (remaining !== 0) throw new CreativePointRepositoryError('CREATIVE_POINT_ALLOCATION_FAILED', 'creative point reservation allocations are incomplete')
  }
  async grant(input: GrantCreativePointsInput): Promise<CreativePointMutation<CreativePointGrant>> { const workspaceId=requireWorkspaceScope(input.workspaceId); const at=instant(input.at); positivePoints(input.points); required(input.idempotencyKey,'idempotencyKey'); required(input.sourceType,'sourceType'); required(input.sourceId,'sourceId'); const expiresAt=optionalInstant(input.expiresAt); const request={source_type:input.sourceType,source_id:input.sourceId,points:input.points,expires_at:expiresAt,metadata:input.metadata??{}}; return withWorkspaceTransaction(this.pool,workspaceId,async client=>{ await this.lockState(client,workspaceId); const replay=await this.replay<GrantRow>(client,workspaceId,'grant',input.idempotencyKey,request,grantProjection,'creative_point_grants'); if(replay) return {value:grantFromRow(replay),balance:await this.refreshBalance(client,workspaceId,at,false)}; const source=await client.query<GrantRow>(`SELECT ${grantProjection} FROM creative_point_grants WHERE workspace_id=$1 AND source_type=$2 AND source_id=$3`,[workspaceId,input.sourceType,input.sourceId]); if(source.rows[0]){const existing=grantFromRow(source.rows[0]);if(existing.points!==input.points||existing.expiresAt!==expiresAt)throw new CreativePointRepositoryError('CREATIVE_POINT_IDEMPOTENCY_CONFLICT','creative point grant source was already recorded with different facts');return {value:existing,balance:await this.refreshBalance(client,workspaceId,at,false)}} const operationId=`cpo_${randomUUID()}`; const grantId=`cpg_${randomUUID()}`; await this.insertOperation(client,operationId,workspaceId,'grant',input.idempotencyKey,request); const row=await client.query<GrantRow>(`INSERT INTO creative_point_grants (id,workspace_id,operation_id,source_type,source_id,points,expires_at,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz) RETURNING ${grantProjection}`,[grantId,workspaceId,operationId,input.sourceType,input.sourceId,input.points,expiresAt,JSON.stringify(input.metadata??{}),at]); const balance=await this.refreshBalance(client,workspaceId,at,true); await this.ledger(client,workspaceId,operationId,'granted',input.points,balance,input.metadata); await this.complete(client,workspaceId,operationId,grantId,at); return {value:grantFromRow(row.rows[0]!),balance} }) }
  async reserve(input: ReserveCreativePointsInput): Promise<CreativePointMutation<CreativePointReservation>> { const workspaceId=requireWorkspaceScope(input.workspaceId); const at=instant(input.at); positivePoints(input.points); required(input.idempotencyKey,'idempotencyKey'); required(input.actionKey,'actionKey'); const rateCardVersion=required(input.rateCardVersion,'rateCardVersion'); const request={action_key:input.actionKey,points:input.points,rate_card_version:rateCardVersion}; return withWorkspaceTransaction(this.pool,workspaceId,async client=>{ await this.lockState(client,workspaceId); const replay=await this.replay<ReservationRow>(client,workspaceId,'reserve',input.idempotencyKey,request,reservationProjection,'creative_point_reservations'); if(replay) return {value:reservationFromRow(replay),balance:await this.refreshBalance(client,workspaceId,at,false)}; const before=await this.refreshBalance(client,workspaceId,at,false); if(before.availablePoints===null) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN','creative point balance is unknown'); if(before.availablePoints<input.points) throw new CreativePointRepositoryError('CREATIVE_POINT_INSUFFICIENT','creative points are insufficient'); const operationId=`cpo_${randomUUID()}`; const reservationId=`cpr_${randomUUID()}`; await this.insertOperation(client,operationId,workspaceId,'reserve',input.idempotencyKey,request); const row=await client.query<ReservationRow>(`INSERT INTO creative_point_reservations (id,workspace_id,operation_id,action_key,rate_card_version,points,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,'active',$7::timestamptz) RETURNING ${reservationProjection}`,[reservationId,workspaceId,operationId,input.actionKey,rateCardVersion,input.points,at]); await this.allocate(client,workspaceId,reservationId,input.points,at,'reserve'); const balance=await this.refreshBalance(client,workspaceId,at,true); await this.ledger(client,workspaceId,operationId,'reserved',-input.points,balance,{reservation_id:reservationId,action_key:input.actionKey,rate_card_version:rateCardVersion}); await this.complete(client,workspaceId,operationId,reservationId,at); return {value:reservationFromRow(row.rows[0]!),balance} }) }
  async release(input: ReleaseCreativePointsInput): Promise<CreativePointMutation<CreativePointReservation>> { return this.finalize(input,'release',0) }
  async settle(input: SettleCreativePointsInput): Promise<CreativePointMutation<CreativePointReservation>> { nonNegativePoints(input.actualPoints); return this.finalize(input,'settle',input.actualPoints,input.metadata) }
  private async finalize(input: ReleaseCreativePointsInput|SettleCreativePointsInput,kind:'release'|'settle',actualPoints:number,metadata:Record<string,unknown>={}):Promise<CreativePointMutation<CreativePointReservation>> { const workspaceId=requireWorkspaceScope(input.workspaceId); const at=instant(input.at); required(input.idempotencyKey,'idempotencyKey'); required(input.reservationId,'reservationId'); const request={reservation_id:input.reservationId,...(kind==='settle'?{actual_points:actualPoints,metadata}: {})}; return withWorkspaceTransaction(this.pool,workspaceId,async client=>{ await this.lockState(client,workspaceId); const replay=await this.replay<ReservationRow>(client,workspaceId,kind,input.idempotencyKey,request,reservationProjection,'creative_point_reservations'); if(replay) return {value:reservationFromRow(replay),balance:await this.refreshBalance(client,workspaceId,at,false)}; const found=await client.query<ReservationRow>(`SELECT ${reservationProjection} FROM creative_point_reservations WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[workspaceId,input.reservationId]); const current=found.rows[0]; if(!current) throw new CreativePointRepositoryError('CREATIVE_POINT_RESERVATION_NOT_FOUND','creative point reservation was not found'); if(current.status!=='active') throw new CreativePointRepositoryError('CREATIVE_POINT_RESERVATION_FINALIZED','creative point reservation is already finalized'); const before=await this.refreshBalance(client,workspaceId,at,false); if(before.availablePoints===null) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN','creative point balance is unknown'); if(kind==='settle'&&actualPoints>before.availablePoints+integer(current.points)) throw new CreativePointRepositoryError('CREATIVE_POINT_INSUFFICIENT','creative points are insufficient for settlement'); const operationId=`cpo_${randomUUID()}`; await this.insertOperation(client,operationId,workspaceId,kind,input.idempotencyKey,request); if(kind==='release') await this.reverseAllocation(client,workspaceId,input.reservationId,integer(current.points),at,'release'); if(kind==='settle'&&actualPoints<integer(current.points)) await this.reverseAllocation(client,workspaceId,input.reservationId,integer(current.points)-actualPoints,at,'settle_adjustment'); if(kind==='settle'&&actualPoints>integer(current.points)) await this.allocate(client,workspaceId,input.reservationId,actualPoints-integer(current.points),at,'settle_adjustment'); const status=kind==='release'?'released':'settled'; const row=await client.query<ReservationRow>(`UPDATE creative_point_reservations SET status=$3,settled_points=$4,finalized_at=$5::timestamptz WHERE workspace_id=$1 AND id=$2 AND status='active' RETURNING ${reservationProjection}`,[workspaceId,input.reservationId,status,kind==='settle'?actualPoints:null,at]); if(!row.rows[0])throw new CreativePointRepositoryError('CREATIVE_POINT_RESERVATION_FINALIZED','creative point reservation is already finalized'); const balance=await this.refreshBalance(client,workspaceId,at,true); await this.ledger(client,workspaceId,operationId,kind==='release'?'released':'settled',integer(current.points)-actualPoints,balance,{reservation_id:input.reservationId,...metadata}); await this.complete(client,workspaceId,operationId,input.reservationId,at); return {value:reservationFromRow(row.rows[0]),balance} }) }
}
