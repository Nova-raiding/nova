import { describe, expect, it, vi } from 'vitest'
import {
  createConfiguredConnector, credentialRefreshKey, InProcessCredentialRefreshLock, RedisCredentialRefreshLock,
  type AccessCredential, type CredentialProvider, type HttpConnectorConfig, type PlatformConnector,
} from './index.js'

const future = () => new Date(Date.now() + 3_600_000).toISOString()
const expired = () => new Date(Date.now() - 60_000).toISOString()

function readyConfig(): HttpConnectorConfig {
  return {
    clientId: 'app-test',
    clientSecret: 'secret-is-never-logged',
    oauth: { authorizeUrl: 'https://platform.test/oauth/authorize', tokenUrl: 'https://platform.test/oauth/token', refreshUrl: 'https://platform.test/oauth/refresh' },
    api: { baseUrl: 'https://platform.test/api', syncPath: '/products', createPath: '/products', updatePath: '/products/update', queryPath: '/publish/status' },
    timeoutMs: 500,
    signer: { kind: 'test', sign: () => ({ 'x-platform-signature': 'test-only-adapter' }) },
    mapProducts: () => [],
    mappingEvidence: { version: 'test.mapping.v1', evidenceRef: 'test-only', verifiedBy: 'unit-test', verifiedAt: '2026-08-22T00:00:00Z' },
    capabilityEvidence: ['refresh', 'read', 'full_sync', 'incremental_sync'].map(capability => ({ platform: 'jd' as const, capability: capability as never, state: 'test_e2e' as const, evidenceRef: 'test-only', verifiedBy: 'unit-test', verifiedAt: '2026-08-22T00:00:00Z' })),
  }
}

/** Vault-shaped store: `resolve` always returns whatever the vault currently
 * holds, so the test can observe the write-back that a real refresh performs. */
function vaultStore(initial: AccessCredential) {
  let current = initial
  const writes: AccessCredential[] = []
  const store = {
    kind: 'test' as const,
    writes,
    current: () => current,
    set(value: AccessCredential) { current = value },
    async resolve() { return current },
    async store({ accountId, credential }: { accountId: string; credential: AccessCredential }) { current = credential; writes.push(credential); return { accountId, credentialRef: `vault://${accountId}` } },
  }
  return store
}

const context = { workspaceId: 'ws-refresh', accountId: 'acct-refresh', credentialRef: 'vault://acct-refresh' }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }

function refusal() { return { tryAcquire: async () => undefined } }

describe('credential refresh single flight', () => {
  it('issues one refresh when two requests for one account race in one process', async () => {
    const store = vaultStore({ accessToken: 'stale', refreshToken: 'rt-1', expiresAt: expired() })
    let refreshCalls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/oauth/refresh')) {
        refreshCalls += 1
        await gate
        return response({ access_token: 'fresh-1', refresh_token: 'rt-2', expires_in: 300 })
      }
      return response({ items: [] })
    })
    const connector = createConfiguredConnector('jd', {
      config: readyConfig(), credentials: store, fetch: fetchMock, refreshLock: new InProcessCredentialRefreshLock(),
      refreshPollMs: 5, refreshWaitMs: 1_000, allowTestCredentials: true, allowTestAdapters: true,
    })
    const first = connector.syncProducts(context)
    await tick()
    const second = connector.syncProducts(context)
    release()
    await Promise.all([first, second])
    expect(refreshCalls).toBe(1)
    expect(store.writes).toHaveLength(1)
    const refreshRequests = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/oauth/refresh'))
    expect(refreshRequests).toHaveLength(1)
  })

  it('adopts the credential a concurrent refresher stored instead of overwriting it', async () => {
    const store = vaultStore({ accessToken: 'stale', refreshToken: 'rt-1', expiresAt: expired() })
    const authorizations: string[] = []
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/oauth/refresh')) {
        // The other replica won the rotation while this POST was in flight.
        store.set({ accessToken: 'winner', refreshToken: 'rt-winner', expiresAt: future() })
        return response({ access_token: 'loser-token', refresh_token: 'rt-loser', expires_in: 300 })
      }
      authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''))
      return response({ items: [] })
    })
    const connector = createConfiguredConnector('jd', {
      config: readyConfig(), credentials: store, fetch: fetchMock, refreshLock: new InProcessCredentialRefreshLock(),
      allowTestCredentials: true, allowTestAdapters: true,
    })
    await connector.syncProducts(context)
    // The losing refresh must never clobber the refresh token that survived.
    expect(store.writes).toHaveLength(0)
    expect(store.current()).toMatchObject({ accessToken: 'winner', refreshToken: 'rt-winner' })
    expect(authorizations.at(-1)).toBe('Bearer winner')
  })

  it('waits for the lease holder and adopts the credential it stored', async () => {
    const store = vaultStore({ accessToken: 'stale', refreshToken: 'rt-1', expiresAt: expired() })
    let resolves = 0
    const provider: CredentialProvider = {
      kind: 'test',
      async resolve() { resolves += 1; return resolves > 1 ? { accessToken: 'from-winner', refreshToken: 'rt-2', expiresAt: future() } : { accessToken: 'stale', refreshToken: 'rt-1', expiresAt: expired() } },
      async store({ accountId, credential }) { store.set(credential); return { accountId, credentialRef: `vault://${accountId}` } },
    }
    const authorizations: string[] = []
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/oauth/refresh')) throw new Error('the waiting replica must not refresh')
      authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''))
      return response({ items: [] })
    })
    const connector = createConfiguredConnector('jd', {
      config: readyConfig(), credentials: provider, fetch: fetchMock, refreshLock: refusal(),
      refreshPollMs: 1, refreshWaitMs: 500, allowTestCredentials: true, allowTestAdapters: true,
    })
    await connector.syncProducts(context)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/oauth/refresh'))).toBe(false)
    expect(authorizations.at(-1)).toBe('Bearer from-winner')
  })

  it('refreshes under the read-modify-write guard when the lease store is unavailable', async () => {
    const store = vaultStore({ accessToken: 'stale', refreshToken: 'rt-1', expiresAt: expired() })
    const fetchMock = vi.fn(async (url: string | URL) => String(url).endsWith('/oauth/refresh')
      ? response({ access_token: 'fresh', refresh_token: 'rt-2', expires_in: 300 })
      : response({ items: [] }))
    const connector = createConfiguredConnector('jd', {
      config: readyConfig(), credentials: store, fetch: fetchMock,
      refreshLock: { tryAcquire: async () => { throw new Error('lease store unavailable') } },
      refreshPollMs: 1, refreshWaitMs: 1, allowTestCredentials: true, allowTestAdapters: true,
    })
    await connector.syncProducts(context)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/oauth/refresh'))).toHaveLength(1)
    expect(store.current()).toMatchObject({ accessToken: 'fresh', refreshToken: 'rt-2' })
  })

  it('classifies a rotated-refresh-token invalid_grant as retryable instead of terminal', async () => {
    const store = vaultStore({ accessToken: 'stale', refreshToken: 'rt-1', expiresAt: expired() })
    const connector = createConfiguredConnector('jd', {
      config: readyConfig(), credentials: store,
      fetch: async (url: string | URL) => String(url).endsWith('/oauth/refresh')
        ? response({ error: 'invalid_grant', error_description: 'refresh token has been reused' }, 400)
        : response({ items: [] }),
      refreshLock: new InProcessCredentialRefreshLock(), allowTestCredentials: true, allowTestAdapters: true,
    })
    await expect(connector.syncProducts(context)).rejects.toMatchObject({
      normalized: {
        code: 'UNAUTHORIZED', retryable: true, status: 400,
        details: { oauthErrorCode: 'invalid_grant', refreshRace: true },
      },
    })
    expect(store.writes).toHaveLength(0)
  })

  it('keeps an unrecoverable refresh rejection terminal', async () => {
    const store = vaultStore({ accessToken: 'stale', refreshToken: 'rt-1', expiresAt: expired() })
    const connector = createConfiguredConnector('jd', {
      config: readyConfig(), credentials: store,
      fetch: async (url: string | URL) => String(url).endsWith('/oauth/refresh')
        ? response({ error: 'invalid_client', error_description: 'client authentication failed' }, 401)
        : response({ items: [] }),
      refreshLock: new InProcessCredentialRefreshLock(), allowTestCredentials: true, allowTestAdapters: true,
    })
    await expect(connector.syncProducts(context)).rejects.toMatchObject({ normalized: { code: 'UNAUTHORIZED', retryable: false, status: 401 } })
  })

  it('scopes the lease key to the workspace, platform and account', () => {
    const base = { platform: 'jd', workspaceId: 'ws-one', accountId: 'acct-one' }
    const key = credentialRefreshKey(base)
    expect(key).toMatch(/^merchant:connector:refresh:[a-f0-9]{64}$/u)
    expect(credentialRefreshKey({ ...base, workspaceId: 'ws-two' })).not.toBe(key)
    expect(credentialRefreshKey({ ...base, accountId: 'acct-two' })).not.toBe(key)
    expect(credentialRefreshKey({ ...base, platform: 'taobao' })).not.toBe(key)
    // Ambiguous identity separators must not collide: (a|bc) never equals (ab|c).
    expect(credentialRefreshKey({ platform: 'jd', workspaceId: 'a\nbc', accountId: 'x' })).not.toBe(credentialRefreshKey({ platform: 'jd', workspaceId: 'a', accountId: 'bc\nx' }))
  })
})

describe('refresh lease implementations', () => {
  it('serializes one lease per key in process and expires it by ttl', async () => {
    let now = 1_000
    const lock = new InProcessCredentialRefreshLock(() => now)
    const first = await lock.tryAcquire('key', 50)
    expect(first).toBeDefined()
    expect(await lock.tryAcquire('key', 50)).toBeUndefined()
    expect(await lock.tryAcquire('other-key', 50)).toBeDefined()
    await first!.release()
    expect(await lock.tryAcquire('key', 50)).toBeDefined()
    const third = await lock.tryAcquire('key', 50)
    expect(third).toBeUndefined()
    now += 1_000
    // An expired lease is reclaimable, and the stale owner may not delete it.
    const fourth = await lock.tryAcquire('key', 50)
    expect(fourth).toBeDefined()
    await first!.release()
    expect(await lock.tryAcquire('key', 50)).toBeUndefined()
    await fourth!.release()
    expect(await lock.tryAcquire('key', 50)).toBeDefined()
  })

  it('uses SET NX semantics and compare-and-delete through the injected Redis port', async () => {
    const values = new Map<string, string>()
    const port = {
      setIfAbsent: async (key: string, value: string) => { if (values.has(key)) return false; values.set(key, value); return true },
      deleteIfValue: async (key: string, value: string) => { if (values.get(key) === value) values.delete(key) },
    }
    const lock = new RedisCredentialRefreshLock(port)
    const first = await lock.tryAcquire('lease-key', 1_000)
    expect(first).toBeDefined()
    expect(values.size).toBe(1)
    expect(await lock.tryAcquire('lease-key', 1_000)).toBeUndefined()
    // A release from a process that no longer owns the lease is a no-op.
    values.set('lease-key', 'someone-else')
    await first!.release()
    expect(values.get('lease-key')).toBe('someone-else')
    values.delete('lease-key')
    expect(await lock.tryAcquire('lease-key', 1_000)).toBeDefined()
    await expect(lock.tryAcquire('lease-key', 0)).rejects.toThrow('TTL')
  })
})

describe('refresh-capable connector surface', () => {
  it('exposes refresh and never persists a raw access token in the credential ref', async () => {
    const store = vaultStore({ accessToken: 'stale', refreshToken: 'rt-1', expiresAt: expired() })
    const connector: PlatformConnector = createConfiguredConnector('jd', {
      config: readyConfig(), credentials: store,
      fetch: async (url: string | URL) => String(url).endsWith('/oauth/refresh') ? response({ access_token: 'fresh-access-token', refresh_token: 'rt-2', expires_in: 300 }) : response({ items: [] }),
      refreshLock: new InProcessCredentialRefreshLock(), allowTestCredentials: true, allowTestAdapters: true,
    })
    const ref = await connector.refreshCredential(context)
    expect(ref).toMatchObject({ accountId: context.accountId, credentialRef: context.credentialRef, expiresAt: expect.any(String), refreshable: true })
    expect(JSON.stringify(ref)).not.toContain('fresh-access-token')
    expect(JSON.stringify(ref)).not.toContain('rt-2')
  })
})
