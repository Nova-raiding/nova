import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error Native Node installer module intentionally has no build step.
import { main } from './login-local-windows.mjs'

describe('Windows local plugin login', () => {
  it('prints actionable help without loading Windows credential or session services', async () => {
    let printed = ''
    const output = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      printed += String(chunk)
      return true
    })
    try {
      // The packaged login.cmd prepends --base-url before forwarding user args.
      await expect(main(['--base-url', 'https://yxsona.com', '--help'], { platform: 'linux' })).resolves.toBeUndefined()
      expect(printed).toContain('login-local-windows.mjs --base-url https://yxsona.com --workspace ws_xxx')
      expect(printed).toContain('Windows Credential Manager')
      expect(printed).toContain('不需要 ChatGPT OAuth')
    } finally { output.mockRestore() }
  })

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

  it('does not persist credentials or configure a session when browser authorization fails', async () => {
    let stored = false
    let configured = false
    await expect(main(['--base-url', 'https://example.test', '--workspace', 'ws_test'], {
      platform: 'win32', assertCredentialReady: () => {},
      openBrowser: () => { throw new Error('sensitive browser failure') },
      storeCredential: () => { stored = true },
      configureSession: () => { configured = true },
      timeoutMs: 2000,
    })).rejects.toThrow('LOCAL_PLUGIN_LOGIN_FAILED')
    expect(stored).toBe(false)
    expect(configured).toBe(false)
  })
})
