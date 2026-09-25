import { DomainError, type MerchantService, type Platform, type Product } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { projectImportedProductsToKnowledge } from '../../../packages/application/src/knowledge-import.js'
import type { ApiPersistence } from './server.js'

type Params = Record<string, unknown>
export interface CatalogImportDependencies {
  service: Pick<MerchantService, 'getActionablePlatformAccount' | 'importProduct'>
  supportedPlatforms: readonly Platform[]
  isProduction(): boolean
  brandUnits: NonNullable<ApiPersistence['brandUnits']>
  knowledgeRepository: NonNullable<ApiPersistence['knowledge']>
  required(params: Params, key: string): string
  enforceBrandAccess(workspaceId: string, brandId: string, role: 'editor'): Promise<unknown>
  scanImportedProductRules(workspaceId: string, product: Product): Promise<unknown>
  persistSnapshot(workspaceId: string, entityType: 'product', entity: Product, value: Record<string, unknown>): Promise<unknown>
}

export async function handleCatalogImport(workspaceId: string, params: Params, deps: CatalogImportDependencies) {
  const { service, supportedPlatforms, isProduction, brandUnits, knowledgeRepository, required, enforceBrandAccess, scanImportedProductRules, persistSnapshot } = deps

      const platform = required(params, 'platform') as Platform
      const draftOnly = params.draft_only === 'true'
      const numeric = (key: string) => typeof params[key] === 'string' && params[key]!.trim() ? Number(params[key]) : undefined
      const images = typeof params.images === 'string' && params.images.trim() ? params.images.split(',').map(item => item.trim()).filter(Boolean) : undefined
      let sourceAssetIds: string[] | undefined
      if (typeof params.asset_ids_json === 'string' && params.asset_ids_json.trim()) {
        try {
          const parsed = JSON.parse(params.asset_ids_json)
          if (!Array.isArray(parsed) || parsed.length > 50 || parsed.some(value => typeof value !== 'string' || !value.trim())) throw new Error('asset_ids_json')
          sourceAssetIds = [...new Set(parsed.map(value => value.trim()))]
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'asset_ids_json 必须是最多 50 个素材 ID 的字符串数组 JSON', 400) }
      }
      let skus: import('../../../packages/application/src/service.js').ProductSku[] | undefined
      if (typeof params.skus_json === 'string' && params.skus_json.trim()) {
        try {
          const parsed = JSON.parse(params.skus_json)
          if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.price !== 'number' || typeof item.stock !== 'number')) throw new Error('skus_json')
          skus = parsed.map((item: Record<string, any>) => ({ id: item.id.trim(), name: item.name.trim(), price: item.price, stock: item.stock, ...(Array.isArray(item.images) ? { images: item.images.filter((value: unknown): value is string => typeof value === 'string') } : {}), ...(item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes) ? { attributes: Object.fromEntries(Object.entries(item.attributes).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value as string])) } : {}) }))
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'skus_json 必须是包含 id、name、price、stock 的 SKU 数组', 400) }
      }
      let attributes: Record<string, string> | undefined
      if (typeof params.attributes_json === 'string' && params.attributes_json.trim()) {
        try {
          const parsed = JSON.parse(params.attributes_json)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('attributes_json must be an object')
          attributes = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value as string]))
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'attributes_json 必须是 JSON 对象', 400) }
      }
      let sellingPoints: import('../../../packages/application/src/service.js').ProductSellingPoint[] | undefined
      if (typeof params.selling_points_json === 'string' && params.selling_points_json.trim()) {
        try {
          const parsed = JSON.parse(params.selling_points_json)
          if (!Array.isArray(parsed)) throw new Error('selling_points_json')
          sellingPoints = parsed.map((item: any, index: number) => ({ id: typeof item.id === 'string' ? item.id : `sp_${index + 1}`, text: typeof item.text === 'string' ? item.text : '', proofStatus: item.proof_status === 'confirmed' || item.proof_status === 'rejected' ? item.proof_status : 'pending', sourceIds: Array.isArray(item.source_ids) ? item.source_ids.filter((value: unknown): value is string => typeof value === 'string') : [] }))
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'selling_points_json 必须是卖点对象数组', 400) }
      }
      const price = numeric('price'); const skuCount = numeric('sku_count'); const stock = numeric('stock')
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      const brandId = typeof params.brand_id === 'string' && params.brand_id.trim() ? params.brand_id.trim() : undefined
      if (!supportedPlatforms.includes(platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
      if (isProduction() && !accountId && !draftOnly) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产商品导入必须绑定已授权平台账号；如仅需做内容草稿，请显式传 draft_only=true', 400)
      if (accountId) service.getActionablePlatformAccount(workspaceId, accountId, platform)
      if (brandId) {
        if (!accountId) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '绑定品牌导入商品必须同时指定已授权店铺', 400)
        await enforceBrandAccess(workspaceId, brandId, 'editor')
        const bindings = await brandUnits.listBrands({ workspaceId, brandId, platform, accountId })
        if (!bindings.length) throw new DomainError('BRAND_STORE_BINDING_REQUIRED', '导入商品前必须先将店铺绑定到指定品', 409, { brand_id: brandId, platform, account_id: accountId, next_actions: ['brand-unit.bind-store'] })
      }
      const product = service.importProduct({
        workspaceId, platform, ...(brandId ? { brandId } : {}), ...(accountId ? { accountId } : {}),
        ...(typeof params.remote_id === 'string' && params.remote_id.trim() ? { remoteId: params.remote_id } : {}),
        ...(typeof params.local_product_key === 'string' ? { localProductKey: params.local_product_key } : {}),
        title: required(params, 'title'),
        ...(skus ? { skus } : {}),
        ...(typeof price === 'number' && Number.isFinite(price) ? { price } : {}),
        ...(typeof skuCount === 'number' && Number.isFinite(skuCount) ? { skuCount } : {}),
        ...(typeof stock === 'number' && Number.isFinite(stock) ? { stock } : {}),
        ...(typeof params.category === 'string' && params.category.trim() ? { category: params.category } : {}),
        ...(images ? { images } : {}), ...(sourceAssetIds ? { sourceAssetIds } : {}), ...(attributes ? { attributes } : {}), ...(sellingPoints ? { sellingPoints } : {}),
        ...(typeof params.store_name === 'string' ? { storeName: params.store_name } : {}),
        ...(typeof params.store_differentiation === 'string' ? { storeDifferentiation: params.store_differentiation } : {}),
      })
      await scanImportedProductRules(workspaceId, product)
      await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
      const knowledgeProjection = draftOnly
        ? await projectImportedProductsToKnowledge({ repository: knowledgeRepository, workspaceId, products: [product], ...(sourceAssetIds?.[0] ? { sourceAssetId: sourceAssetIds[0] } : {}), sourceMetadata: { source: 'catalog.import.draft', importMode: 'manual' } })
        : undefined
      return ({ ...product, product_id: product.id, rule_scan: product.ruleScan, ...(draftOnly ? { draft_only: true, candidate_status: '未绑定商品、仅草稿、不可发布', publishable: false, knowledge: { assetCount: knowledgeProjection?.assets.length ?? 0, documentCount: knowledgeProjection?.documents.length ?? 0, chunkCount: knowledgeProjection?.chunks.length ?? 0, bindingCount: knowledgeProjection?.bindings.length ?? 0, approvalStatus: 'pending', rightsStatus: 'unknown', indexState: 'queued' } } : {}) })
    }
