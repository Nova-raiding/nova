import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'

test.setTimeout(120_000)
test.use({ channel: 'chrome' })
const baseUrl = process.env.OPS_BASE_URL ?? 'http://127.0.0.1:18082/'

// 7f6cf3f4 renamed the directory column 成员状态 -> 激活状态; the filter control
// was left behind and now carries the same canonical name again.
const userDirectoryTable = page => page.getByRole('table').filter({
  has: page.getByRole('columnheader', { name: '激活状态' }),
})

async function filterUserDirectory(page, keyword = '') {
  const filters = page.getByRole('form', { name: '用户目录筛选' })
  await expect(filters).toBeVisible({ timeout: 20_000 })
  await filters.getByRole('textbox', { name: '关键词' }).fill(keyword)
  await filters.getByRole('button', { name: /查\s*询/u }).click()
  await expect(filters.getByRole('button', { name: /查\s*询/u })).toBeEnabled({ timeout: 20_000 })
  return userDirectoryTable(page).getByRole('row').filter({ has: page.getByRole('button', { name: /用户详情/u }) }).first()
}

async function waitForBackgroundHydration(page) {
  const refreshButton = page.getByRole('button', { name: /(?:保存并刷新|刷新数据)/u })
  await expect(refreshButton).toBeEnabled({ timeout: 70_000 })
  const loadError = page.getByRole('alert').filter({ hasText: '无法加载运营数据' })
  if (await loadError.isVisible()) {
    await loadError.getByRole('button', { name: /重\s*试/u }).click()
    await expect(refreshButton).toBeEnabled({ timeout: 70_000 })
  }
}

test('operates the platform user directory without destructive confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = []
  const badResponses = []
  const routeRequests = []
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() }) })
  page.on('request', request => { if (/UsersPage|UserDirectory/u.test(request.url())) routeRequests.push({ event: 'request', url: request.url() }) })
  page.on('requestfinished', request => { if (/UsersPage|UserDirectory/u.test(request.url())) routeRequests.push({ event: 'finished', url: request.url() }) })
  await openPlatformConsole(page)
  await page.locator('#ops-primary-navigation').getByRole('button', { name: '用户中心', exact: true }).click()
  await expect(page).toHaveURL(/\/ops\/users(?:\?.*)?$/u)
  await expect(page.getByRole('heading', { name: '用户中心' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('当前租户成员')).toHaveCount(0)
  await expect(page.getByRole('form', { name: '用户目录筛选' })).toBeVisible({ timeout: 20_000 })
  // Registration applications are loaded through the platform-only REST
  // boundary and remain visible alongside the identity directory.
  const registrationApplications = page.getByText('注册申请', { exact: true })
  if (await registrationApplications.count()) {
    await expect(registrationApplications).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: '刷新申请' })).toBeVisible()
  }

  const supportRow = await filterUserDirectory(page)
  // The platform directory aggregates members across every workspace; on a
  // cold PostgreSQL/Redis run it can finish after the search button is enabled.
  try {
    await expect(supportRow).toBeVisible({ timeout: 70_000 })
  } catch (error) {
    const loadError = page.getByRole('alert').filter({ hasText: '用户目录加载失败' }).first()
    if (await loadError.isVisible()) {
      await loadError.getByRole('button', { name: /刷新用户目录/u }).click()
      await expect(supportRow).toBeVisible({ timeout: 70_000 })
    } else {
      console.error(JSON.stringify({
        usersDebug: await page.evaluate(() => ({
          trace: window.__OPS_BOOTSTRAP_TRACE__ ?? [],
          text: document.body.innerText.slice(0, 12_000),
          rows: document.querySelectorAll('[role="row"]').length,
        })),
      }))
      throw error
    }
  }
  // RETIRED (cc2f01cb `ui: simplify user status filter`): the directory panel no
  // longer renders the `导出当前筛选` control, so there is no browser download
  // left to assert. The export contract itself keeps server-side coverage
  // (apps/api/src/ops-users-directory.e2e.test.ts:168 asserts json + csv
  // payload, count and truncation), but the `ops-users-<date>.csv` filename and
  // the `external_subject,display_name,workspace_id` CSV header lost their only
  // carrier. Re-adding the control is a UI change that must come back through
  // review, so it is deliberately not restored here. Registered as entry 7 in
  // ./retired-ops-assertions.md. The walk continues below with the detail
  // drawer.
  const detailButton = supportRow.getByRole('button', { name: /用户详情/u })
  await detailButton.focus()
  await page.keyboard.press('Enter')
  const detailDrawer = page.getByRole('dialog', { name: /用户详情/u })
  await expect(detailDrawer).toBeVisible()
  // RETIRED (f84b9561 `ui: remove sessions and simplify store details`, 1b7d8799
  // `ui: simplify user detail drawer`): the drawer is now a per-workspace
  // commercial view. The masked-session list, the identity lifecycle section,
  // the tenant/role summary and the member operation history are gone from it,
  // so this asserts what the drawer renders today: the identity header plus the
  // store / monthly-fee / wallet / usage tables of every membership it loaded.
  // Registered as entry 9 in ./retired-ops-assertions.md — those four sections
  // have no carrier left anywhere in the user center, they are not renames.
  await expect(detailDrawer.getByRole('heading', { name: '店铺详情' })).toBeVisible({ timeout: 20_000 })
  await expect(detailDrawer.getByRole('heading', { name: '月费详情' })).toBeVisible()
  await expect(detailDrawer.getByRole('heading', { name: '钱包' })).toBeVisible()
  await expect(detailDrawer.getByRole('heading', { name: '当月消耗表' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(detailDrawer).toBeHidden()
  await expect(detailButton).toBeFocused()

  const filters = page.getByRole('form', { name: '用户目录筛选' })
  const keyword = filters.getByRole('textbox', { name: '关键词' })
  await keyword.fill('不存在的用户')
  await filters.getByRole('button', { name: /查\s*询/u }).click()
  await expect(page.getByText('没有符合条件的用户成员关系')).toBeVisible({ timeout: 20_000 })
  // The `清空` button was removed by the same commit, so the filter is reset by
  // clearing the keyword and querying again (the assertion below still proves
  // the filtered-empty state is reversible). This is a re-anchor, not a
  // retirement — see entry 8 in ./retired-ops-assertions.md.
  await keyword.fill('')
  await filters.getByRole('button', { name: /查\s*询/u }).click()
  await expect(filters.getByRole('button', { name: /查\s*询/u })).toBeEnabled({ timeout: 20_000 })
  await expect(userDirectoryTable(page).getByRole('row')).not.toHaveCount(1, { timeout: 20_000 })
  // The filtered identity can be the currently logged-in platform actor,
  // whose row is intentionally not selectable for bulk suspension. Choose a
  // visible row with an enabled selection control for the bulk-action path.
  const restoredSupportRow = userDirectoryTable(page).getByRole('row').filter({
    has: page.locator('input:not([disabled])'),
  }).filter({ has: page.getByRole('button', { name: /用户详情/u }) }).first()
  await expect(restoredSupportRow).toBeVisible({ timeout: 20_000 })

  await restoredSupportRow.getByRole('checkbox').click()
  const bulkButton = page.getByRole('button', { name: /批量停用/u })
  await expect(bulkButton).toBeEnabled()
  await bulkButton.click()
  const bulkDialog = page.getByRole('dialog', { name: /批量停用用户/u })
  await expect(bulkDialog).toBeVisible()
  await expect(bulkDialog.getByRole('button', { name: /逐条执行停用/u })).toBeDisabled()
  await bulkDialog.getByLabel('操作原因（至少 4 个字符）').fill('浏览器验收测试，不提交')
  await expect(bulkDialog.getByRole('button', { name: /逐条执行停用/u })).toBeEnabled()
  await bulkDialog.getByRole('button', { name: /Cancel|取\s*消/u }).click()
  await expect(bulkDialog).toBeHidden()

  await restoredSupportRow.getByRole('button', { name: /停\s*用/u }).click()
  const dialog = page.getByRole('dialog', { name: '停用用户访问' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: /确认停用/u })).toBeDisabled()
  await dialog.getByLabel('操作原因（至少 4 个字符）').fill('浏览器验收测试，不提交')
  // The actor is the authenticated server session. The UI must not accept a
  // forgeable typed approver; a concrete audit reason arms the operation and
  // the server revalidates identity.update before writing.
  await expect(dialog.getByText('本操作由当前会话授权', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('审批人')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: /确认停用/u })).toBeEnabled()
  await dialog.getByRole('button', { name: /Cancel|取\s*消/u }).click()
  await expect(dialog).toBeHidden()

  const shots = resolve('screenshots', 'ops-users')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: resolve(shots, 'user-directory.png'), fullPage: true })
  await writeFile('ops-users-result.json', JSON.stringify({ errors, url: page.url(), rows: await page.locator('tbody tr').count() }, null, 2))
  expect(errors).toEqual([])
})
