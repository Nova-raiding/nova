import { describe, expect, it, vi } from 'vitest'
import { createVaultCredentialProviderFromEnv, VaultKvCredentialProvider } from './vault-provider.js'

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }

describe('VaultKvCredentialProvider', () => {
  it('stores, resolves and revokes KV v2 credentials without exposing token in the ref', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (init?.method === 'GET') return response({ data: { data: { access_token: 'secret-access', refresh_token: 'secret-refresh', expires_at: '2030-01-01T00:00:00.000Z' } } })
      return response({ data: { version: 1 } })
    })
    const provider = new VaultKvCredentialProvider({ address: 'https://vault.test/', token: 'vault-bootstrap-token', mount: 'kv', fetch: fetchMock })
    const ref = await provider.store({ accountId: 'acct/1', credential: { accessToken: 'secret-access', refreshToken: 'secret-refresh' } })
    expect(ref.credentialRef).toBe('vault://kv/merchant-marketing/acct%2F1')
    expect(ref.credentialRef).not.toContain('secret-access')
    await expect(provider.resolve(ref)).resolves.toMatchObject({ accessToken: 'secret-access', refreshToken: 'secret-refresh' })
    await provider.revoke(ref)
    expect(calls[0]?.url).toContain('/v1/kv/data/merchant-marketing/acct%2F1')
    expect(calls[0]?.init?.headers).toMatchObject({ 'x-vault-token': 'vault-bootstrap-token' })
    expect(JSON.stringify(calls[0]?.init?.body)).toContain('secret-access')
    expect(calls[1]?.url).toContain('/v1/kv/data/merchant-marketing/acct%2F1')
    expect(calls[2]?.url).toContain('/v1/kv/metadata/merchant-marketing/acct%2F1')
  })

  it('returns undefined when KV data is absent and does not configure partial env', async () => {
    const provider = new VaultKvCredentialProvider({ address: 'https://vault.test', token: 'token', fetch: async () => response({}, 404) })
    await expect(provider.resolve({ accountId: 'acct' })).resolves.toBeUndefined()
    expect(createVaultCredentialProviderFromEnv({ VAULT_ADDR: 'https://vault.test' })).toBeUndefined()
    expect(createVaultCredentialProviderFromEnv({ VAULT_TOKEN: 'token' })).toBeUndefined()
    expect(createVaultCredentialProviderFromEnv({ VAULT_ADDR: 'https://vault.test', VAULT_TOKEN: 'token' })).toMatchObject({ kind: 'vault' })
  })

  it('uses different opaque Vault paths for the same remote account in different workspaces', async () => {
    const provider = new VaultKvCredentialProvider({ address: 'https://vault.test', token: 'token', mount: 'kv', fetch: async () => response({ data: { version: 1 } }) })
    const first = await provider.store({ workspaceId: 'ws-one', accountId: 'same-remote-account', credential: { accessToken: 'one' } })
    const second = await provider.store({ workspaceId: 'ws-two', accountId: 'same-remote-account', credential: { accessToken: 'two' } })
    expect(first.credentialRef).toMatch(/^vault:\/\/kv\/merchant-marketing\/workspaces\/[a-f0-9]{24}\/accounts\/[a-f0-9]{24}$/u)
    expect(second.credentialRef).toMatch(/^vault:\/\/kv\/merchant-marketing\/workspaces\/[a-f0-9]{24}\/accounts\/[a-f0-9]{24}$/u)
    expect(first.credentialRef).not.toBe(second.credentialRef)
  })

  it('rejects an insecure Vault address outside test mode', () => {
    vi.stubEnv('NODE_ENV', 'staging')
    expect(() => new VaultKvCredentialProvider({ address: 'http://vault.internal', token: 'token' })).toThrow('HTTPS')
    vi.unstubAllEnvs()
  })

  it('does not allow dot segments in an opaque credential ref to escape its KV prefix', async () => {
    const calls: string[] = []
    const provider = new VaultKvCredentialProvider({
      address: 'https://vault.test',
      token: 'token',
      mount: 'kv',
      fetch: async (url: string | URL) => { calls.push(String(url)); return response({}, 404) },
    })
    await expect(provider.resolve({ accountId: 'safe-account', credentialRef: 'vault://kv/merchant-marketing/%2e%2e/sys' })).resolves.toBeUndefined()
    expect(calls[0]).toContain('/v1/kv/data/merchant-marketing/safe-account')
    expect(calls[0]).not.toContain('%2e%2e')
  })

  it('bounds Vault responses and propagates a request timeout signal', async () => {
    const oversized = new Response('{"data":{}}', { headers: { 'content-length': String(2 * 1024 * 1024) } })
    await expect(new VaultKvCredentialProvider({ address: 'https://vault.test', token: 'token', fetch: async () => oversized }).resolve({ accountId: 'acct' })).rejects.toThrow('safety limit')

    let aborted = false
    const provider = new VaultKvCredentialProvider({ address: 'https://vault.test', token: 'token', timeoutMs: 10, fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')) })
    }) })
    await expect(provider.resolve({ accountId: 'acct' })).rejects.toThrow('aborted')
    expect(aborted).toBe(true)
  })
})
