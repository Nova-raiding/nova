import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceA = 'ws_task_detail_alpha'
const workspaceB = 'ws_task_detail_beta'
const envelope = (workspaceId, data) => ({ request_id: 'task-detail-workspace-switch-fixture', trace_id: 'task-detail-workspace-switch-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

const task = (id, workspaceId, productId) => ({
  id, workspaceId, productId, platform: 'taobao', accountId: `store-${workspaceId}`,
  state: workspaceId === workspaceA ? 'draft' : 'plan_confirmed', version: 1,
  createdAt: '2026-10-10T02:00:00.000Z', requestText: `${workspaceId} 私有任务说明`,
})
const product = (id, workspaceId) => ({
  id, workspaceId, platform: 'taobao', accountId: `store-${workspaceId}`,
  storeName: `${workspaceId}店铺`, title: workspaceId === workspaceA ? 'A 工作区详情商品' : 'B 工作区详情商品',
  skuCount: 1, stock: 10, factsConfirmed: true, source: 'browser_fixture', version: 1,
})

test('task detail ignores a late A task read after switching to workspace B', async () => {
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
    throw new Error('Task detail workspace fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  const externalRequests = []
  const pageErrors = []
  const taskReads = []
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
      data = { account: { id: 'task-detail-reader', login: 'task-detail@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceA, workspaceB] } }
    } else if (path === '/v1/auth/mcp-token') {
      const targetWorkspace = request.postDataJSON()?.workspace_id ?? workspaceA
      data = { access_token: `token-${targetWorkspace}`, refresh_token: `refresh-${targetWorkspace}`, expires_in: 300, workspace_id: targetWorkspace }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path.startsWith('/v1/tasks/')) {
      const taskId = path.slice('/v1/tasks/'.length)
      taskReads.push({ taskId, workspace })
      const owner = taskId === 'task-alpha-private' ? workspaceA : workspaceB
      if (owner === workspaceA && holdA) {
        await new Promise(resolve => pendingAReleases.push(resolve))
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspaceA, task('task-alpha-private', workspaceA, 'product-alpha'))) })
      }
      data = task(taskId, owner, owner === workspaceA ? 'product-alpha' : 'product-beta')
    } else if (path === '/v1/products/product-alpha' || path === '/v1/products/product-beta') {
      const isA = path.endsWith('product-alpha')
      data = product(isA ? 'product-alpha' : 'product-beta', isA ? workspaceA : workspaceB)
    } else if (path === '/v1/platform-accounts') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      if (method === 'platform.model.status') data = { result: { state: 'ready', capabilities: { image_generation: false } } }
      else if (method === 'workspace.metrics') data = { result: { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} } }
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
  async function openTask(taskId) {
    await page.evaluate(id => {
      window.history.pushState(null, '', `/merchant/tasks/${id}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, taskId)
  }

  try {
    await page.goto(`${studioUrl}/merchant/tasks`, { waitUntil: 'domcontentloaded' })
    await chooseWorkspace('选择当前商家工作区 ID', workspaceA)
    await openTask('task-alpha-private')
    await expect.poll(() => taskReads.filter(read => read.taskId === 'task-alpha-private' && read.workspace === workspaceA).length).toBe(1)

    await chooseWorkspace('按工作区 ID 切换当前商家工作区', workspaceB)
    await expect(page).toHaveURL(/\/merchant\/overview$/u)
    await openTask('task-beta-private')
    await expect(page.getByRole('heading', { name: /B 工作区详情商品 · 淘宝/u })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('待生成内容', { exact: true })).toBeVisible()
    await expect(page.getByText('待补充信息', { exact: true })).toHaveCount(0)
    expect(taskReads.some(read => read.taskId === 'task-beta-private' && read.workspace === workspaceB)).toBe(true)

    holdA = false
    for (const release of pendingAReleases) release()
    await expect(page.getByRole('heading', { name: /B 工作区详情商品 · 淘宝/u })).toBeVisible()
    await expect(page.getByText('待生成内容', { exact: true })).toBeVisible()
    await expect(page.getByText('待补充信息', { exact: true })).toHaveCount(0)
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
