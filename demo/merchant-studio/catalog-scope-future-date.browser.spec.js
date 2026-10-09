import { expect, test, chromium } from '@playwright/test'

test.setTimeout(60_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18081'
const workspaceId = 'ws_catalog_scope_date_fixture'
const sharedAccountId = 'shared-remote-account-42'
const envelope = (data, error = null) => ({ request_id: 'catalog-scope-date-fixture', trace_id: 'catalog-scope-date-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

function localDate(offsetDays) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const accounts = [
  { platform: 'jd', state: 'manually_registered', readEnabled: false, writeEnabled: false, dataMode: 'manual_upload', accountId: sharedAccountId, storeName: '京东同号店' },
  { platform: 'taobao', state: 'manually_registered', readEnabled: false, writeEnabled: false, dataMode: 'manual_upload', accountId: sharedAccountId, storeName: '淘宝同号店' },
]
const products = [
  { id: 'jd-current', workspaceId, platform: 'jd', accountId: sharedAccountId, storeName: '京东同号店', title: '京东今天商品', createdAt: `${localDate(0)}T08:00:00.000Z`, updatedAt: `${localDate(0)}T08:00:00.000Z`, version: 1 },
  { id: 'jd-future', workspaceId, platform: 'jd', accountId: sharedAccountId, storeName: '京东同号店', title: '京东未来日期商品', createdAt: `${localDate(3)}T08:00:00.000Z`, updatedAt: `${localDate(3)}T08:00:00.000Z`, version: 1 },
  { id: 'taobao-current', workspaceId, platform: 'taobao', accountId: sharedAccountId, storeName: '淘宝同号店', title: '淘宝同号商品', createdAt: `${localDate(0)}T08:00:00.000Z`, updatedAt: `${localDate(0)}T08:00:00.000Z`, version: 1 },
]

async function launchCatalog() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (pathname === '/v1/auth/session') {
      data = { account: { id: 'catalog-scope-user', login: 'catalog-scope@example.invalid', accountType: 'merchant', displayName: '目录验收', status: 'active', workspaceIds: [workspaceId] } }
    } else if (pathname === '/v1/auth/mcp-token') {
      data = { access_token: 'catalog-scope-fixture-token', refresh_token: 'catalog-scope-fixture-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (pathname === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (pathname === '/v1/platform-accounts') {
      data = { items: accounts }
    } else if (pathname === '/v1/products') {
      const request = new URL(route.request().url())
      const offset = Number(request.searchParams.get('offset') ?? 0)
      const limit = Number(request.searchParams.get('limit') ?? 50)
      data = { items: products.slice(offset, offset + limit), total: products.length, limit, offset }
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
  await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
  return { browser, context, page }
}

test('same account ID on two platforms opens the clicked platform store and writes matching URL scope', async () => {
  const { browser, context, page } = await launchCatalog()
  try {
    // Taobao sorts before JD in the platform rail, so the old ID-only global
    // lookup would silently resolve this JD click to the Taobao store.
    await page.getByRole('button', { name: /^京东/u }).click()
    const store = page.locator('.catalog-store-card').filter({ hasText: '京东同号店' })
    await store.getByRole('button', { name: /进入商品库/u }).click()

    await expect(page.getByRole('heading', { name: '京东同号店' })).toBeVisible()
    await expect(page.locator('.catalog-product-card').filter({ hasText: '京东今天商品' })).toHaveCount(1)
    await expect(page.locator('.catalog-product-card').filter({ hasText: '淘宝同号商品' })).toHaveCount(0)
    await expect(page).toHaveURL(/platform=jd/u)
    await expect(page).toHaveURL(/account_id=shared-remote-account-42/u)
  } finally {
    await context.close()
    await browser.close()
  }
})

test('future-dated product does not match a recent-added filter', async () => {
  const { browser, context, page } = await launchCatalog()
  try {
    await page.getByRole('button', { name: /^京东/u }).click()
    const store = page.locator('.catalog-store-card').filter({ hasText: '京东同号店' })
    await store.getByRole('button', { name: /进入商品库/u }).click()
    await expect(page.locator('.catalog-product-card')).toHaveCount(2)

    await page.getByRole('button', { name: '按添加时间筛选' }).click()
    await page.getByRole('option', { name: '近 7 天添加' }).click()
    await expect(page.locator('.catalog-product-card')).toHaveCount(1)
    await expect(page.locator('.catalog-product-card')).toContainText('京东今天商品')
    await expect(page.locator('.catalog-product-card')).not.toContainText('京东未来日期商品')
  } finally {
    await context.close()
    await browser.close()
  }
})
