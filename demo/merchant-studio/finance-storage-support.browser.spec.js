import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_finance_storage_support_fixture'
const envelope = data => ({ request_id: 'finance-storage-support', trace_id: 'finance-storage-support', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('finance storage expansion opens scoped manual support without purchase or payment writes', async ({ page }) => {
  test.setTimeout(60_000)
  const origin = new URL(studioUrl).origin
  const requests = []
  const writes = []
  const externalRequests = []
  const ticketId = '123e4567-e89b-12d3-a456-426614174000'

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== origin) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    const method = request.method()
    let rpcMethod = ''
    if (path === '/mcp' && method === 'POST') rpcMethod = request.postDataJSON()?.method ?? ''
    if (path === '/v1/support/requests' && method === 'POST') {
      const body = request.postDataJSON()
      writes.push({ method, path, rpcMethod, workspace: request.headers()['x-workspace-id'] ?? '', body })
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(envelope({ submitted: true, ticket_id: ticketId, ticket_number: 'SUP-20261011-019', status: 'open', replayed: false, replies_path: `/v1/support/requests/${ticketId}` })) })
    }
    const readMethods = new Set(['billing.transactions', 'canonical.product.consistency', 'commercial.catalog.get', 'commercial.subscription.get', 'creative-points.balance.get', 'creative-points.statement.list', 'platform.model.status', 'subscription.get', 'workspace.metrics'])
    const readMcp = path === '/mcp' && method === 'POST' && readMethods.has(rpcMethod)
    if (method !== 'GET' && !(path === '/v1/auth/mcp-token' && method === 'POST') && !readMcp) {
      writes.push({ method, path, rpcMethod, workspace: request.headers()['x-workspace-id'] ?? '' })
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null)) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true }, platformOperations: { mode: 'manual', ready: true } } }
    else if (path === '/v1/auth/session') data = { account: { id: 'finance-storage-reader', login: 'storage@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/v1/auth/mcp-token') data = { access_token: 'local-fixture', refresh_token: 'local-fixture', token_type: 'Bearer', expires_in: 300, workspace_id: workspaceId }
    else if (path === '/v1/platform-accounts' || path === '/v1/products') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === '/v1/assets') data = { items: [], total: 0, limit: 50, offset: 0, storage_quota: { usedBytes: 1_000_000, reservedBytes: 0, limitBytes: 2_147_483_648, availableBytes: 2_146_483_648, status: 'available' } }
    else if (path === '/v1/brand-scopes') data = { settings: {}, revision: 0, series: [], assignments: [] }
    else if (path === '/mcp') {
      requests.push({ method: rpcMethod, workspace: request.headers()['x-workspace-id'] ?? '' })
      let result = {}
      if (rpcMethod === 'creative-points.balance.get') result = { balance_state: 'known', available_points: 120, reserved_points: 0, settled_points: 0 }
      else if (rpcMethod === 'billing.transactions') result = { balance_cny: '0.00', transactions: [] }
      else if (rpcMethod === 'creative-points.statement.list') result = { entries: [], next_cursor: null, truncated: false, unreadable_entries: 0 }
      else if (rpcMethod === 'commercial.subscription.get') result = { schema_version: 'commercial.subscription.v1', status: 'available', current: null, future: [], packs: [], history: [], orders: [] }
      else if (rpcMethod === 'commercial.catalog.get') result = { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [] }
      else if (rpcMethod === 'workspace.metrics') result = { riskItems: [], stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
      else if (rpcMethod === 'platform.model.status') result = { state: 'ready', capabilities: { image_generation: false } }
      else if (rpcMethod === 'subscription.get') result = { commercial_entitlement: { status: 'unknown' }, legacy_commercial_entitlement: null }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
    }
    requests.push({ method: `${method} ${path}`, workspace: request.headers()['x-workspace-id'] ?? '' })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  await page.goto(`${studioUrl}/merchant/finance`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '购买储存空间' }).click()
  const dialog = page.getByRole('dialog', { name: '储存空间扩容咨询' })
  await expect(dialog.getByRole('heading', { name: '提交人工支持' })).toBeVisible()
  await expect(dialog.getByText(/不会创建订单或发起付款/)).toBeVisible()
  await expect(dialog.getByLabel('问题标题')).toBeVisible()
  await expect(dialog.getByLabel('问题说明')).toBeVisible()
  expect(writes).toEqual([])

  await dialog.getByLabel('问题标题').fill('咨询储存空间扩容')
  await dialog.getByLabel('问题说明').fill('当前工作区需要更多储存空间，请协助确认可用方案。')
  await dialog.getByRole('button', { name: '提交人工支持' }).click()
  await expect(dialog.getByText(/已登记真实工单 SUP-20261011-019/)).toBeVisible()

  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ method: 'POST', path: '/v1/support/requests', workspace: workspaceId, body: { subject: '咨询储存空间扩容', message: '当前工作区需要更多储存空间，请协助确认可用方案。' } })
  expect(writes[0].body.idempotency_key).toEqual(expect.any(String))
  expect(requests.some(item => ['commercial.order.create', 'commercial.checkout.create', 'commercial.order.payment.create', 'billing.recharge.create'].includes(item.method))).toBe(false)
  expect(externalRequests).toEqual([])
})
