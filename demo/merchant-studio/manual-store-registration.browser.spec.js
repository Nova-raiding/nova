import { expect, test, chromium } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_manual_store_registration_browser'
const apiEnvelope = (data) => ({ request_id: 'manual-store-browser', trace_id: 'manual-store-browser', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('商家可登记店铺识别资料，并清楚看到该记录仍未授权', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const accounts = []
  const requests = []
  const unexpectedWrites = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const parsed = new URL(request.url())
    const pathname = parsed.pathname.replace(/^\/api/u, '')
    const method = request.method()
    const mcpMethod = pathname === '/mcp' && method === 'POST'
      ? request.postDataJSON()?.method
      : undefined
    const isExpectedMcpRead = pathname === '/mcp' && method === 'POST' && [
      'billing.transactions',
      'creative-points.balance.get',
      'platform.model.status',
      'workspace.metrics',
    ].includes(mcpMethod)
    const isExpectedPost = method === 'POST' && [
      '/v1/auth/mcp-token',
      '/v1/platform-accounts/taobao/manual-record',
    ].includes(pathname)
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !isExpectedPost && !isExpectedMcpRead) {
      unexpectedWrites.push({ method, pathname, ...(mcpMethod ? { mcpMethod } : {}) })
      return route.fulfill({ status: 405, contentType: 'application/json', body: JSON.stringify({
        request_id: 'manual-store-unexpected-write',
        error: { code: 'UNEXPECTED_FIXTURE_WRITE', message: 'unexpected write blocked by browser fixture' },
      }) })
    }
    let data = {}
    if (pathname === '/v1/auth/session') data = { account: { id: 'merchant_browser', login: 'demo@example.invalid', accountType: 'merchant', displayName: '本地验收商家', enterpriseName: '本地验收企业', status: 'active', workspaceIds: [workspaceId] } }
    else if (pathname === '/v1/auth/mcp-token') data = { access_token: 'browser-fixture-access', refresh_token: 'browser-fixture-refresh', expires_in: 300 }
    else if (pathname === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    // Return a fresh API snapshot. Reusing this mutable fixture array would
    // let POST mutate the same React state reference and suppress the refresh.
    else if (pathname === '/v1/platform-accounts' && request.method() === 'GET') data = { items: accounts.map(account => ({ ...account })) }
    else if (pathname === '/v1/platform-accounts/taobao/manual-record' && request.method() === 'POST') {
      const body = request.postDataJSON()
      requests.push({ method: request.method(), pathname, body })
      const accountId = body.account_id
      const storeName = body.store_name
      accounts.push({ platform: 'taobao', accountId, storeName, state: 'manually_registered', readEnabled: false, writeEnabled: false, dataMode: 'account_record_only' })
      data = {
        store: { platform: 'taobao', accountId, storeName, state: 'manually_registered', readEnabled: false, writeEnabled: false },
        connection: { mode: 'manual_store_record', token_state: 'manually_registered', credential_free: true, authorization_receipt: null },
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(apiEnvelope(data)) })
    } else if (pathname === '/v1/products') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (pathname === '/v1/platform-capabilities') data = { items: [] }
    else if (pathname === '/mcp') {
      const resultByMethod = {
        'billing.transactions': { balance_cny: '0.00', transactions: [] },
        'creative-points.balance.get': { balance_state: 'unknown', available_points: null, reserved_points: null, settled_points: null, access_revision: null },
        'platform.model.status': { state: 'unconfigured', capabilities: {}, next_actions: [] },
        'workspace.metrics': { date_from: '', date_to: '', generated_at: '', metrics: [], risks: [] },
      }
      data = { result: resultByMethod[mcpMethod] ?? {} }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(apiEnvelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
    // The fixture starts a fresh Vite process for this spec. Keep the first
    // authenticated route assertion tolerant of cold startup and session
    // hydration, while still failing well before the test's overall timeout.
    await expect(page.getByRole('heading', { name: '选择平台与店铺' })).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: /淘宝/u }).click()
    await expect(page.getByText('仅登记店铺识别信息，不会建立 OAuth 授权，也不会读取店铺数据')).toBeVisible()
    const form = page.locator('form').filter({ has: page.locator('#merchant-manual-store-id') })
    const submit = form.getByRole('button', { name: '登记店铺资料' })
    await expect(submit).toBeDisabled()
    await form.locator('#merchant-manual-store-id').fill('  taobao-shop-42  ')
    await form.locator('#merchant-manual-store-name').fill('  本地验收旗舰店  ')
    await expect(submit).toBeEnabled()
    await submit.click()

    await expect(page.locator('.ant-alert-success')).toContainText('人工登记（未授权）')
    await expect(page.getByRole('heading', { name: '本地验收旗舰店' })).toBeVisible()
    await expect(page.locator('.catalog-store-card')).toContainText('平台未授权；商品资料由工作区人工导入，不代表平台同步')
    expect(requests).toEqual([{ method: 'POST', pathname: '/v1/platform-accounts/taobao/manual-record', body: { account_id: 'taobao-shop-42', store_name: '本地验收旗舰店' } }])
    expect(unexpectedWrites).toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    await context.close()
    await browser.close()
  }
})
