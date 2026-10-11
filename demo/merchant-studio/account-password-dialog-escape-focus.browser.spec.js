import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_password_escape_fixture'
const envelope = (data, error = null) => ({ request_id: 'password-escape-fixture', trace_id: 'password-escape-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('Escape cancels password change and restores focus through the account menu', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Password dialog fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const passwordWrites = []

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') {
      data = { account: { id: 'password-fixture-user', login: 'password@example.invalid', accountType: 'merchant', displayName: '本地密码验收', enterpriseName: '本地工作区', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/auth/password/change' && request.method() === 'POST') {
      passwordWrites.push(request.postDataJSON())
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_PASSWORD_WRITE_BLOCKED', message: 'Password writes are blocked in this fixture.' })) })
    } else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      const result = method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : method === 'creative-points.balance.get' ? { available_points: 0 } : {}
      data = { result }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    const accountTrigger = page.getByRole('button', { name: '打开账号菜单' })
    await expect(accountTrigger).toBeVisible()
    await accountTrigger.click()
    const accountPanel = page.getByRole('region', { name: '账号菜单' })
    await expect(accountPanel).toBeVisible()
    const changePassword = accountPanel.getByRole('button', { name: '修改密码' })
    await changePassword.click()
    const dialog = page.getByRole('dialog', { name: '修改商家账号密码' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(accountPanel).toBeVisible()
    await expect(changePassword).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(accountPanel).toHaveCount(0)
    await expect(accountTrigger).toBeFocused()
    expect(passwordWrites).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
