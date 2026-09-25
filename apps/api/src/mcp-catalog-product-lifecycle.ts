import { DomainError, type MerchantService, type Product } from '../../../packages/application/src/service.js'
import { productFactsConfirmation } from './brand-product-helpers.js'
import type { ApiPersistence } from './server.js'

type Params = Record<string, unknown>

export interface CatalogProductLifecycleDependencies {
  service: Pick<MerchantService, 'disableProduct' | 'enableProduct'>
  brandUnits: NonNullable<ApiPersistence['brandUnits']>
  persistenceReady: Promise<unknown>
  required(params: Params, key: string): string
  confirmProductFactsTransition(input: { workspaceId: string; productId: string; source: 'mcp' | 'rest' }): ReturnType<typeof import('./brand-product-helpers.js').confirmProductFactsTransition>
  canonicalProductReadControl(workspaceId: string): Promise<{ mode: string }>
  persistSnapshot(workspaceId: string, entityType: 'product', entity: Product, value: Record<string, unknown>): Promise<unknown>
  persistEvent(workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>): Promise<unknown>
}

export async function handleCatalogProductLifecycle(method: 'catalog.facts.confirm' | 'catalog.product.disable' | 'catalog.product.enable', workspaceId: string, params: Params, deps: CatalogProductLifecycleDependencies) {
  const { service, brandUnits, persistenceReady, required, confirmProductFactsTransition, canonicalProductReadControl, persistSnapshot, persistEvent } = deps
  if (method === 'catalog.product.disable') {
    const productId = required(params, 'product_id')
    const product = service.disableProduct({ workspaceId, productId, reason: required(params, 'reason') })
    await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, product.id, 'product.disabled', product.version ?? 1, { product_id: product.id, reason: product.disabledReason })
    return product
  }
  if (method === 'catalog.product.enable') {
    const product = service.enableProduct(workspaceId, required(params, 'product_id'))
    await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
    await persistEvent(workspaceId, product.id, 'product.enabled', product.version ?? 1, { product_id: product.id })
    return product
  }
  const productId = required(params, 'product_id')
  const transition = await confirmProductFactsTransition({ workspaceId, productId, source: 'mcp' })
  const { product, resumedTasks } = transition
  const readControl = await canonicalProductReadControl(workspaceId)
  const basic = { ...product, product_id: product.id, factsConfirmationRequired: false, humanConfirmed: true, facts_confirmation: productFactsConfirmation(product), resumed_task_ids: resumedTasks.map(task => task.id) }
  if (readControl.mode !== 'canonical_read') return basic
  await persistenceReady
  const candidates = await brandUnits.listCanonicalProducts({ workspaceId, sourceProductIds: [product.id] })
  if (candidates.length > 1) throw new DomainError('CANONICAL_PRODUCT_AMBIGUOUS', '一个商品对应多个规范商品，已阻止同步事实，请先完成映射治理', 409, { product_id: product.id, canonical_product_ids: candidates.map(row => row.id), next_action: 'canonical.product.consistency' })
  const canonical = candidates[0]
  if (!canonical) throw new DomainError('CANONICAL_PRODUCT_MAPPING_REQUIRED', '商品事实已确认，但尚未绑定规范商品，无法完成 canonical_read 同步', 409, { product_id: product.id, next_action: 'canonical.product.consistency' })
  if (canonical.facts && Object.keys(canonical.facts).length > 0) return { ...basic, canonical_scope: { canonical_product_id: canonical.id, brand_id: canonical.brandId, facts_version: canonical.factsVersion, facts_synced: false } }
  const facts: Record<string, unknown> = {
    ...(product.category ? { category: product.category } : {}),
    ...(product.attributes ? { attributes: structuredClone(product.attributes) } : {}),
    ...(typeof product.price === 'number' ? { price: product.price } : {}),
    sku_ids: (product.skus ?? []).map(sku => sku.id),
    selling_points: (product.sellingPoints ?? []).filter(point => point.proofStatus === 'confirmed').map(point => point.text),
  }
  try {
    const updated = await brandUnits.updateCanonicalProductFacts({ workspaceId, id: canonical.id, facts, expectedFactsVersion: canonical.factsVersion })
    await persistEvent(workspaceId, updated.id, 'canonical_product.facts_confirmed', updated.factsVersion, { product_id: product.id, canonical_product_id: updated.id, facts_version: updated.factsVersion, source: 'legacy_confirmation' })
    return { ...basic, canonical_scope: { canonical_product_id: updated.id, brand_id: updated.brandId, facts_version: updated.factsVersion, facts_synced: true } }
  } catch (error) {
    if (error instanceof Error && error.message === 'CANONICAL_PRODUCT_REVISION_CONFLICT') throw new DomainError('CANONICAL_PRODUCT_REVISION_CONFLICT', '标准商品事实已被其他操作更新，请刷新后重试', 409)
    if (error instanceof Error && error.message === 'CANONICAL_PRODUCT_NOT_FOUND') throw new DomainError('CANONICAL_PRODUCT_NOT_FOUND', '标准商品不存在或不属于当前工作区', 404)
    throw error
  }
}
