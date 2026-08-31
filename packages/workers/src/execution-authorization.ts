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
  workspaceId: string
  contextId: string
  contextVersion: string
  policyVersion: string
  grantRevision: string
  scopeHash: string
  capability: CriticalWorkerOperation
  resourceId: string
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

export function createExecutionAuthorizationGuard(
  recheck: WorkerAuthorizationRecheckPort,
  options: { now?: () => number; maxEvidenceAgeMs?: number } = {},
): WorkerExecutionAuthorizationGuard {
  const now = options.now ?? (() => Date.now())
  const maxEvidenceAgeMs = options.maxEvidenceAgeMs ?? 30_000
  return {
    async assertAuthorized(event, operation, signal) {
      signal?.throwIfAborted()
      const snapshot = parseWorkerAuthorizationSnapshot(event, operation)
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

export function createUnavailableExecutionAuthorizationGuard(reason = 'authoritative execution authorization repository is not configured'): WorkerExecutionAuthorizationGuard {
  return createExecutionAuthorizationGuard(async () => {
    throw new WorkerExecutionAuthorizationError('AUTHZ_EXECUTION_RECHECK_UNAVAILABLE', reason, { retryable: true })
  })
}

export function parseWorkerAuthorizationSnapshot(event: DurableOutboxEvent, operation: CriticalWorkerOperation): WorkerAuthorizationSnapshot {
  const raw = event.payload.authorization_snapshot
  if (!isRecord(raw)) throw snapshotError('authorization_snapshot is missing from the durable event envelope')
  const snapshot: WorkerAuthorizationSnapshot = {
    schemaVersion: requireExactInteger(raw.schema_version, 'schema_version', WORKER_AUTHORIZATION_SNAPSHOT_SCHEMA),
    decisionId: requireString(raw.decision_id, 'decision_id'),
    actorId: requireString(raw.actor_id, 'actor_id'),
    workspaceId: requireString(raw.workspace_id, 'workspace_id'),
    contextId: requireString(raw.context_id, 'context_id'),
    contextVersion: requireString(raw.context_version, 'context_version'),
    policyVersion: requireString(raw.policy_version, 'policy_version'),
    grantRevision: requireString(raw.grant_revision, 'grant_revision'),
    scopeHash: requireSha256(raw.scope_hash, 'scope_hash'),
    capability: requireCapability(raw.capability),
    resourceId: requireString(raw.resource_id, 'resource_id'),
    authorized: requireAuthorized(raw.authorized),
    decidedAt: requireTimestamp(raw.decided_at, 'decided_at'),
  }
  if (snapshot.workspaceId !== event.workspaceId) throw snapshotError('authorization snapshot workspace binding mismatch')
  if (snapshot.contextId !== `workspace:${event.workspaceId}`) throw snapshotError('authorization snapshot context binding mismatch')
  if (snapshot.resourceId !== event.aggregateId) throw snapshotError('authorization snapshot resource binding mismatch')
  if (snapshot.capability !== operation) throw snapshotError('authorization snapshot capability binding mismatch')
  return snapshot
}

function validateRecheck(current: WorkerAuthorizationRecheck, snapshot: WorkerAuthorizationSnapshot, event: DurableOutboxEvent, operation: CriticalWorkerOperation, now: number, maxAgeMs: number): void {
  if (!isRecord(current)) throw recheckInvalid('execution authorization recheck returned no evidence')
  const checkedAt = requireRecheckTimestamp(current.checkedAt)
  if (checkedAt > now + 5_000 || now - checkedAt > maxAgeMs) throw recheckInvalid('execution authorization recheck evidence is stale')
  if (current.authorized !== true) throw new WorkerExecutionAuthorizationError('AUTHZ_EXECUTION_RECHECK_DENIED', 'execution authorization was revoked or denied', { retryable: false })
  if (!nonEmpty(current.recheckId) || current.recheckId === snapshot.decisionId) throw recheckInvalid('execution authorization recheck id is invalid')
  if (current.actorId !== snapshot.actorId) throw recheckInvalid('execution authorization actor binding mismatch')
  if (current.workspaceId !== event.workspaceId || current.contextId !== snapshot.contextId) throw recheckInvalid('execution authorization context binding mismatch')
  if (current.capability !== operation || current.resourceId !== event.aggregateId) throw recheckInvalid('execution authorization resource binding mismatch')
  if (!nonEmpty(current.contextVersion) || !nonEmpty(current.policyVersion) || !nonEmpty(current.grantRevision) || current.scopeHash !== snapshot.scopeHash) throw recheckInvalid('execution authorization version or scope evidence is incomplete')
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

function requireRecheckTimestamp(value: unknown): number {
  if (!nonEmpty(value)) throw recheckInvalid('execution authorization checked_at is missing')
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw recheckInvalid('execution authorization checked_at is invalid')
  return parsed
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
