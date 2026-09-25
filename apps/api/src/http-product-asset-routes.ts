import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type MerchantService } from '../../../packages/application/src/service.js'
import { ERROR_CODES, type ApiEnvelope } from '../../../packages/contracts/src/index.js'
import { BusinessSnapshotVersionConflictError, type PostgresBusinessRepository, type ProductAssetBindingRow } from '../../../packages/persistence/src/business-repository.js'

type JsonObject = Record<string, unknown>
type Send = <T>(res: ServerResponse, status: number, workspaceId: string, data: T | null, error?: ApiEnvelope<T>['error'], req?: IncomingMessage) => void

export async function handleHttpProductAssetRoute(req: IncomingMessage, res: ServerResponse, path: string, deps: {
  service: MerchantService
  business?: Pick<PostgresBusinessRepository, 'listProductAssetBindings' | 'bindProductAsset' | 'unbindProductAsset'>
  persistenceReady: Promise<unknown>
  resolveWorkspace: (req: IncomingMessage, candidate?: unknown) => string
  enforceProductBrandAccess: (req: IncomingMessage, workspaceId: string, productId: string) => Promise<unknown>
  enforceProductBrandBinding: (req: IncomingMessage, workspaceId: string, productId: string, brandId: string) => Promise<unknown>
  accessibleProductIds: (req: IncomingMessage, workspaceId: string) => Promise<ReadonlySet<string> | undefined>
  requestActor: (req: IncomingMessage) => string
  body: (req: IncomingMessage) => Promise<JsonObject>
  send: Send
}) {
  const productGetMatch = path.match(/^\/v1\/products\/([^/]+)$/)
  const productAssetsMatch = path.match(/^\/v1\/products\/([^/]+)\/assets$/)
  if (req.method === 'GET' && productAssetsMatch) {
    const workspaceId = deps.resolveWorkspace(req)
    const productId = decodeURIComponent(productAssetsMatch[1]!)
    const product = deps.service.products.get(productId)
    if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
    await deps.enforceProductBrandAccess(req, workspaceId, productId)
    if (deps.business) {
      const items = await deps.business.listProductAssetBindings(workspaceId, { productId })
      return deps.send(res, 200, workspaceId, { items, source: 'normalized_relation' }, null, req)
    }
    const items = deps.service.listAssets(workspaceId)
      .filter(asset => product.sourceAssetIds?.includes(asset.id))
      .map((asset, index) => ({ workspaceId, productId, assetId: asset.id, assetRole: 'source' as const, ordinal: index + 1, status: 'active' as const, createdAt: asset.createdAt, updatedAt: asset.createdAt }))
    return deps.send(res, 200, workspaceId, { items, source: 'compatibility_projection' }, null, req)
  }
  if ((req.method === 'POST' || req.method === 'DELETE') && productAssetsMatch) {
    await deps.persistenceReady
    if (!deps.business) throw new DomainError('BUSINESS_PERSISTENCE_REQUIRED', '商品素材关系变更需要持久化业务仓储', 503)
    const input = await deps.body(req)
    const workspaceId = deps.resolveWorkspace(req, input.workspace_id)
    const productId = decodeURIComponent(productAssetsMatch[1]!)
    const assetId = typeof input.asset_id === 'string' ? input.asset_id.trim() : ''
    const brandId = typeof input.brand_id === 'string' ? input.brand_id.trim() : ''
    const assetRole = typeof input.asset_role === 'string' ? input.asset_role.trim() : 'source'
    const expectedVersion = typeof input.expected_version === 'number' ? input.expected_version : Number(input.expected_version)
    const ordinal = input.ordinal === undefined ? undefined : Number(input.ordinal)
    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    if (!assetId || !brandId || !reason || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || (ordinal !== undefined && (!Number.isSafeInteger(ordinal) || ordinal < 1)) || !['source', 'main', 'secondary', 'detail'].includes(assetRole)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'asset_id、brand_id、reason、expected_version 和合法 asset_role 为必填项', 400)
    await deps.enforceProductBrandBinding(req, workspaceId, productId, brandId)
    const actorId = deps.requestActor(req)
    try {
      const change = { workspaceId, productId, assetId, brandId, assetRole: assetRole as ProductAssetBindingRow['assetRole'], ...(ordinal !== undefined ? { ordinal } : {}), expectedVersion, actorId, reason }
      const binding = req.method === 'POST' ? await deps.business.bindProductAsset(change) : await deps.business.unbindProductAsset(change)
      return deps.send(res, req.method === 'POST' ? 201 : 200, workspaceId, { binding, audited: true, source: 'controlled_relation_service' }, null, req)
    } catch (error) {
      if (error instanceof BusinessSnapshotVersionConflictError) throw new DomainError('PRODUCT_ASSET_BINDING_VERSION_CONFLICT', '商品版本已变化，请刷新后重试', 409)
      if (error instanceof Error && error.message === 'PRODUCT_ASSET_BINDING_BRAND_MISMATCH') throw new DomainError('PRODUCT_ASSET_BINDING_BRAND_MISMATCH', '商品或素材不属于指定品牌', 403)
      if (error instanceof Error && error.message === 'PRODUCT_ASSET_BINDING_ASSET_NOT_FOUND') throw new DomainError('PRODUCT_ASSET_BINDING_ASSET_NOT_FOUND', '素材不存在或不属于当前工作区', 404)
      throw error
    }
  }
  if (req.method === 'GET' && productGetMatch) {
    const workspaceId = deps.resolveWorkspace(req)
    const product = deps.service.products.get(decodeURIComponent(productGetMatch[1]!))
    if (!product || product.workspaceId !== workspaceId) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在或不属于当前工作区', 404)
    await deps.enforceProductBrandAccess(req, workspaceId, product.id)
    return deps.send(res, 200, workspaceId, product, null, req)
  }
  const assetProductsMatch = path.match(/^\/v1\/assets\/([^/]+)\/products$/)
  if (req.method === 'GET' && assetProductsMatch) {
    const workspaceId = deps.resolveWorkspace(req)
    const assetId = decodeURIComponent(assetProductsMatch[1]!)
    const asset = deps.service.listAssets(workspaceId).find(item => item.id === assetId)
    if (!asset) throw new DomainError('ASSET_NOT_FOUND', '素材不存在或不属于当前工作区', 404)
    const accessibleIds = await deps.accessibleProductIds(req, workspaceId)
    if (deps.business) {
      const items = (await deps.business.listProductAssetBindings(workspaceId, { assetId })).filter(item => accessibleIds === undefined || accessibleIds.has(item.productId))
      return deps.send(res, 200, workspaceId, { items, source: 'normalized_relation' }, null, req)
    }
    const items = deps.service.listProducts(workspaceId).filter(product => (accessibleIds === undefined || accessibleIds.has(product.id)) && product.sourceAssetIds?.includes(assetId)).map(product => ({ workspaceId, productId: product.id, assetId, assetRole: 'source' as const, ordinal: product.sourceAssetIds!.indexOf(assetId) + 1, status: 'active' as const, createdAt: product.updatedAt, updatedAt: product.updatedAt }))
    return deps.send(res, 200, workspaceId, { items, source: 'compatibility_projection' }, null, req)
  }
  const productImageReviewMatch = path.match(/^\/v1\/products\/([^/]+)\/image-review$/)
  if (req.method === 'GET' && productImageReviewMatch) {
    const workspaceId = deps.resolveWorkspace(req)
    const productId = decodeURIComponent(productImageReviewMatch[1]!)
    await deps.enforceProductBrandAccess(req, workspaceId, productId)
    return deps.send(res, 200, workspaceId, deps.service.reviewProductImages(workspaceId, productId), null, req)
  }
}
