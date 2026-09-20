import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaterialBrandFields, MaterialBrandOutput, MaterialLibraryWorkspace } from './App'
import type { PlatformAccount, Product } from './api'
import {
  BRAND_DOCUMENT_LOCAL_ONLY,
  BRAND_DOCUMENT_NONE,
  BRAND_DOCUMENT_PENDING,
  BRAND_UNCONFIGURED,
  resolveBrandColorFacts,
  resolveBrandDocumentFacts,
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

  it('cannot claim an upload while the pane makes no server call', () => {
    // The label and the behaviour have to agree. `resolveBrandDocumentFacts`
    // returns `uploaded: false` as a literal type, so a real upload would have
    // to change this file's contract on purpose — and this assertion is what
    // fails while someone wires the endpoint but leaves 「仅本地，未上传」 up.
    const pane = appSource.slice(appSource.indexOf('function MaterialBrandFields('), appSource.indexOf('type RecycleMaterialItem'))
    expect(pane.length).toBeGreaterThan(3_000)
    for (const serverCall of ['uploadAsset(', 'saveBrandProfile(', 'extractBrandProfile(', 'fetch(']) {
      expect(pane, `${serverCall} would make 「${BRAND_DOCUMENT_LOCAL_ONLY}」 a lie`).not.toContain(serverCall)
    }
    // ... and the fields block tells the merchant the same thing before reading
    // the card, in the same words the analysis status uses.
    const fields = renderToStaticMarkup(createElement(MaterialBrandFields, { value: settings('', ''), onChange: () => undefined, label: '全局' }))
    expect(fields).toContain('选择文档并解析')
    expect(fields).not.toContain('上传并分析')
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

  it('opens the reviewed 品牌资产 page without a colour or a document', () => {
    const brands = renderToStaticMarkup(createElement(MaterialLibraryWorkspace, { baseUrl: undefined, accounts, products, view: 'brands' }))
    expect(brands).not.toMatch(/#17543c/iu)
    expect(brands).toContain(BRAND_UNCONFIGURED)
    expect(brands).toContain(BRAND_DOCUMENT_NONE)
    expect(brands).toContain(BRAND_DOCUMENT_PENDING)
    expect(brands).not.toContain('已接收')
  })
})
