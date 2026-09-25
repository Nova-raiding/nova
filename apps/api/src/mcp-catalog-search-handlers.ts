import { DomainError, type MerchantService, type Platform, type Product, type ProductSku, type KnowledgeGenerationContext } from '../../../packages/application/src/service.js'
import type { CanonicalProductReadMode } from '../../../packages/application/src/canonical-product-consistency.js'
import type { BrandUnitRepository } from '../../../packages/persistence/src/brand-unit-repository.js'
import type { PostgresBusinessRepository } from '../../../packages/persistence/src/business-repository.js'
import type { KnowledgeRepository, KnowledgeSearchResult } from '../../../packages/persistence/src/knowledge.js'
import type { KnowledgeModule, RuleEntry, AssetEntry, LearningSuggestion } from '../../../packages/knowledge/src/index.js'

type Params = Record<string, unknown>
type Store = { platform: Platform; accountId: string; label: string }
type KnowledgeContextInput = {
  rules: readonly RuleEntry[]
  assets?: readonly AssetEntry[]
  learningSuggestions: readonly LearningSuggestion[]
  brandPreference?: { id: string; preferences: Record<string, unknown>; version: string; revision: number }
}

export async function handleCatalogSearch(params: Params, workspaceId: string, deps: {
  service: Pick<MerchantService, 'getPlatformAccount' | 'listProducts'>
  business?: Pick<PostgresBusinessRepository, 'listProductsPage'>
  brandUnits: Pick<BrandUnitRepository, 'listCanonicalProducts' | 'listListings'>
  knowledgeRepository: Pick<KnowledgeRepository, 'listDocuments' | 'search'>
  storeDirectory: () => readonly Store[]
  pagination: (params: Params) => { limit: number; offset: number }
  accessibleTaskBrandIds: () => Promise<readonly string[] | undefined>
  accessibleProductIds: () => Promise<ReadonlySet<string> | undefined>
  canonicalReadControl: () => Promise<{ mode: CanonicalProductReadMode }>
  knowledgeForWorkspace: () => KnowledgeModule
  buildKnowledgeContext: (input: KnowledgeContextInput) => KnowledgeGenerationContext
}) {
    const scope = params.scope === 'workspace' ? 'workspace' : params.scope === 'store' ? 'store' : undefined
    const platform = typeof params.platform === 'string' ? params.platform as Platform : undefined
    const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
    if (scope === 'store' && (!platform || !accountId)) throw new DomainError('STORE_SELECTION_REQUIRED', '查看指定店铺商品时，请同时选择平台和店铺', 409, { next_actions: ['选择一个平台店铺', '或明确使用全部店铺只读汇总'] })
    if (accountId && !platform) throw new DomainError('STORE_PLATFORM_REQUIRED', '使用 account_id 查询商品时必须同时指定 platform', 400)
    if (scope !== 'workspace' && (!platform || !accountId)) throw new DomainError('STORE_SELECTION_REQUIRED', '请先选择要查看的具体平台店铺；如需汇总全部店铺，请明确传入 scope=workspace', 409, { next_actions: ['调用 workspace.health 查看店铺列表', '选择 platform + account_id', '或明确使用 scope=workspace 查看全部店铺'] })
    if (scope === 'workspace' && accountId) throw new DomainError('CATALOG_SCOPE_CONFLICT', '全部店铺汇总不能同时指定 account_id，请改用 scope=store', 400)
    if (accountId) deps.service.getPlatformAccount(workspaceId, accountId, platform)
    const directory = new Map(deps.storeDirectory().map(store => [`${store.platform}:${store.accountId}`, store]))
    const pageRequest = deps.pagination(params)
    const accessibleBrandIds = await deps.accessibleTaskBrandIds()
    const filters = {
      ...(typeof params.query === 'string' ? { query: params.query } : {}),
      ...(platform ? { platform } : {}),
      ...(accountId ? { accountId } : {}),
      ...(typeof params.store_name === 'string' ? { storeName: params.store_name } : {}),
      ...(typeof params.brand_name === 'string' ? { brandName: params.brand_name } : {}),
      ...(typeof params.sku_id === 'string' ? { skuId: params.sku_id } : {}),
      ...(typeof params.remote_product_id === 'string' ? { remoteProductId: params.remote_product_id } : {}),
      ...(typeof params.listing_status === 'string' ? { listingStatus: params.listing_status as Product['listingStatus'] } : {}),
      ...(typeof params.product_state === 'string' ? { productState: params.product_state as 'active' | 'disabled' } : {}),
      ...(typeof params.sync_status === 'string' ? { syncStatus: params.sync_status as import('../../../packages/application/src/service.js').SyncJobState } : {}),
      ...(typeof params.date_from === 'string' ? { dateFrom: params.date_from } : {}),
      ...(typeof params.date_to === 'string' ? { dateTo: params.date_to } : {}),
    }
    const page = deps.business
      ? await deps.business.listProductsPage(workspaceId, { ...pageRequest, ...filters, ...(accessibleBrandIds !== undefined ? { accessibleBrandIds } : {}) })
      : await (async () => { const accessibleIds = await deps.accessibleProductIds(); const all = deps.service.listProducts(workspaceId, filters).filter(product => accessibleIds === undefined || accessibleIds.has(product.id)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)); return { items: all.slice(pageRequest.offset, pageRequest.offset + pageRequest.limit), total: all.length, ...pageRequest } })()
    const canonicalRepository = deps.brandUnits
    const readControl = await deps.canonicalReadControl()
    const includeKnowledge = params.include_knowledge === true || params.include_knowledge === 'true'
    const knowledgeModule = includeKnowledge ? deps.knowledgeForWorkspace() : undefined
    const knowledgeRepository = includeKnowledge ? (deps.knowledgeRepository) : undefined
    const knowledgeAssets = knowledgeModule?.queryAssets({ workspaceId })
    const confirmedLearningSuggestions = knowledgeModule?.listLearningSuggestions(workspaceId, 'confirmed')
    const activeBrandPreference = knowledgeModule?.getBrandPreference(workspaceId)
    // Index the page's canonical products once instead of re-reading the
    // whole catalog inside the per-product loop. The previous shape issued
    // one unbounded `listCanonicalProducts` transaction per product, and the
    // shape after that one full-catalog read per request; both were O(catalog)
    // for a fixed page size. `sourceProductIds` is the exact key set the loop
    // below looks up, so the bucket contents, their relative order and the
    // `candidates.length > 1` conflict verdict are unchanged — only the rows
    // that cannot be referenced by this page are no longer fetched.
    const pageProducts = page.items as unknown as Product[]
    const canonicalRowsForPage = await canonicalRepository.listCanonicalProducts({
      workspaceId,
      sourceProductIds: pageProducts.map(product => product.id),
    })
    const canonicalBySourceProductId = new Map<string, typeof canonicalRowsForPage>()
    for (const row of canonicalRowsForPage) {
      const sourceProductId = row.sourceProductId
      if (!sourceProductId) continue
      const bucket = canonicalBySourceProductId.get(sourceProductId)
      if (bucket) bucket.push(row)
      else canonicalBySourceProductId.set(sourceProductId, [row])
    }
    // One listing read for the page. The per-product read this replaces asked
    // for `(canonicalProductId, brandId, platform, accountId?)`; the rows below
    // are filtered on exactly those columns in memory, and because
    // `product_listings` has one `brand_id` per canonical product the group key
    // carries the same brand predicate the old query did. `ORDER BY updated_at
    // DESC` is preserved: a subsequence of an ordered result is still ordered,
    // so each product's subset and its cursor-relevant order are unchanged.
    const pageCanonicalIds = new Set<string>()
    for (const candidates of canonicalBySourceProductId.values()) if (candidates.length === 1) pageCanonicalIds.add(candidates[0]!.id)
    const listingsForPage = pageCanonicalIds.size
      ? await canonicalRepository.listListings({ workspaceId, canonicalProductIds: [...pageCanonicalIds] })
      : []
    // Listing rows and page products are matched on the exact triple the
    // per-product read filtered on. `\u001f` cannot occur in a canonical id,
    // a brand id or a platform name, so the key cannot be ambiguous.
    const pageListingKey = (canonicalProductId: string, brandId: string, platform: string) => `${canonicalProductId}\u001f${brandId}\u001f${platform}`
    const listingsByCanonicalPlatform = new Map<string, typeof listingsForPage>()
    for (const listing of listingsForPage) {
      const key = pageListingKey(listing.canonicalProductId, listing.brandId, listing.platform)
      const bucket = listingsByCanonicalPlatform.get(key)
      if (bucket) bucket.push(listing)
      else listingsByCanonicalPlatform.set(key, [listing])
    }
    // `knowledge_status` is reported per product as an exact
    // `pendingKnowledge.length`, so the page read must stay complete: a `limit`
    // would turn an honest count into a truncated one and could silently drop
    // the blocker. It is one workspace-scoped read that replaces one identical
    // read per product, not a page-sized cap.
    const knowledgeStatusEnabled = Boolean(includeKnowledge && knowledgeRepository)
    const knowledgeDocumentsForPage = knowledgeStatusEnabled ? await knowledgeRepository!.listDocuments(workspaceId) : []
    const knowledgeDocumentsByProductId = new Map<string, typeof knowledgeDocumentsForPage>()
    for (const document of knowledgeDocumentsForPage) {
      const productId = document.productId
      if (!productId) continue
      const bucket = knowledgeDocumentsByProductId.get(productId)
      if (bucket) bucket.push(document)
      else knowledgeDocumentsByProductId.set(productId, [document])
    }
    // `search` scopes one call to one store/platform/SKU scope, so the page is
    // grouped by every filter that is not the product id and asked once per
    // group instead of once per product. The resolved `sku_id` belongs to the
    // key even though the page filter above already matched it by SKU id — so
    // every product of a SKU-filtered page resolves to the same value today.
    // Keeping it in the key costs nothing and keeps the batch correct if a
    // page source ever resolves a SKU *name* per product, which would
    // otherwise fold products with different resolved SKUs into one shared
    // `sku_id` and change what `search` returns for them.
    const requestedSkuId = typeof params.sku_id === 'string' ? params.sku_id.trim() : ''
    const knowledgeQuery = typeof params.query === 'string' && params.query.trim() ? params.query.trim() : undefined
    const selectedSkusByProductId = new Map<string, ProductSku[]>()
    const searchGroups = new Map<string, { platform: Platform; accountId?: string; storeName?: string; skuId?: string; productIds: string[]; seen: Set<string>; hasCandidate: boolean }>()
    for (const product of pageProducts) {
      const selectedSkus = requestedSkuId
        ? (product.skus ?? []).filter(sku => sku.id === requestedSkuId || sku.name === requestedSkuId)
        : []
      selectedSkusByProductId.set(product.id, selectedSkus)
      if (!knowledgeStatusEnabled) continue
      const resolvedSkuId = selectedSkus[0]?.id ? selectedSkus[0].id : requestedSkuId ? requestedSkuId : undefined
      // `\u001f` cannot occur in a platform name, an account id, a store name or a
      // SKU id, so the key cannot conflate two different scopes.
      const groupKey = [product.platform, product.accountId ?? '', product.storeName ?? '', resolvedSkuId ?? ''].join('\u001f')
      const group = searchGroups.get(groupKey) ?? {
        platform: product.platform,
        ...(product.accountId ? { accountId: product.accountId } : {}),
        ...(product.storeName ? { storeName: product.storeName } : {}),
        ...(resolvedSkuId ? { skuId: resolvedSkuId } : {}),
        productIds: [],
        seen: new Set<string>(),
        hasCandidate: false,
      }
      if (!group.seen.has(product.id)) { group.seen.add(product.id); group.productIds.push(product.id) }
      // The page read above holds every document of the product and `search`
      // only ever returns ready + approved + cleared documents, so a group in
      // which no product has such a candidate can only answer `[]` for each of
      // its products. Skipping is sound only while that coarse predicate stays
      // no narrower than the one inside `search`; a document that is ready and
      // approved here but that `search` rejects (stale store scope) is still
      // filtered by `search` itself, because the group call is made whenever
      // any member has a candidate.
      if (!group.hasCandidate) group.hasCandidate = (knowledgeDocumentsByProductId.get(product.id) ?? []).some(document => document.indexState === 'ready' && document.approvalStatus === 'approved' && document.rightsStatus === 'cleared')
      searchGroups.set(groupKey, group)
    }
    // One `search` per group for the whole page. `search` answers the batch as
    // the concatenation of each product's ranked slice, in the order of
    // `productIds`, so bucketing the response by `document.productId` gives
    // every product exactly the list its own call returned.
    const persistedKnowledgeByProductId = new Map<string, KnowledgeSearchResult[]>()
    if (knowledgeStatusEnabled) {
      const batches = await Promise.all([...searchGroups.values()].filter(group => group.hasCandidate).map(group => knowledgeRepository!.search({
        workspaceId,
        platform: group.platform,
        ...(group.accountId ? { accountId: group.accountId } : {}),
        ...(group.storeName ? { storeName: group.storeName } : {}),
        ...(knowledgeQuery ? { query: knowledgeQuery } : {}),
        productIds: group.productIds,
        ...(group.skuId ? { skuId: group.skuId } : {}),
        limit: 8,
      })))
      for (const batch of batches) for (const item of batch) {
        const productId = item.document.productId
        if (!productId) continue
        const bucket = persistedKnowledgeByProductId.get(productId)
        if (bucket) bucket.push(item)
        else persistedKnowledgeByProductId.set(productId, [item])
      }
    }
    // No I/O is left in this loop: every read it used to await is now a page
    // or group-level read hoisted above it, so the projection below is pure.
    const products = pageProducts.map(product => {
      const selectedSkus = selectedSkusByProductId.get(product.id) ?? []
      const canonicalCandidates = canonicalBySourceProductId.get(product.id) ?? []
      const canonical = canonicalCandidates.length === 1 ? canonicalCandidates[0] : undefined
      const listings = canonical
        ? (listingsByCanonicalPlatform.get(pageListingKey(canonical.id, canonical.brandId, product.platform)) ?? []).filter(listing => !product.accountId || listing.accountId === product.accountId)
        : []
      const verificationStatus = canonicalCandidates.length > 1 ? 'conflict' : !canonical ? 'legacy_only' : listings.length === 1 ? 'verified' : 'blocked'
      const knowledgeContext = knowledgeModule ? deps.buildKnowledgeContext({
        rules: knowledgeModule.findApplicableRules({ platform: product.platform, ...(product.category ? { category: product.category } : {}), ...(product.storeName ? { store: product.storeName } : {}) }, new Date().toISOString(), workspaceId),
        assets: knowledgeAssets,
        learningSuggestions: confirmedLearningSuggestions ?? [],
        ...(activeBrandPreference?.status === 'active' ? { brandPreference: activeBrandPreference } : {}),
      }) : undefined
      // This product's slice of the page read above, in the same order the
      // per-product read returned it (`updated_at DESC, id`).
      const knowledgeStatus = knowledgeStatusEnabled ? (knowledgeDocumentsByProductId.get(product.id) ?? []) : []
      // This product's slice of its group's call above, ranked by `search`
      // exactly as the per-product call ranked it.
      const persistedKnowledge = knowledgeStatusEnabled ? (persistedKnowledgeByProductId.get(product.id) ?? []) : []
      const knowledgeDocuments = persistedKnowledge.map(({ document, chunks, score }) => ({
        id: document.id,
        title: document.title,
        knowledge_type: document.knowledgeType,
        product_id: document.productId ?? null,
        sku_id: document.skuId ?? null,
        extracted_text: document.extractedText,
        chunks: chunks.map(chunk => ({ id: chunk.id, ordinal: chunk.ordinal, content: chunk.content })),
        score,
        source_version: document.sourceVersion,
        revision: document.revision,
      }))
      const pendingKnowledge = knowledgeStatus.filter(document =>
        document.indexState !== 'ready' || document.approvalStatus !== 'approved' || document.rightsStatus !== 'cleared',
      )
      const knowledgeBlocker = includeKnowledge && knowledgeDocuments.length === 0 && pendingKnowledge.length > 0
        ? {
            state: 'pending_review_or_index',
            document_count: pendingKnowledge.length,
            statuses: [...new Set(pendingKnowledge.map(document => `${document.approvalStatus}/${document.rightsStatus}/${document.indexState}`))],
            next_action: 'knowledge.asset.update',
            message: '商品知识已入库，但仍在等待运营审批、权益确认或索引完成；完成后插件会自动返回可用知识。',
          }
        : undefined
      return {
        ...product,
        product_id: product.id,
        ...(requestedSkuId ? { selected_skus: selectedSkus } : {}),
        storeContext: product.accountId ? directory.get(`${product.platform}:${product.accountId}`) ?? { platform: product.platform, accountId: product.accountId } : null,
        canonical_scope: { verification_status: verificationStatus, read_mode: readControl.mode, canonical_product_id: canonical?.id ?? null, brand_id: canonical?.brandId ?? null, listing_id: listings.length === 1 ? listings[0]!.id : null, listing_count: listings.length, next_action: verificationStatus === 'verified' ? null : 'canonical.product.consistency' },
        ...(knowledgeContext ? { knowledge_context: knowledgeContext } : {}),
        ...(includeKnowledge ? { knowledge_documents: knowledgeDocuments } : {}),
        ...(knowledgeBlocker ? { knowledge_status: knowledgeBlocker } : {}),
      }
    })
    const product_actions = products.map(product => {
      const base = { product_id: product.id, title: product.title, platform: product.platform, account_id: product.accountId ?? null, facts_confirmed: product.factsConfirmed }
      if (!product.accountId) return { ...base, action: { method: 'platform.connect', label: '绑定商品所属店铺', required_inputs: ['platform'], confirmation: 'interactive_confirmation' } }
      if (!product.factsConfirmed) return { ...base, action: { method: 'catalog.facts.confirm', label: '确认商品、SKU、价格和图片事实', required_inputs: ['product_id'], confirmation: 'interactive_confirmation' } }
      if (product.canonical_scope.verification_status !== 'verified') return { ...base, action: { method: 'canonical.product.consistency', label: '检查标准商品链', required_inputs: [], confirmation: 'none', reason: product.canonical_scope.verification_status } }
      return { ...base, action: null, next_step: '商品事实已确认，可创建内容任务' }
    })
    return {
      scope: scope === 'workspace' ? 'workspace' : 'store',
      selection: accountId && platform ? { platform, accountId } : null,
      products,
      product_actions,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      emptyState: products.length ? null : {
        title: '暂时没有找到商品',
        reason: scope === 'workspace' ? '当前工作区还没有可见商品，或筛选条件没有匹配结果' : '该店铺还没有同步或导入商品，或筛选条件没有匹配结果',
        nextActions: scope === 'workspace' ? ['选择具体店铺后重新查询', '同步或导入商品'] : ['同步当前店铺商品', '导入商品资料', '更换筛选条件'],
      },
    }
}

export function handleCatalogCategories(params: Params, catalogCategories: readonly { code: string; name: string; fields: readonly string[] }[]) {
  const query = typeof params.query === 'string' ? params.query.trim().toLocaleLowerCase() : ''
  return (query ? catalogCategories.filter(item => `${item.code}${item.name}${item.fields.join('')}`.toLocaleLowerCase().includes(query)) : catalogCategories).map(item => ({ ...item, category_code: item.code, required_fields: item.fields }))
}
