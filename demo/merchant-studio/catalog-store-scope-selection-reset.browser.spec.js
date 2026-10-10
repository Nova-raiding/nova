import { expect, test } from '@playwright/test'

test.setTimeout(60_000)
const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_catalog_store_scope_fixture'
const platform = 'jd'
const stores = [
  { accountId: 'jd-store-a', storeName: '目录范围店铺 A' },
  { accountId: 'jd-store-b', storeName: '目录范围店铺 B' },
]
const envelope = data => ({ request_id: 'catalog-store-scope-fixture', trace_id: 'catalog-store-scope-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })
function localDate(offsetDays) {
  const date = new Date()
  date.setDate(date.getDate() - offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const productSeeds = [
  ['coffee-new', '轻云咖啡机', 0], ['pour-over', '云朵手冲壶', 5], ['thermos', '晴空保温杯', 20], ['filter', '山野滤杯', 60],
  ['grinder', '晨光磨豆机', 120], ['scale', '便携咖啡秤', 0], ['server', '玻璃分享壶', 5], ['rack', '陶瓷滤纸架', 20],
]
const products = stores.flatMap(store => productSeeds.map(([suffix, title, age]) => ({
  id: `${store.accountId}-${suffix}`, workspaceId, platform, accountId: store.accountId, storeName: store.storeName, title,
  skuCount: 1, stock: 10, factsConfirmed: true, source: 'manual_import',
  createdAt: `${localDate(age)}T08:00:00.000Z`, updatedAt: `${localDate(age)}T08:00:00.000Z`, version: 1,
})))

test('catalog query, selection, filters and sort are scoped and reset when changing stores', async ({ page }) => {
  const origin = new URL(studioUrl).origin
  const unexpectedRequests = []
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) { unexpectedRequests.push(url.origin); await route.abort(); return }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') data = { account: { id: 'catalog-scope-user', login: 'catalog-scope@example.invalid', accountType: 'merchant', displayName: '目录范围验收', status: 'active', workspaceIds: [workspaceId] } }
    else if (path === '/v1/auth/mcp-token') data = { access_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_in: 300, workspace_id: workspaceId }
    else if (path === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (path === '/v1/platform-accounts') data = { items: stores.map(store => ({ platform, state: 'manually_registered', readEnabled: false, writeEnabled: false, dataMode: 'manual_upload', ...store })) }
    else if (path === '/v1/products') data = { items: products, total: products.length, limit: 50, offset: 0 }
    else if (path === '/mcp') {
      const method = route.request().postDataJSON()?.method
      data = { result: method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: products.length, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } }
        : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    } else { unexpectedRequests.push(`unmocked ${route.request().method()} ${path}`); await route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify(envelope(null)) }); return }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
  const jd = page.getByRole('button', { name: /^京东/u })
  await expect(jd).toBeVisible()
  if (await jd.getAttribute('aria-pressed') !== 'true') await jd.click()
  const storeA = page.locator('.catalog-store-card').filter({ hasText: stores[0].storeName })
  await expect(storeA).toBeVisible()
  await storeA.getByRole('button', { name: /进入商品库/u }).click()

  const catalogSearch = page.getByRole('textbox', { name: '搜索商品名称或关键词' })
  const topbarSearch = page.getByRole('textbox', { name: '全局搜索商品' })
  await expect(catalogSearch).toBeVisible()
  await expect(page.locator('.catalog-product-card')).toHaveCount(6)
  await expect(page.locator('.catalog-product-select')).toHaveCount(0)
  await expect(page.locator('.catalog-batch-operation-card')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /批量删除/u })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '打开轻云咖啡机商品详情' })).toBeVisible()
  await catalogSearch.fill('不存在的商品')
  await expect(page.getByText('没有找到符合条件的商品', { exact: true })).toBeVisible()
  await expect(topbarSearch).toHaveValue('不存在的商品')
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('不存在的商品')
  await page.getByRole('button', { name: '清除全部条件' }).click()
  await expect(catalogSearch).toHaveValue('')
  await expect(topbarSearch).toHaveValue('')
  await expect.poll(() => new URL(page.url()).searchParams.has('q')).toBe(false)
  await expect(page.locator('.catalog-product-card')).toHaveCount(6)

  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page.getByRole('navigation', { name: '商品分页' })).toContainText('第 2 / 2 页')
  await expect(page.locator('.catalog-product-select')).toHaveCount(0)

  await page.getByRole('button', { name: '按添加时间筛选' }).click()
  await page.getByRole('option', { name: '近 7 天添加' }).click()
  await expect(page.locator('.catalog-product-card')).toHaveCount(4)
  await page.getByRole('button', { name: '商品排序方式' }).click()
  await page.getByRole('option', { name: '添加时间从旧到新' }).click()
  await expect(page.getByRole('button', { name: '商品排序方式' })).toContainText('添加时间从旧到新')

  await page.getByRole('button', { name: '返回店铺选择' }).click()
  const selectionUrl = new URL(page.url())
  expect(selectionUrl.searchParams.get('platform')).toBe(platform)
  expect(selectionUrl.searchParams.get('section')).toBe('products')
  expect(selectionUrl.searchParams.has('account_id')).toBe(false)
  expect(selectionUrl.searchParams.has('q')).toBe(false)
  await expect(topbarSearch).toHaveValue('')
  const storeB = page.locator('.catalog-store-card').filter({ hasText: stores[1].storeName })
  await expect(storeB).toBeVisible()
  await storeB.getByRole('button', { name: /进入商品库/u }).click()
  await expect(page.getByRole('heading', { name: stores[1].storeName })).toBeVisible()
  await expect(catalogSearch).toHaveValue('')
  await expect(topbarSearch).toHaveValue('')
  await expect(page.locator('.catalog-product-select')).toHaveCount(0)
  await expect(page.locator('.catalog-batch-operation-card')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '按添加时间筛选' })).toContainText('全部添加时间')
  await expect(page.getByRole('button', { name: '商品排序方式' })).toContainText('添加时间从新到旧')
  await expect(page.getByRole('navigation', { name: '商品分页' })).toContainText('第 1 / 2 页')
  const storeBUrl = new URL(page.url())
  expect(storeBUrl.searchParams.get('platform')).toBe(platform)
  expect(storeBUrl.searchParams.get('account_id')).toBe(stores[1].accountId)
  expect(storeBUrl.searchParams.has('q')).toBe(false)
  expect(unexpectedRequests).toEqual([])
})
