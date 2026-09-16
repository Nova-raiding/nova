import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalPluginConnectionError, requestLocalPluginCredential, type LocalPluginAccount } from './local-plugin-connection'

const account: LocalPluginAccount = {
  id: 'account_merchant', login: 'merchant@example.test', accountType: 'merchant', status: 'active', workspaceIds: ['ws_merchant'],
}
const tokenData = () => ({
  access_token: 'secret-access-never-expose', refresh_token: 'secret-refresh-never-expose',
  token_type: 'Bearer', expires_in: 600, scope: 'merchant',
  workspace_id: 'ws_merchant', account_login: 'merchant@example.test',
})
const origin = (value: string) => vi.stubGlobal('window', { location: { origin: value } })
const ok = (data: unknown = tokenData()) => ({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ data, error: null }) })

describe('local plugin credential request', () => {
  beforeEach(() => {
    origin('https://merchant.example.test')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok()))
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-16T00:00:00.000Z'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses only the same-origin session and returns safe metadata, never the issued tokens', async () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('sessionStorage', storage)
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    const result = await requestLocalPluginCredential('/api', account)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://merchant.example.test/api/v1/auth/mcp-token', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: 'ws_merchant' }), signal: undefined,
    })
    expect(result).toEqual({
      workspaceId: 'ws_merchant', accountLogin: 'merchant@example.test',
      expiresAt: '2026-09-16T00:10:00.000Z', state: 'installer_required',
    })
    expect(JSON.stringify(result)).not.toMatch(/secret-|access_token|refresh_token|keychain|installed/u)
    for (const method of Object.values(storage)) expect(method).not.toHaveBeenCalled()
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })

  it.each(['/api/', 'https://merchant.example.test/api', 'https://merchant.example.test/api/'])(
    'accepts a same-origin API base %s', async baseUrl => {
      await requestLocalPluginCredential(baseUrl, account)
      expect(fetch).toHaveBeenCalledWith('https://merchant.example.test/api/v1/auth/mcp-token', expect.any(Object))
    },
  )

  it.each(['http://127.0.0.1:18080', 'http://localhost:18080', 'http://[::1]:18080'])(
    'allows HTTP only on same-origin loopback %s', async localOrigin => {
      origin(localOrigin)
      await expect(requestLocalPluginCredential('/api', account)).resolves.toMatchObject({ state: 'installer_required' })
      expect(fetch).toHaveBeenCalledWith(`${localOrigin}/api/v1/auth/mcp-token`, expect.any(Object))
    },
  )

  it.each([
    'https://attacker.example/api', 'http://merchant.example.test/api', '//attacker.example/api',
    '//merchant.example.test/api', 'https://merchant.example.test:8443/api',
    'https://user:password@merchant.example.test/api', 'https://@merchant.example.test/api',
    '/api?secret=value', '/api?', '/api#fragment', '/api#',
    'https://merchant.example.test\\@attacker.example/api', '/api\n', ' /api', 'api', '',
    'data:text/plain,secret', 'javascript:alert(1)',
  ])('rejects unsafe base URL without making a request: %s', async baseUrl => {
    await expect(requestLocalPluginCredential(baseUrl, account)).rejects.toMatchObject({ code: 'UNSAFE_ENDPOINT' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a remote HTTP origin even when the API is same-origin', async () => {
    origin('http://merchant.example.test')
    await expect(requestLocalPluginCredential('/api', account)).rejects.toMatchObject({ code: 'UNSAFE_ENDPOINT' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    { ...account, id: '' }, { ...account, login: '' }, { ...account, accountType: 'platform' },
    { ...account, status: 'disabled' },
  ])('rejects inactive or non-merchant accounts locally', async invalidAccount => {
    await expect(requestLocalPluginCredential('/api', invalidAccount)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([[], ['ws_one', 'ws_two'], ['ws_merchant', 'ws_merchant'], [''], ['*'], [' ws_merchant']])(
    'rejects a missing, ambiguous, or invalid workspace binding', async workspaceIds => {
      await expect(requestLocalPluginCredential('/api', { ...account, workspaceIds })).rejects.toMatchObject({ code: 'WORKSPACE_BINDING_REQUIRED' })
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    null, [], {}, { ...tokenData(), access_token: '' }, { ...tokenData(), refresh_token: 'token with spaces' },
    { ...tokenData(), token_type: 'bearer' }, { ...tokenData(), scope: 'merchant ops' },
    { ...tokenData(), workspace_id: 'ws_other' }, { ...tokenData(), account_login: 'other@example.test' },
    { ...tokenData(), expires_in: 0 }, { ...tokenData(), expires_in: -1 }, { ...tokenData(), expires_in: 0.5 },
    { ...tokenData(), expires_in: '600' }, { ...tokenData(), expires_in: Number.MAX_SAFE_INTEGER },
  ])('rejects malformed or mismatched token data without leaking tokens', async data => {
    vi.mocked(fetch).mockResolvedValueOnce(ok(data) as unknown as Response)
    const error = await requestLocalPluginCredential('/api', account).catch(error => error)
    expect(error).toBeInstanceOf(LocalPluginConnectionError)
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toMatch(/secret-access|secret-refresh|other@example/u)
    expect(error.cause).toBeUndefined()
  })

  it.each([
    { data: tokenData(), error: { message: 'secret-upstream-error' } },
    { data: tokenData(), workspace_id: 'ws_other', error: null },
    [tokenData()],
  ])('rejects malformed envelopes', async envelope => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue(envelope) } as unknown as Response)
    await expect(requestLocalPluginCredential('/api', account)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it.each([
    [401, 'AUTH_REQUIRED', '登录已失效'],
    [409, 'WORKSPACE_BINDING_REQUIRED', '只能绑定一个工作区'],
    [403, 'ACCESS_DENIED', '无权申请插件连接'],
    [500, 'REQUEST_FAILED', '暂时无法申请插件连接'],
  ] as const)('maps HTTP %i to fixed safe copy without reading its body', async (status, code, message) => {
    const response = { ok: false, status, json: vi.fn().mockResolvedValue({ message: 'secret-access-never-expose' }) }
    vi.mocked(fetch).mockResolvedValueOnce(response as unknown as Response)
    const error = await requestLocalPluginCredential('/api', account).catch(error => error)
    expect(error).toMatchObject({ code, message: expect.stringContaining(message), status: status === 500 ? undefined : status })
    expect(response.json).not.toHaveBeenCalled()
    expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toContain('secret-access')
  })

  it('sanitizes network and JSON decoding errors without attaching the original cause', async () => {
    for (const malformed of [false, true]) {
      const raw = new Error('secret-access-never-expose')
      if (malformed) vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockRejectedValue(raw) } as unknown as Response)
      else vi.mocked(fetch).mockRejectedValueOnce(raw)
      const error = await requestLocalPluginCredential('/api', account).catch(error => error)
      expect(error).toMatchObject({ code: 'REQUEST_FAILED' })
      expect(error.cause).toBeUndefined()
      expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toContain('secret-access')
    }
  })

  it('does not request credentials for a pre-aborted operation or expose its reason', async () => {
    const controller = new AbortController()
    controller.abort(new Error('secret-abort-reason'))
    const error = await requestLocalPluginCredential('/api', account, controller.signal).catch(error => error)
    expect(error).toMatchObject({ code: 'ABORTED' })
    expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toContain('secret-abort')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('passes cancellation to fetch and sanitizes an in-flight abort', async () => {
    const controller = new AbortController()
    vi.mocked(fetch).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    }))
    const pending = requestLocalPluginCredential('/api', account, controller.signal)
    controller.abort(new Error('secret-abort-reason'))
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }))
  })

  it('does not return credentials metadata if canceled while decoding the response', async () => {
    const controller = new AbortController()
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => {
      controller.abort('secret-abort-reason')
      return { data: tokenData(), error: null }
    } } as unknown as Response)
    await expect(requestLocalPluginCredential('/api', account, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
  })
})
