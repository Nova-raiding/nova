import { afterEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { PostgresBusinessRepository } from '../../../packages/persistence/src/business-repository.js'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, server, setBusinessRepositoryForTests } from './server.js'

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
      ]) })
      expect(batch.error).toBeNull()
      expect(batch.data!.result).toMatchObject({ atomic: true, count: 1 })
      const batchId = String(batch.data!.result.products[0].id)
      expect((await repository.get(workspaceId!, 'product', batchId)).payload).toMatchObject({ title: '隔离验收批量商品 A' })
      const page = await repository.listProductsPage(workspaceId!, { limit: 20, offset: 0 })
      expect(page.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: productId, title: '隔离验收防晒外套' }),
        expect.objectContaining({ id: batchId, title: '隔离验收批量商品 A' }),
      ]))
      const searched = await call('catalog.search', { scope: 'workspace', query: '隔离验收防晒外套' })
      expect(searched.error).toBeNull()
      expect(searched.data!.result.products).toEqual(expect.arrayContaining([expect.objectContaining({ product_id: productId })]))
    } finally {
      setBusinessRepositoryForTests(undefined)
      await pool.end()
    }
  }, 120_000)
})
