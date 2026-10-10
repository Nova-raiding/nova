import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_task_history_close_fixture'
const taskId = 'task_history_close_fixture'
const versionId = 'content_version_task_history_close'
const envelope = data => ({ request_id: 'task-history-close-focus', trace_id: 'task-history-close-focus', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })
const task = { id: taskId, workspaceId, productId: 'product-history-close', platform: 'jd', accountId: 'store-history-close', state: 'draft', version: 2, createdAt: '2026-10-10T00:00:00.000Z', contentVersionId: versionId }
const version = { id: versionId, taskId, version: 2, revision: 2, body: { title: '任务历史返回验收', detail: '合成详情', sellingPoints: ['合成卖点'] }, factVersionIds: ['fact-v2'], ruleVersionIds: ['rule-v1'], state: 'review_required' }
const timeline = [
  { id: 'event-create', task_id: taskId, event_type: 'task_created', sequence: 1, delivery: 'delivered', occurred_at: '2026-10-10T08:00:00.000Z' },
  { id: 'event-content', task_id: taskId, event_type: 'content_generated', sequence: 2, delivery: 'delivered', occurred_at: '2026-10-10T08:05:00.000Z' },
]

test('task history opens with local readback and returns focus to its trigger when closed', async () => {
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
    throw new Error('Task history fixture did not bind an ephemeral TCP port')
  }
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const writeAttempts = []
  const timelineReads = []
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
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: '任务历史只读 fixture 禁止写入' })) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (path === '/v1/auth/session') data = { account: { id: 'history-reader', login: 'history@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/v1/auth/mcp-token') data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    else if (path === `/v1/tasks/${taskId}`) data = task
    else if (path === `/v1/tasks/${taskId}/content-versions`) data = { items: [version], total: 1, limit: 50, offset: 0 }
    else if (path === `/v1/tasks/${taskId}/feedback`) data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === `/v1/tasks/${taskId}/timeline`) { timelineReads.push(request.method()); data = timeline }
    else if (path === `/v1/content-versions/${versionId}/review`) data = { findings: [], categories: [{ id: 'history-review', name: '本地审核', status: 'passed', findingCount: 0, summary: '本地合成审核通过' }], blocking: false }
    else if (path === '/v1/products/product-history-close') data = { id: 'product-history-close', workspaceId, platform: 'jd', accountId: 'store-history-close', storeName: '任务历史合成店铺', title: '任务历史返回验收', skuCount: 1, stock: 4, factsConfirmed: true, source: 'browser_fixture', version: 2 }
    else if (path === '/mcp') data = { result: mcpMethod === 'workspace.metrics'
      ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
      : mcpMethod === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${origin}/merchant/tasks/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await expect(page.getByRole('heading', { name: '任务协作线程' })).toBeVisible({ timeout: 30_000 })
    const trigger = page.getByRole('button', { name: '历史', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '任务历史' })
    await expect(dialog.getByText('任务已创建')).toBeVisible()
    await expect(dialog.getByText('内容已生成')).toBeVisible()
    await expect(dialog.locator('.timeline-row')).toHaveCount(2)
    // The task detail preload and opening the history dialog each read the same
    // local timeline; both are read-only and should return the same evidence.
    expect(timelineReads).toEqual(['GET', 'GET'])

    await dialog.getByRole('button', { name: '关闭任务历史' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(writeAttempts).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
