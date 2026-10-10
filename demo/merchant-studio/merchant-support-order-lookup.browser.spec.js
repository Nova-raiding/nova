import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_support_order_lookup_fixture'
const orderId = 'order-support-fixture-20261011'
const envelope = (data, error = null) => ({ request_id: 'support-order-lookup', trace_id: 'support-order-lookup', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('support panel finds customer-visible replies by order ID when Enter is pressed', async () => {
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
      data = { account: { id: 'support-order-user', login: 'support@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'support-order-token', refresh_token: 'support-order-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/mcp') {
      const body = request.postDataJSON() ?? {}
      if (body.method === 'support.customer.replies.list') {
        supportCalls.push(body.params)
        data = { result: { ticket: null, replies: [], tickets: [{ ticket_id: 'ticket-order-fixture', ticket_number: 'SN-ORDER-120', subject: '订单交付咨询', status: 'in_progress', replies: [{ id: 'order-reply-1', body: '客户可见回复：订单资料已核对，正在安排后续处理。', created_at: '2026-10-11T02:00:00.000Z' }] }], next_cursor: null } }
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
    const orderInput = panel.getByLabel('订单 ID（可选）')
    await orderInput.fill(orderId)
    await orderInput.press('Enter')
    await expect(panel).toContainText('SN-ORDER-120 · 订单交付咨询 · in_progress')
    await expect(panel).toContainText('客户可见回复：订单资料已核对，正在安排后续处理。')
    expect(supportCalls).toEqual([{ related_order_id: orderId, limit: '50' }])
    expect(otherMethods.filter(method => method === 'support.customer.replies.list')).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
