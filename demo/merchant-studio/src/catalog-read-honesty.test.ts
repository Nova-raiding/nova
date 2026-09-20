import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Products, resolveCatalogReadCountText, resolveCatalogSyncControl } from './App'

/**
 * Two reads on the catalogue page — `/v1/platform-accounts` and `/v1/products` —
 * used to end up as `0` when they failed:
 *
 *   `syncableAccountCount = (accounts ?? []).filter(…)` collapsed the `null` that
 *   `loadAccounts` stores for an in-flight *and* a failed read into an empty
 *   array, and `loadProducts`' catch called `setProductTotal(0)`.
 *
 * Live reproduction of the shipped build (both endpoints 500-ing, real browser,
 * 2026-09-20): the header read 「已连接店铺 0」 beside a button that said
 * 「等待店铺连接」 and the instruction 「下一步：先连接一个可读取的店铺，再回来同步
 * 商品。」 — while the same page's 运营检查 panel said 「店铺身份读取失败 / 下一步：
 * 重试店铺发现」 and the info notice said 「店铺发现失败：… 已停止全部同步。」
 * Reloading with `/v1/products` 500-ing read 「当前目录 0 个商品」 above a table that
 * said 「商品列表暂不可用」. The healthy baseline read 「8 个商品」 and 「1」.
 *
 * The header is asserted as the merchant reads it, and the read states the
 * renderer cannot reach in a static render — a settled failure — are driven
 * through the resolvers that produce those words.
 */

const renderProducts = (baseUrl?: string) =>
  renderToStaticMarkup(createElement(Products, {
    baseUrl,
    modelStatus: null,
    modelStatusRead: false,
    onRefreshModelStatus: () => undefined,
    onSelectTarget: () => undefined,
    onOpenTasks: () => undefined,
  }))

/** The header card's text, with the markup taken out. */
const headerText = (html: string) => {
  const card = /<section class="products-summary"[\s\S]*?<\/section>/u.exec(html)?.[0] ?? ''
  return card.replace(/<[^>]*>/gu, '')
}

describe('the catalogue header never answers a read that did not answer', () => {
  it('says the store and product reads are unread while they are still in flight', () => {
    const header = headerText(renderProducts('http://127.0.0.1:9'))
    // Both of these read 「… 0」 before the fix, on a page whose other panels
    // reported the same reads as unread or failed.
    expect(header).not.toContain('当前目录0')
    expect(header).not.toContain('已连接店铺0')
    expect(header).toContain('当前目录未读取')
    expect(header).toContain('已连接店铺未读取')
    // 「已选择任务目标」 is a local selection counter, not a read: its 0 is real.
    expect(header).toContain('已选择任务目标0')
  })

  it('keeps the offline demo counts, which were never a server read', () => {
    const header = headerText(renderProducts(undefined))
    expect(header).toMatch(/当前目录\d+个商品/u)
    expect(header).not.toContain('未读取')
  })

  it('does not page the catalogue as if it held zero products', () => {
    const html = renderProducts('http://127.0.0.1:9')
    expect(html).not.toContain('显示 0 个商品')
    expect(html).toContain('正在读取商品列表…')
    // The 「全部」 filter chip is the same read: it printed 「全部 0」.
    expect(html).not.toContain('全部 0')
  })
})

describe('an unanswered read is never printed as a count', () => {
  it('separates unread from failed, and prints a real zero as zero', () => {
    expect(resolveCatalogReadCountText({ count: null, failed: false })).toBe('未读取')
    expect(resolveCatalogReadCountText({ count: null, failed: true })).toBe('读取失败')
    expect(resolveCatalogReadCountText({ count: 0, failed: false })).toBe('0')
    expect(resolveCatalogReadCountText({ count: 8, failed: false })).toBe('8')
  })
})

describe('the sync control keeps the four store-read states apart', () => {
  const base = {
    baseUrl: '/api',
    accountsLoading: false,
    accountsError: '',
    syncing: false,
    idleHint: '至少选择 2 个商品 + 平台 + 店铺目标',
  }

  it('does not tell a merchant to connect a store after the store read failed', () => {
    const failed = resolveCatalogSyncControl({
      ...base,
      syncableStores: null,
      accountsError: '店铺发现失败：网络不可用。为避免同步到错误店铺，已停止全部同步。',
    })
    expect(failed.label).toBe('读取失败')
    expect(failed.hint).toBe('下一步：重试店铺发现，确认店铺身份后再同步商品。')
    // The instruction the shipped build gave for this state, on a read that
    // could not know whether a store exists.
    expect(failed.hint).not.toContain('先连接一个可读取的店铺')
    expect(failed.label).not.toBe('等待店铺连接')
  })

  it('says the store read has not answered instead of claiming there is no store', () => {
    expect(resolveCatalogSyncControl({ ...base, syncableStores: null })).toEqual({
      label: '店铺连接未读取',
      hint: '店铺连接未读取，无法判断是否已连接可读取的店铺。',
    })
  })

  it('still tells a merchant with no readable store to connect one', () => {
    expect(resolveCatalogSyncControl({ ...base, syncableStores: 0 })).toEqual({
      label: '等待店铺连接',
      hint: '下一步：先连接一个可读取的店铺，再回来同步商品。',
    })
  })

  it('keeps the answered, loading, syncing and offline states unchanged', () => {
    expect(resolveCatalogSyncControl({ ...base, syncableStores: 2 })).toEqual({ label: '同步全部店铺', hint: base.idleHint })
    expect(resolveCatalogSyncControl({ ...base, syncableStores: null, accountsLoading: true })).toEqual({ label: '正在发现店铺…', hint: base.idleHint })
    expect(resolveCatalogSyncControl({ ...base, syncableStores: 2, syncing: true })).toEqual({ label: '同步全部店铺…', hint: base.idleHint })
    expect(resolveCatalogSyncControl({ ...base, baseUrl: undefined, syncableStores: 0 })).toEqual({ label: '演示数据', hint: base.idleHint })
  })
})
