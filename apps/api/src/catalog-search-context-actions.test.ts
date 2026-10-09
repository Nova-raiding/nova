import { describe, expect, it, vi } from 'vitest'
import { handleCatalogSearch } from './mcp-catalog-search-handlers.js'
import type { Product } from '../../../packages/application/src/service.js'

const workspaceId = 'ws_catalog_context'
const product = (patch: Partial<Product> = {}) => ({ id: 'product_qa', workspaceId, title: 'QA资料', platform: 'taobao', source: 'csv', factsConfirmed: true, stock: 0, skuCount: 0, updatedAt: '2026-10-05T00:00:00Z', ...patch }) as Product
async function search(products: Product[], options: { canonical?: boolean; params?: Record<string, unknown>; visibleIds?: ReadonlySet<string>; memory?: boolean } = {}) {
  const page = vi.fn(async () => ({ items: products, total: products.length, limit: 1, offset: 0 }))
  const canonical = options.canonical ? [{ id: 'canonical_qa', brandId: 'brand_qa', sourceProductId: 'product_qa' }] : []
  const listings = options.canonical ? [{ id: 'listing_qa', canonicalProductId: 'canonical_qa', brandId: 'brand_qa', platform: 'taobao', accountId: 'account_qa' }] : []
  const listProducts = vi.fn(() => products)
  const listCanonicalProducts = vi.fn(async () => canonical)
  const deps = {
    service: { getPlatformAccount: vi.fn(), listProducts },
    ...(options.memory ? {} : { business: { listProductsPage: page } }),
    brandUnits: { listCanonicalProducts, listListings: vi.fn(async () => listings) },
    knowledgeRepository: { listDocuments: vi.fn(async () => []), search: vi.fn(async () => []) },
    storeDirectory: () => [], pagination: () => ({ limit: 1, offset: 0 }),
    accessibleTaskBrandIds: async () => ['brand_qa'], accessibleProductIds: async () => options.visibleIds,
    canonicalReadControl: async () => ({ mode: 'legacy_shadow' }),
    knowledgeForWorkspace: vi.fn(() => { throw new Error('knowledge not requested') }), buildKnowledgeContext: vi.fn(),
  }
  const result = await handleCatalogSearch({ scope: 'workspace', query: 'QA资料', limit: '1', ...options.params }, workspaceId, deps as any)
  return { result, page, listCanonicalProducts, listProducts }
}

describe('catalog search trusted context and candidate actions', () => {
  it.each([true, false])('keeps authenticated workspace context on populated=%s pages', async populated => {
    const { result, page } = await search(populated ? [product()] : [], { params: { workspace_id: 'ws_untrusted_argument' } })
    expect(result.workspace_id).toBe(workspaceId)
    expect(result.products).toHaveLength(populated ? 1 : 0)
    expect(result).toMatchObject({ limit: 1, offset: 0, selection: null })
    expect(page).toHaveBeenCalledWith(workspaceId, expect.objectContaining({ query: 'QA资料', limit: 1, accessibleBrandIds: ['brand_qa'] }))
  })
  it.each([false, true])('offers only the applicable candidate step for confirmed=%s', async confirmed => {
    const { result } = await search([product({ factsConfirmed: confirmed })])
    const action = result.product_actions[0]!
    expect(action).toMatchObject({ candidate_only: true, publishable: false, account_id: null, action: { method: confirmed ? 'task.create.draft' : 'catalog.facts.confirm', arguments: { product_id: 'product_qa', ...(confirmed ? { platform: 'taobao' } : {}) }, required_inputs: [], confirmation: 'interactive_confirmation' } })
    expect(result.products[0]!.storeContext).toBeNull()
    expect(JSON.stringify(action)).not.toContain('platform.connect')
  })
  it('allows public CSV listing evidence without inventing a store', async () => {
    const { result } = await search([product({ remoteId: 'public_listing' })])
    expect(result.product_actions[0]!.action?.method).toBe('task.create.draft')
    expect(result.product_actions[0]!.account_id).toBeNull()
  })
  it.each([{ brandId: 'brand_qa' }, { remoteId: 'synced_remote', source: 'platform' }])('does not downgrade scoped unbound products to candidates: %j', async patch => {
    const { result } = await search([product(patch as Partial<Product>)])
    expect(result.product_actions[0]!.action).toMatchObject({ method: 'canonical.product.consistency', reason: 'candidate_scope_ineligible' })
    expect(result.product_actions[0]).not.toHaveProperty('candidate_only')
    expect(JSON.stringify(result.product_actions)).not.toContain('platform.connect')
  })
  it.each([false, true])('keeps bound product confirmation/canonical path for confirmed=%s', async confirmed => {
    const { result } = await search([product({ accountId: 'account_qa', factsConfirmed: confirmed })])
    expect(result.product_actions[0]!.action?.method).toBe(confirmed ? 'canonical.product.consistency' : 'catalog.facts.confirm')
    expect(result.product_actions[0]).not.toHaveProperty('candidate_only')
  })
  it('preserves a verified bound product without candidate fallback', async () => {
    const { result } = await search([product({ accountId: 'account_qa', brandId: 'brand_qa' })], { canonical: true })
    expect(result.product_actions[0]!.action).toBeNull()
    expect(result.product_actions[0]).not.toHaveProperty('candidate_only')
  })
  it('keeps inaccessible products filtered before projecting actions in memory mode', async () => {
    const { result } = await search([product()], { memory: true, visibleIds: new Set() })
    expect(result.workspace_id).toBe(workspaceId)
    expect(result.products).toEqual([])
    expect(result.product_actions).toEqual([])
  })
  it('does not turn incomplete store scope into an unbound candidate search', async () => {
    await expect(search([product()], { params: { scope: 'store' } })).rejects.toMatchObject({ code: 'STORE_SELECTION_REQUIRED' })
  })
  it('normalizes catalog date filters before both durable and memory repositories', async () => {
    const from = '2026-10-01T08:00:00+08:00'
    const to = '2026-10-02T00:00:00Z'
    const durable = await search([product()], { params: { date_from: from, date_to: to } })
    expect(durable.page).toHaveBeenCalledWith(workspaceId, expect.objectContaining({ dateFrom: '2026-10-01T00:00:00.000Z', dateTo: to.replace('Z', '.000Z') }))

    const memory = await search([product()], { memory: true, params: { date_from: from, date_to: to } })
    expect(memory.listProducts).toHaveBeenCalledWith(workspaceId, expect.objectContaining({ dateFrom: '2026-10-01T00:00:00.000Z', dateTo: to.replace('Z', '.000Z') }))
  })
  it.each([
    { date_from: '2026-02-30T00:00:00Z' },
    { date_from: '2026-10-01T00:00:00.0001Z' },
    { date_to: '2026-10-01T00:00:00' },
    { date_from: '2026-10-02T00:00:00Z', date_to: '2026-10-01T00:00:00Z' },
  ])('rejects malformed or reversed date filters', async params => {
    await expect(search([product()], { params })).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
  })
})
