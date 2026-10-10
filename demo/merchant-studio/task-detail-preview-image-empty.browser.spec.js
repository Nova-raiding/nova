import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_task_preview_empty_fixture'
const taskId = 'task_preview_empty_fixture'
const versionId = 'content_version_preview_empty_fixture'
const envelope = data => ({ request_id: 'task-preview-image-empty', trace_id: 'task-preview-image-empty', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })
const version = { id: versionId, taskId, version: 1, revision: 1, body: { title: '空图片状态验收商品', detail: '合成内容详情', sellingPoints: ['有来源的合成卖点'] }, factVersionIds: ['fact-v1'], ruleVersionIds: ['rule-v1'], state: 'review_required' }

test('task detail preview explains an unbound image without rendering an invalid asset URL', async () => {
  test.setTimeout(90_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Task preview empty-state fixture did not bind an ephemeral TCP port')
  }
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const writeAttempts = []
  const readOnlyMcpMethods = new Set(['billing.transactions', 'canonical.product.consistency', 'commercial.catalog.get', 'commercial.subscription.get', 'creative-points.balance.get', 'creative-points.statement.list', 'platform.model.status', 'subscription.get', 'workspace.metrics'])

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== origin) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    let method = ''
    if (path === '/mcp' && request.method() === 'POST') method = request.postDataJSON()?.method ?? ''
    const allowedMcpRead = path === '/mcp' && request.method() === 'POST' && readOnlyMcpMethods.has(method)
    if (request.method() !== 'GET' && !(path === '/v1/auth/mcp-token' && request.method() === 'POST') && !allowedMcpRead) {
      writeAttempts.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: '商品预览只读 fixture 禁止写入' })) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (path === '/v1/auth/session') data = { account: { id: 'preview-reader', login: 'preview@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/v1/auth/mcp-token') data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    else if (path === `/v1/tasks/${taskId}`) data = { id: taskId, workspaceId, productId: 'product-preview-empty', platform: 'jd', accountId: 'store-preview-empty', state: 'draft', version: 1, createdAt: '2026-10-10T00:00:00.000Z', contentVersionId: versionId }
    else if (path === `/v1/tasks/${taskId}/content-versions`) data = { items: [version], total: 1, limit: 50, offset: 0 }
    else if (path === `/v1/tasks/${taskId}/feedback`) data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === `/v1/tasks/${taskId}/timeline`) data = []
    else if (path === `/v1/content-versions/${versionId}/review`) data = { findings: [], categories: [{ id: 'preview-empty-review', name: '本地检查', status: 'passed', findingCount: 0, summary: '本地合成检查通过' }], blocking: false }
    else if (path === '/v1/products/product-preview-empty') data = { id: 'product-preview-empty', workspaceId, platform: 'jd', accountId: 'store-preview-empty', storeName: '预览空态合成店铺', title: '空图片状态验收商品', category: '日用', stock: 5, skuCount: 0, factsConfirmed: true, source: 'browser_fixture', version: 1, images: ['asset://not-a-browser-image'] }
    else if (path === '/mcp') data = { result: method === 'workspace.metrics'
      ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
      : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${origin}/merchant/tasks/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const preview = page.getByRole('region', { name: '商品详情页预览' })
    await expect(preview.getByText('尚未绑定商品图片')).toBeVisible({ timeout: 30_000 })
    await expect(preview.locator('.gallery-main img')).toHaveCount(0)
    await expect(preview).toContainText('空图片状态验收商品')
    await expect(preview).toContainText('发布前需人工审核')
    expect(writeAttempts).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
