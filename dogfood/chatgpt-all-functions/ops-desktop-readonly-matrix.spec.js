import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'

const outputRoot = process.env.OPS_E2E_OUTPUT_DIR
const base = process.env.OPS_BASE_URL
const actorId = process.env.OPS_ACTOR_ID
if (!outputRoot || !base || !actorId) throw new Error('ISOLATED_OPS_RUNNER_REQUIRED')

test.use({ channel: 'chrome', viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Shanghai' })
test.setTimeout(240_000)

const routes = [
  ['总览', 'overview'], ['用户/工作区/成员/权限/入驻', 'users'],
  ['店铺与代导入', 'stores'], ['平台规则', 'rules'],
  ['财务/收款/权益', 'finance'], ['客户交付', 'customer-delivery'],
  ['模型计费设置旧路由', 'models'], ['存储与对账旧路由', 'storage'], ['审计旧路由', 'audit'],
]

test('platform desktop read-only route and tab matrix', async ({ page }) => {
  const output = join(outputRoot, 'desktop-readonly-matrix')
  await mkdir(output, { recursive: true, mode: 0o700 })
  const pageErrors = []
  const failedApi = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('response', response => {
    if (response.url().includes('/api/') && response.status() >= 500) failedApi.push({ route: new URL(response.url()).pathname, status: response.status() })
  })
  await openPlatformConsole(page, '/ops/overview')
  // The disposable fixture begins with platform_admin + security_admin. Grant
  // ops_admin through the real isolated API to reach member/authz read tabs.
  for (const [id, role, expectedRevision, reason] of [
    [1, 'ops_admin', '2', 'isolated desktop browser read-only matrix'],
    [2, 'rules_admin', '3', 'isolated desktop browser platform rule read matrix'],
  ]) {
    const roleResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/mcp') && response.request().postDataJSON()?.method === 'ops.authorization.role.assign' && response.request().postDataJSON()?.id === id)
    await page.evaluate(({ actorId, id, role, expectedRevision, reason }) => fetch('/api/mcp', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-ops-workbench': 'platform' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'ops.authorization.role.assign', params: { subject_identity_id: actorId, role, expected_authorization_revision: expectedRevision, reason } }),
    }), { actorId, id, role, expectedRevision, reason })
    const roleResponse = await roleResponsePromise
    expect(roleResponse.status()).toBe(200)
    expect((await roleResponse.json()).error).toBeFalsy()
  }
  await page.reload()
  await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('已由服务端验证')
  const matrix = []
  for (const [label, domain] of routes) {
    await page.goto(new URL(`/ops/${domain}`, base).toString(), { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('已由服务端验证', { timeout: 30_000 })
    if (domain === 'overview') {
      const customerCount = page.getByText('客户总数', { exact: true }).locator('xpath=..').locator('strong')
      await expect(customerCount).not.toHaveText('—', { timeout: 10_000 })
    }
    await page.waitForTimeout(350)
    const headings = await page.locator('h1,h2,h3').allTextContents()
    const tabs = await page.getByRole('tab').allTextContents()
    const alerts = await page.getByRole('alert').allTextContents()
    const navigation = await page.getByRole('navigation', { name: '平台运营功能导航' }).getByRole('button').allTextContents()
    const denied = headings.some(value => value.startsWith('无权访问'))
    matrix.push({ label, domain, url: new URL(page.url()).pathname, headings: headings.map(value => value.trim()), tabs: tabs.map(value => value.trim()), alerts: alerts.map(value => value.trim().slice(0, 500)), navigation: navigation.map(value => value.trim()), denied })
    await page.screenshot({ path: join(output, `${domain}.png`), fullPage: true })
    if (domain === 'users' || domain === 'finance' || domain === 'stores') {
      for (const tabName of tabs.map(value => value.trim()).filter(Boolean)) {
        const tab = page.getByRole('tab', { name: tabName, exact: true })
        if (await tab.count() !== 1 || await tab.getAttribute('aria-disabled') === 'true') continue
        await tab.click()
        await page.waitForTimeout(250)
        matrix.push({ label: `${label} → ${tabName}`, domain, headings: (await page.locator('h1,h2,h3').allTextContents()).map(value => value.trim()), alerts: (await page.getByRole('alert').allTextContents()).map(value => value.trim().slice(0, 500)), selected: await tab.getAttribute('aria-selected') })
        await page.screenshot({ path: join(output, `${domain}-tab-${tabs.indexOf(tabName)}.png`), fullPage: true })
      }
    }
    if (domain === 'users') {
      const governanceMenu = page.getByRole('button', { name: /更多用户治理操作|切换用户治理页面/u })
      if (await governanceMenu.count() === 1) {
        await governanceMenu.click()
        const sectionLabels = new Set(['商家工作区', '成员', '入驻申请', '权限与授权'])
        const destinations = (await page.getByRole('menuitem').allTextContents()).map(value => value.trim()).filter(value => sectionLabels.has(value))
        for (const destination of destinations) {
          const target = page.getByRole('menuitem', { name: destination.trim(), exact: true })
          if (await target.count() !== 1) continue
          await target.click()
          await page.waitForTimeout(250)
          matrix.push({ label: `${label} → ${destination.trim()}`, domain, headings: (await page.locator('h1,h2,h3').allTextContents()).map(value => value.trim()), alerts: (await page.getByRole('alert').allTextContents()).map(value => value.trim().slice(0, 500)), tables: await page.getByRole('table').count() })
          await page.screenshot({ path: join(output, `${domain}-governance-${matrix.length}.png`), fullPage: true })
          const nextMenu = page.getByRole('button', { name: /更多用户治理操作|切换用户治理页面/u })
          if (await nextMenu.count() !== 1) break
          await nextMenu.click()
        }
        await page.keyboard.press('Escape')
      }
    }
  }
  await writeFile(join(output, 'matrix.json'), JSON.stringify({ auth: 'real-isolated-platform-password-session', productionBrowser: false, matrix, pageErrors, failedApi }, null, 2), { mode: 0o600 })
  expect(pageErrors).toEqual([])
  expect(failedApi).toEqual([])
})
