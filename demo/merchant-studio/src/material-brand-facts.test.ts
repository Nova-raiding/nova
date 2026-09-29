import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrandScopeUnavailableRow, MaterialBrandFields, MaterialBrandOutput, MaterialLibraryWorkspace, imageBrandSaveEntries } from './App'
import type { AssetMetadata, PlatformAccount, Product } from './api'
import {
  BRAND_DOCUMENT_LOCAL_ONLY,
  BRAND_DOCUMENT_NONE,
  BRAND_DOCUMENT_PENDING,
  BRAND_LOCAL_ONLY,
  BRAND_LOGO_LOCAL_ONLY,
  BRAND_UNCONFIGURED,
  resolveBrandColorFacts,
  resolveBrandDocumentFacts,
  resolveBrandLogoFacts,
} from './material-brand-facts'
import platformAccountsCapture from './fixtures/platform-accounts.capture.json'
import productsCapture from './fixtures/products.capture.json'

/**
 * The 品牌配置 panes claimed two server facts they did not have.
 *
 * Live reproduction against the shipped build (real browser, request-logging
 * proxy in front of the local API, 2026-09-20): picking `brand-doc.txt` on
 * 品牌资产 put 「品牌资产文档 · brand-doc.txt · 已接收」 on all four levels of the
 * stack and filled 用户画像/品牌卖点 from the file's text — while the request log
 * recorded **zero** requests for the pick, and a reload brought back
 * 「暂无资产文件 · 待接收」. The same card printed 「品牌主色 #17543C」, the app's own
 * theme green, for a workspace whose `GET /v1/brand-profile` answers
 * `{"profile": null}` and whose Logo row correctly said 「未单独配置」.
 */
const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const brandAssetSource = readFileSync(new URL('./material-brand-assets.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const accounts = (platformAccountsCapture as { data: { items: PlatformAccount[] } }).data.items
const products = (productsCapture as { data: { items: Product[] } }).data.items

const storage = new Map<string, string>()
beforeEach(() => {
  storage.clear()
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) }, removeItem: (key: string) => { storage.delete(key) }, clear: () => storage.clear() },
    location: { pathname: '/merchant/products', search: '?section=assets', href: 'http://127.0.0.1/merchant/products?section=assets' },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  })
})
afterEach(() => vi.unstubAllGlobals())

const settings = (color: string, assetFileName: string) => ({ logoUrl: '', color, persona: '', sellingPoints: '', personaFileName: '', sellingPointsFileName: '', assetFileName })
const card = (color: string, assetFileName: string) => renderToStaticMarkup(createElement(MaterialBrandOutput, {
  value: settings(color, assetFileName),
  label: '全局配置',
  enabled: true,
}))
/** The same card with an image the merchant picked in this browser. */
const pickedLogo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
const cardWithLogo = (assetFileName = '') => renderToStaticMarkup(createElement(MaterialBrandOutput, {
  value: { ...settings('', assetFileName), logoUrl: pickedLogo },
  label: '全局配置',
  enabled: true,
}))

describe('single-image brand settings save path', () => {
  it('keeps an explicit save button in the image detail view wired to image edits', () => {
    const detail = appSource.slice(appSource.indexOf('if (detailMaterial) {'), appSource.indexOf('  return (\n    <div className="material-library-page"', appSource.indexOf('if (detailMaterial) {')))
    const save = appSource.slice(appSource.indexOf('const saveMaterialBrandScopes = async () => {'), appSource.indexOf('const createBrandSeries = async () => {'))

    expect(detail).toContain('onClick={() => { void saveMaterialBrandScopes() }}')
    expect(detail).toContain('保存品牌配置')
    expect(detail).toContain('setImageBrands((current) => ({ ...current, [detailMaterial.id]: next }))')
    expect(detail).toContain('setImageBrandEnabled((current) => ({ ...current, [detailMaterial.id]: enabled }))')
    expect(detail).toContain('setScopedBrandDraftDirty(true); setScopedBrandError(\'\'); setScopedBrandSaved(\'\')')
    expect(detail).toContain('{(scopedBrandDraftDirty || scopedBrandError || scopedBrandSaved) && <div className="material-brand-save-row">')
    expect(save).toContain('for (const [assetId, value] of imageBrandSaveEntries(imageBrands, imageBrandEnabled))')
    expect(save).toContain('enabled: imageBrandEnabled[assetId] ?? true')
    expect(save).toContain('await saveScopedBrandSettings(baseUrl, settings, scopedBrandRead.revision)')
  })

  it('includes a new image whose only edit is disabling its brand override', () => {
    const entries = imageBrandSaveEntries({}, { 'asset-new-image': false })
    expect(entries).toEqual([['asset-new-image', settings('', '')]])
    const detail = appSource.slice(appSource.indexOf('if (detailMaterial) {'), appSource.indexOf('  return (\n    <div className="material-library-page"', appSource.indexOf('if (detailMaterial) {')))
    expect(detail).toContain('setImageBrandContexts((current) => ({ ...current, [detailMaterial.id]: { accountId: activeStoreId, seriesName: detailMaterial.series } }))')
  })

  it('shows server-confirmed store attribution in image details', () => {
    const detail = appSource.slice(appSource.indexOf('if (detailMaterial) {'), appSource.indexOf('  return (\n    <div className="material-library-page"', appSource.indexOf('if (detailMaterial) {')))
    expect(detail).toContain('assignmentByAsset.get(detailMaterial.id)?.accountId === activeStore.id')
    expect(detail).toContain("detailAssignedToStore ? activeStore.name : '未归属'")
  })
})

describe('a locally picked document is never called received', () => {
  it('says the document is local and unsent, because no request is made', () => {
    expect(resolveBrandDocumentFacts('brand-doc.txt')).toEqual({
      fileName: 'brand-doc.txt',
      uploaded: false,
      label: BRAND_DOCUMENT_LOCAL_ONLY,
      pending: false,
    })
    expect(BRAND_DOCUMENT_LOCAL_ONLY).toBe('仅本地，未上传')
  })

  it('keeps the two facts it can stand behind for an empty pane', () => {
    expect(resolveBrandDocumentFacts('')).toMatchObject({ fileName: '', label: BRAND_DOCUMENT_PENDING, pending: true })
    expect(resolveBrandDocumentFacts('   ')).toMatchObject({ fileName: '', pending: true })
    expect(BRAND_DOCUMENT_PENDING).toBe('待接收')
    expect(card('', '')).toContain(BRAND_DOCUMENT_NONE)
  })

  it('renders the received word for no document this pane can produce', () => {
    // The mutation this catches is the shipped code: any non-empty name was
    // rendered as 「已接收」.
    const html = card('', 'brand-doc.txt')
    expect(html).toContain('brand-doc.txt')
    expect(html).toContain(BRAND_DOCUMENT_LOCAL_ONLY)
    expect(html).not.toContain('已接收')
  })

  it('uploads a selected document and stores the server asset identity', () => {
    const pane = appSource.slice(appSource.indexOf('function MaterialBrandFields('), appSource.indexOf('type RecycleMaterialItem'))
    expect(pane.length).toBeGreaterThan(3_000)
    expect(pane).toContain('uploadAsset(baseUrl, file)')
    expect(pane).toContain('documentAssetId: uploaded.id')
    expect(pane).toContain('onAssetUploaded?.(uploaded, kind, file)')
    const existingDoc = { id: 'asset-existing-brand-doc', name: 'brand-guide.pdf', mimeType: 'application/pdf', scanStatus: 'clean', rightsStatus: 'approved', parseStatus: 'succeeded', rightsScope: 'commercial_authorized', factsConfirmedBy: 'merchant-1', factsConfirmedAt: '2026-09-29T00:00:00Z', readiness: { status: 'ready', reasons: [] }, contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true }, references: [], revision: 1, sizeBytes: 10, createdAt: '2026-09-29T00:00:00Z' } as AssetMetadata
    const fields = renderToStaticMarkup(createElement(MaterialBrandFields, { value: settings('', ''), onChange: () => undefined, label: '全局', assets: [existingDoc] }))
    expect(fields).toContain('上传文档')
    expect(fields).toContain('选择已上传品牌文档')
    expect(fields).toContain('brand-guide.pdf · 已就绪')
    expect(pane).toContain('未配置 API，品牌素材无法上传到服务端。')
  })

  it('routes the card through the resolver instead of an inline claim', () => {
    const cardSource = appSource.slice(appSource.indexOf('export function MaterialBrandOutput'), appSource.indexOf('type RecycleMaterialItem'))
    expect(cardSource.length).toBeGreaterThan(1_000)
    expect(cardSource).toContain('resolveBrandDocumentFacts(value.assetFileName)')
    expect(cardSource).toContain('documentFacts.label')
    // The literal may only live in the module that documents why it is true.
    expect(cardSource).not.toContain('已接收')
    expect(styles).not.toContain('已接收')
  })
})

/**
 * The same card called the document 「仅本地，未上传」 and the Logo 「生效」.
 *
 * Live reproduction (real browser behind a request-logging proxy, 2026-09-20):
 * picking `brand-logo-probe.png` on 品牌资产 produced **zero** requests, and the
 * 全局/店铺/系列 cards then rendered `alt="…生效 Logo"` — while the document row of
 * that same card, after `brand-doc.txt` was picked on the same page in the same
 * session, read 「brand-doc.txt · 仅本地，未上传」. Two rows, one origin (a
 * `FileReader` reading a local file into React state), two opposite claims.
 */
describe('a Logo read in this browser is never called 生效', () => {
  it('reports a picked Logo as local and unsent, because no request is made', () => {
    expect(resolveBrandLogoFacts(pickedLogo)).toEqual({
      picked: true,
      uploaded: false,
      label: '仅本地，未上传',
      imageAlt: 'Logo 本地预览（仅本地，未上传）',
    })
    expect(resolveBrandLogoFacts('')).toEqual({ picked: false, uploaded: false, label: BRAND_UNCONFIGURED, imageAlt: '' })
    expect(resolveBrandLogoFacts('   ')).toMatchObject({ picked: false, label: BRAND_UNCONFIGURED })
  })

  it('prints the same sentence as the document row of the same card', () => {
    // The defect was these two rows disagreeing, so the assertion is that they
    // agree on one shared literal rather than on two copies of it.
    expect(BRAND_LOGO_LOCAL_ONLY).toBe(BRAND_DOCUMENT_LOCAL_ONLY)
    const html = cardWithLogo('brand-doc.txt')
    expect(html).toContain('brand-doc.txt')
    expect(html).toContain(pickedLogo)
    // One occurrence for the Logo row, one for the Logo preview's alt, one for
    // the document row — and no state where one of them says something else.
    const sentences = html.split(BRAND_LOCAL_ONLY).length - 1
    expect(sentences).toBe(2)
    expect(html).not.toContain(BRAND_DOCUMENT_PENDING)
  })

  it('renders the shipped claim for no Logo this pane can produce', () => {
    // The mutation this catches is the shipped code: `alt={`${label}生效 Logo`}`.
    const html = cardWithLogo()
    expect(html).not.toContain('生效')
    expect(html).toContain('仅本地，未上传')
    expect(html).toMatch(/alt="全局配置 Logo 预览"/u)
    // The scope label survives, so four stacked cards stay distinguishable.
    expect(html).toContain('全局配置')
  })

  it('uploads a Logo, links the returned asset ID, and revokes the local preview URL', () => {
    const pane = appSource.slice(appSource.indexOf('function MaterialBrandFields('), appSource.indexOf('type RecycleMaterialItem'))
    expect(pane).toContain('logoAssetId: uploaded.id')
    expect(brandAssetSource).toContain('URL.createObjectURL(file)')
    expect(brandAssetSource).toContain('URL.revokeObjectURL(url)')
    expect(appSource).toContain('brandAssetPreviewRegistry.current.clear()')
    expect(pane).toContain('品牌素材上传失败：')
    const fields = renderToStaticMarkup(createElement(MaterialBrandFields, { value: settings('', ''), onChange: () => undefined, label: '全局' }))
    expect(fields).toContain('上传 Logo')
    expect(renderToStaticMarkup(createElement(MaterialBrandFields, { value: { ...settings('', ''), logoAssetId: 'asset-real-1' }, onChange: () => undefined, label: '全局' }))).toContain('重新上传 Logo')
  })

  it('routes the card through the resolver instead of an inline claim', () => {
    const cardSource = appSource.slice(appSource.indexOf('export function MaterialBrandOutput'), appSource.indexOf('type RecycleMaterialItem'))
    expect(cardSource).toContain('resolveBrandLogoFacts(logoPreviewUrl)')
    expect(cardSource).toContain('logoFacts.label')
    // The claim may only live in the module that documents why it is false.
    expect(cardSource).not.toContain('生效')
    expect(styles).not.toContain('生效 Logo')
  })
})

describe('a default colour is not a brand colour', () => {
  it('reports an unconfigured colour as unconfigured', () => {
    expect(resolveBrandColorFacts('')).toEqual({ configured: false, value: '', label: '未单独配置' })
    expect(resolveBrandColorFacts('   ')).toMatchObject({ configured: false })
    expect(resolveBrandColorFacts('绿色')).toMatchObject({ configured: false })
    expect(resolveBrandColorFacts('#17543C')).toEqual({ configured: true, value: '#17543C', label: '#17543C' })
  })

  it('never paints the app theme green over a workspace with no brand colour', () => {
    const html = card('', '')
    expect(html).not.toContain('#17543c')
    expect(html).not.toContain('#17543C')
    expect(html).toContain(BRAND_UNCONFIGURED)
    // The swatch is only drawn for a colour that exists.
    expect(html).not.toContain('<i>')
    expect(card('#2f7a4d', '')).toContain('#2f7a4d')
  })

  it('removes the fabricated fallback from the stylesheet too', () => {
    // `background:var(--brand-preview-color,#17543c)` painted the theme green
    // as the brand colour for any card whose colour was not set.
    expect(styles).not.toContain('var(--brand-preview-color,#17543c)')
    expect(styles).toContain('var(--brand-preview-color,transparent)')
  })

  it('keeps brand editing closed until scoped server data is read', () => {
    const brands = renderToStaticMarkup(createElement(MaterialLibraryWorkspace, { baseUrl: undefined, accounts, products, view: 'brands' }))
    expect(brands).not.toMatch(/#17543c/iu)
    expect(brands).toContain('正在读取服务端品牌配置')
    expect(brands).not.toContain('material-brand-config-card')
    expect(brands).not.toContain('material-brand-output')
    expect(brands).not.toContain(BRAND_UNCONFIGURED)
    expect(brands).not.toContain(BRAND_DOCUMENT_NONE)
    expect(brands).not.toContain(BRAND_DOCUMENT_PENDING)
    expect(brands).not.toContain('已接收')
    expect(brands).not.toContain('上传品牌资料')
    expect(brands).not.toContain('保存品牌配置')
  })
})

describe('brand scope data is unavailable', () => {
  it('keeps the scope layout but exposes no editable controls without a readable store', () => {
    const html = renderToStaticMarkup(createElement(BrandScopeUnavailableRow, {
      number: '02', label: '店铺配置', description: '覆盖全局配置并应用到当前店铺', status: '当前没有已登记店铺。',
    }))
    expect(html).toContain('data-testid="brand-scope-unavailable-02"')
    expect(html).toContain('店铺配置尚不可用')
    expect(html).toContain('当前没有已登记店铺。')
    expect(html).toContain('等待真实数据')
    expect(html).not.toMatch(/<input|<textarea|Store Nova|#17543c/iu)
  })

  it('labels the native colour picker as unconfigured instead of showing its browser black default', () => {
    const html = renderToStaticMarkup(createElement(MaterialBrandFields, {
      value: { logoUrl: '', color: '', persona: '', sellingPoints: '', personaFileName: '', sellingPointsFileName: '', assetFileName: '' },
      label: '全局', onChange: () => undefined,
    }))
    expect(html).toContain('当前未配置')
    expect(html).toContain('placeholder="未配置"')
    expect(html).toContain('value="#ffffff"')
    expect(html).not.toContain('value="#000000"')
  })
})
