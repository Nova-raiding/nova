import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_task_version_review_fixture'
const taskId = 'task_version_review_fixture'
const currentVersionId = 'content_version_current_fixture'
const olderVersionId = 'content_version_older_fixture'
const envelope = (data, error = null) => ({ request_id: 'task-version-review-fixture', trace_id: 'task-version-review-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })
const versions = [
  { id: currentVersionId, taskId, version: 2, body: { title: '当前服务端版本标题', detail: '当前版本详情', sellingPoints: ['当前卖点'] }, factVersionIds: ['fact-current'], ruleVersionIds: ['rule-current'], state: 'pending_review', revision: 2 },
  { id: olderVersionId, taskId, version: 1, body: { title: '历史服务端版本标题', detail: '历史版本详情', sellingPoints: ['历史卖点'] }, factVersionIds: ['fact-old'], ruleVersionIds: ['rule-old'], state: 'superseded', revision: 1 },
]

test('merchant can inspect an older content version and explicitly recover its failed review read', async () => {
  test.setTimeout(120_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Task version review fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const writeAttempts = []
  const reviewReads = []
  const readOnlyMcpMethods = new Set(['billing.transactions', 'canonical.product.consistency', 'commercial.catalog.get', 'commercial.subscription.get', 'creative-points.balance.get', 'creative-points.statement.list', 'platform.model.status', 'subscription.get', 'workspace.metrics'])
  const failOlderReviewOnce = { value: true }

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    let mcpMethod = ''
    if (path === '/mcp') {
      try { mcpMethod = request.postDataJSON()?.method ?? '' } catch { /* rejected by the allowlist below */ }
    }
    const allowedMcpRead = path === '/mcp' && request.method() === 'POST' && readOnlyMcpMethods.has(mcpMethod)
    if (request.method() !== 'GET' && !(path === '/v1/auth/mcp-token' && request.method() === 'POST') && !allowedMcpRead) {
      writeAttempts.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: '只读版本审查 fixture 禁止写入' })) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/auth/session') {
      data = { account: { id: 'task-version-user', login: 'version@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    } else if (path === `/v1/tasks/${taskId}`) {
      data = { id: taskId, workspaceId, productId: 'product-version-fixture', platform: 'jd', accountId: 'store-version-fixture', state: 'draft', version: 2, createdAt: '2026-10-10T00:00:00.000Z' }
    } else if (path === `/v1/tasks/${taskId}/content-versions`) {
      data = { items: versions, total: versions.length, limit: 50, offset: 0 }
    } else if (path === `/v1/tasks/${taskId}/feedback`) {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (path === `/v1/tasks/${taskId}/timeline`) {
      data = []
    } else if (path === `/v1/content-versions/${olderVersionId}/review`) {
      reviewReads.push(olderVersionId)
      if (failOlderReviewOnce.value) {
        failOlderReviewOnce.value = false
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '历史版本审核结果暂时无法读取' })) })
      }
      data = { findings: [], categories: [{ id: 'fixture-review', name: '历史版本校验', status: 'passed', findingCount: 0, summary: '本地合成审核结果' }], blocking: false }
    } else if (path === `/v1/content-versions/${currentVersionId}/review`) {
      data = { findings: [], categories: [{ id: 'fixture-review-current', name: '当前版本校验', status: 'passed', findingCount: 0, summary: '当前版本合成结果' }], blocking: false }
    } else if (path === '/mcp') {
      data = { result: mcpMethod === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : mcpMethod === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    } else if (/^\/v1\/products\/[^/]+$/u.test(path)) {
      data = { id: 'product-version-fixture', workspaceId, platform: 'jd', accountId: 'store-version-fixture', storeName: '版本审查合成店铺', title: '版本审查合成商品', version: 1, factsConfirmed: true, source: 'browser_fixture', updatedAt: '2026-10-10T00:00:00.000Z' }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/tasks/${taskId}`, { waitUntil: 'domcontentloaded' })
    const editor = page.getByRole('region', { name: '内容编辑区' })
    await expect(editor.getByRole('heading', { name: '当前服务端版本标题' }).first()).toBeVisible()
    await page.getByRole('tab', { name: /版本记录/u }).click()
    const versionsPanel = page.getByRole('tabpanel', { name: /版本记录/u })
    await expect(versionsPanel.getByText('内容版本 v1')).toBeVisible()
    await versionsPanel.getByRole('button', { name: '查看版本' }).nth(1).click()

    await expect(editor.getByRole('heading', { name: '历史服务端版本标题' }).first()).toBeVisible()
    await expect(page.getByText(/审核结果读取失败：/u)).toBeVisible()
    await expect(page.getByText('模型服务尚未就绪')).toHaveCount(0)
    expect(reviewReads).toEqual([olderVersionId])
    await expect(page.getByRole('checkbox', { name: /批准/u })).toBeDisabled()

    await page.getByRole('button', { name: '重新读取' }).click()
    await expect(page.getByText('本地合成审核结果')).toBeVisible()
    await expect(editor.getByRole('heading', { name: '历史服务端版本标题' }).first()).toBeVisible()
    expect(reviewReads).toEqual([olderVersionId, olderVersionId])
    expect(writeAttempts).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
