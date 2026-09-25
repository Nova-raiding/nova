import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertProductTargetIdentity, fetchImageGenerationJobs, fetchManualPublishRecords, fetchPlatformAccounts, fetchPlatformModelStatus, fetchProduct, fetchProductAssetBindings, fetchProducts, fetchTaskPage, fetchTasks, generateCampaignBatch, importProduct, MERCHANT_TASK_PAGE_SIZE, registerMerchantAccount, requestApi, type Product } from './src/api.js'
import { buildCatalogPlatforms } from './src/catalog-data.js'
import { resolveLibraryData } from './src/library-data.js'
import { resolveTaskDirections } from './src/task-evidence.js'
import platformAccountsCapture from './src/fixtures/platform-accounts.capture.json'

const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({
  request_id: 'merchant-api-unit',
  trace_id: 'merchant-api-unit',
  workspace_id: 'ws_demo',
  data,
  warnings: [],
  next_actions: [],
  error: status >= 400 ? { code: 'NOT_FOUND', message: 'not found' } : null,
}), { status, headers: { 'content-type': 'application/json' } })

describe('merchant product response normalization', () => {
  beforeEach(() => vi.stubEnv('VITE_API_TOKEN', 'merchant-api-test-token'))
  afterEach(() => vi.unstubAllGlobals())

  it('recovers the exact product identity from a paginated list fallback', async () => {
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(envelope(null, 404))
      .mockResolvedValueOnce(envelope({
        items: [
          { id: 'prod-store-a', workspaceId: 'ws_demo', platform: 'taobao', accountId: 'store-a', storeName: '淘宝 A 店', title: '同名商品', skuCount: 1, stock: 8, factsConfirmed: true, source: 'official_api', updatedAt: '2026-08-29T00:00:00.000Z' },
          { id: 'prod-store-b', workspaceId: 'ws_demo', platform: 'taobao', accountId: 'store-b', storeName: '淘宝 B 店', title: '同名商品', skuCount: 1, stock: 12, factsConfirmed: true, source: 'official_api', updatedAt: '2026-08-29T00:00:00.000Z' },
        ],
        total: 2,
        limit: 20,
        offset: 0,
      })))

    await expect(fetchProduct('/api', 'prod-store-b')).resolves.toMatchObject({
      id: 'prod-store-b',
      platform: 'taobao',
      accountId: 'store-b',
      storeName: '淘宝 B 店',
    })
  })

  it('fails closed when the authoritative product or store identity changes', () => {
    const current = {
      id: 'prod-store-b', workspaceId: 'ws_demo', platform: 'taobao', accountId: 'store-a', storeName: '淘宝 A 店',
      title: '同名商品', skuCount: 1, stock: 12, factsConfirmed: true, source: 'official_api', updatedAt: '2026-08-29T00:00:00.000Z',
    } satisfies Product

    expect(() => assertProductTargetIdentity(current, {
      productId: 'prod-store-b', platform: 'taobao', accountId: 'store-b', storeName: '淘宝 B 店',
    })).toThrow('商品店铺身份与最新商品事实不一致')

    expect(() => assertProductTargetIdentity({ ...current, id: 'prod-store-a', accountId: 'store-b', storeName: '淘宝 B 店' }, {
      productId: 'prod-store-b', platform: 'taobao', accountId: 'store-b', storeName: '淘宝 B 店',
    })).toThrow('商品 ID 与所选商品不一致')
  })

  it('keeps successful empty directions and rules explicit instead of mixing fixtures', () => {
    expect(resolveTaskDirections({ baseUrl: '/api', remote: [], error: '' })).toEqual({ mode: 'api_empty', items: [] })
    expect(resolveLibraryData({ baseUrl: '/api', remote: [], error: '', fixtures: [{ id: 'demo-rule' }] })).toEqual({ mode: 'api_empty', items: [] })
  })

  it('reads products and tasks in bounded pages while returning the legacy array shape', async () => {
    vi.stubGlobal('window', globalThis)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(envelope({ items: [{ id: 'p1' }], total: 2, limit: 1, offset: 0 }))
      .mockResolvedValueOnce(envelope({ items: [{ id: 'p2' }], total: 2, limit: 1, offset: 1 }))
      .mockResolvedValueOnce(envelope([{ id: 't1' }]))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchProducts('/api')).resolves.toEqual([{ id: 'p1' }, { id: 'p2' }])
    await expect(fetchTasks('/api')).resolves.toEqual([{ id: 't1' }])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/products?limit=50&offset=0')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/v1/products?limit=50&offset=1')
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/v1/tasks?limit=50&offset=0')
  })

  it('maps the captured platform-account API contract into merchant store facts', async () => {
    vi.stubGlobal('window', globalThis)
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(platformAccountsCapture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await fetchPlatformAccounts('/api')
    const platforms = buildCatalogPlatforms(response.items, [])

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/platform-accounts')
    expect(platforms?.map((platform) => platform.id)).toEqual(['taobao', 'tmall', 'jd', 'douyin', 'pinduoduo', 'xiaohongshu'])
    expect(platforms?.flatMap((platform) => platform.stores)).toMatchObject([{
      id: 'fixture-store-ws_demo-taobao',
      name: '淘宝 Fixture 店',
      dataModeLabel: '演示数据',
      connectionLabel: '演示连接',
      readable: true,
      realConnected: false,
    }])
    expect(platforms?.find((platform) => platform.id === 'jd')).toMatchObject({
      stores: [],
      connected: false,
      statusLabel: '未接入',
    })
  })

  it('uses the desktop task page size for task page requests and offsets', async () => {
    vi.stubGlobal('window', globalThis)
    const fetchMock = vi.fn().mockResolvedValueOnce(envelope({
      items: [{ id: 't51' }],
      total: 51,
      limit: MERCHANT_TASK_PAGE_SIZE,
      offset: MERCHANT_TASK_PAGE_SIZE,
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchTaskPage('/api', { offset: MERCHANT_TASK_PAGE_SIZE })).resolves.toEqual({
      items: [{ id: 't51' }],
      total: 51,
      limit: MERCHANT_TASK_PAGE_SIZE,
      offset: MERCHANT_TASK_PAGE_SIZE,
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/v1/tasks?limit=${MERCHANT_TASK_PAGE_SIZE}&offset=${MERCHANT_TASK_PAGE_SIZE}`,
    )
  })

  it('reads tenant-scoped manual publish reports without treating them as platform receipts', async () => {
    vi.stubGlobal('window', globalThis)
    const record = { id: 'manual-1', taskId: 'task-1', contentVersionId: 'content-1', platform: 'taobao', accountId: 'store-1', state: 'manual_publish_reported', recordedAt: '2026-09-17T00:00:00.000Z' }
    const fetchMock = vi.fn().mockResolvedValueOnce(envelope({ result: { items: [record], total: 1, limit: 100, offset: 0 } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchManualPublishRecords('/api')).resolves.toEqual([record])
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ method: 'publish.manual.list', params: { limit: '100', offset: '0' } })
  })

  it('preserves request and trace evidence on API failures', async () => {
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      request_id: 'req_failure_1',
      trace_id: 'trace_failure_1',
      workspace_id: 'ws_demo',
      data: null,
      warnings: [],
      next_actions: ['commercial.access.get'],
      error: { code: 'MODEL_RELAY_NOT_CONFIGURED', message: '模型中转未配置', details: { retryable: false, provider: 'relay' } },
    }), { status: 503, headers: { 'content-type': 'application/json' } })))

    await expect(requestApi('/api', '/v1/workspace/health')).rejects.toMatchObject({
      code: 'MODEL_RELAY_NOT_CONFIGURED',
      status: 503,
      requestId: 'req_failure_1',
      traceId: 'trace_failure_1',
      details: { retryable: false, provider: 'relay' },
      nextActions: ['commercial.access.get'],
      retryable: false,
    })
  })

  it('reads the workspace-scoped image task discovery page without inventing demo rows', async () => {
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({ items: [{ jobId: 'img_1', productId: 'p1', state: 'running', archiveState: 'pending', executionState: 'provider_dispatching', reconciliationRequired: true, requestedCount: 2, candidateCount: 2, revision: 3, createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z' }], total: 1, limit: 50, offset: 0 })))
    await expect(fetchImageGenerationJobs('/api')).resolves.toMatchObject({ total: 1, items: [{ jobId: 'img_1', candidateCount: 2, executionState: 'provider_dispatching', reconciliationRequired: true }] })
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(expect.stringContaining('/v1/image-generation-jobs?limit=50&offset=0'), expect.any(Object))
  })

  it('reads normalized product asset bindings and submits selected import assets to the server', async () => {
    vi.stubGlobal('window', globalThis)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(envelope({ items: [{ workspaceId: 'ws_demo', productId: 'p1', assetId: 'a1', assetRole: 'source', ordinal: 1, status: 'active', createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z' }], source: 'normalized_relation' }))
      .mockResolvedValueOnce(envelope({ id: 'p1', workspaceId: 'ws_demo', platform: 'taobao', title: '商品', storeName: '店铺', skuCount: 1, stock: 1, factsConfirmed: false, source: 'csv', updatedAt: '2026-08-29T00:00:00.000Z' }, 201))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchProductAssetBindings('/api', 'p1')).resolves.toMatchObject({ source: 'normalized_relation', items: [{ assetId: 'a1' }] })
    await importProduct('/api', { platform: 'taobao', title: '商品', category: '服装', asset_ids: ['a1'] })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/products/p1/assets')
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ asset_ids: ['a1'] })
  })

  it('passes a stable generation idempotency key through the merchant MCP client', async () => {
    vi.stubGlobal('window', globalThis)
    const fetchMock = vi.fn().mockResolvedValue(envelope({ result: { campaignId: 'campaign_1', taskIds: ['task_1'], replayed: false } }))
    vi.stubGlobal('fetch', fetchMock)

    await generateCampaignBatch('/api', 'campaign_1', '按事实生成', 'merchant-studio-campaign-generate-campaign_1')

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      method: 'campaign.batch.generate',
      params: { campaign_id: 'campaign_1', request_text: '按事实生成', idempotency_key: 'merchant-studio-campaign-generate-campaign_1' },
    })
  })

  it('normalizes the registration application id returned by the HTTP API', async () => {
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({ application_id: 'app_123', login: 'merchant@example.com', status: 'merchant_pending' }, 201)))

    await expect(registerMerchantAccount('/api', { login: 'merchant@example.com', password: 'MerchantPass123!', enterpriseName: '测试企业', contactName: '联系人' })).resolves.toEqual({
      applicationId: 'app_123',
      login: 'merchant@example.com',
      status: 'merchant_pending',
    })
  })
})

describe('merchant model readiness projection', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({
      status: 'ok',
      writesEnabled: false,
      connectors: {},
      setup: {
        ai: { costGate: 'ready', relay: { configured: true, host: 'relay.example.test' } },
        modelReadiness: {
          text: { ready: true },
          image: { ready: true },
          image_edit: { ready: true },
          ocr: { ready: true },
          video: { ready: true },
          embedding: { ready: false, reasons: ['embedding_not_configured'] },
        },
      },
    })))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps image generation ready when an unrelated embedding modality is blocked', async () => {
    await expect(fetchPlatformModelStatus('/api')).resolves.toMatchObject({
      state: 'ready',
      capabilities: { image_generation: true },
      cost_control_ready: true,
      next_actions: [],
    })
  })

  it('keeps image generation blocked when the shared model cost gate is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({
      status: 'ok',
      connectors: {},
      setup: {
        ai: { costGate: 'blocked' },
        modelReadiness: { image: { ready: true } },
      },
    })))

    await expect(fetchPlatformModelStatus('/api')).resolves.toMatchObject({
      state: 'blocked',
      capabilities: { image_generation: true },
      cost_control_ready: false,
      next_actions: ['配置并审批平台模型 RPM、TPM 和每日人民币成本上限'],
    })
  })
})
