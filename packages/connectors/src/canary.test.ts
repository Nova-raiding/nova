import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createConfiguredConnector, createFakeConnector, profiles, runPlatformCanary, type AccessCredential, type CredentialProvider, type HttpConnectorConfig } from './index.js'

function sandboxCredentialProvider(revokedRefs: string[] = []): CredentialProvider {
  let credential: AccessCredential = { accessToken: 'sandbox-test-token' }
  return {
    kind: 'test',
    async resolve() { return credential },
    async store(input) {
      credential = input.credential
      return { accountId: input.accountId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), credentialRef: 'sandbox://credential' }
    },
    async revoke(ref) { revokedRefs.push(ref.credentialRef) },
  }
}

function sandboxConfig(): HttpConnectorConfig {
  return {
    clientId: 'local-sandbox-client',
    clientSecret: 'local-sandbox-secret',
    oauth: {
      authorizeUrl: 'https://sandbox.local.test/oauth/authorize',
      tokenUrl: 'https://sandbox.local.test/oauth/token',
      refreshUrl: 'https://sandbox.local.test/oauth/refresh',
      revokeUrl: 'https://sandbox.local.test/oauth/revoke',
      scopes: ['sandbox.product.read', 'sandbox.product.write'],
    },
    api: {
      baseUrl: 'https://sandbox.local.test/api',
      syncPath: '/products',
      createPath: '/products',
      updatePath: '/products',
      queryPath: '/products/status',
    },
    mediaUploadPath: '/media',
    mediaUploadEvidence: { version: 'sandbox.media.v1', evidenceRef: 'artifact://sandbox/media', verifiedBy: 'local-contract-test', verifiedAt: '2026-08-22T00:00:00Z' },
    allowedHosts: ['sandbox.local.test'],
    mapMediaUpload: payload => ({ mediaId: String((payload as { mediaId: string }).mediaId) }),
  }
}

function localSandboxConnector(options: { statusRequestId?: string; omitCursor?: boolean; onExchange?: (observation: unknown) => void } = {}) {
  const fixture = profiles.taobao.fixture
  let writeRequestId = 'sandbox-create-request'
  const revokedRefs: string[] = []
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const requestUrl = new URL(String(url))
    if (requestUrl.pathname === '/oauth/revoke') return new Response('{}', { status: 200 })
    if (requestUrl.pathname === '/api/products/status') return new Response(JSON.stringify({ found: true, state: 'published', remoteId: fixture.remoteId, requestId: options.statusRequestId ?? writeRequestId }), { status: 200 })
    if (requestUrl.pathname === '/api/products' && init?.method === 'GET') {
      return new Response(JSON.stringify(requestUrl.searchParams.has('cursor') ? { items: [], nextCursor: undefined } : { items: [fixture], ...(options.omitCursor ? {} : { nextCursor: 'sandbox-page-2' }) }), { status: 200 })
    }
    if (requestUrl.pathname === '/api/products' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { idempotencyKey?: string; remoteId?: string }
      if (body.remoteId) writeRequestId = 'sandbox-update-request'
      return new Response(JSON.stringify({ remoteId: body.remoteId ?? fixture.remoteId, requestId: writeRequestId }), { status: 200 })
    }
    if (requestUrl.pathname === '/api/media') return new Response(JSON.stringify({ mediaId: 'sandbox-media-1' }), { status: 200 })
    if (requestUrl.pathname === '/oauth/token' || requestUrl.pathname === '/oauth/refresh') return new Response(JSON.stringify({ access_token: 'sandbox-test-token', refresh_token: 'sandbox-refresh-token', account_id: 'acct_local_sandbox' }), { status: 200 })
    return new Response(JSON.stringify({}), { status: 404 })
  })
  return { connector: createConfiguredConnector('taobao', { config: sandboxConfig(), credentials: sandboxCredentialProvider(revokedRefs), fetch, onExchange: options.onExchange, allowTestCredentials: true, allowTestAdapters: true }), fetch, revokedRefs }
}

describe('platform canary runner', () => {
  it('exchanges a controlled callback and binds the returned account to the tenant', async () => {
    const { connector, fetch } = localSandboxConnector()
    const result = await runPlatformCanary({
      connector, context: { workspaceId: 'ws_local_sandbox', accountId: 'acct_local_sandbox' },
      evidenceRef: 'artifact://sandbox/oauth', verifiedBy: 'local-contract-test', apiVersion: 'sandbox-v1', scope: 'sandbox.product.read', expectedRemoteId: profiles.taobao.fixture.remoteId,
      oauthCallback: { code: 'sandbox-authorize-code', state: 'sandbox-state', pendingState: 'sandbox-state', redirectUri: 'https://sandbox.local.test/callback' },
      allowWrite: false, allowRevoke: false,
    })
    expect(result.checks.find(item => item.capability === 'authorize')?.passed).toBe(true)
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/oauth/token'))).toBe(true)
  })

  it('rejects a production promotion without an actual OAuth callback before provider I/O', async () => {
    const { connector, fetch } = localSandboxConnector()
    const result = await runPlatformCanary({
      connector, context: { workspaceId: 'ws_local_sandbox', accountId: 'acct_local_sandbox' },
      evidenceRef: 'artifact://sandbox/oauth', verifiedBy: 'local-contract-test', apiVersion: 'sandbox-v1', scope: 'sandbox.product.read', expectedRemoteId: profiles.taobao.fixture.remoteId,
      allowWrite: true, allowRevoke: true, promoteToProductionCanary: true,
    })
    expect(result.passed).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects mismatched pending OAuth state before provider I/O', async () => {
    const { connector, fetch } = localSandboxConnector()
    const result = await runPlatformCanary({ connector, context: { workspaceId: 'ws_local_sandbox', accountId: 'acct_local_sandbox' }, evidenceRef: 'artifact://sandbox/oauth', verifiedBy: 'qa', apiVersion: 'sandbox-v1', scope: 'sandbox.product.read', expectedRemoteId: profiles.taobao.fixture.remoteId, oauthCallback: { code: 'actual-code', state: 'callback-state', pendingState: 'different-pending-state', redirectUri: 'https://sandbox.local.test/callback' }, allowWrite: true, allowRevoke: true, promoteToProductionCanary: true })
    expect(result.passed).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('stops all later provider operations after OAuth account mismatch', async () => {
    const { connector, fetch } = localSandboxConnector()
    const result = await runPlatformCanary({ connector, context: { workspaceId: 'ws_local_sandbox', accountId: 'wrong-account' }, evidenceRef: 'artifact://sandbox/oauth', verifiedBy: 'qa', apiVersion: 'sandbox-v1', scope: 'sandbox.product.read', expectedRemoteId: profiles.taobao.fixture.remoteId, oauthCallback: { code: 'actual-code', state: 'sandbox-state', pendingState: 'sandbox-state', redirectUri: 'https://sandbox.local.test/callback' }, allowWrite: true, allowRevoke: true, promoteToProductionCanary: true })
    expect(result.passed).toBe(false)
    expect(result.checks).toHaveLength(10)
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/oauth/token'])
  })
  it('proves a local sandbox test-shop contract without promoting evidence to production', async () => {
    const { connector, fetch, revokedRefs } = localSandboxConnector()
    const result = await runPlatformCanary({
      connector,
      context: { workspaceId: 'ws_local_sandbox', accountId: 'acct_local_sandbox' },
      evidenceRef: 'artifact://sandbox/local-taobao',
      verifiedBy: 'local-contract-test',
      apiVersion: 'sandbox-contract-v1',
      scope: 'sandbox.product.read sandbox.product.write',
      expectedRemoteId: profiles.taobao.fixture.remoteId,
      allowWrite: true,
      allowRevoke: true,
      oauthCallback: { code: 'sandbox-authorize-code', state: 'sandbox-state', pendingState: 'sandbox-state', redirectUri: 'https://sandbox.local.test/callback' },
      mediaFile: (() => { const bytes = new Uint8Array([1, 2, 3]); return { bytes, mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex') } })(),
    })

    expect(result.passed, JSON.stringify(result)).toBe(true)
    expect(result.checks.every(item => item.passed && !item.simulated)).toBe(true)
    expect(result.evidence.every(item => item.state === 'test_e2e')).toBe(true)
    expect(result.evidence.every(item => item.evidenceRef?.startsWith('artifact://sandbox/local-taobao'))).toBe(true)
    expect(result.evidence.some(item => item.state === 'production_canary')).toBe(false)
    expect(result.checks.find(item => item.capability === 'refresh')).toMatchObject({ passed: true, simulated: false })
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/oauth/refresh'))).toBe(true)
    expect(revokedRefs).toEqual(['sandbox://credential'])
    expect(revokedRefs.every(ref => !ref.startsWith('canary://'))).toBe(true)
  })

  it('only promotes a fully successful non-simulated run to production_canary', async () => {
    const { connector } = localSandboxConnector()
    const result = await runPlatformCanary({
      connector,
      context: { workspaceId: 'ws_local_sandbox', accountId: 'acct_local_sandbox' },
      evidenceRef: 'artifact://sandbox/local-taobao', verifiedBy: 'local-contract-test', apiVersion: 'sandbox-contract-v1', scope: 'sandbox.product.read',
      expectedRemoteId: profiles.taobao.fixture.remoteId,
      allowWrite: false, allowRevoke: false,
      oauthCallback: { code: 'sandbox-authorize-code', state: 'sandbox-state', pendingState: 'sandbox-state', redirectUri: 'https://sandbox.local.test/callback' },
      promoteToProductionCanary: true,
    })
    expect(result.evidence.find(item => item.capability === 'authorize')?.state).toBe('test_e2e')
    expect(result.evidence.some(item => item.state === 'production_canary')).toBe(false)
  })

  it('rejects a provider status response unrelated to the create receipt', async () => {
    const { connector } = localSandboxConnector({ statusRequestId: 'different-provider-request' })
    const bytes = new Uint8Array([1, 2, 3])
    const result = await runPlatformCanary({
      connector, context: { workspaceId: 'ws_local_sandbox', accountId: 'acct_local_sandbox' },
      evidenceRef: 'artifact://sandbox/status-binding', verifiedBy: 'local-contract-test',
      apiVersion: 'sandbox-contract-v1', scope: 'sandbox.product.read', expectedRemoteId: profiles.taobao.fixture.remoteId,
      allowWrite: true, allowRevoke: true, mediaFile: { bytes, mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex') },
    })
    expect(result.passed).toBe(false)
    expect(result.checks.find(item => item.capability === 'query_status')?.passed).toBe(false)
    expect(result.evidence.some(item => item.state === 'production_canary')).toBe(false)
  })

  it('rejects incremental sync when the provider supplied no cursor', async () => {
    const { connector } = localSandboxConnector({ omitCursor: true })
    const result = await runPlatformCanary({
      connector, context: { workspaceId: 'ws_local_sandbox', accountId: 'acct_local_sandbox' },
      evidenceRef: 'artifact://sandbox/cursor-binding', verifiedBy: 'local-contract-test',
      apiVersion: 'sandbox-contract-v1', scope: 'sandbox.product.read', expectedRemoteId: profiles.taobao.fixture.remoteId,
      allowWrite: false, allowRevoke: false,
    })
    expect(result.checks.find(item => item.capability === 'incremental_sync')).toMatchObject({ passed: false, detail: expect.stringContaining('no provider cursor') })
  })

  it('records only secret-free provider exchange metadata', async () => {
    const observations: unknown[] = []
    const { connector } = localSandboxConnector({ onExchange: observation => observations.push(observation) })
    await connector.syncProducts({ workspaceId: 'ws_local_sandbox', accountId: 'acct_local_sandbox' })
    const record = observations[0] as Record<string, unknown>
    expect(record).toMatchObject({ platform: 'taobao', operation: 'sync_products', workspaceId: 'ws_local_sandbox', accountId: 'acct_local_sandbox', method: 'GET', origin: 'https://sandbox.local.test', status: 200, transport: 'fetch' })
    expect(Object.keys(record).sort()).toEqual(['accountId', 'method', 'observedAt', 'operation', 'origin', 'platform', 'status', 'transport', 'workspaceId'])
    expect(JSON.stringify(observations)).not.toContain('sandbox-test-token')
  })

  it('fails closed without a retryable provider result when exchange recording fails', async () => {
    const { connector } = localSandboxConnector({ onExchange: () => { throw new Error('collector unavailable') } })
    await expect(connector.syncProducts({ workspaceId: 'ws_local_sandbox', accountId: 'acct_local_sandbox' })).rejects.toMatchObject({ normalized: { unknown: true, retryable: false } })
  })

  it('does not promote a fixture or disabled write/revoke run to production_canary', async () => {
    const result = await runPlatformCanary({
      connector: createFakeConnector('taobao', { configured: true, allowFakeWrites: true }),
      context: { workspaceId: 'ws_canary', accountId: 'acct_canary' },
      evidenceRef: 'artifact://canary/test', verifiedBy: 'qa', apiVersion: 'fixture', scope: 'fixture', allowWrite: false, allowRevoke: false,
      expectedRemoteId: profiles.taobao.fixture.remoteId,
    })
    expect(result.passed).toBe(false)
    expect(result.evidence.every(item => item.state !== 'production_canary')).toBe(true)
    expect(result.checks.find(item => item.capability === 'create')?.detail).toContain('write canary disabled')
  })

  it('rejects malformed attribution before touching the connector', async () => {
    const connector = createFakeConnector('taobao', { configured: true, allowFakeWrites: true })
    const authorize = vi.spyOn(connector, 'authorize')
    const result = await runPlatformCanary({
      connector,
      context: { workspaceId: 'ws_local\nforged', accountId: 'acct_local' },
      evidenceRef: 'fixture://unverified', verifiedBy: 'qa', apiVersion: 'fixture', scope: 'fixture',
      expectedRemoteId: profiles.taobao.fixture.remoteId, allowWrite: false, allowRevoke: false,
    })

    expect(result.passed).toBe(false)
    expect(result.checks).toHaveLength(10)
    expect(result.checks.every(item => item.detail?.includes('invalid evidence, scope, or media attribution'))).toBe(true)
    expect(authorize).not.toHaveBeenCalled()
  })

  it('rejects a media canary whose declared hash does not match the bytes', async () => {
    const { connector } = localSandboxConnector()
    const authorize = vi.spyOn(connector, 'authorize')
    const result = await runPlatformCanary({
      connector,
      context: { workspaceId: 'ws_local_sandbox', accountId: 'acct_local_sandbox' },
      evidenceRef: 'artifact://sandbox/local-taobao', verifiedBy: 'local-contract-test', apiVersion: 'sandbox-contract-v1', scope: 'sandbox.product.read',
      expectedRemoteId: profiles.taobao.fixture.remoteId, allowWrite: false, allowRevoke: false,
      mediaFile: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', sha256: 'a'.repeat(64) },
    })
    expect(result.passed).toBe(false)
    expect(result.checks).toHaveLength(10)
    expect(result.checks.every(item => item.detail?.includes('invalid evidence, scope, or media attribution'))).toBe(true)
    expect(authorize).not.toHaveBeenCalled()
  })

  it('requires non-simulated write and query evidence even when fixture operations succeed', async () => {
    const result = await runPlatformCanary({
      connector: createFakeConnector('jd', { configured: true, allowFakeWrites: true }),
      context: { workspaceId: 'ws_canary', accountId: 'acct_canary' },
      evidenceRef: 'artifact://canary/fixture', verifiedBy: 'qa', apiVersion: 'fixture', scope: 'fixture', allowWrite: true, allowRevoke: true,
      expectedRemoteId: profiles.jd.fixture.remoteId,
    })
    expect(result.passed).toBe(false)
    expect(result.checks.filter(item => ['create', 'update', 'query_status'].includes(item.capability)).some(item => item.simulated)).toBe(true)
  })
})
