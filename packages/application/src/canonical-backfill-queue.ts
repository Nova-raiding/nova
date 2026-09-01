export interface CanonicalBackfillConflictQueueFailure {
  code: 'CANONICAL_BACKFILL_CONFLICT_COUNT_INVALID' | 'CANONICAL_BACKFILL_CONFLICT_REPOSITORY_UNAVAILABLE'
  status: 503
  details?: { conflict_count: number }
}

/**
 * A failed run is retryable only when the durable result contains an executor
 * error. Conflict-bearing runs deliberately stay terminal until a human has
 * reviewed their queued evidence.
 */
export function canonicalBackfillRunCanRetry(lastResult: Record<string, unknown>): boolean {
  return typeof lastResult.error === 'string'
    && lastResult.error.trim().length > 0
    && !Array.isArray(lastResult.conflicts)
}

/**
 * Conflicts are actionable only when a durable repair queue is available.
 * Returning a stable failure contract keeps the API boundary fail-closed and
 * lets the rule be tested without importing the server's runtime state.
 */
export function canonicalBackfillConflictQueueFailure(input: { conflictCount: number; configured: boolean }): CanonicalBackfillConflictQueueFailure | undefined {
  if (!Number.isSafeInteger(input.conflictCount) || input.conflictCount < 0) return { code: 'CANONICAL_BACKFILL_CONFLICT_COUNT_INVALID', status: 503 }
  if (input.conflictCount > 0 && !input.configured) return { code: 'CANONICAL_BACKFILL_CONFLICT_REPOSITORY_UNAVAILABLE', status: 503, details: { conflict_count: input.conflictCount } }
  return undefined
}
