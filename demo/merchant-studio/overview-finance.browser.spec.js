import { expect, test, chromium } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4179'
test.setTimeout(60_000)
const envelope = (data) => ({ request_id: 'merchant-overview-browser', trace_id: 'merchant-overview-browser', workspace_id: 'ws_browser', data, warnings: [], next_actions: [], error: null })

async function openIsolatedMerchant(path, entitlement) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', error => console.error(`ISOLATED_PAGE_ERROR ${error.message}`))
  page.on('console', message => { if (message.type() === 'error') console.error(`ISOLATED_CONSOLE_ERROR ${message.text()}`) })
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname.replace(/^\/api/u, '')
    let data
    if (pathname === '/v1/auth/session') data = { account: { id: 'merchant_browser', login: 'demo@ys.com', accountType: 'merchant', displayName: '贵人鸟商家', enterpriseName: '贵人鸟服装', status: 'active', workspaceIds: ['ws_browser'] } }
    else if (pathname === '/v1/auth/mcp-token') data = { access_token: 'browser-fixture-access', refresh_token: 'browser-fixture-refresh', expires_in: 300 }
    // All API calls below are browser fixtures; this is not a live DB probe.
    else if (pathname === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (pathname === '/v1/platform-accounts') data = { items: [{ platform: 'jd', state: 'not_configured', readEnabled: false, writeEnabled: false, dataMode: 'account_record_only', accountId: 'jd-store', storeName: '贵人鸟官方旗舰店' }] }
    else if (pathname === '/v1/brand-scopes') data = { settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} }, revision: 0, updated_at: null, series: [], assignments: [] }
    else if (pathname === '/v1/products') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (pathname === '/mcp') {
      const method = route.request().postDataJSON()?.method
      data = { result: method === 'subscription.get' ? { commercial_entitlement: entitlement, legacy_commercial_entitlement: { plan: 'starter', status: 'trial' } }
        : method === 'workspace.metrics' ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: { approved: 0 }, riskSummary: { total: 0, returned: 0, truncated: false } }
          : method === 'creative-points.balance.get' ? { available_points: 12594 }
            : method === 'billing.transactions' ? { balance_cny: '0.00', transactions: [] }
              : method === 'commercial.catalog.get' ? { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [] }
                : { items: [], total: 0, limit: 50, offset: 0 } }
    } else data = { items: [], total: 0, limit: 50, offset: 0 }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })
  // The candidate URL ends with `/`; resolve the route so the browser never
  // receives a protocol-relative `//merchant/...` path.
  await page.goto(new URL(path, studioUrl).href, { waitUntil: 'domcontentloaded' })
  return { browser, context, page }
}

test('overview connection action opens platform and store catalog', async () => {
  const { browser, context, page } = await openIsolatedMerchant('/merchant/overview', { schema_version: 'commercial.entitlement.v2', status: 'unknown' })
  try {
    const connections = page.locator('.account-platform-block')
    await expect(connections).toContainText('0/1 已接入')
    await expect(connections).toContainText('人工登记（未授权）')
    await expect(page.locator('.account-store-block')).toContainText('暂无')
    await expect(connections).not.toContainText('平台连接未读取')
    await page.getByRole('button', { name: '进入店铺连接' }).click()
    await expect(page).toHaveURL(/\/merchant\/products\?section=products/u)
    await expect(page.getByRole('heading', { name: '选择平台与店铺' })).toBeVisible()
  } finally { await context.close(); await browser.close() }
})

test('brand assets removes the duplicate no-readable-store banner after scoped settings load', async () => {
  const { browser, context, page } = await openIsolatedMerchant('/merchant/products?section=assets', { schema_version: 'commercial.entitlement.v2', status: 'unknown' })
  try {
    const storeScope = page.getByTestId('brand-scope-unavailable-02')
    await expect(storeScope).toBeVisible()
    await expect(storeScope).toContainText('已登记店铺尚未取得可读取授权')
    await expect(page.locator('.material-brand-no-store')).toHaveCount(0)
    await expect(page.getByTestId('brand-scope-unavailable-03')).toBeVisible()
  } finally { await context.close(); await browser.close() }
})

test('finance shows only the active V2 Growth plan and period', async () => {
  const entitlement = { schema_version: 'commercial.entitlement.v2', status: 'available', plan: 'growth', period: { start: '2026-09-27T12:53:13.872Z', end: '2026-10-27T12:53:13.872Z' }, entitlement_id: 'ces_browser' }
  const { browser, context, page } = await openIsolatedMerchant('/merchant/finance', entitlement)
  try {
    const card = page.getByRole('region', { name: '账号版本与有效期' })
    await expect(card).toContainText('成长版')
    await expect(card).toContainText('有效期至 2026/10/27')
    await expect(card).not.toContainText('试用中')
  } finally { await context.close(); await browser.close() }
})

test('finance does not upgrade legacy Trial or wallet facts into a current plan', async () => {
  const { browser, context, page } = await openIsolatedMerchant('/merchant/finance', { schema_version: 'commercial.entitlement.v2', status: 'unknown' })
  try {
    const card = page.getByRole('region', { name: '账号版本与有效期' })
    await expect(card).toContainText('服务端未确认当前账号版本')
    await expect(card).not.toContainText('成长版')
    await expect(card).not.toContainText('试用中')
  } finally { await context.close(); await browser.close() }
})
