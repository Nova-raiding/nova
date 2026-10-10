import { expect, test, chromium } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_finance_ledger_details_fixture'
const envelope = (data) => ({ request_id: 'finance-ledger-details', trace_id: 'finance-ledger-details', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('finance ledger pagination preserves server rows and exposes each row source details', async () => {
  test.setTimeout(60_000)
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const unknownRequests = []
  const entries = Array.from({ length: 11 }, (_, index) => ({
    id: `ledger-${index + 1}`,
    workspaceId,
    operationId: `operation-${index + 1}`,
    eventType: index === 10 ? 'settled' : 'granted',
    pointsDelta: index === 10 ? -75 : 100,
    intent: index === 10 ? { actual_points: 75 } : {},
    createdAt: `2026-10-${String(index + 1).padStart(2, '0')}T04:00:00.000Z`,
    commercial_origin: { status: 'known', kind: index === 10 ? 'point_pack' : 'subscription_points', source_order_id: `order-${index + 1}`, sku_version_id: `sku-v${index + 1}`, grant_id: `grant-${index + 1}` },
  }))
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname.replace(/^\/api/u, '')
    let data
    if (pathname === '/v1/auth/session') data = { account: { id: 'merchant-ledger', login: 'ledger@example.invalid', accountType: 'merchant', displayName: '账本验收商家', enterpriseName: '本地夹具企业', status: 'active', workspaceIds: [workspaceId] } }
    else if (pathname === '/v1/auth/mcp-token') data = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 300 }
    else if (pathname === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (pathname === '/v1/assets') data = { used_bytes: 0, limit_bytes: 1000000, available_bytes: 1000000 }
    else if (pathname === '/mcp') {
      const { method } = request.postDataJSON()
      if (method === 'creative-points.statement.list') data = { result: { entries } }
      else if (method === 'subscription.get' || method === 'commercial.subscription.get') data = { result: { schema_version: 'commercial.subscription.v1', status: 'available', current: null, future: [], packs: [], history: [], orders: [] } }
      else if (method === 'creative-points.balance.get') data = { result: { available_points: 400 } }
      else if (method === 'billing.transactions') data = { result: { balance_cny: '0.00', transactions: [] } }
      else if (method === 'commercial.catalog.get') data = { result: { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [] } }
      else data = { result: {} }
    } else {
      unknownRequests.push(`${request.method()} ${pathname}`)
      return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ ...envelope(null), error: { code: 'FIXTURE_UNKNOWN_REQUEST', message: 'Unmocked local API request blocked.' } }) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(new URL('/merchant/finance', studioUrl).href, { waitUntil: 'domcontentloaded' })
    const ledger = page.getByRole('region', { name: '创意点来源账本' })
    await expect(ledger.getByRole('row')).toHaveCount(11) // header + ten entries
    const firstRow = ledger.getByRole('row').filter({ hasText: '2026/10/1 12:00:00' })
    await firstRow.getByText('查看流水来源').click()
    await expect(firstRow).toContainText('来源订单 order-1')
    await expect(firstRow).toContainText('冻结版本 sku-v1')
    await ledger.getByRole('listitem', { name: '2' }).click()
    const lastRow = ledger.getByRole('row').filter({ hasText: '实际消耗' })
    await expect(lastRow).toBeVisible()
    await expect(lastRow).toContainText('实际消耗')
    await lastRow.getByText('查看流水来源').click()
    await expect(lastRow).toContainText('权益包点数')
    await expect(lastRow).toContainText('来源订单 order-11')
    expect(unknownRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
  }
})
