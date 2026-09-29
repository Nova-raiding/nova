import { describe, expect, it } from 'vitest'
import { currentShanghaiMonthRange, filterFinanceEntriesByWindow, fillDailyFinancePoints, shanghaiCalendarDate } from './finance-window.js'

describe('merchant finance chart window', () => {
  it('uses Shanghai calendar dates for ledger timestamps', () => {
    expect(shanghaiCalendarDate(new Date('2026-09-30T16:30:00.000Z'))).toBe('2026-10-01')
  })

  it('builds the complete current Shanghai calendar month', () => {
    expect(currentShanghaiMonthRange(new Date('2026-09-28T08:00:00.000Z'))).toEqual({ start: '2026-09-01', end: '2026-09-30', days: 30 })
  })

  it('fills missing dates with zero only inside a bounded chart window', () => {
    expect(fillDailyFinancePoints([{ dateLabel: '2026/09/02', label: '09/02', value: 7 }], '2026-09-01', '2026-09-03')).toEqual([
      { dateLabel: '2026-09-01', label: '09/01', value: 0 },
      { dateLabel: '2026/09/02', label: '09/02', value: 7 },
      { dateLabel: '2026-09-03', label: '09/03', value: 0 },
    ])
    const long = fillDailyFinancePoints([{ label: 'old', value: 1 }], '2025-01-01', '2026-09-30')
    expect(long).toEqual([{ label: 'old', value: 1 }])
  })

  it('keeps an empty ledger empty instead of implying a zero-value history', () => {
    expect(fillDailyFinancePoints([], '2026-09-01', '2026-09-03')).toEqual([])
  })

  it('filters statement rows to the selected Shanghai date window', () => {
    const entries = [
      { id: 'outside', createdAt: '2026-08-31T15:59:59.999Z' },
      { id: 'inside', createdAt: '2026-09-15T12:00:00.000Z' },
    ]
    expect(filterFinanceEntriesByWindow(entries, 'day', '2026-09-01', '2026-09-30').map(({ id }) => id)).toEqual(['inside'])
    expect(filterFinanceEntriesByWindow(entries, 'day', '2026-10-01', '2026-10-31')).toEqual([])
    expect(filterFinanceEntriesByWindow(entries, 'month', '2026-08', '2026-08').map(({ id }) => id)).toEqual(['outside'])
  })
})
