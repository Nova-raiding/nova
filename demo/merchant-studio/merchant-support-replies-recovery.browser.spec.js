import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_support_replies_recovery_fixture'
const ticketId = 'support-ticket-fixture-8842'
const envelope = (data, error = null) => ({ request_id: 'support-replies-fixture', trace_id: 'support-replies-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('support replies preserve the ticket query after a read failure and recover on retry', async () => {
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
    throw new Error('Support replies fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const replyQueries = []
  let allowReplyRead = false

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/auth/session') {
      data = { account: { id: 'support-replies-user', login: 'support@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/mcp') {
      const body = request.postDataJSON()
      if (body?.method === 'support.customer.replies.list') {
        replyQueries.push(body.params)
        if (!allowReplyRead) {
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '本地夹具：客服回复暂时无法读取。' })) })
        }
        data = { result: { ticket: { ticket_number: 'SN-8842', subject: '店铺授权接入咨询', status: 'open' }, replies: [{ id: 'reply-public-1', body: '客户可见回复：已收到店铺资料，客户经理将在一个工作日内联系。', created_at: '2026-10-10T02:30:00.000Z' }], tickets: [], next_cursor: null } }
      } else {
        const method = body?.method
        data = { result: method === 'workspace.metrics'
          ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
          : method === 'platform.model.status' ? { state: 'ready', capabilities: {} } : {} }
      }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '联系客服经理' }).click()
    const panel = page.getByRole('dialog', { name: '支持消息' })
    await expect(panel).toBeVisible()
    const ticketInput = panel.getByLabel('客服工单 ID')
    await ticketInput.fill(ticketId)
    await panel.getByRole('button', { name: '读取客户回复' }).click()
    await expect(panel.getByRole('alert')).toContainText('服务暂不可用')
    await expect(ticketInput).toHaveValue(ticketId)

    allowReplyRead = true
    await panel.getByRole('button', { name: '读取客户回复' }).click()
    await expect(panel).toContainText('SN-8842 · 店铺授权接入咨询 · open')
    await expect(panel).toContainText('客户可见回复：已收到店铺资料，客户经理将在一个工作日内联系。')
    expect(replyQueries).toEqual([
      { ticket_id: ticketId, limit: '50' },
      { ticket_id: ticketId, limit: '50' },
    ])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
