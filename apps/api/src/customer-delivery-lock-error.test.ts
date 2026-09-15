import { describe, expect, it } from 'vitest'
import { mapCustomerDeliveryPersistenceError } from './server.js'

describe('customer delivery PostgreSQL lock error mapping', () => {
  it('maps an explicitly rejected delivery evidence assertion to a repairable 409', () => {
    expect(mapCustomerDeliveryPersistenceError(Object.assign(new Error('customer delivery evidence is unavailable'), { code: '23514' })))
      .toMatchObject({ code: 'CUSTOMER_DELIVERY_EVIDENCE_NOT_READY', status: 409, details: { retryable: false, requires_evidence_refresh: true } })
  })
  it.each([
    ['55P03', 'lock_not_available'],
    ['40P01', 'deadlock_detected'],
  ])('maps PostgreSQL %s to a stable retryable 503 contract', (postgresCode, conflictKind) => {
    const error = mapCustomerDeliveryPersistenceError(Object.assign(new Error('database details must not leak'), { code: postgresCode }))

    expect(error).toMatchObject({
      code: 'CUSTOMER_DELIVERY_EVIDENCE_LOCK_BUSY',
      status: 503,
      details: {
        retryable: true,
        conflict_kind: conflictKind,
        retry_after_ms: 250,
      },
    })
    expect(error?.message).not.toContain('database details')
  })

  it('does not relabel unrelated PostgreSQL failures as evidence-lock contention', () => {
    expect(mapCustomerDeliveryPersistenceError(Object.assign(new Error('constraint'), { code: '23503' }))).toBeUndefined()
    expect(mapCustomerDeliveryPersistenceError(Object.assign(new Error('unrelated check constraint'), { code: '23514' }))).toBeUndefined()
    expect(mapCustomerDeliveryPersistenceError(new Error('unknown'))).toBeUndefined()
  })
})
