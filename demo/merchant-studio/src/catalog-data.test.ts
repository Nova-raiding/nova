import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { PlatformAccount, Product } from './api'
import {
  buildCatalogPlatforms,
  catalogProductAddedAt,
  catalogProductsForStore,
  catalogProductSubtitle,
  catalogSyncLabel,
} from './catalog-data'
import platformAccountsCapture from './fixtures/platform-accounts.capture.json'
import productsCapture from './fixtures/products.capture.json'

/**
 * The fixtures are verbatim captures of real responses, not hand-written stubs:
 *
 *   GET /api/v1/platform-accounts       → platform-accounts.capture.json
 *   GET /api/v1/products?limit=50&offset=0 → products.capture.json
 *
 * captured over the merchant session at http://127.0.0.1:28181/ (Vite proxy →
 * API), workspace ws_demo, on 2026-09-20. They record what the store page must
 * render: one fixture account (「演示连接」, no sync record) and one product.
 *
 * The page used to render eight invented stores, three of them 「已接入」, nine
 * invented products and a 「12 分钟前同步」 sync time with zero server requests,
 * while the server-driven overview in the same session said 0 connected stores.
 */
const accounts = (platformAccountsCapture as { data: { items: PlatformAccount[] } }).data.items
const products = (productsCapture as { data: { items: Product[] } }).data.items
const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
/**
 * Exactly the store catalogue component: the material library that follows it
 * is covered by `material-library.test.ts`.
 *
 * This slice used to end at `function demoStoreMaterials`, and the comment
 * above it read「the demo material library that follows it (its own seed, its
 * own audit trail) is deliberately out of scope here」. That exemption is the
 * reason the material library kept rendering eight invented materials per store
 * for a workspace whose server reported one fixture account, and kept serving
 * 「下载」 files that were four lines of text: the same class of defect this
 * file was written to pin down, one component to the right, excluded by name
 * from the only test that looked at this region. There is no longer any such
 * component to slice around — the seed builders are deleted — and the material
 * surfaces now carry their own behaviour tests instead of an exemption.
 */
const materialWorkspaceStart = appSource.indexOf('export function MaterialRecycleBinWorkspace')
if (materialWorkspaceStart < 0) throw new Error('the material workspace must exist for the catalogue slice to end at it')
const catalogComponent = appSource.slice(
  appSource.indexOf('function StoreCatalogExperience'),
  materialWorkspaceStart,
)
/**
 * The end of the material slice, guarded like its start.
 *
 * `appSource.slice(start, appSource.indexOf('function Products('))` was the
 * original, and `indexOf` answers `-1` for a marker that moved. `slice(start,
 * -1)` does not fail: it silently becomes "everything from `start` to one
 * character before the end of the file", so renaming `function Products(` — a
 * rename the compiler would happily accept — turned the slice into most of
 * `App.tsx` while all thirteen assertions kept passing. A `-1` is a missing
 * marker, not an offset, so it throws here like the start guard above.
 */
const productsComponentStart = appSource.indexOf('function Products(')
if (productsComponentStart < 0) throw new Error('the products component must exist for the material slice to end at it')
if (productsComponentStart < materialWorkspaceStart) throw new Error('the products component must follow the material workspace for the slice to end at it')
const materialSource = appSource.slice(materialWorkspaceStart, productsComponentStart)
if (materialSource.length >= appSource.length) throw new Error('the material slice must end before the end of the file')

describe('the store page renders the server catalogue', () => {
  it('keeps the reviewed platform set and order, with the real store count per platform', () => {
    const platforms = buildCatalogPlatforms(accounts, products)!
    expect(platforms.map((platform) => platform.id)).toEqual(['taobao', 'tmall', 'jd', 'douyin', 'pinduoduo', 'xiaohongshu'])
    expect(platforms.map((platform) => platform.label)).toEqual(['淘宝', '天猫', '京东', '抖音小店', '拼多多', '小红书店'])
    expect(platforms.map((platform) => platform.stores.length)).toEqual([1, 0, 0, 0, 0, 0])
    // A platform with no account is 未接入 — not a store card with invented data.
    expect(platforms.filter((platform) => platform.id !== 'taobao').map((platform) => platform.statusLabel)).toEqual(['未接入', '未接入', '未接入', '未接入', '未接入'])
  })

  it('reports the one real store with the server facts, not a demo catalogue', () => {
    const [store, ...rest] = buildCatalogPlatforms(accounts, products)!.flatMap((platform) => platform.stores)
    expect(rest).toEqual([])
    expect(store).toMatchObject({
      id: 'fixture-store-ws_demo-taobao',
      name: '淘宝 Fixture 店',
      platformId: 'taobao',
      platform: '淘宝',
      mark: '淘',
      dataModeLabel: '演示数据',
      connectionLabel: '演示连接',
      readable: true,
      // The fixture account is readable but is not a real connected store, so it
      // may not be counted as 「已连接」 — the same rule the overview uses.
      realConnected: false,
      products: 1,
      syncLabel: '',
    })
  })

  it('never presents the capture as a demo brand catalogue', () => {
    const rendered = JSON.stringify(buildCatalogPlatforms(accounts, products))
    for (const invented of ['Store Nova', '京东自营店', '12 分钟前同步', '已上架']) expect(rendered).not.toContain(invented)
  })

  it('shows no store at all when the server has no accounts', () => {
    // The server enumerates every supported platform; an account-less row is a
    // platform, not a store.
    const withoutAccounts = accounts.map(({ accountId, ...row }) => ({ ...row, accountId: undefined }))
    const platforms = buildCatalogPlatforms(withoutAccounts, products)!
    expect(platforms.flatMap((platform) => platform.stores)).toEqual([])
    expect(platforms.every((platform) => platform.statusLabel === '未接入')).toBe(true)
    expect(platforms.every((platform) => platform.connectedCount === 0)).toBe(true)
  })

  it('says the store list is unread until the account read answers', () => {
    expect(buildCatalogPlatforms(null, products)).toBeNull()
    expect(buildCatalogPlatforms(null, null)).toBeNull()
    // A completed read that returned nothing is a real answer, not "unread".
    expect(buildCatalogPlatforms([], null)).toEqual([])
  })

  it('labels manual platform placeholders as requiring operator registration', () => {
    const manualPlatforms = ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'].map((platform) => ({ platform, state: 'manual_operations', dataMode: 'manual_upload' })) as unknown as PlatformAccount[]
    const rows = buildCatalogPlatforms(manualPlatforms, null)!
    expect(rows).toHaveLength(6)
    expect(rows.every((platform) => platform.stores.length === 0 && platform.statusLabel === '需运营登记')).toBe(true)
  })
})

describe('product facts come from the server', () => {
  it('lists the server products for the account that owns them', () => {
    const items = catalogProductsForStore(products, 'fixture-store-ws_demo-taobao')!
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'prod_demo_fixture_1',
      title: '本地演示保温杯（Fixture）',
      price: 89,
      addedAt: '2026-08-29',
      series: '未分类',
      skus: [],
    })
    expect(items[0]!.subtitle).toContain('demo_fixture_category')
    expect(items[0]!.subtitle).toContain('库存 36 件')
    expect(items[0]!.subtitle).toContain('2 个规格')
  })

  it('separates an unresolved product read from a store with no products', () => {
    expect(catalogProductsForStore(null, 'fixture-store-ws_demo-taobao')).toBeNull()
    expect(catalogProductsForStore(products, 'no-such-account')).toEqual([])
  })

  it('never fabricates a price or an added date', () => {
    expect(catalogProductSubtitle({ stock: 0, skuCount: 0 } as Product)).toBe('库存 0 件 · 0 个规格')
    expect(catalogProductSubtitle({} as Product)).toBe('')
    expect(catalogProductAddedAt({})).toBe('')
    expect(catalogProductAddedAt({ createdAt: 'not-a-date' })).toBe('')
    expect(catalogProductAddedAt({ updatedAt: '2026-01-02T00:00:00.000Z' })).toBe('2026-01-02')
    expect(catalogProductsForStore([{ id: 'p', title: 'p', updatedAt: '2026-01-02T00:00:00.000Z', accountId: 'a' } as Product], 'a')![0]!.price).toBeNull()
  })

  it('reports a sync time only when the server recorded one', () => {
    expect(catalogSyncLabel({})).toBe('')
    expect(catalogSyncLabel({ sync: { lastSuccessfulAt: null, lastAttemptAt: null } })).toBe('')
    expect(catalogSyncLabel({ sync: { lastSuccessfulAt: 'not-a-date' } })).toBe('')
    expect(catalogSyncLabel({ sync: { lastSuccessfulAt: '2026-08-29T00:05:00+00:00' } })).toMatch(/^2026-08-29 \d{2}:\d{2}$/)
  })
})

describe('the page cannot fall back to a hardcoded catalogue', () => {
  it('reads its stores and products from the server through the passed base url', () => {
    expect(catalogComponent).toContain('fetchPlatformAccounts(baseUrl)')
    expect(catalogComponent).toContain('fetchProducts(baseUrl)')
    expect(catalogComponent).toContain('buildCatalogPlatforms(accounts, products)')
    expect(catalogComponent).toContain('catalogProductsForStore(products, selectedStore.id')
  })

  it('offers a platform choice and operations handoff without exposing merchant OAuth in manual mode', () => {
    expect(catalogComponent).toContain('Object.entries(platformNames).map')
    expect(catalogComponent).toContain('前往运营后台登记店铺')
    expect(catalogComponent).toContain('当前版本不提供商家自行授权连接')
    expect(catalogComponent).not.toContain('authorizePlatform(baseUrl, platform)')
  })

  it('no longer carries the invented product template table or its per-store copy', () => {
    // The values themselves are pinned by the mapper tests above; these are the
    // two source constructs that used to hand the page a fake catalogue. They are
    // checked across the whole file, because the fake table lived at module level
    // next to the component rather than inside it.
    for (const removed of ['catalogProductTemplates', 'storeProducts(']) {
      expect(appSource, `${removed} must not be part of the store page`).not.toContain(removed)
    }
  })

  it('no longer exempts the material surfaces from the server-data rule', () => {
    // The material library used to be sliced out of this file by name. It now
    // reads the same server stores the catalogue does, and its own tests live
    // in `material-library.test.ts`. Both ends of the slice are guarded above.
    expect(materialSource.length).toBeGreaterThan(5_000)
    expect(materialSource.length).toBeLessThan(appSource.length / 2)
    expect(materialSource).toContain('buildCatalogPlatforms(accounts, products)')
    expect(materialSource).toContain('resolveMaterialRead(')
    expect(appSource).not.toContain('demoStoreMaterials')
  })

  it('does not claim 已连接 for a store the server did not connect', () => {
    // The pill text is the connection word the server's state implies.
    expect(catalogComponent).toContain('{store.connectionLabel}')
    expect(catalogComponent).toContain('platform?.statusLabel ?? \'未登记\'')
  })
})
