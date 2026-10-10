import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_task_detail_module_filter_fixture'
const taskId = 'task_detail_module_filter_fixture'
const versionId = 'content_version_module_filter_fixture'
const envelope = data => ({ request_id: 'task-detail-module-filter', trace_id: 'task-detail-module-filter', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })
const version = {
  id: versionId, taskId, version: 4, revision: 4,
  body: {
    title: '模块筛选验收商品', detail: '顶层详情内容', sellingPoints: ['保温持久'],
    modules: [
      { key: 'material-fact', title: '面料信息', purpose: '材料说明', body: '使用棉质面料', contentKind: 'fact' },
      { key: 'campaign-creative', title: '场景表达', purpose: '生活场景', body: '适合通勤携带', contentKind: 'creative' },
      { key: 'pending-proof', title: '耐用性说明', purpose: '耐用性', body: '[待确认] 尚无耐用性检测证明', contentKind: 'pending', pendingReason: '缺少检测报告' },
    ],
  },
  factVersionIds: ['fact-v4'], ruleVersionIds: ['rule-v2'], state: 'review_required',
}

test('content detail module filters show only the selected evidence category and restore all modules', async () => {
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
    throw new Error('Task detail module filter fixture did not bind an ephemeral TCP port')
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
    let mcpMethod = ''
    if (path === '/mcp' && request.method() === 'POST') mcpMethod = request.postDataJSON()?.method ?? ''
    const allowedMcpRead = path === '/mcp' && request.method() === 'POST' && readOnlyMcpMethods.has(mcpMethod)
    if (request.method() !== 'GET' && !(path === '/v1/auth/mcp-token' && request.method() === 'POST') && !allowedMcpRead) {
      writeAttempts.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: '内容详情只读 fixture 禁止写入' })) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (path === '/v1/auth/session') data = { account: { id: 'module-filter-user', login: 'module-filter@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/v1/auth/mcp-token') data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    else if (path === `/v1/tasks/${taskId}`) data = { id: taskId, workspaceId, productId: 'product-module-filter', platform: 'jd', accountId: 'store-module-filter', state: 'draft', version: 4, createdAt: '2026-10-10T00:00:00.000Z', contentVersionId: versionId }
    else if (path === `/v1/tasks/${taskId}/content-versions`) data = { items: [version], total: 1, limit: 50, offset: 0 }
    else if (path === `/v1/tasks/${taskId}/feedback`) data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === `/v1/tasks/${taskId}/timeline`) data = []
    else if (path === `/v1/content-versions/${versionId}/review`) data = { findings: [], categories: [{ id: 'module-filter-review', name: '本地版本检查', status: 'passed', findingCount: 0, summary: '本地合成审核通过' }], blocking: false }
    else if (path === '/v1/products/product-module-filter') data = { id: 'product-module-filter', workspaceId, platform: 'jd', accountId: 'store-module-filter', storeName: '模块筛选合成店铺', title: '模块筛选验收商品', skuCount: 1, stock: 3, factsConfirmed: true, source: 'browser_fixture', version: 4, attributes: { 材质: '棉质' } }
    else if (path === '/mcp') data = { result: mcpMethod === 'workspace.metrics'
      ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
      : mcpMethod === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${origin}/merchant/tasks/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const preview = page.getByRole('region', { name: '商品详情页预览' })
    await expect(preview.getByRole('tablist', { name: '详情模块类型筛选' })).toBeVisible({ timeout: 30_000 })
    const moduleGrid = preview.locator('.detail-module-grid')
    await expect(moduleGrid.locator('article')).toHaveCount(3)
    await expect(moduleGrid).toContainText('面料信息')
    await expect(moduleGrid).toContainText('场景表达')
    await expect(moduleGrid).toContainText('耐用性说明')

    const tabs = preview.getByRole('tablist', { name: '详情模块类型筛选' })
    await tabs.getByRole('tab', { name: /创意表达/u }).click()
    await expect(preview.getByText('1 / 3 个可审阅模块')).toBeVisible()
    await expect(moduleGrid.locator('article')).toHaveCount(1)
    await expect(moduleGrid).toContainText('场景表达')
    await expect(moduleGrid).not.toContainText('面料信息')
    await expect(moduleGrid).not.toContainText('耐用性说明')

    await tabs.getByRole('tab', { name: /待确认/u }).click()
    await expect(moduleGrid.locator('article')).toHaveCount(1)
    await expect(moduleGrid).toContainText('缺少检测报告')
    await tabs.getByRole('tab', { name: /全部/u }).click()
    await expect(moduleGrid.locator('article')).toHaveCount(3)
    expect(writeAttempts).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
