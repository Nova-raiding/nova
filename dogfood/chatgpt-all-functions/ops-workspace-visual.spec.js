import { expect, test, chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openWorkspaceConsole } from './ops-auth.js'

test.setTimeout(240_000)

const workspaceSections = [
  { label: '成员与权限', path: '/ops/members?workbench=workspace', heading: '成员与权限' },
  { label: '任务与内容', path: '/ops/tasks?workbench=workspace', heading: '任务与内容' },
  { label: '知识库', path: '/ops/knowledge?workbench=workspace', heading: '知识库' },
  { label: '平台规则', path: '/ops/rules?workbench=workspace', heading: '平台规则' },
]

const snapshot = async (page, section) => ({
  section,
  headings: await page.locator('h1,h2,h3,h4').allTextContents(),
  buttons: await page.locator('button').evaluateAll(elements => elements
    .map(element => ({ text: (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '), disabled: element.disabled }))
    .filter(item => item.text)),
  inputs: await page.locator('input,textarea,select').evaluateAll(elements => elements.map(element => ({
    tag: element.tagName,
    type: element.getAttribute('type'),
    placeholder: element.getAttribute('placeholder'),
    label: element.getAttribute('aria-label'),
  }))),
  text: (await page.locator('body').innerText()).slice(0, 35_000),
})

test('captures every workspace Ops Console page for visual QA', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const consoleErrors = []
  const requestFailures = []
  const badResponses = []
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', error => consoleErrors.push(error.message))
  page.on('requestfailed', request => {
    if (request.failure()?.errorText === 'net::ERR_ABORTED' || request.url().startsWith('https://fonts.googleapis.com/')) return
    requestFailures.push({ method: request.method(), url: request.url(), error: request.failure()?.errorText })
  })
  page.on('response', response => {
    if (response.status() >= 400) {
      const body = response.request().postDataJSON?.()
      badResponses.push({ method: response.request().method(), url: response.url(), status: response.status(), rpc_method: body?.method, params: body?.params })
    }
  })

  const screenshots = resolve('screenshots', 'ops-workspace-pages')
  await mkdir(screenshots, { recursive: true })
  const pages = []
  for (const [index, section] of workspaceSections.entries()) {
    if (index === 0) {
      await openWorkspaceConsole(page, section.path)
    } else {
      await page.goto(new URL(section.path, process.env.OPS_WORKSPACE_OIDC_BASE_URL).toString(), { waitUntil: 'domcontentloaded' })
    }
    const pageHeading = page.getByRole('heading', { name: section.heading, exact: true })
    const permissionHeading = page.getByRole('heading', { name: /无权访问/u })
    await expect(pageHeading.or(permissionHeading)).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1_500)
    pages.push(await snapshot(page, section.label))
    await page.screenshot({ path: resolve(screenshots, `${index + 1}-${section.label}.png`), fullPage: true })
  }

  await writeFile('ops-workspace-visual-inventory.json', JSON.stringify({ pages, consoleErrors, requestFailures, badResponses }, null, 2))
  const expectedReadModel503 = message => message.includes('status of 503 (Service Unavailable)')
  expect(consoleErrors.filter(message => !expectedReadModel503(message))).toEqual([])
  expect(requestFailures).toEqual([])
  expect(badResponses.filter(response => response.status !== 503)).toEqual([])
  await context.close()
  await browser.close()
})
