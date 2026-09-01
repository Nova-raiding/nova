import { describe, expect, it } from 'vitest'
import { canonicalBackfillConflictQueueFailure, canonicalBackfillRunCanRetry } from './canonical-backfill-queue.js'

describe('canonical backfill conflict queue safety', () => {
  it('requires a durable queue whenever a batch discovers conflicts', () => {
    expect(canonicalBackfillConflictQueueFailure({ conflictCount: 1, configured: false })).toEqual({
      code: 'CANONICAL_BACKFILL_CONFLICT_REPOSITORY_UNAVAILABLE', status: 503, details: { conflict_count: 1 },
    })
  })

  it('allows conflict-free batches without a queue and rejects invalid counts', () => {
    expect(canonicalBackfillConflictQueueFailure({ conflictCount: 0, configured: false })).toBeUndefined()
    expect(canonicalBackfillConflictQueueFailure({ conflictCount: -1, configured: true })).toMatchObject({ code: 'CANONICAL_BACKFILL_CONFLICT_COUNT_INVALID', status: 503 })
  })

  it('allows executor failures to retry but keeps conflict failures terminal', () => {
    expect(canonicalBackfillRunCanRetry({ error: 'temporary database timeout' })).toBe(true)
    expect(canonicalBackfillRunCanRetry({ error: ' ' })).toBe(false)
    expect(canonicalBackfillRunCanRetry({ conflicts: [{ code: 'MISSING_BRAND' }] })).toBe(false)
  })
})
