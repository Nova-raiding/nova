import { expect, test, chromium } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_commercial_payment_unknown_fixture'
const orderId = 'growth-payment-unknown-order'
const envelope = (data, error = null) => ({ request_id: 'commercial-payment-unknown', trace_id: 'commercial-payment-unknown', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })
const pendingOrder = {
  order_id: orderId, sku_code: 'growth', sku_version_id: 'growth-v2', status: 'pending', amount_fen: 200000,
  currency: 'CNY', payment_mode: 'provider', expires_at: '2099-01-01T00:00:00.000Z',
  snapshot: { name: '成长版', cycle: { unit: 'month', count: 1 }, quantity: 1, benefits: [{ code: 'monthly_creative_points', quantity: 5000 }] },
}

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
  if (!address || typeof address === 'string') throw new Error('Commercial payment fixture did not bind a loopback port')
  studioUrl = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
}, 60_000)

test.afterAll(async () => {
  test.setTimeout(60_000)
  try { await browser?.close() }
  finally { await vite?.close() }
})

test('recovers a payment request with the same idempotency key after a lost response', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const calls = []
  let paymentIntentCreated = false
  let paymentReads = 0
  await page.route('**/api/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname.replace(/^\/api/u, '')
    let data = {}
    if (pathname === '/v1/auth/session') data = { account: { id: 'commercial-payment-unknown', login: 'payment@example.invalid', accountType: 'merchant', displayName: '本地支付恢复验收', enterpriseName: '本地模拟工作区', status: 'active', workspaceIds: [workspaceId] } }
    else if (pathname === '/v1/auth/mcp-token') data = { access_token: 'local-payment-unknown-token', refresh_token: 'local-payment-unknown-refresh', expires_in: 300, workspace_id: workspaceId }
    else if (pathname === '/healthz') data = { status: 'ok', writesEnabled: true, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (pathname === '/v1/assets') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (pathname === '/mcp') {
      const body = request.postDataJSON()
      calls.push({ method: body.method, params: body.params })
      if (body.method === 'commercial.catalog.get') data = { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [{ id: 'growth-payment-v2', code: 'growth', kind: 'monthly', visibility: 'public', version: 2, lifecycle: 'approved', executable: true, priceFen: 200000, name: '成长版', checksum: 'growth-v2', effectiveAt: '2026-01-01T00:00:00.000Z', saleState: 'on_sale', cycle: { unit: 'month', count: 1 }, planFamily: 'standard', tierRank: 2, benefits: [{ code: 'monthly_creative_points', quantity: 5000 }], payload: {} }] }
      else if (body.method === 'commercial.subscription.get') data = { schema_version: 'commercial.subscription.v1', status: 'available', onboarding_qualified: true, current: null, future: [], packs: [], history: [], orders: [] }
      else if (body.method === 'commercial.order.create') data = pendingOrder
      else if (body.method === 'commercial.order.payment.create') {
        if (!paymentIntentCreated) {
          paymentIntentCreated = true
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'API_REQUEST_TIMEOUT', message: '模拟支付请求已创建，但响应丢失' })) })
        }
        data = { ...pendingOrder, payment_url: 'https://pay.example.invalid/checkout/growth-payment-unknown-order' }
      } else if (body.method === 'commercial.order.payment.get') {
        paymentReads += 1
        if (paymentReads === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'API_REQUEST_TIMEOUT', message: '模拟付款状态读取暂不可用' })) })
        data = paymentReads === 2
          ? { ...pendingOrder, payment_url: 'https://pay.example.invalid/checkout/growth-payment-unknown-order' }
          : { ...pendingOrder, status: 'paid' }
      }
      else if (body.method === 'workspace.metrics') data = { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } }
      else if (body.method === 'platform.model.status') data = { state: 'ready', capabilities: { image_generation: false } }
      else if (body.method === 'creative-points.balance.get') data = { available_points: 0, balance_state: 'known' }
      else if (body.method === 'billing.transactions') data = { balance_cny: '0.00', transactions: [] }
      else data = {}
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: data })) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/finance`, { waitUntil: 'domcontentloaded' })
    const center = page.getByRole('region', { name: '套餐与权益包' })
    const growthRow = center.getByRole('row').filter({ hasText: '成长版' })
    await growthRow.getByRole('button', { name: '购买套餐' }).click()
    const dialog = page.getByRole('dialog', { name: '确认服务端订单与付款明细' })
    await dialog.getByRole('button', { name: '生成订单明细，暂不付款' }).click()
    await expect(dialog).toContainText('成长版 / growth-v2 / 1')
    await dialog.getByRole('checkbox', { name: /我已核对当前待付款分项/u }).check()
    await dialog.getByRole('button', { name: /确认待付款分项/u }).click()
    await expect(dialog.getByRole('alert')).toContainText('API 请求超时')
    await expect(dialog.getByRole('button', { name: '读取原订单付款状态' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '查询原提交结果' })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: '请先读取付款请求结果' })).toBeDisabled()

    await dialog.getByRole('button', { name: '读取原订单付款状态' }).click()
    await expect(dialog.getByRole('alert')).toContainText('API 请求超时')
    await expect(dialog.getByRole('button', { name: '请先读取付款请求结果' })).toBeDisabled()
    await dialog.getByRole('button', { name: '读取原订单付款状态' }).click()
    await expect.poll(() => calls.filter(call => call.method === 'commercial.order.payment.get').length).toBe(2)
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await dialog.getByRole('checkbox', { name: /我已核对当前待付款分项/u }).check()
    await expect(dialog.getByRole('button', { name: /确认待付款分项/u })).toBeEnabled()

    // The first result is unknown. A retry must replay the original safe payment
    // request, never create a second purchase order or a new payment intent.
    await dialog.getByRole('button', { name: /确认待付款分项/u }).click()
    await expect(dialog.getByRole('link', { name: /打开 ¥2,000.00 的支付页面/u })).toHaveAttribute('href', 'https://pay.example.invalid/checkout/growth-payment-unknown-order')
    const paymentCalls = calls.filter(call => call.method === 'commercial.order.payment.create')
    expect(paymentCalls).toHaveLength(2)
    expect(paymentCalls[0].params).toEqual(paymentCalls[1].params)
    expect(paymentCalls[0].params).toMatchObject({ order_id: orderId, idempotency_key: `merchant-payment:${orderId}` })
    expect(calls.filter(call => call.method === 'commercial.order.create')).toHaveLength(1)

    await dialog.getByRole('button', { name: '查询原订单与权益状态' }).click()
    await expect(dialog).toContainText('已支付')
    expect(calls.filter(call => call.method === 'commercial.order.payment.get').map(call => call.params.order_id)).toEqual([orderId, orderId, orderId])
  } finally {
    await context.close()
  }
})
