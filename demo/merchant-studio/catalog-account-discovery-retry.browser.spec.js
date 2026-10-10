import { chromium, expect, test } from '@playwright/test'

test.setTimeout(60_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_catalog_account_retry_fixture'
const accountId = 'jd-catalog-account-retry-store'
const envelope = (data, error = null) => ({
  request_id: 'catalog-account-retry-fixture', trace_id: 'catalog-account-retry-fixture',
  workspace_id: workspaceId, data, warnings: [], next_actions: [], error,
})

test('failed store discovery hides guessed stores and recovers after an explicit read retry', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const unmockedWrites = []
  let accountReads = 0
  let allowAccountRead = false
  const accountReadWorkspaceHeaders = []

  await page.route('**/api/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (pathname === '/v1/auth/session') {
      data = { account: { id: 'catalog-account-retry-user', login: 'catalog-account-retry@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceId] } }
    } else if (pathname === '/v1/auth/mcp-token') {
      data = { access_token: 'catalog-account-retry-token', refresh_token: 'catalog-account-retry-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (pathname === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (pathname === '/v1/platform-accounts') {
      accountReads += 1
      accountReadWorkspaceHeaders.push(request.headers()['x-workspace-id'] ?? null)
      if (!allowAccountRead) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '暂时无法读取店铺' })) })
      }
      data = { items: [{ platform: 'jd', state: 'manually_registered', readEnabled: false, writeEnabled: false, dataMode: 'manual_upload', accountId, storeName: '店铺重试验收店' }] }
    } else if (pathname === '/v1/products') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (pathname === '/mcp') {
      const method = request.postDataJSON()?.method
      data = { result: method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } }
        : method === 'platform.model.status'
          ? { state: 'ready', capabilities: { image_generation: false } }
          : {} }
    } else {
      unmockedWrites.push(`${request.method()} ${pathname}`)
      return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNMOCKED_CATALOG_ACCOUNT_RETRY_FIXTURE' })) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.topbar h1')).toHaveText('平台&店铺&商品')
    await expect(page.getByLabel('商品目录读取错误').getByText(/平台与店铺读取失败：/u)).toBeVisible()
    await expect(page.locator('.catalog-store-card')).toHaveCount(0)

    const readsBeforeRetry = accountReads
    allowAccountRead = true
    await page.getByLabel('商品目录读取错误').getByRole('button', { name: '重新读取' }).click()
    await expect.poll(() => accountReads, { timeout: 10_000 }).toBeGreaterThan(readsBeforeRetry)
    const jdPlatform = page.getByRole('button', { name: /^京东/u })
    await expect(jdPlatform).toBeVisible()
    await jdPlatform.click()
    await expect(page.locator('.catalog-store-card').filter({ hasText: '店铺重试验收店' })).toBeVisible()
    await expect(page.locator('.catalog-store-card').getByRole('button', { name: /进入商品库/u })).toBeVisible()
    await page.locator('.catalog-store-card').getByRole('button', { name: /进入商品库/u }).click()
    await expect(page.locator('.catalog-no-results')).toContainText('该店铺还没有商品')
    await expect(page.locator('.catalog-no-results')).toContainText('平台运营尚未为这家店铺导入商品')
    expect(accountReadWorkspaceHeaders.length).toBeGreaterThanOrEqual(2)
    expect(accountReadWorkspaceHeaders).toEqual(Array(accountReadWorkspaceHeaders.length).fill(workspaceId))
    expect(unmockedWrites).toEqual([])
  } finally {
    await context.close()
    await browser.close()
  }
})
