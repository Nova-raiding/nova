import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'

const evidenceDir = process.env.OPS_E2E_OUTPUT_DIR
const actorId = process.env.OPS_ACTOR_ID
const baseUrl = process.env.OPS_BASE_URL
if (!evidenceDir || !actorId || !baseUrl) throw new Error('ISOLATED_OPS_RUNNER_REQUIRED')

test.use({ channel: 'chrome', viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' })
test.setTimeout(120_000)

test('platform global password session shows member context gate without an invitation form', async ({ page }, testInfo) => {
  const output = join(evidenceDir, 'members-global')
  await mkdir(output, { recursive: true, mode: 0o700 })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await openPlatformConsole(page, '/ops/users')
  await expect(page.getByRole('heading', { name: '已接入用户', exact: true })).toBeAttached()
  await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('平台运营视图')
  // The runner seeds platform_admin + security_admin, which intentionally lacks
  // workspace.member.read. Assign ops_admin through the real isolated MCP API
  // so the member tab is reachable under a genuine server authorization.
  const roleResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/mcp') && response.request().postDataJSON()?.method === 'ops.authorization.role.assign')
  await page.evaluate(({ actorId }) => {
    const payload = { jsonrpc: '2.0', id: crypto.randomUUID(), method: 'ops.authorization.role.assign', params: {
      subject_identity_id: actorId, role: 'ops_admin', expected_authorization_revision: '2',
      reason: 'isolated browser verification of platform global member context',
    } }
    return fetch('/api/mcp', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-ops-workbench': 'platform' }, body: JSON.stringify(payload) })
  }, { actorId })
  const response = await roleResponsePromise
  const body = await response.json()
  expect(response.status()).toBe(200)
  expect(body.error ?? body.data?.error).toBeFalsy()
  await page.reload()
  await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('已由服务端验证')
  const governanceMenu = page.getByRole('button', { name: /更多用户治理操作|切换用户治理页面/u })
  await expect(governanceMenu).toBeVisible()
  await governanceMenu.click()
  await page.getByRole('menuitem', { name: '成员', exact: true }).click()
  await expect(page.getByText('请先进入商家工作区', { exact: true })).toBeVisible()
  await expect(page.getByText('成员列表和邀请操作只在已授权的商家工作区会话中可用。当前是平台全局会话，无法读取或修改某个工作区的成员。')).toBeVisible()
  await expect(page.getByRole('form', { name: '邀请工作区成员' })).toHaveCount(0)
  await expect(page.getByText('成员列表加载失败')).toHaveCount(0)
  expect(pageErrors).toEqual([])

  const screenshot = join(output, 'platform-members-context.png')
  await page.screenshot({ path: screenshot, fullPage: true })
  await testInfo.attach('platform-members-context', { path: screenshot, contentType: 'image/png' })
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'passed', surface: 'ops-users-members', auth: 'real-isolated-password-session', context: 'platform-global', invitationFormVisible: false, pageErrors, productionBrowser: false }, null, 2), { mode: 0o600 })
})
