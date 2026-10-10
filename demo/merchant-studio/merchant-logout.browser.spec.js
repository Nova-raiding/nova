import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_merchant_logout_fixture'
const envelope = (data, error = null) => ({ request_id: 'merchant-logout-browser', trace_id: 'merchant-logout-browser', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('account menu logout revokes the local session and returns to sign-in', async () => {
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
    throw new Error('Merchant logout fixture failed to bind an ephemeral port')
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const revokeBodies = []
  const logoutBodies = []
  const calls = []

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== `http://127.0.0.1:${address.port}`) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const request = route.request()
    const path = new URL(request.url()).pathname
    calls.push({ path, method: request.method() })
    if (path === '/api/v1/auth/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: { id: 'logout-owner', login: 'logout-owner@example.invalid', accountType: 'merchant', displayName: '本地退出验收', enterpriseName: '本地工作区', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })) })
    if (path === '/api/v1/auth/mcp-token') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ access_token: 'logout-access-token', refresh_token: 'logout-refresh-token', expires_in: 300, workspace_id: workspaceId })) })
    if (path === '/api/v1/auth/mcp-token/revoke' && request.method() === 'POST') {
      revokeBodies.push(request.postDataJSON())
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ revoked: true })) })
    }
    if (path === '/api/v1/auth/logout' && request.method() === 'POST') {
      logoutBodies.push(request.postDataJSON())
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ logged_out: true })) })
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
    const menu = page.getByRole('region', { name: '账号菜单' })
    await expect(menu.getByRole('button', { name: '退出登录' })).toBeVisible()
    await menu.getByRole('button', { name: '退出登录' }).click()

    await expect(page.getByRole('form', { name: '商家账号登录' })).toBeVisible()
    await expect(page.locator('.app-shell')).toHaveCount(0)
    expect(revokeBodies).toEqual([{ refresh_token: 'logout-refresh-token' }])
    expect(logoutBodies).toEqual([{}])
    expect(calls.some(call => call.path === '/api/v1/auth/mcp-token' && call.method === 'POST')).toBe(true)
    expect(calls.filter(call => call.path === '/api/v1/auth/logout')).toHaveLength(1)
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
