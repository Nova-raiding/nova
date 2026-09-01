import type { DurableOutboxEvent } from './durable.js'
import type { CriticalWorkerOperation } from './execution-authorization.js'
import type { WorkerError } from './types.js'

export const WORKER_COMMERCIAL_ACCESS_SNAPSHOT_SCHEMA = 1 as const

export type WorkerCommercialAccessMode = 'POINT_CHARGED' | 'POINT_REQUIRED_NO_CHARGE'
export type WorkerCommercialBalanceState = 'known'

export interface WorkerCommercialAccessSnapshot {
  schemaVersion: typeof WORKER_COMMERCIAL_ACCESS_SNAPSHOT_SCHEMA
  decisionId: string
  workspaceId: string
  operation: CriticalWorkerOperation
  accessMode: WorkerCommercialAccessMode
  accessRevision: string
  balanceState: WorkerCommercialBalanceState
  entitlementSnapshotId: string
  entitlementSnapshotChecksum: string
  rateVersion: string | null
  quotedPoints: number
  reservationId?: string
  decidedAt: string
}

export interface WorkerCommercialAccessRecheck extends Omit<WorkerCommercialAccessSnapshot, 'schemaVersion' | 'decisionId' | 'decidedAt'> {
  recheckId: string
  allowed: boolean
  ready: boolean
  reservationState: 'active' | 'not_required' | 'consumed' | 'released' | 'expired'
  checkedAt: string
}

export type WorkerCommercialAccessRecheckPort = (input: {
  event: DurableOutboxEvent
  operation: CriticalWorkerOperation
  snapshot: WorkerCommercialAccessSnapshot
  signal?: AbortSignal
}) => Promise<WorkerCommercialAccessRecheck>

export interface WorkerCommercialAccessGuard {
  assertCommercialAccess(event: DurableOutboxEvent, operation: CriticalWorkerOperation, signal?: AbortSignal): Promise<WorkerCommercialAccessRecheck>
}

export class WorkerCommercialAccessError extends Error {
  readonly unknown = false
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message)
    this.name = 'WorkerCommercialAccessError'
  }
}

const COMMERCIAL_RETRYABLE_CODES = new Set([
  'COMMERCIAL_EXECUTION_RECHECK_UNAVAILABLE',
  'COMMERCIAL_EXECUTION_NOT_READY',
])

/**
 * Converts an authority result into the only retry semantics safe at the
 * durable boundary. A caller-supplied retryable bit is not trusted: access,
 * quote, revision, reservation and scope changes must not replay a charge or
 * external side effect. Unknown outcomes require manual reconciliation.
 */
export function normalizeCommercialAccessFailure(error: unknown): WorkerError {
  const candidate = error as { code?: unknown; message?: unknown; unknown?: unknown } | undefined
  const code = typeof candidate?.code === 'string' && /^COMMERCIAL_EXECUTION_[A-Z0-9_]{2,63}$/u.test(candidate.code)
    ? candidate.code
    : 'COMMERCIAL_EXECUTION_RECHECK_UNAVAILABLE'
  const unknown = candidate?.unknown === true
  const message = typeof candidate?.message === 'string' && candidate.message.trim()
    ? candidate.message.replace(/[\u0000-\u001F\u007F]/gu, ' ').slice(0, 512)
    : 'worker commercial access recheck failed'
  return { code, message, retryable: !unknown && COMMERCIAL_RETRYABLE_CODES.has(code), unknown }
}

export function createCommercialAccessGuard(
  recheck: WorkerCommercialAccessRecheckPort,
  options: { now?: () => number; maxEvidenceAgeMs?: number } = {},
): WorkerCommercialAccessGuard {
  const now = options.now ?? (() => Date.now())
  const maxEvidenceAgeMs = options.maxEvidenceAgeMs ?? 30_000
  if (!Number.isFinite(maxEvidenceAgeMs) || maxEvidenceAgeMs <= 0) throw new RangeError('maxEvidenceAgeMs must be a positive finite number')
  return {
    async assertCommercialAccess(event, operation, signal) {
      signal?.throwIfAborted()
      const snapshot = parseWorkerCommercialAccessSnapshot(event, operation)
      validateSnapshotTimestamp(snapshot, now())
      let current: WorkerCommercialAccessRecheck
      try {
        current = await recheck({ event, operation, snapshot, ...(signal ? { signal } : {}) })
      } catch (cause) {
        if (signal?.aborted) signal.throwIfAborted()
        if (cause instanceof WorkerCommercialAccessError) throw cause
        throw new WorkerCommercialAccessError(
          'COMMERCIAL_EXECUTION_RECHECK_UNAVAILABLE',
          `commercial access authority unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
          true,
        )
      }
      signal?.throwIfAborted()
      validateCommercialRecheck(current, snapshot, now(), maxEvidenceAgeMs)
      return current
    },
  }
}

export function createUnavailableCommercialAccessGuard(reason = 'authoritative commercial access repository is not configured'): WorkerCommercialAccessGuard {
  return createCommercialAccessGuard(async () => {
    throw new WorkerCommercialAccessError('COMMERCIAL_EXECUTION_RECHECK_UNAVAILABLE', reason, true)
  })
}

export function parseWorkerCommercialAccessSnapshot(event: DurableOutboxEvent, operation: CriticalWorkerOperation): WorkerCommercialAccessSnapshot {
  const raw = event.payload.commercial_access_snapshot
  if (!isRecord(raw)) throw snapshotError('commercial_access_snapshot is missing from the durable event envelope')
  if ('subscription_snapshot_id' in raw || 'subscription_snapshot_checksum' in raw) throw snapshotError('legacy subscription snapshot fields are unsupported; V2 entitlement snapshot evidence is required')
  const accessMode = requireAccessMode(raw.access_mode)
  const quotedPoints = requirePoints(raw.quoted_points, 'quoted_points')
  const reservationId = optionalString(raw.reservation_id, 'reservation_id')
  const snapshot: WorkerCommercialAccessSnapshot = {
    schemaVersion: requireSchema(raw.schema_version),
    decisionId: requireString(raw.decision_id, 'decision_id'),
    workspaceId: requireString(raw.workspace_id, 'workspace_id'),
    operation: requireOperation(raw.operation),
    accessMode,
    accessRevision: requireString(raw.access_revision, 'access_revision'),
    balanceState: requireBalanceState(raw.balance_state),
    entitlementSnapshotId: requireString(raw.entitlement_snapshot_id, 'entitlement_snapshot_id'),
    entitlementSnapshotChecksum: requireSha256(raw.entitlement_snapshot_checksum, 'entitlement_snapshot_checksum'),
    rateVersion: requireNullableString(raw.rate_version, 'rate_version'),
    quotedPoints,
    ...(reservationId ? { reservationId } : {}),
    decidedAt: requireTimestamp(raw.decided_at, 'decided_at'),
  }
  if (snapshot.workspaceId !== event.workspaceId) throw snapshotError('commercial access snapshot workspace binding mismatch')
  if (snapshot.operation !== operation) throw snapshotError('commercial access snapshot operation binding mismatch')
  if (accessMode === 'POINT_CHARGED' && (quotedPoints < 1 || !reservationId || !snapshot.rateVersion)) throw snapshotError('charged commercial access requires positive quoted_points, approved rate_version, and reservation_id')
  if (accessMode === 'POINT_REQUIRED_NO_CHARGE' && (quotedPoints !== 0 || reservationId || snapshot.rateVersion !== null)) throw snapshotError('no-charge commercial access requires zero quoted_points, null rate_version, and no reservation_id')
  return snapshot
}

function validateCommercialRecheck(current: WorkerCommercialAccessRecheck, snapshot: WorkerCommercialAccessSnapshot, now: number, maxAgeMs: number): void {
  if (!isRecord(current)) throw recheckInvalid('commercial access recheck returned no evidence')
  const checkedAt = parseTimestamp(current.checkedAt, 'commercial access recheck checked_at')
  if (checkedAt > now + 5_000 || now - checkedAt > maxAgeMs) throw recheckInvalid('commercial access recheck evidence is stale')
  if (current.allowed !== true) throw new WorkerCommercialAccessError('COMMERCIAL_EXECUTION_DENIED', 'commercial access was denied', false)
  if (current.ready !== true) throw new WorkerCommercialAccessError('COMMERCIAL_EXECUTION_NOT_READY', 'commercial access is not ready for provider execution', true)
  if (!nonEmpty(current.recheckId) || current.recheckId === snapshot.decisionId) throw recheckInvalid('commercial access recheck id is invalid')
  if (current.workspaceId !== snapshot.workspaceId || current.operation !== snapshot.operation || current.accessMode !== snapshot.accessMode) throw recheckInvalid('commercial access scope binding mismatch')
  if (current.accessRevision !== snapshot.accessRevision) throw new WorkerCommercialAccessError('COMMERCIAL_EXECUTION_REVISION_STALE', 'commercial access revision changed after enqueue', false)
  if (current.balanceState !== snapshot.balanceState || current.balanceState !== 'known') throw new WorkerCommercialAccessError('COMMERCIAL_EXECUTION_BALANCE_BLOCKED', 'creative point balance is not known', false)
  if (current.entitlementSnapshotId !== snapshot.entitlementSnapshotId || current.entitlementSnapshotChecksum !== snapshot.entitlementSnapshotChecksum) throw new WorkerCommercialAccessError('COMMERCIAL_EXECUTION_ENTITLEMENT_STALE', 'V2 entitlement snapshot changed after enqueue', false)
  if (current.rateVersion !== snapshot.rateVersion || current.quotedPoints !== snapshot.quotedPoints) throw new WorkerCommercialAccessError('COMMERCIAL_EXECUTION_RATE_STALE', 'commercial rate or point quote changed after enqueue', false)
  if (snapshot.accessMode === 'POINT_CHARGED') {
    if (current.reservationId !== snapshot.reservationId || current.reservationState !== 'active') throw new WorkerCommercialAccessError('COMMERCIAL_EXECUTION_RESERVATION_INVALID', 'creative point reservation is not active or does not match', false)
  } else if (current.reservationId !== undefined || current.reservationState !== 'not_required') {
    throw recheckInvalid('no-charge commercial access returned reservation evidence')
  }
}

function validateSnapshotTimestamp(snapshot: WorkerCommercialAccessSnapshot, now: number): void {
  const decidedAt = Date.parse(snapshot.decidedAt)
  // Durable work may legitimately wait longer than the live recheck freshness
  // window. The immutable enqueue snapshot remains the binding baseline; the
  // authoritative recheck below detects any revision, entitlement, rate, or
  // reservation drift immediately before provider I/O.
  if (decidedAt > now + 5_000) throw snapshotError('commercial access snapshot evidence is from the future')
}

function snapshotError(message: string): WorkerCommercialAccessError { return new WorkerCommercialAccessError('COMMERCIAL_EXECUTION_SNAPSHOT_INVALID', message, false) }
function recheckInvalid(message: string): WorkerCommercialAccessError { return new WorkerCommercialAccessError('COMMERCIAL_EXECUTION_RECHECK_INVALID', message, true) }
function requireSchema(value: unknown): 1 { if (value !== 1) throw snapshotError('commercial access snapshot schema_version is unsupported'); return 1 }
function requireString(value: unknown, field: string): string { if (!nonEmpty(value)) throw snapshotError(`commercial access snapshot ${field} is missing`); return value }
function requireNullableString(value: unknown, field: string): string | null { if (value === null) return null; return requireString(value, field) }
function optionalString(value: unknown, field: string): string | undefined { if (value === undefined || value === null) return undefined; return requireString(value, field) }
function requireTimestamp(value: unknown, field: string): string { const result = requireString(value, field); if (!Number.isFinite(Date.parse(result))) throw snapshotError(`commercial access snapshot ${field} is invalid`); return result }
function parseTimestamp(value: unknown, field: string): number { if (!nonEmpty(value) || !Number.isFinite(Date.parse(value))) throw recheckInvalid(`${field} is invalid`); return Date.parse(value) }
function requireSha256(value: unknown, field: string): string { const result = requireString(value, field); if (!/^[a-f0-9]{64}$/u.test(result)) throw snapshotError(`commercial access snapshot ${field} is invalid`); return result }
function requirePoints(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw snapshotError(`commercial access snapshot ${field} must be a non-negative safe integer`); return value as number }
function requireAccessMode(value: unknown): WorkerCommercialAccessMode { if (value !== 'POINT_CHARGED' && value !== 'POINT_REQUIRED_NO_CHARGE') throw snapshotError('commercial access snapshot access_mode is unsupported'); return value }
function requireBalanceState(value: unknown): WorkerCommercialBalanceState { if (value !== 'known') throw snapshotError('commercial access snapshot balance_state must be known'); return value }
function requireOperation(value: unknown): CriticalWorkerOperation {
  if (!['publish.execute', 'publish.reconcile', 'generation.execute', 'image_generation.execute', 'catalog.sync.execute', 'asset.scan.execute', 'asset.continuation.execute'].includes(String(value))) throw snapshotError('commercial access snapshot operation is unsupported')
  return value as CriticalWorkerOperation
}
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
