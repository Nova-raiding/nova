import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogImportBatch } from './api.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('merchant spreadsheet batch import transport', () => {
  it('sends the confirmed source and draft flag to MCP, whose contract projects pending knowledge', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      data: { result: { products: [{ id: 'product_test' }], draft_only: true, knowledge: { indexState: 'queued', approvalStatus: 'pending' } } },
      error: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const input = { source_asset_id: 'asset_test', products_json: '[{"platform":"jd","title":"贵人鸟"}]', draft_only: 'true' as const, idempotency_key: 'merchant-import-test-1' }

    await expect(catalogImportBatch('/api', input)).resolves.toMatchObject({
      products: [{ id: 'product_test' }], draft_only: true, knowledge: { indexState: 'queued', approvalStatus: 'pending' },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('/api/mcp')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(String(init.body))).toMatchObject({ jsonrpc: '2.0', method: 'catalog.import.batch', params: input })
  })
})
