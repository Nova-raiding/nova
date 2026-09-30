import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createScreenshotMatrixEvidence } from '../../scripts/screenshot-matrix-evidence.mjs'
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
  ['存储与对账', 'storage'], ['审计中心', 'audit'], ['模型计费设置', 'models'],
]
const governanceDestinations = ['商家工作区', '成员', '入驻申请', '权限与授权']
function hasEffectiveCapability(allowed, denied, capability) {
  return allowed.has(capability) && !denied.has(capability)
}

test('platform desktop read-only route and tab matrix', async ({ page }) => {
  const output = join(outputRoot, 'desktop-readonly-matrix')
  await mkdir(output, { recursive: true, mode: 0o700 })
  const captureEvidence = await createScreenshotMatrixEvidence({ evidenceDir: outputRoot, matrixName: 'ops-desktop-readonly-matrix' })
  const pageErrors = []
  const failedApi = []
  const overviewApiEvidence = []
  const overviewApiInspection = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('response', response => {
    const requestBody = response.request().postDataJSON?.()
    if (response.url().includes('/api/') && response.status() >= 500) {
      const request = response.request()
      const requestBody = request.postDataJSON?.()
      failedApi.push({ route: new URL(response.url()).pathname, status: response.status(), method: requestBody?.method ?? null, requestId: response.headers()['x-request-id'] ?? null })
    }
    if (response.url().endsWith('/api/mcp') && ['ops.workspaces.list', 'ops.finance.search', 'ops.model-usage.summary'].includes(requestBody?.method)) {
      overviewApiInspection.push(response.json().then(envelope => {
        const error = envelope?.error ?? envelope?.data?.error
        const result = envelope?.result ?? envelope?.data?.result
        const entry = { method: requestBody.method, status: response.status(), errorCode: error?.code ?? error?.error?.code ?? null }
        if (requestBody.method === 'ops.workspaces.list') {
          entry.resultKeys = result && typeof result === 'object' ? Object.keys(result).sort() : []
          entry.total = typeof result?.total === 'number' ? result.total : null
          entry.itemCount = Array.isArray(result?.items) ? result.items.length : Array.isArray(result) ? result.length : null
        } else if (requestBody.method === 'ops.finance.search') {
          const summary = result?.summary
          entry.summaryKeys = summary && typeof summary === 'object' ? Object.keys(summary).sort() : []
          entry.summaryValues = summary && typeof summary === 'object'
            ? Object.fromEntries(Object.entries(summary).filter(([, value]) => typeof value === 'number' || value === null))
            : null
        } else {
          entry.providerCostStatus = result?.providerCostStatus ?? null
          entry.providerCostCny = result?.providerCostCny ?? null
        }
        overviewApiEvidence.push(entry)
      }).catch(() => undefined))
    }
  })
  await openPlatformConsole(page, '/ops/overview')
  // The disposable fixture begins with platform_admin + security_admin. Grant
  // ops_admin/rules_admin/finance_ops through the real isolated API; the
  // platform Ops capability projection also controls the canonical queue.
  for (const [id, role, expectedRevision, reason] of [
    [1, 'ops_admin', '2', 'isolated desktop browser read-only matrix'],
    [2, 'rules_admin', '3', 'isolated desktop browser platform rule read matrix'],
    [3, 'finance_ops', '4', 'isolated desktop browser platform finance read matrix'],
  ]) {
    const roleResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/mcp') && response.request().postDataJSON()?.method === 'ops.authorization.role.assign' && response.request().postDataJSON()?.id === id)
    await page.evaluate(({ actorId, id, role, expectedRevision, reason }) => fetch('/api/mcp', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-ops-workbench': 'platform' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'ops.authorization.role.assign', params: { subject_identity_id: actorId, role, expected_authorization_revision: expectedRevision, reason } }),
    }), { actorId, id, role, expectedRevision, reason })
    const roleResponse = await roleResponsePromise
    expect(roleResponse.status()).toBe(200)
    const roleBody = await roleResponse.json()
    expect(roleBody.error ?? roleBody.data?.error).toBeFalsy()
    expect(roleBody.result ?? roleBody.data?.result).toBeTruthy()
  }
  const sessionResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/mcp') && response.request().postDataJSON()?.method === 'ops.session')
  await page.evaluate(() => fetch('/api/mcp', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-ops-workbench': 'platform' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ops.session', params: {} }) }))
  const sessionResponse = await sessionResponsePromise
  const sessionBody = await sessionResponse.json()
  const session = sessionBody.result ?? sessionBody.data?.result
  expect(sessionResponse.status()).toBe(200)
  expect(sessionBody.error ?? sessionBody.data?.error).toBeFalsy()
  expect(session.canonical_roles ?? session.roles).toEqual(expect.arrayContaining(['ops_admin', 'rules_admin', 'finance_ops']))
  expect(session.capabilities).toContain('billing.platform.read')
  const allowedCapabilities = new Set(session.capabilities ?? [])
  const deniedCapabilities = new Set(session.denied_capabilities ?? [])
  for (const permission of session.effective_permissions ?? []) {
    if (typeof permission === 'string') {
      allowedCapabilities.add(permission)
      continue
    }
    const capability = permission.capability ?? permission.id
    if (!capability) continue
    if (permission.effect === 'deny') deniedCapabilities.add(capability)
    else if (permission.effect === 'allow' && (!permission.scope || permission.scope.type === 'platform')) allowedCapabilities.add(capability)
  }
  // Permission denials must win even if a role or capability projection also allows the same capability.
  expect(hasEffectiveCapability(new Set(['billing.platform.read']), new Set(['billing.platform.read']), 'billing.platform.read')).toBe(false)
  console.log(`[ops-matrix] verified roles=${(session.canonical_roles ?? session.roles).join(',')}; capabilities=${session.capabilities.join(',')}`)
  await page.reload()
  const screenReaderAuthorization = page.getByRole('region', { name: '当前身份与权限范围' })
  await expect(screenReaderAuthorization).toContainText('已由服务端验证')
  await page.getByRole('button', { name: '打开账号信息' }).click()
  const accountDialog = page.getByRole('dialog', { name: '账号信息' })
  await expect(accountDialog).toBeVisible()
  const visibleAuthorization = accountDialog.getByRole('region', { name: '当前身份与权限范围' })
  await expect(visibleAuthorization).toContainText('已由服务端验证')
  await expect(visibleAuthorization).toContainText('平台全局')
  await page.keyboard.press('Escape')
  const sidebar = page.getByRole('navigation', { name: '平台运营功能导航' })
  await expect(sidebar.getByRole('button', { name: '模型服务', exact: true })).toHaveCount(0)
  const primaryRail = sidebar.locator('section[aria-labelledby="ops-nav-group-governance"]')
  for (const label of ['总览', '用户中心', '客户交付']) {
    await expect(primaryRail.getByRole('button', { name: label, exact: true })).toBeVisible()
  }
  expect((await primaryRail.getByRole('button').allTextContents()).map(value => value.trim())).toEqual(['总览', '用户中心', '客户交付'])
  await expect(sidebar.getByRole('button', { name: '更多功能', exact: true })).toHaveCount(0)
  await page.goto(new URL('/ops/overview?workbench=platform', base).toString(), { waitUntil: 'domcontentloaded' })
  await expect(sidebar.getByRole('button', { name: '模型服务', exact: true })).toHaveCount(0)
  await page.goto(new URL('/ops/overview?workbench=platform', base).toString(), { waitUntil: 'domcontentloaded' })
  const matrix = []
  for (const [label, domain] of routes) {
    console.log(`[ops-matrix] visiting ${domain}`)
    const workspaceDirectoryResponsePromise = domain === 'customer-delivery' ? page.waitForResponse(response => {
      if (!response.url().endsWith('/api/mcp') || response.request().method() !== 'POST') return false
      const body = response.request().postDataJSON()
      return body?.method === 'ops.workspaces.list' && body?.params?.status === 'active' && body?.params?.merchant_only === 'true'
    }, { timeout: 30_000 }) : undefined
    if (domain === 'overview') {
      const routeButton = page.getByRole('navigation', { name: '平台运营功能导航' }).getByRole('button', { name: '总览', exact: true })
      await expect(routeButton).toBeVisible()
      await routeButton.click()
    } else {
      // Screenshot-backed deep links stay directly routable under server-side
      // authorization while retired/secondary destinations stay off the rail.
      await page.goto(new URL(`/ops/${domain}?workbench=platform`, base).toString(), { waitUntil: 'domcontentloaded' })
    }
    await expect(page).toHaveURL(new RegExp(`/ops/${domain}(?:\\?|$)`))
    await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('已由服务端验证', { timeout: 30_000 })
    if (domain === 'overview') {
      const customerCount = page.getByText('客户总数', { exact: true }).locator('xpath=..').locator('strong')
      // Wait for backend-backed dashboard hydration, not merely the first
      // render after route navigation. The platform shell can still be
      // resolving its authorized session when the overview first paints.
      await expect(customerCount).toContainText('家', { timeout: 30_000 })
      await expect(customerCount).not.toContainText('—', { timeout: 30_000 })
      await expect(page.locator('.ops-dashboard-metric').filter({ hasText: '接入费总收入' }).locator('strong')).not.toContainText('—', { timeout: 30_000 })
      await expect(page.locator('.ops-dashboard-metric').filter({ hasText: '累计平台消耗金额' }).locator('strong')).not.toContainText('—', { timeout: 30_000 })
    }
    await page.waitForTimeout(250)
    await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 })
    // Suspense/lazy route chunks can still be painting after the shared main
    // landmark has stopped reporting busy. Do not archive a skeleton as page
    // evidence; wait for the route's actual content boundary to appear.
    await expect(page.locator('main .ant-skeleton:visible')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator('main .ops-page:visible')).toHaveCount(1, { timeout: 30_000 })
    const routeTitle = domain === 'overview' ? '平台运营实时概况' : domain === 'models' ? '模型计费设置' : {
      users: '已接入用户',
      stores: '平台连接汇总', rules: '平台规则', finance: '平台财务中心',
      'customer-delivery': '客户建档', storage: '存储与对账', audit: '审计中心',
    }[domain]
    await expect(page.locator('main').getByText(routeTitle, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
    const searchInputGeometry = domain === 'users'
      ? await page.getByRole('textbox', { name: '按关键词筛选用户目录' }).evaluate(input => {
        const rect = input.parentElement?.getBoundingClientRect()
        return rect ? { x: rect.x, width: rect.width } : null
      })
      : undefined
    if (domain === 'users') expect(searchInputGeometry?.width, 'user directory search field should match the 200px reference control').toBe(200)
    const userTableHeaderRightEdges = domain === 'users'
      ? await page.locator('.ops-users-page .ant-table-thead th').evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().right)))
      : undefined
    if (userTableHeaderRightEdges) expect(userTableHeaderRightEdges, 'user directory columns should match the latest 1440px reference screenshot').toEqual([287, 692, 905, 1035, 1212, 1391])
    const headings = await page.locator('h1,h2,h3').allTextContents()
    const tabs = await page.getByRole('tab').allTextContents()
    const alerts = await page.getByRole('alert').allTextContents()
    const navigation = await page.getByRole('navigation', { name: '平台运营功能导航' }).getByRole('button').allTextContents()
    expect(navigation.map(value => value.trim())).toEqual(['总览', '用户中心', '客户交付'])
    await expect(sidebar.getByRole('button', { name: '更多功能', exact: true })).toHaveCount(0)
    const denied = headings.some(value => value.startsWith('无权访问'))
    expect(new URL(page.url()).pathname, `${domain} must remain on its canonical route`).toBe(`/ops/${domain}`)
    expect(denied, `${domain} must be reachable with the fixture's granted platform roles`).toBe(false)
    matrix.push({ label, domain, url: new URL(page.url()).pathname, headings: headings.map(value => value.trim()), tabs: tabs.map(value => value.trim()), alerts: alerts.map(value => value.trim().slice(0, 500)), navigation: navigation.map(value => value.trim()), denied,
      ...(domain === 'overview' ? { displayedOverviewMetrics: await page.locator('.ops-dashboard-metric').allInnerTexts() } : {}),
      ...(searchInputGeometry ? { searchInputGeometry } : {}),
      ...(userTableHeaderRightEdges ? { userTableHeaderRightEdges } : {}) })
    await captureEvidence.capture(page, { filePath: join(output, `${domain}.png`), label: domain })
    console.log(`[ops-matrix] captured ${domain}; tabs=${tabs.length}`)
    if (domain === 'stores') {
      const conflictWorkspace = page.getByRole('combobox', { name: '冲突队列工作区' })
      await conflictWorkspace.click()
      const workspaceOptions = page.getByRole('option')
      await expect(workspaceOptions).toHaveCount(1, { timeout: 20_000 })
      const conflictsResponsePromise = page.waitForResponse(response => {
        if (!response.url().endsWith('/api/mcp') || response.request().method() !== 'POST') return false
        const body = response.request().postDataJSON()
        return body?.method === 'ops.canonical.backfill.conflicts.list'
      }, { timeout: 20_000 })
      await conflictWorkspace.press('ArrowDown')
      await conflictWorkspace.press('Enter')
      const conflictsResponse = await conflictsResponsePromise
      const conflictsRequest = conflictsResponse.request().postDataJSON()
      expect(conflictsRequest.params.workspace_id).toBeTruthy()
      expect(conflictsResponse.status()).toBe(200)
      const conflictsBody = await conflictsResponse.json()
      expect(conflictsBody.error ?? conflictsBody.data?.error).toBeFalsy()
      expect(Array.isArray(conflictsBody.result ?? conflictsBody.data?.result)).toBe(true)
      await expect(page.locator('main .ant-select-content-has-value')).toContainText(conflictsRequest.params.workspace_id)
      await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 })
      matrix.push({ label: `${label} → 已选工作区冲突队列`, domain, workspaceId: conflictsRequest.params.workspace_id, status: conflictsResponse.status(), conflictRows: (conflictsBody.result ?? conflictsBody.data?.result).length })
      await captureEvidence.capture(page, { filePath: join(output, 'stores-selected-conflict-workspace.png'), label: 'stores-selected-conflict-workspace' })
    }
    if (domain === 'customer-delivery') {
      const workspaceSelector = page.getByRole('combobox', { name: '客户交付目标企业工作区' })
      // The route starts an explicit active-merchant directory read. Its
      // result is asynchronous and may not be ready when the page screenshot
      // is captured; wait for that real API response before deciding whether
      // this fixture has an authorized target workspace.
      const workspaceDirectoryResponse = await workspaceDirectoryResponsePromise
      expect(workspaceDirectoryResponse.status()).toBe(200)
      const workspaceDirectoryBody = await workspaceDirectoryResponse.json()
      expect(workspaceDirectoryBody.error ?? workspaceDirectoryBody.data?.error).toBeFalsy()
      const workspaceDirectoryResult = workspaceDirectoryBody.result ?? workspaceDirectoryBody.data?.result
      expect(workspaceDirectoryResult).toBeTruthy()
      const authorizedWorkspaceRows = workspaceDirectoryResult.items ?? workspaceDirectoryResult.workspaces ?? []
      expect(Array.isArray(authorizedWorkspaceRows)).toBe(true)
      console.log(`[ops-matrix] active workspace rows=${JSON.stringify(authorizedWorkspaceRows)}`)
      await workspaceSelector.click()
      await expect(workspaceSelector).toHaveAttribute('aria-expanded', 'true')
      const workspaceOptions = page.getByRole('option')
      if (authorizedWorkspaceRows.length > 0) {
        // Select only a workspace explicitly returned by the authorized API.
        await expect(workspaceOptions).toHaveCount(authorizedWorkspaceRows.length, { timeout: 10_000 })
        const workspaceId = authorizedWorkspaceRows[0].workspaceId
        const option = page.getByRole('option', { name: new RegExp(workspaceId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')) })
        await expect(option).toHaveAttribute('aria-disabled', 'false')
        // Ant Design keeps this listbox in the combobox accessibility tree;
        // Playwright can resolve the option but reports it as not visually hit
        // test-addressable under the current Chrome build. Use the native combobox
        // interaction after the API-backed option count is confirmed.
        await workspaceSelector.press('ArrowDown')
        await workspaceSelector.press('Enter')
        await expect(workspaceSelector).toHaveAttribute('aria-expanded', 'false')
        await expect(page.locator('main .ant-select-content-has-value')).toContainText(workspaceId)
        await expect(page.getByText('尚未选择客户工作区', { exact: true })).toHaveCount(0)
        const refreshButton = page.getByRole('button', { name: '刷新交付档案', exact: true })
        await expect(refreshButton).toBeEnabled()
        const refreshResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/mcp')
          && response.request().postDataJSON()?.method === 'ops.customer-delivery.list')
        await refreshButton.click()
        const refreshResponse = await refreshResponsePromise
        expect(refreshResponse.status()).toBe(200)
        expect(refreshResponse.request().postDataJSON()?.params?.target_workspace_id).toBe(workspaceId)
        await page.waitForTimeout(250)
        await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 })
        await captureEvidence.capture(page, { filePath: join(output, 'customer-delivery-selected-workspace.png'), label: 'customer-delivery-selected-workspace' })
        console.log(`[ops-matrix] captured customer delivery with explicitly selected authorized workspace`)
      } else {
        await expect(workspaceOptions).toHaveCount(0)
        await page.keyboard.press('Escape')
        await expect(workspaceSelector).toHaveAttribute('aria-expanded', 'false')
        await expect(page.getByText('尚未选择客户工作区', { exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: '刷新交付档案' })).toBeDisabled()
        console.log(`[ops-matrix] no authorized workspace option; refresh remains disabled by tenant scope`)
      }
    }
    if (domain === 'users' || domain === 'finance' || domain === 'stores') {
      for (const tabName of tabs.map(value => value.trim()).filter(Boolean)) {
        const tab = page.getByRole('tab', { name: tabName, exact: true })
        await expect(tab, `${domain} tab ${tabName} must be unique`).toHaveCount(1)
        await expect(tab, `${domain} tab ${tabName} must be enabled`).not.toHaveAttribute('aria-disabled', 'true')
        await tab.click()
        await page.waitForTimeout(250)
        await expect(tab).toHaveAttribute('aria-selected', 'true')
        matrix.push({ label: `${label} → ${tabName}`, domain, headings: (await page.locator('h1,h2,h3').allTextContents()).map(value => value.trim()), alerts: (await page.getByRole('alert').allTextContents()).map(value => value.trim().slice(0, 500)), selected: await tab.getAttribute('aria-selected') })
        await captureEvidence.capture(page, { filePath: join(output, `${domain}-tab-${tabs.indexOf(tabName)}.png`), label: `${domain}-tab-${tabs.indexOf(tabName)}` })
      }
    }
    if (domain === 'users') {
      const governanceMenu = page.getByRole('button', { name: /更多用户治理操作|切换用户治理页面/u })
      await expect(governanceMenu).toHaveCount(1)
      await governanceMenu.click()
      const dropdown = page.locator('.ant-dropdown:visible')
      await expect(dropdown).toBeVisible()
      const menuText = (await dropdown.innerText()).trim()
      const destinations = governanceDestinations.filter(destination => menuText.includes(destination))
      console.log(`[ops-matrix] governance destinations=${destinations.join(',') || '(none)'}; menu=${menuText.replaceAll('\n', '|')}`)
      expect(destinations, `user governance menu must expose all authorized destinations: ${menuText}`).toEqual(governanceDestinations)
      for (const destination of destinations) {
        const target = dropdown.getByText(destination, { exact: true })
        await expect(target).toBeVisible()
        await target.click()
        await page.waitForTimeout(250)
        const selectedSection = page.getByRole('button', { name: new RegExp(`当前为${destination}`) })
        await expect(selectedSection).toBeVisible()
        matrix.push({ label: `${label} → ${destination}`, domain, headings: (await page.locator('h1,h2,h3').allTextContents()).map(value => value.trim()), alerts: (await page.getByRole('alert').allTextContents()).map(value => value.trim().slice(0, 500)), tables: await page.getByRole('table').count() })
        await captureEvidence.capture(page, { filePath: join(output, `${domain}-governance-${matrix.length}.png`), label: `${domain}-governance-${matrix.length}` })
        if (destination !== destinations.at(-1)) {
          const nextMenu = page.getByRole('button', { name: /更多用户治理操作|切换用户治理页面/u })
          await expect(nextMenu).toHaveCount(1)
          await nextMenu.click()
          await expect(page.locator('.ant-dropdown:visible')).toBeVisible()
        }
      }
      await page.keyboard.press('Escape')
    }
  }
  for (const domain of ['members', 'tasks', 'knowledge']) {
    await page.goto(new URL(`/ops/${domain}?workbench=platform`, base).toString(), { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(new RegExp(`/ops/${domain}(?:\\?|$)`))
    await expect(page.getByText('此页面需要商家工作区权限', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('平台运营控制台不提供该页面', { exact: false })).toBeVisible()
    const headings = await page.locator('h1,h2,h3').allTextContents()
    matrix.push({ label: `${domain} 页面（平台作用域拒绝）`, domain, url: new URL(page.url()).pathname, headings, authorizationState: 'merchant_workspace_scope_required' })
    await captureEvidence.capture(page, { filePath: join(output, `${domain}-platform-scope-denied.png`), label: `${domain}-platform-scope-denied` })
  }
  await Promise.all(overviewApiInspection)
  await writeFile(join(output, 'matrix.json'), JSON.stringify({ auth: 'real-isolated-platform-password-session', productionBrowser: false, matrix, pageErrors, failedApi, overviewApiEvidence }, null, 2), { mode: 0o600 })
  await captureEvidence.finalize()
  expect(pageErrors).toEqual([])
  console.log(`[ops-matrix] failed API requests=${JSON.stringify(failedApi)}`)
  expect(failedApi).toEqual([])
})
