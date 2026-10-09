import { describe, expect, it, vi } from 'vitest'
import { merchantSessionProbeFailure } from './merchant-session-probe.js'

describe('merchant session probe failures', () => {
  const describeError = vi.fn((error: unknown) => (error as Error).message)

  it('keeps an ordinary expired or absent session on the sign-in form', () => {
    expect(merchantSessionProbeFailure(Object.assign(new Error('expired'), { code: 'AUTH_SESSION_INVALID', status: 401 }), describeError))
      .toEqual({ state: 'signed_out', message: '', retryable: false })
  })

  it('shows transport failures and makes the session probe retryable', () => {
    expect(merchantSessionProbeFailure(Object.assign(new Error('API request timed out'), { code: 'API_REQUEST_TIMEOUT' }), describeError))
      .toEqual({ state: 'error', message: '无法验证登录状态：API request timed out', retryable: true })
  })

  it('keeps a non-merchant session explanation without a futile probe retry', () => {
    expect(merchantSessionProbeFailure(Object.assign(new Error('商家账号要求'), { code: 'AUTH_MERCHANT_ACCOUNT_REQUIRED' }), describeError))
      .toEqual({ state: 'error', message: '商家账号要求', retryable: false })
  })

  it('treats auth-expired 403 responses as signed out, matching the API event', () => {
    expect(merchantSessionProbeFailure(Object.assign(new Error('登录会话已过期'), { code: 'AUTH_SESSION_EXPIRED', status: 403 }), describeError))
      .toEqual({ state: 'signed_out', message: '', retryable: false })
  })

  it.each([
    ['API_AUTH_TOKEN_MISSING', undefined],
    ['API_WORKSPACE_ID_MISSING', undefined],
    ['AUTH_FORBIDDEN', 403],
    ['INVALID_REQUEST', 400],
  ])('does not offer a futile retry for configuration or permanent error %s', (code, status) => {
    expect(merchantSessionProbeFailure(Object.assign(new Error('configuration rejected'), { code, status }), describeError))
      .toMatchObject({ state: 'error', retryable: false })
  })

  it('keeps rate limits and server errors retryable', () => {
    expect(merchantSessionProbeFailure(Object.assign(new Error('busy'), { code: 'UPSTREAM_BUSY', status: 503 }), describeError).retryable).toBe(true)
    expect(merchantSessionProbeFailure(Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED', status: 429 }), describeError).retryable).toBe(true)
  })
})
