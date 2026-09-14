import { DomainError, isTrustedCleanAsset, type AssetMetadata } from '../../../packages/application/src/service.js'
import { BusinessSnapshotNotFoundError } from '../../../packages/persistence/src/business-repository.js'

export type DeliveryAssetSource = {
  get(workspaceId: string, entityType: 'asset', assetRef: string): Promise<{ payload: Record<string, unknown> }>
}

/** Resolve fresh, workspace-scoped evidence after the caller's authorization.
 * A warm process cache is never authoritative when durable storage is enabled.
 * This validates admitted scanner evidence; it does not perform an upload/scan.
 */
export async function loadCustomerDeliveryAsset(input: {
  workspaceId: string
  assetRef: string
  business?: DeliveryAssetSource
  memoryAssets: ReadonlyMap<string, AssetMetadata>
}) {
  let candidate: unknown
  if (input.business) {
    try { candidate = (await input.business.get(input.workspaceId, 'asset', input.assetRef)).payload }
    catch (error) { if (!(error instanceof BusinessSnapshotNotFoundError)) throw error }
  } else candidate = input.memoryAssets.get(input.assetRef)

  const asset = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Partial<AssetMetadata> : undefined
  return asset?.id === input.assetRef && asset.workspaceId === input.workspaceId ? asset : undefined
}

export async function requireCustomerDeliveryAsset(input: Parameters<typeof loadCustomerDeliveryAsset>[0] & { purpose: 'contract' | 'video' }) {
  const asset = await loadCustomerDeliveryAsset(input)
  const ready = asset !== undefined && (() => typeof asset.storageKey === 'string' && typeof asset.scanReceiptId === 'string'
    && typeof asset.scanReceiptDigest === 'string'
    && isTrustedCleanAsset(asset as AssetMetadata)
    && (input.purpose !== 'video' || typeof asset.mimeType === 'string' && /^video\/[a-z0-9][a-z0-9.+-]*$/iu.test(asset.mimeType)))()
  if (!ready) {
    const label = input.purpose === 'video' ? '交付视频' : '合同文件'
    throw new DomainError(`CUSTOMER_DELIVERY_${input.purpose.toUpperCase()}_ASSET_NOT_READY`, `${label}必须引用当前工作区内已通过可信安全扫描的${input.purpose === 'video' ? '视频' : '素材'}`, 409)
  }
}
