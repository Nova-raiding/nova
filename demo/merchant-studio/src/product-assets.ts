import type { AssetMetadata, Product } from './api.js'

export type ProductAssetRelation = {
  platform: Product['platform']
  boundIds: string[]
  matchedAssets: AssetMetadata[]
  missingAssetIds: string[]
}

export function productAssetHasTrustedCleanScanEvidence(asset: AssetMetadata): boolean {
  const workspaceId = asset.workspaceId?.trim() ?? ''
  const receiptId = asset.scanReceiptId?.trim() ?? ''
  const storageKey = asset.storageKey?.trim() ?? ''
  if (!workspaceId || workspaceId !== asset.workspaceId || /[\\/]/u.test(workspaceId)) return false
  if (asset.scanStatus !== 'clean' || asset.scanVerdict !== 'clean') return false
  if (receiptId !== asset.scanReceiptId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(receiptId)) return false
  if (!/^[a-f0-9]{64}$/u.test(asset.scanReceiptDigest ?? '')) return false
  const prefix = `clean/${workspaceId}/`
  if (storageKey !== asset.storageKey || !storageKey.startsWith(prefix) || storageKey.length === prefix.length || storageKey.includes('\\')) return false
  return storageKey.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * Builds a read-only view from authoritative product sourceAssetIds.
 * It intentionally does not infer relationships from filenames, images, or
 * workspace-wide asset metadata.
 */
export function resolveProductAssetRelation(product: Product, assets: AssetMetadata[]): ProductAssetRelation {
  const boundIds = [...new Set(product.sourceAssetIds ?? [])]
  const assetById = new Map(assets.map(asset => [asset.id, asset]))
  return {
    platform: product.platform,
    boundIds,
    matchedAssets: boundIds.flatMap(id => {
      const asset = assetById.get(id)
      return asset ? [asset] : []
    }),
    missingAssetIds: boundIds.filter(id => !assetById.has(id)),
  }
}

/** Shared policy for both the relation summary and each asset's status badge. */
export function productAssetGenerationBlockersForAsset(asset: AssetMetadata, platform: Product['platform']): string[] {
  const blockers: string[] = []
  if (!asset.mimeType.toLowerCase().startsWith('image/')) {
    blockers.push('此素材不是图片；图片生成仅支持 image/* 素材。')
  }
  if (!productAssetHasTrustedCleanScanEvidence(asset) || asset.display?.primaryStatus === 'awaiting_scan' || asset.readiness?.reasons.includes('安全扫描凭据缺失或无效')) {
    blockers.push('素材尚未通过可信安全扫描；完成扫描后再继续。')
  }
  if (asset.rightsStatus !== 'approved') blockers.push('已绑定素材尚未通过权益审核；完成审核或解除绑定后再继续。')
  const usageScopes = asset.usageScopes ?? []
  if (!['owned', 'commercial_authorized'].includes(asset.rightsScope ?? '') ||
    !usageScopes.includes('commercial') || !usageScopes.includes('ai_generation')) {
    blockers.push('已绑定素材的权益范围不支持 AI 商用生成；补充明确授权或解除绑定后再继续。')
  }
  if (asset.aiModificationAllowed !== true) {
    blockers.push('尚未明确允许 AI 修改此素材；请在素材权益中确认许可后再继续。')
  }
  if (asset.applicablePlatforms?.length && !asset.applicablePlatforms.includes(platform)) {
    blockers.push('已绑定素材未授权用于当前商品平台；调整平台授权或解除绑定后再继续。')
  }
  const now = Date.now()
  if ((asset.validFrom !== undefined && (!Number.isFinite(Date.parse(asset.validFrom)) || Date.parse(asset.validFrom) > now)) ||
    (asset.validTo !== undefined && (!Number.isFinite(Date.parse(asset.validTo)) || Date.parse(asset.validTo) < now))) {
    blockers.push('已绑定素材的授权有效期不覆盖当前时间；更新授权后再继续。')
  }
  return blockers
}

export function productAssetGenerationSourceStatus(asset: AssetMetadata | null, platform: Product['platform']): {
  tone: 'green' | 'amber'
  label: string
} {
  if (!asset) return { tone: 'amber', label: '素材未找到' }
  return productAssetGenerationBlockersForAsset(asset, platform).length === 0
    ? { tone: 'green', label: '可作为生成来源' }
    : { tone: 'amber', label: '暂不能作为生成来源' }
}

/** A product's active bindings become generation sources, so every binding must
 * still be present, scan-clean, and rights-approved before continuing. */
export function productAssetGenerationBlockers(relation: ProductAssetRelation): string[] {
  const blockers = relation.missingAssetIds.length > 0
    ? ['部分已绑定素材未返回详情；重新读取关系后再继续。']
    : []
  for (const asset of relation.matchedAssets) blockers.push(...productAssetGenerationBlockersForAsset(asset, relation.platform))
  return [...new Set(blockers)]
}
