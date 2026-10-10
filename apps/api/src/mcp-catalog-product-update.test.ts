import { describe, expect, it } from 'vitest'
import { catalogProductUpdateInternals } from './mcp-catalog-product-update.js'

describe('catalog product update version contract', () => {
  it('accepts omitted and safe non-negative versions', () => {
    expect(catalogProductUpdateInternals.parseExpectedVersion(undefined)).toBeUndefined()
    expect(catalogProductUpdateInternals.parseExpectedVersion('0')).toBe(0)
    expect(catalogProductUpdateInternals.parseExpectedVersion(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  it.each(['-1', '1.5', '1e3', '', String(Number.MAX_SAFE_INTEGER + 1), '900719925474099999999'])('rejects invalid or unsafe version %s before update', (value) => {
    expect(() => catalogProductUpdateInternals.parseExpectedVersion(value)).toThrowError(expect.objectContaining({
      code: 'INVALID_REQUEST',
      status: 400,
      message: 'expected_version 必须是非负安全整数',
    }))
  })
})
