import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_finance_empty_ledger_fixture'
const envelope = data => ({ request_id: 'finance-empty-ledger', trace_id: 'finance-empty-ledger', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('finance reports a successfully read empty point ledger without inventing entries', async ({ page }) => {
  test.setTimeout(60_000)
  const origin = new URL(studioUrl).origin
  const requests = []
  const writes = []
  const externalRequests = []

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
    const readMethods = new Set(['billing.transactions', 'canonical.product.consistency', 'commercial.catalog.get', 'commercial.subscription.get', 'creative-points.balance.get', 'creative-points.statement.list', 'platform.model.status', 'subscription.get', 'workspace.metrics'])
    const readMcp = path === '/mcp' && method === 'POST' && readMethods.has(rpcMethod)
    if (method !== 'GET' && !(path === '/v1/auth/mcp-token' && method === 'POST') && !readMcp) {
      writes.push(`${method} ${path} ${rpcMethod}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null)) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true }, platformOperations: { mode: 'manual', ready: true } } }
    else if (path === '/v1/auth/session') data = { account: { id: 'finance-empty-reader', login: 'empty-ledger@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/v1/auth/mcp-token') data = { access_token: 'local-fixture', refresh_token: 'local-fixture', token_type: 'Bearer', expires_in: 300, workspace_id: workspaceId }
    else if (path === '/v1/platform-accounts' || path === '/v1/products') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === '/v1/assets') data = { items: [], total: 0, limit: 50, offset: 0, storage_quota: { usedBytes: 0, reservedBytes: 0, limitBytes: 2_147_483_648, availableBytes: 2_147_483_648, status: 'available' } }
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
  const finance = page.getByRole('region', { name: '财务概况' })
  const ledger = finance.getByRole('region', { name: '创意点来源账本' })
  await expect(ledger.getByText('已读取，暂无创意点流水', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(ledger.getByRole('alert')).toHaveCount(0)
  await expect(ledger.locator('.ant-table-tbody > tr.ant-table-row')).toHaveCount(0)
  await expect(ledger.locator('.ant-table-tbody > tr.ant-table-placeholder')).toContainText('已读取，暂无创意点流水')
  const statementReads = requests.filter(item => item.method === 'creative-points.statement.list')
  expect(statementReads.length).toBeGreaterThan(0)
  expect(statementReads.every(item => item.workspace === workspaceId)).toBe(true)
  expect(writes).toEqual([])
  expect(externalRequests).toEqual([])
})
