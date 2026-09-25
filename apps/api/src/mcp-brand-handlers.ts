import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { DomainError, type MerchantService, type Platform, type Product } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { BrandAccessRole, BrandUnitRepository, OperationAudit } from '../../../packages/persistence/src/index.js'
import type { CommercialCountBenefitCode } from './commercial-count-capacity.js'

export const MCP_BRAND_METHODS = new Set([
  'brand-unit.list', 'brand-unit.create', 'brand-unit.bind-store',
  'brand-unit.product.create', 'brand-unit.listing.create',
  'brand-unit.listing.list', 'brand-unit.access.grant',
])

export interface BrandMcpDependencies {
  repository: BrandUnitRepository
  storageMode: 'memory' | 'postgres'
  ready: Promise<unknown>
  service: MerchantService
  isProduction: () => boolean
  required: (params: Record<string, unknown>, key: string) => string
  requireOperationsRole: (req: IncomingMessage, allowed: readonly string[]) => void
  enforceBrandAccess: (req: IncomingMessage, workspaceId: string, brandId: string, minimumRole?: BrandAccessRole) => Promise<void>
  enforceProductBrandAccess: (req: IncomingMessage, workspaceId: string, productId: string, minimumRole?: BrandAccessRole) => Promise<void>
  filterByBrandAccess: <T>(req: IncomingMessage, workspaceId: string, rows: T[], brandIdOf: (row: T) => string, minimumRole?: BrandAccessRole) => Promise<T[]>
  requireCommercialCountCapacity: (input: { workspaceId: string; code: CommercialCountBenefitCode; used: number; label: string }) => Promise<unknown>
  recordOperationAudit: (input: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
  requestActor: (req: IncomingMessage) => string
  principalActorId: (req: IncomingMessage) => string | undefined
}

export async function handleBrandMcpMethod(
  method: string,
  params: Record<string, unknown>,
  workspaceId: string,
  req: IncomingMessage,
  dependencies: BrandMcpDependencies,
): Promise<unknown> {
  const {
    repository, storageMode, ready: persistenceReady, service, isProduction, required,
    requireOperationsRole, enforceBrandAccess, enforceProductBrandAccess,
    filterByBrandAccess, requireCommercialCountCapacity, recordOperationAudit,
    requestActor, principalActorId,
  } = dependencies
  switch (method) {
    case 'brand-unit.list': {
      const brandId = typeof params.brand_id === 'string' && params.brand_id.trim() ? params.brand_id.trim() : undefined
      const platform = typeof params.platform === 'string' ? params.platform as Platform : undefined
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      if (accountId && !platform) throw new DomainError('STORE_PLATFORM_REQUIRED', '使用 account_id 筛选品时必须同时指定 platform', 400)
      await persistenceReady
      const listed = await repository.listBrands({ workspaceId, ...(brandId ? { brandId } : {}), ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}) })
      if (brandId) await enforceBrandAccess(req, workspaceId, brandId)
      const items = await filterByBrandAccess(req, workspaceId, listed, item => item.id)
      return { items, count: items.length, storage: storageMode, durable: storageMode === 'postgres', ...(storageMode === 'memory' ? { message: '当前为本地 fixture 运行；生产环境会写入 PostgreSQL。' } : {}) }
    }
    case 'brand-unit.create': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const name = required(params, 'name').normalize('NFKC').trim()
      if (name.length > 120) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '品名称不能超过 120 个字符', 400)
      const requestedId = typeof params.brand_id === 'string' && params.brand_id.trim() ? params.brand_id.trim() : `brand_unit_${randomUUID().replaceAll('-', '').slice(0, 24)}`
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/u.test(requestedId)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'brand_id 必须是 2 至 64 个字母、数字、下划线或连字符', 400)
      await persistenceReady
      const existingBrands = await repository.listBrands({ workspaceId })
      await requireCommercialCountCapacity({ workspaceId, code: 'max_brands', used: existingBrands.length + 1, label: '个品牌' })
      try {
        const unit = await repository.createBrand({ workspaceId, id: requestedId, name })
        return { ...unit, storage: storageMode, durable: storageMode === 'postgres', ...(storageMode === 'memory' ? { message: '当前为本地 fixture 运行；生产环境会写入 PostgreSQL。' } : {}) }
      } catch (error) {
        if (String(error).includes('BRAND_UNIT_CONFLICT') || (error as { code?: string })?.code === '23505') throw new DomainError('BRAND_UNIT_CONFLICT', 'brand_id 或品名称已存在，请换一个标识', 409, { brand_id: requestedId })
        throw error
      }
    }
    case 'brand-unit.bind-store': {
      const brandId = required(params, 'brand_id')
      await enforceBrandAccess(req, workspaceId, brandId, 'editor')
      const platform = required(params, 'platform') as Platform
      const accountId = required(params, 'account_id')
      const expectedRevision = params.expected_revision === undefined ? undefined : Number(params.expected_revision)
      if (params.expected_revision !== undefined && (typeof params.expected_revision !== 'string' || !/^[1-9][0-9]*$/u.test(params.expected_revision) || !Number.isSafeInteger(expectedRevision))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'expected_revision 必须是正整数字符串', 400)
      await persistenceReady
      const account = isProduction() ? service.getActionablePlatformAccount(workspaceId, accountId, platform) : service.getPlatformAccount(workspaceId, accountId, platform)
      if (!account) throw new DomainError('PLATFORM_ACCOUNT_NOT_FOUND', '平台账号不存在或不属于当前工作区', 404)
      const brands = await repository.listBrands({ workspaceId })
      const existingStores = new Set(brands.flatMap(brand => brand.storeBindings.map(binding => `${binding.platform}:${binding.accountId}`)))
      const storeKey = `${platform}:${accountId}`
      if (!existingStores.has(storeKey)) await requireCommercialCountCapacity({ workspaceId, code: 'max_stores', used: existingStores.size + 1, label: '家店铺' })
      try {
        const unit = await repository.bindStore({ workspaceId, brandId, platform, accountId, ...(expectedRevision !== undefined ? { expectedRevision } : {}) })
        await recordOperationAudit({ workspaceId, actorId: requestActor(req), action: 'brand.store.bind', resourceType: 'brand_store_binding', resourceId: `${brandId}:${platform}:${accountId}`, before: {}, after: { brand_id: brandId, platform, account_id: accountId, status: 'active' }, reason: typeof params.reason === 'string' && params.reason.trim() ? params.reason.trim() : '绑定品牌与平台店铺' })
        return { brandUnit: unit, boundStore: { platform: account.platform, accountId: account.id, tokenState: account.tokenState }, storage: storageMode, durable: storageMode === 'postgres', ...(storageMode === 'memory' ? { message: '当前为本地 fixture 运行；生产环境会写入 PostgreSQL。' } : {}) }
      } catch (error) {
        if (String(error).includes('BRAND_STORE_REVISION_CONFLICT')) throw new DomainError('BRAND_STORE_REVISION_CONFLICT', '品的店铺绑定已被其他操作更新，请刷新后重试', 409)
        if (String(error).includes('BRAND_UNIT_NOT_FOUND')) throw new DomainError('BRAND_UNIT_NOT_FOUND', '品不存在或不属于当前工作区', 404)
        throw error
      }
    }
    case 'brand-unit.product.create': {
      const brandId = required(params, 'brand_id')
      await enforceBrandAccess(req, workspaceId, brandId, 'editor')
      const title = required(params, 'title').normalize('NFKC').trim()
      if (title.length > 256) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '商品标题不能超过 256 个字符', 400)
      await persistenceReady
      const brands = await repository.listBrands({ workspaceId, brandId })
      if (!brands[0]) throw new DomainError('BRAND_UNIT_NOT_FOUND', '品不存在或不属于当前工作区', 404, { brand_id: brandId })
      const id = typeof params.product_id === 'string' && params.product_id.trim() ? params.product_id.trim() : `canonical_product_${randomUUID().replaceAll('-', '').slice(0, 24)}`
      const sourceProductId = typeof params.source_product_id === 'string' && params.source_product_id.trim() ? params.source_product_id.trim() : undefined
      let canonicalFacts: Record<string, unknown> = {}
      if (sourceProductId) {
        const sourceProduct = service.products.get(sourceProductId)
        if (!sourceProduct || sourceProduct.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', 'source_product_id 不存在或不属于当前工作区', 404, { source_product_id: sourceProductId })
        await enforceProductBrandAccess(req, workspaceId, sourceProductId)
        const recordedBrandId = typeof (sourceProduct as Product & { brandId?: unknown }).brandId === 'string'
          ? (sourceProduct as Product & { brandId: string }).brandId.trim()
          : typeof sourceProduct.rawPlatformFields?.brand_id === 'string'
            ? sourceProduct.rawPlatformFields.brand_id.trim()
            : ''
        if (!recordedBrandId && storageMode === 'postgres') {
          throw new DomainError('PRODUCT_BRAND_REQUIRED', '旧商品尚未绑定品，不能建立标准商品关系；请先从已绑定品的授权店铺重新同步或导入商品', 409, {
            source_product_id: sourceProductId,
            next_actions: ['catalog.sync.start', 'catalog.import'],
          })
        }
        if (recordedBrandId && recordedBrandId !== brandId) throw new DomainError('PRODUCT_BRAND_SCOPE_MISMATCH', 'source_product_id 已归属其他品，不能跨品建立 canonical 商品关系', 409, { source_product_id: sourceProductId, source_brand_id: recordedBrandId, requested_brand_id: brandId })
        if (!sourceProduct.factsConfirmed) throw new DomainError('CANONICAL_PRODUCT_FACTS_REQUIRED', '建立标准商品前必须先确认旧商品事实', 409, { source_product_id: sourceProductId, next_action: 'catalog.facts.confirm' })
        canonicalFacts = {
          ...(sourceProduct.category ? { category: sourceProduct.category } : {}),
          ...(sourceProduct.attributes ? { attributes: structuredClone(sourceProduct.attributes) } : {}),
          ...(typeof sourceProduct.price === 'number' ? { price: sourceProduct.price } : {}),
          sku_ids: (sourceProduct.skus ?? []).map(sku => sku.id),
          selling_points: (sourceProduct.sellingPoints ?? []).filter(point => point.proofStatus === 'confirmed').map(point => point.text),
        }
      }
      try {
        const product = await repository.createCanonicalProduct({ workspaceId, id, brandId, title, facts: canonicalFacts, ...(sourceProductId ? { sourceProductId } : {}) })
        return { ...product, storage: storageMode, durable: storageMode === 'postgres' }
      } catch (error) {
        if (String(error).includes('CANONICAL_PRODUCT_CONFLICT') || (error as { code?: string })?.code === '23505') throw new DomainError('CANONICAL_PRODUCT_CONFLICT', 'canonical product_id 已存在，请换一个标识', 409, { product_id: id })
        throw error
      }
    }
    case 'brand-unit.listing.create': {
      const brandId = required(params, 'brand_id')
      await enforceBrandAccess(req, workspaceId, brandId, 'editor')
      const canonicalProductId = required(params, 'canonical_product_id')
      const platform = required(params, 'platform') as Platform
      const accountId = required(params, 'account_id')
      await persistenceReady
      const canonicalProduct = await repository.getCanonicalProduct({ workspaceId, id: canonicalProductId })
      if (!canonicalProduct || canonicalProduct.brandId !== brandId) throw new DomainError('CANONICAL_PRODUCT_SCOPE_MISMATCH', 'canonical product 不属于当前品或工作区，不能创建店铺 listing', 409, { canonical_product_id: canonicalProductId, brand_id: brandId })
      const brands = await repository.listBrands({ workspaceId, brandId, platform, accountId })
      if (!brands[0]) throw new DomainError('BRAND_STORE_BINDING_REQUIRED', '创建 listing 前必须先将店铺绑定到该品', 409, { brand_id: brandId, platform, account_id: accountId })
      const account = isProduction() ? service.getActionablePlatformAccount(workspaceId, accountId, platform) : service.getPlatformAccount(workspaceId, accountId, platform)
      if (!account) throw new DomainError('PLATFORM_ACCOUNT_NOT_FOUND', '平台账号不存在或不属于当前工作区', 404)
      const id = typeof params.listing_id === 'string' && params.listing_id.trim() ? params.listing_id.trim() : `listing_${randomUUID().replaceAll('-', '').slice(0, 24)}`
      try {
        const listing = await repository.createListing({ workspaceId, id, brandId, canonicalProductId, platform, accountId, ...(typeof params.remote_product_id === 'string' && params.remote_product_id.trim() ? { remoteProductId: params.remote_product_id.trim() } : {}) })
        await recordOperationAudit({ workspaceId, actorId: requestActor(req), action: 'brand.listing.create', resourceType: 'product_listing', resourceId: listing.id, before: {}, after: listing as unknown as Record<string, unknown>, reason: typeof params.reason === 'string' && params.reason.trim() ? params.reason.trim() : '创建平台店铺商品关系' })
        return { ...listing, storage: storageMode, durable: storageMode === 'postgres' }
      } catch (error) {
        if (String(error).includes('LISTING_CONFLICT') || (error as { code?: string })?.code === '23505') throw new DomainError('LISTING_CONFLICT', 'listing_id 已存在，请换一个标识', 409, { listing_id: id })
        if ((error as { code?: string })?.code === '23503' || String(error).includes('PRODUCT_LISTING')) throw new DomainError('CANONICAL_PRODUCT_NOT_FOUND', 'canonical product 不存在或不属于当前工作区', 404, { canonical_product_id: canonicalProductId })
        throw error
      }
    }
    case 'brand-unit.listing.list': {
      await persistenceReady
      const brandId = typeof params.brand_id === 'string' && params.brand_id.trim() ? params.brand_id.trim() : undefined
      const platform = typeof params.platform === 'string' && params.platform.trim() ? params.platform as Platform : undefined
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      if (accountId && !platform) throw new DomainError('STORE_PLATFORM_REQUIRED', '使用 account_id 筛选 listing 时必须同时指定 platform', 400)
      if (brandId) await enforceBrandAccess(req, workspaceId, brandId)
      const listed = await repository.listListings({ workspaceId, ...(brandId ? { brandId } : {}), ...(typeof params.canonical_product_id === 'string' && params.canonical_product_id.trim() ? { canonicalProductId: params.canonical_product_id.trim() } : {}), ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}) })
      const listings = await filterByBrandAccess(req, workspaceId, listed, listing => listing.brandId)
      return { items: listings, count: listings.length, storage: storageMode, durable: storageMode === 'postgres' }
    }
    case 'brand-unit.access.grant': {
      requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'platform_ops'])
      const brandId = required(params, 'brand_id')
      const role = required(params, 'role') as BrandAccessRole
      if (!['viewer', 'editor', 'publisher', 'admin'].includes(role)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '品权限角色无效', 400)
      await enforceBrandAccess(req, workspaceId, brandId, 'admin')
      const externalSubject = required(params, 'external_subject')
      try {
        await repository.grantBrandAccess({ workspaceId, brandId, externalSubject, role })
      } catch (error) {
        if (String(error).includes('ACTIVE_MEMBER_NOT_FOUND')) throw new DomainError('ACTIVE_MEMBER_NOT_FOUND', '只能向当前工作区的 active 成员授予品权限', 404)
        if (String(error).includes('BRAND_UNIT_NOT_FOUND') || (error as { code?: string })?.code === '23503') throw new DomainError('BRAND_UNIT_NOT_FOUND', '品不存在或不属于当前工作区', 404)
        throw error
      }
      await recordOperationAudit({ workspaceId, actorId: principalActorId(req) ?? 'actor_demo', action: 'brand.access.grant', resourceType: 'brand', resourceId: brandId, before: {}, after: { externalSubject, role }, reason: typeof params.reason === 'string' ? params.reason : '更新品权限' })
      return { brandId, externalSubject, role }
    }
  }
  throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知品方法: ${method}`, 400)
}
