import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
// @ts-expect-error The shipped installer is a native Node ESM entrypoint without generated declarations.
import { loginLocalPlugin } from '../../plugin/scripts/login-local-macos.mjs'
import { server, setPasswordAuthRepositoryForTests, workspaceMembers } from './server.js'

async function startApi(): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('API server did not bind')
  return `http://127.0.0.1:${address.port}`
}

describe('local plugin installer and API integration', () => {
  afterEach(async () => {
    if (server.listening) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    setPasswordAuthRepositoryForTests()
    vi.unstubAllEnvs()
  })

  it('completes CLI PKCE login through real consent, loopback redirect, and token HTTP endpoints', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')

    const repository = new MemoryPasswordAuthRepository()
    setPasswordAuthRepositoryForTests(repository)
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const workspaceId = `workspace_local_installer_${suffix}`
    const login = `local-installer-${suffix}@example.test`
    const password = 'LocalInstaller1234!'
    const account = await repository.createMerchantAccount({
      login,
      password,
      enterpriseName: 'Local Installer Integration',
      contactName: 'Owner',
      workspaceIds: [workspaceId],
      actorId: 'platform-operator',
      reason: 'local plugin installer integration test',
    })
    await workspaceMembers.upsert({ workspaceId, externalSubject: login, displayName: 'Owner', role: 'workspace_owner', status: 'active', invitedBy: 'local-plugin-installer-integration' })
    await workspaceMembers.bindIdentity({ workspaceId, externalSubject: login, identityId: account.identityId })

    const baseUrl = await startApi()
    let stored: { target: Record<string, string>; bundle: Record<string, string> } | undefined
    const events: string[] = []

    const result = await loginLocalPlugin({
      baseUrl,
      workspaceId,
      openBrowser: async (authorizeUrl: string) => {
        const authorization = new URL(authorizeUrl)
        expect(authorization.origin).toBe(baseUrl)
        expect(authorization.pathname).toBe('/v1/auth/local-plugin/authorize')
        expect(authorization.searchParams.get('workspace_id')).toBe(workspaceId)
        expect(authorization.searchParams.get('resource')).toBe(`${baseUrl}/mcp`)
        expect(authorization.searchParams.has('code_verifier')).toBe(false)

        const logged = await fetch(`${baseUrl}/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ login, password, account_type: 'merchant' }),
        })
        expect(logged.status).toBe(200)
        const cookie = logged.headers.get('set-cookie')?.split(';')[0]
        expect(cookie).toBeTruthy()

        const consent = await fetch(authorization, { headers: { cookie: cookie! } })
        expect(consent.status).toBe(200)
        const consentHtml = await consent.text()
        expect(consentHtml).toContain('确认授权本地插件')
        expect(consentHtml).toContain(workspaceId)
        expect(consentHtml).not.toContain(password)

        const approved = await fetch(`${baseUrl}/v1/auth/local-plugin/authorize`, {
          method: 'POST',
          headers: {
            cookie: cookie!,
            origin: baseUrl,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(authorization.searchParams),
        })
        expect(approved.status).toBe(200)
        expect(await approved.text()).toContain('Store Nova 已收到授权回调')
        events.push('browser-consent-complete')
      },
      storeCredential: async (target: Record<string, string>, bundle: Record<string, string>) => {
        stored = { target, bundle }
        events.push('credential-stored')
      },
      configureSession: async () => { events.push('session-configured') },
      timeoutMs: 5_000,
    })

    expect(events).toEqual(['browser-consent-complete', 'credential-stored', 'session-configured'])
    expect(result).toMatchObject({ ok: true, mode: 'local_stdio', workspace_id: workspaceId, api_origin: baseUrl })
    expect(stored?.target).toMatchObject({ apiOrigin: baseUrl, workspaceId })
    expect(stored?.bundle).toMatchObject({ schema_version: '1', api_origin: baseUrl, workspace_id: workspaceId })
    expect(stored?.bundle.access_token).toMatch(/^[\x21-\x7e]+$/u)
    expect(stored?.bundle.refresh_token).toMatch(/^[\x21-\x7e]+$/u)
    expect(JSON.stringify(result)).not.toMatch(/access_token|refresh_token/u)
  })

  it('revokes a real late-arriving token family when cancellation wins before persistence', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')

    const repository = new MemoryPasswordAuthRepository()
    setPasswordAuthRepositoryForTests(repository)
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const workspaceId = `ws_cancel_${suffix}`
    const login = `local-cancel-${suffix}@example.test`
    const password = 'LocalCancel1234!'
    const account = await repository.createMerchantAccount({ login, password, enterpriseName: 'Local Cancel Integration', contactName: 'Owner', workspaceIds: [workspaceId], actorId: 'platform-operator', reason: 'local plugin cancellation integration test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: login, displayName: 'Owner', role: 'workspace_owner', status: 'active', invitedBy: 'local-plugin-cancellation-integration' })
    await workspaceMembers.bindIdentity({ workspaceId, externalSubject: login, identityId: account.identityId })

    const baseUrl = await startApi()
    const controller = new AbortController()
    let accessToken = ''
    let revokeRequests = 0
    let writes = 0

    await expect(loginLocalPlugin({
      baseUrl,
      workspaceId,
      signal: controller.signal,
      openBrowser: async (authorizeUrl: string) => {
        const authorization = new URL(authorizeUrl)
        const logged = await fetch(`${baseUrl}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password, account_type: 'merchant' }) })
        const cookie = logged.headers.get('set-cookie')?.split(';')[0]
        expect(cookie).toBeTruthy()
        const consent = await fetch(authorization, { headers: { cookie: cookie! } })
        expect(consent.status).toBe(200)
        const approved = await fetch(`${baseUrl}/v1/auth/local-plugin/authorize`, {
          method: 'POST',
          headers: { cookie: cookie!, origin: baseUrl, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(authorization.searchParams),
        })
        expect(approved.status).toBe(200)
      },
      fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
        const response = await fetch(input, init)
        const pathname = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname
        if (pathname === '/v1/auth/local-plugin/token') {
          const payload = await response.text()
          const envelope = JSON.parse(payload) as { data?: { access_token?: string } }
          accessToken = envelope.data?.access_token ?? ''
          controller.abort()
          return new Response(payload, { status: response.status, headers: response.headers })
        } else if (pathname === '/v1/auth/mcp-token/revoke') revokeRequests++
        return response
      },
      storeCredential: () => { writes++ },
      configureSession: () => { writes++ },
      timeoutMs: 5_000,
    })).rejects.toThrow('CANCELLED')

    expect(accessToken).not.toBe('')
    expect(revokeRequests).toBe(1)
    expect(writes).toBe(0)
    await expect(repository.authenticateMcpAccessToken({
      clientId: 'local-desktop', issuer: baseUrl, audience: `${baseUrl}/mcp`, resource: `${baseUrl}/mcp`, scope: ['merchant'], accessToken,
    })).resolves.toBeUndefined()
  })
})
