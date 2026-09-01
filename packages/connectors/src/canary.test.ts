import { describe, expect, it, vi } from 'vitest'
import { createConfiguredConnector, createFakeConnector, profiles, runPlatformCanary, type AccessCredential, type CredentialProvider, type HttpConnectorConfig } from './index.js'

function sandboxCredentialProvider(): CredentialProvider {
  const credential: AccessCredential = { accessToken: 'sandbox-test-token' }
  return {
    kind: 'test',
    async resolve() { return credential },
    async store({ accountId, workspaceId }) { return { accountId, ...(workspaceId ? { workspaceId } : {}), credentialRef: 'sandbox://credential' } },
    async revoke() {},
  }
}

function sandboxConfig(): HttpConnectorConfig {
  return {
    clientId: 'local-sandbox-client',
    clientSecret: 'local-sandbox-secret',
    oauth: {
      authorizeUrl: 'https://sandbox.local.test/oauth/authorize',
      tokenUrl: 'https://sandbox.local.test/oauth/token',
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
    allowedHosts: ['sandbox.local.test'],
    mapMediaUpload: payload => ({ mediaId: String((payload as { mediaId: string }).mediaId) }),
  }
}

function localSandboxConnector() {
  const fixture = profiles.taobao.fixture
  let writeRequestId = 'sandbox-create-request'
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const requestUrl = new URL(String(url))
    if (requestUrl.pathname === '/oauth/revoke') return new Response('{}', { status: 200 })
    if (requestUrl.pathname === '/api/products/status') return new Response(JSON.stringify({ found: true, state: 'published', remoteId: fixture.remoteId, requestId: writeRequestId }), { status: 200 })
    if (requestUrl.pathname === '/api/products' && init?.method === 'GET') {
      return new Response(JSON.stringify(requestUrl.searchParams.has('cursor') ? { items: [], nextCursor: undefined } : { items: [fixture], nextCursor: 'sandbox-page-2' }), { status: 200 })
    }
    if (requestUrl.pathname === '/api/products' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { idempotencyKey?: string; remoteId?: string }
      if (body.remoteId) writeRequestId = 'sandbox-update-request'
      return new Response(JSON.stringify({ remoteId: body.remoteId ?? fixture.remoteId, requestId: writeRequestId }), { status: 200 })
    }
    if (requestUrl.pathname === '/api/media') return new Response(JSON.stringify({ mediaId: 'sandbox-media-1' }), { status: 200 })
    if (requestUrl.pathname === '/oauth/token') return new Response(JSON.stringify({ access_token: 'sandbox-test-token' }), { status: 200 })
    return new Response(JSON.stringify({}), { status: 404 })
  })
  return { connector: createConfiguredConnector('taobao', { config: sandboxConfig(), credentials: sandboxCredentialProvider(), fetch, allowTestCredentials: true, allowTestAdapters: true }), fetch }
}

describe('platform canary runner', () => {
  it('proves a local sandbox test-shop contract without promoting evidence to production', async () => {
    const { connector, fetch } = localSandboxConnector()
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
      mediaFile: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', sha256: 'a'.repeat(64) },
    })

    expect(result.passed, JSON.stringify(result)).toBe(true)
    expect(result.checks.every(item => item.passed && !item.simulated)).toBe(true)
    expect(result.evidence.every(item => item.state === 'test_e2e')).toBe(true)
    expect(result.evidence.every(item => item.evidenceRef?.startsWith('artifact://sandbox/local-taobao'))).toBe(true)
    expect(result.evidence.some(item => item.state === 'production_canary')).toBe(false)
    expect(fetch).toHaveBeenCalled()
  })

  it('only promotes a fully successful non-simulated run to production_canary', async () => {
    const { connector } = localSandboxConnector()
    const result = await runPlatformCanary({
      connector,
      context: { workspaceId: 'ws_local_sandbox', accountId: 'acct_local_sandbox' },
      evidenceRef: 'artifact://sandbox/local-taobao', verifiedBy: 'local-contract-test', apiVersion: 'sandbox-contract-v1', scope: 'sandbox.product.read',
      expectedRemoteId: profiles.taobao.fixture.remoteId,
      allowWrite: false, allowRevoke: false,
      promoteToProductionCanary: true,
    })
    expect(result.evidence.find(item => item.capability === 'authorize')?.state).toBe('test_e2e')
    expect(result.evidence.some(item => item.state === 'production_canary')).toBe(false)
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
