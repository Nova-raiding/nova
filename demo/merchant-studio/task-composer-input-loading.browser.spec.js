import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_task_composer_input_fixture'
const productId = 'product_task_composer_input_fixture'
const envelope = (data, error = null) => ({ request_id: 'task-composer-input-fixture', trace_id: 'task-composer-input-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('task composer preserves multiline input and locks the request while analysis is pending', async () => {
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
    throw new Error('Task composer fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const understandingRequests = []
  const taskCreationWrites = []
  let announceUnderstanding
  let releaseUnderstanding
  const understandingObserved = new Promise(resolve => { announceUnderstanding = resolve })
  const understandingGate = new Promise(resolve => { releaseUnderstanding = resolve })

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
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/auth/session') {
      data = { account: { id: 'task-composer-user', login: 'task-composer@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (path === `/v1/products/${productId}` && method === 'GET') {
      data = { id: productId, workspaceId, platform: 'jd', accountId: 'store-task-composer', storeName: '任务输入验证店', title: '任务输入验证商品', skuCount: 1, stock: 5, factsConfirmed: true, source: 'browser_fixture', version: 3 }
    } else if (path === '/v1/tasks/understand' && method === 'POST') {
      const body = request.postDataJSON()
      understandingRequests.push(body)
      announceUnderstanding()
      await understandingGate
      data = {
        requestText: body.request_text,
        platformCandidates: ['jd'],
        productCandidates: [{ id: productId, title: '任务输入验证商品', platform: 'jd' }],
        extracted: { goal: '展示任务描述分析结果' },
        questions: [],
        executionPlan: { mode: 'single_task', canCreate: true, reason: '单平台、单商品', childTasks: [{ platform: 'jd', candidateProductIds: [productId], bindingState: 'ready' }] },
      }
    } else if (path === '/v1/tasks' && method === 'POST' || path === '/v1/task-requests' && method === 'POST') {
      taskCreationWrites.push(path)
    } else if (path === '/mcp') {
      const tool = request.postDataJSON()?.method
      data = { result: tool === 'workspace.metrics'
        ? { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} }
        : tool === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/tasks/new?product_id=${productId}&platform=jd&account_id=store-task-composer&intent=task-composer-fixture`, { waitUntil: 'domcontentloaded' })
    const requestInput = page.getByRole('textbox', { name: '描述你的营销任务' })
    const analyze = page.locator('.understanding-form button[type="submit"]')
    await expect(requestInput).toHaveValue('为「任务输入验证商品」准备商品详情页营销内容')
    await expect(requestInput).toBeEditable()
    await requestInput.fill('')
    await expect(analyze).toBeDisabled()

    await requestInput.fill('制作一版淘宝详情页内容')
    await requestInput.press('Shift+Enter')
    await requestInput.type('突出防晒与轻薄卖点')
    const submittedText = '制作一版淘宝详情页内容\n突出防晒与轻薄卖点'
    await expect(requestInput).toHaveValue(submittedText)
    await expect(analyze).toBeEnabled()
    expect(understandingRequests).toEqual([])

    await requestInput.press('Enter')
    await understandingObserved
    expect(understandingRequests).toEqual([{ request_text: submittedText }])
    await expect(requestInput).toHaveAttribute('readonly', '')
    await expect(analyze).toBeDisabled()
    await expect(analyze).toHaveText('分析中…')
    await expect(page.getByTestId('task-conversation').getByRole('status')).toContainText('分析任务需求中…')

    releaseUnderstanding()
    await expect(page.getByTestId('task-confirmation-card')).toContainText('下一步：确认当前商品事实后开始生成。')
    await expect(page.getByRole('button', { name: '确认需求并创建任务' })).toBeEnabled()
    expect(taskCreationWrites).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    releaseUnderstanding?.()
    await context.close()
    await browser.close()
    await vite.close()
  }
})
