import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_bootstrap_membership_fixture'
const envelope = (data, error = null) => ({ request_id: 'bootstrap-membership', trace_id: 'bootstrap-membership', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('first workspace bootstrap waits for session ownership and safely resumes when membership appears', async () => {
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
    throw new Error('Bootstrap membership fixture failed to bind an ephemeral port')
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const bootstrapBodies = []
  let bootstrapAttempts = 0
  let sessionReads = 0

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== `http://127.0.0.1:${address.port}`) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/v1/auth/session' && request.method() === 'GET') {
      sessionReads += 1
      if (sessionReads === 1) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'AUTH_SESSION_INVALID', message: 'No fixture session.' })) })
      const membershipConfirmed = bootstrapAttempts >= 2
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: {
        id: 'bootstrap-owner-fixture', login: 'owner@example.invalid', accountType: 'merchant', displayName: 'Bootstrap Owner', status: 'active', roles: ['merchant_owner'], workspaceIds: membershipConfirmed ? [workspaceId] : [],
      } })) })
    }
    if (path === '/api/v1/auth/login' && request.method() === 'POST') {
      const body = request.postDataJSON()
      if (body.login !== 'owner@example.invalid' || body.password !== 'fixture-password') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid fixture credentials.' })) })
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: {
        id: 'bootstrap-owner-fixture', login: body.login, accountType: 'merchant', displayName: 'Bootstrap Owner', status: 'active', roles: ['merchant_owner'], workspaceIds: [],
      } })) })
    }
    if (path === '/api/v1/auth/workspace-bootstrap' && request.method() === 'POST') {
      bootstrapAttempts += 1
      bootstrapBodies.push(request.postDataJSON())
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ workspace_id: workspaceId, status: 'active', reused: bootstrapAttempts > 1, next_action: 'local_plugin_connect' })) })
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
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const loginName = page.getByRole('textbox', { name: '商家账号' })
    const password = page.getByLabel('密码').last()
    await expect(loginName).toBeEnabled()
    await loginName.fill('owner@example.invalid')
    await password.fill('fixture-password')
    await page.getByRole('button', { name: '登录商家工作台' }).click()
    const workspaceName = page.getByLabel('企业或工作区名称')
    await expect(workspaceName).toBeVisible()
    await workspaceName.fill('本地首次工作区')
    await page.getByRole('button', { name: '创建工作区' }).click()

    await expect(page.getByRole('alert')).toContainText('登录会话尚未确认该工作区归属')
    await expect(workspaceName).toHaveValue('本地首次工作区')
    await expect(page.locator('.app-shell')).toHaveCount(0)
    expect(bootstrapAttempts).toBe(1)

    await page.getByRole('button', { name: '创建工作区' }).click()
    await expect(page.locator('.app-shell')).toBeVisible()
    expect(bootstrapAttempts).toBe(2)
    expect(bootstrapBodies).toEqual([{ display_name: '本地首次工作区' }, { display_name: '本地首次工作区' }])
    expect(sessionReads).toBe(3)
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
