import { describe, expect, it, vi } from 'vitest'
import { createConfiguredConnector, type AccessCredential, type CredentialProvider, type HttpConnectorConfig, type Platform } from './index.js'

// Keep the real HTTP contract honest for every supported platform. The social
// connectors have generic bearer/mapping adapters, but they must still pass
// the same OAuth, read, write, receipt, revoke and media boundary checks.
const platforms: Platform[] = ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin']

function makeConfig(platform: Platform): HttpConnectorConfig {
  return {
    clientId: `${platform}-test-app`,
    clientSecret: `${platform}-test-secret`,
    oauth: {
      authorizeUrl: `https://${platform}.test/oauth/authorize`,
      tokenUrl: `https://${platform}.test/oauth/token`,
      revokeUrl: `https://${platform}.test/oauth/revoke`,
    },
    api: { baseUrl: `https://${platform}.test/api`, syncPath: '/products', createPath: '/products/create', updatePath: '/products/update', queryPath: '/publish/status' },
    signer: { kind: 'test', sign: () => ({ 'x-test-platform': platform }) },
    mapProducts: () => [],
    mapWriteReceipt: (_payload, input, operation, current) => ({ platform: current, operation, remoteId: input.remoteId ?? `${current}-remote-1`, requestId: `${current}-request-1`, status: 'submitted', simulated: false, idempotencyKey: input.idempotencyKey }),
    mapWriteStatus: () => ({ found: true, state: 'submitted', requestId: `${platform}-request-1`, simulated: false }),
  }
}

function makeStore() {
  let revoked = false
  const credential: AccessCredential = { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token' }
  const store: CredentialProvider & { get revoked(): boolean } = {
    kind: 'test',
    get revoked() { return revoked },
    async resolve() { return revoked ? undefined : credential },
    async store({ accountId }) { revoked = false; return { accountId, credentialRef: `fixture-vault://${accountId}` } },
    async revoke() { revoked = true },
  }
  return store
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe.each(platforms)('%s HTTP connector FR-15 contract', (platform) => {
  it('authorizes, exchanges, syncs, and revokes consistently', async () => {
    const store = makeStore()
    const calls: string[] = []
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      calls.push(`${init?.method ?? 'GET'} ${target}`)
      if (target.endsWith('/oauth/token')) return json({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', account_id: `${platform}-shop-1` })
      if (target.endsWith('/oauth/revoke')) return json({ revoked: true })
      if (target.endsWith('/products')) return json({ items: [], nextCursor: 'cursor-2' })
      return json({ ok: true })
    })
    const connector = createConfiguredConnector(platform, { config: makeConfig(platform), credentials: store, fetch: fetchMock, allowTestCredentials: true, allowTestAdapters: true })

    await expect(connector.authorize({ workspaceId: 'ws', actorId: 'actor', redirectUri: 'https://app.test/callback', state: `${platform}-state`, codeVerifier: 'verifier' })).resolves.toMatchObject({ ok: true, mode: 'real', platform })
    const ref = await connector.exchangeCode({ code: `${platform}-code`, state: `${platform}-state`, codeVerifier: 'verifier' })
    expect(ref.accountId).toBe(`${platform}-shop-1`)
    await expect(connector.syncProducts({ workspaceId: 'ws', accountId: ref.accountId, credentialRef: ref.credentialRef })).resolves.toMatchObject({ source: 'official_api', simulated: false, nextCursor: { value: 'cursor-2' } })
    await connector.revoke(ref)
    expect(store.revoked).toBe(true)
    await expect(connector.syncProducts({ workspaceId: 'ws', accountId: ref.accountId, credentialRef: ref.credentialRef })).rejects.toMatchObject({ normalized: { code: 'UNAUTHORIZED', platform } })
    expect(calls.some(call => call.includes('POST https://' + platform + '.test/oauth/revoke'))).toBe(true)
  })

  it('writes and re-reads the same remote identity for create and update', async () => {
    const store = makeStore()
    const requests: Array<{ method: string; url: string; body?: string }> = []
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      const body = typeof init?.body === 'string' ? init.body : undefined
      requests.push({ method: init?.method ?? 'GET', url: target, ...(body ? { body } : {}) })
      if (target.endsWith('/oauth/token')) return json({ access_token: 'fixture-access-token', account_id: `${platform}-shop-1` })
      if (target.endsWith('/products/create')) return json({ remoteId: `${platform}-created-1`, requestId: `${platform}-create-request` })
      if (target.endsWith('/products/update')) return json({ remoteId: `${platform}-updated-1`, requestId: `${platform}-update-request` })
      if (target.endsWith('/publish/status')) {
        const parsed = JSON.parse(body ?? '{}') as { idempotencyKey?: string; remoteId?: string }
        return json({ found: true, state: 'published', requestId: `${platform}-${parsed.idempotencyKey}-status`, remoteId: parsed.remoteId })
      }
      return json({ ok: true })
    })
    const connector = createConfiguredConnector(platform, { config: { ...makeConfig(platform), mapWriteReceipt: undefined, mapWriteStatus: undefined }, credentials: store, fetch: fetchMock, allowTestCredentials: true, allowTestAdapters: true })
    const ref = await connector.exchangeCode({ code: `${platform}-code`, state: `${platform}-state` })
    const context = { workspaceId: 'ws', accountId: ref.accountId, credentialRef: ref.credentialRef }

    const createInput = { fields: { title: 'created', category: 'cat', price: 1, stock: 1 }, idempotencyKey: `${platform}-create` }
    const createReceipt = await connector.createProduct(context, createInput)
    await expect(connector.queryWrite(context, { idempotencyKey: createInput.idempotencyKey, remoteId: createReceipt.remoteId }))
      .resolves.toMatchObject({ found: true, state: 'published', remoteId: `${platform}-created-1` })

    const updateInput = { remoteId: `${platform}-created-1`, fields: { title: 'updated', category: 'cat', price: 2, stock: 2 }, idempotencyKey: `${platform}-update` }
    const updateReceipt = await connector.updateProduct(context, updateInput)
    await expect(connector.queryWrite(context, { idempotencyKey: updateInput.idempotencyKey, remoteId: updateReceipt.remoteId }))
      .resolves.toMatchObject({ found: true, state: 'published', remoteId: `${platform}-updated-1` })

    const statusRequests = requests.filter(request => request.url.endsWith('/publish/status'))
    expect(statusRequests).toHaveLength(2)
    expect(statusRequests.map(request => JSON.parse(request.body ?? '{}'))).toEqual([
      { idempotencyKey: `${platform}-create`, remoteId: `${platform}-created-1` },
      { idempotencyKey: `${platform}-update`, remoteId: `${platform}-updated-1` },
    ])
    expect(statusRequests.every(request => request.method === 'POST')).toBe(true)
  })

  it('fails closed when a status response names a different remote identity', async () => {
    const store = makeStore()
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      if (target.endsWith('/oauth/token')) return json({ access_token: 'fixture-access-token', account_id: `${platform}-shop-1` })
      if (target.endsWith('/products/create')) return json({ remoteId: `${platform}-created-1`, requestId: `${platform}-create-request` })
      if (target.endsWith('/publish/status')) return json({ found: true, state: 'published', remoteId: `${platform}-different-1`, requestId: `${platform}-status-request` })
      return json({ ok: true })
    })
    const connector = createConfiguredConnector(platform, { config: { ...makeConfig(platform), mapWriteReceipt: undefined, mapWriteStatus: undefined }, credentials: store, fetch: fetchMock, allowTestCredentials: true, allowTestAdapters: true })
    const ref = await connector.exchangeCode({ code: `${platform}-code`, state: `${platform}-state` })
    const context = { workspaceId: 'ws', accountId: ref.accountId, credentialRef: ref.credentialRef }
    const input = { fields: { title: 'created', category: 'cat', price: 1, stock: 1 }, idempotencyKey: `${platform}-identity-mismatch` }
    const receipt = await connector.createProduct(context, input)

    await expect(connector.queryWrite(context, { idempotencyKey: input.idempotencyKey, remoteId: receipt.remoteId }))
      .resolves.toMatchObject({ found: false, state: 'unknown', requestId: `${platform}-status-request`, simulated: false })
    const result = await connector.queryWrite(context, { idempotencyKey: input.idempotencyKey, remoteId: receipt.remoteId })
    expect(result.remoteId).toBeUndefined()
  })

  it('normalizes OAuth authorization failure without leaking platform credentials', async () => {
    const store = makeStore()
    const fetchMock = vi.fn(async () => json({ error: 'invalid_grant', access_token: 'must-not-leak' }, 401))
    const connector = createConfiguredConnector(platform, { config: makeConfig(platform), credentials: store, fetch: fetchMock, allowTestCredentials: true, allowTestAdapters: true })
    await expect(connector.exchangeCode({ code: 'bad-code', state: `${platform}-state` })).rejects.toMatchObject({ normalized: { code: 'UNAUTHORIZED', platform, status: 401 } })
  })

  it('disables local access even when remote revoke fails', async () => {
    const store = makeStore()
    const fetchMock = vi.fn(async (url: string | URL) => String(url).endsWith('/oauth/token') ? json({ access_token: 'fixture-access-token', account_id: `${platform}-shop-1` }) : json({ error: 'temporarily unavailable' }, 503))
    const connector = createConfiguredConnector(platform, { config: makeConfig(platform), credentials: store, fetch: fetchMock, allowTestCredentials: true, allowTestAdapters: true })
    const ref = await connector.exchangeCode({ code: 'code', state: `${platform}-state` })
    await expect(connector.revoke(ref)).rejects.toMatchObject({ normalized: { code: 'REMOTE_ERROR', platform, status: 503 } })
    expect(store.revoked).toBe(true)
    await expect(connector.syncProducts({ workspaceId: 'ws', accountId: ref.accountId, credentialRef: ref.credentialRef })).rejects.toMatchObject({ normalized: { code: 'UNAUTHORIZED', platform } })
  })

  it('uploads frozen main/secondary media through the configured platform adapter', async () => {
    const store = makeStore()
    const calls: Array<{ url: string; body?: string }> = []
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => { calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : undefined }); return json({ mediaId: `${platform}-media-1`, url: `https://cdn.${platform}.test/media-1.jpg` }) })
    const config = { ...makeConfig(platform), mediaUploadPath: '/media/upload', mediaUploadEvidence: { version: 'media.v1', evidenceRef: `evidence://${platform}/media`, verifiedBy: 'qa', verifiedAt: new Date().toISOString() }, mapMediaUpload: (payload: unknown) => ({ mediaId: (payload as { mediaId: string }).mediaId, url: (payload as { url: string }).url }) }
    const connector = createConfiguredConnector(platform, { config, credentials: store, fetch: fetchMock, allowTestCredentials: true, allowTestAdapters: true })
    expect((connector as { mediaUploadReady?: () => boolean }).mediaUploadReady?.()).toBe(true)
    await expect(connector.uploadMedia?.({ workspaceId: 'ws', accountId: `${platform}-shop`, credentialRef: 'vault://shop' }, { visualRef: 'dvis_1', role: 'main', mimeType: 'image/png', sha256: 'a'.repeat(64), bytes: Buffer.from('image'), idempotencyKey: 'publish:media-1' })).resolves.toMatchObject({ platform, role: 'main', url: `https://cdn.${platform}.test/media-1.jpg`, simulated: false })
    expect(calls[0]?.url).toBe(`https://${platform}.test/api/media/upload`)
    expect(calls[0]?.body).toContain('aW1hZ2U=')
  })

  it('fails closed for media when the platform upload path is not configured', async () => {
    const connector = createConfiguredConnector(platform, { config: makeConfig(platform), credentials: makeStore(), fetch: async () => json({}) , allowTestCredentials: true, allowTestAdapters: true })
    expect((connector as { mediaUploadReadiness?: () => { ready: boolean } }).mediaUploadReadiness?.().ready).toBe(false)
    await expect(connector.uploadMedia?.({ workspaceId: 'ws', accountId: `${platform}-shop` }, { visualRef: 'dvis_1', role: 'main', mimeType: 'image/png', sha256: 'a'.repeat(64), bytes: Buffer.from('image'), idempotencyKey: `publish:${platform}:media-missing` })).rejects.toMatchObject({ normalized: { code: 'NOT_CONFIGURED', platform } })
  })
})
