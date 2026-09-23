import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryLocalPluginConnectionRepository } from '../../../packages/persistence/src/local-plugin-connection-repository.js'
import { MemoryLocalPluginInstallInstanceRepository } from '../../../packages/persistence/src/local-plugin-install-instance-repository.js'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import { server, setLocalPluginConnectionRepositoryForTests, setLocalPluginInstallInstanceRepositoryForTests, setPasswordAuthRepositoryForTests } from './server.js'

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
    setLocalPluginInstallInstanceRepositoryForTests()
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

  it('requires an explicit owned workspace for multi-workspace requests and status polling', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')
    vi.stubEnv('LOCAL_PLUGIN_ONE_CLICK_ENABLED', 'true')
    const auth = new MemoryPasswordAuthRepository()
    setPasswordAuthRepositoryForTests(auth)
    const login = 'connect-multi@example.test'
    const password = 'ConnectMulti1234!'
    await auth.createMerchantAccount({ login, password, enterpriseName: 'Connect Multi', contactName: 'Owner', workspaceIds: ['ws_first', 'ws_second'], actorId: 'platform', reason: 'connect multi e2e' })
    const base = await startApi()
    const logged = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password, account_type: 'merchant' }) })
    const cookie = logged.headers.get('set-cookie')?.split(';')[0]
    const create = (workspaceId?: string) => fetch(`${base}/v1/auth/local-plugin/connect-requests`, { method: 'POST', headers: { cookie: cookie!, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(workspaceId ? { workspace_id: workspaceId } : {}) })
    expect((await create()).status).toBe(409)
    expect((await create('ws_foreign')).status).toBe(409)
    const created = await create('ws_second')
    expect(created.status).toBe(201)
    const envelope = await created.json() as Envelope<{ request_id: string; launch_url: string }>
    expect(new URL(envelope.data!.launch_url).searchParams.get('workspace')).toBe('ws_second')
    const statusUrl = `${base}/v1/auth/local-plugin/connect-requests/${envelope.data!.request_id}/status`
    expect((await fetch(statusUrl, { headers: { cookie: cookie! } })).status).toBe(409)
    expect((await fetch(`${statusUrl}?workspace_id=ws_first`, { headers: { cookie: cookie! } })).status).toBe(404)
    const status = await fetch(`${statusUrl}?workspace_id=ws_second`, { headers: { cookie: cookie! } })
    expect(status.status).toBe(200)
    await expect(status.json()).resolves.toMatchObject({ data: { status: 'pending' } })
    await auth.activateMerchantAccount({ login, workspaceIds: ['ws_first'], actorId: 'platform', reason: 'remove plugin workspace' })
    expect((await fetch(`${statusUrl}?workspace_id=ws_second`, { headers: { cookie: cookie! } })).status).toBe(409)
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

  it('keeps the same connection request pending when issuing its PKCE code fails, then permits retry', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')
    vi.stubEnv('LOCAL_PLUGIN_ONE_CLICK_ENABLED', 'true')
    const auth = new MemoryPasswordAuthRepository()
    const connections = new MemoryLocalPluginConnectionRepository()
    const instances = new MemoryLocalPluginInstallInstanceRepository()
    setPasswordAuthRepositoryForTests(auth)
    setLocalPluginConnectionRepositoryForTests(connections)
    setLocalPluginInstallInstanceRepositoryForTests(instances)
    const workspaceId = 'ws_code_retry'
    const login = 'connect-code-retry@example.test'
    const password = 'ConnectCodeRetry1234!'
    const account = await auth.createMerchantAccount({ login, password, enterpriseName: 'Code Retry', contactName: 'Owner', workspaceIds: [workspaceId], actorId: 'platform', reason: 'code issuance failure retry' })
    const base = await startApi()
    const logged = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password, account_type: 'merchant' }) })
    const cookie = logged.headers.get('set-cookie')?.split(';')[0]
    const created = await fetch(`${base}/v1/auth/local-plugin/connect-requests`, { method: 'POST', headers: { cookie: cookie!, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: workspaceId }) })
    const request = await created.json() as Envelope<{ request_id: string }>
    expect(created.status).toBe(201)
    const instance = { id: '11111111-1111-4111-8111-111111111111', accountId: account.id, identityId: account.identityId, workspaceId, platform: 'macos' as const, publicKey: 'test', publicKeyFingerprint: 'test', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }
    vi.spyOn(instances, 'getForOwner').mockResolvedValue(instance)
    const consumed = vi.spyOn(instances, 'verifyAndConsumeChallenge').mockResolvedValue(instance)
    const verifier = 'code-issuance-retry-verifier-00000000000000000000000'
    const form = new URLSearchParams({ response_type: 'code', client_id: 'local-desktop', redirect_uri: 'http://127.0.0.1:18992/merchant-mcp-callback', state: 'x'.repeat(43), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'merchant', resource: `${base}/mcp`, workspace_id: workspaceId, connection_request_id: request.data!.request_id, installation_id: instance.id, challenge_id: '22222222-2222-4222-8222-222222222222', instance_signature: 's'.repeat(86), client_nonce: 'c'.repeat(43), server_nonce: 'n'.repeat(43), challenge_issued_at: new Date().toISOString(), challenge_expires_at: new Date(Date.now() + 120_000).toISOString() })
    vi.spyOn(auth, 'issueMcpAuthorizationCode').mockRejectedValueOnce(new Error('injected issuance failure'))
    const authorize = () => fetch(`${base}/v1/auth/local-plugin/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie: cookie!, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: form })
    const failed = await authorize()
    expect(failed.status).toBe(500)
    expect(failed.headers.get('location')).toBeNull()
    expect(consumed).not.toHaveBeenCalled()
    expect(await connections.getForAccount({ id: request.data!.request_id, accountId: account.id, workspaceId })).toMatchObject({ status: 'pending' })
    const retried = await authorize()
    expect(retried.status).toBe(303)
    expect(new URL(retried.headers.get('location')!).searchParams.get('code')).toBeTruthy()
    expect(consumed).toHaveBeenCalledOnce()
    expect(await connections.getForAccount({ id: request.data!.request_id, accountId: account.id, workspaceId })).toMatchObject({ status: 'authorized' })
  })
})
