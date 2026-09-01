import { expect, test } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test.setTimeout(120_000)
test.use({ channel: 'chrome' })
const baseUrl = process.env.OPS_BASE_URL ?? 'http://127.0.0.1:18082/'
const workspaceToken = process.env.OPS_WORKSPACE_TOKEN ?? ''
const workspaceActorId = process.env.OPS_WORKSPACE_ACTOR_ID ?? 'workspace_admin_demo'

const userDirectoryTable = page => page.getByRole('table').filter({
  has: page.getByRole('columnheader', { name: '成员状态' }),
})

async function filterUserDirectory(page, keyword = 'support_demo') {
  const filters = page.getByRole('form', { name: '用户目录筛选' })
  await expect(filters).toBeVisible({ timeout: 20_000 })
  await filters.getByRole('textbox', { name: '关键词' }).fill(keyword)
  await filters.getByRole('button', { name: /查\s*询/u }).click()
  return userDirectoryTable(page).getByRole('row').filter({ hasText: keyword }).first()
}

async function waitForBackgroundHydration(page) {
  await expect(page.getByRole('button', { name: /刷新数据/u })).toBeEnabled({ timeout: 70_000 })
  const loadError = page.getByRole('alert').filter({ hasText: '无法加载运营数据' })
  if (await loadError.isVisible()) {
    await loadError.getByRole('button', { name: /重\s*试/u }).click()
    await expect(page.getByRole('button', { name: /刷新数据/u })).toBeEnabled({ timeout: 70_000 })
  }
}

test('operates the platform user directory without destructive confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.addInitScript(() => {
    localStorage.setItem('ops_workspace_id', 'ws_demo')
    localStorage.setItem('ops_actor_id', 'actor_demo')
    localStorage.setItem('ops_api_token', 'pilot-local-token')
    localStorage.setItem('ops_workbench', 'platform')
  })
  const errors = []
  const badResponses = []
  const routeRequests = []
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() }) })
  page.on('request', request => { if (/UsersPage|UserDirectory/u.test(request.url())) routeRequests.push({ event: 'request', url: request.url() }) })
  page.on('requestfinished', request => { if (/UsersPage|UserDirectory/u.test(request.url())) routeRequests.push({ event: 'finished', url: request.url() }) })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('#ops-primary-navigation').getByRole('button', { name: '用户与租户', exact: true }).click()
  await expect(page).toHaveURL(/\/ops\/users(?:\?.*)?$/u)
  await expect(page.getByRole('heading', { name: '用户与租户' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('当前租户成员')).toHaveCount(0)
  await waitForBackgroundHydration(page)

  const supportRow = await filterUserDirectory(page)
  await expect(supportRow).toBeVisible({ timeout: 20_000 })
  const exportDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出当前筛选' }).click()
  const downloaded = await exportDownload
  expect(downloaded.suggestedFilename()).toMatch(/^ops-users-\d{4}-\d{2}-\d{2}\.csv$/u)
  const exportedContent = await readFile(await downloaded.path(), 'utf8')
  expect(exportedContent).toContain('external_subject,display_name,workspace_id')
  expect(exportedContent).toContain('support_demo')
  const detailButton = supportRow.getByRole('button', { name: /详\s*情/u })
  await detailButton.focus()
  await page.keyboard.press('Enter')
  const detailDrawer = page.getByRole('dialog', { name: /用户详情.*support_demo/u })
  await expect(detailDrawer).toBeVisible()
  await expect(detailDrawer.getByText('认证会话（已脱敏）')).toBeVisible()
  await expect(detailDrawer.getByRole('heading', { name: '平台身份生命周期' })).toBeVisible()
  await expect(detailDrawer.getByText('所属租户与角色')).toBeVisible()
  await expect(detailDrawer.getByText('暂无成员操作记录')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(detailDrawer).toBeHidden()
  await expect(detailButton).toBeFocused()

  const filters = page.getByRole('form', { name: '用户目录筛选' })
  const keyword = filters.getByRole('textbox', { name: '关键词' })
  await keyword.fill('不存在的用户')
  await filters.getByRole('button', { name: /查\s*询/u }).click()
  await expect(page.getByText('没有符合条件的用户成员关系')).toBeVisible()
  await filters.getByRole('button', { name: /清\s*空/u }).click()
  await expect(supportRow).toBeVisible()

  await supportRow.getByRole('checkbox').click()
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

  await supportRow.getByRole('button', { name: /^停\s*用$/u }).click()
  const dialog = page.getByRole('dialog', { name: '停用用户访问' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: /确认停用/u })).toBeDisabled()
  await dialog.getByLabel('操作原因（至少 4 个字符）').fill('浏览器验收测试，不提交')
  await expect(dialog.getByRole('button', { name: /确认停用/u })).toBeEnabled()
  await dialog.getByRole('button', { name: /Cancel|取\s*消/u }).click()
  await expect(dialog).toBeHidden()

  const shots = resolve('screenshots', 'ops-users')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: resolve(shots, 'user-directory.png'), fullPage: true })
  await writeFile('ops-users-result.json', JSON.stringify({ errors, url: page.url(), rows: await page.locator('tbody tr').count() }, null, 2))
  expect(errors).toEqual([])
})

test('keeps member governance in the workspace workbench', async ({ page }) => {
  test.skip(!workspaceToken, 'requires a workspace-only merchant_admin/owner token fixture')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.addInitScript(() => {
    localStorage.setItem('ops_workspace_id', 'ws_demo')
    localStorage.setItem('ops_actor_id', workspaceActorId)
    localStorage.setItem('ops_api_token', workspaceToken)
    localStorage.setItem('ops_workbench', 'workspace')
  })
  await page.goto(new URL('/ops/members?workbench=workspace', baseUrl).toString(), { waitUntil: 'domcontentloaded' })
  await expect(page).toHaveURL(/\/ops\/members\?workbench=workspace$/u)
  await expect(page.getByRole('heading', { name: '成员与权限' })).toBeVisible()
  await expect(page.getByText('当前租户成员')).toBeVisible()
  const inviteForm = page.getByRole('form', { name: '邀请工作区成员' })
  await expect(inviteForm).toBeVisible()
  await inviteForm.getByRole('textbox', { name: /用户 ID/u }).focus()
  await expect(inviteForm.getByRole('textbox', { name: /用户 ID/u })).toBeFocused()
  const shots = resolve('screenshots', 'ops-users')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: resolve(shots, 'members-governance-workspace-1440.png') })
})
