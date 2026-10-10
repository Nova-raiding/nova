import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_catalog_empty_store_fixture'
const store = { platform: 'jd', accountId: 'jd-empty-store', storeName: '尚无商品合成店铺', state: 'manually_registered', readEnabled: false, writeEnabled: false, dataMode: 'manual_upload' }
const envelope = data => ({ request_id: 'catalog-empty-store', trace_id: 'catalog-empty-store', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('catalog distinguishes a successfully read empty store from a filtered no-results state', async ({ page }) => {
  test.setTimeout(60_000)
  const origin = new URL(studioUrl).origin
  const unexpectedRequests = []
  const productReads = []
  const writes = []
  page.on('pageerror', error => unexpectedRequests.push(`pageerror ${error.message}`))

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== origin) {
      unexpectedRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    const method = request.method()
    let mcpMethod = ''
    if (path === '/mcp' && method === 'POST') mcpMethod = request.postDataJSON()?.method ?? ''
    const readOnlyMcp = path === '/mcp' && method === 'POST' && ['billing.transactions', 'creative-points.balance.get', 'platform.model.status', 'workspace.metrics'].includes(mcpMethod)
    if (method !== 'GET' && !(path === '/v1/auth/mcp-token' && method === 'POST') && !readOnlyMcp) {
      writes.push(`${method} ${path}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null)) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') data = { account: { id: 'catalog-empty-reader', login: 'empty-store@example.invalid', accountType: 'merchant', displayName: '空店铺本地验收', status: 'active', workspaceIds: [workspaceId] } }
    else if (path === '/v1/auth/mcp-token') data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    else if (path === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (path === '/v1/platform-accounts') data = { items: [{ ...store }] }
    else if (path === '/v1/products') { productReads.push({ method, query: url.search }); data = { items: [], total: 0, limit: 50, offset: 0 } }
    else if (path === '/mcp') data = { result: mcpMethod === 'workspace.metrics'
      ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
      : mcpMethod === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
  const platform = page.getByRole('button', { name: /^京东/u })
  await expect(platform).toBeVisible()
  if (await platform.getAttribute('aria-pressed') !== 'true') await platform.click()
  const storeCard = page.locator('.catalog-store-card').filter({ hasText: store.storeName })
  await expect(storeCard).toBeVisible()
  await storeCard.getByRole('button', { name: /进入商品库/u }).click()

  await expect(page.getByRole('heading', { name: store.storeName })).toBeVisible()
  const emptyState = page.locator('.catalog-no-results')
  await expect(emptyState.getByText('该店铺还没有商品', { exact: true })).toBeVisible()
  await expect(emptyState).toContainText('平台运营尚未为这家店铺导入商品。')
  await expect(page.getByText('没有找到符合条件的商品', { exact: true })).toHaveCount(0)
  await expect(page.locator('.catalog-product-card')).toHaveCount(0)
  await expect(page.getByText('共找到 0 件商品')).toBeVisible()
  expect(productReads.length).toBeGreaterThan(0)
  expect(writes).toEqual([])
  expect(unexpectedRequests).toEqual([])
})
