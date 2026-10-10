import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_merchant_logout_error_fixture'
const envelope = (data, error = null) => ({ request_id: 'merchant-logout-error-browser', trace_id: 'merchant-logout-error-browser', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('logout server failure remains visible after the local workspace is cleared', async () => {
  test.setTimeout(90_000)
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('production') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Merchant logout error fixture failed to bind an ephemeral port')
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const logoutCalls = []
  const externalRequests = []

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== `http://127.0.0.1:${address.port}`) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const request = route.request()
    const path = url.pathname
    if (path === '/api/v1/auth/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: { id: 'logout-owner', login: 'logout-owner@example.invalid', accountType: 'merchant', displayName: '本地退出错误验收', enterpriseName: '本地工作区', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })) })
    if (path === '/api/v1/auth/mcp-token') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ access_token: 'logout-error-access', refresh_token: 'logout-error-refresh', expires_in: 300, workspace_id: workspaceId })) })
    if (path === '/api/v1/auth/mcp-token/revoke' && request.method() === 'POST') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ revoked: true })) })
    if (path === '/api/v1/auth/logout' && request.method() === 'POST') {
      logoutCalls.push(request.postDataJSON())
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '退出请求暂不可用，请重试。' })) })
    }
    if (path === '/api/healthz') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } })) })
    if (path === '/api/mcp') {
      const method = request.postDataJSON()?.method
      const result = method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } }
        : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {}
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
    }
    if (request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: `Blocked ${request.method()} ${path}` })) })
  })

  try {
    await page.goto(`http://127.0.0.1:${address.port}/merchant/overview`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await expect(page.locator('.app-shell')).toBeVisible()
    await page.getByRole('button', { name: '打开账号菜单' }).click()
    await page.getByRole('region', { name: '账号菜单' }).getByRole('button', { name: '退出登录' }).click()

    await expect(page.getByRole('form', { name: '商家账号登录' })).toBeVisible()
    await expect(page.locator('.app-shell')).toHaveCount(0)
    await expect(page.locator('.merchant-login-alert')).toContainText('退出登录失败')
    await expect(page.locator('.merchant-login-alert')).toContainText('当前操作未确认完成')
    expect(logoutCalls).toEqual([{}])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
