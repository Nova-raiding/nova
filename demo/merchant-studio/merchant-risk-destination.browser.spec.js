import { expect, test, chromium } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4179'
const envelope = (data) => ({
  request_id: 'merchant-risk-browser',
  trace_id: 'merchant-risk-browser',
  workspace_id: 'ws_browser',
  data,
  warnings: [],
  next_actions: [],
  error: null,
})

const task = {
  id: 'task-risk-42',
  workspaceId: 'ws_browser',
  productId: 'product-risk-42',
  platform: 'jd',
  accountId: 'jd-store-42',
  state: 'draft',
  version: 1,
  createdAt: '2026-10-09T02:00:00.000Z',
}

const product = {
  id: 'product-risk-42',
  workspaceId: 'ws_browser',
  platform: 'jd',
  accountId: 'jd-store-42',
  storeName: '贵人鸟官方旗舰店',
  title: '测试商品-风险跳转',
  skuCount: 1,
  stock: 3,
  factsConfirmed: true,
  source: 'browser_fixture',
  updatedAt: '2026-10-09T02:00:00.000Z',
}

// These rows model products imported into the workspace and bound to a
// manually registered JD store. They are intentionally not platform reads.
const jdWorkspaceProducts = [product, ...['补充商品一', '补充商品二'].map((title, index) => ({
  ...product,
  id: `product-risk-imported-${index + 1}`,
  title,
}))]

async function openOverview(issue) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const apiCalls = []

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname.replace(/^\/api/u, '')
    apiCalls.push({ pathname, method: route.request().method() })
    let data
    if (pathname === '/v1/auth/session') {
      data = { account: { id: 'merchant_browser', login: 'demo@ys.com', accountType: 'merchant', displayName: '商家浏览器验收', status: 'active', workspaceIds: ['ws_browser'] } }
    } else if (pathname === '/v1/auth/mcp-token') {
      data = { access_token: 'risk-browser-fixture', refresh_token: 'risk-browser-fixture-refresh', expires_in: 300 }
    } else if (pathname === '/healthz') {
      // This spec stubs every API response. Report the persistence source as a
      // fixture so the browser flow cannot be mistaken for a database check.
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (pathname === '/v1/platform-accounts') {
      data = { items: [{ platform: 'jd', state: 'manually_registered', readEnabled: false, writeEnabled: false, dataMode: 'manual_upload', accountId: 'jd-store-42', storeName: '贵人鸟官方旗舰店' }] }
    } else if (pathname === '/v1/products') {
      data = { items: jdWorkspaceProducts, total: jdWorkspaceProducts.length, limit: 50, offset: 0 }
    } else if (pathname === '/v1/tasks/task-risk-42') {
      data = task
    } else if (pathname === '/v1/products/product-risk-42') {
      data = product
    } else if (pathname === '/v1/tasks/task-risk-42/timeline' || pathname === '/v1/tasks/task-risk-42/directions' || pathname === '/v1/tasks/task-risk-42/feedback') {
      data = []
    } else if (pathname === '/mcp') {
      const method = route.request().postDataJSON()?.method
      data = { result: method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 1, lowStock: 1, missingImages: 0 }, riskItems: [issue], taskFunnel: { approved: 0 }, riskSummary: { total: 1, returned: 1, truncated: false } }
        : {} }
    } else {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  await page.goto(new URL('/merchant/overview', studioUrl).href, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: '事务看板' })).toBeVisible()
  await expect(page.getByRole('button', { name: issue.type === 'AUTH_RECONNECT' ? /店铺接入方式待核实/u : issue.title })).toBeVisible()
  return { browser, context, page, apiCalls }
}

test('overview product risk restores its platform, store, product, and search context', async () => {
  const issue = { severity: 'high', type: 'LOW_STOCK', title: '测试商品-风险跳转', entityType: 'product', entityId: 'product-risk-42', platform: 'jd', accountId: 'jd-store-42', storeName: '贵人鸟官方旗舰店', nextAction: '查看商品库存' }
  const { browser, context, page, apiCalls } = await openOverview(issue)
  try {
    await page.getByRole('button', { name: /测试商品-风险跳转/ }).click()
    await expect.poll(() => {
      const url = new URL(page.url())
      return {
        pathname: url.pathname,
        section: url.searchParams.get('section'),
        query: url.searchParams.get('q'),
        platform: url.searchParams.get('platform'),
        accountId: url.searchParams.get('account_id'),
        productId: url.searchParams.get('product_id'),
      }
    }).toEqual({
      pathname: '/merchant/products', section: 'products', query: '测试商品-风险跳转',
      platform: 'jd', accountId: 'jd-store-42', productId: 'product-risk-42',
    })
    await expect(page.getByRole('heading', { name: '平台&店铺&商品' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '测试商品-风险跳转' })).toBeVisible()
    await expect(page.getByText('京东', { exact: true })).toBeVisible()
    await expect(page.getByText('贵人鸟官方旗舰店', { exact: true })).toBeVisible()
    await expect(page.getByText('当前商品属于人工登记、未授权的店铺，只能读取工作区导入资料；这不代表平台同步或授权。')).toBeVisible()
    await expect(page.getByTestId('catalog-generate-image')).toBeVisible()
    await expect.poll(() => apiCalls.some((call) => call.pathname === '/v1/products')).toBe(true)
  } finally {
    await context.close()
    await browser.close()
  }
})

test('manual authorization risk opens honest store guidance and the existing support-message entry', async () => {
  const issue = {
    severity: 'high', type: 'AUTH_RECONNECT', title: '店铺授权需重新连接', entityType: 'platform_account',
    entityId: 'jd-store-42', platform: 'jd', accountId: 'jd-store-42', storeName: '贵人鸟官方旗舰店',
    nextAction: '在交互会话中重新发起官方授权',
  }
  const { browser, context, page, apiCalls } = await openOverview(issue)
  try {
    const authIssue = page.getByRole('button', { name: /店铺接入方式待核实/u })
    await expect(authIssue).toContainText('当前为人工登记且未授权')
    await expect(authIssue).not.toContainText('重新发起官方授权')
    await authIssue.click()
    await expect.poll(() => {
      const url = new URL(page.url())
      return {
        pathname: url.pathname,
        section: url.searchParams.get('section'),
        platform: url.searchParams.get('platform'),
        accountId: url.searchParams.get('account_id'),
        intent: url.searchParams.get('intent'),
      }
    }).toEqual({ pathname: '/merchant/products', section: 'products', platform: 'jd', accountId: 'jd-store-42', intent: 'authorization' })
    await expect(page.getByTestId('store-authorization-guidance')).toContainText('此页面不会发起授权')
    await expect(page.getByTestId('store-authorization-guidance')).toContainText('请联系客户经理确认平台接入方式')
    const callsBeforeSupport = apiCalls.length
    await page.getByRole('button', { name: '查看客服支持消息' }).click()
    await expect(page.getByRole('heading', { name: '支持消息' })).toBeVisible()
    expect(apiCalls).toHaveLength(callsBeforeSupport)
    await expect.poll(() => apiCalls.some((call) => call.pathname.includes('/authorization'))).toBe(false)
  } finally {
    await context.close()
    await browser.close()
  }
})

test('overview task risk restores the linked task and product context', async () => {
  const issue = { severity: 'high', type: 'CONTENT_BLOCKING', title: '测试任务风险', entityType: 'content_version', entityId: 'version-risk-42', evidence: { taskId: 'task-risk-42' }, nextAction: '查看任务审核' }
  const { browser, context, page, apiCalls } = await openOverview(issue)
  try {
    await page.getByRole('button', { name: /测试任务风险/ }).click()
    await expect(page).toHaveURL(/\/merchant\/tasks\/task-risk-42$/u)
    await expect.poll(() => apiCalls.some((call) => call.pathname === '/v1/tasks/task-risk-42')).toBe(true)
    await expect(page.getByTestId('task-conversation')).toBeVisible()
    await expect(page.getByTestId('task-conversation')).toContainText('测试商品-风险跳转')
    await expect(page.getByTestId('route-recovery-error')).toHaveCount(0)
  } finally {
    await context.close()
    await browser.close()
  }
})

test('overview risk with an unknown entity type stays on the overview', async () => {
  const issue = { severity: 'high', type: 'LOW_STOCK', title: '未来实体风险', entityType: 'future_catalog_entity', entityId: 'unknown-42', nextAction: '人工核查风险归属' }
  const { browser, context, page } = await openOverview(issue)
  try {
    await page.getByRole('button', { name: /未来实体风险/ }).click()
    await expect(page).toHaveURL(/\/merchant\/overview$/u)
    await expect(page.getByRole('heading', { name: '事务看板' })).toBeVisible()
    await expect(page.getByRole('button', { name: /未来实体风险/ })).toBeVisible()
  } finally {
    await context.close()
    await browser.close()
  }
})
