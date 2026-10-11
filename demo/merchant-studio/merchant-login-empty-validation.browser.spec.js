import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const envelope = (data, error = null) => ({
  request_id: 'merchant-login-empty-validation',
  trace_id: 'merchant-login-empty-validation',
  workspace_id: '',
  data,
  warnings: [],
  next_actions: [],
  error,
})

test('empty login form reports required fields on Enter without sending credentials', async () => {
  test.setTimeout(60_000)
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const externalRequests = []
  const loginRequests = []

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
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'AUTH_SESSION_INVALID', message: 'Fixture has no session.' })) })
    }
    if (url.pathname === '/api/healthz' && request.method() === 'GET') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, persistence: { mode: 'fixture', ready: true } })) })
    }
    if (url.pathname === '/api/v1/auth/login' && request.method() === 'POST') {
      loginRequests.push(request.postDataJSON())
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'AUTH_INVALID_CREDENTIALS', message: 'Unexpected login attempt.' })) })
    }
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_REQUEST_BLOCKED', message: 'Unexpected fixture request.' })) })
  })

  try {
    await page.goto(studioUrl, { waitUntil: 'domcontentloaded' })
    const form = page.getByRole('form', { name: '商家账号登录' })
    await expect(form).toBeVisible()
    const account = page.locator('#merchant-login-account')
    const password = page.locator('#merchant-login-password')
    await expect(account).toBeEnabled()
    await account.focus()
    await account.press('Enter')

    await expect(page.getByText('请输入商家账号')).toBeVisible()
    await expect(page.getByText('请输入商家密码')).toBeVisible()
    await expect(account).toBeFocused()
    expect(loginRequests).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
