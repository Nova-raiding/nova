import { describe, expect, it, vi } from 'vitest'
import { handlePlatformAccountRoute, type PlatformAccountRouteDependencies } from './http-platform-account-routes.js'

describe('OAuth callback exchange failure isolation', () => {
  it.each([
    ['provider rejects the code', new Error('provider rejected authorization code')],
    ['provider exchange times out', new Error('provider exchange timed out')],
  ])('does not create a connected account when %s', async (_scenario, exchangeError) => {
    const registerPlatformAccount = vi.fn()
    const persistSnapshot = vi.fn()
    const persistEvent = vi.fn()
    const createSyncJob = vi.fn()
    const exchangeCode = vi.fn().mockRejectedValue(exchangeError)
    const send = vi.fn()
    const deps = {
      service: { registerPlatformAccount, createSyncJob } as unknown as PlatformAccountRouteDependencies['service'],
      connectorRuntime: { connector: vi.fn(() => ({ exchangeCode })) } as unknown as PlatformAccountRouteDependencies['connectorRuntime'],
      header: vi.fn(() => undefined),
      ensureOAuthStateReady: vi.fn(),
      consumeOAuthState: vi.fn().mockResolvedValue({ workspaceId: 'ws_isolated_oauth', platform: 'taobao', codeVerifier: 'test-verifier' }),
      persistSnapshot,
      persistEvent,
      send,
    } as unknown as PlatformAccountRouteDependencies

    await expect(handlePlatformAccountRoute(
      { method: 'GET', headers: {}, url: '/v1/oauth/callback/taobao' } as never,
      {} as never,
      '/v1/oauth/callback/taobao',
      new URL('https://merchant.invalid/v1/oauth/callback/taobao?state=one-time-test-state&code=isolated-test-code'),
      deps,
    )).rejects.toBe(exchangeError)

    expect(deps.ensureOAuthStateReady).toHaveBeenCalledOnce()
    expect(deps.consumeOAuthState).toHaveBeenCalledWith('one-time-test-state', 'taobao', undefined)
    expect(exchangeCode).toHaveBeenCalledWith({ code: 'isolated-test-code', state: 'one-time-test-state', workspaceId: 'ws_isolated_oauth', codeVerifier: 'test-verifier' })
    expect(registerPlatformAccount).not.toHaveBeenCalled()
    expect(persistSnapshot).not.toHaveBeenCalled()
    expect(persistEvent).not.toHaveBeenCalled()
    expect(createSyncJob).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
