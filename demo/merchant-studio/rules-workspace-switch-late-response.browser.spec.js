import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceA = 'ws_rules_late_a'
const workspaceB = 'ws_rules_late_b'
const envelope = (workspace, data) => ({ request_id: 'rules-workspace-switch', trace_id: 'rules-workspace-switch', workspace_id: workspace, data, warnings: [], next_actions: [], error: null })

test.setTimeout(60_000)
test.use({ viewport: { width: 1440, height: 1000 } })

test('rules page keeps B rule pack after A rule list responds late', async ({ page }) => {
  const ruleReads = new Map([[workspaceA, 0], [workspaceB, 0]])
  let releaseARules
  let aRulesStartedResolve
  const aRulesStarted = new Promise(resolve => { aRulesStartedResolve = resolve })
  const delayedARules = new Promise(resolve => { releaseARules = resolve })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/u, '')
    const workspace = request.headers()['x-workspace-id'] ?? null
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') {
      data = { account: { id: 'rules-workspace-account', login: 'rules-race@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceA, workspaceB] } }
    } else if (path === '/v1/auth/mcp-token') {
      const target = request.postDataJSON()?.workspace_id ?? workspaceA
      data = { access_token: `token-${target}`, refresh_token: `refresh-${target}`, expires_in: 300, workspace_id: target }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/rules') {
      const count = (ruleReads.get(workspace) ?? 0) + 1
      ruleReads.set(workspace, count)
      // Overview reads the same collection once after selecting each tenant;
      // the following A read belongs to the explicit rules page journey.
      if (workspace === workspaceA && count === 2) {
        aRulesStartedResolve()
        await delayedARules
      }
      data = { items: [{ id: `rule-${workspace}`, name: `规则包 ${workspace}`, version: '1.0.0', scope: '全平台', category: 'platform', status: 'active', updatedAt: '2026-10-11T00:00:00.000Z', revision: 1, source: { kind: 'fixture', reference: `source-${workspace}`, checkedAt: '2026-10-11T00:00:00.000Z' } }], total: 1, limit: 50, offset: 0 }
    } else if (path === '/v1/catalog/categories') data = []
    else if (path === '/v1/assets') data = { items: [], total: 0, limit: 50, offset: 0, storage_quota: { usedBytes: 0, reservedBytes: 0, limitBytes: 1_000_000_000, availableBytes: 1_000_000_000, status: 'available' } }
    else if (path === '/v1/platform-accounts' || path === '/v1/products') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === '/mcp') {
      const { method, params = {} } = request.postDataJSON()
      if (method === 'workspace.metrics') data = { result: { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {}, completedTaskCount: 0, date_from: params.date_from ?? '', date_to: params.date_to ?? '' } }
      else if (method === 'creative-points.statement.list') data = { result: { entries: [] } }
      else if (method === 'commercial.subscription.get' || method === 'subscription.get') data = { result: { schema_version: 'commercial.subscription.v1', status: 'available', current: null, future: [], packs: [], history: [], orders: [] } }
      else if (method === 'creative-points.balance.get') data = { result: { available_points: 0 } }
      else if (method === 'billing.transactions') data = { result: { balance_cny: '0.00', transactions: [] } }
      else if (method === 'commercial.catalog.get') data = { result: { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [] } }
      else data = { result: {} }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspace, data)) })
  })

  await page.goto(`${studioUrl}/merchant/rules`, { waitUntil: 'domcontentloaded' })
  const bootstrap = page.getByRole('combobox', { name: '选择当前商家工作区 ID' })
  await expect(bootstrap).toBeVisible()
  await bootstrap.click()
  await page.getByText(`工作区 ID · ${workspaceA}`, { exact: true }).last().click()
  await expect.poll(() => ruleReads.get(workspaceA)).toBe(1)
  await page.getByRole('button', { name: '规则与类目' }).click()
  await aRulesStarted

  const workspacePicker = page.getByRole('combobox', { name: '按工作区 ID 切换当前商家工作区' })
  await workspacePicker.click()
  await page.getByText(`工作区 ID · ${workspaceB}`, { exact: true }).last().click()
  await page.getByRole('button', { name: '规则与类目' }).click()
  await expect(page.getByText(`规则包 ${workspaceB}`, { exact: true })).toBeVisible()
  await expect(page.getByText(`规则包 ${workspaceA}`, { exact: true })).toHaveCount(0)

  releaseARules()
  await expect(page.getByText(`规则包 ${workspaceB}`, { exact: true })).toBeVisible()
  await expect(page.getByText(`规则包 ${workspaceA}`, { exact: true })).toHaveCount(0)
  expect(ruleReads.get(workspaceA)).toBe(2)
  expect(ruleReads.get(workspaceB)).toBe(2)
  expect(pageErrors).toEqual([])
})
