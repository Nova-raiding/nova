import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'

const outputRoot = process.env.OPS_E2E_OUTPUT_DIR
const base = process.env.OPS_BASE_URL
const actorId = process.env.OPS_ACTOR_ID
if (!outputRoot || !base || !actorId) throw new Error('ISOLATED_OPS_RUNNER_REQUIRED')

test.use({ channel: 'chrome', viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' })
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
  const roleResponse = await page.request.post(new URL('/api/mcp', base).toString(), {
    headers: { 'x-ops-workbench': 'platform' },
    data: { jsonrpc: '2.0', id: 1, method: 'ops.authorization.role.assign', params: {
      subject_identity_id: actorId, role: 'ops_admin', expected_authorization_revision: '2',
      reason: 'isolated desktop browser read-only matrix',
    } },
  })
  expect(roleResponse.status()).toBe(200)
  expect((await roleResponse.json()).error).toBeFalsy()
  const rulesRoleResponse = await page.request.post(new URL('/api/mcp', base).toString(), {
    headers: { 'x-ops-workbench': 'platform' },
    data: { jsonrpc: '2.0', id: 2, method: 'ops.authorization.role.assign', params: {
      subject_identity_id: actorId, role: 'rules_admin', expected_authorization_revision: '3',
      reason: 'isolated desktop browser platform rule read matrix',
    } },
  })
  expect(rulesRoleResponse.status()).toBe(200)
  expect((await rulesRoleResponse.json()).error).toBeFalsy()
  await page.reload()
  await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('已由服务端验证')
  const matrix = []
  for (const [label, domain] of routes) {
    await page.goto(new URL(`/ops/${domain}`, base).toString(), { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('已由服务端验证', { timeout: 30_000 })
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
  }
  await writeFile(join(output, 'matrix.json'), JSON.stringify({ auth: 'real-isolated-platform-password-session', productionBrowser: false, matrix, pageErrors, failedApi }, null, 2), { mode: 0o600 })
  expect(pageErrors).toEqual([])
  expect(failedApi).toEqual([])
})
