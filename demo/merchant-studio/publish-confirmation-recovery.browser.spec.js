import { expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_publish_confirmation_local_mock'
const taskId = 'task-publish-confirmation-fixture'
const productId = 'product-publish-confirmation-fixture'
const versionId = 'content-publish-confirmation-fixture'
const storeId = 'store-publish-confirmation-fixture'

test.setTimeout(120_000)

const envelope = data => ({
  request_id: 'publish-confirmation-local-fixture',
  trace_id: 'publish-confirmation-local-fixture',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
})

const task = {
  id: taskId, workspaceId, productId, platform: 'jd', accountId: storeId,
  state: 'approved', version: 7, createdAt: '2026-10-11T00:00:00.000Z', requestText: '本地发布确认验收',
}

const product = {
  id: productId, workspaceId, platform: 'jd', accountId: storeId, storeName: '本地验收店铺',
  title: '本地商品', skuCount: 1, stock: 8, factsConfirmed: true, source: 'local_mock',
  updatedAt: '2026-10-11T00:00:00.000Z', sellingPoints: [],
}

const version = {
  id: versionId, taskId, version: 3, revision: 2,
  body: { title: '已审核的本地商品内容', detail: '只用于隔离浏览器回归。', sellingPoints: [] },
  factVersionIds: [], ruleVersionIds: [], state: 'approved',
}

let vite
let browser
let studioUrl

test.beforeAll(async () => {
  vite = await createServer({
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
  if (!address || typeof address === 'string') throw new Error('Local publish fixture did not bind a loopback port')
  studioUrl = `http://127.0.0.1:${address.port}`
  browser = await (await import('playwright')).chromium.launch({ channel: 'chrome', headless: true })
}, 60_000)

test.afterAll(async () => {
  try { await browser?.close() }
  finally { await vite?.close() }
}, 60_000)

test('人工发布确认可取消；结果未知后先读回历史且不重复提交', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const unexpectedApiRequests = []
  const previewRequests = []
  const publishRequests = []
  const taskReads = []
  let acceptedJob = null
  page.on('pageerror', error => unexpectedApiRequests.push(`pageerror: ${error.message}`))

  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== studioUrl) {
      externalRequests.push(route.request().url())
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === '/api/healthz') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'local_mock', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } })) })
    if (path === '/api/v1/auth/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: { id: 'local-merchant', login: 'local@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })) })
    if (path === '/api/v1/auth/mcp-token') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ access_token: 'local-fixture-token', refresh_token: 'local-fixture-refresh', expires_in: 300 })) })

    if (path === `/api/v1/tasks/${taskId}/publish-preview` && request.method() === 'POST') {
      previewRequests.push(request.postDataJSON())
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ task, version, remoteSnapshotHash: 'local-remote-snapshot-hash', confirmationHash: 'local-confirmation-hash', operation: 'update', changes: ['标题', '详情'], protectedFields: ['价格', '库存', 'SKU'] })) })
    }
    if (path === '/api/v1/publish-jobs' && request.method() === 'POST') {
      const body = request.postDataJSON()
      publishRequests.push({ body, idempotencyKey: request.headers()['idempotency-key'] })
      // The local fixture records acceptance, then drops the response. This
      // models an unknown HTTP outcome without calling a real publishing API.
      acceptedJob = {
        id: 'publish-job-accepted-response-lost', workspaceId, taskId, contentVersionId: versionId,
        platform: 'jd', accountId: storeId, idempotencyKey: request.headers()['idempotency-key'],
        state: 'unknown', remoteState: 'unknown', confirmationHash: body.confirmation_hash,
        remoteSnapshotHash: body.remote_snapshot_hash, createdAt: '2026-10-11T00:01:00.000Z',
      }
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ...envelope(null), error: { code: 'PUBLISH_CONFIRM_OUTCOME_UNKNOWN', message: '本地夹具模拟服务端已记录任务但响应丢失。' } }) })
    }
    if (path === '/api/v1/publish-jobs' && request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: acceptedJob ? [acceptedJob] : [], total: acceptedJob ? 1 : 0, limit: 20, offset: 0 })) })

    if (path === `/api/v1/tasks/${taskId}` && request.method() === 'GET') {
      taskReads.push(path)
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(task)) })
    }
    if (path === `/api/v1/products/${productId}` && request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(product)) })
    if (path === `/api/v1/tasks/${taskId}/content-versions` && request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [version], total: 1, limit: 50, offset: 0 })) })
    if (path === `/api/v1/tasks/${taskId}/feedback` && request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    if (path === `/api/v1/tasks/${taskId}/timeline` && request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope([])) })
    if (path === `/api/v1/tasks/${taskId}/directions` && request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope([])) })
    if (path === `/api/v1/content-versions/${versionId}/review` && request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ findings: [], categories: [], blocking: false })) })
    if (path === '/api/v1/tasks' && request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [task], total: 1, limit: 20, offset: 0 })) })
    if ((path === '/api/v1/products' || path === '/api/v1/platform-accounts') && request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })

    if (path === '/api/mcp' && request.method() === 'POST') {
      const method = request.postDataJSON()?.method
      if (method === 'campaign.batch.list') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { items: [] } })) })
      if (method === 'publish.manual.list') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { items: [], total: 0, limit: 20, offset: 0 } })) })
      if (/\.(create|confirm|update|delete|upsert|approve|suspend|grant|revoke|retry|pause|resume|submit|report|import|generate|extract|set|select|adjust|record)$/iu.test(String(method))) {
        unexpectedApiRequests.push(`POST /api/mcp method=${String(method)}`)
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ...envelope(null), error: { code: 'FIXTURE_UNEXPECTED_MCP', message: `Unexpected write method in local publish fixture: ${String(method)}` } }) })
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { items: [], total: 0, limit: 50, offset: 0 } })) })
    }
    if (request.method() !== 'GET') unexpectedApiRequests.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ ...envelope(null), error: { code: 'FIXTURE_UNEXPECTED_API', message: 'Unexpected API call in local publish fixture.' } }) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/tasks/${taskId}`, { waitUntil: 'domcontentloaded' })
    const continueButton = page.getByRole('button', { name: '继续确认发布' })
    await expect(continueButton).toBeEnabled({ timeout: 30_000 })

    await continueButton.click()
    const dialog = page.getByRole('dialog', { name: '提交人工发布任务' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('当前不代表平台已受理或已生效')
    await expect(dialog.getByRole('button', { name: '提交人工发布任务' })).toBeDisabled()
    const focusable = dialog.locator('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')
    const firstFocusable = focusable.first()
    const lastFocusable = focusable.last()
    await firstFocusable.focus()
    await page.keyboard.press('Shift+Tab')
    await expect(lastFocusable).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(firstFocusable).toBeFocused()
    await dialog.getByRole('button', { name: '关闭发布确认' }).click()
    await expect(dialog).toBeHidden()
    await expect(continueButton).toBeFocused()
    expect(publishRequests).toHaveLength(0)

    await continueButton.click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '返回检查' }).click()
    await expect(dialog).toBeHidden()
    await expect(continueButton).toBeFocused()
    expect(previewRequests).toHaveLength(2)
    expect(publishRequests).toHaveLength(0)

    await continueButton.click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('checkbox').check()
    const submit = dialog.getByRole('button', { name: '提交人工发布任务' })
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect(dialog.getByRole('alert')).toContainText('提交结果未确认')
    await expect(dialog.getByRole('alert')).toContainText('请先核对发布记录')
    expect(publishRequests).toHaveLength(1)
    expect(publishRequests[0].body).toMatchObject({ task_id: taskId, content_version_id: versionId, account_id: storeId })
    expect(publishRequests[0].idempotencyKey).toMatch(/^merchant-studio-publish-v1:/u)

    await dialog.getByRole('button', { name: '去发布记录核对' }).click()
    const history = page.getByRole('region', { name: '发布记录' })
    await expect(history).toContainText('结果未知，需人工核对')
    await expect(history).toContainText('当前不要重复提交')
    await expect(history).toContainText(`任务 ${taskId}`)
    expect(publishRequests).toHaveLength(1)
    expect(previewRequests).toHaveLength(3)
    expect(taskReads.length).toBeGreaterThan(0)
    expect(externalRequests).toEqual([])
    expect(unexpectedApiRequests).toEqual([])
  } finally {
    await context.close()
  }
})
