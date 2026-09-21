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
// 365c5d84 converged the platform sidebar to a single navigation group. `models`
// is still deliberately absent from OpsSidebar.navigationGroups, so 模型服务 has
// no reachable button; 客户交付 renders no page heading (OpsPage hideTitle) and
// is walked by the ops-delivery-*.spec.js fixtures instead.
//
// 账务与退款 is back: the owner reversed that half of the withdrawal on
// 2026-09-20 (docs/qa/four-product-decisions-2026-09-20.md, option A), which
// restored `finance` to opsDomains / domainReadCapabilities / navigationGroups /
// opsPageRegistry and brought FinancePage back. The `商业化生产门禁` card inside
// it was the one real operational guarantee that withdrawal lost, so walking it
// again is the point rather than a formality.
//
// Shrinking this list is a retirement, not a convenience: every entry that left
// it is written down in ./retired-ops-assertions.md, with what it asserted, the
// commit that removed the surface, and what coverage survives. The models
// withdrawal is still asserted by the reverse gate below rather than being
// merely absent — re-mounting it has to turn that gate red.
const platformSections = ['总览', '用户中心', '账务与退款']
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
    if (section === '账务与退款') {
      // Restored 2026-09-20 together with the finance domain, which is why the
      // section is walked again. This guards the leak the pre-365c5d84 branch
      // guarded: the platform finance surface must not expose tenant
      // member-governance controls. `当前租户成员` is rendered only by
      // components/finance/MembersSection.tsx, which pages/MembersPage.tsx mounts
      // and the restored FinancePage does not; `成员角色调整` is only ever a
      // mutation reason sent to ops.member.upsert, never a rendered label.
      await expect(page.getByText('当前租户成员')).toHaveCount(0)
      await expect(page.getByText('成员角色调整')).toHaveCount(0)
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
// walk entries were removed — as a registered retirement, see
// ./retired-ops-assertions.md — and this test replaced them by asserting the
// withdrawal itself.
//
// The finance half of that gate did its job: it was written so the decision
// "has to come back through review instead of arriving as a silent re-add", and
// on 2026-09-20 it did exactly that. The owner reviewed and restored the
// finance domain (docs/qa/four-product-decisions-2026-09-20.md, option A), so
// this test now asserts the models withdrawal alone and additionally pins the
// facts the restore was for.
//
// Why 模型服务 is still a reverse gate instead of nothing: an entry that merely
// disappears from `platformSections` leaves no signal. If it is ever mounted
// again, the walk would stay green while `OpsSidebar.test.tsx` (which asserts
// the same product fact from the unit side) and this test would go red, so that
// decision has to come back through review too.
test('keeps the withdrawn model services surface unreachable and the restored finance surface reachable', async () => {
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
    // Boot straight onto the finance deep link so the assertion covers
    // `domainFromLocation` and not just the sidebar. It used to canonicalize to
    // overview; it must now resolve to its own domain.
    await openPlatformConsole(page, '/ops/finance')
    const sidebar = page.getByRole('navigation', { name: '平台运营功能导航' })
    await expect(sidebar).toBeVisible({ timeout: 20_000 })
    await expect(sidebar.getByRole('button', { name: '账务与退款', exact: true })).toHaveCount(1)
    // 模型服务 stays withdrawn, and 存储与对账 / 审计中心 never had a sidebar
    // entry because `navigationGroups` omits them.
    for (const label of ['模型服务', '存储与对账', '审计中心']) {
      await expect(sidebar.getByRole('button', { name: label, exact: true })).toHaveCount(0)
    }
    // The deep link must land on the finance page's own heading, never fall back
    // to 运营总览. `FinancePage` picks the title by workbench, and this context
    // is pinned to `platform`.
    await expect(page.locator('h1,h2,h3').filter({ hasText: /^平台财务中心$/u })).toBeVisible({ timeout: 20_000 })
    // The guarantee the withdrawal actually lost: the commercial-readiness card
    // inside FinancePage, which embeds CommercialReadinessPanel. Re-walking the
    // section is not enough — this asserts the evidence panel is on screen.
    await expect(page.getByText('商业化生产门禁')).toBeVisible({ timeout: 20_000 })
    // Still no mount point, and restoring finance did NOT change that:
    // `导出商业配置` lives only in components/finance/PlanBillingSection.tsx, which
    // the restored FinancePage does not import and which has never been imported
    // by any file since 2440b44b. Registered as a remaining gap in
    // ./retired-ops-assertions.md; this assertion is what will go red when it is
    // finally mounted.
    await expect(page.getByRole('button', { name: '导出商业配置' })).toHaveCount(0)
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
