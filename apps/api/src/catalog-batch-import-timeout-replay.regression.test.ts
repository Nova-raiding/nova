import { describe, expect, it, vi } from 'vitest'
import { MemoryKnowledgeRepository } from '../../../packages/persistence/src/knowledge.js'
import { handleCatalogBatchImport, type CatalogBatchImportDependencies } from './mcp-catalog-batch-import.js'
import { rollbackBatchProducts } from './server.js'

function fixture() {
  const products = new Map<string, { id: string; workspaceId: string; version: number; title: string; platform: 'jd' }>()
  const service = {
    products,
    importProduct: vi.fn((input: { workspaceId: string; platform: 'jd'; localProductKey?: string; title: string }) => {
      const id = `${input.workspaceId}:${input.platform}:${input.localProductKey || input.title}`
      const current = products.get(id)
      const product = { id, workspaceId: input.workspaceId, version: (current?.version ?? 0) + 1, title: input.title, platform: input.platform }
      products.set(id, product)
      return product
    }),
    getActionablePlatformAccount: vi.fn(),
  }
  const persistSnapshotsAndEvent = vi.fn(async () => undefined)
  const recordOperationAudit = vi.fn(async () => undefined)
  const dependencies = {
    service,
    supportedPlatforms: ['jd'],
    isProduction: () => false,
    knowledgeRepository: new MemoryKnowledgeRepository(),
    required: (params: Record<string, unknown>, key: string) => {
      const value = params[key]
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} required`)
      return value
    },
    enforceAssetAccess: vi.fn(async () => undefined),
    assetForWorkspace: vi.fn(() => { throw new Error('source asset lookup was not expected') }),
    scanImportedProductRules: vi.fn(async () => undefined),
    persistSnapshotsAndEvent,
    recordOperationAudit,
    rollbackBatchProducts: (map: typeof products, workspaceId: string, writes: Array<{ product: { id: string; workspaceId: string; version: number }; version: number }>, before: ReadonlyMap<string, { id: string; workspaceId: string; version: number }>) => rollbackBatchProducts(map, workspaceId, writes, before),
    actor: () => 'fixture-merchant',
  } as unknown as CatalogBatchImportDependencies

  return { dependencies, service, persistSnapshotsAndEvent, recordOperationAudit }
}

describe('catalog batch import timeout replay idempotency', () => {
  it('returns the original result for an identical replay and does not repeat product, snapshot, or audit writes', async () => {
    const { dependencies, service, persistSnapshotsAndEvent, recordOperationAudit } = fixture()
    const workspaceId = 'ws_catalog_timeout_replay'
    const params = {
      idempotency_key: 'catalog-import-timeout-replay-1',
      products_json: JSON.stringify([{ platform: 'jd', local_product_key: 'sku-replay-1', title: '网络超时重放商品' }]),
    }

    // Simulate request #1 committing server-side while its response is lost to the client.
    const firstResponse = await handleCatalogBatchImport(workspaceId, params, dependencies)
    // Request #2 is the client's whole-request retry with the same key and payload.
    const replayResponse = await handleCatalogBatchImport(workspaceId, params, dependencies)

    expect(replayResponse).toEqual(firstResponse)
    expect(service.importProduct).toHaveBeenCalledTimes(1)
    expect(service.products.size).toBe(1)
    expect(service.products.values().next().value).toMatchObject({ version: 1, title: '网络超时重放商品' })
    expect(persistSnapshotsAndEvent).toHaveBeenCalledTimes(1)
    expect(recordOperationAudit).toHaveBeenCalledTimes(1)
  })
})
