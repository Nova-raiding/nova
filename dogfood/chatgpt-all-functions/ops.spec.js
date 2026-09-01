import { expect, test, chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test.setTimeout(120_000)
const baseUrl = process.env.OPS_BASE_URL ?? 'http://127.0.0.1:18082/'

test('inventory Ops Console through the real browser UI', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => {
    localStorage.setItem('ops_workspace_id', 'ws_demo')
    localStorage.setItem('ops_actor_id', 'actor_demo')
    localStorage.setItem('ops_api_token', 'pilot-local-token')
    localStorage.setItem('ops_workbench', 'platform')
  })
  const page = await context.newPage()
  const consoleMessages = []
  const requestFailures = []
  const badResponses = []
  page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text() }))
  page.on('pageerror', error => consoleMessages.push({ type: 'pageerror', text: error.message }))
  page.on('requestfailed', request => requestFailures.push({ method: request.method(), url: request.url(), error: request.failure()?.errorText }))
  page.on('response', async response => {
    if (response.status() < 400) return
    let body = ''
    try { body = (await response.text()).slice(0, 5_000) } catch {}
    badResponses.push({ method: response.request().method(), url: response.url(), status: response.status(), requestBody: response.request().postData(), body })
  })
  const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
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

test('fails closed with no local connection credentials and exposes diagnostics on demand', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const requests = []
  context.on('request', request => requests.push(request.url()))
  const page = await context.newPage()
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('权限未验证', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '连接诊断' })).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('form', { name: '运营 API 连接配置' })).toHaveCount(0)
  await page.getByRole('button', { name: '连接诊断' }).click()
  await expect(page.getByRole('form', { name: '运营 API 连接配置' })).toBeVisible()
  expect(requests.filter(url => url.includes('/api/mcp'))).toEqual([])
  await context.close()
  await browser.close()
})

test('turns an authenticated-session 401 into a reauthentication gate', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => {
    localStorage.setItem('ops_workspace_id', 'ws_demo')
    localStorage.setItem('ops_actor_id', 'actor_demo')
    localStorage.setItem('ops_api_token', 'expired-local-token')
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
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('无法验证运营权限', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('运营登录已失效或尚未登录', { exact: false }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '重试权限验证' })).toBeVisible()
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
  await page.goto(`${baseUrl}ops/stores?workbench=workspace`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: '平台连接汇总' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('品牌、平台与店铺', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Release QA Brand', exact: true })).toBeVisible()
  await expect(page.getByText('brand_release_qa', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /查看淘宝店铺 fixture-store-ws_demo-taobao 的任务/ })).toBeVisible()
  expect(badResponses).toEqual([])
  await context.close()
  await browser.close()
})
