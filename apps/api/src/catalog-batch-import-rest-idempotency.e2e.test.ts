import { describe, expect, it, vi } from 'vitest'
import { handleHttpProductWrite, type HttpProductWriteDependencies } from './http-product-write-routes.js'
import { MemoryCatalogBatchImportIdempotencyRepository } from '../../../packages/persistence/src/catalog-batch-import-idempotency-repository.js'

function fixture() {
  const products = new Map<string, any>()
  const service = {
    products,
    importProduct: vi.fn((input: any) => {
      const id = `${input.workspaceId}:${input.platform}:${input.localProductKey || input.title}`
      const product = { id, workspaceId: input.workspaceId, version: (products.get(id)?.version ?? 0) + 1, title: input.title, platform: input.platform, factsConfirmed: false }
      products.set(id, product)
      return product
    }),
    getActionablePlatformAccount: vi.fn(),
  }
  const persistSnapshotsAndEvent = vi.fn(async () => undefined)
  const recordOperationAudit = vi.fn(async () => undefined)
  const dependencies = {
    service, supportedPlatforms: ['jd'], isProduction: () => false,
    body: vi.fn(async (req: any) => req.body), resolveWorkspace: () => 'ws_rest_batch_idempotency',
    required: (params: Record<string, unknown>, key: string) => String(params[key]), actor: () => 'rest-actor',
    scanImportedProductRules: vi.fn(async () => undefined), persistSnapshot: vi.fn(async () => undefined),
    persistSnapshotsAndEvent, recordOperationAudit, rollbackBatchProducts: () => undefined,
    enforceProductBrandAccess: vi.fn(async () => undefined), enforceAssetAccess: vi.fn(async () => undefined),
    confirmProductFactsTransition: vi.fn(), send: vi.fn(),
    idempotency: new MemoryCatalogBatchImportIdempotencyRepository(),
  } as unknown as HttpProductWriteDependencies
  const request = (body: Record<string, unknown>, key?: string) => ({ method: 'POST', headers: key ? { 'idempotency-key': key } : {}, body }) as any
  const response = () => ({ writableEnded: false }) as any
  return { dependencies, service, persistSnapshotsAndEvent, recordOperationAudit, request, response }
}

describe('REST catalog batch import idempotency', () => {
  it('replays same-key same-payload result without repeating writes and conflicts on changed payload', async () => {
    const f = fixture()
    const firstResponse = f.response()
    await handleHttpProductWrite(f.request({ products: [{ platform: 'jd', local_product_key: 'same-1', title: 'REST 重放商品' }] }, 'rest-catalog-import-key-1'), firstResponse, '/v1/products/import/batch', f.dependencies)
    const replayResponse = f.response()
    await handleHttpProductWrite(f.request({ products: [{ platform: 'jd', local_product_key: 'same-1', title: 'REST 重放商品' }] }, 'rest-catalog-import-key-1'), replayResponse, '/v1/products/import/batch', f.dependencies)
    expect(f.service.importProduct).toHaveBeenCalledTimes(1)
    expect(f.persistSnapshotsAndEvent).toHaveBeenCalledTimes(1)
    expect(f.recordOperationAudit).toHaveBeenCalledTimes(1)
    expect(f.dependencies.send).toHaveBeenNthCalledWith(1, firstResponse, 201, 'ws_rest_batch_idempotency', expect.objectContaining({ batchId: expect.any(String) }), null, expect.anything())
    expect(f.dependencies.send).toHaveBeenNthCalledWith(2, replayResponse, 200, 'ws_rest_batch_idempotency', expect.objectContaining({ batchId: expect.any(String) }), null, expect.anything())
    await expect(handleHttpProductWrite(f.request({ products: [{ platform: 'jd', local_product_key: 'same-1', title: 'changed intent' }] }, 'rest-catalog-import-key-1'), f.response(), '/v1/products/import/batch', f.dependencies)).rejects.toMatchObject({ code: 'PRODUCT_IMPORT_IDEMPOTENCY_CONFLICT', status: 409 })
    expect(f.service.importProduct).toHaveBeenCalledTimes(1)
  })

  it('preserves legacy behavior when no idempotency key is supplied', async () => {
    const f = fixture()
    for (let index = 0; index < 2; index++) await handleHttpProductWrite(f.request({ products: [{ platform: 'jd', local_product_key: 'legacy-1', title: 'legacy import' }] }), f.response(), '/v1/products/import/batch', f.dependencies)
    expect(f.service.importProduct).toHaveBeenCalledTimes(2)
  })
})
