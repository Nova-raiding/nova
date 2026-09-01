import type { DurableOutboxEvent } from './durable.js'

export const WORKER_AUTHORIZATION_SNAPSHOT_SCHEMA = 1 as const

export type CriticalWorkerOperation =
  | 'publish.execute'
  | 'publish.reconcile'
  | 'generation.execute'
  | 'image_generation.execute'
  | 'catalog.sync.execute'
  | 'asset.scan.execute'
  | 'asset.continuation.execute'

export interface WorkerAuthorizationSnapshot {
  schemaVersion: typeof WORKER_AUTHORIZATION_SNAPSHOT_SCHEMA
  decisionId: string
  actorId: string
  identityId?: string
  workspaceId: string
  workbench?: 'workspace'
  contextId: string
  contextVersion: string
  policyVersion: string
  grantRevision: string
  grantIds?: string[]
  scopeHash: string
  capability: CriticalWorkerOperation
  resourceId: string
  resourceRevision?: string
  requestId?: string
  traceId?: string
  authorized: true
  decidedAt: string
}

export interface WorkerAuthorizationRecheck extends Omit<WorkerAuthorizationSnapshot, 'schemaVersion' | 'decisionId' | 'decidedAt' | 'authorized'> {
  recheckId: string
  authorized: boolean
  checkedAt: string
}

export interface WorkerExecutionAuthorizationGuard {
  assertAuthorized(event: DurableOutboxEvent, operation: CriticalWorkerOperation, signal?: AbortSignal): Promise<WorkerAuthorizationRecheck>
}

export type AuthorizedWorkerProviderCall<T> = (authorization: WorkerAuthorizationRecheck, signal?: AbortSignal) => Promise<T>

/**
 * The last in-process boundary before a worker is allowed to invoke an
 * external system. Implementations must persist the reservation; an in-memory
 * implementation is only suitable for unit tests.
 */
export interface WorkerExecutionReservation {
  reservationId: string
  eventId: string
  workspaceId: string
  operation: CriticalWorkerOperation
  reservedAt: string
}

export type WorkerExecutionReservationPort = (input: {
  reservationId: string
  event: DurableOutboxEvent
  operation: CriticalWorkerOperation
  snapshot: WorkerAuthorizationSnapshot
  recheck: WorkerAuthorizationRecheck
  signal?: AbortSignal
}) => Promise<WorkerExecutionReservation | undefined>

export interface ReservedWorkerExecution {
  reservation: WorkerExecutionReservation
  authorization: WorkerAuthorizationRecheck
}

export type WorkerAuthorizationRecheckPort = (input: {
  event: DurableOutboxEvent
  operation: CriticalWorkerOperation
  snapshot: WorkerAuthorizationSnapshot
  signal?: AbortSignal
}) => Promise<WorkerAuthorizationRecheck>

export class WorkerExecutionAuthorizationError extends Error {
  readonly retryable: boolean
  readonly unknown = false
  constructor(readonly code: string, message: string, options: { retryable: boolean }) {
    super(message)
    this.name = 'WorkerExecutionAuthorizationError'
    this.retryable = options.retryable
  }
}

/**
 * Compose the authoritative recheck and the durable reservation gate. This
 * helper deliberately owns no side effect: callers must invoke their
 * connector only after `reserve` resolves. Keeping that ordering in one
 * small port makes it testable without editing a shared worker handler.
 */
export function createReservedExecutionGate(
  guard: WorkerExecutionAuthorizationGuard,
  reserve: WorkerExecutionReservationPort,
): (event: DurableOutboxEvent, operation: CriticalWorkerOperation, signal?: AbortSignal) => Promise<ReservedWorkerExecution> {
  return async (event, operation, signal) => {
    const authorization = await guard.assertAuthorized(event, operation, signal)
    const snapshot = parseWorkerAuthorizationSnapshot(event, operation)
    const reservationId = `worker-execution:${operation}:${event.id}`
    let reservation: WorkerExecutionReservation | undefined
    try {
      reservation = await reserve({ reservationId, event, operation, snapshot, recheck: authorization, ...(signal ? { signal } : {}) })
    } catch (cause) {
      if (signal?.aborted) signal.throwIfAborted()
      if (cause instanceof WorkerExecutionAuthorizationError) throw cause
      const code = isRecord(cause) && typeof cause.code === 'string' ? cause.code : 'AUTHZ_EXECUTION_RESERVATION_UNAVAILABLE'
      const retryable = isRecord(cause) && typeof cause.retryable === 'boolean' ? cause.retryable : true
      throw new WorkerExecutionAuthorizationError(code, `execution authorization reservation unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, { retryable })
    }
    signal?.throwIfAborted()
    if (!reservation) throw new WorkerExecutionAuthorizationError('AUTHZ_EXECUTION_RESERVATION_CONFLICT', 'execution authorization reservation was not granted; no external side effect is permitted', { retryable: false })
    if (reservation.reservationId !== reservationId || reservation.eventId !== event.id || reservation.workspaceId !== event.workspaceId || reservation.operation !== operation) {
      throw new WorkerExecutionAuthorizationError('AUTHZ_EXECUTION_RESERVATION_INVALID', 'execution authorization reservation binding mismatch', { retryable: false })
    }
    return { reservation, authorization }
  }
}

export function createExecutionAuthorizationGuard(
  recheck: WorkerAuthorizationRecheckPort,
  options: { now?: () => number; maxEvidenceAgeMs?: number } = {},
): WorkerExecutionAuthorizationGuard {
  const now = options.now ?? (() => Date.now())
  const maxEvidenceAgeMs = options.maxEvidenceAgeMs ?? 30_000
  if (!Number.isFinite(maxEvidenceAgeMs) || maxEvidenceAgeMs <= 0) throw new RangeError('maxEvidenceAgeMs must be a positive finite number')
  return {
    async assertAuthorized(event, operation, signal) {
      signal?.throwIfAborted()
      const snapshot = parseWorkerAuthorizationSnapshot(event, operation)
      validateSnapshotFreshness(snapshot, now(), maxEvidenceAgeMs)
      let current: WorkerAuthorizationRecheck
      try {
        current = await recheck({ event, operation, snapshot, ...(signal ? { signal } : {}) })
      } catch (cause) {
        if (signal?.aborted) signal.throwIfAborted()
        if (cause instanceof WorkerExecutionAuthorizationError) throw cause
        throw new WorkerExecutionAuthorizationError(
          'AUTHZ_EXECUTION_RECHECK_UNAVAILABLE',
          `execution authorization authority unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
          { retryable: true },
        )
      }
      signal?.throwIfAborted()
      validateRecheck(current, snapshot, event, operation, now(), maxEvidenceAgeMs)
      return current
    },
  }
}

export function createUnavailableExecutionAuthorizationGuard(reason = 'authoritative execution authorization repository is not configured', options: { now?: () => number; maxEvidenceAgeMs?: number } = {}): WorkerExecutionAuthorizationGuard {
  return createExecutionAuthorizationGuard(async () => {
    throw new WorkerExecutionAuthorizationError('AUTHZ_EXECUTION_RECHECK_UNAVAILABLE', reason, { retryable: true })
  }, options)
}

/**
 * The execution-check boundary for queued work. A durable event may have been
 * authorized when it was queued, but the grant, scope, or resource revision
 * can change before a worker handles it. Keep the provider callback inside
 * this helper so callers cannot accidentally invoke it before the fresh
 * authoritative check has completed.
 */
export async function executeAfterAuthorizationCheck<T>(input: {
  guard: WorkerExecutionAuthorizationGuard
  event: DurableOutboxEvent
  operation: CriticalWorkerOperation
  providerCall: AuthorizedWorkerProviderCall<T>
  signal?: AbortSignal
}): Promise<T> {
  const authorization = await input.guard.assertAuthorized(input.event, input.operation, input.signal)
  input.signal?.throwIfAborted()
  return input.providerCall(authorization, input.signal)
}

export function parseWorkerAuthorizationSnapshot(event: DurableOutboxEvent, operation: CriticalWorkerOperation): WorkerAuthorizationSnapshot {
  const raw = event.payload.authorization_snapshot
  if (!isRecord(raw)) throw snapshotError('authorization_snapshot is missing from the durable event envelope')
  const snapshot: WorkerAuthorizationSnapshot = {
    schemaVersion: requireExactInteger(raw.schema_version, 'schema_version', WORKER_AUTHORIZATION_SNAPSHOT_SCHEMA),
    decisionId: requireString(raw.decision_id, 'decision_id'),
    actorId: requireString(raw.actor_id, 'actor_id'),
    identityId: requireString(raw.identity_id, 'identity_id'),
    workspaceId: requireString(raw.workspace_id, 'workspace_id'),
    workbench: requireWorkbench(raw.workbench),
    contextId: requireString(raw.context_id, 'context_id'),
    contextVersion: requireString(raw.context_version, 'context_version'),
    policyVersion: requireString(raw.policy_version, 'policy_version'),
    grantRevision: requireString(raw.grant_revision, 'grant_revision'),
    grantIds: requireStringArray(raw.grant_ids, 'grant_ids'),
    scopeHash: requireSha256(raw.scope_hash, 'scope_hash'),
    capability: requireCapability(raw.capability),
    resourceId: requireString(raw.resource_id, 'resource_id'),
    resourceRevision: requireString(raw.resource_revision, 'resource_revision'),
    requestId: requireString(raw.request_id, 'request_id'),
    traceId: requireString(raw.trace_id, 'trace_id'),
    authorized: requireAuthorized(raw.authorized),
    decidedAt: requireTimestamp(raw.decided_at, 'decided_at'),
  }
  if (snapshot.workspaceId !== event.workspaceId) throw snapshotError('authorization snapshot workspace binding mismatch')
  if (snapshot.contextId !== `workspace:${event.workspaceId}`) throw snapshotError('authorization snapshot context binding mismatch')
  if (snapshot.resourceId !== event.aggregateId) throw snapshotError('authorization snapshot resource binding mismatch')
  if (snapshot.capability !== operation) throw snapshotError('authorization snapshot capability binding mismatch')
  if (snapshot.workbench !== 'workspace') throw snapshotError('authorization snapshot workbench binding mismatch')
  return snapshot
}

function validateRecheck(current: WorkerAuthorizationRecheck, snapshot: WorkerAuthorizationSnapshot, event: DurableOutboxEvent, operation: CriticalWorkerOperation, now: number, maxAgeMs: number): void {
  if (!isRecord(current)) throw recheckInvalid('execution authorization recheck returned no evidence')
  const checkedAt = requireRecheckTimestamp(current.checkedAt)
  if (checkedAt > now + 5_000 || now - checkedAt > maxAgeMs) throw recheckInvalid('execution authorization recheck evidence is stale')
  if (current.authorized !== true) throw new WorkerExecutionAuthorizationError('AUTHZ_EXECUTION_RECHECK_DENIED', 'execution authorization was revoked or denied', { retryable: false })
  if (!nonEmpty(current.recheckId) || current.recheckId === snapshot.decisionId) throw recheckInvalid('execution authorization recheck id is invalid')
  if (current.actorId !== snapshot.actorId) throw recheckInvalid('execution authorization actor binding mismatch')
  if (current.identityId !== snapshot.identityId || current.workspaceId !== event.workspaceId || current.contextId !== snapshot.contextId || current.workbench !== snapshot.workbench) throw recheckInvalid('execution authorization context binding mismatch')
  if (current.capability !== operation || current.capability !== snapshot.capability || current.resourceId !== event.aggregateId || current.resourceId !== snapshot.resourceId) throw recheckInvalid('execution authorization resource binding mismatch')
  if (!nonEmpty(current.contextVersion) || !nonEmpty(current.policyVersion) || !nonEmpty(current.grantRevision) || !nonEmpty(current.identityId) || current.workbench !== 'workspace' || current.scopeHash !== snapshot.scopeHash || current.resourceRevision !== snapshot.resourceRevision || current.requestId !== snapshot.requestId || current.traceId !== snapshot.traceId || !Array.isArray(current.grantIds) || current.grantIds.join(',') !== snapshot.grantIds?.join(',')) throw recheckInvalid('execution authorization version or scope evidence is incomplete')
}

function validateSnapshotFreshness(snapshot: WorkerAuthorizationSnapshot, now: number, maxAgeMs: number): void {
  const decidedAt = Date.parse(snapshot.decidedAt)
  if (decidedAt > now + 5_000 || now - decidedAt > maxAgeMs) throw snapshotError('authorization snapshot evidence is stale')
}

function snapshotError(message: string) {
  return new WorkerExecutionAuthorizationError('AUTHZ_EXECUTION_SNAPSHOT_INVALID', message, { retryable: false })
}

function recheckInvalid(message: string) {
  return new WorkerExecutionAuthorizationError('AUTHZ_EXECUTION_RECHECK_INVALID', message, { retryable: true })
}

function requireString(value: unknown, field: string): string {
  if (!nonEmpty(value)) throw snapshotError(`authorization snapshot ${field} is missing`)
  return value
}

function requireTimestamp(value: unknown, field: string): string {
  const normalized = requireString(value, field)
  if (!Number.isFinite(Date.parse(normalized))) throw snapshotError(`authorization snapshot ${field} is invalid`)
  return normalized
}

function requireSha256(value: unknown, field: string): string {
  const normalized = requireString(value, field)
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw snapshotError(`authorization snapshot ${field} is invalid`)
  return normalized
}

function requireExactInteger<T extends number>(value: unknown, field: string, expected: T): T {
  if (value !== expected) throw snapshotError(`authorization snapshot ${field} is unsupported`)
  return expected
}

function requireCapability(value: unknown): CriticalWorkerOperation {
  if (!['publish.execute', 'publish.reconcile', 'generation.execute', 'image_generation.execute', 'catalog.sync.execute', 'asset.scan.execute', 'asset.continuation.execute'].includes(String(value))) {
    throw snapshotError('authorization snapshot capability is unsupported')
  }
  return value as CriticalWorkerOperation
}

function requireAuthorized(value: unknown): true {
  if (value !== true) throw snapshotError('authorization snapshot does not contain an allow decision')
  return true
}

function requireWorkbench(value: unknown): 'workspace' {
  if (value !== 'workspace') throw snapshotError('authorization snapshot workbench is unsupported')
  return 'workspace'
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => !nonEmpty(item))) throw snapshotError(`authorization snapshot ${field} is invalid`)
  return [...value]
}

function requireRecheckTimestamp(value: unknown): number {
  if (!nonEmpty(value)) throw recheckInvalid('execution authorization checked_at is missing')
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw recheckInvalid('execution authorization checked_at is invalid')
  return parsed
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
