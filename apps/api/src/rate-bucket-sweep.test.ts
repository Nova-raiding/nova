import { afterEach, describe, expect, it } from 'vitest'
import { rateBuckets, sweepExpiredRateBuckets } from './server.js'

/**
 * The process-local fallback rate limiter is only reached while Redis is down,
 * and its sweep used to walk the entire bucket map from the request hot path
 * the moment the map passed the size threshold. That is O(keys x map size) and
 * it fired exactly when the map was largest and the event loop could least
 * afford it. These tests pin the replacement: a fixed slice per call, with the
 * map still fully drained across calls.
 */

const MINUTE_MS = 60_000
/** Mirrors the private RATE_BUCKET_SWEEP_SLICE without freezing the constant. */
const BOUNDED_SLICE_CEILING = 1000

function seed(size: number, ageMs: number) {
  const now = Date.now()
  for (let index = 0; index < size; index += 1) {
    rateBuckets.set(`seed:${size}:${index}`, { windowStartedAt: now - ageMs, count: 1 })
  }
  return now
}

afterEach(() => {
  rateBuckets.clear()
  // Drop the resumable cursor so one test cannot leave the next mid-iteration.
  for (let index = 0; index < 200; index += 1) sweepExpiredRateBuckets(Date.now())
  rateBuckets.clear()
})

describe('fallback rate bucket sweep', () => {
  it('removes only a bounded slice per call instead of walking the whole map', () => {
    const expired = 4_000
    const now = seed(expired, 2 * MINUTE_MS)

    const before = rateBuckets.size
    sweepExpiredRateBuckets(now)
    const removedInOneCall = before - rateBuckets.size

    expect(removedInOneCall).toBeGreaterThan(0)
    expect(removedInOneCall).toBeLessThan(expired)
    expect(removedInOneCall).toBeLessThanOrEqual(BOUNDED_SLICE_CEILING)
  })

  it('still drains every expired bucket across repeated calls', () => {
    const now = seed(4_000, 2 * MINUTE_MS)

    for (let call = 0; call < 200 && rateBuckets.size > 0; call += 1) sweepExpiredRateBuckets(now)

    expect(rateBuckets.size).toBe(0)
  })

  it('never evicts a bucket inside the current 60 second window', () => {
    const now = Date.now()
    rateBuckets.set('fresh:actor', { windowStartedAt: now - 1_000, count: 7 })
    for (let index = 0; index < 500; index += 1) {
      rateBuckets.set(`stale:${index}`, { windowStartedAt: now - 2 * MINUTE_MS, count: 1 })
    }

    for (let call = 0; call < 50; call += 1) sweepExpiredRateBuckets(now)

    expect(rateBuckets.get('fresh:actor')).toEqual({ windowStartedAt: now - 1_000, count: 7 })
  })
})
