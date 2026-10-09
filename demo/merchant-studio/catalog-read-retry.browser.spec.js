import { expect, test, chromium } from '@playwright/test'

test.setTimeout(60_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_catalog_read_retry_fixture'
const accountId = 'jd-catalog-retry-store'
const product = {
  id: 'product-catalog-retry-1', workspaceId, platform: 'jd', accountId,
  storeName: '目录重试验收店', remoteId: 'remote-catalog-retry-1', title: '重试后可见的商品',
  skuCount: 1, stock: 10, factsConfirmed: true, source: 'manual_import',
  createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z', version: 1,
}
const envelope = (data, error = null) => ({
  request_id: 'catalog-read-retry-fixture', trace_id: 'catalog-read-retry-fixture',
  workspace_id: workspaceId, data, warnings: [], next_actions: [], error,
})

test('catalog API read failure exposes a retry and recovers to server data', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  let productReads = 0
  let allowProductRead = false

  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const pathname = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (pathname === '/v1/auth/session') {
      data = { account: { id: 'catalog-retry-user', login: 'catalog-retry@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceId] } }
    } else if (pathname === '/v1/auth/mcp-token') {
      data = { access_token: 'catalog-retry-token', refresh_token: 'catalog-retry-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (pathname === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (pathname === '/v1/platform-accounts') {
      data = { items: [{ platform: 'jd', state: 'manually_registered', readEnabled: false, writeEnabled: false, dataMode: 'manual_upload', accountId, storeName: '目录重试验收店' }] }
    } else if (pathname === '/v1/products') {
      productReads += 1
      // App initially reads with an unknown apiMode, then re-reads after
      // /healthz resolves. Keep the outage active until the user retries so
      // that this test observes the stable failure state rather than a race.
      if (!allowProductRead) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '暂时无法读取商品' })) })
        return
      }
      data = { items: [product], total: 1, limit: 50, offset: 0 }
    } else if (pathname === '/mcp') {
      const method = route.request().postDataJSON()?.method
      data = { result: method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 1, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } }
        : method === 'platform.model.status'
          ? { state: 'ready', capabilities: { image_generation: false } }
          : {} }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /^京东/u }).click()
    await page.locator('.catalog-store-card').filter({ hasText: '目录重试验收店' }).getByRole('button', { name: /进入商品库/u }).click()
    await expect(page.getByLabel('商品目录读取错误').getByText(/商品读取失败：/u)).toBeVisible()
    const readsBeforeRetry = productReads
    allowProductRead = true
    await page.getByRole('button', { name: '重新读取' }).click()
    await expect.poll(() => productReads).toBeGreaterThan(readsBeforeRetry)
    await expect(page.getByText(/商品读取失败：/u)).toHaveCount(0)
    await expect(page.locator('.catalog-product-card')).toContainText('重试后可见的商品')
  } finally {
    await context.close()
    await browser.close()
  }
})
