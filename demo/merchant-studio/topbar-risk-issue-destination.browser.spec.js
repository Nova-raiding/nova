import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_topbar_issue_destination'
const accountId = 'jd-risk-store-17'
const productId = 'product-risk-destination-17'
const productTitle = '风险铃铛商品上下文验收'
const issue = { severity: 'high', type: 'LOW_STOCK', title: productTitle, entityType: 'product', entityId: productId, platform: 'jd', accountId, storeName: '京东风险验收店', status: 'open', nextAction: '查看商品库存' }
const product = { id: productId, workspaceId, platform: 'jd', accountId, storeName: '京东风险验收店', title: productTitle, skuCount: 1, stock: 2, factsConfirmed: true, source: 'manual_import', createdAt: '2026-10-10T08:00:00.000Z', updatedAt: '2026-10-10T08:00:00.000Z', version: 1 }
const envelope = (data, error = null) => ({ request_id: 'topbar-risk-destination', trace_id: 'topbar-risk-destination', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('topbar risk item opens its product with platform, store, and search context', async () => {
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
    throw new Error('Topbar risk destination fixture failed to bind an ephemeral port')
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const apiCalls = []

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== `http://127.0.0.1:${address.port}`) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const request = route.request()
    const path = new URL(request.url()).pathname
    apiCalls.push({ path, method: request.method() })
    if (path === '/api/v1/auth/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: { id: 'risk-reader-17', login: 'risk-reader@example.invalid', accountType: 'merchant', displayName: '风险通知验收', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })) })
    if (path === '/api/v1/auth/mcp-token') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ access_token: 'topbar-risk-token', refresh_token: 'topbar-risk-refresh', expires_in: 300, workspace_id: workspaceId })) })
    if (path === '/api/healthz') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } })) })
    if (path === '/api/v1/platform-accounts') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [{ platform: 'jd', state: 'manually_registered', readEnabled: false, writeEnabled: false, dataMode: 'manual_upload', accountId, storeName: '京东风险验收店' }] })) })
    if (path === '/api/v1/products') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [product], total: 1, limit: 50, offset: 0 })) })
    if (path === `/api/v1/products/${productId}`) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(product)) })
    if (path === '/api/mcp') {
      const method = request.postDataJSON()?.method
      const result = method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 1, lowStock: 1, missingImages: 0 }, riskItems: [issue], taskFunnel: {}, riskSummary: { total: 1, returned: 1, truncated: false } }
        : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {}
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
    }
    if (request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: `Blocked ${request.method()} ${path}` })) })
  })

  try {
    await page.goto(`http://127.0.0.1:${address.port}/merchant/overview`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const bell = page.getByRole('button', { name: /工作区待处理问题/u })
    await expect(bell).toBeVisible()
    await expect(bell).toHaveAccessibleName(/1 项/u)
    await bell.click()
    const panel = page.getByRole('region', { name: '待处理问题' })
    await expect(panel.getByText(productTitle)).toBeVisible()
    await panel.getByRole('button', { name: `查看问题：${productTitle}` }).click()
    const detail = page.getByRole('dialog', { name: '问题详情' })
    await expect(detail).toBeVisible()
    await detail.getByRole('button', { name: '查看并处理' }).click()

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
    }).toEqual({ pathname: '/merchant/products', section: 'products', query: productTitle, platform: 'jd', accountId, productId })
    await expect(detail).toHaveCount(0)
    await expect(page.getByRole('heading', { name: productTitle })).toBeVisible()
    await expect(page.getByText('京东风险验收店', { exact: true })).toBeVisible()
    expect(apiCalls.some(call => call.path === '/api/v1/products')).toBe(true)
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
