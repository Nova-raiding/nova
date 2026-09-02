import { describe, expect, it } from 'vitest'
import { ERROR_CODES, createStableError, isErrorCode } from './index.js'

describe('stable error codes', () => {
  it('recognizes only registered codes', () => {
    expect(isErrorCode(ERROR_CODES.STALE_PUBLISH_CONFIRMATION)).toBe(true)
    expect(isErrorCode('SDK_RAW_EXCEPTION')).toBe(false)
  })

  it('keeps default transport semantics stable', () => {
    expect(createStableError(ERROR_CODES.TENANT_SCOPE_DENIED, 'denied').status).toBe(403)
    expect(createStableError(ERROR_CODES.WORKSPACE_SCOPE_MISMATCH, 'scope mismatch').status).toBe(403)
    expect(createStableError(ERROR_CODES.DATABASE_UNAVAILABLE, 'db unavailable').status).toBe(503)
    expect(createStableError(ERROR_CODES.PLATFORM_RATE_LIMITED, 'slow down', { retryable: true }).retryable).toBe(true)
  })
})
