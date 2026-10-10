import type { AssetMetadata, Product } from './api.js'

export type ProductAssetRelation = {
  platform: Product['platform']
  boundIds: string[]
  matchedAssets: AssetMetadata[]
  missingAssetIds: string[]
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

/** A product's active bindings become generation sources, so every binding must
 * still be present, scan-clean, and rights-approved before continuing. */
export function productAssetGenerationBlockers(relation: ProductAssetRelation): string[] {
  const blockers: string[] = []
  if (relation.missingAssetIds.length > 0) {
    blockers.push('部分已绑定素材未返回详情；重新读取关系后再继续。')
  }
  if (relation.matchedAssets.some(asset => asset.scanStatus !== 'clean')) {
    blockers.push('已绑定素材尚未通过安全扫描；完成扫描或解除绑定后再继续。')
  }
  if (relation.matchedAssets.some(asset => asset.rightsStatus !== 'approved')) {
    blockers.push('已绑定素材尚未通过权益审核；完成审核或解除绑定后再继续。')
  }
  if (relation.matchedAssets.some(asset => {
    const scope = asset.rightsScope
    const usageScopes = asset.usageScopes ?? []
    return !['owned', 'commercial_authorized'].includes(scope ?? '') ||
      !usageScopes.includes('commercial') || !usageScopes.includes('ai_generation')
  })) {
    blockers.push('已绑定素材的权益范围不支持 AI 商用生成；补充明确授权或解除绑定后再继续。')
  }
  if (relation.matchedAssets.some(asset => asset.applicablePlatforms?.length && !asset.applicablePlatforms.includes(relation.platform))) {
    blockers.push('已绑定素材未授权用于当前商品平台；调整平台授权或解除绑定后再继续。')
  }
  const now = Date.now()
  if (relation.matchedAssets.some(asset =>
    (asset.validFrom !== undefined && (!Number.isFinite(Date.parse(asset.validFrom)) || Date.parse(asset.validFrom) > now)) ||
    (asset.validTo !== undefined && (!Number.isFinite(Date.parse(asset.validTo)) || Date.parse(asset.validTo) < now)))) {
    blockers.push('已绑定素材的授权有效期不覆盖当前时间；更新授权后再继续。')
  }
  return blockers
}
