import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_task_version_return_fixture'
const taskId = 'task_version_return_fixture'
const currentId = 'content_version_current_return_fixture'
const oldId = 'content_version_old_return_fixture'
const envelope = data => ({ request_id: 'task-version-return-fixture', trace_id: 'task-version-return-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })
const versions = [
  { id: currentId, taskId, version: 2, body: { title: '当前内容版本标题', detail: '当前版本详情', sellingPoints: ['当前卖点'] }, factVersionIds: ['fact-current'], ruleVersionIds: ['rule-current'], state: 'review_required', revision: 2 },
  { id: oldId, taskId, version: 1, body: { title: '历史内容版本标题', detail: '历史版本详情', sellingPoints: ['历史卖点'] }, factVersionIds: ['fact-old'], ruleVersionIds: ['rule-old'], state: 'superseded', revision: 1 },
]

test('returning from an older content version restores the current version details', async () => {
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
    throw new Error('Task version history return fixture did not bind an ephemeral TCP port')
  }
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const writeAttempts = []
  const reviewReads = []
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
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: '版本查看 fixture 禁止写入' })) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (path === '/v1/auth/session') data = { account: { id: 'task-version-return-user', login: 'version-return@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/v1/auth/mcp-token') data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    else if (path === `/v1/tasks/${taskId}`) data = { id: taskId, workspaceId, productId: 'product-version-return', platform: 'jd', accountId: 'store-version-return', state: 'draft', version: 2, createdAt: '2026-10-10T00:00:00.000Z' }
    else if (path === `/v1/tasks/${taskId}/content-versions`) data = { items: versions, total: versions.length, limit: 50, offset: 0 }
    else if (path === `/v1/tasks/${taskId}/feedback`) data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === `/v1/tasks/${taskId}/timeline`) data = []
    else if (path === `/v1/content-versions/${oldId}/review` || path === `/v1/content-versions/${currentId}/review`) {
      const id = path.includes(oldId) ? oldId : currentId
      reviewReads.push(id)
      data = { findings: [], categories: [{ id: `review-${id}`, name: '本地版本检查', status: 'passed', findingCount: 0, summary: `已核对 ${id}` }], blocking: false }
    } else if (/^\/v1\/products\/[^/]+$/u.test(path)) data = { id: 'product-version-return', workspaceId, platform: 'jd', accountId: 'store-version-return', storeName: '版本返回合成店铺', title: '版本返回合成商品', version: 1, factsConfirmed: true, source: 'browser_fixture', updatedAt: '2026-10-10T00:00:00.000Z' }
    else if (path === '/mcp') data = { result: method === 'workspace.metrics'
      ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
      : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${origin}/merchant/tasks/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const editor = page.getByRole('region', { name: '内容编辑区' })
    await expect(editor.getByRole('heading', { name: '当前内容版本标题' }).first()).toBeVisible({ timeout: 30_000 })
    await page.getByRole('tab', { name: /版本记录/u }).click()
    const history = page.getByRole('tabpanel', { name: /版本记录/u })
    await expect(history.getByText('内容版本 v1')).toBeVisible()
    await history.getByRole('button', { name: '查看版本' }).nth(1).click()
    await expect(editor.getByRole('heading', { name: '历史内容版本标题' }).first()).toBeVisible()
    await expect(page.getByText(`已核对 ${oldId}`)).toBeVisible()

    await page.getByRole('tab', { name: /版本记录/u }).click()
    await history.getByRole('button', { name: '查看版本' }).first().click()
    await expect(editor.getByRole('heading', { name: '当前内容版本标题' }).first()).toBeVisible()
    await expect(page.getByText(`已核对 ${currentId}`)).toBeVisible()
    expect(reviewReads).toContain(oldId)
    expect(reviewReads).toContain(currentId)
    expect(writeAttempts).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
