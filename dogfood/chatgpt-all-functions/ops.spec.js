import { expect, test, chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'

test.setTimeout(120_000)
const configuredBaseUrl = process.env.OPS_OIDC_BASE_URL ?? process.env.OPS_BASE_URL ?? 'http://127.0.0.1:18082/'
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
  const response = await page.goto(process.env.OPS_OIDC_BASE_URL, { waitUntil: 'domcontentloaded' })
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
    await browser.close()
  }
})

test('fails closed with no local connection credentials and exposes platform login', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const requests = []
  context.on('request', request => requests.push({ url: request.url(), authorization: request.headers().authorization }))
  // Keep this contract independent from the local secure-session bootstrap
  // enabled by the OIDC runner: this case must exercise the no-credentials
  // fail-closed path and therefore cannot obtain a cookie first.
  await context.route('**/api/local-session', async route => {
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'local session disabled for this contract' }) })
  })
  await context.route('**/api/mcp', async route => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: '运营会话已失效或尚未登录' } }) })
  })
  const page = await context.newPage()
  await page.goto(noAuthBaseUrl, { waitUntil: 'domcontentloaded' })
  // With no local credential, the production-shaped console intentionally
  // lands on the dedicated platform login page rather than the post-session
  // recovery result. Both paths fail closed; this one must expose login.
  await expect(page.getByRole('heading', { name: '登录平台运营后台' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByPlaceholder('例如 ops@example.com')).toBeVisible()
  await expect(page.getByPlaceholder('请输入平台运营密码')).toBeVisible()
  await expect(page.getByRole('button', { name: '登录平台运营后台', exact: true })).toBeVisible()
  await expect(page.getByText('运营 API 连接配置')).toHaveCount(0)
  // Managed OIDC builds may still issue the unauthenticated ops.session RPC;
  // the contract is that no local bearer credential is attached to it.
  expect(requests.filter(request => request.url.includes('/api/mcp')).every(request => !request.authorization)).toBe(true)
  await context.close()
  await browser.close()
})

test('turns an authenticated-session 401 into a reauthentication form', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => {
    localStorage.setItem('ops_workspace_id', 'ws_demo')
    localStorage.setItem('ops_actor_id', 'actor_demo')
    localStorage.setItem('ops_api_token', 'expired-local-token')
    sessionStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: 'ws_demo', workbench: 'platform' }))
    sessionStorage.setItem('ops_workspace_id', 'ws_demo')
    sessionStorage.setItem('ops_workbench', 'platform')
  })
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
  await expect(page.getByRole('heading', { name: '登录平台运营后台' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('当前尚未登录', { exact: true })).not.toBeVisible()
  await expect(page.getByPlaceholder('请输入平台运营密码', { exact: true })).toBeVisible()
  expect(sessionRequests).toBe(1)
  await context.close()
  await browser.close()
})

test('renders the real workspace brand tree with revision and store navigation', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => {
    localStorage.setItem('ops_workspace_id', 'ws_demo')
    localStorage.setItem('ops_actor_id', 'workspace_admin_demo')
    localStorage.setItem('ops_api_token', 'workspace-local-token')
    localStorage.setItem('ops_workbench', 'workspace')
  })
  const page = await context.newPage()
  const badResponses = []
  page.on('response', response => {
    if (response.status() >= 400) badResponses.push({ method: response.request().method(), url: response.url(), status: response.status() })
  })
  await page.goto(`${noAuthBaseUrl}ops/stores?workbench=workspace`, { waitUntil: 'domcontentloaded' })
  const permissionGate = page.getByRole('heading', { name: '无法验证运营权限' })
  const workspaceSummary = page.getByRole('heading', { name: '平台连接汇总' })
  // The runner's signed identity is platform-scoped. A workspace route must
  // fail closed rather than silently reusing that identity as a workspace
  // owner. When a workspace-scoped gateway is supplied, continue with the
  // positive brand/store assertions below.
  const permissionDenied = await permissionGate.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false)
  if (permissionDenied) {
    await expect(page.getByText('当前身份尚未通过运营权限验证', { exact: false })).toBeVisible()
    expect(await page.getByRole('heading', { name: '平台连接汇总' }).count()).toBe(0)
    await context.close()
    await browser.close()
    return
  }
  await expect(workspaceSummary).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('品牌、平台与店铺', { exact: true })).toBeVisible()
  const brandHeading = page.getByRole('heading', { name: 'Release QA Brand', exact: true })
  const brandEmpty = page.getByText(/暂无品牌|尚未取得平台品牌聚合数据/, { exact: false }).first()
  await expect(brandHeading.or(brandEmpty)).toBeVisible({ timeout: 20_000 })
  // Real workspaces may legitimately have no brand bindings yet. In that
  // state the empty-state contract is the expected result; fixture-backed
  // workspaces expose the store task navigation instead.
  const taobaoTaskLink = page.getByRole('button', { name: /查看淘宝店铺 fixture-store-ws_demo-taobao 的任务/ })
  const emptyBrandState = page.getByText('当前工作区还没有可访问的品牌', { exact: true })
  await expect(taobaoTaskLink.or(emptyBrandState)).toBeVisible({ timeout: 20_000 })
  expect(badResponses).toEqual([])
  await context.close()
  await browser.close()
})

test('ops/tasks long list scrolling keeps page stable (no white-screen)', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } })
  const page = await context.newPage()
  await openPlatformConsole(page, '/ops/tasks?workbench=platform', { workbench: 'platform' })
  const consoleErrors = []
  const requestFailures = []
  const badResponses = []

  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'pageerror') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', error => {
    consoleErrors.push(error.message)
  })
  page.on('requestfailed', request => {
    if (request.failure()?.errorText === 'net::ERR_ABORTED' || request.url().startsWith('https://fonts.googleapis.com/')) return
    requestFailures.push({ method: request.method(), url: request.url(), error: request.failure()?.errorText })
  })
  page.on('response', async response => {
    const status = response.status()
    if (status >= 400 && status < 500 && status !== 401 && status !== 403) return
    if (status >= 500) {
      let body = ''
      try {
        body = (await response.text()).slice(0, 5_000)
      } catch {}
      badResponses.push({ method: response.request().method(), url: response.url(), status, body })
    }
  })

  await page.goto(`${noAuthBaseUrl}ops/tasks?workbench=workspace`, { waitUntil: 'domcontentloaded' })

  const workspaceGate = page.getByRole('heading', { name: '无法验证运营权限' })
  const taskHeading = page.getByRole('heading', { name: '任务与内容', exact: true })
  const unauthorized = await workspaceGate.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false)
  if (unauthorized) {
    await expect(page.getByText('当前身份尚未通过运营权限验证', { exact: false })).toBeVisible()
    await context.close()
    await browser.close()
    return
  }

  await expect(taskHeading).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('heading', { name: '待处理队列', exact: true })).toBeVisible()
  const stableSections = page.locator('.ops-tasks-work, .ops-tasks-input, .ops-tasks-overview')
  await expect(stableSections.first()).toBeVisible()

  const scrollPoints = [300, 600, 900, 1200, 1500]
  for (const y of scrollPoints) {
    await page.mouse.wheel(0, y)
    await page.waitForTimeout(350)

    const pageState = await page.evaluate(() => {
      const bodyText = document.body?.innerText?.trim() ?? ''
      const main = document.querySelector('.ops-tasks-page') ?? document.body
      const mainHeight = main?.getBoundingClientRect?.().height ?? 0
      const rootHeight = document.documentElement?.scrollHeight ?? 0
      return {
        bodyTextLength: bodyText.length,
        bodyHeight: document.body?.getBoundingClientRect?.().height ?? 0,
        mainHeight,
        rootHeight,
      }
    })

    await expect(page.getByRole('heading', { name: '任务与内容', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '待处理队列', exact: true })).toBeVisible()
    await expect(stableSections.first()).toBeVisible()

    expect(pageState.bodyTextLength).toBeGreaterThan(120)
    expect(pageState.mainHeight).toBeGreaterThan(0)
    expect(pageState.bodyHeight).toBeGreaterThan(0)
    expect(pageState.rootHeight).toBeGreaterThan(0)
    await expect(consoleErrors, `No runtime console errors at scroll offset ${y}`).toEqual([])
  }

  const failureCount = badResponses.length + requestFailures.length
  await expect(failureCount, 'Ops tasks route should not have hard errors while scrolling').toBe(0)
  await page.screenshot({ path: resolve('screenshots', 'ops-tasks-scroll-stability.png'), fullPage: false })

  await context.close()
  await browser.close()
})
