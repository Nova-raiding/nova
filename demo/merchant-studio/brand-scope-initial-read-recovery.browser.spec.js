import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_brand_scope_initial_read_retry'
const envelope = (data, error = null) => ({ request_id: 'brand-scope-read-retry', trace_id: 'brand-scope-read-retry', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })
const settings = {
  schemaVersion: 1,
  global: { enabled: true, values: { persona: '本地读取恢复品牌画像' } },
  stores: { 'store-read-retry': { enabled: true, values: {} } },
  series: {},
  images: {},
}

test('brand scope read failure shows a read-specific retry and recovers the server profile', async () => {
  test.setTimeout(60_000)
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
    throw new Error('Brand scope read retry fixture did not bind a loopback port')
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  let scopeReads = 0
  let allowScopeRead = false
  const unexpectedWrites = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    const mcpMethod = path === '/api/mcp' && method === 'POST' ? request.postDataJSON()?.method : undefined
    const allowedMcpReads = ['billing.transactions', 'canonical.product.consistency', 'creative-points.balance.get', 'platform.model.status', 'workspace.metrics']
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && path !== '/api/v1/auth/mcp-token'
      && !(path === '/api/mcp' && allowedMcpReads.includes(mcpMethod))) {
      unexpectedWrites.push(`${method} ${path}${mcpMethod ? ` ${mcpMethod}` : ''}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_FIXTURE_WRITE', message: `write blocked by local fixture: ${method} ${path}${mcpMethod ? ` ${mcpMethod}` : ''}` })) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/api/v1/auth/session') data = { account: { id: 'brand-read-user', login: 'brand-read@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/api/v1/auth/mcp-token') data = { access_token: 'brand-read-token', refresh_token: 'brand-read-refresh', expires_in: 300 }
    else if (path === '/api/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true } } }
    else if (path === '/api/v1/platform-accounts') data = { items: [{ platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'read_only', accountId: 'store-read-retry', storeName: '读取恢复店铺' }] }
    else if (path === '/api/v1/brand-scopes') {
      scopeReads += 1
      if (!allowScopeRead) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '品牌配置服务暂不可用' })) })
      data = { settings, revision: 4, updated_at: '2026-10-11T00:00:00.000Z', series: [], assignments: [] }
    } else if (path === '/api/v1/assets' || path === '/api/v1/products') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === '/api/mcp') data = { result: mcpMethod === 'creative-points.balance.get' ? { balance_state: 'known', available_points: 5 } : mcpMethod === 'billing.transactions' ? { balance_cny: '0.00', transactions: [] } : mcpMethod === 'workspace.metrics' ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } } : { state: 'ready', capabilities: { image_generation: false } } }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`http://127.0.0.1:${address.port}/merchant/products?section=assets`, { waitUntil: 'domcontentloaded' })
    const panel = page.getByRole('region', { name: '品牌资产配置' })
    await expect(panel).toBeVisible()
    await expect.poll(() => scopeReads, { timeout: 10_000 }).toBeGreaterThan(0)
    const error = page.locator('.material-brand-read-state')
    await expect(error).toContainText('读取暂不可用')
    await expect(error.getByRole('button', { name: '重试读取品牌配置' })).toBeEnabled()
    const initialReadCount = scopeReads
    allowScopeRead = true
    await error.getByRole('button', { name: '重试读取品牌配置' }).click()
    await expect(page.getByRole('textbox', { name: '全局用户画像' })).toHaveValue('本地读取恢复品牌画像')
    await expect.poll(() => scopeReads).toBeGreaterThan(initialReadCount)
    expect(unexpectedWrites).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
