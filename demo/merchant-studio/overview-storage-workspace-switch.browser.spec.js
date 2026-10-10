import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceA = 'ws_overview_storage_a'
const workspaceB = 'ws_overview_storage_b'
const envelope = (workspace, data) => ({ request_id: 'overview-storage-workspace-switch', trace_id: 'overview-storage-workspace-switch', workspace_id: workspace, data, warnings: [], next_actions: [], error: null })

test.setTimeout(60_000)
test.use({ viewport: { width: 1440, height: 1000 } })

test('overview storage card keeps B quota when A quota read resolves late', async ({ page }) => {
  let releaseAQuota
  let aQuotaStartedResolve
  const aQuotaStarted = new Promise(resolve => { aQuotaStartedResolve = resolve })
  const delayedAQuota = new Promise(resolve => { releaseAQuota = resolve })
  const quotaWorkspaces = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/u, '')
    const workspace = request.headers()['x-workspace-id'] ?? null
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') {
      data = { account: { id: 'overview-storage-account', login: 'overview-storage@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceA, workspaceB] } }
    } else if (path === '/v1/auth/mcp-token') {
      const target = request.postDataJSON()?.workspace_id ?? workspaceA
      data = { access_token: `token-${target}`, refresh_token: `refresh-${target}`, expires_in: 300, workspace_id: target }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/assets' && url.searchParams.get('limit') === '1') {
      quotaWorkspaces.push(workspace)
      if (workspace === workspaceA && quotaWorkspaces.filter(value => value === workspaceA).length === 1) {
        aQuotaStartedResolve()
        await delayedAQuota
      }
      const usedBytes = workspace === workspaceB ? 2_000_000_000 : 1_000_000_000
      data = { items: [], total: 0, limit: 1, offset: 0, storage_quota: { usedBytes, reservedBytes: 0, limitBytes: 10_000_000_000, availableBytes: 10_000_000_000 - usedBytes, status: 'available' } }
    } else if (path === '/v1/platform-accounts') data = { items: [] }
    else if (path === '/v1/brand-scopes') data = { settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} }, revision: 0, updated_at: null, series: [], assignments: [] }
    else if (path === '/v1/products' || path === '/v1/rules' || path === '/v1/assets') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === '/mcp') {
      const { method, params = {} } = request.postDataJSON()
      if (method === 'workspace.metrics') data = { result: { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {}, completedTaskCount: 0, date_from: params.date_from ?? '', date_to: params.date_to ?? '' } }
      else if (method === 'creative-points.statement.list') data = { result: { entries: [] } }
      else if (method === 'subscription.get' || method === 'commercial.subscription.get') data = { result: { schema_version: 'commercial.subscription.v1', status: 'available', current: null, future: [], packs: [], history: [], orders: [] } }
      else if (method === 'creative-points.balance.get') data = { result: { available_points: 0 } }
      else if (method === 'billing.transactions') data = { result: { balance_cny: '0.00', transactions: [] } }
      else if (method === 'commercial.catalog.get') data = { result: { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [] } }
      else data = { result: {} }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspace, data)) })
  })

  await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
  const bootstrap = page.getByRole('combobox', { name: '选择当前商家工作区 ID' })
  await expect(bootstrap).toBeVisible()
  await bootstrap.click()
  await page.getByText(`工作区 ID · ${workspaceA}`, { exact: true }).last().click()
  await aQuotaStarted

  const workspacePicker = page.getByRole('combobox', { name: '按工作区 ID 切换当前商家工作区' })
  await workspacePicker.click()
  await page.getByText(`工作区 ID · ${workspaceB}`, { exact: true }).last().click()
  const storageCard = page.getByLabel('素材概览')
  await expect(storageCard).toContainText('2.0')
  await expect(storageCard).not.toContainText('1.0')

  releaseAQuota()
  await expect(storageCard).toContainText('2.0')
  await expect(storageCard).not.toContainText('1.0')
  expect(quotaWorkspaces.filter(Boolean)).toEqual([workspaceA, workspaceB])
  expect(pageErrors).toEqual([])
})
