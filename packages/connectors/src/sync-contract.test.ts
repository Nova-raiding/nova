import { describe, expect, it, vi } from 'vitest'
import { createConfiguredConnector, type AccessCredential, type CredentialProvider, type HttpConnectorConfig, type RawProduct } from './index.js'
import { deduplicateSyncProducts, validateNextSyncCursor, validateSyncCursor, validateSyncWindow } from './sync-safety.js'

const product = (remoteId: string, observedAt = '2026-08-31T10:00:00.000Z', title = 'same'): RawProduct => ({
  remoteId, title, description: '', price: 1, stock: 1, sku: [], images: [], category: 'cat', attributes: {}, platformFields: {}, observedAt,
})

function config(overrides: Partial<HttpConnectorConfig> = {}): HttpConnectorConfig {
  return {
    clientId: 'jd-app', clientSecret: 'jd-secret',
    oauth: { authorizeUrl: 'https://jd.test/oauth/authorize', tokenUrl: 'https://jd.test/oauth/token' },
    api: { baseUrl: 'https://jd.test/api', syncPath: '/products', createPath: '/create', updatePath: '/update', queryPath: '/query' },
    mapProducts: payload => (payload as { items: RawProduct[] }).items,
    capabilityEvidence: ['authorize', 'read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke'].map(capability => ({ platform: 'jd' as const, capability: capability as never, state: 'test_e2e' as const, evidenceRef: 'sync-test', verifiedBy: 'test', verifiedAt: '2026-08-31T00:00:00Z' })),
    ...overrides,
  }
}

function provider(): CredentialProvider {
  const credential: AccessCredential = { accessToken: 'access-token' }
  return { kind: 'test', async resolve() { return credential }, async store({ accountId }) { return { accountId, credentialRef: 'vault://test' } }, async revoke() {} }
}

describe('connector sync safety contract', () => {
  it('validates bounded cursors and monotonic next cursors', () => {
    expect(validateSyncCursor({ value: 'cursor-1' })).toBe('cursor-1')
    expect(validateNextSyncCursor({ value: 'cursor-2' }, 'cursor-1')).toEqual({ value: 'cursor-2' })
    expect(() => validateSyncCursor({ value: 'bad\u0000cursor' })).toThrow('invalid')
    expect(() => validateNextSyncCursor({ value: 'cursor-1' }, 'cursor-1')).toThrow('advance')
  })

  it('rejects inverted or malformed time windows', () => {
    expect(validateSyncWindow({ updatedSince: '2026-08-31T00:00:00Z', updatedUntil: '2026-09-01T00:00:00Z' })).toBeDefined()
    expect(() => validateSyncWindow({ updatedSince: '2026-09-01T00:00:00Z', updatedUntil: '2026-08-31T00:00:00Z' })).toThrow('inverted')
    expect(() => validateSyncWindow({ updatedSince: 'not-a-date' })).toThrow('invalid')
  })

  it('deduplicates identical records and rejects conflicting identities', () => {
    expect(deduplicateSyncProducts([product('p1'), product('p1'), product('p2')], 'jd')).toHaveLength(2)
    expect(() => deduplicateSyncProducts([product('p1'), product('p1', undefined, 'changed')], 'jd')).toThrow('conflicting duplicate')
  })

  it('passes cursor and time window to the platform and accepts an advancing cursor', async () => {
    const urls: string[] = []
    const connector = createConfiguredConnector('jd', {
      config: config({ sync: { updatedSince: '2026-08-31T00:00:00Z', updatedUntil: '2026-09-01T00:00:00Z' } }), credentials: provider(), allowTestCredentials: true, allowTestAdapters: true,
      fetch: vi.fn(async (url: string | URL) => { urls.push(String(url)); return new Response(JSON.stringify({ items: [product('p1')], nextCursor: 'cursor-2' }), { status: 200 }) }),
    })
    await expect(connector.syncProducts({ workspaceId: 'ws', accountId: 'acct' }, { value: 'cursor-1' })).resolves.toMatchObject({ items: [product('p1')], nextCursor: { value: 'cursor-2' } })
    expect(urls[0]).toContain('cursor=cursor-1')
    expect(urls[0]).toContain('updated_since=2026-08-31T00%3A00%3A00Z')
    await expect(connector.syncProducts({ workspaceId: 'ws', accountId: 'acct' }, { value: 'cursor-1' })).resolves.toBeDefined()
  })

  it('marks a timed-out page unknown and requires reconciliation', async () => {
    const connector = createConfiguredConnector('jd', {
      config: config({ timeoutMs: 5 }), credentials: provider(), allowTestCredentials: true, allowTestAdapters: true,
      fetch: vi.fn(async (_url: string | URL, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError'))))),
    })
    const result = connector.syncProducts({ workspaceId: 'ws', accountId: 'acct' })
    await expect(result).rejects.toMatchObject({ normalized: { code: 'TIMEOUT', unknown: true, retryable: true, details: { reconcileRequired: true } } })
  })
})
