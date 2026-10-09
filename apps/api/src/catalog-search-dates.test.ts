import { describe, expect, it } from 'vitest'
import { normalizeCatalogDateRange } from './catalog-search-dates.js'

describe('catalog search date range validation', () => {
  it('rejects numeric timezone offsets beyond the PostgreSQL timestamptz range', () => {
    expect(() => normalizeCatalogDateRange('2026-10-01T00:00:00+16:00', undefined))
      .toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST', status: 400 }))
  })

  it.each([
    '0001-01-01T00:00:00+15:00',
    '9999-12-31T23:59:59-15:00',
    '2026-10-01T00:00:00-00:00',
  ])('rejects noncanonical RFC 3339 boundary %s', value => {
    expect(() => normalizeCatalogDateRange(value, undefined))
      .toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST', status: 400 }))
  })
})
