import { expect, test, chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test.setTimeout(120_000)
const sections = ['总览', '用户与租户', '任务与内容', '店铺管理', '账务与退款']

const snapshot = async (page, section) => ({
  section,
  headings: await page.locator('h1,h2,h3,h4').allTextContents(),
  text: (await page.locator('body').innerText()).slice(0, 35_000),
  buttons: await page.locator('button').evaluateAll(elements => elements.map(element => ({ text: (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '), disabled: element.disabled })).filter(item => item.text)),
  inputs: await page.locator('input,textarea,select').evaluateAll(elements => elements.map(element => ({ tag: element.tagName, type: element.getAttribute('type'), placeholder: element.getAttribute('placeholder'), label: element.getAttribute('aria-label'), value: element.value }))),
})

test('walk every Ops Console section through the real browser UI', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(10_000)
  await context.addInitScript(() => {
    localStorage.setItem('ops_workspace_id', 'ws_demo')
    localStorage.setItem('ops_actor_id', 'actor_demo')
    localStorage.setItem('ops_api_token', 'pilot-local-token')
  })
  const page = await context.newPage()
  const badResponses = []
  const rpcErrors = []
  const requestFailures = []
  const consoleErrors = []
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', error => consoleErrors.push(error.message))
  page.on('requestfailed', request => requestFailures.push({ method: request.method(), url: request.url(), error: request.failure()?.errorText }))
  page.on('response', async response => {
    let body = ''
    try { body = (await response.text()).slice(0, 4_000) } catch {}
    if (response.status() >= 400) badResponses.push({ method: response.request().method(), url: response.url(), status: response.status(), requestBody: response.request().postData(), body })
    if (response.request().method() === 'POST' && response.url().includes('/mcp')) {
      try {
        const parsed = JSON.parse(body)
        const error = parsed.error ?? parsed.data?.error
        if (error) rpcErrors.push({ requestBody: response.request().postData(), error })
      } catch {}
    }
  })
  await page.goto('http://127.0.0.1:18082/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5_000)
  const pages = []
  const shots = resolve('screenshots', 'ops-pages')
  await mkdir(shots, { recursive: true })
  for (const [index, section] of sections.entries()) {
    await page.locator('button').filter({ hasText: new RegExp(`^${section}$`, 'u') }).first().click()
    const expectedHeading = section === '总览' ? '运营总览' : section === '账务与退款' ? '账务与商业配置' : section
    await page.locator('h2,h3').filter({ hasText: new RegExp(`^${expectedHeading}$`, 'u') }).waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(5_000)
    if (section === '用户与租户') {
      await expect(page.getByText('用户目录')).toBeVisible()
      await expect(page.getByText('当前租户成员')).toBeVisible()
    }
    if (section === '账务与退款') {
      await expect(page.getByText('当前租户成员')).toHaveCount(0)
      await expect(page.getByText('成员角色调整')).toHaveCount(0)
    }
    pages.push(await snapshot(page, section))
    await page.screenshot({ path: resolve(shots, `${index + 1}-${section}.png`) })
  }
  await writeFile('ops-all-inventory.json', JSON.stringify({ pages, badResponses, rpcErrors, requestFailures, consoleErrors }, null, 2))
  expect(badResponses).toEqual([])
  expect(rpcErrors).toEqual([])
  expect(requestFailures).toEqual([])
  expect(consoleErrors).toEqual([])
  await context.close()
  await browser.close()
})

test('does not report model configuration success when model status fails', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => {
    localStorage.setItem('ops_workspace_id', 'ws_demo')
    localStorage.setItem('ops_actor_id', 'actor_demo')
    localStorage.setItem('ops_api_token', 'pilot-local-token')
  })
  await context.route('**/mcp', async route => {
    const body = route.request().postDataJSON()
    if (body?.method === 'platform.model.status') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'MODEL_STATUS_UNAVAILABLE', message: '模型状态暂不可用' } }) })
      return
    }
    await route.continue()
  })
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:18082/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('平台模型状态不可用')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('平台模型配置完整')).toHaveCount(0)
  await context.close()
  await browser.close()
})
