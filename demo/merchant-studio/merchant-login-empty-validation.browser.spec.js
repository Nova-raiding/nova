import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

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
    const submit = page.getByRole('button', { name: '登录商家工作台', exact: true })
    await submit.focus()
    await submit.press('Enter')
    await expect(account).toBeFocused()
    await account.fill('fixture-account')
    await submit.focus()
    await submit.press('Enter')
    await expect(password).toBeFocused()
    const readability = await page.locator('.merchant-login-helper').evaluate(helper => {
      const card = helper.closest('.merchant-login-card')
      const background = getComputedStyle(card).backgroundColor
      const colors = [getComputedStyle(helper).color,
        ...[...document.querySelectorAll('.merchant-login-form input')].map(input => getComputedStyle(input, '::placeholder').color)]
      const parse = value => value.match(/[\d.]+/g).map(Number)
      const luminance = channels => channels.slice(0, 3).map(channel => channel / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
      const bg = parse(background)
      const ratios = colors.map(color => {
        const fg = parse(color); const alpha = fg[3] ?? 1
        const mixed = fg.slice(0, 3).map((channel, i) => channel * alpha + bg[i] * (1 - alpha))
        const light = [luminance(mixed), luminance(bg)].sort((a, b) => b - a)
        return (light[0] + .05) / (light[1] + .05)
      })
      return { background, colors, ratios, activeFieldId: document.activeElement?.id }
    })
    expect(readability.activeFieldId).toBe('merchant-login-password')
    for (const ratio of readability.ratios) expect(ratio).toBeGreaterThanOrEqual(4.5)
    if (process.env.MERCHANT_LOGIN_REVIEW_ARTIFACTS) {
      const directory = resolve(process.env.MERCHANT_LOGIN_REVIEW_ARTIFACTS)
      await mkdir(directory, { recursive: true })
      await page.screenshot({ path: resolve(directory, 'merchant-login-focus-after.png'), fullPage: true })
      await writeFile(resolve(directory, 'evidence.json'), JSON.stringify({ readability, loginRequests, externalRequests }, null, 2) + '\n')
    }
    expect(loginRequests).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
