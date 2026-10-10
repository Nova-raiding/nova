import { expect, test, chromium } from '@playwright/test'

test.setTimeout(60_000)

if (!process.env.MERCHANT_STUDIO_URL && process.env.MERCHANT_CATALOG_BROWSER_FIXTURE !== '1') {
  throw new Error('Set MERCHANT_CATALOG_BROWSER_FIXTURE=1 to use the local Vite fixture, or provide an explicit MERCHANT_STUDIO_URL.')
}

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_catalog_keyboard_fixture'
const accountId = 'jd-catalog-keyboard-store'
const envelope = (data) => ({ request_id: 'catalog-keyboard-fixture', trace_id: 'catalog-keyboard-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('catalog date filter supports keyboard navigation and restores focus on selection or Escape', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const unmockedApiRequests = []

  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (pathname === '/v1/auth/session') {
      data = { account: { id: 'catalog-keyboard-user', login: 'catalog-keyboard@example.invalid', accountType: 'merchant', displayName: '键盘验收', status: 'active', workspaceIds: [workspaceId] } }
    } else if (pathname === '/v1/auth/mcp-token') {
      data = { access_token: 'catalog-keyboard-fixture-token', refresh_token: 'catalog-keyboard-fixture-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (pathname === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (pathname === '/v1/platform-accounts') {
      data = { items: [{ platform: 'jd', state: 'manually_registered', readEnabled: false, writeEnabled: false, dataMode: 'manual_upload', accountId, storeName: '键盘验收店' }] }
    } else if (pathname === '/v1/products') {
      data = { items: [{ id: 'keyboard-product', workspaceId, platform: 'jd', accountId, storeName: '键盘验收店', title: '键盘测试商品', createdAt: '2026-10-10T08:00:00.000Z', updatedAt: '2026-10-10T08:00:00.000Z', version: 1 }], total: 1, limit: 50, offset: 0 }
    } else if (pathname === '/mcp') {
      const method = route.request().postDataJSON()?.method
      data = { result: method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 1, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } }
        : method === 'platform.model.status'
          ? { state: 'ready', capabilities: { image_generation: false } }
          : {} }
    } else {
      unmockedApiRequests.push(`${route.request().method()} ${pathname}`)
      await route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ ...envelope(null), error: { code: 'UNMOCKED_CATALOG_KEYBOARD_FIXTURE' } }) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
    const jdPlatform = page.getByRole('button', { name: /^京东/u })
    await expect(jdPlatform).toBeVisible()
    if (await jdPlatform.getAttribute('aria-pressed') !== 'true') await jdPlatform.click()
    const store = page.locator('.catalog-store-card').filter({ hasText: '键盘验收店' })
    await expect(store).toBeVisible()
    await store.getByRole('button', { name: /进入商品库/u }).click()
    await expect(page.locator('.catalog-product-card')).toHaveCount(1)

    const filter = page.getByRole('button', { name: '按添加时间筛选' })
    const listbox = page.getByRole('listbox', { name: '按添加时间筛选' })
    await filter.focus()
    await page.keyboard.press('Enter')
    await expect(listbox).toBeVisible()
    await expect(page.getByRole('option', { name: '全部添加时间' })).toBeFocused()

    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('option', { name: '近 7 天添加' })).toBeFocused()
    await page.keyboard.press('End')
    await expect(page.getByRole('option', { name: '近 90 天添加' })).toBeFocused()
    await page.keyboard.press('Home')
    await expect(page.getByRole('option', { name: '全部添加时间' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(listbox).toHaveCount(0)
    await expect(filter).toContainText('近 7 天添加')
    await expect(filter).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(listbox).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(listbox).toHaveCount(0)
    await expect(filter).toBeFocused()
    expect(unmockedApiRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
  }
})
