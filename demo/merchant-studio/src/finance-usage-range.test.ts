import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  financeUsageRangeHasPendingChanges,
  financeUsageRangeReducer,
  initialFinanceUsageRangeState,
} from './finance-usage-range.js'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('finance trend range applies only on query', () => {
  it('keeps edited date fields as a draft until apply, then promotes them', () => {
    const draft = financeUsageRangeReducer(initialFinanceUsageRangeState, { type: 'set-start', value: '2026-09-01' })
    expect(draft).toMatchObject({
      draft: { mode: 'day', start: '2026-09-01', end: '' },
      applied: { mode: 'day', start: '', end: '' },
    })
    expect(financeUsageRangeHasPendingChanges(draft)).toBe(true)

    const applied = financeUsageRangeReducer(draft, { type: 'apply' })
    expect(applied.applied).toEqual(draft.draft)
    expect(financeUsageRangeHasPendingChanges(applied)).toBe(false)
  })

  it('switches range mode as a draft and reset restores the applied default immediately', () => {
    const appliedMonth = financeUsageRangeReducer(initialFinanceUsageRangeState, { type: 'set-mode', mode: 'month' })
    expect(appliedMonth.applied.mode).toBe('day')
    expect(financeUsageRangeHasPendingChanges(appliedMonth)).toBe(true)

    const reset = financeUsageRangeReducer(appliedMonth, { type: 'reset' })
    expect(reset).toEqual(initialFinanceUsageRangeState)
    expect(financeUsageRangeHasPendingChanges(reset)).toBe(false)
  })

  it('wires the query button to apply and derives chart ranges from applied state', () => {
    expect(app).toContain("onSubmit={(event) => { event.preventDefault(); dispatchUsageRange({ type: 'apply' }) }}")
    expect(app).toContain("onClick={resetUsage}")
    expect(app).toContain("type: 'reset'")
    expect(app).toContain('const { draft: draftUsageRange, applied: appliedUsageRange } = usageRange')
    expect(app).toContain('const source = appliedUsageRange.mode === \'day\' ? dailyUsage : monthlyUsage')
    expect(app).toContain('点击“查询”后应用。')
  })
})
