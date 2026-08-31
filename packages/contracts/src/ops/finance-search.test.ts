import { describe, expect, it } from 'vitest'
import { FinanceSearchValidationError, parseFinanceSearchQuery } from './finance-search.js'

describe('finance search contract', () => {
  it('normalizes bounded filters and timestamps', () => {
    expect(parseFinanceSearchQuery({ workspace_ids: [' ws_2 ', 'ws_2'], kinds: ['model_usage'], statuses: ['settled'], from_at: '2026-08-01', limit: 25 })).toEqual({
      workspaceIds: ['ws_2'], kinds: ['model_usage'], statuses: ['settled'], fromAt: '2026-08-01T00:00:00.000Z', limit: 25,
    })
  })

  it.each([
    { limit: 101 },
    { kinds: ['secret_ledger'] },
    { from_at: '2026-09-01', to_at: '2026-08-01' },
    { workspace_ids: Array.from({ length: 251 }, (_, index) => `ws_${index}`) },
  ])('rejects unsafe query %#', value => {
    expect(() => parseFinanceSearchQuery(value)).toThrow(FinanceSearchValidationError)
  })
})
