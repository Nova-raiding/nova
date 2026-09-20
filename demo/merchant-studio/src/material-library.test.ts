import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AssetMetadata } from './api'
import {
  MATERIAL_UNREAD,
  formatMaterialFileSize,
  materialAddedAtFromAsset,
  materialCategoryFromMimeType,
  materialDownloadHref,
  materialEmptyCopy,
  materialFormatFromMimeType,
  materialItemFromAsset,
  materialSummaryText,
  resolveMaterialRead,
} from './material-library'
import assetsCapture from './fixtures/assets.capture.json'

/**
 * The fixture is a verbatim capture of a real response, not a hand-written stub:
 *
 *   GET /api/v1/assets?limit=50&offset=0 → assets.capture.json
 *
 * captured over the merchant session (Vite proxy → API), workspace ws_demo, on
 * 2026-09-20, right after `POST /v1/assets/upload` accepted one PNG. It records
 * what the material library must render: one asset whose only known facts are
 * its name, its `image/png` type, 95 bytes and a creation time — plus a
 * `storage_quota` projection the page may use.
 *
 * Before this module existed the library rendered eight invented materials per
 * store with invented dimensions, invented upload dates and a
 * `data:text/plain;charset=utf-8,...` "download"; the defect survived because
 * `catalog-data.test.ts` declared this surface "deliberately out of scope".
 */
const assets = (assetsCapture as { data: { items: AssetMetadata[] } }).data.items
const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
// Exactly the material surfaces: the recycle bin and the library/brand
// workspace, up to the product catalogue component that follows them.
const materialLibrarySource = appSource.slice(
  appSource.indexOf('export function MaterialRecycleBinWorkspace'),
  appSource.indexOf('function Products('),
)

describe('a material card is built from the server row', () => {
  it('carries the server name, MIME format, byte size and creation date', () => {
    const item = materialItemFromAsset(assets[0]!)
    expect(item).toMatchObject({
      id: 'asset_cf71b39b-33f4-49bd-82f4-143b8f1b18a1',
      assetId: 'asset_cf71b39b-33f4-49bd-82f4-143b8f1b18a1',
      name: 'qa-packaging-main.png',
      format: 'PNG',
      fileSizeLabel: '1 KB',
      addedAt: '2026-09-20',
      bytes: 95,
    })
  })

  it('never invents a dimension, a category or a store attribution', () => {
    const item = materialItemFromAsset(assets[0]!)
    // `GET /v1/assets` publishes no pixel dimensions, so the card may not show
    // the「1200 × 1200」the seed used to make up.
    expect(item.sizeLabel).toBe(MATERIAL_UNREAD)
    // 素材分类 is the merchant's own labelling and the asset read carries none.
    expect(item.category).toBe('未分类')
    // An image that is not obviously a video stays unclassified; only the
    // medium is a server fact.
    expect(materialCategoryFromMimeType('video/mp4')).toBe('商品视频')
    expect(materialCategoryFromMimeType('image/png')).toBe('未分类')
    expect(materialCategoryFromMimeType('')).toBe('未分类')
  })

  it('reports 未读取 instead of zero for facts the server did not publish', () => {
    expect(materialFormatFromMimeType('')).toBe(MATERIAL_UNREAD)
    expect(materialFormatFromMimeType('application/x-unknown')).toBe('X-UNKNOWN')
    expect(materialAddedAtFromAsset({} as AssetMetadata)).toBe('')
    expect(materialAddedAtFromAsset({ createdAt: 'not-a-date' } as AssetMetadata)).toBe('')
    expect(formatMaterialFileSize(Number.NaN)).toBe(MATERIAL_UNREAD)
    // A real, empty name is not a licence to print a blank card.
    expect(materialItemFromAsset({ id: 'a', name: '  ' } as AssetMetadata).name).toBe(MATERIAL_UNREAD)
  })

  it('keeps the file size honest across the KB/MB boundary', () => {
    expect(formatMaterialFileSize(95)).toBe('1 KB')
    expect(formatMaterialFileSize(2048)).toBe('2 KB')
    expect(formatMaterialFileSize(1.8 * 1024 * 1024)).toBe('1.8 MB')
  })

  it('links the download to the authenticated endpoint, never to a data: URL', () => {
    const item = materialItemFromAsset(assets[0]!)
    // The old card carried `data:text/plain;charset=utf-8,...`, so 「下载」 saved
    // a four-line text file. The link must be the real asset endpoint.
    expect(item.downloadUrl).not.toMatch(/^data:/)
    expect(materialDownloadHref(item, '/api')).toBe(`/api/v1/assets/${item.assetId}/download`)
    expect(materialDownloadHref(item, 'http://127.0.0.1:28181')).toBe(`http://127.0.0.1:28181/v1/assets/${item.assetId}/download`)
    // A session upload has no server id and keeps its own object URL.
    expect(materialDownloadHref({ downloadUrl: 'blob:session-upload' }, '/api')).toBe('blob:session-upload')
  })
})

describe('the library says which of the four states it is in', () => {
  it('never states a count for a read that has not answered', () => {
    // The exact failure that shipped: no API base URL at all, and the page
    // still claimed 「找到 8 项素材」 because the count came from a local array.
    const unread = resolveMaterialRead({ baseUrl: undefined, remote: null, error: '' })
    expect(unread).toEqual({ state: 'unread', items: [], error: '' })
    expect(materialSummaryText(unread)).toBe('未配置 API，素材未读取')
    expect(materialSummaryText(unread)).not.toMatch(/\d/u)

    const loading = resolveMaterialRead({ baseUrl: 'http://127.0.0.1:9', remote: null, error: '' })
    expect(loading.state).toBe('loading')
    expect(materialSummaryText(loading)).toBe('正在读取素材…')

    const failed = resolveMaterialRead({ baseUrl: 'http://127.0.0.1:9', remote: null, error: '素材读取失败：HTTP 500' })
    expect(failed.state).toBe('error')
    expect(materialSummaryText(failed)).toContain('HTTP 500')
    expect(materialEmptyCopy(failed).detail).toContain('不会用本地演示数据替代服务端素材')
  })

  it('separates a completed empty read from an unread one', () => {
    const empty = resolveMaterialRead({ baseUrl: 'http://127.0.0.1:9', remote: [], error: '' })
    expect(empty.state).toBe('ready')
    expect(empty.items).toEqual([])
    // A completed read that returned nothing is a real answer: 「没有素材」.
    expect(materialEmptyCopy(empty)).toEqual({ title: '当前条件下没有素材', detail: '调整搜索或分类，也可以直接上传到当前店铺。' })
  })

  it('maps the real capture into one ready card', () => {
    const ready = resolveMaterialRead({ baseUrl: 'http://127.0.0.1:9', remote: assets, error: '' })
    expect(ready.state).toBe('ready')
    expect(ready.items).toHaveLength(1)
    expect(ready.items[0]!.name).toBe('qa-packaging-main.png')
    expect(ready.items[0]!.downloadUrl).toBe('')
  })
})

describe('the fabricated material data is gone, not just unreferenced', () => {
  it('no longer carries the seed builders or the text "downloads"', () => {
    // The slice must be real: if the markers move, fail loudly rather than
    // silently asserting over an empty string.
    expect(materialLibrarySource.length).toBeGreaterThan(5_000)
    // Removing the call sites is not enough: dead builders get wired back.
    for (const removed of ['demoStoreMaterials', 'demoMaterialStores', 'initialRecycleMaterials']) {
      expect(appSource, `${removed} must be deleted, not left dead`).not.toContain(removed)
    }
    // The fabricated recycle-bin record, in the form a restore would take.
    expect(appSource).not.toContain("id: 'recycle-demo-packaging-v1'")
    // The invented payloads the two seeds handed out, and the text "downloads"
    // they produced, may not come back inside the material surfaces.
    expect(materialLibrarySource).not.toContain('演示素材文件')
    expect(materialLibrarySource).not.toContain('回收站演示素材')
    // The card link is the shared helper, not a raw field: `href={item.downloadUrl}`
    // is exactly how the `data:text/plain` download reached the merchant.
    expect(materialLibrarySource).not.toContain('item.downloadUrl}')
    expect(materialLibrarySource).not.toContain('detailMaterial.downloadUrl}')
    // Both download links (the card and the detail page) go through it.
    expect(materialLibrarySource.match(/materialDownloadHref\(/gu) ?? []).toHaveLength(2)
    // One data: URL may remain in these surfaces: 「下载已选」, whose download
    // name says 清单 (a list of the selected material names, not the bytes).
    // A second one is a material card serving made-up file content again.
    expect(materialLibrarySource.match(/data:text\/plain;charset=utf-8/gu) ?? []).toHaveLength(1)
    expect(materialLibrarySource).toContain('已选素材清单.txt')
  })

  it('reads the material list from the server through the passed base url', () => {
    expect(appSource).toContain('fetchAssets(baseUrl)')
    expect(appSource).toContain('resolveMaterialRead({ baseUrl, remote: remoteAssets')
    expect(appSource).toContain('materialDownloadHref(item, baseUrl)')
    // The store list is the catalogue's own read, so the two pages can no
    // longer disagree about how many stores the workspace has.
    expect(appSource).toContain('buildCatalogPlatforms(accounts, products)')
    expect(appSource).toContain('catalogStoreForMaterials')
  })
})
