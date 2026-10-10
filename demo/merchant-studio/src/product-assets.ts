import type { AssetMetadata, Product } from './api.js'

export type ProductAssetRelation = {
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
  return blockers
}
