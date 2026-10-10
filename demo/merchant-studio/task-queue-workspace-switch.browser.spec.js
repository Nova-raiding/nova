import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceA = 'ws_task_switch_alpha'
const workspaceB = 'ws_task_switch_beta'

test.setTimeout(60_000)
test.use({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })

const envelope = (workspaceId, data, error = null) => ({
  request_id: 'task-workspace-switch-fixture',
  trace_id: 'task-workspace-switch-fixture',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error,
})

const task = (id, workspaceId, productId) => ({
  id, workspaceId, productId, platform: 'taobao', accountId: `store-${workspaceId}`,
  state: 'draft', version: 1, createdAt: '2026-10-10T02:00:00.000Z',
})

const product = (id, workspaceId) => ({
  id, workspaceId, platform: 'taobao', accountId: `store-${workspaceId}`,
  storeName: `${workspaceId}店铺`, title: workspaceId === workspaceA ? 'A 工作区专属任务商品' : 'B 工作区专属任务商品',
  skuCount: 1, stock: 10, factsConfirmed: true, source: 'browser_fixture', version: 1,
})

const workspaceMetrics = {
  source: 'fixture',
  stores: [],
  productSummary: { total: 0, lowStock: 0, missingImages: 0 },
  riskSummary: { total: 0, returned: 0, truncated: false },
  riskItems: [],
  taskFunnel: {},
}

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
  await selectRoot.locator('.ant-select-content').click({ force: true })
  await expect(selector).toHaveAttribute('aria-expanded', 'true')
  if (!current) await selector.press('Home')
  else if (!current.includes(workspaceId)) await selector.press(workspaceId === workspaceA ? 'ArrowUp' : 'ArrowDown')
  await selector.press('Enter')
  if (label === '选择当前商家工作区 ID') {
    await expect(page.locator('.app-shell')).toBeVisible()
  } else {
    await expect(selection).toContainText(workspaceId)
  }
}

test('任务列表切换到工作区 B 后，迟到的 A 响应不会覆盖 B 的任务', async ({ page }) => {
  let releaseAlphaResponse
  let alphaTaskReads = 0
  const taskReadScopes = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/u, '')
    const requestWorkspace = request.headers()['x-workspace-id'] ?? null
    let data = { items: [], total: 0, limit: 50, offset: 0 }

    if (path === '/v1/auth/session') {
      data = { account: { id: 'task-switch-user', login: 'task-switch@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceA, workspaceB] } }
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
    if (path === '/v1/tasks') {
      taskReadScopes.push(requestWorkspace)
      if (requestWorkspace === workspaceA) {
        alphaTaskReads++
        await new Promise(resolve => { releaseAlphaResponse = resolve })
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspaceA, { items: [task('task-alpha-private', workspaceA, 'product-alpha')], total: 1, limit: 50, offset: 0 })) })
      }
      if (requestWorkspace === workspaceB) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspaceB, { items: [task('task-beta-only', workspaceB, 'product-beta')], total: 1, limit: 50, offset: 0 })) })
      }
    }
    if (path === '/v1/products/product-alpha' || path === '/v1/products/product-beta') {
      const workspaceId = path.endsWith('product-alpha') ? workspaceA : workspaceB
      data = product(path.endsWith('product-alpha') ? 'product-alpha' : 'product-beta', workspaceId)
    } else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      if (method === 'platform.model.status') data = { result: { state: 'ready', capabilities: { image_generation: false } } }
      else if (method === 'workspace.metrics') data = { result: workspaceMetrics }
      else data = { result: {} }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(requestWorkspace, data)) })
  })

  await page.goto(`${studioUrl}/merchant/tasks`, { waitUntil: 'domcontentloaded' })
  await chooseWorkspace(page, '选择当前商家工作区 ID', workspaceA)
  await openRoute(page, '/merchant/tasks')
  await expect.poll(() => alphaTaskReads, { timeout: 10_000 }).toBe(1)

  await chooseWorkspace(page, '按工作区 ID 切换当前商家工作区', workspaceB)
  await expect(page).toHaveURL(/\/merchant\/overview$/u)
  await openRoute(page, '/merchant/tasks')
  await expect(page.getByText('B 工作区专属任务商品')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('A 工作区专属任务商品')).toHaveCount(0)
  expect(taskReadScopes).toEqual([workspaceA, workspaceB])

  releaseAlphaResponse()
  await expect(page.getByText('B 工作区专属任务商品')).toBeVisible()
  await expect(page.getByText('A 工作区专属任务商品')).toHaveCount(0)
  expect(pageErrors).toEqual([])
})
