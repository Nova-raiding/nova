import { describe, expect, it } from 'vitest'
import { canonicalBackfillConflictQueueFailure } from './canonical-backfill-queue.js'

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
})
