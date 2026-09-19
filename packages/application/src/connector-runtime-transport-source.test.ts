import { describe, expect, it, vi } from 'vitest'
import { ConnectorRuntime } from './connector-runtime.js'
import type { CapabilityEvidence, CapabilityName } from '../../../packages/connectors/src/capability-evidence.js'
import type { HttpConnectorConfig, RawProduct } from '../../../packages/connectors/src/types.js'

const REQUIRED_CAPABILITIES: readonly CapabilityName[] = [
  'authorize', 'refresh', 'read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke', 'media_upload',
]

const capabilityEvidence: CapabilityEvidence[] = REQUIRED_CAPABILITIES.map(capability => ({
  platform: 'tmall' as const,
  capability,
  state: 'test_e2e' as const,
  evidenceRef: `test://tmall/${capability}`,
  verifiedBy: 'unit-test',
  verifiedAt: '2026-08-22T00:00:00Z',
}))

const remoteRow: RawProduct = {
  remoteId: 'TB-REAL-1001',
  title: '真实店铺商品',
  description: '由平台 API 返回',
  price: 199,
  stock: 7,
  sku: [],
  images: [],
  category: '女装 > 外套',
  attributes: {},
  platformFields: { num_iid: 'TB-REAL-1001' },
  observedAt: '2026-08-30T00:00:00.000Z',
}

/**
 * A fully ready platform connector: this is the configuration a credentialed,
 * canary-verified production sync uses, not a fixture short cut.
 */
const readyConfig: HttpConnectorConfig = {
  clientId: 'tmall-app',
  clientSecret: 'secret-is-never-logged',
  oauth: { authorizeUrl: 'https://platform.test/oauth/authorize', tokenUrl: 'https://platform.test/oauth/token', refreshUrl: 'https://platform.test/oauth/refresh', revokeUrl: 'https://platform.test/oauth/revoke' },
  api: { baseUrl: 'https://platform.test/api', syncPath: '/products', createPath: '/products', updatePath: '/products/update', queryPath: '/publish/status' },
  signer: { kind: 'platform', sign: () => ({ 'x-platform-signature': 'platform-adapter' }) },
  mapProducts: () => [structuredClone(remoteRow)],
  mapWriteReceipt: (_payload, input, operation, platform) => ({ platform, operation, remoteId: input.remoteId ?? 'remote-test', requestId: 'request-test', status: 'submitted', simulated: false, idempotencyKey: input.idempotencyKey }),
  mapWriteStatus: () => ({ found: true, state: 'submitted', simulated: false }),
  mediaUploadPath: '/media/upload',
  mapMediaUpload: () => ({ mediaId: 'media-test' }),
  mappingEvidence: { version: 'test.mapping.v1', evidenceRef: 'test-only', verifiedBy: 'unit-test', verifiedAt: '2026-08-22T00:00:00Z' },
  mediaUploadEvidence: { version: 'test.media.v1', evidenceRef: 'test-only', verifiedBy: 'unit-test', verifiedAt: '2026-08-22T00:00:00Z' },
  capabilityEvidence,
}

const vault = {
  kind: 'vault' as const,
  async resolve() { return { accessToken: 'access-token' } },
  async store({ accountId }: { accountId: string }) { return { accountId, credentialRef: `vault://${accountId}` } },
  async revoke() { /* no remote revoke in this transport test */ },
}

describe('ConnectorRuntime sync transport source', () => {
  it('marks page items read from a configured platform API as official API data', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [{ id: 'TB-REAL-1001' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const runtime = new ConnectorRuntime({ environment: 'development', connectorConfigs: { tmall: readyConfig }, credentialProvider: vault, fetch: fetchMock })
    expect(runtime.canRead('tmall')).toBe(true)

    const result = await runtime.sync('tmall', { workspaceId: 'ws-official', accountId: 'acct-official', traceId: 'trace-official' })
    expect(result.source).toBe('official_api')
    expect(result.simulated).toBe(false)
    // The persisted row source is what the API turns into
    // `source: 'official_api'`; the shared profile would otherwise claim
    // 'fixture' and mark the merchant's live store as simulated demo data.
    expect(result.items[0]).toMatchObject({ source: 'official_api', platform: 'tmall', remoteId: 'TB-REAL-1001' })
    expect(fetchMock).toHaveBeenCalled()
  })

  it('keeps fixture mode rows marked as fixture data', async () => {
    const runtime = new ConnectorRuntime({ fixtureMode: true, environment: 'development' })
    const result = await runtime.sync('tmall', { workspaceId: 'ws-fixture', accountId: 'acct-fixture', traceId: 'trace-fixture' })
    expect(result.source).toBe('fixture')
    expect(result.simulated).toBe(true)
    expect(result.items[0]).toMatchObject({ source: 'fixture' })
  })

  it('corrects a connector whose canonical mapper mislabels the page transport', async () => {
    // A connector profile can only describe the fixture shape, so the page
    // transport is the single source of truth for the row source.
    const runtime = new ConnectorRuntime({ fixtureMode: true, environment: 'development' })
    const fixtureConnector = runtime.connector('tmall')
    const mislabelled = { ...fixtureConnector.mapToCanonical(remoteRow, { id: 'tmall.mapping.v1' }), source: 'fixture' as const }
    const connectors = runtime.connectors as Record<string, unknown>
    connectors.tmall = {
      platform: 'tmall',
      profile: fixtureConnector.profile,
      syncProducts: async () => ({ items: [structuredClone(remoteRow)], source: 'official_api', simulated: false }),
      mapToCanonical: () => structuredClone(mislabelled),
    }
    const result = await runtime.sync('tmall', { workspaceId: 'ws-mislabel', accountId: 'acct-mislabel', traceId: 'trace-mislabel' })
    expect(result.source).toBe('official_api')
    expect(result.items[0]).toMatchObject({ source: 'official_api' })
  })
})
