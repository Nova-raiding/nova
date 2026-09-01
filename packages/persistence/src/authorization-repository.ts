import { createHash, randomUUID } from 'node:crypto'
import type { SqlClient, SqlPool } from './repository.js'

export const PLATFORM_ASSIGNED_ROLES = [
  'platform_owner', 'platform_admin', 'ops_admin', 'support_agent', 'finance_ops',
  'security_admin', 'auditor', 'rules_admin', 'model_admin', 'release_admin',
] as const
export type PlatformAssignedRole = typeof PLATFORM_ASSIGNED_ROLES[number]
export type AuthorizationGrantKind = 'temporary' | 'support'
export type AuthorizationGrantMode = 'read' | 'write'

export interface PlatformRoleAssignment {
  id: string
  subjectIdentityId: string
  role: PlatformAssignedRole
  assignedBy: string
  reason: string
  validFrom: string
  expiresAt?: string
  revokedAt?: string
  revokedBy?: string
  revocationReason?: string
  revision: number
  authorizationRevision: number
  createdAt: string
  updatedAt: string
}

export interface AuthorizationGrant {
  id: string
  grantKind: AuthorizationGrantKind
  accessMode: AuthorizationGrantMode
  subjectIdentityId: string
  workspaceId: string
  capabilities: string[]
  resourceScope: Record<string, unknown>
  scopeHash: string
  reason: string
  ticketRef: string
  issuedBy: string
  approvedBy: string
  approvedAt: string
  issuedAt: string
  expiresAt: string
  revokedAt?: string
  revokedBy?: string
  revocationReason?: string
  maxUses: number
  useCount: number
  revision: number
  authorizationRevision: number
  createdAt: string
  updatedAt: string
}

export interface AssignPlatformRoleInput {
  subjectIdentityId: string
  role: PlatformAssignedRole
  assignedBy: string
  reason: string
  expectedAuthorizationRevision: number
  validFrom?: string
  expiresAt?: string
}
export interface RevokePlatformRoleInput { id: string; subjectIdentityId: string; actorId: string; reason: string; expectedRevision: number; expectedAuthorizationRevision: number }
export interface IssueAuthorizationGrantInput {
  grantKind: AuthorizationGrantKind
  accessMode: AuthorizationGrantMode
  subjectIdentityId: string
  workspaceId: string
  capabilities: readonly string[]
  resourceScope: Record<string, unknown>
  reason: string
  ticketRef: string
  issuedBy: string
  approvedBy: string
  approvedAt: string
  expectedAuthorizationRevision: number
  expiresAt: string
  maxUses: number
}
export interface ConsumeAuthorizationGrantInput { id: string; subjectIdentityId: string; workspaceId: string; capability: string; scopeHash: string; expectedRevision: number; actorId: string; reason: string; at?: string }
export interface RevokeAuthorizationGrantInput { id: string; subjectIdentityId: string; actorId: string; reason: string; expectedRevision: number; expectedAuthorizationRevision: number }
export interface AuthorizationExecutionReservation {
  reservationId: string
  eventId: string
  subjectIdentityId: string
  workspaceId: string
  capability: string
  resourceId: string
  scopeHash: string
  authorizationRevision: number
  grantRevision?: number
  reservedAt: string
}
export interface ReserveAuthorizationExecutionInput {
  reservationId: string
  eventId: string
  subjectIdentityId: string
  workspaceId: string
  capability: string
  resourceId: string
  scopeHash: string
  expectedAuthorizationRevision: number
  grantId?: string
  expectedGrantRevision?: number
  at?: string
}

export interface AuthorizationRepository {
  getAuthorizationRevision(subjectIdentityId: string): Promise<number>
  /** Returns the immutable/current grant row even after it is consumed,
   * expired, or revoked so a worker can re-check the exact authority that
   * admitted a durable event. */
  getGrant(id: string, subjectIdentityId: string): Promise<AuthorizationGrant | undefined>
  listActivePlatformRoles(subjectIdentityId: string, at?: string): Promise<PlatformRoleAssignment[]>
  assignPlatformRole(input: AssignPlatformRoleInput): Promise<PlatformRoleAssignment>
  revokePlatformRole(input: RevokePlatformRoleInput): Promise<PlatformRoleAssignment>
  listActiveGrants(subjectIdentityId: string, workspaceId: string, at?: string): Promise<AuthorizationGrant[]>
  issueGrant(input: IssueAuthorizationGrantInput): Promise<AuthorizationGrant>
  consumeGrant(input: ConsumeAuthorizationGrantInput): Promise<AuthorizationGrant | undefined>
  revokeGrant(input: RevokeAuthorizationGrantInput): Promise<AuthorizationGrant>
  /**
   * Atomically reserves the right to cross a worker side-effect boundary.
   * Revoke/role changes advance the subject authorization revision; a stale
   * caller must lose this CAS. Repeating the same reservation is idempotent.
   */
  reserveExecution(input: ReserveAuthorizationExecutionInput): Promise<AuthorizationExecutionReservation | undefined>
}

export type AuthorizationRepositoryErrorCode =
  | 'AUTHORIZATION_REVISION_CONFLICT'
  | 'PLATFORM_ROLE_ASSIGNMENT_CONFLICT'
  | 'PLATFORM_ROLE_ASSIGNMENT_NOT_FOUND'
  | 'PLATFORM_ROLE_ASSIGNMENT_REVISION_CONFLICT'
  | 'AUTHORIZATION_GRANT_CONFLICT'
  | 'AUTHORIZATION_GRANT_NOT_FOUND'
  | 'AUTHORIZATION_GRANT_REVISION_CONFLICT'
  | 'AUTHORIZATION_GRANT_INVALID'
  | 'AUTHORIZATION_EXECUTION_RESERVATION_CONFLICT'
  | 'AUTHORIZATION_EXECUTION_RESERVATION_UNAVAILABLE'

export class AuthorizationRepositoryError extends Error {
  constructor(readonly code: AuthorizationRepositoryErrorCode) { super(code); this.name = 'AuthorizationRepositoryError' }
}

const clone = <T>(value: T): T => structuredClone(value)
const iso = (value: string | Date): string => value instanceof Date ? value.toISOString() : String(value)
const optionalIso = (value: string | Date | null | undefined): string | undefined => value == null ? undefined : iso(value)
const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]))
    : value

export function authorizationScopeHash(scope: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(scope))).digest('hex')
}

const requireText = (value: string, min: number, max: number) => {
  if (value !== value.trim() || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_INVALID')
}
const requireExpectedRevision = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new AuthorizationRepositoryError('AUTHORIZATION_REVISION_CONFLICT')
}
const normalizeGrant = (input: IssueAuthorizationGrantInput, issuedAt: string) => {
  requireExpectedRevision(input.expectedAuthorizationRevision)
  requireText(input.subjectIdentityId, 1, 255); requireText(input.workspaceId, 1, 255); requireText(input.reason, 3, 1000); requireText(input.ticketRef, 1, 255); requireText(input.issuedBy, 1, 255); requireText(input.approvedBy, 1, 255)
  const capabilities = [...new Set(input.capabilities)]
  if (!capabilities.length || capabilities.length > 100 || capabilities.some(value => !value || value !== value.trim())) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_INVALID')
  for (const capability of capabilities) requireText(capability, 1, 255)
  if (!input.resourceScope || Array.isArray(input.resourceScope) || !Object.keys(input.resourceScope).length) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_INVALID')
  if (!Number.isSafeInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > 100) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_INVALID')
  const issued = Date.parse(issuedAt); const approved = Date.parse(input.approvedAt); const expires = Date.parse(input.expiresAt)
  const maxTtl = input.accessMode === 'write' ? 5 * 60_000 : 15 * 60_000
  if (![issued, approved, expires].every(Number.isFinite) || approved > issued || expires <= issued || expires - issued > maxTtl || (input.accessMode === 'write' && input.approvedBy === input.issuedBy)) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_INVALID')
  return { capabilities, resourceScope: clone(input.resourceScope), scopeHash: authorizationScopeHash(input.resourceScope) }
}

export class MemoryAuthorizationRepository implements AuthorizationRepository {
  private readonly revisions = new Map<string, number>()
  private readonly roles = new Map<string, PlatformRoleAssignment>()
  private readonly grants = new Map<string, AuthorizationGrant>()
  private readonly executionReservations = new Map<string, AuthorizationExecutionReservation>()
  constructor(private readonly clock: () => Date = () => new Date()) {}
  private bump(subject: string, expected: number) { requireExpectedRevision(expected); const current = this.revisions.get(subject) ?? 0; if (current !== expected) throw new AuthorizationRepositoryError('AUTHORIZATION_REVISION_CONFLICT'); const next = current + 1; this.revisions.set(subject, next); return next }
  async getAuthorizationRevision(subject: string) { return this.revisions.get(subject) ?? 0 }
  async getGrant(id: string, subject: string) { const row = this.grants.get(id); return row?.subjectIdentityId === subject ? clone(row) : undefined }
  async listActivePlatformRoles(subject: string, at = this.clock().toISOString()) { const time = Date.parse(at); return [...this.roles.values()].filter(row => row.subjectIdentityId === subject && !row.revokedAt && Date.parse(row.validFrom) <= time && (!row.expiresAt || Date.parse(row.expiresAt) > time)).map(clone) }
  async assignPlatformRole(input: AssignPlatformRoleInput) {
    requireText(input.subjectIdentityId, 1, 255); requireText(input.assignedBy, 1, 255); requireText(input.reason, 3, 1000)
    if ([...this.roles.values()].some(row => row.subjectIdentityId === input.subjectIdentityId && row.role === input.role && !row.revokedAt)) throw new AuthorizationRepositoryError('PLATFORM_ROLE_ASSIGNMENT_CONFLICT')
    const now = this.clock().toISOString(); const validFrom = input.validFrom ?? now
    if (!Number.isFinite(Date.parse(validFrom)) || (input.expiresAt && Date.parse(input.expiresAt) <= Date.parse(validFrom))) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_INVALID')
    const authorizationRevision = this.bump(input.subjectIdentityId, input.expectedAuthorizationRevision)
    const row: PlatformRoleAssignment = { id: randomUUID(), subjectIdentityId: input.subjectIdentityId, role: input.role, assignedBy: input.assignedBy, reason: input.reason, validFrom, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}), revision: 1, authorizationRevision, createdAt: now, updatedAt: now }
    this.roles.set(row.id, row); return clone(row)
  }
  async revokePlatformRole(input: RevokePlatformRoleInput) {
    const row = this.roles.get(input.id); if (!row || row.subjectIdentityId !== input.subjectIdentityId || row.revokedAt) throw new AuthorizationRepositoryError('PLATFORM_ROLE_ASSIGNMENT_NOT_FOUND')
    if (row.revision !== input.expectedRevision) throw new AuthorizationRepositoryError('PLATFORM_ROLE_ASSIGNMENT_REVISION_CONFLICT')
    requireText(input.actorId, 1, 255); requireText(input.reason, 3, 1000)
    const now = this.clock().toISOString(); const authorizationRevision = this.bump(input.subjectIdentityId, input.expectedAuthorizationRevision)
    const revoked = { ...row, revokedAt: now, revokedBy: input.actorId, revocationReason: input.reason, revision: row.revision + 1, authorizationRevision, updatedAt: now }
    this.roles.set(row.id, revoked); return clone(revoked)
  }
  async listActiveGrants(subject: string, workspace: string, at = this.clock().toISOString()) { const time = Date.parse(at); return [...this.grants.values()].filter(row => row.subjectIdentityId === subject && row.workspaceId === workspace && !row.revokedAt && Date.parse(row.issuedAt) <= time && Date.parse(row.expiresAt) > time && row.useCount < row.maxUses).map(clone) }
  async issueGrant(input: IssueAuthorizationGrantInput) {
    if ([...this.grants.values()].some(row => row.ticketRef === input.ticketRef)) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_CONFLICT')
    const now = this.clock().toISOString(); const normalized = normalizeGrant(input, now); const authorizationRevision = this.bump(input.subjectIdentityId, input.expectedAuthorizationRevision)
    const row: AuthorizationGrant = { id: randomUUID(), grantKind: input.grantKind, accessMode: input.accessMode, subjectIdentityId: input.subjectIdentityId, workspaceId: input.workspaceId, ...normalized, reason: input.reason, ticketRef: input.ticketRef, issuedBy: input.issuedBy, approvedBy: input.approvedBy, approvedAt: input.approvedAt, issuedAt: now, expiresAt: input.expiresAt, maxUses: input.maxUses, useCount: 0, revision: 1, authorizationRevision, createdAt: now, updatedAt: now }
    this.grants.set(row.id, row); return clone(row)
  }
  async consumeGrant(input: ConsumeAuthorizationGrantInput) {
    const row = this.grants.get(input.id); const at = input.at ?? this.clock().toISOString()
    if (!row || row.subjectIdentityId !== input.subjectIdentityId || row.workspaceId !== input.workspaceId || row.scopeHash !== input.scopeHash || !row.capabilities.includes(input.capability) || row.revokedAt || Date.parse(row.issuedAt) > Date.parse(at) || Date.parse(row.expiresAt) <= Date.parse(at) || row.useCount >= row.maxUses) return undefined
    if (row.revision !== input.expectedRevision) return undefined
    requireText(input.actorId, 1, 255); requireText(input.reason, 3, 1000)
    const currentAuthorizationRevision = this.revisions.get(row.subjectIdentityId) ?? 0
    const authorizationRevision = this.bump(row.subjectIdentityId, currentAuthorizationRevision)
    const consumed = { ...row, useCount: row.useCount + 1, revision: row.revision + 1, authorizationRevision, updatedAt: at }
    this.grants.set(row.id, consumed); return clone(consumed)
  }
  async revokeGrant(input: RevokeAuthorizationGrantInput) {
    const row = this.grants.get(input.id); if (!row || row.subjectIdentityId !== input.subjectIdentityId || row.revokedAt) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_NOT_FOUND')
    if (row.revision !== input.expectedRevision) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_REVISION_CONFLICT')
    requireText(input.actorId, 1, 255); requireText(input.reason, 3, 1000)
    const now = this.clock().toISOString(); const authorizationRevision = this.bump(row.subjectIdentityId, input.expectedAuthorizationRevision)
    const revoked = { ...row, revokedAt: now, revokedBy: input.actorId, revocationReason: input.reason, revision: row.revision + 1, authorizationRevision, updatedAt: now }
    this.grants.set(row.id, revoked); return clone(revoked)
  }
  async reserveExecution(input: ReserveAuthorizationExecutionInput) {
    requireText(input.reservationId, 1, 255); requireText(input.eventId, 1, 255); requireText(input.subjectIdentityId, 1, 255); requireText(input.workspaceId, 1, 255); requireText(input.capability, 1, 255); requireText(input.resourceId, 1, 255); requireExpectedRevision(input.expectedAuthorizationRevision)
    if (!/^[a-f0-9]{64}$/u.test(input.scopeHash)) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_INVALID')
    const existing = this.executionReservations.get(input.reservationId)
    if (existing) {
      const same = existing.eventId === input.eventId && existing.subjectIdentityId === input.subjectIdentityId && existing.workspaceId === input.workspaceId && existing.capability === input.capability && existing.resourceId === input.resourceId && existing.scopeHash === input.scopeHash
      if (!same) throw new AuthorizationRepositoryError('AUTHORIZATION_EXECUTION_RESERVATION_CONFLICT')
      return clone(existing)
    }
    const currentAuthorizationRevision = this.revisions.get(input.subjectIdentityId) ?? 0
    if (currentAuthorizationRevision !== input.expectedAuthorizationRevision) return undefined
    let grantRevision: number | undefined
    if (input.grantId !== undefined) {
      if (!Number.isSafeInteger(input.expectedGrantRevision) || input.expectedGrantRevision! < 1) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_INVALID')
      const grant = this.grants.get(input.grantId)
      // A grant is consumed when the durable event is admitted to the queue.
      // Reservation must bind that admission, rather than consume another use
      // or authorize an event directly from an issued grant.  In particular,
      // useCount === maxUses is valid here: maxUses was enforced by
      // consumeGrant, and this reservation represents that already-consumed
      // queue admission.
      if (!grant || grant.subjectIdentityId !== input.subjectIdentityId || grant.workspaceId !== input.workspaceId || grant.scopeHash !== input.scopeHash || !grant.capabilities.includes(input.capability) || grant.revokedAt || grant.revision !== input.expectedGrantRevision || grant.authorizationRevision !== input.expectedAuthorizationRevision || grant.useCount < 1) return undefined
      const at = input.at ?? this.clock().toISOString()
      if (Date.parse(grant.issuedAt) > Date.parse(at) || Date.parse(grant.expiresAt) <= Date.parse(at)) return undefined
      grantRevision = grant.revision
    } else if (input.expectedGrantRevision !== undefined) {
      throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_INVALID')
    }
    const reservation: AuthorizationExecutionReservation = { reservationId: input.reservationId, eventId: input.eventId, subjectIdentityId: input.subjectIdentityId, workspaceId: input.workspaceId, capability: input.capability, resourceId: input.resourceId, scopeHash: input.scopeHash, authorizationRevision: currentAuthorizationRevision, ...(grantRevision === undefined ? {} : { grantRevision }), reservedAt: input.at ?? this.clock().toISOString() }
    this.executionReservations.set(input.reservationId, reservation)
    return clone(reservation)
  }
}

type RoleRow = { id: string; subjectIdentityId: string; role: PlatformAssignedRole; assignedBy: string; reason: string; validFrom: string | Date; expiresAt: string | Date | null; revokedAt: string | Date | null; revokedBy: string | null; revocationReason: string | null; revision: number; authorizationRevision: number; createdAt: string | Date; updatedAt: string | Date }
type GrantRow = { id: string; grantKind: AuthorizationGrantKind; accessMode: AuthorizationGrantMode; subjectIdentityId: string; workspaceId: string; capabilities: string[]; resourceScope: Record<string, unknown>; scopeHash: string; reason: string; ticketRef: string; issuedBy: string; approvedBy: string; approvedAt: string | Date; issuedAt: string | Date; expiresAt: string | Date; revokedAt: string | Date | null; revokedBy: string | null; revocationReason: string | null; maxUses: number; useCount: number; revision: number; authorizationRevision: number; createdAt: string | Date; updatedAt: string | Date }
type AuthorizationExecutionReservationRow = { reservationId: string; eventId: string; subjectIdentityId: string; workspaceId: string; capability: string; resourceId: string; scopeHash: string; grantId: string | null; authorizationRevision: number; grantRevision: number | null; reservedAt: string | Date }
const roleProjection = `id, subject_identity_id AS "subjectIdentityId", role, assigned_by AS "assignedBy", reason, valid_from AS "validFrom", expires_at AS "expiresAt", revoked_at AS "revokedAt", revoked_by AS "revokedBy", revocation_reason AS "revocationReason", revision, authorization_revision AS "authorizationRevision", created_at AS "createdAt", updated_at AS "updatedAt"`
const grantProjection = `id, grant_kind AS "grantKind", access_mode AS "accessMode", subject_identity_id AS "subjectIdentityId", workspace_id AS "workspaceId", capabilities, resource_scope AS "resourceScope", scope_hash AS "scopeHash", reason, ticket_ref AS "ticketRef", issued_by AS "issuedBy", approved_by AS "approvedBy", approved_at AS "approvedAt", issued_at AS "issuedAt", expires_at AS "expiresAt", revoked_at AS "revokedAt", revoked_by AS "revokedBy", revocation_reason AS "revocationReason", max_uses AS "maxUses", use_count AS "useCount", revision, authorization_revision AS "authorizationRevision", created_at AS "createdAt", updated_at AS "updatedAt"`
const authorizationExecutionReservationProjection = `reservation_id AS "reservationId", event_id AS "eventId", subject_identity_id AS "subjectIdentityId", workspace_id AS "workspaceId", capability, resource_id AS "resourceId", scope_hash AS "scopeHash", grant_id AS "grantId", authorization_revision AS "authorizationRevision", grant_revision AS "grantRevision", reserved_at AS "reservedAt"`
const roleFromRow = (row: RoleRow): PlatformRoleAssignment => {
  const { expiresAt, revokedAt, revokedBy, revocationReason, ...rest } = row
  return { ...rest, validFrom: iso(row.validFrom), ...(optionalIso(expiresAt) ? { expiresAt: optionalIso(expiresAt) } : {}), ...(optionalIso(revokedAt) ? { revokedAt: optionalIso(revokedAt), revokedBy: revokedBy!, revocationReason: revocationReason! } : {}), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }
}
const grantFromRow = (row: GrantRow): AuthorizationGrant => {
  const { revokedAt, revokedBy, revocationReason, ...rest } = row
  return { ...rest, approvedAt: iso(row.approvedAt), issuedAt: iso(row.issuedAt), expiresAt: iso(row.expiresAt), ...(optionalIso(revokedAt) ? { revokedAt: optionalIso(revokedAt), revokedBy: revokedBy!, revocationReason: revocationReason! } : {}), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }
}
const authorizationExecutionReservationFromRow = (row: AuthorizationExecutionReservationRow): AuthorizationExecutionReservation => ({
  reservationId: row.reservationId, eventId: row.eventId, subjectIdentityId: row.subjectIdentityId,
  workspaceId: row.workspaceId, capability: row.capability, resourceId: row.resourceId,
  scopeHash: row.scopeHash, authorizationRevision: Number(row.authorizationRevision),
  ...(row.grantRevision == null ? {} : { grantRevision: Number(row.grantRevision) }), reservedAt: iso(row.reservedAt),
})

export class PostgresAuthorizationRepository implements AuthorizationRepository {
  constructor(private readonly pool: SqlPool, private readonly clock: () => Date = () => new Date()) {}
  private async transaction<T>(work: (client: SqlClient) => Promise<T>, readOnly = false) { const client = await this.pool.connect(); try { await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN'); await client.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`); const result = await work(client); await client.query('COMMIT'); return result } catch (error) { try { await client.query('ROLLBACK') } catch { /* preserve original */ } throw error } finally { client.release?.() } }
  private async bump(client: SqlClient, subject: string, expected: number, actor: string, reason: string) { requireExpectedRevision(expected); await client.query(`INSERT INTO authorization_revisions (subject_identity_id, revision, updated_by, update_reason) VALUES ($1,0,$2,$3) ON CONFLICT (subject_identity_id) DO NOTHING`, [subject, actor, reason]); const result = await client.query<{ revision: number }>(`UPDATE authorization_revisions SET revision=revision+1, updated_by=$3, update_reason=$4, updated_at=now() WHERE subject_identity_id=$1 AND revision=$2 RETURNING revision`, [subject, expected, actor, reason]); if (!result.rows[0]) throw new AuthorizationRepositoryError('AUTHORIZATION_REVISION_CONFLICT'); return Number(result.rows[0].revision) }
  async getAuthorizationRevision(subject: string) { return this.transaction(async client => Number((await client.query<{ revision: number }>('SELECT revision FROM authorization_revisions WHERE subject_identity_id=$1', [subject])).rows[0]?.revision ?? 0), true) }
  async getGrant(id: string, subject: string) { return this.transaction(async client => { const row = (await client.query<GrantRow>(`SELECT ${grantProjection} FROM ops_access_grants WHERE id=$1 AND subject_identity_id=$2`, [id, subject])).rows[0]; return row ? grantFromRow(row) : undefined }, true) }
  async listActivePlatformRoles(subject: string, at = this.clock().toISOString()) { return this.transaction(async client => (await client.query<RoleRow>(`SELECT ${roleProjection} FROM platform_role_assignments WHERE subject_identity_id=$1 AND revoked_at IS NULL AND valid_from <= $2 AND (expires_at IS NULL OR expires_at > $2) ORDER BY role,id`, [subject, at])).rows.map(roleFromRow), true) }
  async assignPlatformRole(input: AssignPlatformRoleInput) { requireText(input.assignedBy, 1, 255); requireText(input.reason, 3, 1000); const now = this.clock().toISOString(); const validFrom = input.validFrom ?? now; return this.transaction(async client => { const authorizationRevision = await this.bump(client, input.subjectIdentityId, input.expectedAuthorizationRevision, input.assignedBy, input.reason); let row: RoleRow | undefined; try { row = (await client.query<RoleRow>(`INSERT INTO platform_role_assignments (id,subject_identity_id,role,assigned_by,reason,valid_from,expires_at,authorization_revision,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING ${roleProjection}`, [randomUUID(), input.subjectIdentityId, input.role, input.assignedBy, input.reason, validFrom, input.expiresAt ?? null, authorizationRevision, now])).rows[0] } catch (error) { if ((error as { code?: string }).code === '23505') throw new AuthorizationRepositoryError('PLATFORM_ROLE_ASSIGNMENT_CONFLICT'); throw error } const value = roleFromRow(row!); await client.query(`INSERT INTO platform_role_assignment_events (id,assignment_id,subject_identity_id,event_type,actor_id,reason,authorization_revision,assignment_revision,snapshot_json,created_at) VALUES ($1,$2,$3,'assigned',$4,$5,$6,$7,$8,$9)`, [randomUUID(), value.id, value.subjectIdentityId, input.assignedBy, input.reason, authorizationRevision, value.revision, value, now]); return value }) }
  async revokePlatformRole(input: RevokePlatformRoleInput) { requireText(input.actorId, 1, 255); requireText(input.reason, 3, 1000); const now = this.clock().toISOString(); return this.transaction(async client => { const existing = (await client.query<RoleRow>(`SELECT ${roleProjection} FROM platform_role_assignments WHERE id=$1 AND subject_identity_id=$2 AND revoked_at IS NULL FOR UPDATE`, [input.id, input.subjectIdentityId])).rows[0]; if (!existing) throw new AuthorizationRepositoryError('PLATFORM_ROLE_ASSIGNMENT_NOT_FOUND'); if (existing.revision !== input.expectedRevision) throw new AuthorizationRepositoryError('PLATFORM_ROLE_ASSIGNMENT_REVISION_CONFLICT'); const authorizationRevision = await this.bump(client, input.subjectIdentityId, input.expectedAuthorizationRevision, input.actorId, input.reason); const row = (await client.query<RoleRow>(`UPDATE platform_role_assignments SET revoked_at=$3,revoked_by=$4,revocation_reason=$5,revision=revision+1,authorization_revision=$6,updated_at=$3 WHERE id=$1 AND subject_identity_id=$2 AND revision=$7 AND revoked_at IS NULL RETURNING ${roleProjection}`, [input.id, input.subjectIdentityId, now, input.actorId, input.reason, authorizationRevision, input.expectedRevision])).rows[0]; if (!row) throw new AuthorizationRepositoryError('PLATFORM_ROLE_ASSIGNMENT_REVISION_CONFLICT'); const value = roleFromRow(row); await client.query(`INSERT INTO platform_role_assignment_events (id,assignment_id,subject_identity_id,event_type,actor_id,reason,authorization_revision,assignment_revision,snapshot_json,created_at) VALUES ($1,$2,$3,'revoked',$4,$5,$6,$7,$8,$9)`, [randomUUID(), value.id, value.subjectIdentityId, input.actorId, input.reason, authorizationRevision, value.revision, value, now]); return value }) }
  async listActiveGrants(subject: string, workspace: string, at = this.clock().toISOString()) { return this.transaction(async client => (await client.query<GrantRow>(`SELECT ${grantProjection} FROM ops_access_grants WHERE subject_identity_id=$1 AND workspace_id=$2 AND revoked_at IS NULL AND issued_at <= $3 AND expires_at > $3 AND use_count < max_uses ORDER BY expires_at,id`, [subject, workspace, at])).rows.map(grantFromRow), true) }
  async issueGrant(input: IssueAuthorizationGrantInput) { const now = this.clock().toISOString(); const normalized = normalizeGrant(input, now); return this.transaction(async client => { const authorizationRevision = await this.bump(client, input.subjectIdentityId, input.expectedAuthorizationRevision, input.issuedBy, input.reason); let row: GrantRow | undefined; try { row = (await client.query<GrantRow>(`INSERT INTO ops_access_grants (id,grant_kind,access_mode,subject_identity_id,workspace_id,capabilities,resource_scope,scope_hash,reason,ticket_ref,issued_by,approved_by,approved_at,issued_at,expires_at,max_uses,authorization_revision,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$14,$14) RETURNING ${grantProjection}`, [randomUUID(), input.grantKind, input.accessMode, input.subjectIdentityId, input.workspaceId, normalized.capabilities, normalized.resourceScope, normalized.scopeHash, input.reason, input.ticketRef, input.issuedBy, input.approvedBy, input.approvedAt, now, input.expiresAt, input.maxUses, authorizationRevision])).rows[0] } catch (error) { if ((error as { code?: string }).code === '23505') throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_CONFLICT'); throw error } const value = grantFromRow(row!); await client.query(`INSERT INTO ops_access_grant_events (id,grant_id,subject_identity_id,workspace_id,event_type,actor_id,reason,authorization_revision,grant_revision,snapshot_json,created_at) VALUES ($1,$2,$3,$4,'issued',$5,$6,$7,$8,$9,$10)`, [randomUUID(), value.id, value.subjectIdentityId, value.workspaceId, input.issuedBy, input.reason, authorizationRevision, value.revision, value, now]); return value }) }
  async consumeGrant(input: ConsumeAuthorizationGrantInput) { requireText(input.actorId, 1, 255); requireText(input.reason, 3, 1000); const at = input.at ?? this.clock().toISOString(); return this.transaction(async client => { const row = (await client.query<GrantRow>(`UPDATE ops_access_grants SET use_count=use_count+1,revision=revision+1,updated_at=$7 WHERE id=$1 AND subject_identity_id=$2 AND workspace_id=$3 AND $4=ANY(capabilities) AND scope_hash=$5 AND revision=$6 AND revoked_at IS NULL AND issued_at <= $7 AND expires_at > $7 AND use_count < max_uses RETURNING ${grantProjection}`, [input.id, input.subjectIdentityId, input.workspaceId, input.capability, input.scopeHash, input.expectedRevision, at])).rows[0]; if (!row) return undefined; const current = Number((await client.query<{ revision: number }>('SELECT revision FROM authorization_revisions WHERE subject_identity_id=$1 FOR UPDATE', [input.subjectIdentityId])).rows[0]?.revision ?? 0); const authorizationRevision = await this.bump(client, input.subjectIdentityId, current, input.actorId, input.reason); const updated = (await client.query<GrantRow>(`UPDATE ops_access_grants SET authorization_revision=$2 WHERE id=$1 RETURNING ${grantProjection}`, [input.id, authorizationRevision])).rows[0]!; const value = grantFromRow(updated); await client.query(`INSERT INTO ops_access_grant_events (id,grant_id,subject_identity_id,workspace_id,event_type,actor_id,reason,authorization_revision,grant_revision,snapshot_json,created_at) VALUES ($1,$2,$3,$4,'used',$5,$6,$7,$8,$9,$10)`, [randomUUID(), value.id, value.subjectIdentityId, value.workspaceId, input.actorId, input.reason, authorizationRevision, value.revision, value, at]); return value }) }
  async revokeGrant(input: RevokeAuthorizationGrantInput) { requireText(input.actorId, 1, 255); requireText(input.reason, 3, 1000); const now = this.clock().toISOString(); return this.transaction(async client => { const existing = (await client.query<GrantRow>(`SELECT ${grantProjection} FROM ops_access_grants WHERE id=$1 AND subject_identity_id=$2 AND revoked_at IS NULL FOR UPDATE`, [input.id, input.subjectIdentityId])).rows[0]; if (!existing) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_NOT_FOUND'); if (existing.revision !== input.expectedRevision) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_REVISION_CONFLICT'); const authorizationRevision = await this.bump(client, input.subjectIdentityId, input.expectedAuthorizationRevision, input.actorId, input.reason); const row = (await client.query<GrantRow>(`UPDATE ops_access_grants SET revoked_at=$3,revoked_by=$4,revocation_reason=$5,revision=revision+1,authorization_revision=$6,updated_at=$3 WHERE id=$1 AND subject_identity_id=$2 AND revision=$7 AND revoked_at IS NULL RETURNING ${grantProjection}`, [input.id, input.subjectIdentityId, now, input.actorId, input.reason, authorizationRevision, input.expectedRevision])).rows[0]; if (!row) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_REVISION_CONFLICT'); const value = grantFromRow(row); await client.query(`INSERT INTO ops_access_grant_events (id,grant_id,subject_identity_id,workspace_id,event_type,actor_id,reason,authorization_revision,grant_revision,snapshot_json,created_at) VALUES ($1,$2,$3,$4,'revoked',$5,$6,$7,$8,$9,$10)`, [randomUUID(), value.id, value.subjectIdentityId, value.workspaceId, input.actorId, input.reason, authorizationRevision, value.revision, value, now]); return value }) }
  async reserveExecution(input: ReserveAuthorizationExecutionInput): Promise<AuthorizationExecutionReservation | undefined> {
    requireText(input.reservationId, 1, 255); requireText(input.eventId, 1, 255); requireText(input.subjectIdentityId, 1, 255); requireText(input.workspaceId, 1, 255); requireText(input.capability, 1, 255); requireText(input.resourceId, 1, 255); requireExpectedRevision(input.expectedAuthorizationRevision)
    if (!/^[a-f0-9]{64}$/u.test(input.scopeHash)) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_INVALID')
    if (input.grantId !== undefined && (!Number.isSafeInteger(input.expectedGrantRevision) || input.expectedGrantRevision! < 1)) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_INVALID')
    if (input.grantId === undefined && input.expectedGrantRevision !== undefined) throw new AuthorizationRepositoryError('AUTHORIZATION_GRANT_INVALID')
    const at = input.at ?? this.clock().toISOString()
    return this.transaction(async client => {
      // Reservations are immutable after insertion. The unique reservation
      // and event constraints on INSERT are the concurrency fence; reading
      // an existing row must remain plain SELECT because the control-plane
      // role intentionally has no UPDATE privilege on this append-only table.
      const loadExisting = () => client.query<AuthorizationExecutionReservationRow>(`SELECT ${authorizationExecutionReservationProjection} FROM authorization_execution_reservations WHERE reservation_id=$1 OR event_id=$2`, [input.reservationId, input.eventId])
      const assertSameReservation = (existing: AuthorizationExecutionReservationRow) => {
        const same = existing.reservationId === input.reservationId && existing.eventId === input.eventId && existing.subjectIdentityId === input.subjectIdentityId && existing.workspaceId === input.workspaceId && existing.capability === input.capability && existing.resourceId === input.resourceId && existing.scopeHash === input.scopeHash && (existing.grantId ?? undefined) === input.grantId && Number(existing.authorizationRevision) === input.expectedAuthorizationRevision && (existing.grantRevision == null ? undefined : Number(existing.grantRevision)) === input.expectedGrantRevision
        if (!same) throw new AuthorizationRepositoryError('AUTHORIZATION_EXECUTION_RESERVATION_CONFLICT')
        return authorizationExecutionReservationFromRow(existing)
      }
      // Idempotent replay must succeed even after the grant has subsequently
      // been revoked; the reservation is the immutable result of the earlier
      // authorization decision.
      const alreadyReserved = (await loadExisting()).rows[0]
      if (alreadyReserved) return assertSameReservation(alreadyReserved)
      // Match revokeGrant/consumeGrant's lock order so revoke and reserve
      // serialize on the same grant → subject-revision resources.
      const grant = input.grantId === undefined ? undefined : (await client.query<GrantRow>(`SELECT ${grantProjection} FROM ops_access_grants WHERE id=$1 AND subject_identity_id=$2 FOR UPDATE`, [input.grantId, input.subjectIdentityId])).rows[0]
      const revisionRow = (await client.query<{ revision: number }>('SELECT revision FROM authorization_revisions WHERE subject_identity_id=$1 FOR UPDATE', [input.subjectIdentityId])).rows[0]
      const authorizationRevision = Number(revisionRow?.revision ?? 0)
      if (authorizationRevision !== input.expectedAuthorizationRevision) return undefined
      // The enqueue transaction must have consumed the grant before this
      // execution reservation can be created.  Do not re-check maxUses here:
      // a consumed maxUses=1 grant is the expected legal case.
      if (input.grantId !== undefined && (!grant || grant.workspaceId !== input.workspaceId || !grant.capabilities.includes(input.capability) || grant.scopeHash !== input.scopeHash || grant.revokedAt || Number(grant.revision) !== input.expectedGrantRevision || Number(grant.authorizationRevision) !== input.expectedAuthorizationRevision || Number(grant.useCount) < 1 || Date.parse(String(grant.issuedAt)) > Date.parse(at) || Date.parse(String(grant.expiresAt)) <= Date.parse(at))) return undefined
      const grantRevision = grant?.revision
      const values = [input.reservationId, input.eventId, input.subjectIdentityId, input.workspaceId, input.capability, input.resourceId, input.scopeHash, input.grantId ?? null, authorizationRevision, grantRevision ?? null, at]
      const inserted = (await client.query<AuthorizationExecutionReservationRow>(`INSERT INTO authorization_execution_reservations (reservation_id,event_id,subject_identity_id,workspace_id,capability,resource_id,scope_hash,grant_id,authorization_revision,grant_revision,reserved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING ${authorizationExecutionReservationProjection}`, values)).rows[0]
      if (inserted) return authorizationExecutionReservationFromRow(inserted)
      const existing = (await loadExisting()).rows[0]
      if (!existing) throw new AuthorizationRepositoryError('AUTHORIZATION_EXECUTION_RESERVATION_CONFLICT')
      return assertSameReservation(existing)
    })
  }
}
