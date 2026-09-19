import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createVaultCredentialProviderFromEnv, VaultKvCredentialProvider } from './vault-provider.js'

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }

/**
 * The documented addressing rule: the tenancy and the merchant account are
 * each addressed by the first 24 hex characters of their own SHA-256 digest
 * under the shared merchant-marketing prefix. It is recomputed here instead of
 * being sliced out of the returned `credentialRef`, which made every URL
 * assertion compare the implementation against itself.
 */
function expectedVaultPath(workspaceId: string, accountId: string) {
  const hashed = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)
  return `merchant-marketing/workspaces/${hashed(workspaceId)}/accounts/${hashed(accountId)}`
}

describe('VaultKvCredentialProvider', () => {
  it('stores, resolves and revokes KV v2 credentials without exposing token in the ref', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (init?.method === 'GET') return response({ data: { data: { access_token: 'secret-access', refresh_token: 'secret-refresh', expires_at: '2030-01-01T00:00:00.000Z' } } })
      return response({ data: { version: 1 } })
    })
    const provider = new VaultKvCredentialProvider({ address: 'https://vault.test/', token: 'vault-bootstrap-token', mount: 'kv', fetch: fetchMock })
    const ref = await provider.store({ workspaceId: 'ws-one', accountId: 'acct/1', credential: { accessToken: 'secret-access', refreshToken: 'secret-refresh' } })
    // The record is addressed by workspace-scoped, hashed path parts: neither
    // the tenancy nor the merchant account is legible in the Vault path.
    expect(ref.credentialRef).toMatch(/^vault:\/\/kv\/merchant-marketing\/workspaces\/[a-f0-9]{24}\/accounts\/[a-f0-9]{24}$/u)
    expect(ref.credentialRef).not.toContain('secret-access')
    expect(ref.credentialRef).not.toContain('acct')
    const storedPath = expectedVaultPath('ws-one', 'acct/1')
    expect(ref.credentialRef).toBe(`vault://kv/${storedPath}`)
    await expect(provider.resolve(ref)).resolves.toMatchObject({ accessToken: 'secret-access', refreshToken: 'secret-refresh' })
    await provider.revoke(ref)
    expect(calls[0]?.url).toContain(`/v1/kv/data/${storedPath}`)
    expect(calls[0]?.init?.headers).toMatchObject({ 'x-vault-token': 'vault-bootstrap-token' })
    expect(JSON.stringify(calls[0]?.init?.body)).toContain('secret-access')
    expect(calls[1]?.url).toContain(`/v1/kv/data/${storedPath}`)
    expect(calls[2]?.url).toContain(`/v1/kv/metadata/${storedPath}`)
  })

  it('resolves the same workspace-scoped path from an account identity alone', async () => {
    const calls: string[] = []
    const provider = new VaultKvCredentialProvider({
      address: 'https://vault.test', token: 'token', mount: 'kv',
      fetch: async (url: string | URL) => { calls.push(String(url)); return response({ data: { data: { access_token: 'workspace-token' } } }) },
    })
    const stored = await provider.store({ workspaceId: 'ws-one', accountId: 'acct-1', credential: { accessToken: 'workspace-token' } })
    await expect(provider.resolve({ workspaceId: 'ws-one', accountId: 'acct-1' })).resolves.toMatchObject({ accessToken: 'workspace-token' })
    // store and the (workspace, account) fallback must agree on one path,
    // otherwise a refresh writes a record no reader can find.
    const expectedPath = expectedVaultPath('ws-one', 'acct-1')
    expect(stored.credentialRef).toBe(`vault://kv/${expectedPath}`)
    expect(calls[0]).toContain(expectedPath)
    expect(calls[1]).toContain(expectedPath)
  })

  it('never reads another workspace record when no credential ref is supplied', async () => {
    const calls: string[] = []
    const provider = new VaultKvCredentialProvider({
      address: 'https://vault.test', token: 'token', mount: 'kv',
      fetch: async (url: string | URL) => { calls.push(String(url)); return response({ data: { data: { access_token: 'other-workspace-token' } } }) },
    })
    // Both workspaces connect the same remote merchant account: without an
    // explicit workspace (or an opaque ref minted for that workspace) the
    // account id alone must not resolve a shared credential record.
    await expect(provider.resolve({ accountId: 'shared-merchant-account' })).rejects.toThrow('explicit workspaceId')
    await expect(provider.store({ accountId: 'shared-merchant-account', credential: { accessToken: 'one' } })).rejects.toThrow('explicit workspaceId')
    expect(calls).toEqual([])
    const first = await provider.resolve({ workspaceId: 'ws-one', accountId: 'shared-merchant-account' })
    const second = await provider.resolve({ workspaceId: 'ws-two', accountId: 'shared-merchant-account' })
    expect(first).toMatchObject({ accessToken: 'other-workspace-token' })
    expect(second).toMatchObject({ accessToken: 'other-workspace-token' })
    expect(calls[0]).not.toBe(calls[1])
  })

  it('returns undefined when KV data is absent and does not configure partial env', async () => {
    const provider = new VaultKvCredentialProvider({ address: 'https://vault.test', token: 'token', fetch: async () => response({}, 404) })
    await expect(provider.resolve({ workspaceId: 'ws-one', accountId: 'acct' })).resolves.toBeUndefined()
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
    await expect(provider.resolve({ workspaceId: 'ws-safe', accountId: 'safe-account', credentialRef: 'vault://kv/merchant-marketing/%2e%2e/sys' })).resolves.toBeUndefined()
    expect(calls[0]).toContain('/v1/kv/data/merchant-marketing/workspaces/')
    expect(calls[0]).not.toContain('%2e%2e')
  })

  it('bounds Vault responses and propagates a request timeout signal', async () => {
    const oversized = new Response('{"data":{}}', { headers: { 'content-length': String(2 * 1024 * 1024) } })
    await expect(new VaultKvCredentialProvider({ address: 'https://vault.test', token: 'token', fetch: async () => oversized }).resolve({ workspaceId: 'ws', accountId: 'acct' })).rejects.toThrow('safety limit')

    let aborted = false
    const provider = new VaultKvCredentialProvider({ address: 'https://vault.test', token: 'token', timeoutMs: 10, fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')) })
    }) })
    await expect(provider.resolve({ workspaceId: 'ws', accountId: 'acct' })).rejects.toThrow('aborted')
    expect(aborted).toBe(true)
  })
})
