import type { AssetMetadata } from './api.js'

export const ASSET_LIBRARY_PAGE_SIZE = 24

/** Search every loaded workspace asset by the fields merchants can inspect. */
type SearchableAsset = Pick<AssetMetadata, 'name' | 'mimeType' | 'scanStatus' | 'parseStatus' | 'rightsStatus' | 'rightsScope'> & { source?: string }

export function filterAssetLibrary<T extends SearchableAsset>(
  assets: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...assets]
  return assets.filter((asset) => [
    asset.name,
    asset.mimeType,
    asset.source,
    asset.scanStatus,
    asset.parseStatus,
    asset.rightsStatus,
    asset.rightsScope,
  ].some((value) => String(value ?? '').toLocaleLowerCase().includes(needle)))
}

export function paginateAssetLibrary<T>(assets: readonly T[], requestedPage: number, pageSize = ASSET_LIBRARY_PAGE_SIZE) {
  const safePageSize = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : ASSET_LIBRARY_PAGE_SIZE
  const pageCount = Math.max(1, Math.ceil(assets.length / safePageSize))
  const page = Number.isSafeInteger(requestedPage) ? Math.min(pageCount, Math.max(1, requestedPage)) : 1
  return { page, pageCount, items: assets.slice((page - 1) * safePageSize, page * safePageSize) }
}
