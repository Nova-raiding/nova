import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const productRoutes = readFileSync(new URL('../../../apps/api/src/http-product-write-routes.ts', import.meta.url), 'utf8')

describe('merchant material-to-product asset journey contract', () => {
  it('loads persisted workspace assets when the product import form opens and renders their eligibility', () => {
    const openImport = app.slice(app.indexOf('const openImport = () =>'), app.indexOf('const importLocalProduct = async () =>'))
    const picker = app.slice(app.indexOf('<fieldset className="import-asset-picker">'), app.indexOf('</fieldset>', app.indexOf('<fieldset className="import-asset-picker">')))

    expect(openImport).toContain('fetchAssets(baseUrl)')
    expect(openImport).toContain('.then(setImportAssets)')
    expect(openImport).toContain('setImportAssetsLoading(true)')
    expect(openImport).toContain('.finally(() => setImportAssetsLoading(false))')
    expect(picker).toContain('{importAssets.map((asset) => (')
    expect(picker).toContain('checked={selectedImportAssetIds.includes(asset.id)}')
    expect(picker).toContain("asset.scanStatus === 'clean'")
    expect(picker).toContain("asset.rightsStatus === 'approved'")
    expect(picker).toContain('需先完成扫描与权益确认')
    expect(picker).toContain('绑定会随商品导入请求提交到服务端；取消导入不会产生绑定。')
  })

  it('submits only the selected asset IDs through the shared API client and preserves them at the HTTP boundary', () => {
    const submit = app.slice(app.indexOf('const importLocalProduct = async () =>'), app.indexOf('const toggleTarget ='))
    const importApi = api.slice(api.indexOf('export const importProduct ='), api.indexOf('\n', api.indexOf('export const importProduct =')))
    const route = productRoutes.slice(productRoutes.indexOf("path === '/v1/products/import'"), productRoutes.indexOf('const productConfirmMatch'))

    expect(submit).toContain('...(selectedImportAssetIds.length')
    expect(submit).toContain('{ asset_ids: selectedImportAssetIds }')
    expect(submit).toContain('await importProduct(baseUrl, {')
    expect(submit).toContain('setImportOpen(false)')
    expect(submit).toContain('setImportError(describeApiError(cause))')
    expect(importApi).toContain("'/v1/products/import'")
    expect(importApi).toContain('body: JSON.stringify(input)')
    expect(route).toContain('rawAssetIds = input.asset_ids')
    expect(route).toContain('sourceAssetIds ? { sourceAssetIds } : {}')
  })

  it('keeps library previews tied to downloaded server bytes rather than filenames or fabricated URLs', () => {
    const previewLoader = app.slice(app.indexOf('const [materialPreviews, setMaterialPreviews]'), app.indexOf('const activeStore = materialStores.find'))
    const materialCard = app.slice(app.indexOf('className="material-card-open"'), app.indexOf('</button>', app.indexOf('className="material-card-open"')))

    expect(previewLoader).toContain("asset.scanStatus === 'clean' || asset.scanStatus === 'unscanned'")
    expect(previewLoader).toContain("asset.mimeType.toLowerCase().startsWith('image/')")
    expect(previewLoader).toContain('.slice(0, 24)')
    expect(previewLoader).toContain('fetchAssetBlob(baseUrl, asset.id, controller.signal)')
    expect(previewLoader).toContain('probe.onload = () => resolve(true)')
    expect(previewLoader).toContain('URL.revokeObjectURL(url)')
    expect(previewLoader).toContain('setMaterialPreviews(Object.fromEntries(previews))')
    expect(materialCard).toContain('item.previewUrl')
    expect(materialCard).toContain('<img src={item.previewUrl}')
    expect(materialCard).not.toContain('data:image/')
  })
})
