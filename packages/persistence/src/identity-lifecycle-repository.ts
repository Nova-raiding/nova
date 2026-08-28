import { randomUUID } from 'node:crypto'
import type { SqlClient, SqlPool } from './repository.js'

export type IdentityAccessStatus = 'active' | 'suspended'
export type IdentityRiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type IdentityRiskDecision = 'allow' | 'step_up' | 'block'
export type AuthSessionKind = 'oidc' | 'api_token'
export type AuthSessionStatus = 'active' | 'revoked' | 'expired'

export interface PlatformIdentity {
  id: string
  issuer: string
  externalSubject: string
  displayName: string
  accessStatus: IdentityAccessStatus
  riskLevel: IdentityRiskLevel
  riskDecision: IdentityRiskDecision
  authEpoch: number
  revision: number
  suspendedAt?: string
  suspendedBy?: string
  suspensionReason?: string
  firstSeenAt: string
  lastSeenAt: string
  createdAt: string
  updatedAt: string
}

export interface PlatformAuthSession {
  id: string
  identityId: string
  sessionKind: AuthSessionKind
  providerSessionHash: string
  status: AuthSessionStatus
  authEpoch: number
  mfaVerified: boolean
  issuedAt: string
  expiresAt?: string
  lastSeenAt: string
  ipHash?: string
  userAgentHash?: string
  revokedAt?: string
  revokedBy?: string
  revokeReason?: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface PlatformIdentityEvent {
  id: string
  identityId: string
  sessionId?: string
  eventType: string
  actorId: string
  reason: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  evidence: Record<string, unknown>
  requestId?: string
  idempotencyKey?: string
  createdAt: string
}

export interface IdentityMembership {
  id: string
  workspaceId: string
  externalSubject: string
  displayName: string
  role: string
  status: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface IdentityOperationsDetail {
  identity: PlatformIdentity
  sessions: PlatformAuthSession[]
  events: PlatformIdentityEvent[]
  memberships: IdentityMembership[]
}

export interface AuthenticatedSessionObservation {
  issuer: string
  externalSubject: string
  displayName?: string
  sessionHash: string
  kind: AuthSessionKind
  issuedAt: string
  expiresAt?: string
  observedAt?: string
  mfaVerified: boolean
  ipHash?: string
  userAgentHash?: string
}

export interface IdentityAuthorizationSnapshot {
  identity: PlatformIdentity
  session: PlatformAuthSession
  allowed: boolean
  denialReason?: 'IDENTITY_SUSPENDED' | 'IDENTITY_RISK_BLOCKED' | 'IDENTITY_STEP_UP_REQUIRED' | 'SESSION_REVOKED' | 'SESSION_EXPIRED' | 'SESSION_AUTH_EPOCH_STALE'
}

export interface IdentityTransitionResult {
  identity: PlatformIdentity
  revokedSessionIds: string[]
  event: PlatformIdentityEvent
  replayed: boolean
}

export interface SessionRevocationResult {
  session: PlatformAuthSession
  event: PlatformIdentityEvent
  replayed: boolean
}

export interface IdentityLifecycleRepository {
  resolve(input: { issuer: string; externalSubject: string }): Promise<PlatformIdentity | undefined>
  observeAuthenticatedSession(input: AuthenticatedSessionObservation): Promise<IdentityAuthorizationSnapshot>
  detailForOperations(identityId: string): Promise<IdentityOperationsDetail>
  transitionAccess(input: { identityId: string; target: IdentityAccessStatus; expectedRevision: number; actorId: string; reason: string; idempotencyKey: string; requestId?: string }): Promise<IdentityTransitionResult>
  transitionRisk(input: { identityId: string; level: IdentityRiskLevel; decision: IdentityRiskDecision; expectedRevision: number; actorId: string; reason: string; evidence?: Record<string, unknown>; idempotencyKey: string; requestId?: string }): Promise<IdentityTransitionResult>
  revokeSession(input: { identityId: string; sessionId: string; expectedRevision: number; actorId: string; reason: string; idempotencyKey: string; requestId?: string }): Promise<SessionRevocationResult>
}

export class IdentityLifecycleError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = 'IdentityLifecycleError' }
}

type Timestamp = string | Date
type IdentityRow = Omit<PlatformIdentity, 'suspendedAt' | 'firstSeenAt' | 'lastSeenAt' | 'createdAt' | 'updatedAt'> & { suspendedAt: Timestamp | null; suspendedBy: string | null; suspensionReason: string | null; firstSeenAt: Timestamp; lastSeenAt: Timestamp; createdAt: Timestamp; updatedAt: Timestamp }
type SessionRow = Omit<PlatformAuthSession, 'expiresAt' | 'lastSeenAt' | 'issuedAt' | 'revokedAt' | 'createdAt' | 'updatedAt'> & { expiresAt: Timestamp | null; issuedAt: Timestamp; lastSeenAt: Timestamp; ipHash: string | null; userAgentHash: string | null; revokedAt: Timestamp | null; revokedBy: string | null; revokeReason: string | null; createdAt: Timestamp; updatedAt: Timestamp }
type EventRow = Omit<PlatformIdentityEvent, 'sessionId' | 'requestId' | 'idempotencyKey' | 'createdAt'> & { sessionId: string | null; requestId: string | null; idempotencyKey: string | null; createdAt: Timestamp }
type MembershipRow = Omit<IdentityMembership, 'createdAt' | 'updatedAt'> & { createdAt: Timestamp; updatedAt: Timestamp }

const iso = (value: Timestamp) => value instanceof Date ? value.toISOString() : String(value)
const optionalIso = (value: Timestamp | null | undefined) => value == null ? undefined : iso(value)
const optional = <T>(value: T | null | undefined) => value == null ? undefined : value
const identityFromRow = (row: IdentityRow): PlatformIdentity => ({ ...row, suspendedAt: optionalIso(row.suspendedAt), suspendedBy: optional(row.suspendedBy), suspensionReason: optional(row.suspensionReason), firstSeenAt: iso(row.firstSeenAt), lastSeenAt: iso(row.lastSeenAt), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) })
const sessionFromRow = (row: SessionRow): PlatformAuthSession => ({ ...row, expiresAt: optionalIso(row.expiresAt), issuedAt: iso(row.issuedAt), lastSeenAt: iso(row.lastSeenAt), ipHash: optional(row.ipHash), userAgentHash: optional(row.userAgentHash), revokedAt: optionalIso(row.revokedAt), revokedBy: optional(row.revokedBy), revokeReason: optional(row.revokeReason), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) })
const eventFromRow = (row: EventRow): PlatformIdentityEvent => ({ ...row, sessionId: optional(row.sessionId), requestId: optional(row.requestId), idempotencyKey: optional(row.idempotencyKey), createdAt: iso(row.createdAt) })
const membershipFromRow = (row: MembershipRow): IdentityMembership => ({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) })

function required(value: string, code: string) { if (!value.trim()) throw new IdentityLifecycleError(code); return value.trim() }
function hash(value: string | undefined, code: string) { if (value !== undefined && !/^[a-f0-9]{64}$/u.test(value)) throw new IdentityLifecycleError(code); return value }
function positiveRevision(value: number) { if (!Number.isInteger(value) || value < 1) throw new IdentityLifecycleError('IDENTITY_REVISION_INVALID') }
function intent(value: Record<string, unknown>) { return JSON.stringify(value) }
function eventIntent(event: PlatformIdentityEvent) { const value = event.evidence.intent; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function identityFromEvent(event: PlatformIdentityEvent) { return event.after as unknown as PlatformIdentity }
function revokedIds(event: PlatformIdentityEvent) { return Array.isArray(event.evidence.revokedSessionIds) ? event.evidence.revokedSessionIds.filter((value): value is string => typeof value === 'string') : [] }

function authorization(identity: PlatformIdentity, session: PlatformAuthSession): Pick<IdentityAuthorizationSnapshot, 'allowed' | 'denialReason'> {
  if (identity.accessStatus === 'suspended') return { allowed: false, denialReason: 'IDENTITY_SUSPENDED' }
  if (identity.riskDecision === 'block') return { allowed: false, denialReason: 'IDENTITY_RISK_BLOCKED' }
  if (identity.riskDecision === 'step_up' && !session.mfaVerified) return { allowed: false, denialReason: 'IDENTITY_STEP_UP_REQUIRED' }
  if (session.status === 'revoked') return { allowed: false, denialReason: 'SESSION_REVOKED' }
  if (session.status === 'expired') return { allowed: false, denialReason: 'SESSION_EXPIRED' }
  if (session.authEpoch !== identity.authEpoch) return { allowed: false, denialReason: 'SESSION_AUTH_EPOCH_STALE' }
  return { allowed: true }
}

function validateObservation(input: AuthenticatedSessionObservation) {
  required(input.issuer, 'IDENTITY_ISSUER_REQUIRED')
  required(input.externalSubject, 'IDENTITY_SUBJECT_REQUIRED')
  hash(input.sessionHash, 'SESSION_HASH_INVALID')
  hash(input.ipHash, 'SESSION_IP_HASH_INVALID')
  hash(input.userAgentHash, 'SESSION_USER_AGENT_HASH_INVALID')
  if (!input.sessionHash) throw new IdentityLifecycleError('SESSION_HASH_REQUIRED')
  if (!Number.isFinite(Date.parse(input.issuedAt)) || (input.expiresAt && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.parse(input.issuedAt)))) throw new IdentityLifecycleError('SESSION_TIME_RANGE_INVALID')
}

export class MemoryIdentityLifecycleRepository implements IdentityLifecycleRepository {
  private readonly identities = new Map<string, PlatformIdentity>()
  private readonly sessions = new Map<string, PlatformAuthSession>()
  private readonly events = new Map<string, PlatformIdentityEvent>()
  private readonly eventKeys = new Map<string, string>()

  async resolve(input: { issuer: string; externalSubject: string }) { return [...this.identities.values()].find(row => row.issuer === input.issuer && row.externalSubject === input.externalSubject) }

  async observeAuthenticatedSession(input: AuthenticatedSessionObservation) {
    validateObservation(input)
    const observedAt = input.observedAt ?? new Date().toISOString()
    let identity = await this.resolve(input)
    if (!identity) {
      identity = { id: randomUUID(), issuer: input.issuer.trim(), externalSubject: input.externalSubject.trim(), displayName: input.displayName ?? '', accessStatus: 'active', riskLevel: 'low', riskDecision: 'allow', authEpoch: 1, revision: 1, firstSeenAt: observedAt, lastSeenAt: observedAt, createdAt: observedAt, updatedAt: observedAt }
    } else {
      identity = { ...identity, ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}), lastSeenAt: observedAt, updatedAt: observedAt }
    }
    this.identities.set(identity.id, identity)
    let session = [...this.sessions.values()].find(row => row.identityId === identity!.id && row.providerSessionHash === input.sessionHash)
    if (!session) {
      session = { id: randomUUID(), identityId: identity.id, sessionKind: input.kind, providerSessionHash: input.sessionHash, status: 'active', authEpoch: identity.authEpoch, mfaVerified: input.mfaVerified, issuedAt: input.issuedAt, expiresAt: input.expiresAt, lastSeenAt: observedAt, ipHash: input.ipHash, userAgentHash: input.userAgentHash, revision: 1, createdAt: observedAt, updatedAt: observedAt }
    } else {
      session = { ...session, mfaVerified: session.mfaVerified || input.mfaVerified, lastSeenAt: observedAt, ipHash: input.ipHash ?? session.ipHash, userAgentHash: input.userAgentHash ?? session.userAgentHash, updatedAt: observedAt }
    }
    if (session.status === 'active' && session.expiresAt && Date.parse(session.expiresAt) <= Date.parse(observedAt)) session = { ...session, status: 'expired', revision: session.revision + 1, updatedAt: observedAt }
    this.sessions.set(session.id, session)
    return { identity, session, ...authorization(identity, session) }
  }

  async detailForOperations(identityId: string) {
    const identity = this.identities.get(identityId)
    if (!identity) throw new IdentityLifecycleError('IDENTITY_NOT_FOUND')
    return { identity, sessions: [...this.sessions.values()].filter(row => row.identityId === identityId).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)), events: [...this.events.values()].filter(row => row.identityId === identityId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), memberships: [] }
  }

  private replay(identityId: string, key: string, expectedIntent: Record<string, unknown>): PlatformIdentityEvent | undefined {
    const eventId = this.eventKeys.get(`${identityId}:${key}`)
    if (!eventId) return undefined
    const event = this.events.get(eventId)!
    if (intent(eventIntent(event)) !== intent(expectedIntent)) throw new IdentityLifecycleError('IDENTITY_IDEMPOTENCY_CONFLICT')
    return event
  }

  private appendEvent(input: Omit<PlatformIdentityEvent, 'id' | 'createdAt'>, createdAt: string) {
    const event = { ...input, id: randomUUID(), createdAt }
    this.events.set(event.id, event)
    if (event.idempotencyKey) this.eventKeys.set(`${event.identityId}:${event.idempotencyKey}`, event.id)
    return event
  }

  async transitionAccess(input: { identityId: string; target: IdentityAccessStatus; expectedRevision: number; actorId: string; reason: string; idempotencyKey: string; requestId?: string }) {
    positiveRevision(input.expectedRevision); required(input.actorId, 'IDENTITY_ACTOR_REQUIRED'); required(input.reason, 'IDENTITY_REASON_REQUIRED'); required(input.idempotencyKey, 'IDENTITY_IDEMPOTENCY_KEY_REQUIRED')
    const expectedIntent = { kind: 'access', target: input.target, expectedRevision: input.expectedRevision, actorId: input.actorId, reason: input.reason }
    const replay = this.replay(input.identityId, input.idempotencyKey, expectedIntent)
    if (replay) return { identity: identityFromEvent(replay), revokedSessionIds: revokedIds(replay), event: replay, replayed: true }
    const before = this.identities.get(input.identityId)
    if (!before) throw new IdentityLifecycleError('IDENTITY_NOT_FOUND')
    if (before.revision !== input.expectedRevision) throw new IdentityLifecycleError('IDENTITY_REVISION_CONFLICT')
    if (before.accessStatus === input.target) throw new IdentityLifecycleError(input.target === 'active' ? 'IDENTITY_ALREADY_ACTIVE' : 'IDENTITY_ALREADY_SUSPENDED')
    const now = new Date().toISOString()
    const identity: PlatformIdentity = input.target === 'suspended'
      ? { ...before, accessStatus: 'suspended', authEpoch: before.authEpoch + 1, revision: before.revision + 1, suspendedAt: now, suspendedBy: input.actorId, suspensionReason: input.reason, updatedAt: now }
      : { ...before, accessStatus: 'active', revision: before.revision + 1, suspendedAt: undefined, suspendedBy: undefined, suspensionReason: undefined, updatedAt: now }
    const revokedSessionIds: string[] = []
    if (input.target === 'suspended') for (const session of this.sessions.values()) if (session.identityId === input.identityId && session.status === 'active') { revokedSessionIds.push(session.id); this.sessions.set(session.id, { ...session, status: 'revoked', revokedAt: now, revokedBy: input.actorId, revokeReason: input.reason, revision: session.revision + 1, updatedAt: now }) }
    const event = this.appendEvent({ identityId: input.identityId, eventType: `identity.${input.target}`, actorId: input.actorId, reason: input.reason, before: before as unknown as Record<string, unknown>, after: identity as unknown as Record<string, unknown>, evidence: { intent: expectedIntent, revokedSessionIds }, requestId: input.requestId, idempotencyKey: input.idempotencyKey }, now)
    this.identities.set(identity.id, identity)
    return { identity, revokedSessionIds, event, replayed: false }
  }

  async transitionRisk(input: { identityId: string; level: IdentityRiskLevel; decision: IdentityRiskDecision; expectedRevision: number; actorId: string; reason: string; evidence?: Record<string, unknown>; idempotencyKey: string; requestId?: string }) {
    positiveRevision(input.expectedRevision); required(input.actorId, 'IDENTITY_ACTOR_REQUIRED'); required(input.reason, 'IDENTITY_REASON_REQUIRED'); required(input.idempotencyKey, 'IDENTITY_IDEMPOTENCY_KEY_REQUIRED')
    const expectedIntent = { kind: 'risk', level: input.level, decision: input.decision, expectedRevision: input.expectedRevision, actorId: input.actorId, reason: input.reason }
    const replay = this.replay(input.identityId, input.idempotencyKey, expectedIntent)
    if (replay) return { identity: identityFromEvent(replay), revokedSessionIds: revokedIds(replay), event: replay, replayed: true }
    const before = this.identities.get(input.identityId)
    if (!before) throw new IdentityLifecycleError('IDENTITY_NOT_FOUND')
    if (before.revision !== input.expectedRevision) throw new IdentityLifecycleError('IDENTITY_REVISION_CONFLICT')
    if (before.riskLevel === input.level && before.riskDecision === input.decision) throw new IdentityLifecycleError('IDENTITY_RISK_ALREADY_SET')
    const now = new Date().toISOString()
    const revoke = input.decision === 'block' || input.decision === 'step_up'
    const identity = { ...before, riskLevel: input.level, riskDecision: input.decision, authEpoch: input.decision === 'block' ? before.authEpoch + 1 : before.authEpoch, revision: before.revision + 1, updatedAt: now }
    const revokedSessionIds: string[] = []
    if (revoke) for (const session of this.sessions.values()) if (session.identityId === input.identityId && session.status === 'active' && (input.decision === 'block' || !session.mfaVerified)) { revokedSessionIds.push(session.id); this.sessions.set(session.id, { ...session, status: 'revoked', revokedAt: now, revokedBy: input.actorId, revokeReason: input.reason, revision: session.revision + 1, updatedAt: now }) }
    const event = this.appendEvent({ identityId: input.identityId, eventType: 'identity.risk.transition', actorId: input.actorId, reason: input.reason, before: before as unknown as Record<string, unknown>, after: identity as unknown as Record<string, unknown>, evidence: { ...(input.evidence ?? {}), intent: expectedIntent, revokedSessionIds }, requestId: input.requestId, idempotencyKey: input.idempotencyKey }, now)
    this.identities.set(identity.id, identity)
    return { identity, revokedSessionIds, event, replayed: false }
  }

  async revokeSession(input: { identityId: string; sessionId: string; expectedRevision: number; actorId: string; reason: string; idempotencyKey: string; requestId?: string }) {
    positiveRevision(input.expectedRevision); required(input.actorId, 'IDENTITY_ACTOR_REQUIRED'); required(input.reason, 'IDENTITY_REASON_REQUIRED'); required(input.idempotencyKey, 'IDENTITY_IDEMPOTENCY_KEY_REQUIRED')
    const expectedIntent = { kind: 'session_revoke', sessionId: input.sessionId, expectedRevision: input.expectedRevision, actorId: input.actorId, reason: input.reason }
    const replay = this.replay(input.identityId, input.idempotencyKey, expectedIntent)
    if (replay) return { session: replay.after as unknown as PlatformAuthSession, event: replay, replayed: true }
    if (!this.identities.has(input.identityId)) throw new IdentityLifecycleError('IDENTITY_NOT_FOUND')
    const before = this.sessions.get(input.sessionId)
    if (!before || before.identityId !== input.identityId) throw new IdentityLifecycleError('SESSION_NOT_FOUND')
    if (before.revision !== input.expectedRevision) throw new IdentityLifecycleError('SESSION_REVISION_CONFLICT')
    if (before.status === 'revoked') throw new IdentityLifecycleError('SESSION_ALREADY_REVOKED')
    const now = new Date().toISOString()
    const session = { ...before, status: 'revoked' as const, revokedAt: now, revokedBy: input.actorId, revokeReason: input.reason, revision: before.revision + 1, updatedAt: now }
    const event = this.appendEvent({ identityId: input.identityId, sessionId: input.sessionId, eventType: 'session.revoked', actorId: input.actorId, reason: input.reason, before: before as unknown as Record<string, unknown>, after: session as unknown as Record<string, unknown>, evidence: { intent: expectedIntent }, requestId: input.requestId, idempotencyKey: input.idempotencyKey }, now)
    this.sessions.set(session.id, session)
    return { session, event, replayed: false }
  }
}

const identityProjection = `id, issuer, external_subject AS "externalSubject", display_name AS "displayName", access_status AS "accessStatus", risk_level AS "riskLevel", risk_decision AS "riskDecision", auth_epoch::float8 AS "authEpoch", revision, suspended_at AS "suspendedAt", suspended_by AS "suspendedBy", suspension_reason AS "suspensionReason", first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt", created_at AS "createdAt", updated_at AS "updatedAt"`
const sessionProjection = `id, identity_id AS "identityId", session_kind AS "sessionKind", provider_session_hash AS "providerSessionHash", status, auth_epoch::float8 AS "authEpoch", mfa_verified AS "mfaVerified", issued_at AS "issuedAt", expires_at AS "expiresAt", last_seen_at AS "lastSeenAt", ip_hash AS "ipHash", user_agent_hash AS "userAgentHash", revoked_at AS "revokedAt", revoked_by AS "revokedBy", revoke_reason AS "revokeReason", revision, created_at AS "createdAt", updated_at AS "updatedAt"`
const eventProjection = `id, identity_id AS "identityId", session_id AS "sessionId", event_type AS "eventType", actor_id AS "actorId", reason, before_json AS "before", after_json AS "after", evidence_json AS "evidence", request_id AS "requestId", idempotency_key AS "idempotencyKey", created_at AS "createdAt"`
const membershipProjection = `id, workspace_id AS "workspaceId", external_subject AS "externalSubject", display_name AS "displayName", role, status, revision, created_at AS "createdAt", updated_at AS "updatedAt"`

async function withIdentityScope<T>(pool: SqlPool, scope: { issuer: string; externalSubject: string } | { platformOps: true }, work: (client: SqlClient) => Promise<T>) {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query('BEGIN')
    if ('platformOps' in scope) await client.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`)
    else {
      await client.query(`SELECT set_config('app.identity_issuer', $1, true)`, [required(scope.issuer, 'IDENTITY_ISSUER_REQUIRED')])
      await client.query(`SELECT set_config('app.identity_subject', $1, true)`, [required(scope.externalSubject, 'IDENTITY_SUBJECT_REQUIRED')])
    }
    const result = await work(client)
    await client.query('COMMIT'); committed = true; return result
  } catch (error) {
    if (!committed) try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
    throw error
  } finally { client.release?.() }
}

export class PostgresIdentityLifecycleRepository implements IdentityLifecycleRepository {
  constructor(private readonly pool: SqlPool) {}

  async resolve(input: { issuer: string; externalSubject: string }) {
    return withIdentityScope(this.pool, input, async client => {
      const result = await client.query<IdentityRow>(`SELECT ${identityProjection} FROM platform_identities WHERE issuer=$1 AND external_subject=$2`, [input.issuer, input.externalSubject])
      return result.rows[0] ? identityFromRow(result.rows[0]) : undefined
    })
  }

  async observeAuthenticatedSession(input: AuthenticatedSessionObservation) {
    validateObservation(input)
    const observedAt = input.observedAt ?? new Date().toISOString()
    return withIdentityScope(this.pool, input, async client => {
      const existingIdentityResult = await client.query<IdentityRow>(`SELECT ${identityProjection} FROM platform_identities WHERE issuer=$1 AND external_subject=$2`, [input.issuer.trim(), input.externalSubject.trim()])
      if (existingIdentityResult.rows[0]) {
        const existingIdentity = identityFromRow(existingIdentityResult.rows[0])
        await client.query(`SELECT set_config('app.identity_id', $1, true)`, [existingIdentity.id])
        const existingSessionResult = await client.query<SessionRow>(`SELECT ${sessionProjection} FROM platform_auth_sessions WHERE identity_id=$1 AND provider_session_hash=$2`, [existingIdentity.id, input.sessionHash])
        if (existingSessionResult.rows[0]) {
          const existingSession = sessionFromRow(existingSessionResult.rows[0])
          const recentlyObserved = Date.parse(observedAt) - Date.parse(existingSession.lastSeenAt) < 60_000
          const sessionStillCurrent = existingSession.status !== 'active' || !existingSession.expiresAt || Date.parse(existingSession.expiresAt) > Date.parse(observedAt)
          const observationUnchanged = (!input.displayName?.trim() || input.displayName.trim() === existingIdentity.displayName) && (!input.mfaVerified || existingSession.mfaVerified) && (!input.ipHash || input.ipHash === existingSession.ipHash) && (!input.userAgentHash || input.userAgentHash === existingSession.userAgentHash)
          if (recentlyObserved && sessionStillCurrent && observationUnchanged) return { identity: existingIdentity, session: existingSession, ...authorization(existingIdentity, existingSession) }
        }
      }
      const identityResult = await client.query<IdentityRow>(`INSERT INTO platform_identities (id, issuer, external_subject, display_name, first_seen_at, last_seen_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5,$5,$5) ON CONFLICT (issuer, external_subject) DO UPDATE SET display_name=CASE WHEN length(btrim(EXCLUDED.display_name)) > 0 THEN EXCLUDED.display_name ELSE platform_identities.display_name END, last_seen_at=GREATEST(platform_identities.last_seen_at, EXCLUDED.last_seen_at), updated_at=GREATEST(platform_identities.updated_at, EXCLUDED.updated_at) RETURNING ${identityProjection}`, [randomUUID(), input.issuer.trim(), input.externalSubject.trim(), input.displayName?.trim() ?? '', observedAt])
      const identity = identityFromRow(identityResult.rows[0]!)
      await client.query(`SELECT set_config('app.identity_id', $1, true)`, [identity.id])
      let sessionResult = await client.query<SessionRow>(`INSERT INTO platform_auth_sessions (id, identity_id, session_kind, provider_session_hash, auth_epoch, mfa_verified, issued_at, expires_at, last_seen_at, ip_hash, user_agent_hash, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$9,$9) ON CONFLICT (identity_id, provider_session_hash) DO UPDATE SET mfa_verified=platform_auth_sessions.mfa_verified OR EXCLUDED.mfa_verified, last_seen_at=GREATEST(platform_auth_sessions.last_seen_at, EXCLUDED.last_seen_at), ip_hash=COALESCE(EXCLUDED.ip_hash, platform_auth_sessions.ip_hash), user_agent_hash=COALESCE(EXCLUDED.user_agent_hash, platform_auth_sessions.user_agent_hash), updated_at=GREATEST(platform_auth_sessions.updated_at, EXCLUDED.updated_at) RETURNING ${sessionProjection}`, [randomUUID(), identity.id, input.kind, input.sessionHash, identity.authEpoch, input.mfaVerified, input.issuedAt, input.expiresAt ?? null, observedAt, input.ipHash ?? null, input.userAgentHash ?? null])
      let session = sessionFromRow(sessionResult.rows[0]!)
      if (session.status === 'active' && session.expiresAt && Date.parse(session.expiresAt) <= Date.parse(observedAt)) {
        sessionResult = await client.query<SessionRow>(`UPDATE platform_auth_sessions SET status='expired', revision=revision+1, updated_at=$2 WHERE id=$1 AND status='active' RETURNING ${sessionProjection}`, [session.id, observedAt])
        if (sessionResult.rows[0]) session = sessionFromRow(sessionResult.rows[0])
      }
      return { identity, session, ...authorization(identity, session) }
    })
  }

  async detailForOperations(identityId: string) {
    return withIdentityScope(this.pool, { platformOps: true }, async client => {
      const identityResult = await client.query<IdentityRow>(`SELECT ${identityProjection} FROM platform_identities WHERE id=$1`, [identityId])
      if (!identityResult.rows[0]) throw new IdentityLifecycleError('IDENTITY_NOT_FOUND')
      const [sessions, events, memberships] = await Promise.all([
        client.query<SessionRow>(`SELECT ${sessionProjection} FROM platform_auth_sessions WHERE identity_id=$1 ORDER BY last_seen_at DESC,id DESC`, [identityId]),
        client.query<EventRow>(`SELECT ${eventProjection} FROM platform_identity_events WHERE identity_id=$1 ORDER BY created_at DESC,id DESC LIMIT 500`, [identityId]),
        client.query<MembershipRow>(`SELECT ${membershipProjection} FROM workspace_members WHERE identity_id=$1 ORDER BY updated_at DESC,id ASC`, [identityId]),
      ])
      return { identity: identityFromRow(identityResult.rows[0]), sessions: sessions.rows.map(sessionFromRow), events: events.rows.map(eventFromRow), memberships: memberships.rows.map(membershipFromRow) }
    })
  }

  private async replay(client: SqlClient, identityId: string, key: string, expectedIntent: Record<string, unknown>) {
    const result = await client.query<EventRow>(`SELECT ${eventProjection} FROM platform_identity_events WHERE identity_id=$1 AND idempotency_key=$2`, [identityId, key])
    if (!result.rows[0]) return undefined
    const event = eventFromRow(result.rows[0])
    if (intent(eventIntent(event)) !== intent(expectedIntent)) throw new IdentityLifecycleError('IDENTITY_IDEMPOTENCY_CONFLICT')
    return event
  }

  private async lockIdentity(client: SqlClient, identityId: string) {
    const result = await client.query<IdentityRow>(`SELECT ${identityProjection} FROM platform_identities WHERE id=$1 FOR UPDATE`, [identityId])
    if (!result.rows[0]) throw new IdentityLifecycleError('IDENTITY_NOT_FOUND')
    return identityFromRow(result.rows[0])
  }

  private async insertEvent(client: SqlClient, input: Omit<PlatformIdentityEvent, 'id' | 'createdAt'>) {
    const result = await client.query<EventRow>(`INSERT INTO platform_identity_events (id, identity_id, session_id, event_type, actor_id, reason, before_json, after_json, evidence_json, request_id, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${eventProjection}`, [randomUUID(), input.identityId, input.sessionId ?? null, input.eventType, input.actorId, input.reason, input.before, input.after, input.evidence, input.requestId ?? null, input.idempotencyKey ?? null])
    return eventFromRow(result.rows[0]!)
  }

  async transitionAccess(input: { identityId: string; target: IdentityAccessStatus; expectedRevision: number; actorId: string; reason: string; idempotencyKey: string; requestId?: string }) {
    positiveRevision(input.expectedRevision); required(input.actorId, 'IDENTITY_ACTOR_REQUIRED'); required(input.reason, 'IDENTITY_REASON_REQUIRED'); required(input.idempotencyKey, 'IDENTITY_IDEMPOTENCY_KEY_REQUIRED')
    const expectedIntent = { kind: 'access', target: input.target, expectedRevision: input.expectedRevision, actorId: input.actorId, reason: input.reason }
    return withIdentityScope(this.pool, { platformOps: true }, async client => {
      const before = await this.lockIdentity(client, input.identityId)
      const replay = await this.replay(client, input.identityId, input.idempotencyKey, expectedIntent)
      if (replay) return { identity: identityFromEvent(replay), revokedSessionIds: revokedIds(replay), event: replay, replayed: true }
      if (before.revision !== input.expectedRevision) throw new IdentityLifecycleError('IDENTITY_REVISION_CONFLICT')
      if (before.accessStatus === input.target) throw new IdentityLifecycleError(input.target === 'active' ? 'IDENTITY_ALREADY_ACTIVE' : 'IDENTITY_ALREADY_SUSPENDED')
      const result = input.target === 'suspended'
        ? await client.query<IdentityRow>(`UPDATE platform_identities SET access_status='suspended', auth_epoch=auth_epoch+1, revision=revision+1, suspended_at=now(), suspended_by=$2, suspension_reason=$3, updated_at=now() WHERE id=$1 AND revision=$4 RETURNING ${identityProjection}`, [input.identityId, input.actorId, input.reason, input.expectedRevision])
        : await client.query<IdentityRow>(`UPDATE platform_identities SET access_status='active', revision=revision+1, suspended_at=NULL, suspended_by=NULL, suspension_reason=NULL, updated_at=now() WHERE id=$1 AND revision=$2 RETURNING ${identityProjection}`, [input.identityId, input.expectedRevision])
      if (!result.rows[0]) throw new IdentityLifecycleError('IDENTITY_REVISION_CONFLICT')
      const identity = identityFromRow(result.rows[0])
      const revoked = input.target === 'suspended' ? await client.query<{ id: string }>(`UPDATE platform_auth_sessions SET status='revoked', revoked_at=now(), revoked_by=$2, revoke_reason=$3, revision=revision+1, updated_at=now() WHERE identity_id=$1 AND status='active' RETURNING id`, [input.identityId, input.actorId, input.reason]) : { rows: [] }
      const revokedSessionIds = revoked.rows.map(row => row.id)
      const event = await this.insertEvent(client, { identityId: input.identityId, eventType: `identity.${input.target}`, actorId: input.actorId, reason: input.reason, before: before as unknown as Record<string, unknown>, after: identity as unknown as Record<string, unknown>, evidence: { intent: expectedIntent, revokedSessionIds }, requestId: input.requestId, idempotencyKey: input.idempotencyKey })
      return { identity, revokedSessionIds, event, replayed: false }
    })
  }

  async transitionRisk(input: { identityId: string; level: IdentityRiskLevel; decision: IdentityRiskDecision; expectedRevision: number; actorId: string; reason: string; evidence?: Record<string, unknown>; idempotencyKey: string; requestId?: string }) {
    positiveRevision(input.expectedRevision); required(input.actorId, 'IDENTITY_ACTOR_REQUIRED'); required(input.reason, 'IDENTITY_REASON_REQUIRED'); required(input.idempotencyKey, 'IDENTITY_IDEMPOTENCY_KEY_REQUIRED')
    const expectedIntent = { kind: 'risk', level: input.level, decision: input.decision, expectedRevision: input.expectedRevision, actorId: input.actorId, reason: input.reason }
    return withIdentityScope(this.pool, { platformOps: true }, async client => {
      const before = await this.lockIdentity(client, input.identityId)
      const replay = await this.replay(client, input.identityId, input.idempotencyKey, expectedIntent)
      if (replay) return { identity: identityFromEvent(replay), revokedSessionIds: revokedIds(replay), event: replay, replayed: true }
      if (before.revision !== input.expectedRevision) throw new IdentityLifecycleError('IDENTITY_REVISION_CONFLICT')
      if (before.riskLevel === input.level && before.riskDecision === input.decision) throw new IdentityLifecycleError('IDENTITY_RISK_ALREADY_SET')
      const result = await client.query<IdentityRow>(`UPDATE platform_identities SET risk_level=$2, risk_decision=$3, auth_epoch=auth_epoch+CASE WHEN $3='block' THEN 1 ELSE 0 END, revision=revision+1, updated_at=now() WHERE id=$1 AND revision=$4 RETURNING ${identityProjection}`, [input.identityId, input.level, input.decision, input.expectedRevision])
      if (!result.rows[0]) throw new IdentityLifecycleError('IDENTITY_REVISION_CONFLICT')
      const identity = identityFromRow(result.rows[0])
      const revoked = input.decision === 'block' || input.decision === 'step_up'
        ? await client.query<{ id: string }>(`UPDATE platform_auth_sessions SET status='revoked', revoked_at=now(), revoked_by=$2, revoke_reason=$3, revision=revision+1, updated_at=now() WHERE identity_id=$1 AND status='active' AND ($4='block' OR mfa_verified=false) RETURNING id`, [input.identityId, input.actorId, input.reason, input.decision])
        : { rows: [] }
      const revokedSessionIds = revoked.rows.map(row => row.id)
      const event = await this.insertEvent(client, { identityId: input.identityId, eventType: 'identity.risk.transition', actorId: input.actorId, reason: input.reason, before: before as unknown as Record<string, unknown>, after: identity as unknown as Record<string, unknown>, evidence: { ...(input.evidence ?? {}), intent: expectedIntent, revokedSessionIds }, requestId: input.requestId, idempotencyKey: input.idempotencyKey })
      return { identity, revokedSessionIds, event, replayed: false }
    })
  }

  async revokeSession(input: { identityId: string; sessionId: string; expectedRevision: number; actorId: string; reason: string; idempotencyKey: string; requestId?: string }) {
    positiveRevision(input.expectedRevision); required(input.actorId, 'IDENTITY_ACTOR_REQUIRED'); required(input.reason, 'IDENTITY_REASON_REQUIRED'); required(input.idempotencyKey, 'IDENTITY_IDEMPOTENCY_KEY_REQUIRED')
    const expectedIntent = { kind: 'session_revoke', sessionId: input.sessionId, expectedRevision: input.expectedRevision, actorId: input.actorId, reason: input.reason }
    return withIdentityScope(this.pool, { platformOps: true }, async client => {
      await this.lockIdentity(client, input.identityId)
      const replay = await this.replay(client, input.identityId, input.idempotencyKey, expectedIntent)
      if (replay) return { session: replay.after as unknown as PlatformAuthSession, event: replay, replayed: true }
      const existing = await client.query<SessionRow>(`SELECT ${sessionProjection} FROM platform_auth_sessions WHERE id=$1 AND identity_id=$2 FOR UPDATE`, [input.sessionId, input.identityId])
      if (!existing.rows[0]) throw new IdentityLifecycleError('SESSION_NOT_FOUND')
      const before = sessionFromRow(existing.rows[0])
      if (before.revision !== input.expectedRevision) throw new IdentityLifecycleError('SESSION_REVISION_CONFLICT')
      if (before.status === 'revoked') throw new IdentityLifecycleError('SESSION_ALREADY_REVOKED')
      const result = await client.query<SessionRow>(`UPDATE platform_auth_sessions SET status='revoked', revoked_at=now(), revoked_by=$3, revoke_reason=$4, revision=revision+1, updated_at=now() WHERE id=$1 AND identity_id=$2 AND revision=$5 RETURNING ${sessionProjection}`, [input.sessionId, input.identityId, input.actorId, input.reason, input.expectedRevision])
      if (!result.rows[0]) throw new IdentityLifecycleError('SESSION_REVISION_CONFLICT')
      const session = sessionFromRow(result.rows[0])
      const event = await this.insertEvent(client, { identityId: input.identityId, sessionId: input.sessionId, eventType: 'session.revoked', actorId: input.actorId, reason: input.reason, before: before as unknown as Record<string, unknown>, after: session as unknown as Record<string, unknown>, evidence: { intent: expectedIntent }, requestId: input.requestId, idempotencyKey: input.idempotencyKey })
      return { session, event, replayed: false }
    })
  }
}
