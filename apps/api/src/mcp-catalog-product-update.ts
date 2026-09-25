import { DomainError, type MerchantService, type Product } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { CanonicalProductReadMode } from '../../../packages/application/src/canonical-product-consistency.js'
import type { ApiPersistence } from './server.js'

type Params = Record<string, unknown>
export interface CatalogProductUpdateDependencies {
  service: Pick<MerchantService, 'products' | 'updateProductSku' | 'updateProductFacts'>
  brandUnits: NonNullable<ApiPersistence['brandUnits']>
  persistenceReady: Promise<unknown>
  required(params: Params, key: string): string
  canonicalProductReadControl(workspaceId: string): Promise<{ mode: CanonicalProductReadMode }>
  enforceProductBrandAccess(workspaceId: string, productId: string): Promise<unknown>
  persistSnapshot(workspaceId: string, entityType: 'product', entity: Product, value: Record<string, unknown>): Promise<unknown>
  persistEvent(workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>): Promise<unknown>
}

export async function handleCatalogProductUpdate(method: 'catalog.sku.update' | 'catalog.product.update', workspaceId: string, params: Params, deps: CatalogProductUpdateDependencies) {
  const { service, brandUnits, persistenceReady, required, canonicalProductReadControl, enforceProductBrandAccess, persistSnapshot, persistEvent } = deps
  if (method === 'catalog.sku.update') {

      const productId = required(params, 'product_id')
      const skuId = required(params, 'sku_id')
      const readControl = await canonicalProductReadControl(workspaceId)
      const canonicalRepository = brandUnits
      let canonicalBefore: Awaited<ReturnType<typeof canonicalRepository.getCanonicalProduct>>
      if (readControl.mode === 'canonical_read') {
        await persistenceReady
        const candidates = await canonicalRepository.listCanonicalProducts({ workspaceId, sourceProductIds: [productId] })
        if (candidates.length > 1) throw new DomainError('CANONICAL_PRODUCT_AMBIGUOUS', '一个商品对应多个规范商品，已阻止 SKU 事实修改，请先完成映射治理', 409, { product_id: productId, canonical_product_ids: candidates.map(row => row.id), next_action: 'canonical.product.consistency' })
        canonicalBefore = candidates[0]
        if (!canonicalBefore) throw new DomainError('CANONICAL_PRODUCT_MAPPING_REQUIRED', '标准商品映射未完成，已阻止只写 legacy 的 SKU 修改', 409, { product_id: productId, next_action: 'canonical.product.consistency' })
      }
      await enforceProductBrandAccess(workspaceId, productId)
      const parseJsonObject = (key: string) => {
        if (typeof params[key] !== 'string') return undefined
        try { const parsed = JSON.parse(params[key] as string); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error(key); return parsed as Record<string, string> } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是字符串到字符串的 JSON 对象`, 400) }
      }
      const parseImages = () => {
        if (typeof params.images_json !== 'string') return undefined
        try { const parsed = JSON.parse(params.images_json); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error('images_json'); return parsed as string[] } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'images_json 必须是图片引用字符串数组 JSON', 400) }
      }
      const priceProvided = typeof params.price === 'string' && params.price.trim().length > 0
      const stockProvided = typeof params.stock === 'string' && params.stock.trim().length > 0
      const price = priceProvided ? Number(params.price) : undefined
      const stock = stockProvided ? Number(params.stock) : undefined
      if ((priceProvided && !Number.isFinite(price)) || (stockProvided && !Number.isFinite(stock))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'price 和 stock 必须是有效数字', 400)
      const images = parseImages()
      const attributes = parseJsonObject('attributes_json')
      if (!priceProvided && !stockProvided && typeof params.name !== 'string' && images === undefined && attributes === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '至少提供一个 SKU 修改字段', 400)
      const expectedVersion = typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined
      if (params.expected_version !== undefined && expectedVersion === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_version 必须是非负整数', 400)
      const product = service.updateProductSku({ workspaceId, productId, skuId, ...(typeof params.name === 'string' ? { name: params.name } : {}), ...(priceProvided ? { price } : {}), ...(stockProvided ? { stock } : {}), ...(images !== undefined ? { images } : {}), ...(attributes !== undefined ? { attributes } : {}), ...(expectedVersion !== undefined ? { expectedVersion } : {}) })
      let canonicalScope: Record<string, unknown> | undefined
      if (readControl.mode === 'canonical_read' && canonicalBefore) {
        const facts: Record<string, unknown> = {
          ...(product.category ? { category: product.category } : {}),
          ...(product.attributes ? { attributes: structuredClone(product.attributes) } : {}),
          ...(typeof product.price === 'number' ? { price: product.price } : {}),
          sku_ids: (product.skus ?? []).map(sku => sku.id),
          selling_points: (product.sellingPoints ?? []).filter(point => point.proofStatus === 'confirmed').map(point => point.text),
        }
        try {
          const updated = await canonicalRepository.updateCanonicalProductFacts({ workspaceId, id: canonicalBefore.id, facts, expectedFactsVersion: canonicalBefore.factsVersion })
          await persistEvent(workspaceId, updated.id, 'canonical_product.facts_updated', updated.factsVersion, { product_id: product.id, canonical_product_id: updated.id, facts_version: updated.factsVersion, source: 'legacy_sku_update', sku_id: skuId })
          canonicalScope = { canonical_product_id: updated.id, brand_id: updated.brandId, facts_version: updated.factsVersion, facts_synced: true }
        } catch (error) {
          if (error instanceof Error && error.message === 'CANONICAL_PRODUCT_REVISION_CONFLICT') throw new DomainError('CANONICAL_PRODUCT_REVISION_CONFLICT', '标准商品事实已被其他操作更新，请刷新后重试', 409)
          if (error instanceof Error && error.message === 'CANONICAL_PRODUCT_NOT_FOUND') throw new DomainError('CANONICAL_PRODUCT_NOT_FOUND', '标准商品不存在或不属于当前工作区', 404)
          throw error
        }
      }
      await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, product.id, 'product.sku_updated', product.version ?? 1, { product_id: product.id, sku_id: skuId, version: product.version ?? 1, facts_confirmed: false })
      return ({ ...product, product_id: product.id, sku_id: skuId, factsConfirmationRequired: true, ...(canonicalScope ? { canonical_scope: canonicalScope } : {}) })
      }

      const productId = required(params, 'product_id')
      const readControl = await canonicalProductReadControl(workspaceId)
      const canonicalRepository = brandUnits
      let canonicalBefore: Awaited<ReturnType<typeof canonicalRepository.getCanonicalProduct>>
      if (readControl.mode === 'canonical_read') {
        await persistenceReady
        const candidates = await canonicalRepository.listCanonicalProducts({ workspaceId, sourceProductIds: [productId] })
        if (candidates.length > 1) throw new DomainError('CANONICAL_PRODUCT_AMBIGUOUS', '一个商品对应多个规范商品，已阻止事实修改，请先完成映射治理', 409, { product_id: productId, canonical_product_ids: candidates.map(row => row.id), next_action: 'canonical.product.consistency' })
        canonicalBefore = candidates[0]
        if (!canonicalBefore) throw new DomainError('CANONICAL_PRODUCT_MAPPING_REQUIRED', '标准商品映射未完成，已阻止只写 legacy 的事实修改', 409, { product_id: productId, next_action: 'canonical.product.consistency' })
      }
      const productBefore = service.products.get(productId)
      if (!productBefore || productBefore.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
      await enforceProductBrandAccess(workspaceId, productId)
      const parseJsonObject = (key: string) => {
        if (typeof params[key] !== 'string') return undefined
        try { const parsed = JSON.parse(params[key] as string); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error(key); return parsed as Record<string, string> } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是字符串到字符串的 JSON 对象`, 400) }
      }
      const parseImages = () => {
        if (typeof params.images_json !== 'string') return undefined
        try { const parsed = JSON.parse(params.images_json); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error('images_json'); return parsed as string[] } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'images_json 必须是图片引用字符串数组 JSON', 400) }
      }
      const parseSellingPoints = () => {
        if (typeof params.selling_points_json !== 'string') return undefined
        try {
          const parsed = JSON.parse(params.selling_points_json)
          if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== 'object' || typeof item.text !== 'string')) throw new Error('selling_points_json')
          return parsed.map((item: Record<string, unknown>, index: number) => ({ id: typeof item.id === 'string' ? item.id : `sp_${index + 1}`, text: (item.text as string).trim(), proofStatus: (item.proof_status === 'confirmed' || item.proof_status === 'rejected' ? item.proof_status : 'pending') as import('../../../packages/application/src/service.js').SellingPointProofStatus, sourceIds: Array.isArray(item.source_ids) ? item.source_ids.filter((value): value is string => typeof value === 'string') : [] }))
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'selling_points_json 必须是卖点对象数组', 400) }
      }
      const images = parseImages(); const attributes = parseJsonObject('attributes_json'); const sellingPoints = parseSellingPoints()
      const priceProvided = typeof params.price === 'string' && params.price.trim().length > 0
      const price = priceProvided ? Number(params.price) : undefined
      if (priceProvided && (!Number.isFinite(price) || price! < 0)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'price 必须是有效的非负数字', 400)
      const expectedVersion = typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined
      if (params.expected_version !== undefined && expectedVersion === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_version 必须是非负整数', 400)
      if (typeof params.title !== 'string' && typeof params.category !== 'string' && images === undefined && attributes === undefined && sellingPoints === undefined && typeof params.store_differentiation !== 'string' && !priceProvided) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '至少提供一个商品事实修改字段', 400)
      const product = service.updateProductFacts({ workspaceId, productId, ...(typeof params.title === 'string' ? { title: params.title } : {}), ...(typeof params.category === 'string' ? { category: params.category } : {}), ...(images !== undefined ? { images } : {}), ...(attributes !== undefined ? { attributes } : {}), ...(sellingPoints !== undefined ? { sellingPoints } : {}), ...(typeof params.store_differentiation === 'string' ? { storeDifferentiation: params.store_differentiation } : {}), ...(priceProvided ? { price } : {}), ...(expectedVersion !== undefined ? { expectedVersion } : {}) })
      let canonicalScope: Record<string, unknown> | undefined
      if (readControl.mode === 'canonical_read' && canonicalBefore) {
        const facts: Record<string, unknown> = {
          ...(product.category ? { category: product.category } : {}),
          ...(product.attributes ? { attributes: structuredClone(product.attributes) } : {}),
          ...(typeof product.price === 'number' ? { price: product.price } : {}),
          sku_ids: (product.skus ?? []).map(sku => sku.id),
          selling_points: (product.sellingPoints ?? []).filter(point => point.proofStatus === 'confirmed').map(point => point.text),
        }
        try {
          const updatedFacts = await canonicalRepository.updateCanonicalProductFacts({ workspaceId, id: canonicalBefore.id, facts, expectedFactsVersion: canonicalBefore.factsVersion })
          let updated = updatedFacts
          if (typeof params.title === 'string' && params.title.trim() && params.title.trim() !== canonicalBefore.title) updated = await canonicalRepository.updateCanonicalProductTitle({ workspaceId, id: canonicalBefore.id, title: params.title, expectedFactsVersion: updatedFacts.factsVersion })
          await persistEvent(workspaceId, updated.id, 'canonical_product.facts_updated', updated.factsVersion, { product_id: product.id, canonical_product_id: updated.id, facts_version: updated.factsVersion, source: 'legacy_product_update' })
          canonicalScope = { canonical_product_id: updated.id, brand_id: updated.brandId, facts_version: updated.factsVersion, facts_synced: true }
        } catch (error) {
          if (error instanceof Error && error.message === 'CANONICAL_PRODUCT_REVISION_CONFLICT') throw new DomainError('CANONICAL_PRODUCT_REVISION_CONFLICT', '标准商品事实已被其他操作更新，请刷新后重试', 409)
          if (error instanceof Error && error.message === 'CANONICAL_PRODUCT_NOT_FOUND') throw new DomainError('CANONICAL_PRODUCT_NOT_FOUND', '标准商品不存在或不属于当前工作区', 404)
          throw error
        }
      }
      await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, product.id, 'product.facts_updated', product.version ?? 1, { product_id: product.id, version: product.version ?? 1, facts_confirmed: false })
      return ({ ...product, product_id: product.id, factsConfirmationRequired: true, ...(canonicalScope ? { canonical_scope: canonicalScope } : {}) })
    }
