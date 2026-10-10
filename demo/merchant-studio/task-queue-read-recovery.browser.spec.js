import { expect, test, chromium } from '@playwright/test'

test.setTimeout(60_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_task_queue_recovery_fixture'
const envelope = (data, error = null) => ({
  request_id: 'task-queue-recovery-fixture', trace_id: 'task-queue-recovery-fixture',
  workspace_id: workspaceId, data, warnings: [], next_actions: [], error,
})
const task = (id, productId) => ({
  id, workspaceId, productId, platform: 'taobao', accountId: 'store-task-recovery',
  state: 'draft', version: 1, createdAt: '2026-10-09T02:00:00.000Z',
})
const product = (id, title) => ({
  id, workspaceId, platform: 'taobao', accountId: 'store-task-recovery',
  storeName: '任务恢复测试店', title, skuCount: 1, stock: 10,
  factsConfirmed: true, source: 'browser_fixture', version: 1,
})

test('任务搜索读取失败时保留上次成功结果，并可重试加载新结果', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  let failSearch = false
  let allowRetry = false
  let taskReads = 0
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') data = { account: { id: 'task-queue-user', login: 'queue@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceId] } }
    else if (path === '/v1/auth/mcp-token') data = { access_token: 'task-queue-token', refresh_token: 'task-queue-refresh', expires_in: 300, workspace_id: workspaceId }
    else if (path === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (path === '/v1/tasks') {
      taskReads++
      const query = url.searchParams.get('query') ?? ''
      if (failSearch && query === 'missing' && !allowRetry) {
        await new Promise(resolve => setTimeout(resolve, 300))
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TASK_READ_UNAVAILABLE', message: '任务暂时无法读取' })) })
      }
      const rows = query === 'missing' ? [task('task-after-retry', 'product-after-retry')] : [task('task-last-good', 'product-last-good')]
      data = { items: rows, total: rows.length, limit: 12, offset: 0 }
    } else if (/^\/v1\/products\/product-(last-good|after-retry)$/u.test(path)) {
      const id = path.slice('/v1/products/'.length)
      data = product(id, id === 'product-after-retry' ? '重试后任务商品' : '上次成功任务商品')
    } else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      data = { result: method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : method === 'workspace.metrics' ? { riskItems: [] } : {} }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/tasks`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('上次成功任务商品')).toBeVisible()
    failSearch = true
    const search = page.getByRole('searchbox', { name: '搜索任务 ID、商品名称或店铺名称' })
    await search.fill('missing')
    await page.getByRole('button', { name: '搜索' }).click()
    await expect(page.getByText('正在读取新结果；当前列表为上次成功读取的任务。')).toBeVisible()
    await expect(page.getByText('上次成功任务商品')).toBeVisible()
    await expect(page.getByRole('alert')).toContainText('任务暂时无法读取')
    await expect(page.getByText('上次成功读取的任务')).toBeVisible()
    await expect(page.getByText('上次成功任务商品')).toBeVisible()
    await expect(page.getByText('没有匹配的营销任务')).toHaveCount(0)

    allowRetry = true
    await page.getByRole('button', { name: '重试' }).click()
    await expect(page.getByText('重试后任务商品')).toBeVisible()
    await expect(page.getByText('上次成功任务商品')).toHaveCount(0)
    expect(taskReads).toBeGreaterThanOrEqual(3)
    expect(pageErrors).toEqual([])
  } finally {
    await context.close()
    await browser.close()
  }
})
