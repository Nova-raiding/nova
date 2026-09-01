import { expect, test, chromium } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test.setTimeout(240_000)
const baseUrl = process.env.OPS_BASE_URL ?? 'http://127.0.0.1:18082/'
// Platform operations and workspace administration are separate workbenches.
// Member governance is intentionally not part of the platform walk: it is
// only exercised with a workspace membership fixture below.
// These domains require a workspace-scoped policy and are covered by
// workspace fixtures, never by the platform token walk.
const platformSections = ['总览', '用户与租户', '平台连接', '模型服务', '功能开关', '存储与对账', '账务与退款', '审计中心']
const headings = { '总览': '运营总览', '成员与权限': '成员与权限', '客服与 CRM': '客服与客户关系', '平台连接': '平台连接汇总', '存储与对账': '存储与对账', '账务与退款': '账务与商业配置' }

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
    localStorage.setItem('ops_workbench', 'platform')
  })
  const page = await context.newPage()
  const badResponses = []
  const rpcErrors = []
  const requestFailures = []
  const consoleErrors = []
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', error => consoleErrors.push(error.message))
  page.on('requestfailed', request => {
    // Route changes intentionally abort stale queries owned by the page that
    // just unmounted. Keep recording real transport failures without treating
    // browser cancellation as an API outage.
    if (request.failure()?.errorText === 'net::ERR_ABORTED') return
    requestFailures.push({ method: request.method(), url: request.url(), error: request.failure()?.errorText, requestBody: request.postData() })
  })
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
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5_000)
  const pages = []
  const shots = resolve('screenshots', 'ops-pages')
  await mkdir(shots, { recursive: true })
  for (const [index, section] of platformSections.entries()) {
    await page.locator('button').filter({ hasText: new RegExp(`^${section}$`, 'u') }).first().click()
    const expectedHeading = headings[section] ?? section
    await page.locator('h2,h3').filter({ hasText: new RegExp(`^${expectedHeading}$`, 'u') }).waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(5_000)
    if (section === '用户与租户') {
      await expect(page.getByRole('tab', { name: '用户目录', exact: true })).toBeVisible()
      await expect(page.getByText('当前租户成员')).toHaveCount(0)
    }
    if (section === '账务与退款') {
      await expect(page.getByText('当前租户成员')).toHaveCount(0)
      await expect(page.getByText('成员角色调整')).toHaveCount(0)
      const commercialDownload = page.waitForEvent('download')
      await page.getByRole('button', { name: '导出商业配置' }).click()
      const downloaded = await commercialDownload
      expect(downloaded.suggestedFilename()).toMatch(/^ops-commercial-\d{4}-\d{2}-\d{2}\.csv$/u)
      expect(await readFile(await downloaded.path(), 'utf8')).toContain('kind,id,code')
    }
    pages.push(await snapshot(page, section))
    await page.screenshot({ path: resolve(shots, `${index + 1}-${section}.png`) })
  }
  await writeFile('ops-all-inventory.json', JSON.stringify({ pages, badResponses, rpcErrors, requestFailures, consoleErrors }, null, 2))
  expect(badResponses).toEqual([])
  expect(rpcErrors).toEqual([])
  expect(requestFailures).toEqual([])
  expect(consoleErrors).toEqual([])
  // Stop page-owned polling/request work before tearing down the context.
  // Waiting on context.close() directly can hang after the full domain walk
  // when a page still has an in-flight background query, turning a clean
  // browser run into a misleading test timeout.
  await page.close()
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
    localStorage.setItem('ops_workbench', 'platform')
  })
  await context.route('**/api/mcp', async route => {
    const body = route.request().postDataJSON()
    if (body?.method === 'platform.model.status') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'MODEL_STATUS_UNAVAILABLE', message: '模型状态暂不可用' } }) })
      return
    }
    await route.continue()
  })
  const page = await context.newPage()
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('状态不可用').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('平台模型配置完整')).toHaveCount(0)
  await context.close()
  await browser.close()
})
