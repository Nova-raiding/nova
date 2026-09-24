import { expect, test, chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'

const closeWithDeadline = async (close) => { await Promise.race([close(), new Promise(resolve => setTimeout(resolve, 2000))]) }

test.setTimeout(120_000)
const configuredBaseUrl = process.env.OPS_BASE_URL ?? 'http://127.0.0.1:18082/'
const baseUrl = configuredBaseUrl.endsWith('/') ? configuredBaseUrl : `${configuredBaseUrl}/`
const noAuthBaseUrl = process.env.OPS_NO_AUTH_BASE_URL ?? baseUrl

test('inventory Ops Console through the real browser UI', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const consoleMessages = []
  const requestFailures = []
  const badResponses = []
  page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text() }))
  page.on('pageerror', error => consoleMessages.push({ type: 'pageerror', text: error.message }))
  page.on('requestfailed', request => {
    // Route changes can abort stale page-owned requests while the next
    // section is loading. Browser cancellation is not an API outage and is
    // handled the same way as the full Ops walk contract.
    if (request.failure()?.errorText === 'net::ERR_ABORTED' || request.url().startsWith('https://fonts.googleapis.com/')) return
    requestFailures.push({ method: request.method(), url: request.url(), error: request.failure()?.errorText })
  })
  page.on('response', async response => {
    if (response.status() < 400) return
    let body = ''
    try { body = (await response.text()).slice(0, 5_000) } catch {}
    badResponses.push({ method: response.request().method(), url: response.url(), status: response.status(), requestBody: response.request().postData(), body })
  })
  await openPlatformConsole(page)
  const response = await page.goto(process.env.OPS_BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6_000)
  await page.screenshot({ path: resolve('screenshots', 'ops-console.png'), fullPage: true })
  const inventory = await page.evaluate(() => ({
    title: document.title,
    text: document.body.innerText.slice(0, 40_000),
    headings: [...document.querySelectorAll('h1,h2,h3,h4')].map(element => element.textContent?.trim()).filter(Boolean),
    buttons: [...document.querySelectorAll('button')].map(element => ({ text: (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '), disabled: element.disabled })).filter(item => item.text),
    inputs: [...document.querySelectorAll('input,textarea,select')].map(element => ({ tag: element.tagName, type: element.getAttribute('type'), placeholder: element.getAttribute('placeholder'), label: element.getAttribute('aria-label'), value: element.value })),
    tabs: [...document.querySelectorAll('[role="tab"]')].map(element => ({ text: element.textContent?.trim(), selected: element.getAttribute('aria-selected') })),
  }))
  await writeFile('ops-inventory.json', JSON.stringify({ status: response?.status(), inventory, consoleMessages, requestFailures, badResponses }, null, 2))
  try {
    const consoleErrors = consoleMessages.filter(message => message.type === 'error' || message.type === 'pageerror')
    expect(response?.ok(), 'Ops Console entry page should return a successful response').toBe(true)
    expect(badResponses, 'Ops Console inventory should not observe HTTP error responses').toEqual([])
    expect(requestFailures, 'Ops Console inventory should not observe failed network requests').toEqual([])
    expect(consoleErrors, 'Ops Console inventory should not observe console or page errors').toEqual([])
  } finally {
    await context.close()
    await closeWithDeadline(() => browser.close())
  }
})

test('fails closed without a session and exposes only the platform account/password form', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const requests = []
  context.on('request', request => requests.push({ url: request.url(), authorization: request.headers().authorization }))
  // Exercise the no-session path without allowing the local session bootstrap.
  await context.route('**/api/local-session', async route => {
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'local session disabled for this contract' }) })
  })
  await context.route('**/api/mcp', async route => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: '运营会话已失效或尚未登录' } }) })
  })
  await context.route('**/api/v1/ops/local-session', async route => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: '运营会话已失效或尚未登录' } }) })
  })
  const page = await context.newPage()
  await page.goto(noAuthBaseUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.getByPlaceholder('例如 ops@example.com')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByPlaceholder('请输入平台运营密码')).toBeVisible()
  await expect(page.getByRole('button', { name: '登录平台运营后台', exact: true })).toBeVisible()
  await expect(page.getByText(/外部登录|组织登录|SSO/u)).toHaveCount(0)
  await expect(page.getByText('运营 API 连接配置')).toHaveCount(0)
  // The contract is that no local bearer credential is attached to requests.
  expect(requests.filter(request => request.url.includes('/api/mcp')).every(request => !request.authorization)).toBe(true)
  await context.close()
  await closeWithDeadline(() => browser.close())
})

test('does not probe the API before account/password login', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  let sessionRequests = 0
  await context.route('**/api/mcp', async route => {
    const body = route.request().postDataJSON()
    if (body?.method === 'ops.session') {
      sessionRequests += 1
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: '运营会话已失效，请重新登录' } }) })
      return
    }
    await route.continue()
  })
  const page = await context.newPage()
  await page.goto(noAuthBaseUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.getByPlaceholder('例如 ops@example.com')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByPlaceholder('请输入平台运营密码')).toBeVisible()
  await expect(page.getByRole('button', { name: '登录平台运营后台', exact: true })).toBeVisible()
  expect(sessionRequests).toBe(0)
  await context.close()
  await closeWithDeadline(() => browser.close())
})

test('logs in with a platform account/password cookie and logs out back to the same form', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  let authenticated = false
  const requests = []
  await context.route('**/api/v1/auth/login', async route => {
    const body = route.request().postDataJSON()
    requests.push({ method: 'login', account_type: body.account_type })
    if (body.password !== 'fixture-password') {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: '账号或密码不正确' } }) })
      return
    }
    authenticated = true
    await route.fulfill({ status: 200, headers: { 'set-cookie': 'ops_session=fixture-session; HttpOnly; Path=/; SameSite=Lax' }, contentType: 'application/json', body: JSON.stringify({ data: { result: { account: { id: 'ops-fixture', login: body.login, accountType: 'platform', roles: ['platform_admin'] } } } }) })
  })
  await context.route('**/api/v1/auth/logout', async route => {
    requests.push({ method: 'logout' })
    authenticated = false
    await route.fulfill({ status: 200, headers: { 'set-cookie': 'ops_session=; HttpOnly; Path=/; Max-Age=0' }, contentType: 'application/json', body: JSON.stringify({ data: { result: { ok: true } } }) })
  })
  await context.route('**/api/mcp', async route => {
    const body = route.request().postDataJSON()
    requests.push({ method: body.method, hasCookie: (await route.request().headerValue('cookie') || '').includes('ops_session=fixture-session') })
    if (body.method === 'ops.session' && authenticated) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { result: {
        actor_id: 'ops-fixture', account_login: 'owner@example.test', roles: ['platform_admin'], canonical_roles: ['platform_admin'],
        workbench: 'platform', workspace_granted: false, scope: { type: 'platform' }, capabilities: ['platform.summary.read'],
        authorization_projection: { capabilities: ['platform.summary.read'], capability_scopes: { 'platform.summary.read': { type: 'platform' } } },
      } } }) })
      return
    }
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: '运营会话已失效或尚未登录' } }) })
  })

  const page = await context.newPage()
  await page.goto(noAuthBaseUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('#ops-login-account').fill('owner@example.test')
  await page.locator('#ops-login-password').fill('wrong-password')
  await page.getByRole('button', { name: '登录平台运营后台' }).click()
  await expect(page.getByRole('alert').filter({ hasText: '登录失败' })).toBeVisible()
  await page.locator('#ops-login-password').fill('fixture-password')
  await page.getByRole('button', { name: '登录平台运营后台' }).click()
  await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('已由服务端验证')
  expect(requests.some(request => request.method === 'login' && request.account_type === 'platform')).toBe(true)
  expect(requests.some(request => request.method === 'ops.session' && request.hasCookie)).toBe(true)

  await page.getByRole('button', { name: '打开账号信息' }).click()
  await page.getByRole('dialog', { name: '账号信息' }).getByRole('button', { name: '退出登录' }).click()
  await expect(page.locator('#ops-login-account')).toBeVisible()
  expect(requests.some(request => request.method === 'logout')).toBe(true)
  await context.close()
  await closeWithDeadline(() => browser.close())
})

test('requires account/password login for a direct workspace Ops URL', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const requests = []
  context.on('request', request => requests.push({ url: request.url(), authorization: request.headers().authorization }))
  const page = await context.newPage()
  await page.goto(`${noAuthBaseUrl}ops/stores?workbench=workspace`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByPlaceholder('例如 ops@example.com')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByPlaceholder('请输入平台运营密码')).toBeVisible()
  await expect(page.getByRole('heading', { name: '平台连接汇总' })).toHaveCount(0)
  expect(requests.every(request => !request.authorization)).toBe(true)
  await context.close()
  await closeWithDeadline(() => browser.close())
})
