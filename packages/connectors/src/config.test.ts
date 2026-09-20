import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnwiredPlatformSwitchError, buildHttpConnectorConfigs, buildHttpConnectorConfigsFromStructured, platformConfigPrefix, unwiredPlatformSwitches } from './config.js'
import { validateConnectorAuthorizationReadiness } from './readiness.js'
import type { HttpRequestDescriptor } from './types.js'

// Key names are assembled from `platformConfigPrefix` instead of being written
// out: that is the same table the rejection derives from, so these tests cannot
// pass against a hand-copied list that has drifted from it.
const platforms = ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] as const
type TestPlatform = typeof platforms[number]
const switchNames = ['AUTH', 'READ', 'WRITE'] as const
const switchKey = (platform: TestPlatform, name: typeof switchNames[number]) => `${platformConfigPrefix(platform)}_${name}_ENABLED`
// Platforms whose switches the runtime actually reads; the rest must be refused.
const wiredSwitchPlatforms: readonly TestPlatform[] = ['jd', 'taobao', 'douyin']
const unwiredSwitchPlatforms = platforms.filter(platform => !wiredSwitchPlatforms.includes(platform))
function thrownMessage(source: Record<string, string | undefined>): string | undefined {
  try { buildHttpConnectorConfigs(source); return undefined } catch (error) { return (error as Error).message }
}

const base = {
  JD_AUTH_ENABLED: 'true', JD_READ_ENABLED: 'true', JD_WRITE_ENABLED: 'true',
  JD_APP_KEY: 'jd-app', JD_OAUTH_AUTHORIZE_URL: 'https://jd.test/authorize', JD_OAUTH_TOKEN_URL: 'https://jd.test/token', JD_API_BASE_URL: 'https://jd.test/api',
  TAOBAO_APP_KEY: 'taobao-app', TAOBAO_OAUTH_AUTHORIZE_URL: 'https://taobao.test/authorize', TAOBAO_OAUTH_TOKEN_URL: 'https://taobao.test/token', TAOBAO_API_BASE_URL: 'https://taobao.test/api',
  TMALL_APP_KEY: 'tmall-app', TMALL_OAUTH_AUTHORIZE_URL: 'https://tmall.test/authorize', TMALL_OAUTH_TOKEN_URL: 'https://tmall.test/token', TMALL_API_BASE_URL: 'https://tmall.test/api',
  PDD_CLIENT_ID: 'pdd-app', PDD_OAUTH_AUTHORIZE_URL: 'https://pdd.test/authorize', PDD_OAUTH_TOKEN_URL: 'https://pdd.test/token', PDD_API_BASE_URL: 'https://pdd.test/api',
}

const compare = ([left]: [string, unknown], [right]: [string, unknown]) => left < right ? -1 : left > right ? 1 : 0
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'signature_base64').sort(compare).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

describe('platform HTTP configuration', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('requires HTTPS for production OAuth and API endpoints', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const result = buildHttpConnectorConfigs({ ...base, JD_OAUTH_AUTHORIZE_URL: 'http://jd.test/authorize', JD_SYNC_PATH: '/products', JD_CREATE_PATH: '/products/create', JD_UPDATE_PATH: '/products/update', JD_QUERY_PATH: '/products/status' })
    expect(result.readiness.jd.ready).toBe(false)
    expect(result.readiness.jd.reasons).toContain('HTTPS_REQUIRED')
  })

  it('requires explicit API paths when the injected source is production', () => {
    const result = buildHttpConnectorConfigs({ ...base, NODE_ENV: 'production' })
    expect(result.missing.jd).toEqual(expect.arrayContaining([
      'JD_SYNC_PATH', 'JD_CREATE_PATH', 'JD_UPDATE_PATH', 'JD_QUERY_PATH',
    ]))
    expect(result.readiness.jd.reasons).toContain('CONFIG_MISSING')
    expect(result.configs.jd).toBeUndefined()
  })

  it('consumes JD operation switches and fails closed when they are absent or malformed', () => {
    for (const source of [
      { ...base, JD_AUTH_ENABLED: undefined },
      { ...base, JD_AUTH_ENABLED: 'enabled' },
      { ...base, JD_AUTH_ENABLED: 'false' },
    ]) {
      const result = buildHttpConnectorConfigs(source)
      expect(result.allConfigs.jd).toBeUndefined()
      expect(result.configs.jd).toBeUndefined()
      expect(result.missing.jd).toContain('JD_AUTH_ENABLED=true')
      expect(result.readiness.jd.reasons).toContain('CONFIG_MISSING')
    }
  })

  it('keeps OAuth diagnostic config but denies connector admission when JD read or write is disabled', () => {
    const readDisabled = buildHttpConnectorConfigs({ ...base, JD_READ_ENABLED: 'false' })
    expect(readDisabled.allConfigs.jd).toBeDefined()
    expect(readDisabled.configs.jd).toBeUndefined()
    expect(readDisabled.readiness.jd.reasons).toContain('READ_DISABLED')
    expect(validateConnectorAuthorizationReadiness('jd', readDisabled.allConfigs.jd).ready).toBe(true)

    const writeDisabled = buildHttpConnectorConfigs({ ...base, JD_WRITE_ENABLED: 'not-a-boolean' })
    expect(writeDisabled.allConfigs.jd).toBeDefined()
    expect(writeDisabled.configs.jd).toBeUndefined()
    expect(writeDisabled.readiness.jd.reasons).toContain('WRITE_DISABLED')
  })

  it('loads release-bound production capability evidence into runtime readiness', () => {
    const verifiedAt = new Date(Date.now() - 60_000).toISOString()
    const capabilities = Object.fromEntries(['authorize', 'refresh', 'read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke', 'media_upload'].map(capability => [capability, {
      state: 'production_canary', evidence_ref: `artifact://production/jd/${capability}#${'a'.repeat(64)}`, verified_by: 'platform-qa', verified_at: verifiedAt, api_version: 'v1', scope: 'item.read',
    }]))
    const source = {
      ...base, NODE_ENV: 'production', RELEASE_ID: 'release-1', RELEASE_GIT_SHA: 'a'.repeat(40), RELEASE_MANIFEST_SHA256: 'b'.repeat(64), RELEASE_IMAGE_SET_DIGEST: `sha256:${'c'.repeat(64)}`, JD_APP_SECRET: 'signer-secret',
      JD_SYNC_PATH: '/products', JD_CREATE_PATH: '/products/create', JD_UPDATE_PATH: '/products/update', JD_QUERY_PATH: '/products/status',
      JD_MEDIA_UPLOAD_PATH: '/media/upload', JD_MEDIA_ID_PATH: 'data.media_id',
      JD_MEDIA_UPLOAD_EVIDENCE_VERSION: 'media-v1', JD_MEDIA_UPLOAD_EVIDENCE_REF: 'artifact://production/jd/media', JD_MEDIA_UPLOAD_EVIDENCE_VERIFIED_BY: 'platform-qa', JD_MEDIA_UPLOAD_EVIDENCE_VERIFIED_AT: verifiedAt,
      JD_MAPPING_EVIDENCE_VERSION: 'mapping-v1', JD_MAPPING_EVIDENCE_REF: 'artifact://production/jd/mapping', JD_MAPPING_EVIDENCE_VERIFIED_BY: 'platform-qa', JD_MAPPING_EVIDENCE_VERIFIED_AT: verifiedAt,
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const document: Record<string, unknown> = { schema_version: '1', release_id: 'release-1', release_git_sha: source.RELEASE_GIT_SHA, manifest_sha256: source.RELEASE_MANIFEST_SHA256, image_set_digest: source.RELEASE_IMAGE_SET_DIGEST, deployment_nonce: 'deployment_nonce_abcdefghijklmnop', key_id: 'release-key', environment: 'production', simulated: false, platforms: [{ platform: 'jd', application_id: 'jd-app', test_store_id: 'jd-store', capabilities }] }
    document.signature_base64 = sign(null, Buffer.from(canonical(document)), privateKey).toString('base64')
    const result = buildHttpConnectorConfigs(source, { capabilityEvidenceTrust: { documentJson: JSON.stringify(document), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), trustedKeyId: 'release-key' } })
    expect(result.allConfigs.jd?.capabilityEvidence).toHaveLength(10)
    expect(result.readiness.jd.reasons).not.toContain('CAPABILITY_EVIDENCE_MISSING')
    expect(result.readiness.jd.reasons).not.toContain('MEDIA_UPLOAD_MAPPING_MISSING')
  })

  it('rejects capability evidence from another release or a simulated run', () => {
    const common = { ...base, NODE_ENV: 'production', RELEASE_ID: 'release-1', JD_SYNC_PATH: '/products', JD_CREATE_PATH: '/products/create', JD_UPDATE_PATH: '/products/update', JD_QUERY_PATH: '/products/status' }
    for (const document of [
      { schema_version: '1', release_id: 'release-2', environment: 'production', simulated: false, platforms: [] },
      { schema_version: '1', release_id: 'release-1', environment: 'production', simulated: true, platforms: [] },
    ]) {
      const result = buildHttpConnectorConfigs({ ...common, PLATFORM_CAPABILITY_EVIDENCE_JSON: JSON.stringify(document) })
      expect(result.allConfigs.jd?.capabilityEvidence).toBeUndefined()
      expect(result.readiness.jd.reasons).toContain('CAPABILITY_EVIDENCE_MISSING')
    }
  })

  it('rejects unsigned or tampered inline production capability evidence', () => {
    const source = { ...base, NODE_ENV: 'production', RELEASE_ID: 'release-1', JD_SYNC_PATH: '/products', JD_CREATE_PATH: '/products/create', JD_UPDATE_PATH: '/products/update', JD_QUERY_PATH: '/products/status', PLATFORM_CAPABILITY_EVIDENCE_JSON: JSON.stringify({ schema_version: '1', release_id: 'release-1', environment: 'production', simulated: false, platforms: [] }) }
    const result = buildHttpConnectorConfigs(source)
    expect(result.allConfigs.jd?.capabilityEvidence).toBeUndefined()
    expect(result.readiness.jd.reasons).toContain('CAPABILITY_EVIDENCE_MISSING')
  })

  it('builds four independent configs and does not merge taobao with tmall', () => {
    const result = buildHttpConnectorConfigs(base)
    expect(Object.keys(result.configs)).toEqual([])
    expect(Object.keys(result.allConfigs)).toEqual(['jd', 'taobao', 'tmall', 'pinduoduo'])
    expect(result.missing.xiaohongshu).toContain('XHS_CLIENT_ID (or XHS_APP_KEY)')
    expect(result.missing.douyin).toContain('DOUYIN_CLIENT_ID (or DOUYIN_APP_KEY)')
    expect(result.readiness.taobao.ready).toBe(false)
    expect(result.readiness.taobao.reasons).toContain('SIGNER_MISSING')
    expect(result.readiness.tmall.reasons).toContain('CAPABILITY_EVIDENCE_MISSING')
  })

  it('builds bearer transport and generic mapping adapters for social platforms without bypassing evidence gates', () => {
    const result = buildHttpConnectorConfigs({
      ...base,
      XHS_CLIENT_ID: 'xhs-app', XHS_OAUTH_AUTHORIZE_URL: 'https://xhs.test/authorize', XHS_OAUTH_TOKEN_URL: 'https://xhs.test/token', XHS_API_BASE_URL: 'https://xhs.test/api', XHS_MEDIA_UPLOAD_PATH: '/media/upload', XHS_MEDIA_ID_PATH: 'data.media_id', XHS_MEDIA_URL_PATH: 'data.url', XHS_MEDIA_UPLOAD_EVIDENCE_VERSION: 'xhs-media-v1', XHS_MEDIA_UPLOAD_EVIDENCE_REF: 'https://evidence.example/xhs-media', XHS_MEDIA_UPLOAD_EVIDENCE_VERIFIED_BY: 'qa', XHS_MEDIA_UPLOAD_EVIDENCE_VERIFIED_AT: '2026-08-26T00:00:00Z',
      DOUYIN_CLIENT_ID: 'douyin-app', DOUYIN_OAUTH_AUTHORIZE_URL: 'https://douyin.test/authorize', DOUYIN_OAUTH_TOKEN_URL: 'https://douyin.test/token', DOUYIN_API_BASE_URL: 'https://douyin.test/api',
      XHS_ITEMS_PATH: 'data.items', XHS_REMOTE_ID_PATH: 'product_id', XHS_TITLE_PATH: 'name', XHS_SKU_PATH: 'variants', XHS_SKU_ID_PATH: 'sku_id',
    })
    expect(result.allConfigs.xiaohongshu?.signer?.kind).toBe('platform')
    expect(result.allConfigs.douyin?.signer?.kind).toBe('platform')
    expect(result.allConfigs.xiaohongshu?.mapProducts).toBeTypeOf('function')
    expect(result.allConfigs.douyin?.mapWriteReceipt).toBeTypeOf('function')
    expect(result.allConfigs.xiaohongshu?.mediaUploadPath).toBe('/media/upload')
    expect(result.allConfigs.xiaohongshu?.mapMediaUpload).toBeTypeOf('function')
    expect(result.allConfigs.xiaohongshu?.mediaUploadEvidence).toMatchObject({ version: 'xhs-media-v1' })
    expect(result.readiness.xiaohongshu.ready).toBe(false)
    expect(result.readiness.xiaohongshu.reasons).toContain('CAPABILITY_EVIDENCE_MISSING')
    expect(result.readiness.douyin.reasons).toContain('MAPPING_EVIDENCE_MISSING')
    const mapped = result.allConfigs.xiaohongshu?.mapProducts?.({ data: { items: [{ product_id: 'xhs-1', name: '商品', price: '99.00', stock: '3', variants: [{ sku_id: 'sku-1', name: '红色', price: '99.00', stock: '3' }] }] } }, 'xiaohongshu')
    expect(mapped?.[0]).toMatchObject({ remoteId: 'xhs-1', title: '商品', price: 99, stock: 3, sku: [{ id: 'sku-1', price: 99, stock: 3 }] })
    expect(result.allConfigs.xiaohongshu?.mapMediaUpload?.({ data: { media_id: 'media-1', url: 'https://cdn.example/media-1.jpg' } }, { visualRef: 'visual-1', role: 'main', mimeType: 'image/jpeg', sha256: 'hash', bytes: new Uint8Array(), idempotencyKey: 'media-key' }, 'xiaohongshu')).toEqual({ mediaId: 'media-1', url: 'https://cdn.example/media-1.jpg' })
  })

  it('keeps generic social adapters closed until an explicit response mapping is supplied', () => {
    const result = buildHttpConnectorConfigs({
      ...base,
      XHS_CLIENT_ID: 'xhs-app', XHS_OAUTH_AUTHORIZE_URL: 'https://xhs.test/authorize', XHS_OAUTH_TOKEN_URL: 'https://xhs.test/token', XHS_API_BASE_URL: 'https://xhs.test/api',
      DOUYIN_CLIENT_ID: 'douyin-app', DOUYIN_OAUTH_AUTHORIZE_URL: 'https://douyin.test/authorize', DOUYIN_OAUTH_TOKEN_URL: 'https://douyin.test/token', DOUYIN_API_BASE_URL: 'https://douyin.test/api',
    })
    expect(result.readiness.xiaohongshu.reasons).toContain('RESPONSE_MAPPING_MISSING')
    expect(result.readiness.douyin.reasons).toContain('RESPONSE_MAPPING_MISSING')
    expect(result.configs.xiaohongshu).toBeUndefined()
    expect(result.configs.douyin).toBeUndefined()
  })

  it('does not manufacture provider request evidence from a local idempotency key', () => {
    const result = buildHttpConnectorConfigs({
      ...base,
      XHS_CLIENT_ID: 'xhs-app', XHS_OAUTH_AUTHORIZE_URL: 'https://xhs.test/authorize', XHS_OAUTH_TOKEN_URL: 'https://xhs.test/token', XHS_API_BASE_URL: 'https://xhs.test/api',
    })
    const receipt = result.allConfigs.xiaohongshu?.mapWriteReceipt?.({ remoteId: 'remote-1' }, { fields: { title: '商品', category: 'cat', price: 1, stock: 1 }, idempotencyKey: 'local-key' }, 'create', 'xiaohongshu')
    expect(receipt).toMatchObject({ remoteId: 'remote-1', requestId: '' })
    expect(receipt?.requestId).not.toContain('local-key')
  })

  it('rejects malformed provider request evidence in generic write receipts', () => {
    const result = buildHttpConnectorConfigs({
      ...base,
      XHS_CLIENT_ID: 'xhs-app', XHS_OAUTH_AUTHORIZE_URL: 'https://xhs.test/authorize', XHS_OAUTH_TOKEN_URL: 'https://xhs.test/token', XHS_API_BASE_URL: 'https://xhs.test/api',
    })
    const mapWriteReceipt = result.allConfigs.xiaohongshu?.mapWriteReceipt!
    const input = { fields: { title: '商品', category: 'cat', price: 1, stock: 1 }, idempotencyKey: 'local-key' }
    expect(mapWriteReceipt({ remoteId: 'remote-1', requestId: 'provider\nforged' }, input, 'create', 'xiaohongshu').requestId).toBe('')
    expect(mapWriteReceipt({ remoteId: 'remote-1', requestId: 'x'.repeat(257) }, input, 'create', 'xiaohongshu').requestId).toBe('')
    expect(mapWriteReceipt({ remoteId: 'remote-1', requestId: '__proto__' }, input, 'create', 'xiaohongshu').requestId).toBe('')
  })

  it('does not read inherited or malformed provider mapping paths as evidence', () => {
    const result = buildHttpConnectorConfigsFromStructured({
      xiaohongshu: {
        clientId: 'xhs',
        oauth: { authorizeUrl: 'https://xhs.test/a', tokenUrl: 'https://xhs.test/t' },
        api: { baseUrl: 'https://xhs.test/api', syncPath: '/i', createPath: '/c', updatePath: '/u', queryPath: '/q' },
        responseMapping: { itemsPath: 'data.items', remoteIdPath: 'constructor.name', requestIdPath: '__proto__.requestId' },
      },
    })
    const mapProducts = result.allConfigs.xiaohongshu?.mapProducts!
    expect(mapProducts({ data: { items: [{ title: '商品' }] } }, 'xiaohongshu')[0]?.remoteId).toBe('xiaohongshu-remote-0')
    const receipt = result.allConfigs.xiaohongshu?.mapWriteReceipt?.({ remoteId: 'safe-id', requestId: 'provider-request' }, { fields: { title: '商品', category: 'cat', price: 1, stock: 1 }, idempotencyKey: 'local-key' }, 'create', 'xiaohongshu')
    expect(receipt?.requestId).toBe('provider-request')
    expect(result.allConfigs.xiaohongshu?.mapProducts?.({ data: { items: [{ id: 'safe-id' }] } }, 'xiaohongshu')[0]?.remoteId).toBe('safe-id')
    expect(result.allConfigs.xiaohongshu?.mapProducts?.({ data: { items: [{ id: 'safe-id' }] } }, 'xiaohongshu')[0]?.platformFields).toMatchObject({ id: 'safe-id' })
  })

  it('does not create a partial connector config', () => {
    const result = buildHttpConnectorConfigs({ JD_AUTH_ENABLED: 'true', JD_READ_ENABLED: 'true', JD_WRITE_ENABLED: 'true', JD_APP_KEY: 'jd-only' })
    expect(result.configs.jd).toBeUndefined()
    expect(result.missing.jd).toEqual(expect.arrayContaining(['JD_OAUTH_AUTHORIZE_URL', 'JD_OAUTH_TOKEN_URL', 'JD_API_BASE_URL']))
  })

  it('supports structured path, scope and timeout overrides', () => {
    const result = buildHttpConnectorConfigs({ ...base, TMALL_OAUTH_SCOPES: 'item.read, item.write', TMALL_SYNC_PATH: '/v2/items', TMALL_HTTP_TIMEOUT_MS: '2500' })
    expect(result.readiness.tmall.ready).toBe(false)
    expect(result.missing.tmall).toContain('SIGNER_MISSING')
  })

  it('reports malformed API paths instead of treating absolute URLs as connector paths', () => {
    const result = buildHttpConnectorConfigsFromStructured({
      jd: { clientId: 'jd', clientSecret: 'jd-secret', oauth: { authorizeUrl: 'https://jd.test/a', tokenUrl: 'https://jd.test/t' }, api: { baseUrl: 'https://jd.test/api', syncPath: 'https://evil.example/read', createPath: '/c', updatePath: '/u', queryPath: '/q' } },
    })
    expect(result.readiness.jd.reasons).toContain('API_PATH_MUST_BE_RELATIVE')
    expect(result.configs.jd).toBeUndefined()
  })

  it('builds a typed structured map with separate taobao and tmall entries', () => {
    const result = buildHttpConnectorConfigsFromStructured({
      taobao: { clientId: 'tb', clientSecret: 'tb-secret', oauth: { authorizeUrl: 'https://tb.test/a', tokenUrl: 'https://tb.test/t' }, api: { baseUrl: 'https://tb.test/api', syncPath: '/i', createPath: '/c', updatePath: '/u', queryPath: '/q' } },
      tmall: { clientId: 'tm', oauth: { authorizeUrl: 'https://tm.test/a', tokenUrl: 'https://tm.test/t' }, api: { baseUrl: 'https://tm.test/api', syncPath: '/i', createPath: '/c', updatePath: '/u', queryPath: '/q' } },
    })
    expect(result.configs.taobao).toBeUndefined()
    expect(result.configs.tmall).toBeUndefined()
    expect(result.configs.jd).toBeUndefined()
    expect(result.missing.jd).toContain('clientId')
  })

  it('installs built-in signers for structured JD and PDD secrets while retaining evidence gates', () => {
    const result = buildHttpConnectorConfigsFromStructured({
      jd: { clientId: 'jd', clientSecret: 'jd-secret', oauth: { authorizeUrl: 'https://jd.test/a', tokenUrl: 'https://jd.test/t' }, api: { baseUrl: 'https://jd.test/api', syncPath: '/i', createPath: '/c', updatePath: '/u', queryPath: '/q' } },
      pinduoduo: { clientId: 'pdd', clientSecret: 'pdd-secret', oauth: { authorizeUrl: 'https://pdd.test/a', tokenUrl: 'https://pdd.test/t' }, api: { baseUrl: 'https://pdd.test/api', syncPath: '/i', createPath: '/c', updatePath: '/u', queryPath: '/q' } },
    })
    expect(result.readiness.jd.reasons).not.toContain('SIGNER_MISSING')
    expect(result.readiness.pinduoduo.reasons).not.toContain('SIGNER_MISSING')
    expect(result.configs.jd).toBeUndefined()
    expect(result.configs.pinduoduo).toBeUndefined()
    expect(result.allConfigs.jd?.signer?.kind).toBe('platform')
    expect(result.allConfigs.pinduoduo?.signer?.kind).toBe('platform')
  })

  it('reads the router API selector as connector configuration, never from the URL', async () => {
    // The router `method`/`type` selects the platform API. It used to be
    // scraped from the request URL, where it could never appear: `api.*Path`
    // must pass `validRelativePath`, which rejects `?`. It is configuration now.
    const result = buildHttpConnectorConfigs({
      ...base,
      JD_APP_SECRET: 'jd-secret',
      JD_SYNC_METHOD: 'jingdong.ware.search', JD_CREATE_METHOD: 'jingdong.ware.create', JD_UPDATE_METHOD: 'jingdong.ware.update', JD_QUERY_METHOD: 'jingdong.ware.status.get', JD_MEDIA_METHOD: 'jingdong.ware.image.upload',
    })
    expect(result.allConfigs.jd?.api.methods).toEqual({
      sync: 'jingdong.ware.search', create: 'jingdong.ware.create', update: 'jingdong.ware.update', query: 'jingdong.ware.status.get', media: 'jingdong.ware.image.upload',
    })
    const create = { method: 'POST', url: 'https://jd.test/api/products/create', headers: {} as Record<string, string>, body: '{}', platform: 'jd' as const, operation: 'create_product' as const }
    await result.allConfigs.jd?.signer?.sign(create)
    expect(new URLSearchParams(create.body).get('method')).toBe('jingdong.ware.create')
  })

  it('leaves an unconfigured router selector unset so the signer refuses instead of guessing', async () => {
    const result = buildHttpConnectorConfigs({ ...base, JD_APP_SECRET: 'jd-secret', JD_SYNC_METHOD: 'jingdong.ware.search' })
    expect(result.allConfigs.jd?.api.methods).toEqual({ sync: 'jingdong.ware.search' })
    const create = { method: 'POST', url: 'https://jd.test/api/products/create', headers: {} as Record<string, string>, body: '{}', platform: 'jd' as const, operation: 'create_product' as const }
    await expect(Promise.resolve().then(() => result.allConfigs.jd?.signer?.sign(create)))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED', message: expect.stringContaining('api.methods.create') })
  })

  it('passes structured router selectors through to the built-in signers', async () => {
    const result = buildHttpConnectorConfigsFromStructured({
      jd: { clientId: 'jd', clientSecret: 'jd-secret', oauth: { authorizeUrl: 'https://jd.test/a', tokenUrl: 'https://jd.test/t' }, api: { baseUrl: 'https://jd.test/api', syncPath: '/i', createPath: '/c', updatePath: '/u', queryPath: '/q', methods: { sync: 'jingdong.ware.search' } } },
    })
    expect(result.allConfigs.jd?.api.methods).toEqual({ sync: 'jingdong.ware.search' })
    const sync: HttpRequestDescriptor = { method: 'POST', url: 'https://jd.test/api/products', headers: {}, platform: 'jd', operation: 'sync_products' }
    await result.allConfigs.jd?.signer?.sign(sync)
    // The sync operation is dispatched as POST with the signed form body, so
    // the selector travels there and never reaches the request URL.
    expect(new URL(sync.url).search).toBe('')
    expect(new URLSearchParams(sync.body).get('method')).toBe('jingdong.ware.search')
  })

  it('does not expose a structured client secret to the API/MCP connector config', () => {
    const result = buildHttpConnectorConfigsFromStructured({
      jd: { clientId: 'jd', clientSecret: 'jd-secret', oauth: { authorizeUrl: 'https://jd.test/a', tokenUrl: 'https://jd.test/t' }, api: { baseUrl: 'https://jd.test/api', syncPath: '/i', createPath: '/c', updatePath: '/u', queryPath: '/q' } },
    })

    expect(result.allConfigs.jd).toBeDefined()
    expect(result.allConfigs.jd).not.toHaveProperty('clientSecret')
    expect(JSON.stringify(result.allConfigs.jd)).not.toContain('jd-secret')
    expect(result.allConfigs.jd?.signer?.kind).toBe('platform')
  })
})

const productionSource = {
  ...base,
  NODE_ENV: 'production',
  TAOBAO_AUTH_ENABLED: 'true',
  TAOBAO_SYNC_PATH: '/products', TAOBAO_CREATE_PATH: '/products/create', TAOBAO_UPDATE_PATH: '/products/update', TAOBAO_QUERY_PATH: '/publish/status',
  TMALL_SYNC_PATH: '/products', TMALL_CREATE_PATH: '/products/create', TMALL_UPDATE_PATH: '/products/update', TMALL_QUERY_PATH: '/publish/status',
}

describe('unwired platform operation switches', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('refuses every switch no code path reads and names the key that does', () => {
    for (const platform of unwiredSwitchPlatforms) {
      for (const name of switchNames) {
        const key = switchKey(platform, name)
        const message = thrownMessage({ ...base, [key]: 'true' })
        expect(message, `${key}=true must not be accepted silently`).toBeTypeOf('string')
        expect(message).toContain(key)
        if (platform === 'tmall') {
          // Tmall shares the TAOBAO switches, so that is the key to name.
          expect(message).toContain(`${platformConfigPrefix('taobao')}_${name}_ENABLED`)
        } else {
          expect(message).toContain('has no wired operation switch')
        }
      }
    }
    expect(() => buildHttpConnectorConfigs({ ...base, [switchKey('tmall', 'WRITE')]: 'true' })).toThrow(UnwiredPlatformSwitchError)
  })

  it('reports exactly the switches that are declared but unread', () => {
    const allOn = Object.fromEntries(platforms.flatMap(platform => switchNames.map(name => [switchKey(platform, name), 'true'])))
    const switches = unwiredPlatformSwitches(allOn)
    expect(switches.map(item => item.key)).toEqual(unwiredSwitchPlatforms.flatMap(platform => switchNames.map(name => switchKey(platform, name))))
    expect(switches.filter(item => item.effectiveKey).map(item => [item.key, item.effectiveKey]))
      .toEqual(switchNames.map(name => [switchKey('tmall', name), `${platformConfigPrefix('taobao')}_${name}_ENABLED`]))
    // Wired keys are never reported, and non-switch tmall keys are never touched.
    for (const platform of wiredSwitchPlatforms) for (const name of switchNames) {
      expect(unwiredPlatformSwitches({ [switchKey(platform, name)]: 'true' })).toEqual([])
    }
    expect(unwiredPlatformSwitches({ TMALL_CLIENT_ID: 'true', TMALL_OAUTH_AUTHORIZE_URL: 'true', TMALL_HTTP_TIMEOUT_MS: 'true' })).toEqual([])
  })

  it('refuses only in the modes where a platform switch can be acted on', () => {
    const key = switchKey('pinduoduo', 'AUTH')
    // Manual operations mode blocks every platform write before any switch is
    // consulted, so a meaningless key there cannot mislead anyone about a
    // capability that is globally off — and refusing to boot over it would turn
    // a harmless no-op into an outage for a deployment that started fine.
    expect(() => buildHttpConnectorConfigs({ ...base, PLATFORM_OPERATIONS_MODE: 'manual', [key]: 'true' })).not.toThrow()
    expect(() => buildHttpConnectorConfigs({ ...base, PLATFORM_OPERATIONS_MODE: 'MANUAL', [key]: 'true' })).not.toThrow()
    // Every other mode consults the switches, so the trap is live there.
    for (const mode of ['official_api', undefined]) {
      const env = { ...base, [key]: 'true', ...(mode === undefined ? {} : { PLATFORM_OPERATIONS_MODE: mode }) }
      expect(() => buildHttpConnectorConfigs(env), `mode=${String(mode)} must refuse`).toThrow(UnwiredPlatformSwitchError)
    }
    // The inventory itself stays mode-independent: it is a pure function of the
    // platform tables, so the exemption it feeds cannot drift with the mode.
    expect(unwiredPlatformSwitches({ PLATFORM_OPERATIONS_MODE: 'manual', [key]: 'true' })).toHaveLength(1)
  })

  it('leaves false, empty and absent switches exactly as they were', () => {
    for (const setting of ['false', 'FALSE', '0', 'no', '', '   ', undefined]) {
      for (const platform of unwiredSwitchPlatforms) for (const name of switchNames) {
        expect(thrownMessage({ ...base, [switchKey(platform, name)]: setting }), `${switchKey(platform, name)}=${String(setting)}`).toBeUndefined()
      }
    }
    // The ECS pilot compose forwards all nine as `false`; that profile must still build.
    const composeDefaults = Object.fromEntries(unwiredSwitchPlatforms.flatMap(platform => switchNames.map(name => [switchKey(platform, name), 'false'])))
    const result = buildHttpConnectorConfigs({ ...base, ...composeDefaults })
    expect(Object.keys(result.allConfigs)).toEqual(['jd', 'taobao', 'tmall', 'pinduoduo'])
    // Anything else that spells "true" is an explicit opt-in too: the existing
    // switches compare case-insensitively (`explicitlyEnabled`), so `TRUE` must
    // be refused as well rather than becoming the one accepted silent no-op.
    expect(thrownMessage({ ...base, [switchKey('pinduoduo', 'AUTH')]: 'TRUE' })).toBeTypeOf('string')
  })

  it('keeps the wired switches wired, including tmall sharing the TAOBAO namespace', () => {
    const disabled = buildHttpConnectorConfigs(productionSource)
    expect(disabled.readiness.tmall.reasons).toContain('READ_DISABLED')
    expect(disabled.readiness.tmall.reasons).toContain('WRITE_DISABLED')
    const enabled = buildHttpConnectorConfigs({ ...productionSource, TAOBAO_READ_ENABLED: 'true', TAOBAO_WRITE_ENABLED: 'true' })
    expect(enabled.readiness.tmall.reasons).not.toContain('READ_DISABLED')
    expect(enabled.readiness.tmall.reasons).not.toContain('WRITE_DISABLED')
    expect(enabled.readiness.taobao.reasons).not.toContain('WRITE_DISABLED')
    // The shared namespace also drives the auth gate, which is why TMALL_AUTH_ENABLED is the wrong key.
    const noAuthSwitch = buildHttpConnectorConfigs({ ...productionSource, TAOBAO_AUTH_ENABLED: undefined })
    expect(noAuthSwitch.missing.tmall).toContain(`${platformConfigPrefix('taobao')}_AUTH_ENABLED=true`)
    expect(thrownMessage({ ...productionSource, [switchKey('tmall', 'AUTH')]: 'true' })).toContain(`${platformConfigPrefix('taobao')}_AUTH_ENABLED`)
  })

  it('does not disturb the tmall configuration keys that are read', () => {
    const result = buildHttpConnectorConfigs({ ...base, TMALL_OAUTH_SCOPES: 'item.read, item.write', TMALL_SYNC_PATH: '/v2/items', TMALL_HTTP_TIMEOUT_MS: '2500' })
    expect(result.allConfigs.tmall?.clientId).toBe('tmall-app')
    expect(result.allConfigs.tmall?.oauth.authorizeUrl).toBe('https://tmall.test/authorize')
    expect(result.allConfigs.tmall?.oauth.scopes).toEqual(['item.read', 'item.write'])
    expect(result.allConfigs.tmall?.api.syncPath).toBe('/v2/items')
    expect(result.allConfigs.tmall?.timeoutMs).toBe(2500)
  })
})
