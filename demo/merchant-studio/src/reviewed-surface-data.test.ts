import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaterialLibraryWorkspace, initialSeriesForStore } from './App'
import type { AssetMetadata, PlatformAccount, Product } from './api'
import storeNovaLogo from './assets/store-nova-primary-horizontal.png'
import { MATERIAL_UNREAD, materialItemFromAsset, uploadMaterialFiles } from './material-library'
import platformAccountsCapture from './fixtures/platform-accounts.capture.json'
import productsCapture from './fixtures/products.capture.json'

/**
 * The reviewed merchant surfaces may not open on data no server holds.
 *
 * Three sibling defects of the same class were found after the first round of
 * this audit: the material library claimed 「找到 8 项素材」 and the recycle bin
 * claimed one deleted item, both from local seeds. This file holds the line for
 * the rest of that class — the 品牌资产 default, the invented store series, the
 * per-product 素材槽位 table and the local-only 确认上传 — because each of them
 * survived the round that fixed the other two.
 *
 * Two of these surfaces are only reachable through a click sequence, and the
 * candidate cannot be driven from a node test, so the checks are split: the
 * rendered first paint where that is enough (品牌资产) and the pure helper the
 * click path calls where it is not (上传). The `App.tsx` source assertions below
 * are the "must stay deleted" half — the fabricated tables cannot be detected
 * from the outside once nothing renders them, which is exactly how the last dead
 * seed survived.
 */
const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
/**
 * `App.tsx` with its own block comments removed, line by line.
 *
 * The "must stay deleted" assertions below are about code, and the comments that
 * explain why a fabrication was removed have to be able to name it. Without this
 * the explanation would be the thing the test failed on.
 *
 * It is a line-based state machine rather than `/\/\*[\s\S]*?\*\//g` on purpose.
 * That regex is what this helper was first written with, and the upload
 * dialog's wildcard image/video MIME attribute opened a "comment" that swallowed the next 200 000
 * characters of the file — so every "not.toContain" below was quietly asserting
 * over a hole instead of over the code. The mutation run caught it; the
 * `appCode.length` floor below is what stops it coming back.
 */
function stripComments(source: string): string {
  const kept: string[] = []
  let inBlock = false
  for (const line of source.split('\n')) {
    const trimmed = line.trimStart()
    if (inBlock) {
      const close = line.indexOf('*/')
      if (close < 0) continue
      inBlock = false
      const rest = line.slice(close + 2)
      if (rest.trim()) kept.push(rest)
      continue
    }
    if (trimmed.startsWith('/*')) {
      const close = line.indexOf('*/', line.indexOf('/*'))
      if (close < 0) { inBlock = true; continue }
      const rest = line.slice(close + 2)
      if (rest.trim()) kept.push(rest)
      continue
    }
    if (trimmed.startsWith('//')) continue
    kept.push(line)
  }
  return kept.join('\n')
}
const appCode = stripComments(appSource)
const accounts = (platformAccountsCapture as { data: { items: PlatformAccount[] } }).data.items
const products = (productsCapture as { data: { items: Product[] } }).data.items

const storage = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => storage.clear(),
}

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('window', {
    localStorage: localStorageStub,
    location: { pathname: '/merchant/products', search: '?section=assets', href: 'http://127.0.0.1/merchant/products?section=assets' },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the source helper this file asserts through', () => {
  it('removes comments without punching a hole in the file', () => {
    // A hole would turn every `not.toContain` below into a tautology, which is
    // how the first version of this helper passed a mutation that re-added the
    // whole fabricated table.
    expect(appCode.length).toBeGreaterThan(appSource.length * 0.6)
    // Markers from both ends of the file, so a truncated `appCode` fails loudly.
    expect(appCode).toContain("import { Fragment")
    expect(appCode).toContain('material-upload-note')
    expect(appSource).toContain("'image/*,video/*'")
    // Comments really were removed (otherwise the assertions are on the wrong text).
    // The probe is a token that survives only in a comment, so this stays a test
    // of the stripper rather than of the code's contents.
    expect(appSource).toContain('recycle-demo-packaging-v1')
    expect(appCode).not.toContain('recycle-demo-packaging-v1')
  })
})

describe('品牌资产 opens on what the workspace actually has', () => {
  // The reviewed 品牌资产 page is `MaterialLibraryWorkspace view="brands"`, and
  // its store list comes from the fixture captures, so the panel really renders.
  const renderBrands = (baseUrl?: string) =>
    renderToStaticMarkup(createElement(MaterialLibraryWorkspace, {
      baseUrl,
      accounts,
      products,
      view: 'brands',
    }))

  it('never seeds a 品牌资产文档 the server did not receive', () => {
    // The shipped default was `assetFileName: 'Store Nova 品牌资产手册.pdf'`, and
    // `MaterialBrandOutput` renders any non-empty name as 「已接收」. No server
    // holds that document — `GET /v1/brand-profile` answers `{"profile": null}`
    // for this workspace — so the page announced a received file that did not
    // exist, at every level of the 全局/店铺/系列 stack that falls back to it.
    const brands = renderBrands()
    expect(brands).not.toContain('Store Nova 品牌资产手册.pdf')
    expect(brands).not.toContain('已接收')
    // 「待接收」 and 「暂无资产文件」 are the two facts it can stand behind.
    expect(brands).toContain('暂无资产文件')
    expect(brands).toContain('待接收')
  })

  it('never presents a bundled image as the workspace brand logo', () => {
    const brands = renderBrands()
    // The same default also set `logoUrl: storeNovaLogo`, so the global output
    // card drew an app-bundle image under 「品牌 Logo」.
    expect(storeNovaLogo.length).toBeGreaterThan(0)
    expect(brands).not.toContain(storeNovaLogo)
    expect(brands).toContain('未单独配置')
  })

  it('keeps the same honest default while the store read is still in flight', () => {
    const brands = renderBrands('http://127.0.0.1:9')
    expect(brands).not.toContain('Store Nova 品牌资产手册.pdf')
    expect(brands).not.toContain(storeNovaLogo)
    expect(brands).toContain('暂无资产文件')
  })
})

describe('a store starts with the series it actually declared', () => {
  it('hands every store the single 未分类 bucket, not an invented catalogue', () => {
    // `defaultSeriesForStore` used to answer 恒温饮具 / 桌面生活 / 礼赠套装 for any
    // store, plus 品质饮具 / 桌面效率 / 企业礼赠 for the id `jd-official` and
    // 趋势新品 / 桌面美学 / 达人礼盒 for `douyin-brand` — ids that only ever
    // existed in the deleted store seed. `GET /v1/products` publishes no series
    // field at all, so every one of those names was presented to the merchant as
    // their own store's series in the 选择系列 filter, the card's 所属系列 editor
    // and 品牌配置 › 系列配置.
    for (const storeId of ['jd-official', 'douyin-brand', 'fixture-store-ws_demo-taobao', 'anything-else']) {
      expect(initialSeriesForStore(storeId)).toEqual(['未分类'])
    }
    // A fresh array per call: the caller edits the per-store registry.
    expect(initialSeriesForStore('a')).not.toBe(initialSeriesForStore('a'))
  })

  it('carries none of the invented names anywhere in the workspace source', () => {
    for (const invented of ['恒温饮具', '桌面生活', '礼赠套装', '品质饮具', '桌面效率', '企业礼赠', '趋势新品', '桌面美学', '达人礼盒']) {
      expect(appCode, `${invented} was invented by the removed store seed`).not.toContain(invented)
    }
  })
})

describe('the per-product 素材槽位 table is deleted, not left dead', () => {
  it('carries no fabricated asset slots and no text-file download', () => {
    // `assetGroups` invented 2 videos, 12 商品主图 slots, 2 images per SKU and 16
    // 详情页图 slots, each with invented 尺寸 and 文件大小, and every row's 「下载」
    // was `data:text/plain;charset=utf-8,...` — the same broken pattern the
    // material library's download was fixed for. It was unreachable: the dialog
    // it fed was gated on `activeAssetGroupId`, which nothing ever set.
    for (const removed of ['assetGroups', 'assetDownload', 'activeAssetGroup', 'catalog-asset-list', '演示素材文件', '商品主图 01']) {
      expect(appCode, `${removed} was the fabricated per-product asset table`).not.toContain(removed)
    }
    // The 演示素材 download name was the giveaway in the DOM.
    expect(appCode).not.toContain('-演示素材.txt')
  })
})

describe('the retained asset library stays unmounted', () => {
  it('is still not reachable from any route', () => {
    // `AssetLibrary` and the `AssetProductUsageDialog` only it renders lost their
    // mount point when the reviewed interface landed (`2e055921`), and
    // `dogfood/chatgpt-all-functions/retired-merchant-assertions.md` records that
    // the components are deliberately kept so the coverage can be restored by
    // re-adding a mount point. That record is the reason this file does NOT ask
    // for the component to be deleted: deleting it would remove the only
    // implementation of the 不可信文档边界 / 素材事实与权益确认 / 品牌视觉强规则
    // surfaces and would invalidate the record, both of which are decisions for
    // the interface owner, not for this test.
    //
    // What this test does hold is the invariant the record depends on: the
    // component is retained but MUST stay unmounted, so its return is a reviewed
    // interface change rather than an accident.
    expect(appCode).toContain('function AssetLibrary(')
    // `<AssetProductUsageDialog>` is rendered *by* AssetLibrary, so it is not
    // asserted here: it is inside the retained component with it.
    expect(appCode).not.toContain('<AssetLibrary')
  })

  it('carries no fabricated material seed even while unmounted', () => {
    // The reason it is safe to keep: unlike the two seeds that were deleted
    // (`demoStoreMaterials` / `initialRecycleMaterials`), this component holds no
    // local data at all. Everything it shows starts as `null`/`[]` and is filled
    // from `GET /v1/assets`, `/v1/brand-profile` and the authenticated asset
    // endpoints. If a seed ever appears here, it is a fabrication again.
    const assetLibrary = appCode.slice(
      appCode.indexOf('function AssetLibrary('),
      appCode.indexOf('function ProductAssetRelationDialog('),
    )
    expect(assetLibrary.length).toBeGreaterThan(20_000)
    expect(assetLibrary).toContain('fetchAssets(baseUrl)')
    for (const seed of ['demoStoreMaterials', '演示素材文件', 'Store Nova 旗舰店']) {
      expect(assetLibrary, `${seed} would make the retained component a fabrication again`).not.toContain(seed)
    }
  })
})

describe('确认上传 writes to the server', () => {
  const file = (name: string, size: number, type = 'image/png') =>
    ({ name, size, type, lastModified: 0 }) as File

  const serverRow = (overrides: Partial<AssetMetadata> = {}): AssetMetadata => ({
    id: 'asset-server-1',
    name: 'server-name.png',
    mimeType: 'image/png',
    sizeBytes: 2048,
    createdAt: '2026-09-20T10:38:38.323Z',
    ...overrides,
  } as AssetMetadata)

  it('sends every selected file and builds the card from the server row', async () => {
    const sent: string[] = []
    const outcome = await uploadMaterialFiles({
      files: [file('local-a.png', 10), file('local-b.png', 20)],
      upload: async (uploaded) => {
        sent.push(uploaded.name)
        return serverRow({ id: `asset-${uploaded.name}`, name: uploaded.name })
      },
      labels: { category: '商品主图', series: '秋冬新品' },
    })
    // The server is the one that decides what was uploaded — both files went.
    expect(sent).toEqual(['local-a.png', 'local-b.png'])
    expect(outcome.failures).toEqual([])
    expect(outcome.accepted.map((item) => item.assetId)).toEqual(['asset-local-a.png', 'asset-local-b.png'])
    // Every fact on the card is the server's: the size comes from `sizeBytes`,
    // the date from `createdAt`, and the dimensions are 未读取 because the asset
    // read publishes none. The local-only version printed 「刚刚上传」 and
    // 「1920 × 1080」 for exactly these two fields.
    expect(outcome.accepted[0]).toMatchObject({
      name: 'local-a.png',
      fileSizeLabel: '2 KB',
      addedAt: '2026-09-20',
      sizeLabel: MATERIAL_UNREAD,
      category: '商品主图',
      series: '秋冬新品',
    })
    expect(outcome.accepted[0]!.addedAt).not.toBe('刚刚上传')
  })

  it('never reports a refused file as uploaded', async () => {
    const outcome = await uploadMaterialFiles({
      files: [file('ok.png', 10), file('probe.png', 5)],
      upload: async (uploaded) => {
        if (uploaded.name === 'probe.png') {
          const error = new Error('素材未通过上传安全检查，已拒绝进入隔离区') as Error & { code: string }
          error.code = 'ASSET_EXTENSION_SIGNATURE_MISMATCH'
          throw error
        }
        return serverRow({ id: 'asset-ok', name: 'ok.png' })
      },
      labels: { category: '未分类', series: '未分类' },
    })
    // A partial success is not a success: the accepted file is listed, the
    // refused one is named, and the count the merchant sees can never include it.
    expect(outcome.accepted.map((item) => item.name)).toEqual(['ok.png'])
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0]).toContain('probe.png')
    expect(outcome.accepted.map((item) => item.name)).not.toContain('probe.png')
  })

  it('keeps the merchant 素材分类/所属系列 beside the acknowledged row', async () => {
    const outcome = await uploadMaterialFiles({
      files: [file('a.png', 10)],
      upload: async () => serverRow({ id: 'asset-1', name: 'a.png' }),
      labels: { category: '详情页图', series: '未分类' },
    })
    // The asset read carries no label, so a session card would otherwise fall
    // back to 未分类 and silently drop what the merchant chose in the dialog.
    expect(outcome.accepted[0]).toMatchObject({ category: '详情页图', series: '未分类' })
    expect(materialItemFromAsset(serverRow()).category).toBe('未分类')
  })

  it('routes 确认上传 through the upload endpoint rather than local state', () => {
    const upload = appCode.slice(
      appCode.indexOf('const confirmUpload = async () => {'),
      appCode.indexOf('const updateMaterialMetadata ='),
    )
    // A real slice, so a moved marker fails loudly instead of asserting over "".
    expect(upload.length).toBeGreaterThan(500)
    expect(upload).toContain('uploadAsset(baseUrl, file)')
    expect(upload).toContain('uploadMaterialFiles(')
    // The re-read is what makes the list the server's answer.
    expect(upload).toContain('fetchAssets(baseUrl)')
    // No API means no server, and 确认上传 may not pretend otherwise.
    expect(upload).toContain('未配置 API，素材无法上传到服务端')
    // The local-only card literal may not come back. `URL.createObjectURL` is
    // still here — it is the session thumbnail for the bytes just sent — but no
    // card *fact* may be written in this function: id, 尺寸, 格式, 上传时间 and the
    // download target all come from the row `uploadMaterialFiles` was handed.
    expect(upload).not.toContain('刚刚上传')
    expect(upload).not.toContain('sizeLabel:')
    expect(upload).not.toContain('downloadUrl:')
    expect(upload).not.toContain('-upload-${Date.now()}')
  })
})

describe('the recycle bin does not claim a server it does not have', () => {
  it('states that the list is local and that server-side deletes are unread', () => {
    // `GET /v1/assets` has no deleted-materials counterpart and there is no
    // delete endpoint at all (probed live: `DELETE /v1/assets/:id` → NOT_FOUND
    // 路由不存在, `?status=deleted` is ignored). The page may only claim the
    // browser-local record it really keeps, which `material-library-surface.test.ts`
    // renders; this pins the two sentences that admit it.
    const recycleBin = appSource.slice(
      appSource.indexOf('export function MaterialRecycleBinWorkspace'),
      appSource.indexOf('export function MaterialLibraryWorkspace'),
    )
    expect(recycleBin.length).toBeGreaterThan(1_000)
    expect(recycleBin).toContain('服务端已删除素材的读取尚未接入')
    expect(recycleBin).toContain('本地记录 7 天后过期')
    expect(recycleBin).not.toContain('删除的素材会保留 7 天，到期后自动彻底删除')
  })
})
