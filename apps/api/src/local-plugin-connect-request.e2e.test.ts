import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryLocalPluginConnectionRepository } from '../../../packages/persistence/src/local-plugin-connection-repository.js'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import { server, setLocalPluginConnectionRepositoryForTests, setPasswordAuthRepositoryForTests } from './server.js'

async function startApi() {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('API server did not bind')
  return `http://127.0.0.1:${address.port}`
}

type Envelope<T> = { data: T | null; error: { code: string } | null }

describe('local plugin connect request HTTP contract', () => {
  afterEach(async () => {
    if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    setPasswordAuthRepositoryForTests()
    setLocalPluginConnectionRepositoryForTests()
    vi.unstubAllEnvs()
  })

  it('fails closed while the one-click prototype feature gate is disabled', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')
    const auth = new MemoryPasswordAuthRepository()
    setPasswordAuthRepositoryForTests(auth)
    const workspaceId = 'ws_disabled'
    const login = 'connect-disabled@example.test'
    const password = 'ConnectDisabled1234!'
    await auth.createMerchantAccount({ login, password, enterpriseName: 'Connect Disabled', contactName: 'Owner', workspaceIds: [workspaceId], actorId: 'platform', reason: 'connect disabled e2e' })
    const base = await startApi()
    const logged = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password, account_type: 'merchant' }) })
    const cookie = logged.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toBeTruthy()
    const response = await fetch(`${base}/v1/auth/local-plugin/connect-requests`, { method: 'POST', headers: { cookie: cookie!, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: workspaceId }) })
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'LOCAL_PLUGIN_ONE_CLICK_UNAVAILABLE' } })
  })

  it('creates a credential-free helper URL and exposes pollable pending/expired status', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')
    vi.stubEnv('LOCAL_PLUGIN_ONE_CLICK_ENABLED', 'true')
    let now = Date.parse('2026-09-22T10:00:00.000Z')
    setLocalPluginConnectionRepositoryForTests(new MemoryLocalPluginConnectionRepository(() => now, 1_000))
    const auth = new MemoryPasswordAuthRepository()
    setPasswordAuthRepositoryForTests(auth)
    const workspaceId = 'ws_connect_http'
    const login = 'connect-http@example.test'
    const password = 'ConnectHttp1234!'
    await auth.createMerchantAccount({ login, password, enterpriseName: 'Connect HTTP', contactName: 'Owner', workspaceIds: [workspaceId], actorId: 'platform', reason: 'connect request e2e' })
    const base = await startApi()
    const logged = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password, account_type: 'merchant' }) })
    const cookie = logged.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toBeTruthy()

    const createdResponse = await fetch(`${base}/v1/auth/local-plugin/connect-requests`, {
      method: 'POST', headers: { cookie: cookie!, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId }),
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as Envelope<{ request_id: string; launch_url: string; status: string; expires_at: string }>
    expect(created.data).toMatchObject({ status: 'pending' })
    const launch = new URL(created.data!.launch_url)
    expect(launch.protocol).toBe('storenova:')
    expect(Object.fromEntries(launch.searchParams)).toEqual({ api_origin: base, workspace: workspaceId, request_id: created.data!.request_id })
    expect(created.data!.launch_url).not.toMatch(/token|password|code=|secret/u)

    const poll = async () => fetch(`${base}/v1/auth/local-plugin/connect-requests/${created.data!.request_id}/status`, { headers: { cookie: cookie! } })
    const pending = await poll()
    expect(pending.status).toBe(200)
    await expect(pending.json()).resolves.toMatchObject({ data: { request_id: created.data!.request_id, status: 'pending' } })
    now += 1_001
    await expect((await poll()).json()).resolves.toMatchObject({ data: { request_id: created.data!.request_id, status: 'expired' } })
  })

  it('rejects a workspace swap before creating a request', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')
    vi.stubEnv('LOCAL_PLUGIN_ONE_CLICK_ENABLED', 'true')
    const auth = new MemoryPasswordAuthRepository()
    setPasswordAuthRepositoryForTests(auth)
    const login = 'connect-swap@example.test'
    const password = 'ConnectSwap1234!'
    await auth.createMerchantAccount({ login, password, enterpriseName: 'Connect Swap', contactName: 'Owner', workspaceIds: ['ws_owned'], actorId: 'platform', reason: 'connect swap e2e' })
    const base = await startApi()
    const logged = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password, account_type: 'merchant' }) })
    const cookie = logged.headers.get('set-cookie')?.split(';')[0]
    const response = await fetch(`${base}/v1/auth/local-plugin/connect-requests`, { method: 'POST', headers: { cookie: cookie!, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: 'ws_other' }) })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'MCP_OAUTH_WORKSPACE_AMBIGUOUS' } })
  })

  it('rejects creation when the browser Origin header is missing', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')
    vi.stubEnv('LOCAL_PLUGIN_ONE_CLICK_ENABLED', 'true')
    const auth = new MemoryPasswordAuthRepository()
    setPasswordAuthRepositoryForTests(auth)
    const login = 'connect-origin@example.test'
    const password = 'ConnectOrigin1234!'
    await auth.createMerchantAccount({ login, password, enterpriseName: 'Connect Origin', contactName: 'Owner', workspaceIds: ['ws_origin'], actorId: 'platform', reason: 'connect origin e2e' })
    const base = await startApi()
    const logged = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password, account_type: 'merchant' }) })
    const cookie = logged.headers.get('set-cookie')?.split(';')[0]
    const response = await fetch(`${base}/v1/auth/local-plugin/connect-requests`, { method: 'POST', headers: { cookie: cookie!, 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: 'ws_origin' }) })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'AUTH_CSRF_ORIGIN_INVALID' } })
  })
})
