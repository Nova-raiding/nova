import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildHttpConnectorConfigs, buildHttpConnectorConfigsFromStructured } from './config.js'

const base = {
  JD_APP_KEY: 'jd-app', JD_OAUTH_AUTHORIZE_URL: 'https://jd.test/authorize', JD_OAUTH_TOKEN_URL: 'https://jd.test/token', JD_API_BASE_URL: 'https://jd.test/api',
  TAOBAO_APP_KEY: 'taobao-app', TAOBAO_OAUTH_AUTHORIZE_URL: 'https://taobao.test/authorize', TAOBAO_OAUTH_TOKEN_URL: 'https://taobao.test/token', TAOBAO_API_BASE_URL: 'https://taobao.test/api',
  TMALL_APP_KEY: 'tmall-app', TMALL_OAUTH_AUTHORIZE_URL: 'https://tmall.test/authorize', TMALL_OAUTH_TOKEN_URL: 'https://tmall.test/token', TMALL_API_BASE_URL: 'https://tmall.test/api',
  PDD_CLIENT_ID: 'pdd-app', PDD_OAUTH_AUTHORIZE_URL: 'https://pdd.test/authorize', PDD_OAUTH_TOKEN_URL: 'https://pdd.test/token', PDD_API_BASE_URL: 'https://pdd.test/api',
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
    const result = buildHttpConnectorConfigs({ JD_APP_KEY: 'jd-only' })
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
