import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'

/** Enqueue ownership only. Provider transport and schema-repair attempts have
 * their own lifecycle; a bound action is not proof that a provider ran. */
export type CreativeActionPhase = 'available' | 'leased' | 'bound'
export interface CreativeActionClaim {
  workspaceId: string
  actionKey: string
  intentSha256: string
  phase: CreativeActionPhase
  ownerEpoch: number
  ownerToken?: string
  leaseUntil?: string
  reservationId?: string
  jobId?: string
  eventId?: string
  eventPayloadSha256?: string
  updatedAt: string
}
export type LeasedCreativeAction = CreativeActionClaim & { phase: 'leased'; ownerToken: string; leaseUntil: string }
export type CreativeActionClaimErrorCode = 'CREATIVE_ACTION_BUSY' | 'CREATIVE_ACTION_INTENT_MISMATCH' | 'CREATIVE_ACTION_BOUND_RECOVERY_REQUIRED' | 'CREATIVE_ACTION_STALE_OWNER' | 'CREATIVE_ACTION_BINDING_INVALID'
export class CreativeActionClaimError extends Error {
  constructor(readonly code: CreativeActionClaimErrorCode, readonly claim?: CreativeActionClaim) { super(code); this.name = 'CreativeActionClaimError' }
}
export interface CreativeActionClaimRepository {
  claim(input: { workspaceId: string; actionKey: string; intentSha256: string; leaseMs: number }): Promise<LeasedCreativeAction>
  bindInTransaction(client: SqlClient, input: { workspaceId: string; actionKey: string; ownerToken: string; ownerEpoch: number; reservationId: string; jobId: string; eventId: string }): Promise<CreativeActionClaim>
  releaseUnbound(input: { workspaceId: string; actionKey: string; ownerToken: string; ownerEpoch: number }): Promise<CreativeActionClaim>
  get(input: { workspaceId: string; actionKey: string }): Promise<CreativeActionClaim | undefined>
}
const sha256 = /^[0-9a-f]{64}$/u
const rowKey = (workspaceId: string, actionKey: string) => `${workspaceId}\0${actionKey}`
function required(value: string, label: string): string {
  if (!value?.trim() || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`CREATIVE_ACTION_${label}_INVALID`)
  return value
}
function validate(input: { workspaceId: string; actionKey: string; intentSha256: string; leaseMs: number }) {
  const workspaceId = requireWorkspaceScope(input.workspaceId)
  const actionKey = required(input.actionKey, 'KEY')
  if (!sha256.test(input.intentSha256)) throw new Error('CREATIVE_ACTION_INTENT_INVALID')
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 86_400_000) throw new Error('CREATIVE_ACTION_LEASE_INVALID')
  return { workspaceId, actionKey }
}
function failure(current: CreativeActionClaim | undefined, intent: string): CreativeActionClaimError {
  if (current && current.intentSha256 !== intent) return new CreativeActionClaimError('CREATIVE_ACTION_INTENT_MISMATCH', current)
  if (current?.phase === 'bound') return new CreativeActionClaimError('CREATIVE_ACTION_BOUND_RECOVERY_REQUIRED', current)
  return new CreativeActionClaimError('CREATIVE_ACTION_BUSY', current)
}
function owns(current: CreativeActionClaim | undefined, input: { ownerToken: string; ownerEpoch: number }) {
  if (!current || current.phase !== 'leased' || current.ownerToken !== input.ownerToken || current.ownerEpoch !== input.ownerEpoch || Date.parse(current.leaseUntil ?? '') <= Date.now()) throw new CreativeActionClaimError('CREATIVE_ACTION_STALE_OWNER', current)
  return current
}
export class MemoryCreativeActionClaimRepository implements CreativeActionClaimRepository {
  private readonly rows = new Map<string, CreativeActionClaim>()
  async claim(input: { workspaceId: string; actionKey: string; intentSha256: string; leaseMs: number }): Promise<LeasedCreativeAction> {
    const { workspaceId, actionKey } = validate(input)
    const previous = this.rows.get(rowKey(workspaceId, actionKey))
    if (previous && (previous.intentSha256 !== input.intentSha256 || previous.phase === 'bound' || (previous.phase === 'leased' && Date.parse(previous.leaseUntil ?? '') > Date.now()))) throw failure(previous, input.intentSha256)
    const now = Date.now()
    const claim: LeasedCreativeAction = { workspaceId, actionKey, intentSha256: input.intentSha256, phase: 'leased', ownerEpoch: (previous?.ownerEpoch ?? 0) + 1, ownerToken: `creative_action_${randomUUID()}`, leaseUntil: new Date(now + input.leaseMs).toISOString(), updatedAt: new Date(now).toISOString() }
    this.rows.set(rowKey(workspaceId, actionKey), claim)
    return claim
  }
  async bindInTransaction(_client: SqlClient, input: { workspaceId: string; actionKey: string; ownerToken: string; ownerEpoch: number; reservationId: string; jobId: string; eventId: string }): Promise<CreativeActionClaim> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const current = owns(this.rows.get(rowKey(workspaceId, input.actionKey)), input)
    const binding = { reservationId: required(input.reservationId, 'RESERVATION'), jobId: required(input.jobId, 'JOB'), eventId: required(input.eventId, 'EVENT') }
    if ([...this.rows.values()].some(row => row.workspaceId === workspaceId && row.actionKey !== input.actionKey && (row.reservationId === binding.reservationId || row.jobId === binding.jobId || row.eventId === binding.eventId))) throw new CreativeActionClaimError('CREATIVE_ACTION_BINDING_INVALID', current)
    const bound: CreativeActionClaim = { ...current, ...binding, phase: 'bound', ownerToken: undefined, leaseUntil: undefined, updatedAt: new Date().toISOString() }
    this.rows.set(rowKey(workspaceId, input.actionKey), bound)
    return bound
  }
  async releaseUnbound(input: { workspaceId: string; actionKey: string; ownerToken: string; ownerEpoch: number }): Promise<CreativeActionClaim> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const current = owns(this.rows.get(rowKey(workspaceId, input.actionKey)), input)
    const available: CreativeActionClaim = { ...current, phase: 'available', ownerToken: undefined, leaseUntil: undefined, updatedAt: new Date().toISOString() }
    this.rows.set(rowKey(workspaceId, input.actionKey), available)
    return available
  }
  async get(input: { workspaceId: string; actionKey: string }) { return this.rows.get(rowKey(requireWorkspaceScope(input.workspaceId), required(input.actionKey, 'KEY'))) }
}

type Row = { workspace_id: string; action_key: string; intent_sha256: string; phase: CreativeActionPhase; owner_epoch: string | number; owner_token: string | null; lease_until: string | Date | null; reservation_id: string | null; job_id: string | null; event_id: string | null; event_payload_sha256: string | null; updated_at: string | Date }
const projection = 'workspace_id,action_key,intent_sha256,phase,owner_epoch,owner_token,lease_until,reservation_id,job_id,event_id,event_payload_sha256,updated_at'
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
function map(row: Row): CreativeActionClaim {
  return { workspaceId: row.workspace_id, actionKey: row.action_key, intentSha256: row.intent_sha256, phase: row.phase, ownerEpoch: Number(row.owner_epoch), ...(row.owner_token ? { ownerToken: row.owner_token } : {}), ...(row.lease_until ? { leaseUntil: iso(row.lease_until) } : {}), ...(row.reservation_id ? { reservationId: row.reservation_id } : {}), ...(row.job_id ? { jobId: row.job_id } : {}), ...(row.event_id ? { eventId: row.event_id } : {}), ...(row.event_payload_sha256 ? { eventPayloadSha256: row.event_payload_sha256 } : {}), updatedAt: iso(row.updated_at) }
}
export class PostgresCreativeActionClaimRepository implements CreativeActionClaimRepository {
  constructor(private readonly pool: SqlPool) {}
  async claim(input: { workspaceId: string; actionKey: string; intentSha256: string; leaseMs: number }): Promise<LeasedCreativeAction> {
    const { workspaceId, actionKey } = validate(input)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const claimed = await client.query<Row>(`SELECT ${projection} FROM public.claim_creative_point_action($1,$2,$3,$4)`, [workspaceId, actionKey, input.intentSha256, input.leaseMs])
      if (claimed.rows[0]) return map(claimed.rows[0]) as LeasedCreativeAction
      throw failure(await this.getInTransaction(client, workspaceId, actionKey), input.intentSha256)
    })
  }
  async bindInTransaction(client: SqlClient, input: { workspaceId: string; actionKey: string; ownerToken: string; ownerEpoch: number; reservationId: string; jobId: string; eventId: string }): Promise<CreativeActionClaim> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const result = await client.query<Row>(`SELECT ${projection} FROM public.bind_creative_point_action($1,$2,$3,$4,$5,$6,$7)`, [workspaceId, required(input.actionKey, 'KEY'), required(input.ownerToken, 'TOKEN'), input.ownerEpoch, required(input.reservationId, 'RESERVATION'), required(input.jobId, 'JOB'), required(input.eventId, 'EVENT')])
    if (result.rows[0]) return map(result.rows[0])
    owns(await this.getInTransaction(client, workspaceId, input.actionKey), input)
    throw new CreativeActionClaimError('CREATIVE_ACTION_BINDING_INVALID')
  }
  async releaseUnbound(input: { workspaceId: string; actionKey: string; ownerToken: string; ownerEpoch: number }): Promise<CreativeActionClaim> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<Row>(`SELECT ${projection} FROM public.release_unbound_creative_point_action($1,$2,$3,$4)`, [workspaceId, required(input.actionKey, 'KEY'), required(input.ownerToken, 'TOKEN'), input.ownerEpoch])
      if (result.rows[0]) return map(result.rows[0])
      owns(await this.getInTransaction(client, workspaceId, input.actionKey), input)
      throw new CreativeActionClaimError('CREATIVE_ACTION_STALE_OWNER')
    })
  }
  async get(input: { workspaceId: string; actionKey: string }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, client => this.getInTransaction(client, workspaceId, required(input.actionKey, 'KEY')))
  }
  private async getInTransaction(client: SqlClient, workspaceId: string, actionKey: string): Promise<CreativeActionClaim | undefined> {
    const result = await client.query<Row>(`SELECT ${projection} FROM creative_point_action_claims WHERE workspace_id=$1 AND action_key=$2`, [workspaceId, actionKey])
    return result.rows[0] ? map(result.rows[0]) : undefined
  }
}
