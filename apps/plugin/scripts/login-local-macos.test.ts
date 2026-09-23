import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Native Node installer module intentionally has no build step.
import { credentialFromResponse, loginLocalPlugin, validateLoginTarget } from './login-local-macos.mjs'

describe('local plugin login installer runtime', () => {
  it.each(['https://u:p@example.test', 'https://example.test/?token=x', 'https://example.test/mcp', 'http://example.test', 'http://localhost:1234', ' https://example.test', 'https://example.test/#x'])('rejects unsafe target %s', base => {
    expect(() => validateLoginTarget(base, 'ws_test')).toThrow('TARGET_INVALID')
  })

  it('rejects a different workspace before persisting credentials', () => {
    expect(() => credentialFromResponse({ data: { access_token: 'a', refresh_token: 'b', token_type: 'Bearer', scope: 'merchant', expires_in: 600, workspace_id: 'ws_other', account_login: 'test@example.test' } }, { apiOrigin: 'https://example.test', workspaceId: 'ws_test' })).toThrow('RESPONSE_INVALID')
  })

  it('rejects malformed connection request identifiers before opening the browser', async () => {
    await expect(loginLocalPlugin({ baseUrl: 'https://example.test', workspaceId: 'ws_test', requestId: 'secret in url',
      openBrowser: () => {}, storeCredential: () => {}, configureSession: () => {} })).rejects.toThrow('REQUEST_ID_INVALID')
  })

  it.each(['keychain', 'windows_credential_manager'])('drives the real listener for %s, rejects forged callback, then persists before configuring', async credentialSource => {
    let authorization: URL
    let exchanges = 0
    const events: string[] = []
    const provider = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const form = new URLSearchParams(Buffer.concat(chunks).toString())
      expect(req.url).toBe('/v1/auth/local-plugin/token')
      expect(form.get('grant_type')).toBe('authorization_code')
      expect(form.get('client_id')).toBe('local-desktop')
      expect(form.get('workspace_id')).toBe('ws_test')
      expect(form.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'))
      expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'))
      exchanges++
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { access_token: 'synthetic-access-secret', refresh_token: 'synthetic-refresh-secret', token_type: 'Bearer', scope: 'merchant', expires_in: 600, workspace_id: 'ws_test', account_login: 'test@example.test' } }))
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    try {
      const address = provider.address() as { port: number }
      const result = await loginLocalPlugin({ baseUrl: `http://127.0.0.1:${address.port}`, workspaceId: 'ws_test', requestId: 'req_1234567890abcdef', credentialSource,
        openBrowser: async (url: string) => {
          authorization = new URL(url)
          expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
          expect(authorization.searchParams.get('connection_request_id')).toBe('req_1234567890abcdef')
          expect(authorization.searchParams.has('code_verifier')).toBe(false)
          const callback = new URL(authorization.searchParams.get('redirect_uri')!)
          callback.searchParams.set('code', 'one-time-code-long-enough')
          callback.searchParams.set('state', '中'.repeat(43))
          expect((await fetch(callback)).status).toBe(400)
          callback.searchParams.set('state', authorization.searchParams.get('state')!)
          expect((await fetch(callback)).status).toBe(200)
        },
        storeCredential: async (target: { workspaceId: string }, bundle: { workspace_id: string }) => {
          expect(target.workspaceId).toBe('ws_test')
          expect(bundle.workspace_id).toBe('ws_test')
          events.push('stored')
        },
        configureSession: async () => { events.push('configured') }, timeoutMs: 2000,
      })
      expect(exchanges).toBe(1)
      expect(events).toEqual(['stored', 'configured'])
      expect(result).toMatchObject({ ok: true, host_verified: false, credential_source: credentialSource, restart_required: true })
      expect(JSON.stringify(result)).not.toMatch(/synthetic|access_token|refresh_token/u)
    } finally { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())) }
  })

  it('times out without touching credentials or launchd', async () => {
    let writes = 0
    await expect(loginLocalPlugin({ baseUrl: 'https://example.test', workspaceId: 'ws_test', openBrowser: async () => {}, storeCredential: () => { writes++ }, configureSession: () => { writes++ }, timeoutMs: 50 })).rejects.toThrow('TIMEOUT')
    expect(writes).toBe(0)
  })

  it('aborts an in-flight token exchange without storing or configuring', async () => {
    const controller = new AbortController()
    let writes = 0
    let exchangeSignal: AbortSignal | undefined
    await expect(loginLocalPlugin({
      baseUrl: 'https://example.test', workspaceId: 'ws_test', signal: controller.signal,
      openBrowser: async (url: string) => {
        const authorization = new URL(url)
        const callback = new URL(authorization.searchParams.get('redirect_uri')!)
        callback.searchParams.set('code', 'one-time-code-long-enough')
        callback.searchParams.set('state', authorization.searchParams.get('state')!)
        expect((await fetch(callback)).status).toBe(200)
      },
      fetchImpl: async (_url: string, init: RequestInit) => {
        exchangeSignal = init.signal as AbortSignal
        controller.abort()
        throw exchangeSignal.reason
      },
      storeCredential: () => { writes++ }, configureSession: () => { writes++ }, timeoutMs: 2000,
    })).rejects.toThrow('CANCELLED')
    expect(exchangeSignal).not.toBe(controller.signal)
    expect(exchangeSignal?.aborted).toBe(true)
    expect(writes).toBe(0)
  })

  it('revokes a late token response after caller cancellation before storing', async () => {
    const controller = new AbortController()
    const requests: Array<{ url: string; body: string }> = []
    let writes = 0
    await expect(loginLocalPlugin({
      baseUrl: 'https://example.test', workspaceId: 'ws_test', signal: controller.signal,
      openBrowser: async (url: string) => {
        const authorization = new URL(url)
        const callback = new URL(authorization.searchParams.get('redirect_uri')!)
        callback.searchParams.set('code', 'one-time-code-long-enough')
        callback.searchParams.set('state', authorization.searchParams.get('state')!)
        expect((await fetch(callback)).status).toBe(200)
      },
      fetchImpl: async (url: string, init: RequestInit) => {
        requests.push({ url, body: String(init.body ?? '') })
        if (url.endsWith('/v1/auth/local-plugin/token')) {
          controller.abort()
          return new Response(JSON.stringify({ data: { access_token: 'late-access-secret', refresh_token: 'late-refresh-secret', token_type: 'Bearer', scope: 'merchant', expires_in: 600, workspace_id: 'ws_test', account_login: 'test@example.test' } }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({ data: { revoked: true } }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
      storeCredential: () => { writes++ }, configureSession: () => { writes++ }, timeoutMs: 2000,
    })).rejects.toThrow('CANCELLED')
    expect(requests.map(request => new URL(request.url).pathname)).toEqual(['/v1/auth/local-plugin/token', '/v1/auth/mcp-token/revoke'])
    expect(JSON.parse(requests[1]!.body)).toEqual({ refresh_token: 'late-refresh-secret' })
    expect(writes).toBe(0)
  })

  it('does not propagate secret-bearing transport errors', async () => {
    await expect(loginLocalPlugin({ baseUrl: 'https://example.test', workspaceId: 'ws_test', openBrowser: async () => { throw new Error('password=should-never-print') }, storeCredential: () => {}, configureSession: () => {} })).rejects.toThrow(/^LOCAL_PLUGIN_LOGIN_FAILED$/u)
  })

  it('provides a runnable help command without touching credentials', () => {
    const result = spawnSync(process.execPath, ['apps/plugin/scripts/login-local-macos.mjs', '--help'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('不需要 ChatGPT OAuth')
    expect(result.stdout).toContain('--workspace')
  })
})
