import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
// @ts-ignore JavaScript runtime entrypoint intentionally exercised as shipped.
import { credentialFromResponse, loginLocalPlugin, validateLoginTarget } from '../apps/plugin/scripts/login-local-macos.mjs'
// @ts-ignore JavaScript runtime credential store intentionally exercised as shipped.
import { readKeychainCredential, writeKeychainCredential } from '../apps/plugin/mcp/keychain-credential.mjs'

describe('local plugin login/install contract', () => {
  it('runs PKCE S256 through an exact random 127.0.0.1 callback and stores the bound bundle', async () => {
    let authorize: URL | undefined
    let stored: { target: unknown; bundle: Record<string, string> } | undefined
    const configureSession = vi.fn()
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://merchant.example.test/v1/auth/local-plugin/token')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('error')
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('client_id')).toBe('local-desktop')
      expect(body.get('workspace_id')).toBe('ws_contract')
      expect(body.get('resource')).toBe('https://merchant.example.test/mcp')
      expect(body.get('redirect_uri')).toBe(authorize?.searchParams.get('redirect_uri'))
      const verifier = body.get('code_verifier')!
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(authorize?.searchParams.get('code_challenge'))
      return new Response(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'Bearer',
        scope: 'merchant', workspace_id: 'ws_contract', account_login: 'merchant@example.test', expires_in: 600 }),
      { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await loginLocalPlugin({
      baseUrl: 'https://merchant.example.test', workspaceId: 'ws_contract', timeoutMs: 2_000, fetchImpl,
      openBrowser: async (raw: string) => {
        authorize = new URL(raw)
        expect(authorize.origin).toBe('https://merchant.example.test')
        expect(authorize.pathname).toBe('/v1/auth/local-plugin/authorize')
        expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
        expect(authorize.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/u)
        const callback = new URL(authorize.searchParams.get('redirect_uri')!)
        expect(callback.hostname).toBe('127.0.0.1')
        expect(Number(callback.port)).toBeGreaterThan(0)
        callback.searchParams.set('code', 'authorization-code')
        callback.searchParams.set('state', authorize.searchParams.get('state')!)
        expect((await fetch(callback)).status).toBe(200)
      },
      storeCredential: async (target: unknown, bundle: Record<string, string>) => { stored = { target, bundle } },
      configureSession,
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(stored).toMatchObject({
      target: { apiOrigin: 'https://merchant.example.test', workspaceId: 'ws_contract' },
      bundle: { schema_version: '1', api_origin: 'https://merchant.example.test', workspace_id: 'ws_contract', access_token: 'access-secret', refresh_token: 'refresh-secret' },
    })
    expect(configureSession).toHaveBeenCalledWith({ apiOrigin: 'https://merchant.example.test', workspaceId: 'ws_contract' })
    expect(result).toMatchObject({ ok: true, mode: 'local_stdio', credential_source: 'keychain', host_verified: false })
  })

  it('rejects hostile targets and mismatched token scope without storing credentials', () => {
    for (const baseUrl of ['http://localhost:8787', 'http://0.0.0.0:8787', 'http://[::1]:8787', 'https://user:pass@example.test', 'https://example.test/path']) {
      expect(() => validateLoginTarget(baseUrl, 'ws_contract')).toThrow('LOCAL_PLUGIN_LOGIN_TARGET_INVALID')
    }
    expect(() => credentialFromResponse({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', scope: 'merchant',
      workspace_id: 'ws_other', account_login: 'merchant@example.test', expires_in: 600 },
    { apiOrigin: 'https://merchant.example.test', workspaceId: 'ws_contract' })).toThrow('LOCAL_PLUGIN_LOGIN_RESPONSE_INVALID')
  })

  it('rejects a wrong callback state before token exchange', async () => {
    let tokenRequests = 0
    await expect(loginLocalPlugin({
      baseUrl: 'https://merchant.example.test', workspaceId: 'ws_contract', timeoutMs: 100,
      openBrowser: async (raw: string) => {
        const authorize = new URL(raw)
        const callback = new URL(authorize.searchParams.get('redirect_uri')!)
        callback.searchParams.set('code', 'authorization-code')
        callback.searchParams.set('state', 'wrong-state-value-that-is-long-enough-for-validation')
        expect((await fetch(callback)).status).toBe(400)
      },
      fetchImpl: async () => { tokenRequests += 1; throw new Error('must not exchange') },
      storeCredential: async () => { throw new Error('must not store') },
      configureSession: async () => { throw new Error('must not configure') },
    })).rejects.toThrow('LOCAL_PLUGIN_LOGIN_TIMEOUT')
    expect(tokenRequests).toBe(0)
  })

  it('passes the atomic credential package over stdin, never process argv', () => {
    let captured: Record<string, string> | undefined
    const target = { apiOrigin: 'https://merchant.example.test', workspaceId: 'ws_contract' }
    const bundle = { schema_version: '1', api_origin: target.apiOrigin, workspace_id: target.workspaceId,
      access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: '2030-01-01T00:00:00.000Z' }
    writeKeychainCredential(target, bundle, { runHelper: (request: Record<string, string>) => { captured = request; return '' } })
    expect(captured).toMatchObject({ operation: 'write' })
    const storedData = captured?.data
    if (typeof storedData !== 'string') throw new Error('credential helper did not receive a serialized package')
    expect(JSON.parse(storedData)).toEqual(bundle)
    expect(readKeychainCredential(target, { runHelper: () => storedData })).toEqual(bundle)
  })

  it('CLI help states local-only boundaries and rejects secret-bearing argv', () => {
    const entry = 'apps/plugin/scripts/login-local-macos.mjs'
    const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('不需要 ChatGPT OAuth 或插件市场上架')
    const secretArg = spawnSync(process.execPath, [entry, '--base-url', 'https://merchant.example.test', '--workspace', 'ws_contract', '--access-token', 'secret'], { encoding: 'utf8' })
    expect(secretArg.status).not.toBe(0)
    expect(secretArg.stderr).toContain('LOCAL_PLUGIN_LOGIN_ARGUMENTS_INVALID')
    expect(secretArg.stdout + secretArg.stderr).not.toContain('secret')
  })
})
