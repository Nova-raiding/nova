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
