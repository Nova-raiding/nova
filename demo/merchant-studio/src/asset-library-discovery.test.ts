import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ASSET_LIBRARY_PAGE_SIZE, filterAssetLibrary, paginateAssetLibrary } from './asset-library-discovery.js'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

const assets = Array.from({ length: 123 }, (_, index) => ({
  id: `asset-${String(index + 1).padStart(3, '0')}`,
  name: `商品资料-${String(index + 1).padStart(3, '0')}.png`,
  mimeType: 'image/png',
  source: index === 120 ? 'merchant_upload' : 'store_sync',
  scanStatus: 'clean',
  parseStatus: 'succeeded',
  rightsStatus: 'approved',
  rightsScope: 'commercial_authorized',
}))

describe('knowledge asset discovery', () => {
  it('makes records beyond the old first-100 cap reachable through card pages', () => {
    const fifthPage = paginateAssetLibrary(assets, 5)
    const sixthPage = paginateAssetLibrary(assets, 6)
    expect(ASSET_LIBRARY_PAGE_SIZE).toBe(24)
    expect(fifthPage.items.map((asset) => asset.id)).toContain('asset-097')
    expect(sixthPage.items.map((asset) => asset.id)).toContain('asset-121')
    expect(sixthPage.items).toHaveLength(3)
    expect(sixthPage.pageCount).toBe(6)
  })

  it('searches all loaded assets, including entries past the old cap, by name and metadata', () => {
    expect(filterAssetLibrary(assets, '商品资料-121')).toEqual([assets[120]])
    expect(filterAssetLibrary(assets, 'merchant_upload')).toEqual([assets[120]])
    expect(filterAssetLibrary(assets, '   ')).toHaveLength(123)
  })

  it('clamps a stale page after a search reduces the result set', () => {
    const result = paginateAssetLibrary(filterAssetLibrary(assets, '商品资料-121'), 6)
    expect(result).toMatchObject({ page: 1, pageCount: 1, items: [assets[120]] })
  })

  it('wires search results and card pagination into the knowledge asset UI', () => {
    expect(appSource).toContain('filterAssetLibrary(orderedAssets, assetSearchQuery)')
    expect(appSource).toContain('paginateAssetLibrary(searchedAssets, assetCardPage, ASSET_LIBRARY_PAGE_SIZE)')
    expect(appSource).toContain('dataSource={searchedAssets}')
    expect(appSource).toContain('aria-label="资料分页"')
    expect(appSource).not.toContain('orderedAssets.slice(0, 100)')
  })
})
