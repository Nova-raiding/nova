import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error Native Node installer module intentionally has no build step.
import { main } from './login-local-windows.mjs'

describe('Windows local plugin login', () => {
  it('prints the authorization URL and completes the callback in --no-open mode', async () => {
    let printed = ''
    let stored = false
    let configured = false
    const callbackRequests: Promise<unknown>[] = []
    const output = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      printed += String(chunk)
      const url = String(chunk).match(/https:\/\/example\.test\/v1\/auth\/local-plugin\/authorize\?[^\s]+/u)?.[0]
      if (url) {
        const authorization = new URL(url)
        const callback = new URL(authorization.searchParams.get('redirect_uri')!)
        callback.searchParams.set('code', 'one-time-code-long-enough')
        callback.searchParams.set('state', authorization.searchParams.get('state')!)
        callbackRequests.push(fetch(callback).then(response => expect(response.status).toBe(200)))
      }
      return true
    })
    try {
      const result = await main(['--base-url', 'https://example.test', '--workspace', 'ws_test', '--no-open'], {
        platform: 'win32', assertCredentialReady: () => {},
        fetchImpl: async () => new Response(JSON.stringify({ data: {
          access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'Bearer', scope: 'merchant',
          expires_in: 600, workspace_id: 'ws_test', account_login: 'customer@example.test',
        } }), { status: 200, headers: { 'content-type': 'application/json' } }),
        storeCredential: () => { stored = true },
        configureSession: () => { configured = true },
        timeoutMs: 2000,
      })
      await Promise.all(callbackRequests)
      expect(printed).toContain('请在商家浏览器打开此授权地址')
      expect(printed).toContain('code_challenge_method=S256')
      expect(printed).not.toMatch(/access-secret|refresh-secret|code_verifier/u)
      expect(result).toMatchObject({ ok: true, workspace_id: 'ws_test', credential_source: 'windows_credential_manager' })
      expect(stored).toBe(true)
      expect(configured).toBe(true)
    } finally { output.mockRestore() }
  })
})
