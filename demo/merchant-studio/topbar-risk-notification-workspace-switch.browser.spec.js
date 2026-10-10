import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceA = 'ws_topbar_risk_alpha'
const workspaceB = 'ws_topbar_risk_beta'

test.setTimeout(60_000)
test.use({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })

const envelope = (workspaceId, data) => ({
  request_id: 'topbar-risk-workspace-switch-fixture',
  trace_id: 'topbar-risk-workspace-switch-fixture',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
})

const metrics = (workspaceId) => ({
  source: 'fixture',
  stores: [],
  productSummary: { total: 0, lowStock: 0, missingImages: 0 },
  riskSummary: { total: 1, returned: 1, truncated: false },
  riskItems: [{ severity: 'medium', type: 'FIXTURE_WORKSPACE_RISK', title: `${workspaceId} 专属待处理问题`, platform: 'taobao', accountId: `store-${workspaceId}`, storeName: `${workspaceId}店铺`, status: 'open', nextAction: '查看对应工作区问题' }],
  taskFunnel: {},
})

async function chooseWorkspace(page, label, workspaceId) {
  const selector = page.getByRole('combobox', { name: label, exact: true })
  await expect(selector).toBeVisible()
  const selectRoot = selector.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")]')
  const selection = selector.locator('xpath=..')
  const current = label === '选择当前商家工作区 ID' ? '' : ((await selection.textContent().catch(() => ''))?.trim() ?? '')
  await selectRoot.locator('.ant-select-content').click({ force: true })
  await expect(selector).toHaveAttribute('aria-expanded', 'true')
  if (!current) await selector.press('Home')
  else if (!current.includes(workspaceId)) await selector.press(workspaceId === workspaceA ? 'ArrowUp' : 'ArrowDown')
  await selector.press('Enter')
  if (label === '选择当前商家工作区 ID') await expect(page.locator('.app-shell')).toBeVisible()
  else await expect(selection).toContainText(workspaceId)
}

test('顶栏风险通知切到工作区 B 后忽略迟到的 A 读取', async ({ page }) => {
  let releaseAlphaRead
  let alphaTopbarReads = 0
  const topbarReadScopes = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/u, '')
    const requestWorkspace = request.headers()['x-workspace-id'] ?? null
    let data = { items: [], total: 0, limit: 50, offset: 0 }

    if (path === '/v1/auth/session') {
      data = { account: { id: 'topbar-risk-reader', login: 'risk-reader@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceA, workspaceB] } }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(null, data)) })
    }
    if (path === '/v1/auth/mcp-token') {
      const workspaceId = request.postDataJSON()?.workspace_id ?? null
      data = { access_token: `token-${workspaceId}`, refresh_token: `refresh-${workspaceId}`, expires_in: 300, workspace_id: workspaceId }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(null, data)) })
    }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(null, data)) })
    }
    if (path === '/mcp') {
      const body = request.postDataJSON()
      const method = body?.method
      if (method === 'workspace.metrics') {
        const params = body?.params ?? {}
        if (!Object.hasOwn(params, 'date_from')) {
          topbarReadScopes.push(requestWorkspace)
          if (requestWorkspace === workspaceA) {
            alphaTopbarReads++
            if (alphaTopbarReads === 1) {
              await new Promise(resolve => { releaseAlphaRead = resolve })
              data = { result: metrics(workspaceA) }
            } else data = { result: metrics(workspaceA) }
          } else data = { result: metrics(workspaceB) }
        } else data = { result: { ...metrics(requestWorkspace), riskItems: [] } }
      } else if (method === 'platform.model.status') data = { result: { state: 'ready', capabilities: { image_generation: false } } }
      else data = { result: {} }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(requestWorkspace, data)) })
  })

  await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
  await chooseWorkspace(page, '选择当前商家工作区 ID', workspaceA)
  await expect.poll(() => alphaTopbarReads, { timeout: 10_000 }).toBeGreaterThan(0)

  await chooseWorkspace(page, '按工作区 ID 切换当前商家工作区', workspaceB)
  await expect.poll(() => topbarReadScopes.filter(scope => scope === workspaceB).length, { timeout: 10_000 }).toBeGreaterThan(0)
  const bell = page.getByRole('button', { name: /工作区待处理问题/u })
  await expect(bell).toHaveAccessibleName(/1 项/u)
  await bell.click()
  const notificationPanel = page.getByRole('region', { name: '待处理问题' })
  await expect(notificationPanel.getByText(`${workspaceB} 专属待处理问题`)).toBeVisible()
  await expect(notificationPanel.getByText(`${workspaceA} 专属待处理问题`)).toHaveCount(0)

  releaseAlphaRead()
  await expect(notificationPanel.getByText(`${workspaceB} 专属待处理问题`)).toBeVisible()
  await expect(notificationPanel.getByText(`${workspaceA} 专属待处理问题`)).toHaveCount(0)
  expect(topbarReadScopes[0]).toBe(workspaceA)
  expect(topbarReadScopes).toContain(workspaceB)
  expect(pageErrors).toEqual([])
})
