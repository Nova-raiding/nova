import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_finance_read_recovery_fixture'
const envelope = (data, error = null) => ({ request_id: 'finance-read-recovery-fixture', trace_id: 'finance-read-recovery-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('finance data failures stay unknown until one explicit retry recovers balance, ledger and storage', async () => {
  test.setTimeout(90_000)
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Finance read recovery fixture did not bind an ephemeral TCP port')
  }

  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const requests = []
  const writeRequests = []
  let userRetried = false
  const statement = [{
    id: 'finance-recovered-entry', workspaceId, operationId: 'finance-recovered-operation', eventType: 'settled', pointsDelta: -25,
    intent: { actual_points: 25 }, createdAt: '2026-10-10T04:00:00.000Z',
    commercial_origin: { status: 'known', kind: 'point_pack', source_order_id: 'order-finance-fixture', sku_version_id: 'sku-finance-v1', grant_id: 'grant-finance-fixture' },
  }]

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== studioUrl) return route.abort('blockedbyclient')
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const request = route.request()
    const path = url.pathname
    if (path === '/api/healthz') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true }, platformOperations: { mode: 'manual', ready: true } } })) })
    if (path === '/api/v1/auth/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: { id: 'finance-read-user', login: 'finance-read@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })) })
    if (path === '/api/v1/auth/mcp-token') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ access_token: 'finance-read-token', refresh_token: 'finance-read-refresh', token_type: 'Bearer', expires_in: 300, workspace_id: workspaceId })) })
    if (path === '/api/v1/assets') {
      requests.push({ path, method: request.method(), query: url.search })
      if (!userRetried && url.searchParams.get('limit') === '1') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'QUOTA_READ_UNAVAILABLE', message: '储存配额读取暂不可用。' })) })
      if (request.method() !== 'GET') writeRequests.push(`${request.method()} ${path}`)
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0, storage_quota: { usedBytes: userRetried ? 536_870_912 : 0, reservedBytes: 0, limitBytes: 2_147_483_648, availableBytes: userRetried ? 1_610_612_736 : 0, status: 'available' } })) })
    }
    if (path === '/api/mcp') {
      const rpc = request.postDataJSON()
      const method = rpc?.method ?? ''
      requests.push({ path, method, workspaceId: request.headers()['x-workspace-id'] ?? '' })
      const failRead = !userRetried && ['creative-points.balance.get', 'billing.transactions', 'creative-points.statement.list'].includes(method)
      if (failRead) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FINANCE_READ_UNAVAILABLE', message: `本地模拟 ${method} 读取失败。` })) })
      let result = {}
      if (method === 'creative-points.balance.get') result = { balance_state: 'known', available_points: 245 }
      else if (method === 'billing.transactions') result = { balance_cny: '0.00', transactions: [] }
      else if (method === 'creative-points.statement.list') result = { entries: statement }
      else if (method === 'commercial.subscription.get') result = { schema_version: 'commercial.subscription.v1', status: 'available', current: null, future: [], packs: [], history: [], orders: [] }
      else if (method === 'commercial.catalog.get') result = { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [] }
      else if (method === 'workspace.metrics') result = { riskItems: [], stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
      else if (method === 'platform.model.status') result = { state: 'ready', capabilities: { image_generation: false } }
      else if (method === 'subscription.get') result = { commercial_entitlement: { status: 'unknown' }, legacy_commercial_entitlement: null }
      if (!['creative-points.balance.get', 'billing.transactions', 'creative-points.statement.list', 'commercial.subscription.get', 'commercial.catalog.get', 'workspace.metrics', 'platform.model.status', 'subscription.get'].includes(method)) writeRequests.push(`MCP ${method}`)
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
    }
    if (path === '/api/v1/platform-accounts' || path === '/api/v1/products') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    if (path === '/api/v1/brand-scopes') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ settings: {}, revision: 0, series: [], assignments: [] })) })
    if (path.startsWith('/api/v1/') && request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    writeRequests.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: `Blocked ${request.method()} ${path}` })) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/finance`, { waitUntil: 'domcontentloaded' })
    const finance = page.getByRole('region', { name: '财务概况' })
    const retry = finance.getByRole('button', { name: '重新读取财务数据' })
    await expect(finance.getByText('账户余额读取失败', { exact: false })).toBeVisible({ timeout: 25_000 })
    await expect(finance.getByText(/储存配额读取失败/u)).toBeVisible()
    await expect(finance.getByRole('region', { name: '创意点来源账本' }).getByRole('alert')).toContainText('点数来源账本未读取')
    await expect(finance.locator('.finance-chart-summary')).toContainText('创意点流水未读取')
    await expect(finance.locator('.finance-balance-card.accent')).toContainText('未读取')
    await expect(retry).toBeEnabled()
    expect(writeRequests).toEqual([])

    userRetried = true
    await retry.click()
    await expect(finance.locator('.finance-balance-card.accent')).toContainText('245 点')
    const ledger = finance.getByRole('region', { name: '创意点来源账本' })
    await expect(ledger.getByRole('row').filter({ hasText: 'order-finance-fixture' })).toBeVisible()
    await expect(finance.getByText(/储存配额读取失败/u)).toHaveCount(0)
    await expect(finance.getByText(/已使用 .* 共/u)).toBeVisible()
    expect(requests.some((item) => item.method === 'creative-points.statement.list' && item.workspaceId === workspaceId)).toBe(true)
    expect(requests.some((item) => item.method === 'billing.transactions' && item.workspaceId === workspaceId)).toBe(true)
    expect(writeRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
