import { afterEach, describe, expect, it, vi } from 'vitest'
import { MerchantMcpSession } from './merchant-mcp-session.js'
import { requestApi } from './api.js'

const unauthorizedEnvelope = () => new Response(JSON.stringify({
  request_id: 'req-test', trace_id: 'trace-test', workspace_id: 'ws_test',
  data: null, warnings: [], next_actions: [],
  error: { code: 'UNAUTHENTICATED', message: 'token expired' },
}), { status: 401, headers: { 'content-type': 'application/json' } })

describe('merchant MCP browser session', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reissues an expired MCP bearer once and revokes its refresh token when cleared', async () => {
    const session = new MerchantMcpSession(() => 100_000)
    const issue = vi.fn(async () => {
      const version = issue.mock.calls.length
      return { access_token: `access-${version}`, refresh_token: `refresh-${version}`, expires_in: 60 }
    })
    const received: string[] = []
    let invocation = 0

    await expect(session.request(issue, async accessToken => {
      received.push(accessToken)
      invocation += 1
      if (invocation === 1) throw Object.assign(new Error('token expired'), { status: 401 })
      return { ok: true }
    })).resolves.toEqual({ ok: true })

    expect(received).toEqual(['access-1', 'access-2'])
    expect(issue).toHaveBeenCalledTimes(2)
    const revokeToken = vi.fn(async () => ({ revoked: true }))
    await session.revoke(revokeToken)
    expect(revokeToken).toHaveBeenCalledWith('refresh-2')
  })

  it('does not treat an MCP 401 as an expired browser login session', async () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', Object.assign(globalThis, { dispatchEvent }))
    vi.stubGlobal('fetch', vi.fn(async () => unauthorizedEnvelope()))

    await expect(requestApi('/api', '/mcp', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 401 })

    expect(dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'merchant-auth-expired' }))
  })
})
