import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_task_feedback_unknown_fixture'
const taskId = 'task_feedback_unknown_fixture'
const versionId = 'content_version_feedback_unknown_fixture'
const envelope = (data, error = null) => ({ request_id: 'task-feedback-recovery', trace_id: 'task-feedback-recovery', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })
const version = { id: versionId, taskId, version: 1, revision: 1, body: { title: '反馈详情恢复验收', detail: '合成内容', sellingPoints: ['合成事实'] }, factVersionIds: ['fact-v1'], ruleVersionIds: ['rule-v1'], state: 'review_required' }
const feedback = []

test('changed feedback payload keeps its key until the existing record is reviewed', async () => {
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
    throw new Error('Task feedback recovery fixture did not bind an ephemeral TCP port')
  }
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => {
    const storage = window.sessionStorage
    let blocked = false
    const getItem = storage.getItem.bind(storage)
    const setItem = storage.setItem.bind(storage)
    const removeItem = storage.removeItem.bind(storage)
    storage.getItem = (key) => {
      if (blocked) throw new DOMException('Storage access is blocked', 'SecurityError')
      return getItem(key)
    }
    storage.setItem = (key, value) => {
      if (blocked) throw new DOMException('Storage access is blocked', 'SecurityError')
      setItem(key, value)
    }
    storage.removeItem = (key) => {
      if (blocked) throw new DOMException('Storage access is blocked', 'SecurityError')
      removeItem(key)
    }
    Object.defineProperty(window, '__blockSessionStorage', { value: () => { blocked = true } })
  })
  const page = await context.newPage()
  const externalRequests = []
  const writeAttempts = []
  const feedbackReads = []
  const submissions = []
  let committedFeedback
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
    const feedbackSubmit = path === `/v1/tasks/${taskId}/feedback` && request.method() === 'POST'
    if (request.method() !== 'GET' && !(path === '/v1/auth/mcp-token' && request.method() === 'POST') && !allowedMcpRead && !feedbackSubmit) {
      writeAttempts.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: '反馈读取恢复 fixture 禁止写入' })) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') data = { status: 'ok', writesEnabled: true, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (path === '/v1/auth/session') data = { account: { id: 'feedback-reader', login: 'feedback@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/v1/auth/mcp-token') data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    else if (path === `/v1/tasks/${taskId}`) data = { id: taskId, workspaceId, productId: 'product-feedback-recovery', platform: 'jd', accountId: 'store-feedback-recovery', state: 'draft', version: 1, createdAt: '2026-10-10T00:00:00.000Z', contentVersionId: versionId }
    else if (path === `/v1/tasks/${taskId}/content-versions`) data = { items: [version], total: 1, limit: 50, offset: 0 }
    else if (path === `/v1/tasks/${taskId}/feedback`) {
      if (request.method() === 'POST') {
        submissions.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() })
        if (submissions.length === 1) {
          committedFeedback = { id: 'feedback-unknown-once', taskId, contentVersionId: versionId, rating: 'liked', actorId: 'feedback-writer', createdAt: '2026-10-11T00:00:00.000Z', revision: 1 }
          feedback.push(committedFeedback)
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'API_REQUEST_TIMEOUT', message: '模拟反馈已提交，但响应丢失' })) })
        }
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'IDEMPOTENCY_KEY_REUSED', message: '该键已对应不同反馈内容' })) })
      }
      feedbackReads.push(request.method())
      if (feedbackReads.length === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_TEMPORARY_UNAVAILABLE', message: '本地模拟反馈记录暂时不可读' })) })
      data = { items: feedback, total: feedback.length, limit: 50, offset: 0 }
    } else if (path === `/v1/tasks/${taskId}/timeline`) data = []
    else if (path === '/v1/products/product-feedback-recovery') data = { id: 'product-feedback-recovery', workspaceId, platform: 'jd', accountId: 'store-feedback-recovery', storeName: '反馈恢复合成店铺', title: '反馈详情恢复验收', skuCount: 1, stock: 2, factsConfirmed: true, source: 'browser_fixture', version: 1, images: [] }
    else if (path === `/v1/content-versions/${versionId}/review`) data = { findings: [], categories: [{ id: 'feedback-review', name: '本地检查', status: 'passed', findingCount: 0, summary: '本地合成检查通过' }], blocking: false }
    else if (path === '/mcp') data = { result: method === 'workspace.metrics'
      ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
      : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${origin}/merchant/tasks/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await expect(page.getByRole('heading', { name: '任务协作线程' })).toBeVisible({ timeout: 30_000 })
    const feedbackSection = page.locator('.feedback-section')
    await expect(feedbackSection.getByRole('alert')).toContainText('反馈记录读取失败')
    await expect(feedbackSection.getByRole('button', { name: '重试' })).toBeVisible()
    expect(feedbackReads).toEqual(['GET'])
    await feedbackSection.getByRole('button', { name: '重试' }).click()
    await expect(feedbackSection.getByRole('alert')).toHaveCount(0)
    expect(feedbackReads).toEqual(['GET', 'GET'])
    await page.evaluate(({ workspaceId, taskId, versionId }) => {
      window.sessionStorage.setItem(`merchant-feedback:${workspaceId}:${taskId}:${versionId}:liked`, 'legacy-feedback-key')
    }, { workspaceId, taskId, versionId })
    await feedbackSection.locator('input.feedback-input').fill('第一次提交后补充了原因')
    await feedbackSection.getByRole('button', { name: '满意' }).click()
    const satisfactionButton = feedbackSection.getByRole('button', { name: '满意' })
    await expect(satisfactionButton).toBeEnabled({ timeout: 15_000 })
    await expect(feedbackSection.getByRole('alert')).toContainText('API 请求超时')
    await page.evaluate(() => window.__blockSessionStorage())
    expect(await page.evaluate(() => {
      try { window.sessionStorage.getItem('probe'); return false }
      catch { return true }
    })).toBe(true)
    await feedbackSection.locator('input.feedback-input').fill('修改后的反馈原因')
    await satisfactionButton.click()
    await expect(feedbackSection.getByRole('alert')).toContainText('为避免重复记录')
    expect(submissions).toHaveLength(2)
    expect(submissions[0].key).toBe('legacy-feedback-key')
    expect(submissions[1].key).toBe(submissions[0].key)
    expect(submissions[1].body).not.toEqual(submissions[0].body)
    expect(feedback).toHaveLength(1)
    await expect(satisfactionButton).toBeDisabled()
    await feedbackSection.getByRole('button', { name: '核对已有反馈' }).click()
    await expect(feedbackSection.getByText('已记录 1 条任务反馈')).toBeVisible()
    await expect(feedbackSection.getByRole('button', { name: '我已核对，开始新反馈' })).toBeVisible()
    expect(submissions).toHaveLength(2)
    expect(feedbackReads).toEqual(['GET', 'GET', 'GET'])
    expect(writeAttempts).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
