import { expect, test, chromium } from '@playwright/test'

test.setTimeout(60_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_topbar_search_fixture'
const store = { platform: 'jd', state: 'manually_registered', readEnabled: false, writeEnabled: false, dataMode: 'manual_upload', accountId: 'jd-topbar-search-store', storeName: '顶部搜索验收店' }
const products = [
  { id: 'product-topbar-search-1', workspaceId, platform: 'jd', accountId: store.accountId, storeName: store.storeName, remoteId: 'remote-topbar-1', title: '轻云咖啡机', skuCount: 1, stock: 10, factsConfirmed: true, source: 'manual_import', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z', version: 1 },
  { id: 'product-topbar-search-2', workspaceId, platform: 'jd', accountId: store.accountId, storeName: store.storeName, remoteId: 'remote-topbar-2', title: '晴空保温杯', skuCount: 1, stock: 8, factsConfirmed: true, source: 'manual_import', createdAt: '2026-10-02T08:00:00.000Z', updatedAt: '2026-10-02T08:00:00.000Z', version: 1 },
]
const envelope = (data) => ({ request_id: 'topbar-search-fixture', trace_id: 'topbar-search-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('topbar global search opens the product catalog and restores the query and filtered results', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const apiCalls = []

  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const pathname = url.pathname.replace(/^\/api/u, '')
    apiCalls.push({ pathname, method: route.request().method() })
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (pathname === '/v1/auth/session') {
      data = { account: { id: 'topbar-search-user', login: 'topbar-search@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceId] } }
    } else if (pathname === '/v1/auth/mcp-token') {
      data = { access_token: 'topbar-search-token', refresh_token: 'topbar-search-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (pathname === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (pathname === '/v1/platform-accounts') {
      data = { items: [store] }
    } else if (pathname === '/v1/products') {
      data = { items: products, total: products.length, limit: 50, offset: 0 }
    } else if (pathname === '/mcp') {
      const method = route.request().postDataJSON()?.method
      data = { result: method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: products.length, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } }
        : method === 'platform.model.status'
          ? { state: 'ready', capabilities: { image_generation: false } }
          : {} }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    const globalSearch = page.getByRole('search', { name: '商品全局搜索' }).getByRole('textbox', { name: '全局搜索商品' })
    await expect(globalSearch).toBeVisible()
    await globalSearch.fill('轻云')
    await globalSearch.press('Enter')

    await expect.poll(() => {
      const url = new URL(page.url())
      return { pathname: url.pathname, section: url.searchParams.get('section'), query: url.searchParams.get('q') }
    }).toEqual({ pathname: '/merchant/products', section: 'products', query: '轻云' })
    await expect(page.locator('.topbar h1')).toHaveText('平台&店铺&商品')
    // A second search submitted while already on the product page must replace
    // the page-local query instead of silently retaining the first one.
    await globalSearch.fill('晴空')
    await globalSearch.press('Enter')
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('晴空')
    const platform = page.getByRole('button', { name: /^京东/u })
    await platform.click()
    await expect(platform).toHaveAttribute('aria-pressed', 'true')
    await page.locator('.catalog-store-card').filter({ hasText: store.storeName }).getByRole('button', { name: /进入商品库/u }).click()
    const catalogSearch = page.getByRole('textbox', { name: '搜索商品名称或关键词' })
    await expect(catalogSearch).toHaveValue('晴空')
    await expect(page.locator('.catalog-product-card')).toHaveCount(1)
    await expect(page.locator('.catalog-product-card')).toContainText('晴空保温杯')
    await expect(page.locator('.catalog-product-card')).not.toContainText('轻云咖啡机')
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('晴空')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('textbox', { name: '搜索商品名称或关键词' })).toHaveValue('晴空')
    await expect(page.locator('.catalog-product-card')).toHaveCount(1)
    await expect(page.locator('.catalog-product-card')).toContainText('晴空保温杯')
    expect(apiCalls.some(call => call.pathname === '/v1/platform-accounts')).toBe(true)
    expect(apiCalls.some(call => call.pathname === '/v1/products')).toBe(true)
  } finally {
    await context.close()
    await browser.close()
  }
})
