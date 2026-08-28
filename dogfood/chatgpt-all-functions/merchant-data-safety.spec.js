import { expect, test } from '@playwright/test'

test.setTimeout(60_000)
test.use({ channel: 'chrome' })

const appUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18081/'
const envelope = (data, error = null) => ({
  request_id: 'merchant-data-safety-test',
  trace_id: 'merchant-data-safety-test',
  workspace_id: 'ws_demo',
  data,
  warnings: [],
  next_actions: [],
  error,
})
const fulfillJson = (route, data, status = 200, error = null) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(envelope(data, error)),
})
const product = {
  id: 'prod-safe', workspaceId: 'ws_demo', platform: 'taobao', accountId: 'store-a', storeName: '淘宝 A 店',
  title: '安全测试商品', skuCount: 1, stock: 8, factsConfirmed: true, source: 'official_api', createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
}
const sameNameProducts = [
  { ...product, id: 'prod-store-a', accountId: 'store-a', storeName: '淘宝 A 店', title: '同名双店商品' },
  { ...product, id: 'prod-store-b', accountId: 'store-b', storeName: '淘宝 B 店', title: '同名双店商品', stock: 12 },
]

test('API product failure never falls back to fixtures and retry recovers to real products', async ({ page }) => {
  let mode = 'error'
  await page.route('**/api/v1/products', route => {
    if (mode === 'error') return fulfillJson(route, null, 503, { code: 'PRODUCTS_DOWN', message: '商品服务不可用' })
    return fulfillJson(route, [product])
  })

  await page.goto(appUrl)
  await page.getByRole('button', { name: '商品与资产', exact: true }).first().click()
  const productError = page.getByRole('alert').filter({ hasText: '不会执行任何外部写入' })
  await expect(productError).toBeVisible()
  await expect(page.getByTestId('products-unavailable')).toBeVisible()
  await expect(page.getByText('轻云防晒外套 2026', { exact: true })).toHaveCount(0)
  await expect(page.locator('tbody tr')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /创建任务/ })).toHaveCount(0)

  mode = 'success'
  await productError.getByRole('button', { name: '重试' }).click()
  await expect(page.getByText('安全测试商品', { exact: true })).toBeVisible()
  await expect(page.getByText('淘宝 A 店', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /创建任务/ })).toBeEnabled()
  await expect(page.getByTestId('products-unavailable')).toHaveCount(0)
})

test('same-platform same-name selection preserves store identity through task facts and publish confirmation', async ({ page }) => {
  let createBody
  const createdTask = { id: 'task-store-b', workspaceId: 'ws_demo', productId: 'prod-store-b', platform: 'taobao', accountId: 'store-b', state: 'plan_confirmed', selectedDirectionId: 'A', version: 2, createdAt: '2026-08-28T00:00:00.000Z' }
  const approvedTask = { ...createdTask, state: 'approved', version: 3, contentVersionId: 'content-store-b' }
  const content = { id: 'content-store-b', taskId: createdTask.id, version: 1, body: { title: 'B 店已审核标题', detail: '详情', sellingPoints: ['卖点'], modules: [] }, factVersionIds: ['fact-b'], ruleVersionIds: ['rule-b'], state: 'review_required', revision: 1 }
  const approvedContent = { ...content, state: 'approved', revision: 2 }

  await page.route('**/api/v1/products', route => fulfillJson(route, sameNameProducts))
  await page.route('**/api/v1/tasks', route => {
    if (route.request().method() === 'POST') {
      createBody = route.request().postDataJSON()
      return fulfillJson(route, createdTask)
    }
    return fulfillJson(route, [])
  })
  await page.route('**/api/v1/tasks/task-store-b/content-jobs', route => fulfillJson(route, { id: 'generation-store-b', taskId: createdTask.id, state: 'succeeded', attempt: 1, contentVersionId: content.id }))
  await page.route('**/api/v1/tasks/task-store-b/content-versions', route => fulfillJson(route, [content]))
  await page.route('**/api/v1/content-versions/content-store-b/review', route => fulfillJson(route, { findings: [], categories: [], blocking: false }))
  await page.route('**/api/v1/tasks/task-store-b/approve', route => fulfillJson(route, { task: approvedTask, version: approvedContent }))
  await page.route('**/api/v1/tasks/task-store-b/publish-preview', route => fulfillJson(route, { task: approvedTask, version: approvedContent, remoteSnapshotHash: 'snapshot-store-b', confirmationHash: 'confirmation-store-b', operation: 'update', changes: ['title'], protectedFields: ['price', 'stock', 'sku'] }))

  await page.goto(appUrl)
  await page.getByRole('button', { name: '商品与资产', exact: true }).first().click()
  const storeBRow = page.locator('tbody tr').filter({ hasText: '淘宝 B 店' })
  await expect(storeBRow).toContainText('同名双店商品')
  await storeBRow.getByRole('button', { name: /创建任务/ }).click()

  await expect.poll(() => createBody).toEqual({ product_id: 'prod-store-b', platform: 'taobao', account_id: 'store-b' })
  await expect(page.locator('.task-titlebar')).toContainText('同名双店商品 · 淘宝 · 淘宝 B 店')
  await expect(page.locator('.task-titlebar')).toContainText('账号 store-b')
  await expect(page.locator('.context-product')).toContainText('淘宝 B 店 · 账号 store-b')

  await page.getByRole('button', { name: '确认制作方案并生成' }).click()
  await expect(page.getByText('B 店已审核标题', { exact: true }).first()).toBeVisible()
  const approval = page.getByLabel('我已核对事实、规则和最终内容')
  await approval.click()
  await expect(approval).toBeChecked()
  await expect(page.getByRole('button', { name: /继续确认发布/ })).toBeEnabled()
  await page.getByRole('button', { name: /继续确认发布/ }).click()
  const dialog = page.getByRole('dialog', { name: /确认更新淘宝商品/ })
  await expect(dialog).toContainText('淘宝 B 店 · 账号 store-b')
  await expect(dialog).toContainText('写入淘宝 B 店（账号 store-b）')
  await expect(dialog).not.toContainText('淘宝 A 店')
})

test('missing or changed store identity blocks same-name task creation', async ({ page }) => {
  let productMode = 'initial'
  let createRequests = 0
  const missingIdentity = { ...sameNameProducts[0], id: 'prod-missing', accountId: undefined }
  await page.route('**/api/v1/products', route => {
    if (productMode === 'initial') return fulfillJson(route, [missingIdentity, sameNameProducts[1]])
    return fulfillJson(route, [missingIdentity, { ...sameNameProducts[1], accountId: 'store-a', storeName: '淘宝 A 店' }])
  })
  await page.route('**/api/v1/tasks', route => {
    if (route.request().method() === 'POST') createRequests += 1
    return fulfillJson(route, [])
  })

  await page.goto(appUrl)
  await page.getByRole('button', { name: '商品与资产', exact: true }).first().click()
  const missingRow = page.locator('tbody tr').filter({ hasText: '缺少账号 ID' })
  await expect(missingRow.getByRole('button', { name: /创建任务/ })).toBeDisabled()

  const storeBRow = page.locator('tbody tr').filter({ hasText: '淘宝 B 店' })
  await expect(storeBRow).toBeVisible()
  productMode = 'mismatch'
  await storeBRow.getByRole('button', { name: /创建任务/ }).click()
  await expect(page.getByRole('alert').filter({ hasText: '店铺身份与最新商品事实不一致' })).toBeVisible()
  await expect.poll(() => createRequests).toBe(0)
  await expect(page.getByRole('button', { name: '进入发布', exact: true })).toBeDisabled()
})

test('task list shows loading, then a true empty state only after a successful response', async ({ page }) => {
  let release
  const responseGate = new Promise(resolve => { release = resolve })
  await page.route('**/api/v1/tasks', async route => { await responseGate; await fulfillJson(route, []) })
  await page.route('**/api/v1/products', route => fulfillJson(route, []))

  await page.goto(appUrl)
  await page.getByRole('button', { name: '营销任务', exact: true }).first().click()
  await expect(page.getByText('正在读取营销任务…', { exact: true })).toBeVisible()
  await expect(page.getByText('暂无营销任务', { exact: true })).toHaveCount(0)

  release()
  await expect(page.getByText('暂无营销任务', { exact: true })).toBeVisible()
  await expect(page.getByText('正在读取营销任务…', { exact: true })).toHaveCount(0)
})

test('task list keeps error distinct from empty and retry can recover to data', async ({ page }) => {
  let mode = 'error'
  await page.route('**/api/v1/tasks', route => {
    if (mode === 'error') return fulfillJson(route, null, 500, { code: 'TASK_LIST_FAILED', message: '任务列表读取失败' })
    return fulfillJson(route, [{ id: 'task-safe', workspaceId: 'ws_demo', productId: product.id, platform: 'taobao', accountId: 'store-a', state: 'draft', version: 1, createdAt: '2026-08-28T00:00:00.000Z' }])
  })
  await page.route('**/api/v1/products', route => fulfillJson(route, [product]))

  await page.goto(appUrl)
  await page.getByRole('button', { name: '营销任务', exact: true }).first().click()
  await expect(page.getByRole('alert').filter({ hasText: '任务列表读取失败' })).toBeVisible()
  await expect(page.getByText('暂无营销任务', { exact: true })).toHaveCount(0)
  mode = 'success'
  await page.getByRole('alert').getByRole('button', { name: '重试' }).click()
  await expect(page.getByRole('button', { name: /恢复任务/ })).toBeVisible()
  await expect(page.getByText('1 个任务', { exact: true })).toBeVisible()
})

test('publish lists show loading and never render empty while the request failed', async ({ page }) => {
  let release
  let mode = 'error'
  const responseGate = new Promise(resolve => { release = resolve })
  await page.route('**/api/v1/publish-jobs', async route => {
    if (mode === 'error') {
      await responseGate
      return fulfillJson(route, null, 500, { code: 'PUBLISH_LIST_FAILED', message: '发布任务读取失败' })
    }
    return fulfillJson(route, [])
  })

  await page.goto(appUrl)
  await page.getByRole('button', { name: '发布中心', exact: true }).first().click()
  await expect(page.getByText('正在读取发布任务…', { exact: true })).toBeVisible()
  await expect(page.getByText('暂无真实发布任务', { exact: true })).toHaveCount(0)

  release()
  await expect(page.getByRole('alert').filter({ hasText: '发布任务读取失败' })).toBeVisible()
  await expect(page.getByText('暂无真实发布任务', { exact: true })).toHaveCount(0)
  await expect(page.getByText('暂无回执', { exact: true })).toHaveCount(0)

  mode = 'empty'
  await page.getByRole('alert').getByRole('button', { name: '重试' }).click()
  await expect(page.getByText('暂无真实发布任务', { exact: true })).toBeVisible()
  await expect(page.getByText('暂无回执', { exact: true })).toBeVisible()
})

test('publish list renders successful jobs after loading', async ({ page }) => {
  await page.route('**/api/v1/publish-jobs', route => fulfillJson(route, [{
    id: 'publish-safe', workspaceId: 'ws_demo', taskId: 'task-safe', contentVersionId: 'content-safe', platform: 'taobao',
    idempotencyKey: 'safe', state: 'published', confirmationHash: 'confirm', remoteSnapshotHash: 'snapshot', remoteState: 'ONLINE', createdAt: '2026-08-28T00:00:00.000Z',
  }]))

  await page.goto(appUrl)
  await page.getByRole('button', { name: '发布中心', exact: true }).first().click()
  await expect(page.getByText('淘宝 · 发布任务', { exact: true })).toBeVisible()
  await expect(page.getByText('淘宝 · 已生效', { exact: true })).toBeVisible()
  await expect(page.getByText('暂无真实发布任务', { exact: true })).toHaveCount(0)
})

test('both sync-all entry points target every readable store including same-platform stores', async ({ page }) => {
  const syncRequests = []
  const accounts = [
    { platform: 'taobao', accountId: 'store-a', label: '淘宝 A 店', state: 'connected', readEnabled: true, writeEnabled: true },
    { platform: 'taobao', accountId: 'store-b', label: '淘宝 B 店', state: 'connected', readEnabled: true, writeEnabled: true },
    { platform: 'jd', accountId: 'store-c', label: '京东 C 店', state: 'connected', readEnabled: true, writeEnabled: true },
  ]
  await page.route('**/api/v1/platform-accounts', route => fulfillJson(route, { items: accounts }))
  await page.route('**/api/v1/products', route => fulfillJson(route, []))
  await page.route('**/api/v1/platform-accounts/*/sync', async route => {
    syncRequests.push({ url: route.request().url(), body: route.request().postDataJSON(), accountHeader: await route.request().headerValue('x-account-id') })
    await fulfillJson(route, { platform: 'taobao', source: 'official_api', simulated: false, items: [] })
  })

  await page.goto(appUrl)
  const overviewSyncButton = page.getByRole('button', { name: '同步全部店铺', exact: true })
  await expect(overviewSyncButton).toBeEnabled()
  await overviewSyncButton.click()
  await expect.poll(() => syncRequests.length).toBe(3)
  expect(syncRequests.map(item => item.body.account_id).sort()).toEqual(['store-a', 'store-b', 'store-c'])
  syncRequests.length = 0

  await page.getByRole('button', { name: '商品与资产', exact: true }).first().click()
  await expect(page.getByText(/已发现 3 家可同步店铺/)).toBeVisible()
  const syncButton = page.getByRole('button', { name: '同步全部店铺', exact: true })
  await expect(syncButton).toBeEnabled()
  await syncButton.click()
  await expect.poll(() => syncRequests.length).toBe(3)

  expect(syncRequests.map(item => item.body.account_id).sort()).toEqual(['store-a', 'store-b', 'store-c'])
  expect(syncRequests.map(item => item.accountHeader).sort()).toEqual(['store-a', 'store-b', 'store-c'])
  expect(syncRequests.filter(item => item.url.includes('/taobao/')).length).toBe(2)
})

test('store discovery failure disables sync and sends no sync request', async ({ page }) => {
  let syncRequests = 0
  await page.route('**/api/v1/platform-accounts', route => fulfillJson(route, null, 503, { code: 'STORE_DISCOVERY_FAILED', message: '店铺服务不可用' }))
  await page.route('**/api/v1/products', route => fulfillJson(route, []))
  await page.route('**/api/v1/platform-accounts/*/sync', route => { syncRequests += 1; return fulfillJson(route, {}) })

  await page.goto(appUrl)
  await expect(page.getByRole('alert').filter({ hasText: '店铺发现失败' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '同步全部店铺', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '商品与资产', exact: true }).first().click()
  await expect(page.getByRole('alert').filter({ hasText: '店铺发现失败' })).toBeVisible()
  await expect(page.getByRole('button', { name: '同步全部店铺', exact: true })).toBeDisabled()
  await expect.poll(() => syncRequests).toBe(0)
})
