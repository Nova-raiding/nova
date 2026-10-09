import { expect, test, chromium } from '@playwright/test'

test.setTimeout(60_000)

const studioUrl = 'http://127.0.0.1:4189'
const workspaceId = 'ws_task_queue_split_fixture'
const products = [
  { id: 'product-taobao', workspaceId, platform: 'taobao', accountId: 'store-taobao', storeName: '淘宝隔离测试店', title: '队列测试防晒衣', skuCount: 2, stock: 12, factsConfirmed: true, source: 'official_api', version: 1 },
  { id: 'product-jd', workspaceId, platform: 'jd', accountId: 'store-jd', storeName: '京东隔离测试店', title: '队列测试防晒衣', skuCount: 2, stock: 12, factsConfirmed: true, source: 'official_api', version: 1 },
]

const envelope = (data, error = null) => ({
  request_id: 'task-queue-split-browser-fixture',
  trace_id: 'task-queue-split-browser-fixture',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error,
})

const task = ({ id, productId = products[0].id, platform = 'taobao', skuId }) => ({
  id,
  workspaceId,
  productId,
  platform,
  accountId: platform === 'jd' ? 'store-jd' : 'store-taobao',
  state: 'queued',
  version: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...(skuId ? { answers: { sku_id: skuId } } : {}),
})

const understandingFor = (mode) => {
  const childTasks = mode === 'split_by_platform'
    ? [
        { platform: 'taobao', candidateProductIds: ['product-taobao'], bindingState: 'ready' },
        { platform: 'jd', candidateProductIds: ['product-jd'], bindingState: 'ready' },
      ]
    : [{ platform: 'taobao', candidateProductIds: ['product-taobao'], bindingState: 'ready', skuIds: ['sku-red', 'sku-blue'] }]
  return {
    requestText: mode === 'split_by_platform' ? '分别为淘宝和京东准备商品营销内容' : '为两个 SKU 分别准备商品营销内容',
    platformCandidates: mode === 'split_by_platform' ? ['taobao', 'jd'] : ['taobao'],
    productCandidates: products.map(({ id, title, platform }) => ({ id, title, platform })),
    extracted: { goal: '商品营销内容' },
    questions: [],
    executionPlan: { mode, canCreate: true, reason: '夹具确认目标范围', childTasks },
  }
}

async function openApp(path, { mode = 'split_by_platform', creationStatus = 202, holdProductRestore = false } = {}) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  const apiCalls = []
  const taskPageQueries = []
  const taskRequestBodies = []
  const unmockedApiCalls = []
  const unexpectedNetworkRequests = []
  let productFetchCount = 0
  let releaseProductRestore = () => {}
  let markProductRestorePending = () => {}
  const productRestorePending = new Promise((resolve) => { markProductRestorePending = resolve })

  // Route every versioned API request in the browser fixture. Requests without
  // a deliberate response fail closed instead of reaching a real API service.
  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url())
    const apiPath = requestUrl.pathname.replace(/^\/api(?=\/(?:v1\/|healthz$|mcp$))/u, '')
    const isApiRequest = apiPath.startsWith('/v1/') || apiPath.startsWith('/api/') || apiPath === '/healthz' || apiPath === '/mcp'
    if (!isApiRequest) {
      if (requestUrl.origin === studioUrl && route.request().method() === 'GET') return route.continue()
      unexpectedNetworkRequests.push({ method: route.request().method(), url: requestUrl.href })
      return route.abort()
    }
    apiCalls.push({ method: route.request().method(), path: apiPath })

    const json = (data, status = 200, error = null) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(envelope(data, error)),
    })

    if (apiPath === '/healthz') return json({ status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true } })
    if (apiPath === '/v1/auth/session') return json({ account: { id: 'fixture-merchant', login: 'task-queue@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })
    if (apiPath === '/v1/auth/mcp-token') return json({ access_token: 'fixture-token', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600, workspace_id: workspaceId, account_login: 'task-queue@example.invalid' })
    if (apiPath === '/mcp') return json({ result: { state: 'ready', capabilities: {} } })
    if (apiPath === '/v1/platform-accounts' || apiPath.startsWith('/v1/platform-accounts?')) return json({ items: products.map((product) => ({ platform: product.platform, state: 'connected', readEnabled: true, writeEnabled: true, accountId: product.accountId, storeName: product.storeName, label: product.storeName })) })
    if (apiPath === '/v1/products' || apiPath.startsWith('/v1/products?')) return json({ items: products, total: products.length, limit: 50, offset: 0 })
    const productMatch = apiPath.match(/^\/v1\/products\/([^/]+)$/u)
    if (productMatch) {
      productFetchCount += 1
      if (holdProductRestore && productFetchCount === 2) {
        markProductRestorePending()
        await new Promise((resolve) => { releaseProductRestore = resolve })
      }
      const product = products.find((item) => item.id === decodeURIComponent(productMatch[1]))
      return product ? json(product) : json(null, 404, { code: 'NOT_FOUND', message: 'Fixture product not found' })
    }
    if (apiPath === '/v1/tasks/understand') return json(understandingFor(mode))
    if (apiPath === '/v1/task-requests') {
      taskRequestBodies.push(route.request().postDataJSON())
      if (creationStatus === 409) return json(null, 409, { code: 'TASK_REQUEST_SCOPE_CHANGED', message: '商品或 SKU 范围与已确认的执行计划不一致；任务未创建，请重新分析并确认范围' })
      const tasks = mode === 'split_by_platform'
        ? [task({ id: 'task-taobao', productId: 'product-taobao', platform: 'taobao' }), task({ id: 'task-jd', productId: 'product-jd', platform: 'jd' })]
        : [task({ id: 'task-sku-red', skuId: 'sku-red' }), task({ id: 'task-sku-blue', skuId: 'sku-blue' })]
      return json({ understanding: understandingFor(mode), mode, taskGroupId: 'group-fixture-1', taskIds: tasks.map((item) => item.id), tasks, replayed: false })
    }
    if (apiPath === '/v1/publish-jobs' || apiPath.startsWith('/v1/publish-jobs?')) return json({ items: [], total: 0, limit: 20, offset: 0 })
    if (apiPath === '/v1/image-generation-jobs') return json({ items: [], total: 0, limit: 50, offset: 0 })
    if (apiPath === '/v1/tasks' || apiPath.startsWith('/v1/tasks?')) {
      const query = requestUrl.searchParams.get('query') ?? ''
      const limit = Number(requestUrl.searchParams.get('limit') ?? '50')
      const offset = Number(requestUrl.searchParams.get('offset') ?? '0')
      taskPageQueries.push({ query, limit, offset })
      const allTasks = Array.from({ length: 130 }, (_, index) => task({ id: `task-${String(index + 1).padStart(3, '0')}` }))
      const filtered = query ? allTasks.filter((item) => item.id.includes(query)) : allTasks
      const items = filtered.slice(offset, offset + limit)
      return json({ items, total: filtered.length, limit, offset })
    }
    const taskMatch = apiPath.match(/^\/v1\/tasks\/([^/]+)$/u)
    if (taskMatch) return json(task({ id: decodeURIComponent(taskMatch[1]) }))
    if (apiPath.startsWith('/v1/workspaces/')) return json({ items: [] })
    unmockedApiCalls.push({ method: route.request().method(), path: apiPath })
    return json(null, 501, { code: 'UNMOCKED_FIXTURE_API', message: `Unmocked fixture API request: ${apiPath}` })
  })

  await page.goto(`${studioUrl}${path}`, { waitUntil: 'domcontentloaded' })
  return { browser, context, page, apiCalls, taskPageQueries, taskRequestBodies, unmockedApiCalls, unexpectedNetworkRequests, waitForProductRestore: () => productRestorePending, releaseProductRestore: () => releaseProductRestore() }
}


test('task composer stays read-only until the selected product identity is confirmed', async () => {
  const { browser, context, page, unmockedApiCalls, unexpectedNetworkRequests, waitForProductRestore, releaseProductRestore } = await openApp('/merchant/tasks/new?product_id=product-taobao&platform=taobao&account_id=store-taobao', { holdProductRestore: true })
  try {
    await waitForProductRestore()
    const requestText = page.getByRole('textbox', { name: '描述你的营销任务' })
    await expect(requestText).toBeVisible()
    await expect(requestText).toHaveAttribute('readonly', '')
    await expect(page.getByRole('button', { name: '分析需求' })).toBeDisabled()
    releaseProductRestore()
    await expect(requestText).toHaveValue('为「队列测试防晒衣」准备商品详情页营销内容')
    await expect(requestText).not.toHaveAttribute('readonly', '')
    await expect(page.getByRole('button', { name: '分析需求' })).toBeEnabled()
    expect(unmockedApiCalls).toEqual([])
    expect(unexpectedNetworkRequests).toEqual([])
  } finally {
    releaseProductRestore()
    await context.close()
    await browser.close()
  }
})

for (const mode of ['split_by_platform', 'split_by_sku']) {
  test(`creates a ${mode} group and links only to returned child tasks`, async () => {
    const { browser, context, page, apiCalls, taskRequestBodies, unmockedApiCalls, unexpectedNetworkRequests } = await openApp('/merchant/tasks/new?product_id=product-taobao&platform=taobao&account_id=store-taobao', { mode })
    try {
      const requestText = page.getByRole('textbox', { name: '描述你的营销任务' })
      await expect(requestText).toHaveValue('为「队列测试防晒衣」准备商品详情页营销内容')
      await requestText.fill(understandingFor(mode).requestText)
      await requestText.press('Enter')
      await expect(page.getByTestId('task-execution-plan')).toContainText(mode === 'split_by_platform' ? '将拆成 2 个独立平台子任务' : '将拆成 2 个独立 SKU 子任务')
      await page.getByRole('button', { name: '确认需求并创建任务' }).click()

      const group = page.getByTestId('task-group-created')
      await expect(group).toBeVisible()
      await expect(group).toContainText('任务组：group-fixture-1')
      const links = group.getByRole('link')
      await expect(links).toHaveCount(2)
      const expectedChildIds = mode === 'split_by_platform' ? ['task-taobao', 'task-jd'] : ['task-sku-red', 'task-sku-blue']
      await expect(links.nth(0)).toHaveAttribute('href', `/merchant/tasks/${expectedChildIds[0]}`)
      await expect(links.nth(1)).toHaveAttribute('href', `/merchant/tasks/${expectedChildIds[1]}`)
      expect(taskRequestBodies).toHaveLength(1)
      expect(taskRequestBodies[0]?.expected_scopes).toHaveLength(mode === 'split_by_platform' ? 2 : 1)
      if (mode === 'split_by_sku') expect(taskRequestBodies[0]?.expected_scopes[0]?.sku_ids).toEqual(['sku-red', 'sku-blue'])
      expect(apiCalls.some((call) => call.path === '/v1/task-requests' && call.method === 'POST')).toBe(true)
      expect(apiCalls.every((call) => call.path.startsWith('/v1/') || call.path === '/mcp' || call.path === '/healthz')).toBe(true)
      expect(unmockedApiCalls).toEqual([])
      expect(unexpectedNetworkRequests).toEqual([])
    } finally {
      await context.close()
      await browser.close()
    }
  })
}

test('queue search resets the page, applies the query, and clear returns to page one', async () => {
  const { browser, context, page, taskPageQueries, apiCalls, unmockedApiCalls, unexpectedNetworkRequests } = await openApp('/merchant/tasks')
  try {
    await expect.poll(() => taskPageQueries.at(-1)).toMatchObject({ query: '', offset: 0 })
    const pagination = page.locator('.task-list-panel .task-list-pagination')
    await expect(pagination).toContainText('第 1 / 3 页')
    await pagination.getByRole('button', { name: '下一页' }).click()
    await expect.poll(() => taskPageQueries.at(-1)).toMatchObject({ query: '', offset: 50 })
    await expect(pagination).toContainText('第 2 / 3 页')
    await pagination.getByRole('button', { name: '下一页' }).click()
    await expect.poll(() => taskPageQueries.at(-1)).toMatchObject({ query: '', offset: 100 })
    await expect(pagination).toContainText('第 3 / 3 页')

    const search = page.getByRole('search', { name: '搜索任务队列' })
    await search.getByRole('searchbox').fill('task-001')
    await search.getByRole('button', { name: '搜索' }).click()
    await expect(pagination).toContainText('第 1 / 1 页')
    await expect.poll(() => taskPageQueries.at(-1)).toMatchObject({ query: 'task-001', offset: 0 })
    await expect(page.getByText('1 个匹配任务', { exact: true })).toBeVisible()
    await expect(page.getByText(/队列测试防晒衣/u).first()).toBeVisible()

    await search.getByRole('button', { name: '清除搜索' }).click()
    await expect(pagination).toContainText('第 1 / 3 页')
    await expect.poll(() => taskPageQueries.at(-1)).toMatchObject({ query: '', offset: 0 })
    expect(apiCalls.some((call) => call.path === '/v1/tasks')).toBe(true)
    expect(unmockedApiCalls).toEqual([])
    expect(unexpectedNetworkRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
  }
})

test('a scope-changed 409 leaves task creation blocked and exposes no child task links', async () => {
  const { browser, context, page, taskRequestBodies, apiCalls, unmockedApiCalls, unexpectedNetworkRequests } = await openApp('/merchant/tasks/new?product_id=product-taobao&platform=taobao&account_id=store-taobao', { mode: 'split_by_platform', creationStatus: 409 })
  try {
    const requestText = page.getByRole('textbox', { name: '描述你的营销任务' })
    await expect(requestText).toHaveValue('为「队列测试防晒衣」准备商品详情页营销内容')
    await requestText.fill(understandingFor('split_by_platform').requestText)
    await requestText.press('Enter')
    await expect(page.getByTestId('task-execution-plan')).toContainText('将拆成 2 个独立平台子任务')
    await page.getByRole('button', { name: '确认需求并创建任务' }).click()

    await expect(page.getByTestId('task-scope-changed-recovery')).toContainText('商品或 SKU 范围与已确认的执行计划不一致')
    await expect(page.getByRole('button', { name: '重新分析当前需求' })).toBeVisible()
    await expect(page.getByRole('button', { name: '使用同一请求重试' })).toHaveCount(0)
    await expect(page.getByRole('alert')).toContainText('商品或 SKU 范围与已确认的执行计划不一致；任务未创建，请重新分析并确认范围')
    await expect(page.getByTestId('task-group-created')).toHaveCount(0)
    await expect(page.getByRole('link', { name: /任务 task-(taobao|jd)/u })).toHaveCount(0)
    expect(taskRequestBodies).toHaveLength(1)
    expect(apiCalls.filter((call) => call.path === '/v1/task-requests' && call.method === 'POST')).toHaveLength(1)
    expect(unmockedApiCalls).toEqual([])
    expect(unexpectedNetworkRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
  }
})
