import { createHash } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MemoryBrandUnitRepository } from '../../../packages/persistence/src/brand-unit-repository.js'
import { MemoryKnowledgeRepository } from '../../../packages/persistence/src/knowledge.js'

/**
 * Regression coverage for the page-level N+1 reads behind `catalog.search` and
 * the brand filter behind `brand-unit.list`.
 *
 * `catalog.search` used to ask the catalog repositories once per product for a
 * page of products (one listing read, one knowledge search and one unbounded
 * document read each), and `brand-unit.list` used to resolve brand access once
 * per brand inside its own transaction. These tests count repository calls
 * rather than database round trips; the same changes were measured against a
 * real PostgreSQL instance separately (50-product page, 40 of them searchable:
 * 257 -> 62 statements for the page, i.e. 39 per-product searches collapsed
 * into one group call).
 */

let server: typeof import('./server.js').server
let workspaceMembers: typeof import('./server.js').workspaceMembers
let knowledgeDocuments: typeof import('./server.js').knowledgeDocumentsForTests

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

type JsonRpcResponse = { data?: { result?: any }; error?: { code?: string; message?: string } }

async function call(base: string, workspace: string, method: string, params: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workspace-id': workspace, ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${Date.now()}-${Math.random()}`, method, params }),
  })
  return response.json() as Promise<JsonRpcResponse>
}

async function grantCommercialAccess(workspace: string) {
  const runtime = await import('./server.js')
  await runtime.grantCreativePointsForTests(workspace)
  runtime.grantContinuousFeatureEntitlementForTests(workspace)
}

/**
 * Makes one document of `productId` searchable (ready + approved + cleared) so
 * `catalog.search` has a candidate to rank. The asset cascade is the only path
 * that flips approval/rights on a document that already carries chunks.
 */
async function seedSearchableKnowledge(workspaceId: string, input: { id: string; productId: string; skuId?: string; text: string }) {
  const asset = await knowledgeDocuments.createAsset({ workspaceId, kind: 'material', name: `${input.id} asset`, content: { text: input.text } })
  const document = await knowledgeDocuments.createDocument({
    workspaceId,
    knowledgeAssetId: asset.id,
    productId: input.productId,
    ...(input.skuId ? { skuId: input.skuId } : {}),
    knowledgeType: 'material',
    title: input.id,
    contentHash: createHash('sha256').update(input.text, 'utf8').digest('hex'),
    extractedText: input.text,
  })
  await knowledgeDocuments.replaceChunks(workspaceId, document.id, [{ ordinal: 0, content: `${input.text} 分块` }])
  await knowledgeDocuments.updateAsset(workspaceId, asset.id, { approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
  return document.id
}

/** The per-product `knowledge_documents` shape `catalog.search` builds. */
function knowledgeDocumentsView(results: Awaited<ReturnType<typeof knowledgeDocuments.search>>) {
  return results.map(({ document, chunks, score }) => ({
    id: document.id,
    title: document.title,
    knowledge_type: document.knowledgeType,
    product_id: document.productId ?? null,
    sku_id: document.skuId ?? null,
    extracted_text: document.extractedText,
    chunks: chunks.map(chunk => ({ id: chunk.id, ordinal: chunk.ordinal, content: chunk.content })),
    score,
    source_version: document.sourceVersion,
    revision: document.revision,
  }))
}

type CatalogPage = {
  data: {
    result: {
      products: Array<{ product_id: string; knowledge_documents?: unknown[]; knowledge_status?: { document_count: number } }>
    }
  }
}

/** `catalog.search` result payload of one MCP call. */
async function catalogPage(base: string, workspace: string, params: Record<string, unknown>): Promise<CatalogPage['data']['result']> {
  const response = await call(base, workspace, 'catalog.search', params)
  const result = response.data?.result as CatalogPage['data']['result'] | undefined
  if (!result) throw new Error(`catalog.search returned no result: ${JSON.stringify(response)}`)
  return result
}

describe('catalog.search page reads', () => {
  beforeAll(async () => {
    process.env.CONNECTOR_FIXTURE_MODE = 'true'
    process.env.DEPLOYMENT_PROFILE = 'local_acceptance'
    process.env.LOCAL_COMPOSE = 'true'
    vi.stubEnv('REQUIRE_PLATFORM_GOVERNANCE_GATES', 'false')
    const runtime = await import('./server.js')
    server = runtime.server
    workspaceMembers = runtime.workspaceMembers
    knowledgeDocuments = runtime.knowledgeDocumentsForTests
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('reads listings and knowledge once per page and reports an exact pending document count', async () => {
    const base = await start()
    const workspace = `ws_catalog_page_batch_${Date.now()}`
    await grantCommercialAccess(workspace)
    const connected = await call(base, workspace, 'platform.connect', { platform: 'taobao' })
    const accountId = connected.data?.result?.account?.id as string
    expect(accountId).toBeTruthy()
    const brand = await call(base, workspace, 'brand-unit.create', { name: '批量读取品' })
    const brandId = brand.data?.result?.id as string
    expect(brandId).toBeTruthy()
    const bound = await call(base, workspace, 'brand-unit.bind-store', { brand_id: brandId, platform: 'taobao', account_id: accountId })
    expect(bound.error).toBeNull()

    // Three products, each with a canonical product and one store listing. The
    // first carries ten SKUs so its imported knowledge projection holds eleven
    // documents (one product document plus one per SKU), which is more than any
    // page-sized cap would allow.
    const productIds: string[] = []
    const skuCounts = [10, 1, 1]
    for (const [index, skuCount] of skuCounts.entries()) {
      const skus = Array.from({ length: skuCount }, (_, sku) => ({ id: `sku_${index}_${sku}`, name: `规格 ${sku}`, price: 10 + sku, stock: 1 }))
      const imported = await call(base, workspace, 'catalog.import', {
        platform: 'taobao', account_id: accountId, brand_id: brandId, draft_only: 'true',
        title: `批量商品 ${index}`, skus_json: JSON.stringify(skus),
      })
      expect(imported.error).toBeNull()
      const productId = imported.data?.result?.product_id as string
      expect(productId).toBeTruthy()
      productIds.push(productId)
      expect((await call(base, workspace, 'catalog.facts.confirm', { product_id: productId })).error).toBeNull()
      const canonical = await call(base, workspace, 'brand-unit.product.create', { brand_id: brandId, product_id: `canonical_batch_${index}_${workspace}`, title: `规范商品 ${index}`, source_product_id: productId })
      expect(canonical.error).toBeNull()
      const listing = await call(base, workspace, 'brand-unit.listing.create', { brand_id: brandId, canonical_product_id: `canonical_batch_${index}_${workspace}`, platform: 'taobao', account_id: accountId })
      expect(listing.error).toBeNull()
    }

    const listListings = vi.spyOn(MemoryBrandUnitRepository.prototype, 'listListings')
    const listDocuments = vi.spyOn(MemoryKnowledgeRepository.prototype, 'listDocuments')
    const search = vi.spyOn(MemoryKnowledgeRepository.prototype, 'search')

    const page = await call(base, workspace, 'catalog.search', { scope: 'workspace', include_knowledge: 'true' })
    expect(page.error).toBeNull()
    const products = (page.data?.result?.products ?? []) as Array<{ product_id: string; knowledge_status?: { state: string; document_count: number } }>
    expect(products.map(product => product.product_id).sort()).toEqual([...productIds].sort())

    // One listing read for the whole page instead of one per product.
    expect(listListings).toHaveBeenCalledTimes(1)
    // One unbounded document read for the whole page: per-product reads were
    // each unbounded, so bounding this one would trade a query for a wrong
    // `document_count`.
    expect(listDocuments).toHaveBeenCalledTimes(1)
    expect(listDocuments.mock.calls[0]?.[1]?.productId).toBeUndefined()
    expect(listDocuments.mock.calls[0]?.[1]?.limit).toBeUndefined()
    // Nothing in this workspace is ready + approved + cleared, so no product can
    // have a searchable candidate and no per-product candidate search runs.
    expect(search).not.toHaveBeenCalled()

    // The count is the exact number of documents still awaiting review, rights
    // or indexing: eleven for the ten-SKU product, two for each single-SKU one.
    // A page read bounded by the search limit (8) would report 8 for the first
    // product instead of 11.
    const counts = Object.fromEntries(products.map(product => [product.product_id, product.knowledge_status?.document_count]))
    expect(counts[productIds[0]!]).toBe(11)
    expect(counts[productIds[1]!]).toBe(2)
    expect(counts[productIds[2]!]).toBe(2)
  })

  it('ranks the whole store page with one knowledge search instead of one per product', async () => {
    const base = await start()
    const workspace = `ws_catalog_page_search_${Date.now()}`
    await grantCommercialAccess(workspace)
    const connected = await call(base, workspace, 'platform.connect', { platform: 'taobao' })
    const accountId = connected.data?.result?.account?.id as string
    expect(accountId).toBeTruthy()
    const brand = await call(base, workspace, 'brand-unit.create', { name: '知识批量品' })
    const brandId = brand.data?.result?.id as string
    expect(brandId).toBeTruthy()
    expect((await call(base, workspace, 'brand-unit.bind-store', { brand_id: brandId, platform: 'taobao', account_id: accountId })).error).toBeNull()

    // Four products in one store. Three carry a searchable document; the fourth
    // carries only the pending projection `catalog.import` writes, so it has no
    // candidate and must still come back as an empty document list.
    const productIds: string[] = []
    for (const index of [0, 1, 2, 3]) {
      const imported = await call(base, workspace, 'catalog.import', {
        platform: 'taobao', account_id: accountId, brand_id: brandId, draft_only: 'true',
        title: `知识商品 ${index}`, skus_json: JSON.stringify([{ id: `sku_${index}`, name: `规格 ${index}`, price: 10, stock: 1 }]),
      })
      const productId = imported.data?.result?.product_id as string
      expect(productId).toBeTruthy()
      productIds.push(productId)
      expect((await call(base, workspace, 'catalog.facts.confirm', { product_id: productId })).error).toBeNull()
      if (index < 3) await seedSearchableKnowledge(workspace, { id: `doc_page_${index}`, productId, text: `商品 ${index} 的可检索知识` })
    }

    const search = vi.spyOn(MemoryKnowledgeRepository.prototype, 'search')
    const page = await catalogPage(base, workspace, { scope: 'workspace', include_knowledge: 'true' })
    const products = page.products
    expect(products.map(product => product.product_id).sort()).toEqual([...productIds].sort())

    // One group call for the page, carrying every product of the store scope —
    // not one call per product with a candidate.
    expect(search).toHaveBeenCalledTimes(1)
    const input = search.mock.calls[0]?.[0] as { productId?: string; productIds?: readonly string[]; platform?: string; accountId?: string; limit?: number } | undefined
    expect(input?.productId).toBeUndefined()
    expect([...(input?.productIds ?? [])].sort()).toEqual([...productIds].sort())
    expect(input).toMatchObject({ platform: 'taobao', accountId, limit: 8 })

    for (const product of products) {
      const index = productIds.indexOf(product.product_id)
      if (index < 3) {
        // Field-for-field equal to the per-product call this page used to make.
        const direct = await knowledgeDocuments.search({ workspaceId: workspace, platform: 'taobao', accountId, productId: product.product_id, limit: 8 })
        expect(product.knowledge_documents).toEqual(knowledgeDocumentsView(direct))
        expect(product.knowledge_status).toBeUndefined()
      } else {
        expect(product.knowledge_documents).toEqual([])
        // The blocker still reports the product's true pending document count
        // (the imported product document plus its one SKU document).
        expect(product.knowledge_status).toEqual(expect.objectContaining({ state: 'pending_review_or_index', document_count: 2 }))
      }
    }
  })

  it('keeps one knowledge search per store when the page spans two stores', async () => {
    const base = await start()
    const workspace = `ws_catalog_page_two_stores_${Date.now()}`
    await grantCommercialAccess(workspace)
    const north = await call(base, workspace, 'platform.connect', { platform: 'taobao', store_key: 'north' })
    const south = await call(base, workspace, 'platform.connect', { platform: 'taobao', store_key: 'south' })
    const northAccountId = north.data?.result?.account?.id as string
    const southAccountId = south.data?.result?.account?.id as string
    expect(northAccountId).toBeTruthy()
    expect(southAccountId).toBeTruthy()
    expect(northAccountId).not.toBe(southAccountId)
    const brand = await call(base, workspace, 'brand-unit.create', { name: '跨店知识品' })
    const brandId = brand.data?.result?.id as string
    for (const accountId of [northAccountId, southAccountId]) {
      expect((await call(base, workspace, 'brand-unit.bind-store', { brand_id: brandId, platform: 'taobao', account_id: accountId })).error).toBeNull()
    }

    const productIds: Record<string, string[]> = { [northAccountId]: [], [southAccountId]: [] }
    for (const accountId of [northAccountId, southAccountId]) {
      for (const index of [0, 1]) {
        const imported = await call(base, workspace, 'catalog.import', {
          platform: 'taobao', account_id: accountId, brand_id: brandId, draft_only: 'true',
          title: `跨店商品 ${accountId.slice(-4)} ${index}`, skus_json: JSON.stringify([{ id: `sku_x_${index}`, name: `规格 ${index}`, price: 10, stock: 1 }]),
        })
        const productId = imported.data?.result?.product_id as string
        expect(productId).toBeTruthy()
        productIds[accountId]!.push(productId)
        expect((await call(base, workspace, 'catalog.facts.confirm', { product_id: productId })).error).toBeNull()
        await seedSearchableKnowledge(workspace, { id: `doc_store_${accountId.slice(-4)}_${index}`, productId, text: `跨店知识 ${index}` })
      }
    }

    const search = vi.spyOn(MemoryKnowledgeRepository.prototype, 'search')
    const page = await catalogPage(base, workspace, { scope: 'workspace', include_knowledge: 'true' })
    expect(page.products).toHaveLength(4)
    // The store is part of `search`'s own scope, so a two-store page needs one
    // call per store — and no more.
    expect(search).toHaveBeenCalledTimes(2)
    const batches = search.mock.calls.map(call => call[0] as { accountId?: string; productIds?: readonly string[] })
    expect(batches.map(batch => [batch.accountId, [...(batch.productIds ?? [])].sort()]).sort()).toEqual([
      [northAccountId, [...productIds[northAccountId]!].sort()],
      [southAccountId, [...productIds[southAccountId]!].sort()],
    ].sort())
    for (const product of page.products) {
      expect(product.knowledge_documents).toHaveLength(1)
    }
  })

  it('searches a SKU-scoped page once and returns the same slice per product', async () => {
    const base = await start()
    const workspace = `ws_catalog_page_sku_${Date.now()}`
    await grantCommercialAccess(workspace)
    const connected = await call(base, workspace, 'platform.connect', { platform: 'taobao' })
    const accountId = connected.data?.result?.account?.id as string
    const brand = await call(base, workspace, 'brand-unit.create', { name: 'SKU 知识品' })
    const brandId = brand.data?.result?.id as string
    expect((await call(base, workspace, 'brand-unit.bind-store', { brand_id: brandId, platform: 'taobao', account_id: accountId })).error).toBeNull()

    // Every product carries the *same* SKU id, so the id-filtered page holds
    // three products that share one resolved `sku_id`. Each also carries a
    // product-scoped document that the SKU filter must exclude.
    const productIds: string[] = []
    for (const index of [0, 1, 2]) {
      const imported = await call(base, workspace, 'catalog.import', {
        platform: 'taobao', account_id: accountId, brand_id: brandId, draft_only: 'true',
        title: `SKU 商品 ${index}`,
        skus_json: JSON.stringify([
          { id: 'sku_shared', name: '通用规格', price: 10, stock: 1 },
          { id: `sku_only_${index}`, name: `专属规格 ${index}`, price: 11, stock: 1 },
        ]),
      })
      const productId = imported.data?.result?.product_id as string
      expect(productId).toBeTruthy()
      productIds.push(productId)
      expect((await call(base, workspace, 'catalog.facts.confirm', { product_id: productId })).error).toBeNull()
      await seedSearchableKnowledge(workspace, { id: `doc_sku_${index}`, productId, skuId: 'sku_shared', text: `SKU 知识 ${index}` })
      await seedSearchableKnowledge(workspace, { id: `doc_plain_${index}`, productId, text: `商品级知识 ${index}` })
    }

    const search = vi.spyOn(MemoryKnowledgeRepository.prototype, 'search')
    const page = await catalogPage(base, workspace, { scope: 'workspace', include_knowledge: 'true', sku_id: 'sku_shared' })
    expect(page.products.map(product => product.product_id).sort()).toEqual([...productIds].sort())
    expect(search).toHaveBeenCalledTimes(1)
    const input = search.mock.calls[0]?.[0] as { skuId?: string; productId?: string; productIds?: readonly string[] } | undefined
    expect(input?.productId).toBeUndefined()
    expect(input?.skuId).toBe('sku_shared')
    expect([...(input?.productIds ?? [])].sort()).toEqual([...productIds].sort())
    for (const product of page.products) {
      const direct = await knowledgeDocuments.search({ workspaceId: workspace, platform: 'taobao', accountId, productId: product.product_id, skuId: 'sku_shared', limit: 8 })
      expect(product.knowledge_documents).toEqual(knowledgeDocumentsView(direct))
      // The product-scoped document is excluded by the shared `sku_id` filter,
      // so the page only ever sees one document per product.
      expect(product.knowledge_documents).toHaveLength(1)
    }
  })

  it('does not batch a SKU *name* into a shared sku_id scope', async () => {
    const base = await start()
    const workspace = `ws_catalog_page_sku_name_${Date.now()}`
    await grantCommercialAccess(workspace)
    const connected = await call(base, workspace, 'platform.connect', { platform: 'taobao' })
    const accountId = connected.data?.result?.account?.id as string
    const brand = await call(base, workspace, 'brand-unit.create', { name: 'SKU 名称品' })
    const brandId = brand.data?.result?.id as string
    expect((await call(base, workspace, 'brand-unit.bind-store', { brand_id: brandId, platform: 'taobao', account_id: accountId })).error).toBeNull()

    // `catalog.search` resolves `sku_id` against the *page filter*, which is
    // id-based, so a SKU name selects no product at all. That is what keeps a
    // shared `sku_id` group sound: no two products on one page can resolve the
    // same requested value to different SKU ids.
    const imported = await call(base, workspace, 'catalog.import', {
      platform: 'taobao', account_id: accountId, brand_id: brandId, draft_only: 'true',
      title: 'SKU 名称商品', skus_json: JSON.stringify([{ id: 'sku_named', name: '通用规格', price: 10, stock: 1 }]),
    })
    const productId = imported.data?.result?.product_id as string
    expect((await call(base, workspace, 'catalog.facts.confirm', { product_id: productId })).error).toBeNull()
    await seedSearchableKnowledge(workspace, { id: 'doc_named', productId, skuId: 'sku_named', text: '名称知识' })

    const search = vi.spyOn(MemoryKnowledgeRepository.prototype, 'search')
    const page = await catalogPage(base, workspace, { scope: 'workspace', include_knowledge: 'true', sku_id: '通用规格' })
    expect(page.products).toEqual([])
    expect(search).not.toHaveBeenCalled()
    // The same document is reachable by its real SKU id, which proves the empty
    // page above is the page filter and not a missing document.
    const byId = await catalogPage(base, workspace, { scope: 'workspace', include_knowledge: 'true', sku_id: 'sku_named' })
    expect(byId.products).toHaveLength(1)
    expect(byId.products[0]?.knowledge_documents).toHaveLength(1)
  })

  it('resolves the whole brand page with one grant read under strict auth', async () => {
    const workspace = `ws_brand_page_batch_${Date.now()}`
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'catalog-page-batch-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'batch-owner-token': { workspaces: [workspace], actor_id: 'batch-owner' },
      'batch-operator-token': { workspaces: [workspace], actor_id: 'batch-operator' },
    }))
    const base = await start()
    await grantCommercialAccess(workspace)
    const owner = { authorization: 'Bearer batch-owner-token' }
    const operator = { authorization: 'Bearer batch-operator-token' }
    await workspaceMembers.upsert({ workspaceId: workspace, externalSubject: 'batch-owner', displayName: '批量所有者', role: 'workspace_owner', status: 'active', invitedBy: 'test' })
    await workspaceMembers.upsert({ workspaceId: workspace, externalSubject: 'batch-operator', displayName: '批量成员', role: 'operator', status: 'active', invitedBy: 'test' })

    const brandIds: string[] = []
    for (const index of [0, 1, 2]) {
      const created = await call(base, workspace, 'brand-unit.create', { brand_id: `batch_brand_${index}`, name: `批量品牌 ${index}` }, owner)
      expect(created.error).toBeNull()
      brandIds.push(`batch_brand_${index}`)
      const granted = await call(base, workspace, 'brand-unit.access.grant', { brand_id: `batch_brand_${index}`, role: 'viewer', external_subject: 'batch-operator' }, owner)
      expect(granted.error).toBeNull()
    }

    expect(typeof MemoryBrandUnitRepository.prototype.hasBrandAccessMany).toBe('function')
    const hasBrandAccess = vi.spyOn(MemoryBrandUnitRepository.prototype, 'hasBrandAccess')
    const listed = await call(base, workspace, 'brand-unit.list', {}, operator)
    expect(listed.error).toBeNull()
    expect((listed.data?.result?.items ?? []).map((item: { id: string }) => item.id).sort()).toEqual([...brandIds].sort())
    // Every brand on the page is resolved by one page-level grant read; the
    // per-brand form opened its own transaction per brand and is gone from this
    // path.
    expect(hasBrandAccess).not.toHaveBeenCalled()
  })
})
