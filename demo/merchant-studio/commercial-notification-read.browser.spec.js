import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_commercial_notification_fixture'
const notificationId = 'notice-purchase-result-fixture'
const envelope = (data, workspace = workspaceId) => ({ request_id: 'commercial-notification-fixture', trace_id: 'commercial-notification-fixture', workspace_id: workspace, data, warnings: [], next_actions: [], error: null })

test('顶部购买结果通知显示服务端状态，确认已读后才更新状态', async () => {
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
    throw new Error('Commercial notification fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const reads = []
  const writes = []
  let readAt = null
  let releaseRead

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') {
      data = { account: { id: 'commercial-notice-user', login: 'notice@example.invalid', accountType: 'merchant', displayName: '通知夹具', enterpriseName: '本地工作区', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      if (method === 'commercial.notifications.list') {
        reads.push(request.postDataJSON())
        if (releaseRead) await new Promise(resolve => { releaseRead = resolve })
        data = { result: { items: [{ id: notificationId, event_id: 'purchase-event-fixture', sku_code: 'fixture-plan', version: 1, title: '本地购买处理结果', body: '夹具订单已经完成权益处理。', published_at: '2026-10-10T02:00:00.000Z', notification_kind: 'purchase_result', order_id: 'order-fixture-1', result_state: 'active', read_at: readAt }], next_cursor: null } }
      } else if (method === 'workspace.metrics') data = { result: { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} } }
      else if (method === 'platform.model.status') data = { result: { state: 'ready', capabilities: {} } }
      else data = { result: {} }
    } else if (path === `/v1/commercial/notifications/${notificationId}/read` && request.method() === 'POST') {
      writes.push(request.postDataJSON())
      readAt = '2026-10-11T03:00:00.000Z'
      data = { notification_id: notificationId, read_at: readAt, replayed: false }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /待处理问题/u }).click()
    await expect.poll(() => reads.length, { timeout: 10_000 }).toBeGreaterThan(0)
    const panel = page.getByRole('region', { name: '套餐与权益包通知' })
    await expect(panel.getByText('本地购买处理结果')).toBeVisible()
    await expect(panel.getByText('购买结果：立即生效')).toBeVisible()
    await expect(panel.getByText('未读', { exact: true })).toBeVisible()

    let finishWrite
    const writeStarted = new Promise(resolve => { finishWrite = resolve })
    page.on('request', request => {
      if (request.url().includes(`/v1/commercial/notifications/${notificationId}/read`)) finishWrite()
    })
    await page.route(`**/v1/commercial/notifications/${notificationId}/read`, async route => {
      writes.push(route.request().postDataJSON())
      await writeStarted
      await new Promise(resolve => { releaseRead = resolve })
      readAt = '2026-10-11T03:00:00.000Z'
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ notification_id: notificationId, read_at: readAt, replayed: false })) })
    })
    await panel.getByRole('button', { name: '标记已读' }).click()
    await expect.poll(() => writes.length).toBe(1)
    await expect(panel.getByRole('button', { name: '标记已读' })).toBeVisible()
    expect(writes[0]?.idempotency_key).toMatch(/^notification-read:/u)
    releaseRead()
    await expect(panel.getByText('已读', { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: '标记已读' })).toHaveCount(0)
    expect(reads.length).toBeGreaterThan(0)
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
