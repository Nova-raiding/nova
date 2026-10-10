import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_support_order_no_match_fixture'
const orderId = 'order-with-no-support-ticket-20261011'
const envelope = (data, error = null) => ({ request_id: 'support-order-no-match', trace_id: 'support-order-no-match', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('support panel explains a successful order lookup with no related tickets', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Support order lookup fixture did not bind an ephemeral port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const supportCalls = []
  const otherMethods = []
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
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
      data = { account: { id: 'support-no-match-user', login: 'support@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'support-no-match-token', refresh_token: 'support-no-match-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/mcp') {
      const body = request.postDataJSON() ?? {}
      if (body.method === 'support.customer.replies.list') {
        supportCalls.push(body.params)
        data = { result: { ticket: null, replies: [], tickets: [], next_cursor: null } }
      } else {
        otherMethods.push(body.method)
        data = { result: body.method === 'workspace.metrics' ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} } : body.method === 'platform.model.status' ? { state: 'ready', capabilities: {} } : {} }
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
    await expect(ticketInput).toBeFocused()
    await ticketInput.fill('ticket-that-must-not-win')
    const orderInput = panel.getByLabel('订单 ID（可选）')
    await orderInput.fill(orderId)
    await orderInput.press('Enter')
    await expect(panel).toContainText('未找到与当前查询关联的客服工单。')
    await expect(orderInput).toHaveValue(orderId)
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await panel.getByLabel('客服工单 ID').press('Enter')
    await expect(panel).toContainText('未找到与当前查询关联的客服工单。')
    expect(supportCalls).toEqual([
      { related_order_id: orderId, limit: '50' },
      { ticket_id: 'ticket-that-must-not-win', limit: '50' },
    ])
    expect(otherMethods.filter(method => method === 'support.customer.replies.list')).toEqual([])
    expect(externalRequests).toEqual([])
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(page.getByRole('button', { name: '联系客服经理' })).toBeFocused()
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
