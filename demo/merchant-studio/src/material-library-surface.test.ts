import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaterialLibraryWorkspace, MaterialRecycleBinWorkspace, MaterialStorageQuotaCard } from './App'
import type { PlatformAccount } from './api'

/**
 * What the reviewed material surfaces actually render.
 *
 * These are the two pages the dogfood suite walked past without looking: the
 * material library claimed 「找到 8 项素材」 with every business API aborted, and
 * the recycle bin claimed 「1 项待处理素材 · 剩余 6 天 · 2026/9/19 删除」 for a
 * brand-new profile. Both were local arrays, so no gate could see them — the
 * only test that read this region of `App.tsx` had excluded these components by
 * name (see `catalog-data.test.ts`).
 *
 * `renderToStaticMarkup` renders the first paint, which is exactly the state
 * that lied: the count and the deleted record were in the initial render, not
 * behind a request.
 */

const storage = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => storage.clear(),
}

beforeEach(() => {
  storage.clear()
  // The components read localStorage and `window.location` while rendering.
  vi.stubGlobal('window', {
    localStorage: localStorageStub,
    location: { pathname: '/merchant/products', search: '?section=knowledge', href: 'http://127.0.0.1/merchant/products?section=knowledge' },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// Every render happens inside an `it`, after the `window` stub is installed:
// the components read localStorage on their first paint, and a render evaluated
// at module scope would silently exercise the storage-unavailable fallback
// instead of the real initial state.
const renderLibrary = (props: { baseUrl?: string; accounts: never[] | null; products: null; view: 'library' | 'brands' }) =>
  renderToStaticMarkup(createElement(MaterialLibraryWorkspace, props))

const renderRecycleBin = (baseUrl?: string) => renderToStaticMarkup(createElement(MaterialRecycleBinWorkspace, { baseUrl }))

describe('the material library may not claim a catalogue it did not read', () => {
  it('states no count when no API is configured, and shows no material card', () => {
    // The shipped defect, verbatim: with the API fully disconnected the page
    // still read 「找到 8 项素材」 and rendered eight cards.
    const library = renderLibrary({ accounts: [], products: null, view: 'library' })
    expect(library).not.toMatch(/找到\s*<strong>\d+<\/strong>\s*项素材/u)
    expect(library).not.toMatch(/找到 8 项素材/u)
    expect(library).toContain('未配置 API，素材未读取')
    expect(library).not.toContain('Store Nova 旗舰店')
    expect(library).not.toContain('商品首图')
    expect(library).not.toContain('演示素材')
  })

  it('states no count while the asset read is still in flight', () => {
    // Same reason, with an API configured: the page must not read as 「找到 0 项」
    // for a read that has not answered.
    const libraryWithApi = renderLibrary({ baseUrl: 'http://127.0.0.1:9', accounts: null, products: null, view: 'library' })
    expect(libraryWithApi).not.toMatch(/找到\s*<strong>\d+<\/strong>\s*项素材/u)
    expect(libraryWithApi).toContain('正在读取素材')
    expect(libraryWithApi).not.toMatch(/Store Nova/u)
  })

  it('survives a workspace the server reports no store for', () => {
    // The store list is a read now, so a workspace with no store is reachable.
    // The brand view used to dereference `activeStore.name` unconditionally.
    const brands = renderLibrary({ accounts: [], products: null, view: 'brands' })
    expect(brands).toContain('当前没有已登记店铺')
    expect(brands).not.toContain('上传品牌资料')
    expect(brands).toContain('登记店铺后可配置店铺品牌信息')
    expect(brands).not.toMatch(/Store Nova/u)
    const unreadBrands = renderLibrary({ baseUrl: 'http://127.0.0.1:9', accounts: null, products: null, view: 'brands' })
    expect(unreadBrands).not.toContain('上传品牌资料')
    expect(unreadBrands).toContain('正在读取店铺列表')
  })

  it('distinguishes a registered store without read authorization from no store', () => {
    const account = {
      platform: 'jd', accountId: 'jd:42169', alias: '贵人鸟官方旗舰店',
      state: 'manually_registered', dataMode: 'account_record_only',
      readable: false, writeEnabled: false,
    } as PlatformAccount
    const brands = renderToStaticMarkup(createElement(MaterialLibraryWorkspace, {
      accounts: [account], products: null, view: 'brands',
    }))
    expect(brands).toContain('已登记店铺尚未取得可读取授权')
    expect(brands).not.toContain('当前没有已登记店铺')
  })

  it('shows a failed store read on the brand page instead of indefinite loading', () => {
    const brands = renderToStaticMarkup(createElement(MaterialLibraryWorkspace, {
      baseUrl: 'http://127.0.0.1:9', accounts: null, accountsError: '服务暂不可用', products: null, view: 'brands',
    }))
    expect(brands).toContain('店铺列表读取失败：服务暂不可用')
    expect(brands).not.toContain('正在读取店铺列表')
    expect(brands).not.toContain('上传品牌资料')
    expect(brands).toContain('店铺品牌配置暂不可用')
    expect(brands).not.toContain('保存品牌配置')
    expect(brands).not.toContain('material-brand-config-card')
  })

  it('renders the reviewed workspace landmarks, not a rebuilt page', () => {
    // The reviewed UI (fdd6deac / 02b4843a) is unchanged: only the data source
    // moved. These are the landmarks the dogfood suite walks past.
    const library = renderLibrary({ accounts: [], products: null, view: 'library' })
    expect(library).toContain('data-testid="material-library-workspace"')
    expect(library).toContain('素材库')
    expect(library).toContain('上传素材')
    expect(library).toContain('店铺筛选')
    expect(library).toContain('共享储存空间')
  })
})

describe('material metadata editing stays out of the reference card layout', () => {
  it('keeps listing cards compact and exposes persisted category/series edits on the detail page', () => {
    const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(appSource).not.toContain('className="material-card-inline-editor"')
    expect(appSource).toContain('className="material-detail-metadata-editors"')
    expect(appSource).toContain('ariaLabel={`修改${detailMaterial.name}的素材分类`}')
    expect(appSource).toContain('ariaLabel={`修改${detailMaterial.name}的所属系列`}')
    expect(appSource).toContain('void updateMaterialMetadata(detailMaterial.id, { category: value as StoreMaterialCategory })')
    expect(appSource).toContain('void updateMaterialMetadata(detailMaterial.id, { series: value })')
    expect(appSource).toContain("if (patch.series && (!baseUrl || !scopedBrandRead || activeStoreId === 'unclassified'))")
    expect(appSource).toContain('未分类工作区不能保存店铺系列；请先选择已连接店铺。')
  })
})

describe('material storage summary uses the live quota projection', () => {
  it('shows used capacity, total capacity, remaining capacity, and a bounded progress value', () => {
    const summary = renderToStaticMarkup(createElement(MaterialStorageQuotaCard, {
      quota: {
        usedBytes: 31_500_000_000,
        reservedBytes: 0,
        limitBytes: 50_000_000_000,
        availableBytes: 18_500_000_000,
        status: 'available',
      },
      uploadedGb: 0,
    }))

    expect(summary).toContain('31.5 GB / 50 GB')
    expect(summary).toContain('全部店铺已用 31.5 GB')
    expect(summary).toContain('剩余 18.5 GB')
    expect(summary).toContain('aria-valuemax="50000000000"')
    expect(summary).toContain('aria-valuenow="31500000000"')
    expect(summary).toContain('width:63.0%')
  })

  it('keeps quota unknown when the server has not returned a valid limit', () => {
    const summary = renderToStaticMarkup(createElement(MaterialStorageQuotaCard, {
      quota: { usedBytes: 1, reservedBytes: 0, limitBytes: 0, availableBytes: 0, status: 'available' },
      uploadedGb: 0.3,
    }))

    expect(summary).toContain('未读取')
    expect(summary).toContain('配额尚未读取，本次会话上传 0.3 GB')
    expect(summary).not.toContain('role="progressbar"')
  })
})

describe('the recycle bin may not invent a recoverable material', () => {
  it('keeps the count unread until the server recycle bin answers', () => {
    // The shipped defect: a brand-new profile showed one item, deleted
    // "yesterday", with six days left, described as a server retention policy.
    const recycleBin = renderRecycleBin()
    expect(recycleBin).toContain('回收站尚未读取')
    expect(recycleBin).toContain('<strong>—</strong>')
    expect(recycleBin).not.toContain('回收站为空')
    expect(recycleBin).not.toContain('<strong>0</strong><span>项待处理素材</span>')
    expect(recycleBin).not.toContain('<strong>1</strong>')
    expect(recycleBin).not.toContain('旧版包装展示图')
    expect(recycleBin).not.toContain('剩余 6 天')
    expect(recycleBin).not.toMatch(/\d{4}\/\d{1,2}\/\d{1,2} 删除/u)
  })

  it('describes the server-backed source without inventing a fixed retention policy', () => {
    const recycleBin = renderRecycleBin()
    expect(recycleBin).toContain('显示当前工作区由服务端记录的已移除素材')
    expect(recycleBin).not.toContain('保留 7 天')
    expect(recycleBin).toContain('保留期限由服务端返回')
    expect(recycleBin).toContain('当前没有可用的服务端 API 地址')
  })

  it('does not read legacy or other-tenant browser entries', () => {
    storage.set('merchant-material-recycle-bin-v1', JSON.stringify([{ id: 'old', name: 'legacy-secret' }]))
    storage.set('merchant-material-recycle-bin-v2:other:ws_demo', JSON.stringify([{ id: 'other', name: 'other-secret' }]))
    storage.set('merchant-material-recycle-bin-v2:merchant-1:ws_demo', JSON.stringify([{
      id: 'asset-1', name: 'merchant-removed.png', category: '未分类', series: '未分类',
      sizeLabel: '未读取', fileSizeLabel: '1 KB', format: 'PNG', addedAt: '2026-09-20',
      downloadUrl: '', assetId: 'asset-1', storeId: '', storeName: '未归属', platform: '未归属',
      deletedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 6 * 86400000).toISOString(),
    }]))
    const recycleBin = renderRecycleBin()
    expect(recycleBin).toContain('回收站尚未读取')
    expect(recycleBin).not.toContain('legacy-secret')
    expect(recycleBin).not.toContain('other-secret')
    expect(recycleBin).not.toContain('merchant-removed.png')
    expect(storage.has('merchant-material-recycle-bin-v1')).toBe(true)
  })
})
