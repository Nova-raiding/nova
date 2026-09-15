import { createHash } from 'node:crypto'
import { DomainError, isTrustedCleanAsset, type AssetMetadata } from '../../../packages/application/src/service.js'

export const CUSTOMER_DELIVERY_UPLOAD_MAX_BYTES = 50 * 1024 * 1024
const documentMimes = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg'])
const videoMimes = new Set(['video/mp4', 'video/webm'])
export const CUSTOMER_DELIVERY_DOCUMENT_PURPOSES = ['contract', 'payment', 'system_integration', 'functional_acceptance', 'training'] as const
export type CustomerDeliveryUploadPurpose = typeof CUSTOMER_DELIVERY_DOCUMENT_PURPOSES[number] | 'video'

export function customerDeliveryUploadPurpose(value: unknown): CustomerDeliveryUploadPurpose {
  if (value !== 'video' && !CUSTOMER_DELIVERY_DOCUMENT_PURPOSES.includes(value as never)) throw new DomainError('INVALID_REQUEST', '上传用途必须是合同、付款、系统接入、功能验收、培训或交付视频', 400)
  return value as CustomerDeliveryUploadPurpose
}

export function validateCustomerDeliveryUpload(input: Record<string, unknown>) {
  const purpose = customerDeliveryUploadPurpose(input.purpose)
  const mimeType = typeof input.mime_type === 'string' ? input.mime_type.trim().toLowerCase() : ''
  if (!(purpose === 'video' ? videoMimes : documentMimes).has(mimeType)) throw new DomainError('CUSTOMER_DELIVERY_UPLOAD_TYPE_UNSUPPORTED', purpose === 'video' ? '交付视频支持 MP4 和 WebM' : '交付凭证支持 PDF、DOCX、PNG 和 JPEG', 400)
  const encoded = typeof input.content_base64 === 'string' ? input.content_base64 : ''
  if (!encoded || encoded.length > 4 * Math.ceil(CUSTOMER_DELIVERY_UPLOAD_MAX_BYTES / 3)) throw new DomainError('CUSTOMER_DELIVERY_UPLOAD_SIZE_LIMIT', '每个交付文件须大于 0 字节且不超过 50 MiB', 413)
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new DomainError('INVALID_REQUEST', 'content_base64 无效', 400)
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > CUSTOMER_DELIVERY_UPLOAD_MAX_BYTES) throw new DomainError('CUSTOMER_DELIVERY_UPLOAD_SIZE_LIMIT', '每个交付文件须大于 0 字节且不超过 50 MiB', 413)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (input.sha256 !== undefined && input.sha256 !== digest) throw new DomainError('CUSTOMER_DELIVERY_UPLOAD_DIGEST_MISMATCH', '文件校验值不一致，请重新选择文件', 400)
  // Filename / extension / byte signature checks remain in the shared upload
  // admission path, before quarantine storage and the real scanner outbox.
  return { purpose, mimeType, sha256: digest }
}

export function customerDeliveryUploadView(asset: Partial<AssetMetadata> | undefined, purpose: CustomerDeliveryUploadPurpose) {
  const mimeType = typeof asset?.mimeType === 'string' ? asset.mimeType.trim().toLowerCase() : ''
  if (!asset || typeof asset.id !== 'string' || typeof asset.name !== 'string' || typeof asset.sizeBytes !== 'number'
    || !(purpose === 'video' ? videoMimes : documentMimes).has(mimeType)) throw new DomainError('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND', '文件不存在、不属于当前工作区或上传用途不匹配', 404)
  const trusted = typeof asset.workspaceId === 'string' && typeof asset.storageKey === 'string'
    && typeof asset.scanReceiptId === 'string' && typeof asset.scanReceiptDigest === 'string'
    && isTrustedCleanAsset(asset as AssetMetadata)
  const scanStatus = trusted ? 'clean' : asset.scanStatus === 'blocked' || asset.scanStatus === 'clean' ? 'blocked' : 'pending'
  return { assetRef: asset.id, name: asset.name, mimeType, sizeBytes: asset.sizeBytes, scanStatus, ready: trusted }
}
