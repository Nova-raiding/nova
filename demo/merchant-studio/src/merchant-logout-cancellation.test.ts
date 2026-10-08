import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
const envelope = (data: unknown) => new Response(JSON.stringify({ request_id: 'logout-race', trace_id: 'logout-race', workspace_id: 'ws_fixture', data, warnings: [], next_actions: [], error: null }), { headers: { 'content-type': 'application/json' } })
const loginResponse = () => envelope({ account: { id: 'current', accountType: 'merchant' } })

describe('merchant login waits for already dispatched cookie mutations', () => {
  beforeEach(() => { vi.resetModules(); vi.stubGlobal('window', globalThis) })
  afterEach(() => vi.unstubAllGlobals())

  it.each([false, true])('waits for prior logout HTTP and releases the barrier even on transport failure=%s', async transportFailure => {
    const response = deferred<Response>()
    const started = deferred<void>()
    let loginCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/auth/logout')) { started.resolve(); return response.promise }
      loginCalls += 1
      return loginResponse()
    }))
    const api = await import('./api.js')
    const logout = api.logoutMerchantAccount('/api')
    const failed = transportFailure
      ? expect(logout).rejects.toThrow('fixture transport failure')
      : expect(logout).rejects.toMatchObject({ code: 'MCP_SESSION_CHANGED' })
    await started.promise
    const login = api.loginMerchantAccount('/api', { login: 'current@example.invalid', password: 'fixture-only' })
    await new Promise(resolve => setTimeout(resolve, 0))
    try { expect(loginCalls).toBe(0) } finally {
      if (transportFailure) response.reject(new Error('fixture transport failure'))
      else response.resolve(envelope({ logged_out: true }))
    }
    await failed
    await expect(login).resolves.toMatchObject({ id: 'current' })
    expect(loginCalls).toBe(1)
  })

  it('cancels a queued second logout while preserving the newer login in the cookie queue', async () => {
    const response = deferred<Response>()
    const started = deferred<void>()
    let logoutCalls = 0
    let loginCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/auth/logout')) { logoutCalls += 1; started.resolve(); return response.promise }
      loginCalls += 1
      return loginResponse()
    }))
    const api = await import('./api.js')
    const first = api.logoutMerchantAccount('/api')
    const firstCancelled = expect(first).rejects.toMatchObject({ code: 'MCP_SESSION_CHANGED' })
    await started.promise
    const second = api.logoutMerchantAccount('/api')
    const secondCancelled = expect(second).rejects.toMatchObject({ code: 'MCP_SESSION_CHANGED' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const login = api.loginMerchantAccount('/api', { login: 'current@example.invalid', password: 'fixture-only' })
    await new Promise(resolve => setTimeout(resolve, 0))
    try { expect(logoutCalls).toBe(1); expect(loginCalls).toBe(0) } finally { response.resolve(envelope({ logged_out: true })) }
    await firstCancelled
    await secondCancelled
    await expect(login).resolves.toMatchObject({ id: 'current' })
    expect(logoutCalls).toBe(1)
    expect(loginCalls).toBe(1)
  })
})
