import { describe, expect, it } from 'vitest'
import { commercialWriteOutcomeUnknown } from './CommercialPurchaseCenter'
import { describeApiError } from './api'

describe('closed commercial writes', () => {
  it('treats the runtime write fence as a confirmed rejection, not an unknown result', () => {
    const error = { code: 'NEW_WRITES_CLOSED', status: 503 }

    expect(commercialWriteOutcomeUnknown(error)).toBe(false)
    expect(describeApiError(error, { operation: 'write' })).toContain('没有创建订单、发起付款或扣费')
  })
})
