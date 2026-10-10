import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const baseUrl = process.env.MERCHANT_STUDIO_URL
const login = process.env.OPS_E2E_MERCHANT_USERNAME
const password = process.env.OPS_E2E_MERCHANT_PASSWORD
const workspaceA = process.env.OPS_E2E_MERCHANT_WORKSPACE_A
const workspaceB = process.env.OPS_E2E_MERCHANT_WORKSPACE_B
const evidenceDir = process.env.OPS_E2E_OUTPUT_DIR
if (!baseUrl || !login || !password || !workspaceA || !workspaceB || !evidenceDir) {
  throw new Error('MERCHANT_WORKSPACE_SWITCH_ISOLATED_RUNNER_REQUIRED')
}

test.use({ channel: 'chrome', viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' })
test.setTimeout(120_000)

async function openRoute(page, pathname) {
  await page.evaluate(path => {
    window.history.pushState(null, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, pathname)
}

async function chooseWorkspace(page, label, workspaceId) {
  const selector = page.getByRole('combobox', { name: label, exact: true })
  await expect(selector).toBeVisible()
  const selectRoot = selector.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")]')
  const selection = selector.locator('xpath=..')
  const current = label === '选择当前商家工作区 ID' ? '' : ((await selection.textContent().catch(() => ''))?.trim() ?? '')
  await selectRoot.locator('.ant-select-content').click({ force: true, timeout: 5_000 })
  await expect(selector).toHaveAttribute('aria-expanded', 'true', { timeout: 5_000 })
  if (!current) await selector.press('Home')
  else if (!current.includes(workspaceId)) await selector.press(workspaceId === workspaceA ? 'ArrowUp' : 'ArrowDown')
  await selector.press('Enter')
  if (label === '选择当前商家工作区 ID') {
    await expect(page.locator('.app-shell')).toBeVisible()
    const activeSelector = page.getByRole('combobox', { name: '按工作区 ID 切换当前商家工作区', exact: true })
    await expect(activeSelector.locator('xpath=..')).toContainText(workspaceId)
  } else {
    await expect(selection).toContainText(workspaceId)
  }
}

test('merchant workspace selector binds A to B to A requests and clears old tenant UI state', async ({ page }, testInfo) => {
  const output = join(evidenceDir, 'merchant-workspace-switch')
  await mkdir(output, { recursive: true, mode: 0o700 })
  const pageErrors = []
  const mcpCalls = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname !== '/api/mcp' || request.method() !== 'POST') return
    let method = 'invalid-json-rpc'
    try { method = request.postDataJSON()?.method ?? method } catch { /* captured for the assertion below */ }
    mcpCalls.push({ method, workspaceId: request.headers()['x-workspace-id'] ?? null })
  })

  await page.goto(`${baseUrl}/merchant/members`, { waitUntil: 'domcontentloaded' })
  const form = page.getByRole('form', { name: '商家账号登录' })
  await expect(form).toBeVisible()
  const loginName = page.locator('#merchant-login-account')
  const loginPassword = page.locator('#merchant-login-password')
  const loginButton = form.getByRole('button', { name: '登录商家工作台', exact: true })
  await loginName.fill(login)
  await loginPassword.fill(password)
  await expect.poll(async () => {
    if (await page.locator('.app-shell').isVisible().catch(() => false)) return 'authenticated'
    if (await loginButton.isVisible().catch(() => false)) return await loginButton.isEnabled() ? 'ready' : 'loading'
    return 'loading'
  }, { timeout: 30_000, message: 'merchant login button must become ready after filling the account fields' }).toMatch(/authenticated|ready/u)
  const loginResponse = page.waitForResponse(response => response.url().endsWith('/v1/auth/login'))
  if (!await page.locator('.app-shell').isVisible().catch(() => false)) await loginButton.click()
  expect((await loginResponse).status()).toBe(200)
  await chooseWorkspace(page, '选择当前商家工作区 ID', workspaceA)

  await openRoute(page, '/merchant/members')
  const memberTable = page.getByRole('table', { name: '工作区成员列表' })
  await expect(memberTable).toContainText('A 工作区专属成员', { timeout: 30_000 })
  await expect(memberTable).not.toContainText('B 工作区专属成员')

  // Route state is tenant UI state too. Switch while a search route and a
  // workspace-specific dialog are open; neither may survive the transition.
  await openRoute(page, '/merchant/products?section=products&q=old-workspace-search-marker')
  await expect(page).toHaveURL(/old-workspace-search-marker/u)
  await openRoute(page, '/merchant/members')
  const aMemberRow = page.getByRole('row').filter({ hasText: 'A 工作区专属成员' })
  await aMemberRow.getByRole('button', { name: '改角色' }).click()
  await expect(page.getByRole('form', { name: '成员变更' })).toBeVisible()
  await chooseWorkspace(page, '按工作区 ID 切换当前商家工作区', workspaceB)
  await expect(page).toHaveURL(/\/merchant\/overview$/u)
  await expect(page.getByRole('form', { name: '成员变更' })).toHaveCount(0)
  await expect(page).not.toHaveURL(/old-workspace-search-marker/u)

  await openRoute(page, '/merchant/members')
  await expect(memberTable).toContainText('B 工作区专属成员', { timeout: 30_000 })
  await expect(memberTable).not.toContainText('A 工作区专属成员')

  await chooseWorkspace(page, '按工作区 ID 切换当前商家工作区', workspaceA)
  await expect(page).toHaveURL(/\/merchant\/overview$/u)
  await openRoute(page, '/merchant/members')
  await expect(memberTable).toContainText('A 工作区专属成员', { timeout: 30_000 })
  await expect(memberTable).not.toContainText('B 工作区专属成员')

  for (const workspaceId of [workspaceA, workspaceB]) {
    expect(mcpCalls.some(call => call.method === 'ops.session' && call.workspaceId === workspaceId), `ops.session carries ${workspaceId}`).toBe(true)
    expect(mcpCalls.some(call => call.method === 'ops.members.list' && call.workspaceId === workspaceId), `ops.members.list carries ${workspaceId}`).toBe(true)
  }
  expect(pageErrors).toEqual([])
  const result = { status: 'passed', flow: ['A', 'B', 'A'], workspaceA, workspaceB, mcpCalls, staleSearchCleared: true, staleDialogCleared: true, pageErrors, productionBrowser: false, modelCalls: 0 }
  const screenshot = join(output, 'workspace-a-after-return.png')
  await page.screenshot({ path: screenshot, fullPage: true })
  await testInfo.attach('workspace-a-after-return', { path: screenshot, contentType: 'image/png' })
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
})
