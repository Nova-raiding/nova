import { describe, expect, it, vi } from 'vitest'
import { MemoryKnowledgeRepository } from '../../../packages/persistence/src/knowledge.js'
import { handleCatalogBatchImport, type CatalogBatchImportDependencies } from './mcp-catalog-batch-import.js'
import { rollbackBatchProducts } from './server.js'

function setup(options: { denyAssetAccess?: boolean; failFirstPersist?: boolean } = {}) {
  const products = new Map<string, { id: string; workspaceId: string; version: number; title: string; platform: 'jd' }>()
  const service = {
    products,
    importProduct: vi.fn((input: { workspaceId: string; platform: 'jd'; localProductKey?: string; title: string }) => {
      const id = `${input.workspaceId}:${input.platform}:${input.localProductKey || input.title}`
      const previous = products.get(id)
      const product = { id, workspaceId: input.workspaceId, version: (previous?.version ?? 0) + 1, title: input.title, platform: input.platform }
      products.set(id, product)
      return product
    }),
    getActionablePlatformAccount: vi.fn(),
  }
  const enforceAssetAccess = vi.fn(async (_workspaceId: string, _assetId: string, _role: 'editor' | 'viewer') => {
    if (options.denyAssetAccess) throw Object.assign(new Error('asset access denied'), { code: 'ASSET_ACCESS_DENIED' })
  })
  let persistAttempts = 0
  const persistSnapshotsAndEvent = vi.fn(async () => {
    persistAttempts += 1
    if (options.failFirstPersist && persistAttempts === 1) throw new Error('temporary persistence failure')
  })
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
    enforceAssetAccess,
    assetForWorkspace: () => { throw new Error('source asset lookup was not expected') },
    scanImportedProductRules: async () => undefined,
    persistSnapshotsAndEvent,
    recordOperationAudit: async () => undefined,
    rollbackBatchProducts: (map: typeof products, workspaceId: string, writes: Array<{ product: { id: string; workspaceId: string; version: number }; version: number }>, before: ReadonlyMap<string, { id: string; workspaceId: string; version: number }>) => rollbackBatchProducts(map, workspaceId, writes, before),
    actor: () => 'fixture-merchant',
  } as unknown as CatalogBatchImportDependencies

  return { dependencies, service, enforceAssetAccess, persistSnapshotsAndEvent }
}

const params = (items: unknown[]) => ({ products_json: JSON.stringify(items) })
const oneProduct = (overrides: Record<string, unknown> = {}) => ({ platform: 'jd', local_product_key: 'sku-import-1', title: '回归商品', ...overrides })

describe('catalog batch import security and recovery boundaries', () => {
  it('fails closed when a referenced workspace asset is not authorized, before creating products', async () => {
    const { dependencies, service, enforceAssetAccess } = setup({ denyAssetAccess: true })

    await expect(handleCatalogBatchImport('ws_import_boundary', params([oneProduct({ asset_ids: ['asset_other_workspace'] })]), dependencies))
      .rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })

    expect(enforceAssetAccess).toHaveBeenCalledWith('ws_import_boundary', 'asset_other_workspace', 'viewer')
    expect(service.importProduct).not.toHaveBeenCalled()
    expect(service.products.size).toBe(0)
  })

  it('rejects duplicate product identities in one submission before any write', async () => {
    const { dependencies, service } = setup()

    await expect(handleCatalogBatchImport('ws_import_boundary', params([
      oneProduct(), oneProduct({ title: '重复提交行' }),
    ]), dependencies)).rejects.toMatchObject({ code: 'PRODUCT_IMPORT_IDENTITY_CONFLICT' })

    expect(service.importProduct).not.toHaveBeenCalled()
    expect(service.products.size).toBe(0)
  })

  it('rolls back a transient persistence failure and allows a clean retry', async () => {
    const { dependencies, service, persistSnapshotsAndEvent } = setup({ failFirstPersist: true })
    const request = params([oneProduct()])

    await expect(handleCatalogBatchImport('ws_import_boundary', request, dependencies))
      .rejects.toThrow('temporary persistence failure')
    expect(service.products.size).toBe(0)

    const retried = await handleCatalogBatchImport('ws_import_boundary', request, dependencies)
    expect(retried).toMatchObject({ count: 1, atomic: true, products: [{ title: '回归商品' }] })
    expect(service.products.size).toBe(1)
    expect(persistSnapshotsAndEvent).toHaveBeenCalledTimes(2)
  })
})
