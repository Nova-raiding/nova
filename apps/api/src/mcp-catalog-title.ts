import { createHash } from 'node:crypto'
import { DomainError, type MerchantService, type Platform, type Product } from '../../../packages/application/src/service.js'
import { resolveCanonicalProductReadScope, type CanonicalProductReadMode } from '../../../packages/application/src/canonical-product-consistency.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { generateSeoGeoSuggestions } from '../../../packages/seo/src/index.js'
import type { ApiPersistence } from './server.js'

type Params = Record<string, unknown>

export interface CatalogTitleDependencies {
  service: Pick<MerchantService, 'products' | 'acceptSeoGeoTitle'>
  supportedPlatforms: readonly Platform[]
  brandUnits: NonNullable<ApiPersistence['brandUnits']>
  required(params: Params, key: string): string
  observeWallet(workspaceId: string): Promise<unknown>
  enforceProductBrandAccess(workspaceId: string, productId: string): Promise<unknown>
  canonicalProductReadControl(workspaceId: string): Promise<{ mode: CanonicalProductReadMode }>
  requireGenerationRulePreflight(workspaceId: string, productId: string, message: string): Promise<unknown>
  requireRuleSafeGenerationText(rulePreflight: unknown, values: unknown[], message?: string): void
  enforceCommercialAccess(workspaceId: string, method: string): Promise<unknown>
  actor(): string
  persistSnapshot(workspaceId: string, entityType: 'product', entity: Product, value: Record<string, unknown>): Promise<unknown>
  persistEvent(workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>): Promise<unknown>
  refundWallet(input: { workspaceId: string; debitIdempotencyKey: string; actorId: string; reason: string }): Promise<unknown>
}

export async function handleCatalogTitle(method: 'catalog.title.optimize' | 'catalog.title.accept', workspaceId: string, params: Params, deps: CatalogTitleDependencies) {
  const { service, supportedPlatforms, brandUnits, required, observeWallet, enforceProductBrandAccess, canonicalProductReadControl, requireGenerationRulePreflight, requireRuleSafeGenerationText, enforceCommercialAccess, actor, persistSnapshot, persistEvent, refundWallet } = deps
  if (method === 'catalog.title.optimize') {
    await observeWallet(workspaceId)
    const productId = required(params, 'product_id')
    const product = service.products.get(productId)
    if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
    await enforceProductBrandAccess(workspaceId, product.id)
    const requestedPlatform = typeof params.platform === 'string' ? params.platform as Platform : product.platform
    if (!supportedPlatforms.includes(requestedPlatform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
    if (requestedPlatform !== product.platform) throw new DomainError('TITLE_PLATFORM_SCOPE_MISMATCH', '标题优化的平台必须与当前商品平台一致', 409, { product_platform: product.platform, requested_platform: requestedPlatform })
    const readControl = await canonicalProductReadControl(workspaceId)
    const canonicalCandidates = await brandUnits.listCanonicalProducts({ workspaceId, sourceProductIds: [product.id] })
    const canonical = canonicalCandidates.length === 1 ? canonicalCandidates[0] : undefined
    const canonicalListings = canonical
      ? await brandUnits.listListings({ workspaceId, brandId: canonical.brandId, canonicalProductId: canonical.id, platform: requestedPlatform, ...(product.accountId ? { accountId: product.accountId } : {}) })
      : []
    const canonicalScope = resolveCanonicalProductReadScope({ mode: readControl.mode, workspaceId, platform: requestedPlatform, ...(product.accountId ? { accountId: product.accountId } : {}), candidates: canonicalCandidates, listings: canonicalListings })
    if (canonicalScope?.status === 'blocked') throw new DomainError(canonicalScope.code, '标准商品链未完成验证，已阻断标题优化', 409, { reason: canonicalScope.reason, next_action: 'canonical.product.consistency', read_mode: readControl.mode })
    const generationTitle = canonicalScope?.status === 'verified' ? canonicalScope.title : product.title
    const generationFacts = canonicalScope?.status === 'verified' ? canonicalScope.facts : undefined
    const rulePreflight = await requireGenerationRulePreflight(workspaceId, product.id, '标题优化前平台规则校验未通过')
    requireRuleSafeGenerationText(rulePreflight, [generationTitle, params.keyword, params.objective])
    await enforceCommercialAccess(workspaceId, method)
    const suggestions = generateSeoGeoSuggestions({ platform: requestedPlatform, productId: product.id, title: generationTitle, ...(typeof generationFacts?.category === 'string' ? { category: generationFacts.category } : product.category ? { category: product.category } : {}), ...(generationFacts?.attributes && typeof generationFacts.attributes === 'object' ? { attributes: generationFacts.attributes as Record<string, string> } : product.attributes ? { attributes: product.attributes } : {}), ...(Array.isArray(generationFacts?.selling_points) ? { sellingPoints: generationFacts.selling_points.filter((item): item is string => typeof item === 'string') } : product.sellingPoints ? { sellingPoints: product.sellingPoints.filter(item => item.proofStatus === 'confirmed').map(item => item.text) } : {}), ...(typeof params.keyword === 'string' ? { keyword: params.keyword } : {}), ...(typeof params.objective === 'string' ? { objective: params.objective } : {}) })
    requireRuleSafeGenerationText(rulePreflight, [suggestions], '标题优化结果命中当前平台规则禁用表达')
    const seoKey = createHash('sha256').update(JSON.stringify({ productId: product.id, requestedPlatform, keyword: params.keyword ?? '', objective: params.objective ?? '' })).digest('hex')
    const seoDebitKey = `seo-geo:${seoKey}`
    const seoActor = actor()
    await observeWallet(workspaceId)
    try {
      await persistEvent(workspaceId, product.id, 'catalog.title.optimized', product.version ?? 1, { product_id: product.id, platform: requestedPlatform, suggestion_id: suggestions[0]?.id ?? null, ranking_guarantee: false })
    } catch (error) {
      await refundWallet({ workspaceId, debitIdempotencyKey: seoDebitKey, actorId: seoActor, reason: 'SEO/GEO 结果记录失败' })
      throw error
    }
    return { product_id: product.id, platform: requestedPlatform, suggestions, rule_preflight: rulePreflight, canonical_scope: canonicalScope?.status === 'verified' ? canonicalScope : null, humanConfirmationRequired: true, rankingGuarantee: false }
  }
  const productId = required(params, 'product_id')
  const platform = required(params, 'platform') as Platform
  const suggestionId = required(params, 'suggestion_id')
  const title = required(params, 'title')
  const expectedVersion = typeof params.expected_version === 'string' && /^\d+$/u.test(params.expected_version) ? Number(params.expected_version) : undefined
  if (params.expected_version !== undefined && expectedVersion === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_version 必须是非负整数', 400)
  const readControl = await canonicalProductReadControl(workspaceId)
  if (readControl.mode === 'canonical_read') {
    const product = service.products.get(productId)
    if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
    if (expectedVersion !== undefined && expectedVersion !== product.version) throw new DomainError('PRODUCT_VERSION_CONFLICT', '商品事实已变化，请刷新后再确认 SEO/GEO 标题', 409)
    if (!supportedPlatforms.includes(platform)) throw new DomainError('PLATFORM_INVALID', 'SEO/GEO 标题的平台无效', 400)
    const expectedSuggestionId = `seo_geo_${product.id}_${platform}`
    if (suggestionId !== expectedSuggestionId) throw new DomainError('SEO_GEO_SUGGESTION_INVALID', 'SEO/GEO 建议已过期或不属于当前商品/平台，请重新生成', 409, { expected_suggestion_id: expectedSuggestionId })
    const trimmedTitle = title.trim()
    if (!trimmedTitle) throw new DomainError('PRODUCT_TITLE_REQUIRED', 'SEO/GEO 标题不能为空', 400)
    const candidates = await brandUnits.listCanonicalProducts({ workspaceId, sourceProductIds: [product.id] })
    if (candidates.length !== 1) throw new DomainError('CANONICAL_PRODUCT_MAPPING_REQUIRED', '标准商品映射不唯一，已阻断标题写回', 409, { product_id: product.id, next_action: 'canonical.product.consistency' })
    const canonical = candidates[0]!
    const listings = await brandUnits.listListings({ workspaceId, brandId: canonical.brandId, canonicalProductId: canonical.id, platform, ...(product.accountId ? { accountId: product.accountId } : {}) })
    if (listings.length !== 1 || !canonical.facts || Object.keys(canonical.facts).length === 0) throw new DomainError('CANONICAL_PRODUCT_SCOPE_INCOMPLETE', '标准商品的事实或唯一平台 listing 尚未验证，已阻断标题写回', 409, { product_id: product.id, canonical_product_id: canonical.id, listing_count: listings.length, next_action: 'canonical.product.consistency' })
    try {
      const updated = await brandUnits.updateCanonicalProductTitle({ workspaceId, id: canonical.id, title: trimmedTitle, expectedFactsVersion: canonical.factsVersion })
      await persistEvent(workspaceId, updated.id, 'catalog.title.accepted', updated.factsVersion, { product_id: product.id, canonical_product_id: updated.id, platform, suggestion_id: suggestionId, facts_confirmed: true, source: 'canonical' })
      return { product_id: product.id, canonical_product_id: updated.id, listing_id: listings[0]!.id, title: updated.title, factsConfirmationRequired: false, humanConfirmed: true, canonical_scope: { canonical_product_id: updated.id, brand_id: updated.brandId, listing_id: listings[0]!.id, facts_version: updated.factsVersion } }
    } catch (error) {
      if (error instanceof Error && error.message === 'CANONICAL_PRODUCT_REVISION_CONFLICT') throw new DomainError('CANONICAL_PRODUCT_REVISION_CONFLICT', '标准商品标题已被其他操作更新，请刷新后重试', 409)
      if (error instanceof Error && error.message === 'CANONICAL_PRODUCT_NOT_FOUND') throw new DomainError('CANONICAL_PRODUCT_NOT_FOUND', '标准商品不存在或不属于当前工作区', 404)
      throw error
    }
  }
  const product = service.acceptSeoGeoTitle({ workspaceId, productId, platform, suggestionId, title, actorId: actor(), ...(expectedVersion !== undefined ? { expectedVersion } : {}) })
  await persistSnapshot(workspaceId, 'product', product, product as unknown as Record<string, unknown>)
  await persistEvent(workspaceId, product.id, 'catalog.title.accepted', product.version ?? 1, { product_id: product.id, platform, suggestion_id: suggestionId, facts_confirmed: false })
  return { ...product, product_id: product.id, factsConfirmationRequired: true, humanConfirmed: true }
}
