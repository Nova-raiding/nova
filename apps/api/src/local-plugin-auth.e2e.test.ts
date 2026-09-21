import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import { server, setPasswordAuthRepositoryForTests, workspaceMembers } from './server.js'

async function start() {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

describe('local plugin browser PKCE', () => {
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    setPasswordAuthRepositoryForTests()
    vi.unstubAllEnvs()
  })

  it('requires explicit same-origin consent and exchanges each code once', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')
    const repository = new MemoryPasswordAuthRepository()
    setPasswordAuthRepositoryForTests(repository)
    const workspaceId = `ws_local_pkce_${Date.now()}`
    const login = `local-pkce-${Date.now()}@example.test`
    const password = 'LocalPkce1234!'
    const account = await repository.createMerchantAccount({ login, password, enterpriseName: 'Local PKCE', contactName: 'Owner', workspaceIds: [workspaceId], actorId: 'platform-operator', reason: 'local plugin PKCE e2e' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: login, displayName: 'Owner', role: 'workspace_owner', status: 'active', invitedBy: 'local-plugin-pkce-e2e' })
    await workspaceMembers.bindIdentity({ workspaceId, externalSubject: login, identityId: account.identityId })
    const base = await start()
    let callbackUrl = ''
    const callbackServer = createServer((req, res) => { callbackUrl = req.url ?? ''; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('authorization received') })
    await new Promise<void>((resolve, reject) => { callbackServer.once('error', reject); callbackServer.listen(0, '127.0.0.1', resolve) })
    const callbackAddress = callbackServer.address()
    if (!callbackAddress || typeof callbackAddress === 'string') throw new Error('callback server did not bind')
    const redirectUri = `http://127.0.0.1:${callbackAddress.port}/merchant-mcp-callback`
    const verifier = 'local-plugin-pkce-verifier-000000000000000000000000000000000000'
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = 'x'.repeat(43)
    const authorization = new URL(`${base}/v1/auth/local-plugin/authorize`)
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: 'local-desktop', redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', scope: 'merchant', resource: `${base}/mcp`, workspace_id: workspaceId })) authorization.searchParams.set(key, value)

    const unauthenticated = await fetch(authorization)
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.text()).toContain('新标签页打开商家后台登录')

    const logged = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password, account_type: 'merchant' }) })
    const cookie = logged.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toBeTruthy()
    const consent = await fetch(authorization, { headers: { cookie: cookie! } })
    expect(consent.status).toBe(200)
    const consentHtml = await consent.text()
    expect(consentHtml).toContain('确认授权本地插件')
    expect(consentHtml).not.toContain(password)

    const form = new URLSearchParams(authorization.searchParams)
    const crossOrigin = await fetch(`${base}/v1/auth/local-plugin/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie: cookie!, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: form })
    expect(crossOrigin.status).toBe(403)
    const approved = await fetch(`${base}/v1/auth/local-plugin/authorize`, { method: 'POST', headers: { cookie: cookie!, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: form })
    expect(approved.status).toBe(200)
    expect(await approved.text()).toBe('authorization received')
    const callback = new URL(callbackUrl, redirectUri)
    expect(callback.origin + callback.pathname).toBe(redirectUri)
    expect(callback.searchParams.get('state')).toBe(state)
    const code = callback.searchParams.get('code')!
    await new Promise<void>(resolve => callbackServer.close(() => resolve()))

    const tokenForm = new URLSearchParams({ grant_type: 'authorization_code', client_id: 'local-desktop', redirect_uri: redirectUri, code, code_verifier: verifier, resource: `${base}/mcp`, workspace_id: workspaceId })
    const exchanged = await fetch(`${base}/v1/auth/local-plugin/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tokenForm })
    expect(exchanged.status).toBe(200)
    const envelope = await exchanged.json() as { data?: Record<string, unknown> & { result?: Record<string, unknown> } }
    const result = envelope.data?.result ?? envelope.data
    expect(result).toMatchObject({ token_type: 'Bearer', scope: 'merchant', expires_in: 600, workspace_id: workspaceId, account_login: login })
    expect(typeof result?.access_token).toBe('string')
    expect(typeof result?.refresh_token).toBe('string')

    const replay = await fetch(`${base}/v1/auth/local-plugin/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tokenForm })
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({ error: { code: 'MCP_OAUTH_INVALID_GRANT' } })
  })
})
