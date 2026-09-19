import { describe, expect, it } from 'vitest'
import { monthlyAnniversary as applicationMonthlyAnniversary } from '../packages/application/src/service-fulfillment.js'
import { monthlyAnniversary } from '../packages/persistence/src/commercial-contract-repository.js'
import { nextPeriodEnd } from '../packages/persistence/src/commercial-extensions-repository.js'
import { cycleEnd } from '../packages/persistence/src/subscription-repository.js'

/**
 * The "one calendar month on, clamped to the last day of the target month, in
 * UTC" rule exists as four independent implementations plus PostgreSQL's
 * `interval '1 month'`:
 *
 *   - `monthlyAnniversary` (commercial-contract-repository) — the payment path
 *   - `monthlyAnniversary` (service-fulfillment)              — fulfillment
 *   - `nextPeriodEnd`      (commercial-extensions-repository)  — plan changes
 *   - `cycleEnd`           (subscription-repository)           — memory subscriptions
 *   - `now() + interval '1 month'`                             — Postgres subscriptions
 *
 * They agree today. Two of them did *not* at the start of this audit: the
 * payment path used a raw `setUTCMonth(+1)` overflow (so payments taken on the
 * 29th-31st were never credited) and `cycleEnd` used a local-timezone overflow
 * anchored on the wall clock. Both produced silently wrong dates only on
 * specific days of the year, so no ordinary test caught them.
 *
 * This test sweeps every day of a 30-year window and requires all four to agree
 * on every one of them, so a future edit to any single copy fails immediately
 * rather than waiting for a customer to pay on the 31st.
 */
const START = Date.UTC(2000, 0, 1)
const END = Date.UTC(2030, 0, 1)
const DAY_MS = 86_400_000
/** Times of day that stress the local-timezone handling of the old code. */
const HOURS = ['00:00:00.000', '10:30:45.123', '23:59:59.999']

describe('month-anniversary rule equivalence', () => {
  it('all implementations agree for +1 month on every day of 2000-2030', () => {
    const disagreements: Array<{ paidAt: string; canonical: string; candidates: Record<string, string> }> = []
    for (let day = START; day < END; day += DAY_MS) {
      for (const time of HOURS) {
        const paidAt = `${new Date(day).toISOString().slice(0, 10)}T${time}Z`
        const canonical = monthlyAnniversary(paidAt, 1)
        const candidates: Record<string, string> = {
          'service-fulfillment': applicationMonthlyAnniversary(new Date(paidAt), 1),
          'commercial-extensions': nextPeriodEnd(paidAt, 'monthly'),
          'subscription-cycleEnd': cycleEnd(paidAt, 'monthly'),
        }
        if (Object.values(candidates).some(value => value !== canonical)) disagreements.push({ paidAt, canonical, candidates })
      }
    }
    expect(disagreements.slice(0, 5)).toEqual([])
    expect(disagreements).toHaveLength(0)
  })

  it('clamps to the last day of a shorter target month instead of overflowing', () => {
    // These are the exact shapes that used to diverge by two or three days.
    expect(monthlyAnniversary('2026-01-31T10:00:00.000Z', 1)).toBe('2026-02-28T10:00:00.000Z')
    expect(monthlyAnniversary('2027-01-29T10:00:00.000Z', 1)).toBe('2027-02-28T10:00:00.000Z')
    expect(monthlyAnniversary('2028-01-31T10:00:00.000Z', 1)).toBe('2028-02-29T10:00:00.000Z')
    expect(cycleEnd('2027-01-31T10:00:00.000Z', 'monthly')).toBe('2027-02-28T10:00:00.000Z')
    // A 31-day target month keeps the anchor day.
    expect(monthlyAnniversary('2026-03-31T10:00:00.000Z', 1)).toBe('2026-04-30T10:00:00.000Z')
    expect(monthlyAnniversary('2026-12-31T10:00:00.000Z', 1)).toBe('2027-01-31T10:00:00.000Z')
  })

  it('agrees on the annual cycle as well', () => {
    expect(cycleEnd('2028-02-29T10:00:00.000Z', 'annual')).toBe(monthlyAnniversary('2028-02-29T10:00:00.000Z', 12))
    expect(nextPeriodEnd('2028-02-29T10:00:00.000Z', 'annual')).toBe(monthlyAnniversary('2028-02-29T10:00:00.000Z', 12))
  })
})
