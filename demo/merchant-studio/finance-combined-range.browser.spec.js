import { expect, test, chromium } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4190'
const envelope = (data) => ({ request_id: 'finance-range-browser', trace_id: 'finance-range-browser', workspace_id: 'ws_browser', data, warnings: [], next_actions: [], error: null })

test('finance combined month filters apply together and keep the ledger read isolated', async () => {
  test.setTimeout(120_000)
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  context.setDefaultTimeout(5_000)
  const page = await context.newPage()
  let ledgerReads = 0
  page.on('pageerror', error => console.error(`ISOLATED_PAGE_ERROR ${error.message}`))
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname.replace(/^\/api/u, '')
    let data
    if (pathname === '/v1/auth/session') data = { account: { id: 'merchant_browser', login: 'demo@ys.com', accountType: 'merchant', displayName: '测试商家', enterpriseName: '测试企业', status: 'active', workspaceIds: ['ws_browser'] } }
    else if (pathname === '/v1/auth/mcp-token') data = { access_token: 'browser-fixture-access', refresh_token: 'browser-fixture-refresh', expires_in: 300 }
    else if (pathname === '/v1/platform-accounts') data = { items: [] }
    else if (pathname === '/v1/brand-scopes') data = { settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} }, revision: 0, updated_at: null, series: [], assignments: [] }
    else if (pathname === '/v1/products') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (pathname === '/v1/assets') data = { used_bytes: 0, limit_bytes: 1000000, available_bytes: 1000000 }
    else if (pathname === '/mcp') {
      const { method } = route.request().postDataJSON()
      if (method === 'creative-points.statement.list') {
        ledgerReads += 1
        data = { result: { entries: [
          { id: 'sep-a', workspaceId: 'ws_browser', operationId: 'op-a', eventType: 'settled', pointsDelta: -10, createdAt: '2026-09-02T04:00:00.000Z', intent: { actual_points: 10 } },
          { id: 'sep-b', workspaceId: 'ws_browser', operationId: 'op-b', eventType: 'settled', pointsDelta: -20, createdAt: '2026-09-12T04:00:00.000Z', intent: { actual_points: 20 } },
          { id: 'oct-a', workspaceId: 'ws_browser', operationId: 'op-c', eventType: 'settled', pointsDelta: -30, createdAt: '2026-10-01T04:00:00.000Z', intent: { actual_points: 30 } },
        ] } }
      } else data = { result: method === 'subscription.get' ? { commercial_entitlement: { schema_version: 'commercial.entitlement.v2', status: 'unknown' } }
        : method === 'creative-points.balance.get' ? { available_points: 100 }
          : method === 'billing.transactions' ? { balance_cny: '0.00', transactions: [] }
            : method === 'commercial.catalog.get' ? { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [] }
              : { items: [], total: 0, limit: 50, offset: 0 } }
    } else data = { items: [], total: 0, limit: 50, offset: 0 }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(new URL('/merchant/finance', studioUrl).href, { waitUntil: 'domcontentloaded' })
    const panel = page.locator('.finance-usage-panel')
    await expect(panel.getByRole('heading', { name: '创意点消耗趋势' })).toBeVisible()
    await expect.poll(() => ledgerReads).toBeGreaterThan(0)
    const initialLedgerReads = ledgerReads

    await panel.locator('.finance-query-select').click()
    await page.getByText('按月份', { exact: true }).click()
    const dates = panel.locator('.finance-date-picker input')
    await dates.nth(0).click()
    await page.waitForTimeout(350)
    await page.locator('.finance-date-picker-popup:visible .ant-picker-cell-inner:visible').filter({ hasText: /^9月$/u }).first().click()
    await dates.nth(1).click()
    await page.waitForTimeout(350)
    await page.locator('.finance-date-picker-popup:visible .ant-picker-cell-inner:visible').filter({ hasText: /^10月$/u }).first().click()
    await expect(panel.getByRole('status').filter({ hasText: '日期范围已修改' })).toBeVisible()
    await panel.getByRole('button', { name: '查询' }).click()
    await expect(panel.locator('.finance-chart-summary')).toContainText('2026/09 至 2026/10')
    await expect(panel.locator('.finance-chart-summary')).toContainText('合计 60 点')
    await expect(panel.locator('.finance-chart-summary')).toContainText('2 个数据点')

    // A pending end-month change must not alter the applied result before submit.
    await dates.nth(1).click()
    await page.waitForTimeout(350)
    await page.locator('.finance-date-picker-popup:visible .ant-picker-cell-inner:visible').filter({ hasText: /^9月$/u }).first().click()
    await expect(panel.locator('.finance-chart-summary')).toContainText('2026/09 至 2026/10')
    await panel.getByRole('button', { name: '查询' }).click()
    await expect(panel.locator('.finance-chart-summary')).toContainText('2026/09 至 2026/09')
    await expect(panel.locator('.finance-chart-summary')).toContainText('合计 30 点')
    expect(ledgerReads).toBe(initialLedgerReads)
  } finally {
    await context.close()
    await browser.close()
  }
})
