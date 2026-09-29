import { describe, expect, it } from 'vitest'
import { daysRemainingInShanghai, yesterdayWindowInShanghai } from './entitlement-date'

describe('entitlement days remaining', () => {
  it('counts Shanghai calendar days across UTC date boundaries', () => {
    expect(daysRemainingInShanghai('2026-10-01T00:00:00.000Z', new Date('2026-09-30T16:00:00.000Z'))).toBe(0)
    expect(daysRemainingInShanghai('2026-09-30T16:00:00.000Z', new Date('2026-09-30T15:59:00.000Z'))).toBe(1)
  })

  it('clamps expired periods at zero and rejects invalid dates', () => {
    expect(daysRemainingInShanghai('2026-09-30T15:59:59.000Z', new Date('2026-09-30T16:00:00.000Z'))).toBe(0)
    expect(daysRemainingInShanghai('not-a-date', new Date('2026-09-30T16:00:00.000Z'))).toBeNull()
  })

  it('builds inclusive yesterday boundaries in the Shanghai calendar', () => {
    expect(yesterdayWindowInShanghai(new Date('2026-09-29T03:00:00.000Z'))).toEqual({
      date: '2026-09-28',
      dateFrom: '2026-09-28T00:00:00+08:00',
      dateTo: '2026-09-28T23:59:59.999+08:00',
    })
  })
})
