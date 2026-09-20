import { expect, test, chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'

test.setTimeout(240_000)
const baseUrl = process.env.OPS_OIDC_BASE_URL ?? process.env.OPS_BASE_URL ?? 'http://127.0.0.1:18082/'
// Platform operations and workspace administration are separate workbenches.
// Member governance is intentionally not part of the platform walk: it is
// only exercised with a workspace membership fixture below.
// These domains require a workspace-scoped policy and are covered by
// workspace fixtures, never by the platform token walk.
// The platform sidebar was intentionally converged to a single navigation
// group (365c5d84: 总览/用户中心/客户交付). A browser walk can only click what
// the sidebar exposes: `models` is deliberately absent from
// OpsSidebar.navigationGroups, and `/ops/finance` now canonicalizes back to the
// overview domain, so 模型服务 and 账务与退款 have no reachable button. 客户交付
// renders no page heading (OpsPage hideTitle) and is walked by the
// ops-delivery-*.spec.js fixtures instead.
//
// Shrinking this list is a retirement, not a convenience: every entry that left
// it is written down in ./retired-ops-assertions.md, with what it asserted, the
// commit that removed the surface, and what coverage survives. The withdrawal
// itself is now asserted by the reverse gate below rather than being merely
// absent — re-mounting either surface has to turn that gate red.
const platformSections = ['总览', '用户中心']
const headings = { '总览': '运营总览', '成员与权限': '成员与权限', '客服': '客服工作台', '平台连接': '平台连接汇总', '存储与对账': '存储与对账', '账务与退款': '平台财务中心' }

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
    if (request.failure()?.errorText === 'net::ERR_ABORTED' || request.url().startsWith('https://fonts.googleapis.com/')) return
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
  await openPlatformConsole(page)
  await page.waitForTimeout(5_000)
  const pages = []
  const shots = resolve('screenshots', 'ops-pages')
  await mkdir(shots, { recursive: true })
  for (const [index, section] of platformSections.entries()) {
    const sectionButton = page.locator('button').filter({ hasText: new RegExp(`^${section}$`, 'u') }).first()
    if (await sectionButton.count() === 0) throw new Error(`OPS_SECTION_BUTTON_MISSING:${section}`)
    await sectionButton.click()
    const expectedHeading = headings[section] ?? section
    await page.locator('h1,h2,h3').filter({ hasText: new RegExp(`^${expectedHeading}$`, 'u') }).waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(5_000)
    if (section === '用户中心') {
      const userDirectory = page.getByRole('tab', { name: '已开通用户', exact: true })
      const userDirectoryLink = page.getByRole('link', { name: '用户目录', exact: true })
      const userDirectoryHeading = page.getByRole('heading', { name: '用户目录', exact: true })
      const userDirectoryTable = page.getByRole('table', { name: '用户目录数据表', exact: true })
      const hasDirectory = await userDirectory.or(userDirectoryLink).count() + await userDirectoryHeading.count() + await userDirectoryTable.count()
      if (hasDirectory === 0) {
        await expect(page.getByText(/当前角色没有用户治理视图|没有用户治理读取能力/)).toBeVisible()
      }
      await expect(page.getByText('当前租户成员')).toHaveCount(0)
    }
    pages.push(await snapshot(page, section))
    await page.screenshot({ path: resolve(shots, `${index + 1}-${section}.png`) })
  }
  await writeFile('ops-all-inventory.json', JSON.stringify({ pages, badResponses, rpcErrors, requestFailures, consoleErrors }, null, 2))
  const unexpectedBadResponses = badResponses.filter((response) => {
    if (response.status !== 403 || !response.body.includes('"code":"MEMBER_ROLE_MISMATCH"')) return true
    return false
  })
  expect(unexpectedBadResponses).toEqual([])
  const unexpectedRpcErrors = rpcErrors.filter((entry) => entry.error?.code !== 'MEMBER_ROLE_MISMATCH')
  expect(unexpectedRpcErrors).toEqual([])
  expect(requestFailures).toEqual([])
  expect(consoleErrors.filter((message) =>
    !message.includes('status of 403 (Forbidden)'),
  )).toEqual([])
  // Stop page-owned polling/request work before tearing down the context.
  // A background fetch can keep Playwright's close promise pending after the
  // full domain walk, so bound teardown and avoid turning a clean walk into a
  // four-minute test timeout.
  const closeWithDeadline = async (close, deadlineMs = 5_000) => {
    let timer
    await Promise.race([
      close().catch(() => undefined),
      new Promise(resolve => { timer = setTimeout(resolve, deadlineMs) }),
    ])
    clearTimeout(timer)
  }
  await closeWithDeadline(() => page.close())
  await closeWithDeadline(() => context.close())
  await closeWithDeadline(() => browser.close())
})

// The walk above used to cover 模型服务 and 账务与退款. 365c5d84 converged the
// platform sidebar to a single navigation group, dropped `models` from
// OpsSidebar.navigationGroups, removed `finance` from opsDomains /
// domainReadCapabilities / navigationGroups and deleted FinancePage. The two
// walk entries were therefore removed — as a registered retirement, see
// ./retired-ops-assertions.md — and this test is the coverage that replaces
// them: it asserts the withdrawal itself.
//
// Why a reverse gate instead of nothing: an entry that merely disappears from
// `platformSections` leaves no signal. If the destination is ever mounted
// again, the walk would stay green while `OpsSidebar.test.tsx` (which asserts
// the same product fact from the unit side) and this test would go red, so the
// decision has to come back through review instead of arriving as a silent
// re-add.
test('keeps the withdrawn finance and model navigation surfaces unreachable', async () => {
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
  try {
    // Boot straight onto the withdrawn deep link so the assertion covers the
    // canonicalization in `domainFromLocation` and not just the sidebar.
    await openPlatformConsole(page, '/ops/finance')
    const sidebar = page.getByRole('navigation', { name: '平台运营功能导航' })
    await expect(sidebar).toBeVisible({ timeout: 20_000 })
    for (const label of ['账务与退款', '模型服务', '存储与对账', '审计中心']) {
      await expect(sidebar.getByRole('button', { name: label, exact: true })).toHaveCount(0)
    }
    // The commercial export button exists only inside PlanBillingSection, which
    // has never been mounted (2440b44b onward), so it must not appear anywhere.
    await expect(page.getByRole('button', { name: '导出商业配置' })).toHaveCount(0)
    // /ops/finance canonicalizes back to the overview domain and FinancePage is
    // gone: the deep link must land on 运营总览, never on 平台财务中心.
    await expect(page.locator('h1,h2,h3').filter({ hasText: /^运营总览$/u })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('平台财务中心')).toHaveCount(0)
  } finally {
    await context.close()
    await browser.close()
  }
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
  // Fail exactly one dataset: every other read stays real, so any warning the
  // assertions below see has to come from `platform.model.status`.
  const failedModelStatusCalls = []
  await context.route('**/api/mcp', async route => {
    const body = route.request().postDataJSON()
    if (body?.method === 'platform.model.status') {
      failedModelStatusCalls.push(body?.id ?? null)
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'MODEL_STATUS_UNAVAILABLE', message: '模型状态暂不可用' } }) })
      return
    }
    await route.continue()
  })
  const page = await context.newPage()
  await openPlatformConsole(page)
  // The converged platform console does not mount ModelStatusSection or
  // ModelServiceSummary, so `状态不可用` is unreachable there — that surface is
  // registered as a re-anchored retirement in ./retired-ops-assertions.md
  // (entry 6). The product's fail-closed signal for a failed model-status read
  // is the global load warning: it must be visible and it must name the dataset
  // that failed. Swallowing the failure would leave the operator reading a
  // console that looks like the model configuration is healthy.
  const loadWarning = page.locator('.ops-global-load-warning')
  await expect(loadWarning).toBeVisible({ timeout: 20_000 })
  expect(failedModelStatusCalls.length).toBeGreaterThan(0)
  await expect(loadWarning.getByText('部分运营数据未刷新')).toBeVisible()
  await expect(loadWarning.getByText(/个数据集刷新失败/u)).toBeVisible()
  await loadWarning.getByText('查看失败数据集与原因').click()
  await expect(loadWarning.getByText(/platform\.model\.status/u)).toBeVisible()
  // A failed model status read must never be presented as a successful model
  // configuration.
  await expect(page.getByText('平台模型配置完整')).toHaveCount(0)
  await expect(page.getByText('状态不可用')).toHaveCount(0)
  await context.close()
  await browser.close()
})
