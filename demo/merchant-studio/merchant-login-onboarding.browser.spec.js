import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_auth_onboarding_fixture'
const envelope = (data, error = null) => ({
  request_id: 'auth-onboarding-fixture',
  trace_id: 'auth-onboarding-fixture',
  workspace_id: '',
  data,
  warnings: [],
  next_actions: [],
  error,
})

test('merchant can recover from login and first-workspace errors without losing form input', async () => {
  test.setTimeout(90_000)
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react()],
    optimizeDeps: { include: ['react', 'react-dom/client', 'antd', 'lucide-react'] },
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'),
      'import.meta.env.MODE': JSON.stringify('test'),
    },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Local Merchant Studio fixture did not bind an ephemeral TCP port')
  }

  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const unexpectedWrites = []
  const loginBodies = []
  const bootstrapBodies = []
  const sessionReads = []
  let loginAttempts = 0
  let bootstrapAttempts = 0
  let releaseInitialSession
  let releaseInvalidLogin
  const initialSessionGate = new Promise(resolve => { releaseInitialSession = resolve })
  const invalidLoginGate = new Promise(resolve => { releaseInvalidLogin = resolve })

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/v1/auth/session' && request.method() === 'GET') {
      sessionReads.push('GET')
      if (sessionReads.length === 1) await initialSessionGate
      if (bootstrapAttempts >= 2) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: {
          id: 'merchant-onboarding-fixture',
          login: 'merchant@example.invalid',
          accountType: 'merchant',
          displayName: '本地引导验收',
          enterpriseName: '演示企业工作区',
          status: 'active',
          roles: ['merchant_owner'],
          workspaceIds: [workspaceId],
        } })) })
      }
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'AUTH_SESSION_INVALID', message: 'No fixture session.' })) })
    }
    if (url.pathname === '/api/v1/auth/login' && request.method() === 'POST') {
      const body = request.postDataJSON()
      loginBodies.push(body)
      loginAttempts += 1
      if (body.password !== 'fixture-valid-password') {
        await invalidLoginGate
        return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'AUTH_INVALID_CREDENTIALS', message: '本地夹具：账号或密码不正确。' })) })
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: {
        id: 'merchant-onboarding-fixture',
        login: body.login,
        accountType: 'merchant',
        displayName: '本地引导验收',
        enterpriseName: '',
        status: 'active',
        roles: ['merchant_owner'],
        workspaceIds: [],
      } })) })
    }
    if (url.pathname === '/api/v1/auth/workspace-bootstrap' && request.method() === 'POST') {
      bootstrapBodies.push(request.postDataJSON())
      bootstrapAttempts += 1
      if (bootstrapAttempts === 1) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UPSTREAM_BUSY', message: 'Fixture temporarily unavailable.' })) })
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ workspace_id: workspaceId, status: 'active', reused: false, next_action: 'local_plugin_connect' })) })
    }
    if (url.pathname === '/api/healthz' && request.method() === 'GET') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, persistence: { mode: 'fixture', ready: true } })) })
    }
    if (url.pathname === '/api/mcp' && request.method() === 'POST') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: {} })) })
    }
    if (request.method() === 'GET') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    }
    unexpectedWrites.push(`${request.method()} ${url.pathname}`)
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: 'Fixture blocks unrelated writes.' })) })
  })

  try {
    await page.goto(studioUrl, { waitUntil: 'domcontentloaded' })
    const loginForm = page.getByRole('form', { name: '商家账号登录' })
    const loginName = page.locator('#merchant-login-account')
    const password = page.locator('#merchant-login-password')
    await expect(loginForm).toBeVisible()
    await expect(loginName).toBeDisabled()
    await expect(page.getByRole('status')).toContainText('正在检查登录状态，完成后即可输入商家账号。')
    releaseInitialSession()
    await expect(loginName).toBeEnabled()
    await loginName.fill('merchant@example.invalid')
    await password.fill('wrong-password')
    await password.press('Enter')
    await expect(loginName).toBeDisabled()
    releaseInvalidLogin()
    await expect(page.getByRole('alert')).toContainText('本地夹具：账号或密码不正确。')
    await expect(loginName).toBeEnabled()
    await expect(loginName).toHaveValue('merchant@example.invalid')

    await password.fill('fixture-valid-password')
    await password.press('Enter')
    await expect(page.getByRole('heading', { name: '创建首次工作区' })).toBeVisible()
    const workspaceName = page.locator('#merchant-workspace-display-name')
    await expect(workspaceName).toBeFocused()
    await workspaceName.fill('  演示企业工作区  ')
    await workspaceName.press('Enter')
    await expect(page.getByRole('alert')).toContainText('首次工作区创建未完成')
    await expect(workspaceName).toHaveValue('  演示企业工作区  ')

    await page.getByRole('button', { name: '创建工作区' }).click()
    await expect.poll(() => bootstrapAttempts).toBe(2)
    await expect.poll(() => sessionReads.length).toBe(2)
    await expect(page.locator('.app-shell')).toBeVisible()
    expect(loginAttempts).toBe(2)
    expect(loginBodies).toEqual([
      { login: 'merchant@example.invalid', password: 'wrong-password', account_type: 'merchant' },
      { login: 'merchant@example.invalid', password: 'fixture-valid-password', account_type: 'merchant' },
    ])
    expect(bootstrapAttempts).toBe(2)
    expect(bootstrapBodies).toEqual([
      { display_name: '演示企业工作区' },
      { display_name: '演示企业工作区' },
    ])
    expect(externalRequests).toEqual([])
    expect(unexpectedWrites).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
