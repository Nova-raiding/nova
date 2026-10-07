import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type MerchantService, type Platform, type Product } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { assertUniqueBatchProductImportIdentities } from './product-import-identity.js'
import { batchFactsConfirmation, productFactsConfirmation } from './brand-product-helpers.js'
import { CatalogBatchImportIdempotencyError, hashCatalogBatchImportIntent, MemoryCatalogBatchImportIdempotencyRepository, type CatalogBatchImportIdempotencyRepository } from '../../../packages/persistence/src/catalog-batch-import-idempotency-repository.js'

const memoryHttpBatchImportIdempotency = new MemoryCatalogBatchImportIdempotencyRepository()

type Params = Record<string, unknown>
type BatchProductWrite = { product: Product; version: number }
type Snapshot = { entityType: 'product'; entityId: string; entityVersion: number; payload: Record<string, unknown> }
export interface HttpProductWriteDependencies {
  service: Pick<MerchantService, 'products' | 'importProduct' | 'getActionablePlatformAccount'>
  supportedPlatforms: readonly Platform[]
  isProduction(): boolean
  body(req: IncomingMessage): Promise<Params>
  resolveWorkspace(req: IncomingMessage, candidate?: unknown): string
  required(params: Params, key: string): string
  actor(): string
  scanImportedProductRules(workspaceId: string, product: Product): Promise<unknown>
  persistSnapshot(workspaceId: string, entityType: 'product', entity: Product, value: Record<string, unknown>): Promise<unknown>
  persistSnapshotsAndEvent(input: { workspaceId: string; snapshots: Snapshot[]; aggregateId: string; eventType: string; sequence: number; eventPayload: Record<string, unknown> }): Promise<unknown>
  recordOperationAudit(input: { workspaceId: string; actorId: string; action: string; resourceType: string; resourceId: string; before: Record<string, unknown>; after: Record<string, unknown>; reason: string }): Promise<unknown>
  rollbackBatchProducts: typeof import('./server.js').rollbackBatchProducts
  enforceProductBrandAccess(workspaceId: string, productId: string): Promise<unknown>
  confirmProductFactsTransition(input: { workspaceId: string; productId: string; source: 'rest' }): ReturnType<typeof import('./brand-product-helpers.js').confirmProductFactsTransition>
  send(res: ServerResponse, status: number, workspaceId: string, data: unknown, error: null, req: IncomingMessage): void
  idempotency?: CatalogBatchImportIdempotencyRepository
  enforceAssetAccess?(workspaceId: string, assetId: string, role: 'viewer'): Promise<unknown>
}

/** Returns false only when none of the product write routes matched. */
export async function handleHttpProductWrite(req: IncomingMessage, res: ServerResponse, path: string, deps: HttpProductWriteDependencies): Promise<void | false> {
  const { service, supportedPlatforms, isProduction, body, resolveWorkspace, required, actor, scanImportedProductRules, persistSnapshot, persistSnapshotsAndEvent, recordOperationAudit, rollbackBatchProducts, enforceProductBrandAccess, confirmProductFactsTransition, send } = deps
  if (req.method === 'POST' && path === '/v1/products/import/batch') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    if (!Array.isArray(input.products) || input.products.length < 1 || input.products.length > 50 || input.products.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'products 必须是 1 至 50 个商品对象的数组', 400)
    type RestBatchItem = Parameters<MerchantService['importProduct']>[0]
    const items: RestBatchItem[] = input.products.map((raw: Record<string, unknown>, index: number) => {
      const platform = typeof raw.platform === 'string' ? raw.platform as Platform : '' as Platform
      if (!supportedPlatforms.includes(platform)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 platform 无效`, 400)
      const accountId = typeof raw.account_id === 'string' && raw.account_id.trim() ? raw.account_id.trim() : undefined
      if (isProduction() && !accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', `第 ${index + 1} 项生产导入必须绑定已授权平台账号`, 400)
      if (accountId) service.getActionablePlatformAccount(workspaceId, accountId, platform)
      const title = typeof raw.title === 'string' ? raw.title.trim() : ''
      if (!title) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 title 不能为空`, 400)
      const sourceAssetIds = Array.isArray(raw.asset_ids) ? raw.asset_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(value => value.trim()) : undefined
      if (sourceAssetIds && (sourceAssetIds.length > 50 || new Set(sourceAssetIds).size !== sourceAssetIds.length)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 asset_ids 必须是最多 50 个不重复素材 ID`, 400)
      const skus = Array.isArray(raw.skus) ? raw.skus.map((sku: any, skuIndex: number) => {
        if (!sku || typeof sku !== 'object' || typeof sku.id !== 'string' || typeof sku.name !== 'string' || typeof sku.price !== 'number' || typeof sku.stock !== 'number') throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 SKU ${skuIndex + 1} 格式无效`, 400)
        if (sku.sourceAssetIds !== undefined && (!Array.isArray(sku.sourceAssetIds) || sku.sourceAssetIds.length > 50 || sku.sourceAssetIds.some((value: unknown) => typeof value !== 'string' || !value.trim()) || new Set(sku.sourceAssetIds).size !== sku.sourceAssetIds.length)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 SKU ${skuIndex + 1} 原图素材必须是最多 50 个不重复素材 ID`, 400)
        return { id: sku.id.trim(), name: sku.name.trim(), price: sku.price, stock: sku.stock, ...(Array.isArray(sku.sourceAssetIds) ? { sourceAssetIds: sku.sourceAssetIds.map((value: string) => value.trim()) } : {}), ...(Array.isArray(sku.images) ? { images: sku.images.filter((value: unknown): value is string => typeof value === 'string') } : {}), ...(sku.attributes && typeof sku.attributes === 'object' && !Array.isArray(sku.attributes) ? { attributes: Object.fromEntries(Object.entries(sku.attributes).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value as string])) } : {}) }
      }) : undefined
      const sellingPoints = Array.isArray(raw.selling_points) ? raw.selling_points.map((point: any, pointIndex: number) => ({ id: typeof point?.id === 'string' ? point.id : `sp_${pointIndex + 1}`, text: typeof point?.text === 'string' ? point.text : '', proofStatus: point?.proof_status === 'confirmed' || point?.proof_status === 'rejected' ? point.proof_status : 'pending', sourceIds: Array.isArray(point?.source_ids) ? point.source_ids.filter((value: unknown): value is string => typeof value === 'string') : [] })) : undefined
      return { workspaceId, platform, ...(accountId ? { accountId } : {}), ...(typeof raw.remote_id === 'string' && raw.remote_id.trim() ? { remoteId: raw.remote_id.trim() } : {}), ...(typeof raw.local_product_key === 'string' ? { localProductKey: raw.local_product_key } : {}), title, ...(typeof raw.sku_count === 'number' ? { skuCount: raw.sku_count } : skus ? { skuCount: skus.length } : {}), ...(skus ? { skus } : {}), ...(typeof raw.stock === 'number' ? { stock: raw.stock } : {}), ...(typeof raw.price === 'number' ? { price: raw.price } : {}), ...(typeof raw.category === 'string' ? { category: raw.category } : {}), ...(Array.isArray(raw.images) ? { images: raw.images.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean) } : {}), ...(sourceAssetIds ? { sourceAssetIds } : {}), ...(raw.attributes && typeof raw.attributes === 'object' && !Array.isArray(raw.attributes) ? { attributes: Object.fromEntries(Object.entries(raw.attributes).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value as string])) } : {}), ...(sellingPoints ? { sellingPoints } : {}), ...(typeof raw.store_name === 'string' ? { storeName: raw.store_name } : {}), ...(typeof raw.store_differentiation === 'string' ? { storeDifferentiation: raw.store_differentiation } : {}) }
    })
    assertUniqueBatchProductImportIdentities(items)
    const rawHeaderKey = req.headers['idempotency-key']
    const headerKey = Array.isArray(rawHeaderKey) ? rawHeaderKey[0]?.trim() : rawHeaderKey?.trim()
    const bodyKey = typeof input.idempotency_key === 'string' ? input.idempotency_key.trim() : undefined
    if (input.idempotency_key !== undefined && bodyKey === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'idempotency_key 必须是字符串', 400)
    if (headerKey && bodyKey && headerKey !== bodyKey) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'Idempotency-Key 与 body.idempotency_key 不一致', 400)
    const rawKey = headerKey ?? bodyKey
    if (rawKey !== undefined && (!rawKey || rawKey.length < 8 || rawKey.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(rawKey))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'Idempotency-Key 必须为 8 至 200 位字母、数字或 . _ : -', 400)
    const assetIds = new Set(items.flatMap(item => [...(item.sourceAssetIds ?? []), ...(item.skus ?? []).flatMap((sku: any) => sku.sourceAssetIds ?? [])]))
    for (const assetId of assetIds) {
      if (!deps.enforceAssetAccess) throw new DomainError('ASSET_ACCESS_UNAVAILABLE', '商品素材权限校验不可用，批量导入已阻止', 503)
      await deps.enforceAssetAccess(workspaceId, assetId, 'viewer')
    }
    const idempotency = deps.idempotency ?? memoryHttpBatchImportIdempotency
    const normalizedItems = items.map(({ workspaceId: _workspaceId, ...item }) => item)
    const idempotencyInput = rawKey ? { workspaceId, actorId: actor(), key: rawKey, requestHash: hashCatalogBatchImportIntent({ items: normalizedItems }) } : undefined
    const beforeProducts = new Map([...service.products.entries()].filter(([, product]) => product.workspaceId === workspaceId).map(([id, product]) => [id, structuredClone(product)] as const))
    const created: ReturnType<typeof service.importProduct>[] = []
    const writes: BatchProductWrite[] = []
    let idempotencyToken: string | undefined
    if (idempotencyInput) {
      try {
        const claim = await idempotency.claim(idempotencyInput)
        if (claim.kind === 'completed') return send(res, 200, workspaceId, claim.result, null, req)
        if (claim.kind === 'in_progress') throw new DomainError('PRODUCT_IMPORT_IDEMPOTENCY_IN_PROGRESS', '相同幂等请求仍在处理中，请稍后查询或重试', 409)
        if (claim.kind === 'needs_reconciliation') throw new DomainError('PRODUCT_IMPORT_IDEMPOTENCY_RECONCILIATION_REQUIRED', '该幂等请求可能已产生部分写入，需要运营核对后使用新幂等键', 409)
        idempotencyToken = claim.token
      } catch (error) {
        if (error instanceof CatalogBatchImportIdempotencyError) throw new DomainError(error.code, error.message, 409)
        throw error
      }
    }
    let durableSideEffectsStarted = false
    try {
      for (const item of items) {
        const product = service.importProduct(item)
        await scanImportedProductRules(workspaceId, product)
        created.push(product)
        writes.push({ product, version: product.version ?? 0 })
      }
      if (idempotencyInput && idempotencyToken) {
        await idempotency.start({ ...idempotencyInput, token: idempotencyToken })
        durableSideEffectsStarted = true
      }
      const batchId = `catalog_import_batch_${randomUUID()}`
      await persistSnapshotsAndEvent({ workspaceId, snapshots: created.map(product => ({ entityType: 'product' as const, entityId: product.id, entityVersion: product.version ?? 1, payload: product as unknown as Record<string, unknown> })), aggregateId: batchId, eventType: 'catalog.import.batch.completed', sequence: 1, eventPayload: { batch_id: batchId, count: created.length, product_ids: created.map(product => product.id), transport: 'rest' } })
      await recordOperationAudit({ workspaceId, actorId: actor(), action: 'catalog.import.batch', resourceType: 'product_import_batch', resourceId: batchId, before: {}, after: { count: created.length, product_ids: created.map(product => product.id), atomic: false, atomic_scope: 'none_across_workflow', snapshot_outbox_transactional: true, transport: 'rest' }, reason: '批量导入商品并建立持久化快照' })
      const factsConfirmation = batchFactsConfirmation(created)
      const response = { batchId, count: created.length, products: created.map(product => ({ ...product, factsConfirmationRequired: !product.factsConfirmed, facts_confirmation: productFactsConfirmation(product) })), atomic: false, atomic_scope: 'none_across_workflow', snapshot_outbox_transactional: true, factsConfirmationRequired: factsConfirmation.required, facts_confirmation: factsConfirmation, next_actions: factsConfirmation.next_actions }
      if (idempotencyInput && idempotencyToken) await idempotency.complete({ ...idempotencyInput, token: idempotencyToken, result: response })
      return send(res, 201, workspaceId, response, null, req)
    } catch (error) {
      rollbackBatchProducts(service.products, workspaceId, writes, beforeProducts)
      if (idempotencyInput && idempotencyToken) {
        if (durableSideEffectsStarted) await idempotency.markNeedsReconciliation({ ...idempotencyInput, token: idempotencyToken })
        else await idempotency.releaseBeforeSideEffects({ ...idempotencyInput, token: idempotencyToken })
      }
      throw error
    }
  }
  if (req.method === 'POST' && path === '/v1/products/import') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const rawSkus = Array.isArray(input.skus) ? input.skus : undefined
    const skus = rawSkus?.map((item: any) => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.price !== 'number' || typeof item.stock !== 'number') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'skus 必须包含 id、name、price、stock', 400)
      return { id: item.id.trim(), name: item.name.trim(), price: item.price, stock: item.stock, ...(Array.isArray(item.images) ? { images: item.images.filter((value: unknown): value is string => typeof value === 'string') } : {}) }
    })
    const rawSellingPoints = Array.isArray(input.selling_points) ? input.selling_points : undefined
    const sellingPoints = rawSellingPoints?.map((item: any, index: number) => ({ id: typeof item.id === 'string' ? item.id : `sp_${index + 1}`, text: typeof item.text === 'string' ? item.text : '', proofStatus: item.proof_status === 'confirmed' || item.proof_status === 'rejected' ? item.proof_status : 'pending', sourceIds: Array.isArray(item.source_ids) ? item.source_ids.filter((value: unknown): value is string => typeof value === 'string') : [] }))
    const rawAssetIds = input.asset_ids
    const sourceAssetIds = rawAssetIds === undefined ? undefined : Array.isArray(rawAssetIds) && rawAssetIds.length > 0 && rawAssetIds.length <= 50 && rawAssetIds.every(value => typeof value === 'string' && value.trim()) ? [...new Set(rawAssetIds.map(value => String(value).trim()))] : null
    if (sourceAssetIds === null || (sourceAssetIds && Array.isArray(rawAssetIds) && sourceAssetIds.length !== rawAssetIds.length)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'asset_ids 必须是最多 50 个不重复素材 ID 的数组', 400)
    const platform = required(input, 'platform') as Platform
    const accountId = typeof input.account_id === 'string' && input.account_id.trim() ? input.account_id.trim() : undefined
    if (!supportedPlatforms.includes(platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
    if (isProduction() && !accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产商品导入必须绑定已授权平台账号', 400)
    if (accountId) service.getActionablePlatformAccount(workspaceId, accountId, platform)
    const product = service.importProduct({ workspaceId, platform, ...(accountId ? { accountId } : {}), ...(typeof input.remote_id === 'string' && input.remote_id.trim() ? { remoteId: input.remote_id } : {}), ...(typeof input.local_product_key === 'string' ? { localProductKey: input.local_product_key } : {}), title: required(input, 'title'), skuCount: typeof input.sku_count === 'number' ? input.sku_count : undefined, ...(skus ? { skus } : {}), stock: typeof input.stock === 'number' ? input.stock : undefined, price: typeof input.price === 'number' ? input.price : undefined, category: typeof input.category === 'string' ? input.category : undefined, images: Array.isArray(input.images) ? input.images.filter((item): item is string => typeof item === 'string') : undefined, ...(sourceAssetIds ? { sourceAssetIds } : {}), attributes: input.attributes && typeof input.attributes === 'object' && !Array.isArray(input.attributes) ? Object.fromEntries(Object.entries(input.attributes).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value as string])) : undefined, ...(sellingPoints ? { sellingPoints } : {}), storeName: typeof input.store_name === 'string' ? input.store_name : undefined, storeDifferentiation: typeof input.store_differentiation === 'string' ? input.store_differentiation : undefined })
    await scanImportedProductRules(workspaceId, product)
    await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
    return send(res, 201, workspaceId, product, null, req)
  }
  const productConfirmMatch = path.match(/^\/v1\/products\/([^/]+)\/confirm$/)
  if (req.method === 'POST' && productConfirmMatch) {
    const workspaceId = resolveWorkspace(req)
    const productId = decodeURIComponent(productConfirmMatch[1]!)
    await enforceProductBrandAccess(workspaceId, productId)
    const { product, resumedTasks } = await confirmProductFactsTransition({ workspaceId, productId, source: 'rest' })
    return send(res, 200, workspaceId, { ...product, product_id: product.id, factsConfirmationRequired: false, humanConfirmed: true, facts_confirmation: productFactsConfirmation(product), resumed_task_ids: resumedTasks.map(task => task.id) }, null, req)
  }
  return false
}
