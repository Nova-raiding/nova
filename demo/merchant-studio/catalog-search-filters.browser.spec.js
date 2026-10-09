import { expect, test, chromium } from '@playwright/test'

test.setTimeout(60_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18081'
const workspaceId = 'ws_catalog_search_fixture'
const accountId = 'jd-catalog-search-store'
const envelope = (data, error = null) => ({ request_id: 'catalog-search-fixture', trace_id: 'catalog-search-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

function localDate(offsetDays) {
  const date = new Date()
  date.setDate(date.getDate() - offsetDays)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const products = [
  ['product-catalog-1', '轻云咖啡机', 0],
  ['product-catalog-2', '云朵手冲壶', 5],
  ['product-catalog-3', '晴空保温杯', 20],
  ['product-catalog-4', '山野滤杯', 60],
  ['product-catalog-5', '晨光磨豆机', 120],
  ['product-catalog-6', '便携咖啡秤', 0],
  ['product-catalog-7', '玻璃分享壶', 5],
  ['product-catalog-8', '陶瓷滤纸架', 20],
].map(([id, title, age]) => ({
  id, workspaceId, platform: 'jd', accountId, storeName: '目录搜索验收店', title,
  skuCount: 1, stock: 10, factsConfirmed: true, source: 'manual_import',
  createdAt: `${localDate(age)}T08:00:00.000Z`, updatedAt: `${localDate(age)}T08:00:00.000Z`, version: 1,
}))

test('catalog search, date filter, empty-state recovery, and pagination use the selected store data', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const unmockedApiRequests = []

  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (pathname === '/v1/auth/session') {
      data = { account: { id: 'catalog-search-user', login: 'catalog-search@example.invalid', accountType: 'merchant', displayName: '目录验收', status: 'active', workspaceIds: [workspaceId] } }
    } else if (pathname === '/v1/auth/mcp-token') {
      data = { access_token: 'catalog-search-fixture-token', refresh_token: 'catalog-search-fixture-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (pathname === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (pathname === '/v1/platform-accounts') {
      data = { items: [{ platform: 'jd', state: 'manually_registered', readEnabled: false, writeEnabled: false, dataMode: 'manual_upload', accountId, storeName: '目录搜索验收店' }] }
    } else if (pathname === '/v1/products') {
      data = { items: products, total: products.length, limit: 50, offset: 0 }
    } else if (pathname === '/mcp') {
      const method = route.request().postDataJSON()?.method
      data = { result: method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: products.length, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } }
        : method === 'platform.model.status'
          ? { state: 'ready', capabilities: { image_generation: false } }
          : {} }
    } else {
      unmockedApiRequests.push(`${route.request().method()} ${pathname}`)
      await route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNMOCKED_CATALOG_SEARCH_FIXTURE' })) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: /^京东/u })).toHaveAttribute('aria-pressed', 'true')
    const store = page.locator('.catalog-store-card').filter({ hasText: '目录搜索验收店' })
    await expect(store).toBeVisible()
    await store.getByRole('button', { name: /进入商品库/u }).click()
    const search = page.getByRole('textbox', { name: '搜索商品名称或关键词' })
    await expect(search).toBeVisible()
    await expect(page.locator('.catalog-product-card')).toHaveCount(6)
    await expect(page.getByRole('navigation', { name: '商品分页' })).toContainText('共 8 件 · 第 1 / 2 页')

    await search.fill('云咖')
    await expect(page.locator('.catalog-product-card')).toHaveCount(1)
    await expect(page.locator('.catalog-product-card')).toContainText('轻云咖啡机')
    await expect(page.locator('.catalog-product-card')).not.toContainText('云朵手冲壶')

    await search.fill('不存在的商品')
    await expect(page.getByText('没有找到符合条件的商品', { exact: true })).toBeVisible()
    await expect(page.getByText('该店铺还没有商品', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '清除全部条件' }).click()
    await expect(search).toHaveValue('')
    await expect(page.locator('.catalog-product-card')).toHaveCount(6)

    await page.getByRole('button', { name: '按添加时间筛选' }).click()
    await page.getByRole('option', { name: '近 7 天添加' }).click()
    await expect(page.locator('.catalog-product-card')).toHaveCount(4)
    await expect(page.locator('.catalog-product-card').filter({ hasText: '轻云咖啡机' })).toHaveCount(1)
    await expect(page.locator('.catalog-product-card').filter({ hasText: '便携咖啡秤' })).toHaveCount(1)
    await expect(page.locator('.catalog-product-card').filter({ hasText: '晴空保温杯' })).toHaveCount(0)

    await page.getByRole('button', { name: '重置条件' }).click()
    await expect(page.locator('.catalog-product-card')).toHaveCount(6)
    await page.getByRole('button', { name: '下一页' }).click()
    await expect(page.getByRole('navigation', { name: '商品分页' })).toContainText('共 8 件 · 第 2 / 2 页')
    await expect(page.locator('.catalog-product-card')).toHaveCount(2)
    expect(unmockedApiRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
  }
})
