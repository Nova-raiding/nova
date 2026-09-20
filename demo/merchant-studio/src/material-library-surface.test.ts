import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaterialLibraryWorkspace, MaterialRecycleBinWorkspace } from './App'

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

const renderRecycleBin = () => renderToStaticMarkup(createElement(MaterialRecycleBinWorkspace))

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
    expect(brands).toContain('当前工作区没有可管理的店铺')
    expect(brands).not.toMatch(/Store Nova/u)
    const unreadBrands = renderLibrary({ baseUrl: 'http://127.0.0.1:9', accounts: null, products: null, view: 'brands' })
    expect(unreadBrands).toContain('店铺列表尚未从服务端读取')
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

describe('the recycle bin may not invent a recoverable material', () => {
  it('is empty on a profile that never removed anything', () => {
    // The shipped defect: a brand-new profile showed one item, deleted
    // "yesterday", with six days left, described as a server retention policy.
    const recycleBin = renderRecycleBin()
    expect(recycleBin).toContain('回收站为空')
    // 「0 项待处理素材」 is the reviewed summary; the defect was the 1.
    expect(recycleBin).toContain('<strong>0</strong>')
    expect(recycleBin).not.toContain('<strong>1</strong>')
    expect(recycleBin).not.toContain('旧版包装展示图')
    expect(recycleBin).not.toContain('剩余 6 天')
    expect(recycleBin).not.toMatch(/\d{4}\/\d{1,2}\/\d{1,2} 删除/u)
  })

  it('shows only what this browser recorded, and claims no server retention', () => {
    const recycleBin = renderRecycleBin()
    expect(recycleBin).not.toContain('删除的素材会保留 7 天，到期后自动彻底删除')
    expect(recycleBin).toContain('服务端已删除素材的读取尚未接入')
    // A record this browser really wrote is still shown — the bin is not
    // hardcoded to empty, it reads its own storage.
    storage.set('merchant-material-recycle-bin-v1', JSON.stringify([{
      id: 'asset-1', name: 'merchant-removed.png', category: '未分类', series: '未分类',
      sizeLabel: '未读取', fileSizeLabel: '1 KB', format: 'PNG', addedAt: '2026-09-20',
      downloadUrl: '', assetId: 'asset-1', storeId: '', storeName: '未归属', platform: '未归属',
      deletedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 6 * 86400000).toISOString(),
    }]))
    const withItem = renderRecycleBin()
    expect(withItem).toContain('merchant-removed.png')
    expect(withItem).toContain('未归属')
  })
})
