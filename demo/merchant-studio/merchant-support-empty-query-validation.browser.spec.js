import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_support_empty_query_validation_fixture'
const orderId = ''
const envelope = (data, error = null) => ({ request_id: 'support-empty-query-validation', trace_id: 'support-empty-query-validation', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('support panel blocks a reply lookup until an identifier is entered', async () => {
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
      data = { account: { id: 'support-empty-query-user', login: 'support@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'support-empty-query-token', refresh_token: 'support-empty-query-refresh', expires_in: 300, workspace_id: workspaceId }
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
    const orderInput = panel.getByLabel('订单 ID（可选）')
    await expect(ticketInput).toHaveValue('')
    await expect(orderInput).toHaveValue('')
    await panel.getByRole('button', { name: '读取客户回复' }).click()
    await expect(panel.getByRole('alert')).toHaveText('请输入客服工单 ID、任务 ID 或订单 ID。')
    await expect(ticketInput).toHaveValue('')
    await expect(orderInput).toHaveValue('')
    expect(supportCalls).toEqual([])
    expect(otherMethods.filter(method => method === 'support.customer.replies.list')).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
