import { describe, expect, it, vi } from 'vitest'
import { MerchantMcpSession } from './merchant-mcp-session.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

const credential = (version: string) => ({
  access_token: `access-${version}`, refresh_token: `refresh-${version}`, expires_in: 300,
})

describe('merchant MCP session cancellation across account changes', () => {
  it('never invokes a pending credential issued before the session was cleared', async () => {
    const session = new MerchantMcpSession()
    const pending = deferred<ReturnType<typeof credential>>()
    const invoke = vi.fn(async () => 'old account result')
    const result = session.request(() => pending.promise, invoke)
    const rejected = expect(result).rejects.toMatchObject({ code: 'MCP_SESSION_CHANGED' })
    session.clear()
    pending.resolve(credential('old'))
    await rejected
    expect(invoke).not.toHaveBeenCalled()
    await expect(session.request(async () => credential('new'), async token => token)).resolves.toBe('access-new')
  })

  it('does not retry an old in-flight 401 under the replacement account', async () => {
    const session = new MerchantMcpSession()
    const response = deferred<string>()
    const started = deferred<void>()
    const issue = vi.fn(async () => credential('old'))
    const invoke = vi.fn(async () => { started.resolve(); return response.promise })
    const result = session.request(issue, invoke)
    const rejected = expect(result).rejects.toMatchObject({ code: 'MCP_SESSION_CHANGED' })
    await started.promise
    session.clear()
    await expect(session.request(async () => credential('new'), async token => token)).resolves.toBe('access-new')
    response.reject(Object.assign(new Error('expired'), { status: 401 }))
    await rejected
    expect(issue).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('discards an old successful response after revocation rather than presenting it in the new account', async () => {
    const session = new MerchantMcpSession()
    const response = deferred<string>()
    const started = deferred<void>()
    const result = session.request(async () => credential('old'), async () => { started.resolve(); return response.promise })
    const rejected = expect(result).rejects.toMatchObject({ code: 'MCP_SESSION_CHANGED' })
    await started.promise
    const revoke = vi.fn(async () => undefined)
    await session.revoke(revoke)
    response.resolve('old workspace data')
    await rejected
    expect(revoke).toHaveBeenCalledWith('refresh-old')
  })

  it('continues sharing credential issuance for concurrent requests in the same session', async () => {
    const session = new MerchantMcpSession()
    const pending = deferred<ReturnType<typeof credential>>()
    const issue = vi.fn(() => pending.promise)
    const results = [session.request(issue, async token => token), session.request(issue, async token => token)]
    pending.resolve(credential('current'))
    await expect(Promise.all(results)).resolves.toEqual(['access-current', 'access-current'])
    expect(issue).toHaveBeenCalledTimes(1)
  })

  it('does not use a renewal that completes after the account changes', async () => {
    const session = new MerchantMcpSession()
    const renewal = deferred<ReturnType<typeof credential>>()
    const started = deferred<void>()
    const issue = vi.fn()
      .mockResolvedValueOnce(credential('old'))
      .mockImplementationOnce(() => { started.resolve(); return renewal.promise })
    const invoke = vi.fn(async () => { throw Object.assign(new Error('expired'), { status: 401 }) })
    const result = session.request(issue, invoke)
    const rejected = expect(result).rejects.toMatchObject({ code: 'MCP_SESSION_CHANGED' })
    await started.promise
    session.clear()
    renewal.resolve(credential('old-renewed'))
    await rejected
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('keeps the new pending issuance when the abandoned issuance completes', async () => {
    const session = new MerchantMcpSession()
    const old = deferred<ReturnType<typeof credential>>()
    const current = deferred<ReturnType<typeof credential>>()
    const oldResult = session.request(() => old.promise, async token => token)
    const oldRejected = expect(oldResult).rejects.toMatchObject({ code: 'MCP_SESSION_CHANGED' })
    session.clear()
    const currentIssue = vi.fn(() => current.promise)
    const first = session.request(currentIssue, async token => token)
    old.resolve(credential('old'))
    await oldRejected
    const second = session.request(currentIssue, async token => token)
    current.resolve(credential('current'))
    await expect(Promise.all([first, second])).resolves.toEqual(['access-current', 'access-current'])
    expect(currentIssue).toHaveBeenCalledTimes(1)
  })
})
