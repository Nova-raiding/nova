import { randomUUID } from 'node:crypto'
import { DomainError, type MerchantService, type Platform, type Product } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { spreadsheetFactsToBatchProducts, SpreadsheetBatchImportError } from '../../../packages/application/src/spreadsheet-batch.js'
import { projectImportedProductsToKnowledge } from '../../../packages/application/src/knowledge-import.js'
import { assertUniqueBatchProductImportIdentities } from './product-import-identity.js'
import { batchFactsConfirmation, productFactsConfirmation } from './brand-product-helpers.js'
import type { ApiPersistence } from './server.js'

type Params = Record<string, unknown>
type ProductAsset = MerchantService['assets'] extends Map<string, infer Asset> ? Asset : never
type BatchProductWrite = { product: Product; version: number }
type Snapshot = { entityType: 'product'; entityId: string; entityVersion: number; payload: Record<string, unknown> }
export interface CatalogBatchImportDependencies {
  service: Pick<MerchantService, 'products' | 'importProduct' | 'getActionablePlatformAccount'>
  supportedPlatforms: readonly Platform[]
  isProduction(): boolean
  knowledgeRepository: NonNullable<ApiPersistence['knowledge']>
  required(params: Params, key: string): string
  enforceAssetAccess(workspaceId: string, assetId: string, role: 'editor' | 'viewer'): Promise<unknown>
  assetForWorkspace(workspaceId: string, assetId: string): ProductAsset
  scanImportedProductRules(workspaceId: string, product: Product): Promise<unknown>
  persistSnapshotsAndEvent(input: { workspaceId: string; snapshots: Snapshot[]; aggregateId: string; eventType: string; sequence: number; eventPayload: Record<string, unknown> }): Promise<unknown>
  recordOperationAudit(input: { workspaceId: string; actorId: string; action: string; resourceType: string; resourceId: string; before: Record<string, unknown>; after: Record<string, unknown>; reason: string }): Promise<unknown>
  rollbackBatchProducts: typeof import('./server.js').rollbackBatchProducts
  actor(): string
}

export async function handleCatalogBatchImport(workspaceId: string, params: Params, deps: CatalogBatchImportDependencies) {
  const { service, supportedPlatforms, isProduction, knowledgeRepository, required, enforceAssetAccess, assetForWorkspace, scanImportedProductRules, persistSnapshotsAndEvent, recordOperationAudit, rollbackBatchProducts, actor } = deps

      const draftOnly = params.draft_only === 'true'
      let rawItems: unknown
      try {
        if (typeof params.products_json === 'string' && params.products_json.trim()) rawItems = JSON.parse(params.products_json)
        else {
          const assetId = required(params, 'source_asset_id')
          await enforceAssetAccess(workspaceId, assetId, 'editor')
          const asset = assetForWorkspace(workspaceId, assetId)
          if (asset.parseStatus !== 'succeeded' || !asset.extractedFacts) throw new DomainError('PRODUCT_IMPORT_SOURCE_NOT_PARSED', '商品表格尚未解析成功，请先完成表格解析', 409, { asset_id: asset.id, next_action: 'asset.parse' })
          if (!asset.factsConfirmedBy || !asset.factsConfirmedAt) throw new DomainError('PRODUCT_IMPORT_SOURCE_FACTS_UNCONFIRMED', '商品表格事实尚未由商家确认，不能批量导入', 409, { asset_id: asset.id, next_action: 'asset.facts.confirm' })
          rawItems = spreadsheetFactsToBatchProducts(asset.extractedFacts)
        }
      } catch (error) {
        if (error instanceof DomainError) throw error
        if (error instanceof SpreadsheetBatchImportError) throw new DomainError('PRODUCT_IMPORT_SPREADSHEET_INVALID', error.message, 400, { row: error.row })
        throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'products_json 必须是商品对象数组 JSON，或提供已确认的 source_asset_id', 400)
      }
      if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 50 || rawItems.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
        throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'products_json 必须是 1 至 50 个商品对象的 JSON 数组', 400)
      }
      type BatchImportItem = { platform: Platform; accountId?: string; remoteId?: string; localProductKey?: string; title: string; skuCount?: number; skus?: import('../../../packages/application/src/service.js').ProductSku[]; stock?: number; price?: number; category?: string; images?: string[]; sourceAssetIds?: string[]; attributes?: Record<string, string>; sellingPoints?: import('../../../packages/application/src/service.js').ProductSellingPoint[]; storeName?: string; storeDifferentiation?: string }
      const numeric = (value: unknown, field: string, index: number) => {
        if (value === undefined || value === null || value === '') return undefined
        const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
        if (!Number.isFinite(parsed) || parsed < 0) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 ${field} 必须是非负数字`, 400)
        return parsed
      }
      const items: BatchImportItem[] = rawItems.map((raw, index) => {
        const item = raw as Record<string, unknown>
        const platform = typeof item.platform === 'string' ? item.platform as Platform : '' as Platform
        if (!supportedPlatforms.includes(platform)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 platform 无效`, 400)
        const accountId = typeof item.account_id === 'string' && item.account_id.trim() ? item.account_id.trim() : undefined
        if (isProduction() && !accountId && !draftOnly) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', `第 ${index + 1} 项生产导入必须绑定已授权平台账号；如仅需建立待审核知识草稿，请显式传 draft_only=true`, 400)
        if (accountId) service.getActionablePlatformAccount(workspaceId, accountId, platform)
        const title = typeof item.title === 'string' ? item.title.trim() : ''
        if (!title) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 title 不能为空`, 400)
        const images = Array.isArray(item.images) ? item.images.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(value => value.trim()) : typeof item.images === 'string' ? item.images.split(',').map(value => value.trim()).filter(Boolean) : undefined
        const sourceAssetIds = Array.isArray(item.asset_ids) ? item.asset_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(value => value.trim()) : undefined
        if (sourceAssetIds && (sourceAssetIds.length > 50 || new Set(sourceAssetIds).size !== sourceAssetIds.length)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 asset_ids 必须是最多 50 个不重复素材 ID`, 400)
        let skus: import('../../../packages/application/src/service.js').ProductSku[] | undefined
        if (item.skus !== undefined) {
          if (!Array.isArray(item.skus)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 skus 必须是数组`, 400)
          skus = item.skus.map((value, skuIndex) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 SKU ${skuIndex + 1} 格式无效`, 400)
            const sku = value as Record<string, unknown>
            if (typeof sku.id !== 'string' || typeof sku.name !== 'string') throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 SKU ${skuIndex + 1} 缺少 id/name`, 400)
            const price = numeric(sku.price, 'SKU price', index); const stock = numeric(sku.stock, 'SKU stock', index)
            if (price === undefined || stock === undefined || !Number.isInteger(stock)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 SKU ${skuIndex + 1} 的 price/stock 无效`, 400)
            const attributes = sku.attributes && typeof sku.attributes === 'object' && !Array.isArray(sku.attributes) ? Object.fromEntries(Object.entries(sku.attributes).filter(([, candidate]) => typeof candidate === 'string').map(([key, candidate]) => [key, candidate as string])) : undefined
            const skuAssetIds = sku.sourceAssetIds
            if (skuAssetIds !== undefined && (!Array.isArray(skuAssetIds) || skuAssetIds.length > 50 || skuAssetIds.some(value => typeof value !== 'string' || !value.trim()) || new Set(skuAssetIds).size !== skuAssetIds.length)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项 SKU ${skuIndex + 1} 原图素材必须是最多 50 个不重复素材 ID`, 400)
            return { ...(Array.isArray(skuAssetIds) ? { sourceAssetIds: skuAssetIds.map(value => (value as string).trim()) } : {}), id: sku.id.trim(), name: sku.name.trim(), price, stock, ...(Array.isArray(sku.images) ? { images: sku.images.filter((value): value is string => typeof value === 'string') } : {}), ...(attributes ? { attributes } : {}) }
          })
        }
        const attributes = item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes) ? Object.fromEntries(Object.entries(item.attributes).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value as string])) : undefined
        const sellingPoints = Array.isArray(item.selling_points) ? item.selling_points.map((value, pointIndex) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('PRODUCT_IMPORT_BATCH_INVALID', `第 ${index + 1} 项卖点 ${pointIndex + 1} 格式无效`, 400)
          const point = value as Record<string, unknown>
          return { id: typeof point.id === 'string' ? point.id : `sp_${pointIndex + 1}`, text: typeof point.text === 'string' ? point.text : '', proofStatus: (point.proof_status === 'confirmed' || point.proof_status === 'rejected' ? point.proof_status : 'pending') as 'pending' | 'confirmed' | 'rejected', sourceIds: Array.isArray(point.source_ids) ? point.source_ids.filter((source): source is string => typeof source === 'string') : [] }
        }) : undefined
        return { platform, ...(accountId ? { accountId } : {}), ...(typeof item.remote_id === 'string' && item.remote_id.trim() ? { remoteId: item.remote_id.trim() } : {}), ...(typeof item.local_product_key === 'string' ? { localProductKey: item.local_product_key } : {}), title, ...(typeof item.category === 'string' ? { category: item.category } : {}), ...(typeof item.store_name === 'string' ? { storeName: item.store_name } : {}), ...(typeof item.store_differentiation === 'string' ? { storeDifferentiation: item.store_differentiation } : {}), ...(images ? { images } : {}), ...(sourceAssetIds ? { sourceAssetIds } : {}), ...(attributes ? { attributes } : {}), ...(sellingPoints ? { sellingPoints } : {}), ...(skus ? { skus, skuCount: skus.length } : {}), ...(numeric(item.price, 'price', index) !== undefined ? { price: numeric(item.price, 'price', index) } : {}), ...(numeric(item.stock, 'stock', index) !== undefined ? { stock: numeric(item.stock, 'stock', index) } : {}), ...(numeric(item.sku_count, 'sku_count', index) !== undefined ? { skuCount: numeric(item.sku_count, 'sku_count', index) } : {}) }
      })
      assertUniqueBatchProductImportIdentities(items)
      for (const assetId of new Set(items.flatMap(item => [...(item.sourceAssetIds ?? []), ...(item.skus ?? []).flatMap(sku => sku.sourceAssetIds ?? [])]))) await enforceAssetAccess(workspaceId, assetId, 'viewer')
      const created: ReturnType<typeof service.importProduct>[] = []
      const writes: BatchProductWrite[] = []
      const importedKnowledge = knowledgeRepository
      const beforeProducts = new Map([...service.products.entries()]
        .filter(([, product]) => product.workspaceId === workspaceId)
        .map(([id, product]) => [id, structuredClone(product)] as const))
      try {
        for (const item of items) {
          const product = service.importProduct({ workspaceId, ...item })
          await scanImportedProductRules(workspaceId, product)
          created.push(product)
          writes.push({ product, version: product.version ?? 0 })
        }
        const knowledgeProjection = await projectImportedProductsToKnowledge({ repository: importedKnowledge, workspaceId, products: created, ...(typeof params.source_asset_id === 'string' && params.source_asset_id.trim() ? { sourceAssetId: params.source_asset_id.trim() } : {}), sourceMetadata: { importMode: typeof params.products_json === 'string' ? 'products_json' : 'spreadsheet' } })
        const batchId = `catalog_import_batch_${randomUUID()}`
        await persistSnapshotsAndEvent({ workspaceId, snapshots: created.map(product => ({ entityType: 'product' as const, entityId: product.id, entityVersion: product.version ?? 1, payload: product as unknown as Record<string, unknown> })), aggregateId: batchId, eventType: 'catalog.import.batch.completed', sequence: 1, eventPayload: { batch_id: batchId, count: created.length, product_ids: created.map(product => product.id) } })
        await recordOperationAudit({ workspaceId, actorId: actor(), action: 'catalog.import.batch', resourceType: 'product_import_batch', resourceId: batchId, before: {}, after: { count: created.length, product_ids: created.map(product => product.id), atomic: true }, reason: '批量导入商品并建立持久化快照' })
        const factsConfirmation = batchFactsConfirmation(created)
        return ({ batchId, count: created.length, products: created.map(product => ({ ...product, product_id: product.id, rule_scan: product.ruleScan, factsConfirmationRequired: !product.factsConfirmed, facts_confirmation: productFactsConfirmation(product), ...(draftOnly ? { draft_only: true, candidate_status: '未绑定商品、仅草稿、不可发布', publishable: false } : {}) })), atomic: true, factsConfirmationRequired: factsConfirmation.required, facts_confirmation: factsConfirmation, next_actions: factsConfirmation.next_actions, ...(draftOnly ? { draft_only: true } : {}), knowledge: { assetCount: knowledgeProjection.assets.length, documentCount: knowledgeProjection.documents.length, chunkCount: knowledgeProjection.chunks.length, bindingCount: knowledgeProjection.bindings.length, indexState: 'queued', approvalStatus: 'pending', nextAction: 'knowledge.asset.update' } })
      } catch (error) {
        rollbackBatchProducts(service.products, workspaceId, writes, beforeProducts)
        throw error
      }
    }
