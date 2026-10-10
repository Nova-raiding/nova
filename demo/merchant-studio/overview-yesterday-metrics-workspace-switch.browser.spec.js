import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceA = 'ws_overview_yesterday_alpha'
const workspaceB = 'ws_overview_yesterday_beta'
const envelope = (workspaceId, data) => ({ request_id: 'overview-yesterday-workspace-fixture', trace_id: 'overview-yesterday-workspace-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })
const emptyMetrics = (completedTaskCount = 0) => ({
  stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 },
  riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {}, completedTaskCount,
})

test('overview keeps workspace B yesterday task count when A metrics arrive late', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Overview workspace fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  const externalRequests = []
  const pageErrors = []
  const yesterdayMetricReads = []
  const pendingAReleases = []
  let holdA = true
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== studioUrl) externalRequests.push(request.url())
  })
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    const workspace = request.headers()['x-workspace-id'] ?? null
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') {
      data = { account: { id: 'overview-yesterday-reader', login: 'overview-yesterday@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceA, workspaceB] } }
    } else if (path === '/v1/auth/mcp-token') {
      const targetWorkspace = request.postDataJSON()?.workspace_id ?? workspaceA
      data = { access_token: `token-${targetWorkspace}`, refresh_token: `refresh-${targetWorkspace}`, expires_in: 300, workspace_id: targetWorkspace }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/platform-accounts') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (path === '/v1/assets' && url.searchParams.get('limit') === '1') {
      data = { items: [], total: 0, limit: 1, offset: 0, storage_quota: { usedBytes: 0, reservedBytes: 0, limitBytes: 1_000_000, availableBytes: 1_000_000, status: 'available' } }
    } else if (path === '/v1/rules') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (path === '/mcp') {
      const body = request.postDataJSON() ?? {}
      const method = body.method
      const params = body.params ?? {}
      if (method === 'workspace.metrics' && params.date_from && params.date_to) {
        yesterdayMetricReads.push({ workspace, dateFrom: params.date_from, dateTo: params.date_to })
        if (workspace === workspaceA && holdA) {
          await new Promise(resolve => pendingAReleases.push(resolve))
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspaceA, { result: emptyMetrics(123) })) })
        }
        data = { result: emptyMetrics(workspace === workspaceB ? 7 : 0), date_from: params.date_from, date_to: params.date_to }
      } else if (method === 'workspace.metrics') data = { result: emptyMetrics() }
      else if (method === 'creative-points.statement.list') data = { result: { entries: [], truncated: false, unreadable_entries: 0 } }
      else if (method === 'creative-points.balance.get') data = { result: { available_points: 0 } }
      else if (method === 'subscription.get' || method === 'commercial.subscription.get') data = { result: { schema_version: 'commercial.subscription.v1', status: 'available', current: null, future: [], packs: [], history: [], orders: [] } }
      else if (method === 'billing.transactions') data = { result: { balance_cny: '0.00', transactions: [] } }
      else if (method === 'commercial.catalog.get') data = { result: { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [] } }
      else data = { result: {} }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspace, data)) })
  })

  async function chooseWorkspace(label, workspaceId) {
    const selector = page.getByRole('combobox', { name: label, exact: true })
    await expect(selector).toBeVisible()
    const selectRoot = selector.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")]')
    const selection = selector.locator('xpath=..')
    await selectRoot.locator('.ant-select-content').click({ force: true })
    await expect(selector).toHaveAttribute('aria-expanded', 'true')
    await page.getByText(`工作区 ID · ${workspaceId}`, { exact: true }).last().click()
    if (label === '选择当前商家工作区 ID') await expect(page.locator('.app-shell')).toBeVisible()
    else await expect(selection).toContainText(workspaceId)
  }

  try {
    await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    await chooseWorkspace('选择当前商家工作区 ID', workspaceA)
    await expect.poll(() => yesterdayMetricReads.filter(read => read.workspace === workspaceA).length).toBe(1)

    await chooseWorkspace('按工作区 ID 切换当前商家工作区', workspaceB)
    const dataBoard = page.locator('.today-data-board')
    await expect(dataBoard).toContainText('7次', { timeout: 10_000 })
    await expect(dataBoard).not.toContainText('123次')
    expect(yesterdayMetricReads.some(read => read.workspace === workspaceB)).toBe(true)

    holdA = false
    for (const release of pendingAReleases) release()
    await expect(dataBoard).toContainText('7次')
    await expect(dataBoard).not.toContainText('123次')
    expect(pageErrors).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    holdA = false
    for (const release of pendingAReleases) release()
    await context.close()
    await browser.close()
    await vite.close()
  }
})
