import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_task_scope_block_fixture'
const productId = 'product_task_scope_block_fixture'
const envelope = (data, error = null) => ({ request_id: 'task-scope-block-fixture', trace_id: 'task-scope-block-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('task creation deep link with a mismatched store is blocked before intent or write requests', async () => {
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
    throw new Error('Task store-scope fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const taskIntentRequests = []
  const taskCreationWrites = []
  const productReads = []

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
    if (method === 'POST' && path === '/v1/tasks/understand') taskIntentRequests.push(path)
    if (method === 'POST' && (path === '/v1/tasks' || path === '/v1/task-requests')) taskCreationWrites.push(path)
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/auth/session') {
      data = { account: { id: 'task-scope-block-user', login: 'task-scope-block@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (path === `/v1/products/${productId}`) {
      productReads.push({ method, workspace: request.headers()['x-workspace-id'] })
      data = { id: productId, workspaceId, platform: 'jd', accountId: 'actual-account-from-server', storeName: '服务端真实归属店铺', title: '安全范围验证商品', skuCount: 1, stock: 5, factsConfirmed: true, source: 'browser_fixture', version: 2 }
    } else if (path === '/mcp') {
      const tool = request.postDataJSON()?.method
      data = { result: tool === 'workspace.metrics'
        ? { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} }
        : tool === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/tasks/new?product_id=${productId}&platform=jd&account_id=stale-account-from-link&intent=scope-fixture-intent`, { waitUntil: 'domcontentloaded' })
    const recovery = page.getByRole('alert')
    await expect(recovery).toContainText('深链店铺账号与当前商品账号不一致，已阻止创建任务。')
    await expect(page.getByRole('button', { name: '回到知识库' })).toBeVisible()
    expect(productReads).toEqual([{ method: 'GET', workspace: workspaceId }])
    expect(taskIntentRequests).toEqual([])
    expect(taskCreationWrites).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
