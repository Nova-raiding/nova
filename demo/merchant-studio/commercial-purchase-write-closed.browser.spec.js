import { expect, test, chromium } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_commercial_write_closed_fixture'
const envelope = (data, error = null) => ({ request_id: 'commercial-write-closed', trace_id: 'commercial-write-closed', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test.setTimeout(120_000)
let vite
let browser
let studioUrl

test.beforeAll(async () => {
  vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Commercial write-closed fixture did not bind a loopback port')
  studioUrl = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
}, 60_000)

test.afterAll(async () => {
  test.setTimeout(60_000)
  try { await browser?.close() }
  finally { await vite?.close() }
})

test('明确拒绝的商业写入不会被显示为结果未知或引导恢复查询', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const calls = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname.replace(/^\/api/u, '')
    let data = {}
    if (pathname === '/v1/auth/session') data = { account: { id: 'merchant-write-closed', login: 'closed@example.invalid', accountType: 'merchant', displayName: '本地关闭写入验收', enterpriseName: '本地模拟工作区', status: 'active', workspaceIds: [workspaceId] } }
    else if (pathname === '/v1/auth/mcp-token') data = { access_token: 'fixture-write-closed-token', refresh_token: 'fixture-write-closed-refresh', expires_in: 300, workspace_id: workspaceId }
    else if (pathname === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true } }
    else if (pathname === '/v1/assets') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (pathname === '/mcp') {
      const body = request.postDataJSON()
      calls.push({ method: body.method, params: body.params })
      if (body.method === 'commercial.catalog.get') data = { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [{ id: 'points-500-v3', code: 'points_500', kind: 'point_pack', visibility: 'public', version: 3, lifecycle: 'approved', executable: true, priceFen: 30000, name: '500 点包', checksum: 'points-500-v3', effectiveAt: '2026-01-01T00:00:00.000Z', saleState: 'on_sale', cycle: { unit: 'day', count: 30 }, benefits: [{ code: 'creative_points', quantity: 500 }], payload: {} }] }
      else if (body.method === 'commercial.subscription.get') data = { schema_version: 'commercial.subscription.v1', status: 'available', onboarding_qualified: false, current: null, future: [], packs: [], history: [], orders: [] }
      else if (body.method === 'commercial.order.create') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'NEW_WRITES_CLOSED', message: 'runtime write fence is closed' })) })
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: data })) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/finance`, { waitUntil: 'domcontentloaded' })
    const center = page.getByRole('region', { name: '套餐与权益包' })
    await center.getByRole('row', { name: /500 点包/u }).getByRole('button', { name: '购买权益包' }).click()
    const dialog = page.getByRole('dialog', { name: '确认服务端订单与付款明细' })
    await dialog.getByRole('button', { name: '生成订单明细，暂不付款' }).click()
    await expect(dialog.getByRole('alert')).toContainText('当前环境的新商业写入已关闭；本次没有创建订单、发起付款或扣费。')
    await expect(dialog.getByRole('button', { name: '查询原提交结果', exact: true })).toHaveCount(0)
    await expect(dialog).not.toContainText('结果待确认')
    expect(calls.filter(call => call.method === 'commercial.order.create')).toHaveLength(1)
    expect(pageErrors).toEqual([])
  } finally {
    await context.close()
  }
})
