import { describe, expect, it } from 'vitest'
import { validateCustomerDeliveryProfileValues } from './customer-delivery-profile-validation.js'

describe('validateCustomerDeliveryProfileValues', () => {
  it('accepts the minimum valid profile and nullable draft fields', () => {
    expect(() => validateCustomerDeliveryProfileValues({ companyName: '示例客户' })).not.toThrow()
    expect(() => validateCustomerDeliveryProfileValues({
      companyName: '示例客户',
      contractNumber: null,
      projectOwner: null,
      supportOwner: null,
      contractRef: null,
      paymentDate: null,
      plannedGoLiveAt: null,
      archivedAt: null,
    })).not.toThrow()
    expect(() => validateCustomerDeliveryProfileValues({})).not.toThrow()
  })

  it('accepts valid calendar dates and timestamps with explicit UTC or numeric offsets', () => {
    expect(() => validateCustomerDeliveryProfileValues({
      paymentDate: '2024-02-29',
      plannedGoLiveAt: '2026-10-08T09:30:00+08:00',
      archivedAt: '2026-10-08T01:30:00Z',
    })).not.toThrow()
  })

  it('accepts a syntactically valid uploaded contract asset reference', () => {
    expect(() => validateCustomerDeliveryProfileValues({ contractRef: 'asset://contract/scan_123.pdf' })).not.toThrow()
  })

  it.each([
    ['impossible leap day', { paymentDate: '2025-02-29' }],
    ['zero year', { paymentDate: '0000-01-01' }],
    ['timestamp without timezone', { plannedGoLiveAt: '2026-10-08T09:30:00' }],
    ['invalid calendar date in timestamp', { archivedAt: '2026-02-30T12:00:00Z' }],
    ['out-of-range PostgreSQL offset', { plannedGoLiveAt: '2026-10-08T09:30:00+16:00' }],
  ])('rejects %s', (_caseName, patch) => {
    expect(() => validateCustomerDeliveryProfileValues(patch)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })

  it('rejects NUL in profile values and object keys', () => {
    expect(() => validateCustomerDeliveryProfileValues({ projectOwner: 'ops\u0000admin' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => validateCustomerDeliveryProfileValues({ ['bad\u0000key']: 'value' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })

  it('accepts company names at the 200-character limit and rejects over-limit values', () => {
    expect(() => validateCustomerDeliveryProfileValues({ companyName: '客'.repeat(200) })).not.toThrow()
    expect(() => validateCustomerDeliveryProfileValues({ companyName: '客'.repeat(201) }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })

  it.each(['', '   ', null, 42])('rejects an empty or non-string company name (%s)', companyName => {
    expect(() => validateCustomerDeliveryProfileValues({ companyName }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })

  it('rejects empty or malformed contract references while allowing null draft values', () => {
    expect(() => validateCustomerDeliveryProfileValues({ contractRef: '' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => validateCustomerDeliveryProfileValues({ contractRef: 'https://example.test/contract.pdf' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => validateCustomerDeliveryProfileValues({ contractRef: null })).not.toThrow()
  })
})
