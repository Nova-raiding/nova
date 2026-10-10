import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_account_password_fixture'
const envelope = (data, error = null) => ({ request_id: 'account-password-fixture', trace_id: 'account-password-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('password change blocks mismatched confirmation and preserves the form after a server rejection', async () => {
  test.setTimeout(90_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Account password fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const passwordWrites = []

  await page.route('**/*', async (route) => {
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
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'AUTH_CURRENT_PASSWORD_INVALID', message: '本地夹具：当前密码不正确。' })) })
    } else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      const result = method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : method === 'platform.model.status' ? { state: 'ready', capabilities: {} }
          : method === 'creative-points.balance.get' ? { available_points: 0 }
            : {}
      data = { result }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '打开账号菜单' }).click()
    await page.getByRole('menu', { name: '账号菜单' }).getByRole('button', { name: '修改密码' }).click()
    const dialog = page.getByRole('dialog', { name: '修改商家账号密码' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('修改成功后当前账号的其他登录会话会失效')

    await dialog.getByLabel('当前密码').fill('fixture-old-password')
    const newPassword = dialog.locator('#new_password')
    await newPassword.fill('fixture-new-password-123')
    const confirmation = dialog.locator('#confirm_password')
    await confirmation.fill('fixture-new-password-mismatch')
    await dialog.getByRole('button', { name: '确认修改' }).click()
    await expect(dialog).toContainText('两次输入的新密码不一致')
    expect(passwordWrites).toEqual([])

    await confirmation.fill('fixture-new-password-123')
    await dialog.getByRole('button', { name: '确认修改' }).click()
    await expect(dialog).toContainText('本地夹具：当前密码不正确。')
    await expect(dialog.getByLabel('当前密码')).toHaveValue('fixture-old-password')
    await expect(newPassword).toHaveValue('fixture-new-password-123')
    expect(passwordWrites).toEqual([{ current_password: 'fixture-old-password', new_password: 'fixture-new-password-123' }])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
