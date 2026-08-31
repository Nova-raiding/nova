import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertProductTargetIdentity, fetchImageGenerationJobs, fetchProduct, fetchProductAssetBindings, fetchProducts, fetchTasks, importProduct, type Product } from './src/api.js'
import { resolveLibraryData } from './src/library-data.js'
import { resolveTaskDirections } from './src/task-evidence.js'

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

  it('reads the workspace-scoped image task discovery page without inventing demo rows', async () => {
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({ items: [{ jobId: 'img_1', productId: 'p1', state: 'succeeded', archiveState: 'archived', requestedCount: 2, candidateCount: 2, revision: 3, createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z' }], total: 1, limit: 50, offset: 0 })))
    await expect(fetchImageGenerationJobs('/api')).resolves.toMatchObject({ total: 1, items: [{ jobId: 'img_1', candidateCount: 2 }] })
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
})
