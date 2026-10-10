import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceA = 'ws_finance_ledger_a'
const workspaceB = 'ws_finance_ledger_b'
const envelope = (workspace, data) => ({ request_id: 'finance-ledger-workspace-switch', trace_id: 'finance-ledger-workspace-switch', workspace_id: workspace, data, warnings: [], next_actions: [], error: null })

test.setTimeout(60_000)
test.use({ viewport: { width: 1440, height: 1000 } })

test('finance ledger keeps B statement when A statement read resolves late', async ({ page }) => {
  let delayAStatement = false
  let releaseAStatement
  let aStatementStartedResolve
  const aStatementStarted = new Promise(resolve => { aStatementStartedResolve = resolve })
  const delayedAStatement = new Promise(resolve => { releaseAStatement = resolve })
  const statementRequests = []
  const mcpMethods = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))

  const entry = (workspace, suffix, points, day) => ({
    id: `statement-${suffix}`,
    workspaceId: workspace,
    operationId: `operation-${suffix}`,
    eventType: 'granted',
    pointsDelta: points,
    availableAfter: points,
    reservedAfter: 0,
    settledAfter: 0,
    accessRevision: 1,
    createdAt: `2026-10-${day}T04:00:00.000Z`,
    intent: {},
    grantSourceType: 'subscription',
    grantSourceId: `grant-${suffix}`,
    commercial_origin: { status: 'known', kind: 'subscription_points', source_order_id: `order-${suffix}`, sku_version_id: `sku-${suffix}`, grant_id: `grant-${suffix}` },
  })

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/u, '')
    const workspace = request.headers()['x-workspace-id'] ?? null
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') {
      data = { account: { id: 'finance-ledger-race-account', login: 'finance-race@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceA, workspaceB] } }
    } else if (path === '/v1/auth/mcp-token') {
      const target = request.postDataJSON()?.workspace_id ?? workspaceA
      data = { access_token: `token-${target}`, refresh_token: `refresh-${target}`, expires_in: 300, workspace_id: target }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/assets' && url.searchParams.get('limit') === '1') {
      data = { items: [], total: 0, limit: 1, offset: 0, storage_quota: { usedBytes: 0, reservedBytes: 0, limitBytes: 1_000_000_000, availableBytes: 1_000_000_000, status: 'available' } }
    } else if (path === '/v1/assets' || path === '/v1/products' || path === '/v1/rules') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === '/v1/platform-accounts') data = { items: [] }
    else if (path === '/v1/brand-scopes') data = { settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} }, revision: 0, updated_at: null, series: [], assignments: [] }
    else if (path === '/mcp') {
      const { method, params = {} } = request.postDataJSON()
      mcpMethods.push(method)
      if (method === 'creative-points.statement.list') {
        statementRequests.push(workspace)
        if (workspace === workspaceA && delayAStatement) {
          aStatementStartedResolve()
          await delayedAStatement
        }
        data = { result: { entries: [entry(workspace, workspace === workspaceB ? 'B' : 'A', workspace === workspaceB ? 275 : 111, workspace === workspaceB ? '08' : '02')] } }
      } else if (method === 'workspace.metrics') data = { result: { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {}, completedTaskCount: 0, date_from: params.date_from ?? '', date_to: params.date_to ?? '' } }
      else if (method === 'commercial.subscription.get' || method === 'subscription.get') data = { result: { schema_version: 'commercial.subscription.v1', status: 'available', current: null, future: [], packs: [], history: [], orders: [] } }
      else if (method === 'creative-points.balance.get') data = { result: { available_points: 400 } }
      else if (method === 'billing.transactions') data = { result: { balance_cny: '0.00', transactions: [] } }
      else if (method === 'commercial.catalog.get') data = { result: { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [] } }
      else data = { result: {} }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspace, data)) })
  })

  await page.goto(`${studioUrl}/merchant/finance`, { waitUntil: 'domcontentloaded' })
  const bootstrap = page.getByRole('combobox', { name: '选择当前商家工作区 ID' })
  await expect(bootstrap).toBeVisible()
  await bootstrap.click()
  await page.getByText(`工作区 ID · ${workspaceA}`, { exact: true }).last().click()
  delayAStatement = true
  await page.getByRole('button', { name: '财务概况' }).click()
  await aStatementStarted

  const workspacePicker = page.getByRole('combobox', { name: '按工作区 ID 切换当前商家工作区' })
  await workspacePicker.click()
  await page.getByText(`工作区 ID · ${workspaceB}`, { exact: true }).last().click()
  await page.getByRole('button', { name: '财务概况' }).click()
  const ledger = page.getByRole('region', { name: '创意点来源账本' })
  const bRow = ledger.getByRole('row').filter({ hasText: '2026/10/8 12:00:00' })
  await expect(bRow).toBeVisible()
  await bRow.getByText('查看流水来源').click()
  await expect(bRow).toContainText('来源订单 order-B')
  await expect(ledger).not.toContainText('order-A')

  releaseAStatement()
  await expect(bRow).toBeVisible()
  await expect(bRow).toContainText('来源订单 order-B')
  await expect(ledger).not.toContainText('order-A')
  expect(statementRequests).toContain(workspaceA)
  expect(statementRequests).toContain(workspaceB)
  expect(mcpMethods.filter(method => /(?:order|payment|recharge)\.(?:create|request\.create)/u.test(method))).toEqual([])
  expect(pageErrors).toEqual([])
})
