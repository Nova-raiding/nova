import { describe, expect, it, vi } from 'vitest'
import { createConfiguredConnector, type AccessCredential, type CredentialProvider, type HttpConnectorConfig } from './index.js'

const config: HttpConnectorConfig = {
  clientId: 'app-test',
  clientSecret: 'secret-is-never-logged',
  oauth: { authorizeUrl: 'https://platform.test/oauth/authorize', tokenUrl: 'https://platform.test/oauth/token', refreshUrl: 'https://platform.test/oauth/refresh', revokeUrl: 'https://platform.test/oauth/revoke', scopes: ['product.read', 'product.write'] },
  api: { baseUrl: 'https://platform.test/api', syncPath: '/products', createPath: '/products', updatePath: '/products/update', queryPath: '/publish/status' },
  timeoutMs: 100,
}

const readyConfig: HttpConnectorConfig = {
  ...config,
  signer: { kind: 'test', sign: () => ({ 'x-platform-signature': 'test-only-adapter' }) },
  mapProducts: () => [],
  mapWriteReceipt: (_payload, input, operation, platform) => ({ platform, operation, remoteId: input.remoteId ?? 'remote-test', requestId: 'request-test', status: 'submitted', simulated: false, idempotencyKey: input.idempotencyKey }),
  mapWriteStatus: () => ({ found: true, state: 'submitted', simulated: false }),
  mappingEvidence: { version: 'test.mapping.v1', evidenceRef: 'test-only', verifiedBy: 'unit-test', verifiedAt: '2026-08-22T00:00:00Z' },
  capabilityEvidence: ['authorize', 'read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke'].map(capability => ({ platform: 'jd' as const, capability: capability as any, state: 'test_e2e' as const, evidenceRef: 'test-only', verifiedBy: 'unit-test', verifiedAt: '2026-08-22T00:00:00Z' })),
}

function credentials(): CredentialProvider & { saved: AccessCredential[] } {
  const saved: AccessCredential[] = []
  return {
    kind: 'test',
    saved,
    async resolve() { return saved.at(-1) ?? { accessToken: 'access-token', refreshToken: 'refresh-token' } },
    async store({ accountId, credential }) { saved.push(credential); return { accountId, credentialRef: `vault://${accountId}` } },
    async revoke() { saved.length = 0 },
  }
}

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }

describe('HttpPlatformConnector', () => {
  it('allows OAuth setup before catalog evidence while keeping sync closed', async () => {
    const connector = createConfiguredConnector('jd', { config })
    await expect(connector.authorize({ workspaceId: 'ws', actorId: 'actor', redirectUri: 'https://app.test/v1/oauth/callback/jd', state: 'state-oauth-only' })).resolves.toMatchObject({ ok: true, mode: 'real' })
    await expect(connector.syncProducts({ workspaceId: 'ws', accountId: 'acct' })).rejects.toMatchObject({ normalized: { code: 'NOT_CONFIGURED' } })
  })

  it('rejects unsafe OAuth callback URLs before building the authorization request', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const fetchMock = vi.fn()
      const connector = createConfiguredConnector('jd', { config: { ...readyConfig, allowedHosts: ['platform.test'], capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'jd' as const })) }, fetch: fetchMock, allowTestAdapters: true })
      await expect(connector.authorize({ workspaceId: 'ws', actorId: 'actor', redirectUri: 'http://localhost:8787/oauth/callback', state: 'state-unsafe' })).resolves.toMatchObject({ ok: false, code: 'VALIDATION_FAILED', mode: 'not_configured' })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('builds OAuth authorize URL with S256 PKCE challenge', async () => {
    const connector = createConfiguredConnector('jd', { config: { ...readyConfig, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'jd' as const })) }, credentials: credentials(), allowTestCredentials: true, allowTestAdapters: true })
    const result = await connector.authorize({ workspaceId: 'ws', actorId: 'actor', redirectUri: 'https://app.test/callback', state: 'state-1', codeVerifier: 'verifier-123' })
    expect(result).toMatchObject({ ok: true, mode: 'real' })
    expect(new URL(result.authorizationUrl!).searchParams.get('client_id')).toBe('app-test')
    expect(new URL(result.authorizationUrl!).searchParams.get('scope')).toBe('product.read product.write')
    expect(new URL(result.authorizationUrl!).searchParams.get('code_challenge_method')).toBe('S256')
    expect(new URL(result.authorizationUrl!).searchParams.get('code_challenge')).not.toBe('verifier-123')
  })

  it('exchanges, refreshes and revokes through injected HTTP and credential store', async () => {
    const store = credentials()
    const calls: Array<{ url: string; body?: string }> = []
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      calls.push({ url: target, body: init?.body as string | undefined })
      if (target.endsWith('/oauth/token')) return response({ access_token: 'token-1', refresh_token: 'refresh-1', expires_in: 60, scope: 'product.read product.write', account_id: 'remote-shop-1' })
      if (target.endsWith('/oauth/refresh')) return response({ access_token: 'token-2', expires_in: 60 })
      return response({ ok: true })
    })
    const connector = createConfiguredConnector('taobao', { config: { ...readyConfig, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'taobao' as const })) }, credentials: store, fetch: fetchMock, allowTestCredentials: true, allowTestAdapters: true })
    const ref = await connector.exchangeCode({ code: 'code-1', state: 'state-1', codeVerifier: 'pkce-verifier', workspaceId: 'ws-oauth' })
    expect(ref).toMatchObject({ credentialRef: 'vault://remote-shop-1', workspaceId: 'ws-oauth', scope: 'product.read product.write', expiresAt: expect.any(String) })
    await connector.refreshCredential(ref)
    await connector.revoke(ref)
    expect(calls).toHaveLength(3)
    expect(calls[0]?.body).toContain('authorization_code')
    expect(calls[0]?.body).toContain('grant_type=authorization_code')
    expect(calls[0]?.body).toContain('code_verifier=pkce-verifier')
    expect(calls[1]?.body).toContain('refresh_token')
    expect(calls[0]?.body).not.toContain('access-token')
  })

  it('reads nested OAuth credentials and provider account identity without inventing local identity', async () => {
    const store = credentials()
    const connector = createConfiguredConnector('jd', {
      config: { ...readyConfig, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'jd' as const })) },
      credentials: store,
      fetch: async () => response({
        data: {
          result: {
            access_token: 'nested-access-token',
            refresh_token: 'nested-refresh-token',
            expires_in: 60,
            account_id: 'provider-account-42',
          },
        },
      }),
      allowTestCredentials: true,
      allowTestAdapters: true,
    })

    await expect(connector.exchangeCode({ code: 'nested-code', state: 'nested-state', workspaceId: 'workspace-42' }))
      .resolves.toMatchObject({ accountId: 'provider-account-42', credentialRef: 'vault://provider-account-42', workspaceId: 'workspace-42' })
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0]).toMatchObject({ accessToken: 'nested-access-token', refreshToken: 'nested-refresh-token' })
  })

  it('fails closed when OAuth does not identify the remote merchant account', async () => {
    const connector = createConfiguredConnector('jd', { config: { ...readyConfig, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'jd' as const })) }, credentials: credentials(), fetch: async () => response({ access_token: 'token-without-merchant-id' }), allowTestCredentials: true, allowTestAdapters: true })
    await expect(connector.exchangeCode({ code: 'code-1', state: 'state-1' })).rejects.toThrow(/identify a remote merchant account/)
  })

  it('injects bearer credentials, signer headers, syncs and writes with idempotency', async () => {
    const store = credentials()
    const signer = { sign: vi.fn(() => ({ 'x-platform-signature': 'provided-by-platform-adapter' })) }
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      requests.push({ url: target, init })
      if (target.endsWith('/products')) return response({ items: [{ id: 'remote-1', title: 'Remote', price: 10, stock: 4, category: 'cat' }] })
      if (target.endsWith('/products/update')) return response({ remoteId: 'remote-1', requestId: 'request-1', state: 'published' })
      return response({ found: true, state: 'published', remoteId: 'remote-1', requestId: 'request-1' })
    })
    const connector = createConfiguredConnector('tmall', { config: { ...readyConfig, signer, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'tmall' as const })) }, credentials: store, fetch: fetchMock, allowTestCredentials: true, allowTestAdapters: true })
    const context = { workspaceId: 'ws', accountId: 'acct' }
    const page = await connector.syncProducts(context)
    expect(page).toMatchObject({ source: 'official_api', simulated: false })
    const first = await connector.updateProduct(context, { fields: { title: 'Remote', category: 'cat', price: 10, stock: 4 }, idempotencyKey: 'idem-1', remoteId: 'remote-1' })
    const second = await connector.updateProduct(context, { fields: { title: 'Remote', category: 'cat', price: 10, stock: 4 }, idempotencyKey: 'idem-1', remoteId: 'remote-1' })
    expect(first.status).toBe('submitted')
    expect(second.requestId).toBe(first.requestId)
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: 'Bearer access-token', 'x-platform-signature': 'provided-by-platform-adapter' })
    expect(signer.sign).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails closed when a provider write omits or corrupts its request ID', async () => {
    for (const requestId of [undefined, 'bad request', 'x'.repeat(257)]) {
      const connector = createConfiguredConnector('jd', {
        config: { ...readyConfig, mapWriteReceipt: undefined, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'jd' as const })) },
        credentials: credentials(),
        fetch: async () => response({ remoteId: 'remote-1', ...(requestId === undefined ? {} : { requestId }) }),
        allowTestCredentials: true,
        allowTestAdapters: true,
      })
      await expect(connector.createProduct({ workspaceId: 'ws', accountId: 'acct' }, { fields: { title: 'Product', category: 'cat', price: 10, stock: 1 }, idempotencyKey: `missing-request-${requestId ?? 'none'}` }))
        .rejects.toMatchObject({ normalized: { code: 'VALIDATION_FAILED', retryable: false } })
    }
  })

  it('does not treat malformed query request IDs as publish evidence', async () => {
    const connector = createConfiguredConnector('jd', {
      config: { ...readyConfig, mapWriteStatus: undefined, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'jd' as const })) },
      credentials: credentials(),
      fetch: async () => response({ found: true, state: 'published', remoteId: 'remote-1', requestId: 'unsafe request id' }),
      allowTestCredentials: true,
      allowTestAdapters: true,
    })
    await expect(connector.queryWrite({ workspaceId: 'ws', accountId: 'acct' }, { idempotencyKey: 'query-evidence-1', remoteId: 'remote-1' }))
      .resolves.toMatchObject({ found: true, state: 'unknown', simulated: false })
  })

  it('cancels in-flight platform HTTP when the durable lease signal aborts', async () => {
    const controller = new AbortController()
    let platformSignal: AbortSignal | undefined
    let requestStarted!: () => void
    const started = new Promise<void>(resolve => { requestStarted = resolve })
    const connector = createConfiguredConnector('jd', {
      config: { ...readyConfig, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'jd' as const })) },
      credentials: credentials(),
      fetch: async (_url, init) => {
        platformSignal = init?.signal ?? undefined
        requestStarted()
        return await new Promise<Response>((_resolve, reject) => platformSignal?.addEventListener('abort', () => reject(platformSignal?.reason), { once: true }))
      },
      allowTestCredentials: true,
      allowTestAdapters: true,
    })
    const pending = connector.syncProducts({ workspaceId: 'ws', accountId: 'acct', signal: controller.signal })
    await started
    controller.abort(new Error('lease lost'))

    await expect(pending).rejects.toMatchObject({ normalized: { code: 'REMOTE_ERROR', unknown: false } })
    expect(platformSignal?.aborted).toBe(true)
  })

  it('revalidates a signer-mutated URL in secure environments', async () => {
    vi.stubEnv('NODE_ENV', 'staging')
    try {
      const fetchMock = vi.fn(async () => response({ items: [] }))
      const connector = createConfiguredConnector('jd', {
        config: { ...readyConfig, allowedHosts: ['platform.test'], signer: { kind: 'test', sign: (descriptor) => { descriptor.url = 'https://evil.test/steal'; return {} } } },
        credentials: credentials(), fetch: fetchMock, allowTestCredentials: true, allowTestAdapters: true,
      })
      await expect(connector.syncProducts({ workspaceId: 'ws', accountId: 'acct' })).rejects.toThrow('HOST_NOT_ALLOWLISTED')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('normalizes numeric-string commerce fields and image object envelopes in the fallback mapper', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => String(url).endsWith('/products')
      ? response({ items: [{ id: 'remote-2', title: 'Social', price: '19.90', stock: '8', sku: [{ id: 'sku-2', name: '红色', price: '21.00', stock: '2' }], images: [{ image_url: 'https://img.example/main.jpg' }, { url: 'https://img.example/secondary.jpg' }] }] })
      : response({ items: [] }))
    const fallbackConfig = { ...readyConfig, mapProducts: undefined }
    const connector = createConfiguredConnector('jd', { config: fallbackConfig, credentials: credentials(), fetch: fetchMock, allowTestCredentials: true, allowTestAdapters: true })
    const page = await connector.syncProducts({ workspaceId: 'ws', accountId: 'acct' })
    expect(page.items[0]).toMatchObject({ price: 19.9, stock: 8, sku: [{ price: 21, stock: 2 }], images: ['https://img.example/main.jpg', 'https://img.example/secondary.jpg'] })
  })

  it('refreshes an expiring access credential before an API request', async () => {
    const saved: AccessCredential[] = [{ accessToken: 'expired', refreshToken: 'refresh', expiresAt: new Date(Date.now() - 1_000).toISOString() }]
    const store: CredentialProvider = {
      kind: 'test',
      async resolve() { return saved.at(-1) },
      async store({ credential }) { saved.push(credential); return { accountId: 'acct', credentialRef: 'vault://acct' } },
    }
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => String(url).endsWith('/oauth/refresh')
      ? response({ access_token: 'fresh', refresh_token: 'fresh-refresh', expires_in: 300 })
      : response({ items: [] }))
    const connector = createConfiguredConnector('jd', { config: { ...readyConfig, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'jd' as const })) }, credentials: store, fetch: fetchMock, allowTestCredentials: true, allowTestAdapters: true })
    await connector.syncProducts({ workspaceId: 'ws', accountId: 'acct' })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/oauth/refresh'), expect.anything())
    const apiCall = fetchMock.mock.calls.at(-1)![1] as RequestInit
    expect(apiCall.headers).toMatchObject({ authorization: 'Bearer fresh' })
  })

  it('downgrades an unsubstantiated published mapping to unknown', async () => {
    const connector = createConfiguredConnector('jd', {
      config: {
        ...readyConfig,
        mapWriteStatus: () => ({ found: true, state: 'published', simulated: false }),
        capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'jd' as const })),
      },
      credentials: credentials(),
      fetch: async () => response({ state: 'published' }),
      allowTestCredentials: true,
      allowTestAdapters: true,
    })

    await expect(connector.queryWrite({ workspaceId: 'ws', accountId: 'acct' }, { idempotencyKey: 'evidence-required' }))
      .resolves.toMatchObject({ found: true, state: 'unknown', simulated: false })
  })

  it('normalizes timeout and HTTP statuses without leaking token data', async () => {
    const connector = createConfiguredConnector('pinduoduo', { config: { ...readyConfig, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'pinduoduo' as const })) }, credentials: credentials(), fetch: async () => response({ code: 'bad', token: 'secret' }, 429), allowTestCredentials: true, allowTestAdapters: true })
    await expect(connector.syncProducts({ workspaceId: 'ws', accountId: 'acct' })).rejects.toMatchObject({ normalized: { code: 'RATE_LIMITED', retryable: true, status: 429 } })
    expect(connector.normalizeError({ name: 'AbortError', message: 'aborted access-token' })).toMatchObject({ code: 'TIMEOUT', unknown: true, retryable: true })
    expect(connector.normalizeError({ name: 'AbortError', message: 'aborted access-token' }).message).not.toContain('access-token')
  })

  it('classifies the connector-owned TimeoutError as unknown and retryable', async () => {
    const connector = createConfiguredConnector('jd', {
      config: { ...readyConfig, timeoutMs: 5, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'jd' as const })) },
      credentials: credentials(),
      fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }),
      allowTestCredentials: true,
      allowTestAdapters: true,
    })
    await expect(connector.syncProducts({ workspaceId: 'ws', accountId: 'acct' }))
      .rejects.toMatchObject({ normalized: { code: 'TIMEOUT', unknown: true, retryable: true } })
  })

  it('classifies structured platform validation errors and retains safe rejection evidence', async () => {
    const connector = createConfiguredConnector('jd', {
      config: { ...readyConfig, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'jd' as const })) },
      credentials: credentials(),
      fetch: async () => response({ error: { code: 'SKU_INVALID', message: '商品字段不合法', requestId: 'req-safe', fields: [{ path: 'sku[0].price', code: 'PRICE_INVALID', message: 'must be positive' }] } }, 422),
      allowTestCredentials: true,
      allowTestAdapters: true,
    })
    await expect(connector.syncProducts({ workspaceId: 'ws', accountId: 'acct' }))
      .rejects.toMatchObject({ normalized: { code: 'VALIDATION_FAILED', status: 422, retryable: false, details: { platformCode: 'SKU_INVALID', requestId: 'req-safe', rejection: { rawCode: 'SKU_INVALID', fields: [{ path: 'sku[0].price', rawCode: 'PRICE_INVALID', message: 'must be positive' }] } } } })
  })

  it('rejects oversized platform responses before parsing them', async () => {
    const connector = createConfiguredConnector('jd', {
      config: { ...readyConfig, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'jd' as const })) },
      credentials: credentials(),
      fetch: async () => new Response('{"items":[]}', { headers: { 'content-length': String(5 * 1024 * 1024) } }),
      allowTestCredentials: true,
      allowTestAdapters: true,
    })
    await expect(connector.syncProducts({ workspaceId: 'ws', accountId: 'acct' })).rejects.toMatchObject({ normalized: { code: 'VALIDATION_FAILED', retryable: false } })
  })

  it('fails closed when config or credential provider is missing', async () => {
    const unconfigured = createConfiguredConnector('jd', {})
    await expect(unconfigured.syncProducts({ workspaceId: 'ws', accountId: 'acct' })).rejects.toMatchObject({ normalized: { code: 'NOT_CONFIGURED' } })
    const noStore = createConfiguredConnector('jd', { config })
    await expect(noStore.exchangeCode({ code: 'code', state: 'state' })).rejects.toMatchObject({ normalized: { code: 'NOT_CONFIGURED' } })
  })

  it('does not expose provider failures or token-shaped details', async () => {
    const provider: CredentialProvider = {
      kind: 'test',
      async resolve() { throw new Error('vault access-token=do-not-expose') },
      async store() { throw new Error('vault secret=do-not-expose') },
    }
    const connector = createConfiguredConnector('jd', { config: { ...readyConfig, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'jd' as const })) }, credentials: provider, fetch: async () => response({ items: [] }), allowTestCredentials: true, allowTestAdapters: true })
    await expect(connector.syncProducts({ workspaceId: 'ws', accountId: 'acct' })).rejects.toMatchObject({ normalized: { code: 'UNAUTHORIZED' } })

    const exchangeProvider: CredentialProvider = {
      kind: 'test',
      async resolve() { return undefined },
      async store() { throw new Error('vault secret=do-not-expose') },
    }
    const exchange = createConfiguredConnector('jd', { config: { ...readyConfig, capabilityEvidence: readyConfig.capabilityEvidence?.map(item => ({ ...item, platform: 'jd' as const })) }, credentials: exchangeProvider, fetch: async () => response({ access_token: 'transient-token', account_id: 'remote-acct' }), allowTestCredentials: true, allowTestAdapters: true })
    try {
      await exchange.exchangeCode({ code: 'code', state: 'state' })
      throw new Error('expected exchange to fail closed')
    } catch (error) {
      expect(error).toMatchObject({ normalized: { code: 'NOT_CONFIGURED' } })
      expect(JSON.stringify(error)).not.toContain('transient-token')
      expect(JSON.stringify(error)).not.toContain('do-not-expose')
    }
  })

  it('redacts credential-shaped keys from normalized remote details', () => {
    const connector = createConfiguredConnector('jd', { config })
    const normalized = connector.normalizeError({ status: 500, details: { accessToken: 'secret-token', requestId: 'safe-request-id' } })
    expect(normalized.details).toEqual({ accessToken: '[REDACTED]', requestId: 'safe-request-id' })
  })
})
