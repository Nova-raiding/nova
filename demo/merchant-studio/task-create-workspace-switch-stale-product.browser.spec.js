import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceA = 'ws_task_create_alpha'
const workspaceB = 'ws_task_create_beta'
const productId = 'product-shared-task-entry-fixture'
const envelope = (workspaceId, data, error = null) => ({ request_id: 'task-create-workspace-switch-fixture', trace_id: 'task-create-workspace-switch-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

const chooseWorkspace = async (page, workspaceId) => {
  const selector = page.getByRole('combobox', { name: '按工作区 ID 切换当前商家工作区', exact: true })
  const selection = selector.locator('xpath=..')
  const selectRoot = selector.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")]')
  await expect(selector).toBeVisible()
  const current = (await selection.textContent())?.trim() ?? ''
  await selectRoot.locator('.ant-select-content').click({ force: true })
  if (!current.includes(workspaceId)) await selector.press(workspaceId === workspaceA ? 'ArrowUp' : 'ArrowDown')
  await selector.press('Enter')
  await expect(selection).toContainText(workspaceId)
}

test('late product context from workspace A cannot populate task creation after switching to workspace B', async () => {
  test.setTimeout(90_000)
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Task creation workspace-switch fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const productReads = []
  const taskIntentRequests = []
  const taskCreationWrites = []
  let announceARead
  let announceBRead
  let releaseA
  let releaseB
  const aReadObserved = new Promise(resolve => { announceARead = resolve })
  const bReadObserved = new Promise(resolve => { announceBRead = resolve })
  const aResponseGate = new Promise(resolve => { releaseA = resolve })
  const bResponseGate = new Promise(resolve => { releaseB = resolve })

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    const method = request.method()
    const requestWorkspace = request.headers()['x-workspace-id'] ?? null
    if (method === 'POST' && path === '/v1/tasks/understand') taskIntentRequests.push({ workspace: requestWorkspace })
    if (method === 'POST' && (path === '/v1/tasks' || path === '/v1/task-requests')) taskCreationWrites.push({ path, workspace: requestWorkspace })
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/auth/session') {
      data = { account: { id: 'task-create-workspace-user', login: 'task-create-workspace@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceA, workspaceB] } }
    } else if (path === '/v1/auth/mcp-token') {
      const tokenWorkspace = request.postDataJSON()?.workspace_id ?? null
      data = { access_token: `fixture-${tokenWorkspace}`, refresh_token: `fixture-refresh-${tokenWorkspace}`, expires_in: 300, workspace_id: tokenWorkspace }
    } else if (path === `/v1/products/${productId}` && method === 'GET') {
      productReads.push(requestWorkspace)
      if (requestWorkspace === workspaceA) {
        announceARead()
        await aResponseGate
        data = { id: productId, workspaceId: workspaceA, platform: 'jd', accountId: 'store-alpha', storeName: 'A 店铺', title: 'A 工作区私有商品', skuCount: 1, stock: 10, factsConfirmed: true, source: 'browser_fixture', version: 1 }
      } else if (requestWorkspace === workspaceB) {
        announceBRead()
        await bResponseGate
        data = { id: productId, workspaceId: workspaceB, platform: 'jd', accountId: 'store-beta', storeName: 'B 店铺', title: 'B 工作区商品', skuCount: 1, stock: 5, factsConfirmed: true, source: 'browser_fixture', version: 2 }
      }
    } else if (path === '/mcp') {
      const tool = request.postDataJSON()?.method
      data = { result: tool === 'workspace.metrics'
        ? { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} }
        : tool === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(requestWorkspace, data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    const initialWorkspaceSelector = page.getByRole('combobox', { name: '选择当前商家工作区 ID', exact: true })
    await initialWorkspaceSelector.click()
    await initialWorkspaceSelector.press('ArrowDown')
    await initialWorkspaceSelector.press('Enter')
    await expect(page.locator('.app-shell')).toBeVisible()

    const routeFor = (accountId) => `/merchant/tasks/new?product_id=${productId}&platform=jd&account_id=${accountId}&intent=workspace-switch-fixture`
    const openTaskEntry = async (accountId) => page.evaluate(path => {
      window.history.pushState(null, '', path)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, routeFor(accountId))

    await openTaskEntry('store-alpha')
    await aReadObserved
    expect(productReads).toEqual([workspaceA])

    await chooseWorkspace(page, workspaceB)
    await expect(page).toHaveURL(/\/merchant\/overview$/u)
    await openTaskEntry('store-beta')
    await bReadObserved
    expect(productReads).toEqual([workspaceA, workspaceB])

    releaseA()
    await expect(page.getByText('正在从链接安全恢复商品与任务上下文…')).toBeVisible()
    await expect(page.getByRole('heading', { name: /A 工作区私有商品/u })).toHaveCount(0)

    releaseB()
    await expect(page.locator('main h2')).toContainText('B 工作区商品 · 京东 · B 店铺')
    await expect(page.getByRole('heading', { name: /A 工作区私有商品/u })).toHaveCount(0)
    expect(productReads).toEqual([workspaceA, workspaceB])
    expect(taskIntentRequests).toEqual([])
    expect(taskCreationWrites).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    releaseA?.()
    releaseB?.()
    await context.close()
    await browser.close()
    await vite.close()
  }
})
