import { describe, expect, it, vi } from 'vitest'
import {
  createConfiguredConnector,
  profiles,
  type AccessCredential,
  type CredentialProvider,
  type HttpConnectorConfig,
  type Platform,
  type RawProduct,
} from '../packages/connectors/src/index.js'

const platforms = Object.keys(profiles) as Platform[]

function provider(): CredentialProvider {
  const credential: AccessCredential = { accessToken: 'local-fixture-token' }
  return {
    kind: 'test',
    async resolve() { return credential },
    async store({ accountId, workspaceId }) { return { accountId, ...(workspaceId ? { workspaceId } : {}), credentialRef: 'fixture://credential' } },
    async revoke() {},
  }
}

function baseConfig(platform: Platform, overrides: Partial<HttpConnectorConfig> = {}): HttpConnectorConfig {
  const host = `${platform}.local.test`
  return {
    clientId: `local-${platform}-client`,
    clientSecret: `local-${platform}-secret`,
    oauth: {
      authorizeUrl: `https://${host}/oauth/authorize`,
      tokenUrl: `https://${host}/oauth/token`,
      scopes: [`fixture.${platform}.read`, `fixture.${platform}.write`],
    },
    api: { baseUrl: `https://${host}/api`, syncPath: '/products', createPath: '/products', updatePath: '/products', queryPath: '/products/status' },
    allowedHosts: [host],
    mapProducts: payload => (payload as { items: RawProduct[] }).items,
    ...overrides,
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function connectorFor(platform: Platform, fetch: NonNullable<Parameters<typeof createConfiguredConnector>[1]>['fetch'], overrides: Partial<HttpConnectorConfig> = {}) {
  return createConfiguredConnector(platform, {
    config: baseConfig(platform, overrides),
    credentials: provider(),
    fetch,
    allowTestCredentials: true,
    allowTestAdapters: true,
  })
}

describe('local six-platform connector profile smoke', () => {
  it.each(platforms)('%s exposes the configured OAuth scopes without real platform access', async platform => {
    const requests: Array<{ url: string; body?: string }> = []
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), ...(init?.body ? { body: String(init.body) } : {}) })
      return jsonResponse({ access_token: 'local-token', account_id: `local-account-${platform}`, scope: `fixture.${platform}.read fixture.${platform}.write` })
    })
    const connector = connectorFor(platform, fetch)

    const authorization = await connector.authorize({
      workspaceId: `workspace-${platform}`,
      actorId: 'local-test',
      redirectUri: 'https://local.test/callback',
      state: `state-${platform}`,
    })

    expect(authorization).toMatchObject({ ok: true, mode: 'real', platform })
    const authUrl = new URL(authorization.authorizationUrl!)
    expect(authUrl.searchParams.get('scope')?.split(' ')).toEqual([`fixture.${platform}.read`, `fixture.${platform}.write`])

    const credential = await connector.exchangeCode({ code: 'local-code', state: `state-${platform}`, workspaceId: `workspace-${platform}` })
    expect(credential).toMatchObject({ accountId: `local-account-${platform}`, workspaceId: `workspace-${platform}`, scope: `fixture.${platform}.read fixture.${platform}.write` })
    expect(requests).toHaveLength(1)
    const tokenRequest = requests[0]!
    expect(tokenRequest.url).toContain(`/oauth/token`)
    expect(tokenRequest.body).toContain('grant_type=authorization_code')
  })

  it.each(platforms)('%s reads a paginated fixture page and deduplicates incremental records', async platform => {
    const fixture = profiles[platform].fixture
    const duplicate = structuredClone(fixture)
    const urls: string[] = []
    const fetch = vi.fn(async (url: string | URL) => {
      urls.push(String(url))
      const requestUrl = new URL(String(url))
      if (requestUrl.searchParams.has('cursor')) return jsonResponse({ items: [fixture], nextCursor: 'page-2' })
      return jsonResponse({ items: [fixture, duplicate], nextCursor: 'page-1' })
    })
    const connector = connectorFor(platform, fetch, {
      sync: { updatedSince: '2026-08-21T00:00:00.000Z', updatedUntil: '2026-08-23T00:00:00.000Z' },
    })
    const context = { workspaceId: `workspace-${platform}`, accountId: `account-${platform}` }

    const first = await connector.syncProducts(context)
    const second = await connector.syncProducts(context, first.nextCursor)

    expect(first.source).toBe('official_api')
    expect(first.simulated).toBe(false)
    expect(first.items).toHaveLength(1)
    expect(first.items[0]!.remoteId).toBe(fixture.remoteId)
    expect(first.nextCursor).toEqual({ value: 'page-1' })
    expect(second.items).toEqual([fixture])
    expect(urls[0]!).toContain('updated_since=2026-08-21T00%3A00%3A00.000Z')
    expect(urls[0]!).toContain('updated_until=2026-08-23T00%3A00%3A00.000Z')
    expect(urls[1]!).toContain('cursor=page-1')
  })

  it.each(platforms)('%s returns attributable readback status after a fixture write', async platform => {
    const fixture = profiles[platform].fixture
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/status')) return jsonResponse({ found: true, state: 'published', remoteId: fixture.remoteId, requestId: 'local-request-1' })
      return jsonResponse({ remoteId: fixture.remoteId, requestId: 'local-request-1' })
    })
    const connector = connectorFor(platform, fetch)
    const context = { workspaceId: `workspace-${platform}`, accountId: `account-${platform}` }
    const input = { remoteId: fixture.remoteId, idempotencyKey: `local-write-${platform}`, fields: { title: fixture.title, category: fixture.category, price: fixture.price, stock: fixture.stock } }

    const receipt = await connector.createProduct(context, input)
    const status = await connector.queryWrite(context, { idempotencyKey: input.idempotencyKey, remoteId: receipt.remoteId })

    expect(receipt).toMatchObject({ platform, operation: 'create', remoteId: fixture.remoteId, requestId: 'local-request-1', simulated: false, status: 'submitted' })
    expect(status).toMatchObject({ found: true, state: 'published', remoteId: fixture.remoteId, requestId: 'local-request-1', simulated: false })
  })

  it.each(platforms)('%s marks a timed-out fixture page unknown and requires reconciliation', async platform => {
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      const onAbort = () => reject(new DOMException('local fixture timeout', 'TimeoutError'))
      if (init?.signal?.aborted) onAbort()
      else init?.signal?.addEventListener('abort', onAbort, { once: true })
    }))
    const connector = connectorFor(platform, fetch, { timeoutMs: 5 })

    await expect(connector.syncProducts({ workspaceId: `workspace-${platform}`, accountId: `account-${platform}` }))
      .rejects.toMatchObject({ normalized: { code: 'TIMEOUT', unknown: true, retryable: true, platform, details: { reconcileRequired: true } } })
  })
})
