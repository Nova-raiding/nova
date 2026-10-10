import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_url_direct_route_matrix_fixture'
test.setTimeout(240_000)

const envelope = (data) => ({
  request_id: 'url-direct-route-matrix-fixture',
  trace_id: 'url-direct-route-matrix-fixture',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
})

test('canonical merchant URLs render directly and preserve product section search through reload and browser back', async () => {
  // Isolated Vite on an OS-assigned loopback port. Every API request is
  // intercepted and any non-local browser request is aborted by the fixture.
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react()],
    optimizeDeps: { include: ['react', 'react-dom/client', 'antd', 'lucide-react'] },
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'),
      'import.meta.env.MODE': JSON.stringify('test'),
    },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Local Merchant Studio fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const unknownApiRequests = []
  const writeAttempts = []
  const observedRuleRequests = []
  const observedProductReads = []
  const consoleErrors = []
  const pageErrors = []
  const readOnlyMcpMethods = new Set([
    'billing.transactions',
    'canonical.product.consistency',
    'commercial.catalog.get',
    'commercial.subscription.get',
    'creative-points.balance.get',
    'creative-points.statement.list',
    'knowledge.asset.list',
    'ops.members.list',
    'ops.session',
    'platform.model.status',
    'publish.manual.list',
    'subscription.get',
    'workspace.metrics',
  ])
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== studioUrl) externalRequests.push(request.url())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  // This catch-all allows only this test's loopback Vite origin. The specific
  // /api route below is registered afterwards and handles every API request.
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== studioUrl) {
      externalRequests.push(route.request().url())
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const requestUrl = new URL(request.url())
    if (path === '/api/v1/rules') observedRuleRequests.push(requestUrl.toString())
    if (/^\/api\/v1\/products\/[^/]+$/u.test(path)) observedProductReads.push(path)
    if (path === '/api/mcp') {
      let mcpMethod = ''
      try {
        const body = request.postDataJSON()
        if (body && typeof body === 'object' && typeof body.method === 'string') mcpMethod = body.method
      } catch {
        // Malformed MCP calls are rejected by the same fail-closed gate below.
      }
      if (request.method() !== 'POST' || !readOnlyMcpMethods.has(mcpMethod)) {
        const attempt = `${request.method()} ${path}${mcpMethod ? ` method=${mcpMethod}` : ''}`
        writeAttempts.push(attempt)
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({
          request_id: 'url-direct-route-matrix-forbidden-operation',
          error: { code: 'FIXTURE_WRITE_BLOCKED', message: 'Only allowlisted read-only MCP methods are permitted by this URL fixture.' },
        }) })
      }
    } else if (request.method() !== 'GET') {
      const attempt = `${request.method()} ${path}`
      writeAttempts.push(attempt)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({
        request_id: 'url-direct-route-matrix-forbidden-operation',
        error: { code: 'FIXTURE_WRITE_BLOCKED', message: 'Only GET API requests are permitted by this URL fixture.' },
      }) })
    }
    if (path === '/api/healthz') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true },
        setup: { platformOperations: { mode: 'manual', ready: true } },
      })) })
    }
    if (path === '/api/v1/auth/session') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: {
        id: 'url-route-browser-user', login: 'route-matrix@example.invalid', accountType: 'merchant',
        status: 'active', roles: ['merchant_owner', 'merchant_admin'], workspaceIds: [workspaceId],
      } })) })
    }
    if (path === '/api/v1/auth/mcp-token') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        access_token: 'route-matrix-fixture-token', refresh_token: 'route-matrix-fixture-refresh', expires_in: 300,
      })) })
    }
    if (path === '/api/mcp') {
      const method = request.postDataJSON()?.method
      const result = method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: { approved: 0 }, riskSummary: { total: 0, returned: 0, truncated: false } }
        : method === 'subscription.get'
          ? { commercial_entitlement: { schema_version: 'commercial.entitlement.v2', status: 'unknown' }, legacy_commercial_entitlement: null }
          : method === 'creative-points.balance.get'
            ? { available_points: 0 }
            : method === 'billing.transactions'
              ? { balance_cny: '0.00', transactions: [] }
              : method === 'commercial.catalog.get'
                ? { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [] }
                : { items: [], total: 0, limit: 50, offset: 0 }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
    }
    if (path === '/api/v1/platform-accounts' || path === '/api/v1/products' || path === '/api/v1/tasks' || path === '/api/v1/assets' || path === '/api/v1/assets/trash' || path === '/api/v1/rules') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    }
    if (path === '/api/v1/image-generation-jobs' || path === '/api/v1/publish-jobs') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    }
    const publishJobMatch = /^\/api\/v1\/publish-jobs\/([^/]+)$/u.exec(path)
    if (publishJobMatch) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        id: decodeURIComponent(publishJobMatch[1]), workspaceId, taskId: 'task-route-matrix-7',
        contentVersionId: 'content-route-matrix-7', platform: 'jd', accountId: 'store-route-fixture',
        idempotencyKey: 'route-matrix-read-only', state: 'prepared', confirmationHash: 'fixture-confirmation-hash',
        remoteSnapshotHash: 'fixture-remote-snapshot-hash', createdAt: '2026-10-10T00:00:00.000Z',
      })) })
    }
    const imageJobMatch = /^\/api\/v1\/image-generation-jobs\/([^/]+)$/u.exec(path)
    if (imageJobMatch) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        job_id: decodeURIComponent(imageJobMatch[1]), revision: 1, state: 'failed', archive_state: 'not_archived',
        product_id: 'product-route-fixture', task_id: null, content_version_id: null, image_mode: 'product_main_image',
        direction: '只读路由矩阵 fixture', requested_count: 1, source_asset_ids: [], source_product_version: 1,
        intent_hash: 'route-matrix-image-job', execution_state: 'failed', provider_request_id: null,
        execution_attempt: 1, reconciliation_required: false, error_code: 'FIXTURE_NO_EXECUTION',
        error_message: '只读路由矩阵，不执行图像生成。', updated_at: '2026-10-10T00:00:00.000Z',
        created_at: '2026-10-10T00:00:00.000Z', outputs: [], next_action: { type: 'none', label: '无操作', allowed: false },
      })) })
    }
    if (/^\/api\/v1\/tasks\/[^/]+\/(content-versions|feedback)$/u.test(path)) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    }
    if (/^\/api\/v1\/tasks\/[^/]+\/(timeline|directions)$/u.test(path)) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope([])) })
    }
    if (path === '/api/v1/catalog/categories') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope([])) })
    }
    if (path === '/api/v1/delivery-readiness') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ generatedAt: '2026-10-10T00:00:00.000Z', mappingPreflights: [], bundles: [], authenticity: [] })) })
    }
    if (path === '/api/v1/brand-scopes') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        settings: { schemaVersion: 1, global: { enabled: false, values: {} }, stores: {}, series: {}, images: {} },
        revision: 0, updated_at: null, series: [], assignments: [],
      })) })
    }

    const taskMatch = /^\/api\/v1\/tasks\/([^/]+)$/u.exec(path)
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1])
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        id: taskId, workspaceId, productId: 'product-route-fixture', platform: 'jd', accountId: 'store-route-fixture',
        state: 'draft', version: 1, createdAt: '2026-10-09T00:00:00.000Z',
      })) })
    }
    const productMatch = /^\/api\/v1\/products\/([^/]+)$/u.exec(path)
    if (productMatch) {
      const productId = decodeURIComponent(productMatch[1])
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        id: productId, workspaceId, platform: 'jd', accountId: 'store-route-fixture', storeName: '路由矩阵验收店', title: '路由矩阵商品',
        skuCount: 1, stock: 3, factsConfirmed: true, source: 'browser_fixture', updatedAt: '2026-10-09T00:00:00.000Z',
      })) })
    }

    unknownApiRequests.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({
      request_id: 'url-direct-route-matrix-unknown-api',
      error: { code: 'FIXTURE_UNKNOWN_API', message: 'Unknown API is blocked by the local route fixture.' },
    }) })
  })

  try {
    const routeCases = [
      ['/merchant/overview', '/merchant/overview', '事务看板'],
      ['/merchant/products', '/merchant/products?section=knowledge', '素材库'],
      ['/merchant/products?section=products', '/merchant/products?section=products', '选择平台与店铺'],
      ['/merchant/products?section=knowledge', '/merchant/products?section=knowledge', 'main-heading'],
      ['/merchant/products?section=images', '/merchant/products?section=images', 'main-heading'],
      ['/merchant/products?section=assets', '/merchant/products?section=assets', '品牌资产'],
      ['/merchant/products?section=trash', '/merchant/products?section=trash', '回收站'],
      ['/merchant/finance', '/merchant/finance', '财务与资源'],
      ['/merchant/members', '/merchant/members', '成员与权限'],
      ['/merchant/tasks', '/merchant/tasks', '任务队列'],
      ['/merchant/tasks?publish_job_id=publish-route-matrix-7', '/merchant/tasks?publish_job_id=publish-route-matrix-7', '任务队列'],
      ['/merchant/tasks?image_job=image-route-matrix-7', '/merchant/tasks?image_job=image-route-matrix-7', '任务队列'],
      ['/merchant/tasks/new', '/merchant/tasks', '任务队列'],
      ['/merchant/tasks/task-route-matrix-7', '/merchant/tasks/task-route-matrix-7', '路由矩阵商品'],
      // `/merchant/publish` is a supported legacy deep link and currently
      // canonicalizes to the durable products workspace; publish history is
      // under `/merchant/tasks`.
      ['/merchant/publish', '/merchant/products', '素材库'],
      ['/merchant/rules', '/merchant/rules', '规则库与品类库'],
      ['/merchant/rules?product_id=product-route-fixture&platform=jd&account_id=store-route-fixture&rules_platform=jd', '/merchant/rules?product_id=product-route-fixture&platform=jd&account_id=store-route-fixture&rules_platform=jd', '规则库与品类库'],
      ['/merchant/#rules', '/merchant/rules', '规则库与品类库'],
    ]
    for (const [path, canonicalPath, heading] of routeCases) {
      await page.goto(`${studioUrl}${path}`, { waitUntil: 'domcontentloaded' })
      const renderedHeading = heading === 'main-heading'
        ? page.locator('main').getByRole('heading').first()
        : heading === '路由矩阵商品'
          ? page.locator('main').getByText(heading, { exact: false }).first()
          : page.locator('main').getByRole('heading', { name: heading }).first()
      await expect(renderedHeading, `${path} should render ${heading}; write attempts: ${JSON.stringify(writeAttempts)}; page errors: ${JSON.stringify(pageErrors)}; console errors: ${JSON.stringify(consoleErrors)}`).toBeVisible({ timeout: 15_000 })
      await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}${new URL(page.url()).hash}`).toBe(canonicalPath)
      console.log(`ROUTE_OK ${path} -> ${canonicalPath}`)
    }

    // A product-scoped task route is the actual creation entry. Loading it
    // resolves the product identity but must not create a task by itself.
    const createTaskUrl = `${studioUrl}/merchant/tasks/new?product_id=product-route-fixture&platform=jd&account_id=store-route-fixture&intent=route-matrix-task-intent`
    await page.goto(createTaskUrl, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('main').getByRole('heading', { name: '路由矩阵商品 · 京东 · 路由矩阵验收店' })).toBeVisible()
    await expect(page.getByRole('region', { name: '任务对话进度' })).toBeVisible()
    await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe('/merchant/tasks/new?product_id=product-route-fixture&platform=jd&account_id=store-route-fixture&intent=route-matrix-task-intent')
    expect(observedProductReads).toContain('/api/v1/products/product-route-fixture')
    await page.getByRole('button', { name: /所有任务/u }).click()
    await expect(page).toHaveURL(/\/merchant\/tasks$/u)
    await expect(page.locator('main').getByRole('heading', { name: '任务队列' })).toBeVisible()
    expect(writeAttempts).toEqual([])

    // The image-job route renders the real failure state and its safe recovery
    // affordance. This fixture job cannot be selected or retried.
    await page.goto(`${studioUrl}/merchant/tasks?image_job=image-route-matrix-7`, { waitUntil: 'domcontentloaded' })
    const imagePanel = page.getByRole('region', { name: '图片生成任务' })
    await expect(imagePanel.locator('.status-chip').getByText('生成失败', { exact: true })).toBeVisible()
    await expect(imagePanel.getByRole('alert')).toContainText('FIXTURE_NO_EXECUTION：只读路由矩阵，不执行图像生成。')
    await expect(imagePanel.getByText('任务 image-route-matrix-7 · 商品 product-route-fixture', { exact: false })).toBeVisible()
    await expect(imagePanel.getByRole('button', { name: '安全重试' })).toHaveCount(0)
    await expect(imagePanel.getByRole('button', { name: '刷新图片任务状态' })).toBeEnabled()
    await expect(imagePanel.getByLabel('候选选择')).toHaveCount(0)
    expect(writeAttempts).toEqual([])

    // Scoped rules are loaded from the product/store deep link. Verify that
    // query context survives a full reload and history navigation.
    const scopedRulesUrl = `${studioUrl}/merchant/rules?product_id=product-route-fixture&platform=jd&account_id=store-route-fixture&rules_platform=jd`
    await page.goto(scopedRulesUrl, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('main').getByRole('heading', { name: '规则库与品类库' })).toBeVisible()
    await expect.poll(() => observedRuleRequests.some(value => new URL(value).searchParams.get('platform') === 'jd')).toBe(true)
    await expect.poll(() => observedProductReads.filter(value => value === '/api/v1/products/product-route-fixture').length).toBeGreaterThan(1)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe('/merchant/rules?product_id=product-route-fixture&platform=jd&account_id=store-route-fixture&rules_platform=jd')
    await expect(page.locator('main').getByRole('heading', { name: '规则库与品类库' })).toBeVisible()
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '运营概览' }).click()
    await expect(page).toHaveURL(/\/merchant\/overview$/u)
    await page.goBack()
    await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe('/merchant/rules?product_id=product-route-fixture&platform=jd&account_id=store-route-fixture&rules_platform=jd')
    await expect(page.locator('main').getByRole('heading', { name: '规则库与品类库' })).toBeVisible()
    await expect.poll(() => observedRuleRequests.filter(value => new URL(value).searchParams.get('platform') === 'jd').length).toBeGreaterThan(1)

    const productSearchUrl = `${studioUrl}/merchant/products?section=products&q=${encodeURIComponent('回归路由商品')}`
    await page.goto(productSearchUrl, { waitUntil: 'domcontentloaded' })
    const globalSearch = page.getByRole('textbox', { name: '全局搜索商品' })
    await expect(globalSearch).toHaveValue('回归路由商品')
    await expect(page.getByRole('heading', { name: '选择平台与店铺' })).toBeVisible()

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect.poll(() => {
      const url = new URL(page.url())
      return { pathname: url.pathname, section: url.searchParams.get('section'), q: url.searchParams.get('q') }
    }).toEqual({ pathname: '/merchant/products', section: 'products', q: '回归路由商品' })
    await expect(page.getByRole('textbox', { name: '全局搜索商品' })).toHaveValue('回归路由商品')

    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '运营概览' }).click()
    await expect(page).toHaveURL(/\/merchant\/overview$/u)
    await expect(page.locator('main').getByRole('heading', { name: '事务看板' })).toBeVisible()
    await page.goBack()
    await expect.poll(() => {
      const url = new URL(page.url())
      return { pathname: url.pathname, section: url.searchParams.get('section'), q: url.searchParams.get('q') }
    }).toEqual({ pathname: '/merchant/products', section: 'products', q: '回归路由商品' })
    await expect(page.getByRole('textbox', { name: '全局搜索商品' })).toHaveValue('回归路由商品')

    expect(externalRequests).toEqual([])
    expect(unknownApiRequests).toEqual([])
    expect(writeAttempts).toEqual([])
    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
