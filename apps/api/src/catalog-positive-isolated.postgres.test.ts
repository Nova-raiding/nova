import { afterEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { PostgresBusinessRepository } from '../../../packages/persistence/src/business-repository.js'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, server, service, setBusinessRepositoryForTests } from './server.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const runId = process.env.MERCHANT_ISOLATED_POSTGRES_RUN_ID
const workspaceId = runId && /^[a-f0-9-]{36}$/u.test(runId)
  ? `ws_catalog_fixture_${runId.replaceAll('-', '')}` : undefined

type Envelope = { data: { result: Record<string, any> } | null; error: { code: string; message: string } | null }

describe('isolated catalog API to PostgreSQL readback', () => {
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    setBusinessRepositoryForTests(undefined)
  })

  it('persists draft import, product and SKU changes, confirmation, and batch import', async () => {
    if (!databaseUrl || !workspaceId || new URL(databaseUrl).hostname !== '127.0.0.1') {
      throw new Error('CATALOG_ISOLATED_POSTGRES_FIXTURE_REQUIRED')
    }
    const pool = new Pool({ connectionString: databaseUrl!, max: 2 })
    const repository = new PostgresBusinessRepository(pool, { normalizedProjection: true })
    setBusinessRepositoryForTests(repository)
    try {
      await pool.query("INSERT INTO workspaces (id,status) VALUES ($1,'active')", [workspaceId])
      await grantCreativePointsForTests(workspaceId!)
      grantContinuousFeatureEntitlementForTests(workspaceId!)
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        server.once('error', onError)
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('isolated catalog API did not bind')
      const base = `http://127.0.0.1:${address.port}`
      const call = async (method: string, params: Record<string, unknown>): Promise<Envelope> => fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId!, 'x-test-commercial-fixture': 'server-e2e' },
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { workspace_id: workspaceId, ...params } }),
      }).then(response => response.json() as Promise<Envelope>)

      const imported = await call('catalog.import', {
        platform: 'taobao', draft_only: 'true', title: '隔离验收外套', price: '129', stock: '2',
        skus_json: JSON.stringify([{ id: 'sku-local-a', name: '蓝色/M', price: 129, stock: 2 }]),
      })
      expect(imported.error).toBeNull()
      const productId = String(imported.data!.result.product_id)
      const persistedImport = await repository.get(workspaceId!, 'product', productId)
      expect(persistedImport.payload).toMatchObject({ title: '隔离验收外套' })
      expect(imported.data!.result).toMatchObject({ draft_only: true, publishable: false })

      const updated = await call('catalog.product.update', { product_id: productId, title: '隔离验收防晒外套', expected_version: String(imported.data!.result.version) })
      expect(updated.error).toBeNull()
      expect((await repository.get(workspaceId!, 'product', productId)).payload).toMatchObject({ title: '隔离验收防晒外套', factsConfirmed: false })
      const sku = await call('catalog.sku.update', { product_id: productId, sku_id: 'sku-local-a', stock: '5', expected_version: String(updated.data!.result.version) })
      expect(sku.error).toBeNull()
      expect((await repository.get(workspaceId!, 'product', productId)).payload).toMatchObject({ skus: [expect.objectContaining({ id: 'sku-local-a', stock: 5 })] })
      const confirmed = await call('catalog.facts.confirm', { product_id: productId })
      expect(confirmed.error).toBeNull()
      expect((await repository.get(workspaceId!, 'product', productId)).payload).toMatchObject({ factsConfirmed: true })

      const batch = await call('catalog.import.batch', { draft_only: 'true', products_json: JSON.stringify([
        { platform: 'taobao', local_product_key: 'isolated-batch-a', title: '隔离验收批量商品 A', stock: 1 },
        {
          platform: 'taobao', local_product_key: 'isolated-batch-special', remote_id: 'remote-special-001',
          title: '组合_%! 隔离商品', store_name: '字面_%! 店铺', attributes: { brand: '测试_%! 品牌' },
          skus: [{ id: 'sku-special-001', name: '特殊字符规格', price: 20, stock: 3 }],
        },
      ]) })
      expect(batch.error).toBeNull()
      expect(batch.data!.result).toMatchObject({ atomic: false, atomic_scope: 'none_across_workflow', snapshot_outbox_transactional: true, count: 2 })
      const batchId = String(batch.data!.result.products[0].id)
      expect((await repository.get(workspaceId!, 'product', batchId)).payload).toMatchObject({ title: '隔离验收批量商品 A' })
      const specialId = String(batch.data!.result.products[1].id)
      expect((await repository.get(workspaceId!, 'product', specialId)).payload).toMatchObject({
        title: '组合_%! 隔离商品', storeName: '字面_%! 店铺', remoteId: 'remote-special-001',
        attributes: { brand: '测试_%! 品牌' }, skus: [expect.objectContaining({ id: 'sku-special-001' })],
      })
      const page = await repository.listProductsPage(workspaceId!, { limit: 20, offset: 0 })
      expect(page.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: productId, title: '隔离验收防晒外套' }),
        expect.objectContaining({ id: batchId, title: '隔离验收批量商品 A' }),
        expect.objectContaining({ id: specialId, title: '组合_%! 隔离商品' }),
      ]))
      const searched = await call('catalog.search', { scope: 'workspace', query: '隔离验收防晒外套' })
      expect(searched.error).toBeNull()
      expect(searched.data!.result.products).toEqual(expect.arrayContaining([expect.objectContaining({ product_id: productId })]))

      // Compare the durable MCP query against the in-memory service fallback
      // over the exact same isolated fixture. `%`, `_`, and `!` are literal
      // search characters here; PostgreSQL LIKE must not widen the result.
      const specialFilters = {
        scope: 'workspace', query: '组合_%!', platform: 'taobao', store_name: '_%!',
        brand_name: '_%!', sku_id: 'sku-special-001', remote_product_id: 'remote-special-001',
      }
      const fallbackSpecial = service.listProducts(workspaceId!, {
        query: String(specialFilters.query), platform: 'taobao', storeName: String(specialFilters.store_name),
        brandName: String(specialFilters.brand_name), skuId: String(specialFilters.sku_id), remoteProductId: String(specialFilters.remote_product_id),
      })
      const durableSpecial = await call('catalog.search', { ...specialFilters, limit: '1', offset: '0' })
      expect(durableSpecial.error).toBeNull()
      expect(durableSpecial.data!.result.total).toBe(fallbackSpecial.length)
      expect(durableSpecial.data!.result.products.map((product: { product_id: string }) => product.product_id)).toEqual(fallbackSpecial.map(product => product.id))
      expect(durableSpecial.data!.result.products.map((product: { product_id: string }) => product.product_id)).toEqual([specialId])

      // Count and page contents must use the same filter set. Exercise a later
      // page and a timestamp window around the persisted value without relying
      // on wall-clock sleeps or unrelated workspace data.
      const fallbackQuery = service.listProducts(workspaceId!, { query: '隔离验收' })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      const durableSecondPage = await call('catalog.search', { scope: 'workspace', query: '隔离验收', limit: '1', offset: '1' })
      expect(durableSecondPage.error).toBeNull()
      expect(durableSecondPage.data!.result.total).toBe(fallbackQuery.length)
      expect(durableSecondPage.data!.result.products.map((product: { product_id: string }) => product.product_id)).toEqual(fallbackQuery.slice(1, 2).map(product => product.id))
      const specialProduct = page.items.find(product => product.id === specialId) as { updatedAt: string }
      const dateFrom = new Date(Date.parse(specialProduct.updatedAt) - 1_000).toISOString()
      const dateTo = new Date(Date.parse(specialProduct.updatedAt) + 1_000).toISOString()
      const dateFallback = service.listProducts(workspaceId!, { query: '组合_%!', dateFrom, dateTo })
      const dateBoundary = await call('catalog.search', {
        scope: 'workspace', query: '组合_%!', date_from: dateFrom,
        date_to: dateTo, limit: '10', offset: '0',
      })
      expect(dateBoundary.error).toBeNull()
      expect(dateBoundary.data!.result.total).toBe(dateFallback.length)
      expect(dateBoundary.data!.result.products.map((product: { product_id: string }) => product.product_id)).toEqual(dateFallback.map(product => product.id))
      expect(dateBoundary.data!.result.products.map((product: { product_id: string }) => product.product_id)).toEqual([specialId])
    } finally {
      setBusinessRepositoryForTests(undefined)
      await pool.end()
    }
  }, 120_000)
})
