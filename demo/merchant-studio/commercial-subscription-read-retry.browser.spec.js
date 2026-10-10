import { expect, test, chromium } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_commercial_retry_browser'
test.setTimeout(60_000)

test('套餐读取失败时保留可见错误，刷新后恢复且不创建订单', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const calls = []
  const pageErrors = []
  let subscriptionReads = 0
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname.replace(/^\/api/u, '')
    let data = {}
    if (pathname === '/v1/auth/session') data = { account: { id: 'merchant_retry', login: 'retry@example.invalid', accountType: 'merchant', displayName: '本地验收商家', enterpriseName: '本地验收企业', status: 'active', workspaceIds: [workspaceId] } }
    else if (pathname === '/v1/auth/mcp-token') data = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 300 }
    else if (pathname === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (pathname === '/mcp') {
      const body = request.postDataJSON()
      calls.push({ method: body.method, workspaceId: request.headers()['x-workspace-id'] })
      if (body.method === 'commercial.catalog.get') data = { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [] }
      else if (body.method === 'commercial.subscription.get') {
        subscriptionReads += 1
        if (subscriptionReads <= 2) return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ request_id: 'subscription-read-failed', trace_id: 'subscription-read-failed', workspace_id: workspaceId, error: { code: 'FIXTURE_READ_UNAVAILABLE', message: '本地模拟套餐读取失败' } }),
        })
        data = { schema_version: 'commercial.subscription.v1', status: 'available', onboarding_qualified: false, current: null, future: [], packs: [], history: [], orders: [] }
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ request_id: 'commercial-retry', trace_id: 'commercial-retry', workspace_id: workspaceId, data: { result: data }, warnings: [], next_actions: [], error: null }) })
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ request_id: 'commercial-retry', trace_id: 'commercial-retry', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null }) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/finance`, { waitUntil: 'domcontentloaded' })
    const center = page.getByRole('region', { name: '套餐与权益包' })
    const alert = center.locator('.ant-alert').filter({ hasText: '套餐事实未读取成功' })
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('套餐事实未读取成功')
    await expect(alert).toContainText('暂不能新购或升级')
    await center.getByRole('button', { name: '刷新已购与商品' }).click()
    await expect(center.getByText('账户开通资格：待开通；开通费与首期套餐分别计费', { exact: true })).toBeVisible()
    expect(subscriptionReads).toBe(3)
    expect(calls.filter(call => call.method === 'commercial.subscription.get').every(call => call.workspaceId === workspaceId)).toBe(true)
    expect(calls.filter(call => /(?:create|payment)/u.test(call.method))).toEqual([])
    expect(pageErrors).toEqual([])
    await page.screenshot({ path: test.info().outputPath('commercial-subscription-read-recovered.png'), fullPage: true })
  } finally {
    await context.close()
    await browser.close()
  }
})
