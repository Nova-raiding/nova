import { DomainError, isTrustedCleanAsset, type AssetMetadata } from '../../../packages/application/src/service.js'
import { BusinessSnapshotNotFoundError } from '../../../packages/persistence/src/business-repository.js'
import type { CustomerDeliveryUploadPurpose } from './customer-delivery-upload.js'

const DOCUMENT_MIMES = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg'])

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

export async function requireCustomerDeliveryAsset(input: Parameters<typeof loadCustomerDeliveryAsset>[0] & { purpose: CustomerDeliveryUploadPurpose }) {
  const asset = await loadCustomerDeliveryAsset(input)
  const ready = asset !== undefined && (() => typeof asset.storageKey === 'string' && typeof asset.scanReceiptId === 'string'
    && typeof asset.scanReceiptDigest === 'string'
    && isTrustedCleanAsset(asset as AssetMetadata)
    && typeof asset.mimeType === 'string'
    && (input.purpose === 'video' ? /^video\/[a-z0-9][a-z0-9.+-]*$/iu.test(asset.mimeType) : DOCUMENT_MIMES.has(asset.mimeType.toLowerCase())))()
  if (!ready) {
    const label = ({ contract: '合同文件', payment: '付款凭证', system_integration: '系统接入凭证', functional_acceptance: '功能验收凭证', training: '培训凭证', video: '交付视频' } as const)[input.purpose]
    throw new DomainError(`CUSTOMER_DELIVERY_${input.purpose.toUpperCase()}_ASSET_NOT_READY`, `${label}必须引用当前工作区内已通过可信安全扫描的${input.purpose === 'video' ? '视频' : '素材'}`, 409)
  }
}
