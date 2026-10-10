import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_task_history_empty_fixture'
const taskId = 'task_history_empty_fixture'
const versionId = 'content_version_history_empty'
const envelope = data => ({ request_id: 'task-history-empty', trace_id: 'task-history-empty', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('task history shows an explicit empty state when the server returns no events', async () => {
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
    throw new Error('Task history empty-state fixture did not bind an ephemeral TCP port')
  }
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const timelineReads = []
  const externalRequests = []
  const writeAttempts = []
  let releaseTimelineReads
  const timelineReadGate = new Promise(resolve => { releaseTimelineReads = resolve })
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
    const method = path === '/mcp' && request.method() === 'POST' ? request.postDataJSON()?.method ?? '' : ''
    const allowedMcpRead = path === '/mcp' && request.method() === 'POST' && readOnlyMcpMethods.has(method)
    if (request.method() !== 'GET' && !(path === '/v1/auth/mcp-token' && request.method() === 'POST') && !allowedMcpRead) {
      writeAttempts.push(`${request.method()} ${path}${method ? ` ${method}` : ''}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null)) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (path === '/v1/auth/session') data = { account: { id: 'history-empty-reader', login: 'history-empty@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/v1/auth/mcp-token') data = { access_token: 'history-empty-local-token', refresh_token: 'history-empty-local-token', expires_in: 300, workspace_id: workspaceId }
    else if (path === `/v1/tasks/${taskId}`) data = { id: taskId, workspaceId, productId: 'product-history-empty', platform: 'jd', accountId: 'store-history-empty', state: 'draft', version: 1, createdAt: '2026-10-10T00:00:00.000Z', contentVersionId: versionId }
    else if (path === `/v1/tasks/${taskId}/content-versions`) data = { items: [{ id: versionId, taskId, version: 1, revision: 1, body: { title: '空历史状态验收', detail: '合成详情', sellingPoints: ['合成卖点'] }, factVersionIds: [], ruleVersionIds: [], state: 'review_required' }], total: 1, limit: 50, offset: 0 }
    else if (path === `/v1/tasks/${taskId}/feedback`) data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === `/v1/tasks/${taskId}/timeline`) {
      timelineReads.push(request.method())
      await timelineReadGate
      data = []
    }
    else if (path === `/v1/content-versions/${versionId}/review`) data = { findings: [], categories: [{ id: 'history-empty-review', name: '本地审核', status: 'passed', findingCount: 0, summary: '本地合成审核通过' }], blocking: false }
    else if (path === '/v1/products/product-history-empty') data = { id: 'product-history-empty', workspaceId, platform: 'jd', accountId: 'store-history-empty', storeName: '空历史合成店铺', title: '空历史状态验收', skuCount: 1, stock: 2, factsConfirmed: true, source: 'browser_fixture', version: 1 }
    else if (path === '/mcp') data = { result: method === 'workspace.metrics'
      ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
      : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${origin}/merchant/tasks/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await expect(page.getByRole('heading', { name: '任务协作线程' })).toBeVisible({ timeout: 30_000 })
    const trigger = page.getByRole('button', { name: '历史', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '任务历史' })
    await expect.poll(() => timelineReads.length).toBe(2)
    await expect(dialog.getByRole('status')).toContainText('正在读取历史事件')
    await expect(dialog.getByText('暂无可用历史事件')).toBeHidden()
    releaseTimelineReads()
    await expect(dialog.getByText('暂无可用历史事件')).toBeVisible()
    await expect(dialog.locator('.timeline-row')).toHaveCount(0)
    expect(timelineReads).toEqual(['GET', 'GET'])
    expect(writeAttempts).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    releaseTimelineReads()
    await context.close()
    await browser.close()
    await vite.close()
  }
})
