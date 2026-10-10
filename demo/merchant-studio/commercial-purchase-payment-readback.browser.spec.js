import { expect, test, chromium } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_commercial_payment_readback_fixture'
const envelope = data => ({ request_id: 'commercial-payment-readback', trace_id: 'commercial-payment-readback', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

const catalog = [{
  id: 'growth-payment-v2', code: 'growth', kind: 'monthly', visibility: 'public', version: 2,
  lifecycle: 'approved', executable: true, priceFen: 200000, name: '成长版', checksum: 'growth-v2',
  effectiveAt: '2026-01-01T00:00:00.000Z', saleState: 'on_sale', cycle: { unit: 'month', count: 1 },
  planFamily: 'standard', tierRank: 2, benefits: [{ code: 'monthly_creative_points', quantity: 5000 }], payload: {},
}]

const pendingOrder = {
  order_id: 'growth-payment-order-1', sku_code: 'growth', sku_version_id: 'growth-v2', status: 'pending',
  amount_fen: 200000, currency: 'CNY', payment_mode: 'manual_transfer', expires_at: '2099-01-01T00:00:00.000Z',
  snapshot: { name: '成长版', cycle: { unit: 'month', count: 1 }, quantity: 1, benefits: [{ code: 'monthly_creative_points', quantity: 5000 }] },
  transfer_instructions: { receiver_name: '演示收款主体', receiving_account: 'MOCK-ACCOUNT-001', bank_name: '演示银行', reference: 'growth-payment-order-1', warning: '仅展示本地模拟收款指引；请勿转账。' },
}

const activePortfolio = {
  schema_version: 'commercial.subscription.v1', status: 'available', onboarding_qualified: true,
  current: { id: 'active-growth-1', sourceOrderId: pendingOrder.order_id, skuCode: 'growth', catalogVersionId: 'growth-v2', periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-01T00:00:00.000Z', periodStatus: 'active', resolvedBenefits: [{ code: 'monthly_creative_points', quantity: 5000 }], executable: true, plan_family: 'standard', tier_rank: 2 },
  future: [], packs: [], history: [], orders: [{ order_id: pendingOrder.order_id, status: 'paid' }],
}

test.setTimeout(60_000)

test('套餐购买弹窗可取消且不下单，确认模拟转账指引后按原订单权威回读激活状态', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const calls = []
  const unknownRequests = []
  const pageErrors = []
  let orderCreated = false
  let subscriptionReads = 0
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname.replace(/^\/api/u, '')
    let data = {}
    if (pathname === '/v1/auth/session') {
      data = { account: { id: 'merchant-payment-readback', login: 'payment-readback@example.invalid', accountType: 'merchant', displayName: '付款回读验收商家', enterpriseName: '本地模拟工作区', status: 'active', workspaceIds: [workspaceId] } }
    } else if (pathname === '/v1/auth/mcp-token') {
      data = { access_token: 'local-payment-readback-token', refresh_token: 'local-payment-readback-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (pathname === '/healthz') {
      data = { status: 'ok', writesEnabled: true, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (pathname === '/v1/assets') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (pathname === '/mcp') {
      const body = request.postDataJSON()
      calls.push({ method: body.method, params: body.params })
      if (body.method === 'commercial.catalog.get') data = { schema_version: 'commercial.catalog.v2', status: 'available', catalog }
      else if (body.method === 'commercial.subscription.get') {
        subscriptionReads += 1
        data = orderCreated ? activePortfolio : { schema_version: 'commercial.subscription.v1', status: 'available', onboarding_qualified: true, current: null, future: [], packs: [], history: [], orders: [] }
      } else if (body.method === 'commercial.order.create') {
        orderCreated = true
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ...envelope(null), error: { code: 'UPSTREAM_TIMEOUT', message: '模拟提交已落库但响应丢失' } }) })
      } else if (body.method === 'commercial.order.request.get') {
        data = orderCreated ? pendingOrder : null
      } else if (body.method === 'commercial.order.payment.get') {
        data = { ...pendingOrder, status: 'paid' }
      } else if (body.method === 'commercial.order.payment.create') {
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ...envelope(null), error: { code: 'FIXTURE_PAYMENT_CREATE_BLOCKED', message: 'Manual transfer must not create a provider payment request.' } }) })
      } else if (body.method === 'workspace.metrics') data = { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } }
      else if (body.method === 'platform.model.status') data = { state: 'ready', capabilities: { image_generation: false } }
      else if (body.method === 'creative-points.balance.get') data = { available_points: 0, balance_state: 'known' }
      else if (body.method === 'billing.transactions') data = { balance_cny: '0.00', transactions: [] }
      else data = {}
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: data })) })
    } else {
      unknownRequests.push(`${request.method()} ${pathname}`)
      return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ ...envelope(null), error: { code: 'FIXTURE_UNKNOWN_REQUEST', message: 'Unmocked local API request blocked.' } }) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/finance`, { waitUntil: 'domcontentloaded' })
    const center = page.getByRole('region', { name: '套餐与权益包' })
    const growthRow = center.getByRole('row').filter({ hasText: '成长版' })
    await growthRow.getByRole('button', { name: '购买套餐' }).click()
    await expect(page.getByRole('dialog', { name: '确认服务端订单与付款明细' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '确认服务端订单与付款明细' })).toHaveCount(0)
    expect(calls.filter(call => call.method === 'commercial.order.create')).toHaveLength(0)

    await growthRow.getByRole('button', { name: '购买套餐' }).click()
    const dialog = page.getByRole('dialog', { name: '确认服务端订单与付款明细' })
    await dialog.getByRole('button', { name: '生成订单明细，暂不付款' }).click()
    await expect(dialog.getByRole('alert')).toContainText('操作未确认完成')
    await dialog.getByRole('button', { name: '查询原提交结果' }).click()
    await expect(dialog).toContainText('成长版 / growth-v2 / 1')
    await expect(dialog).toContainText('原订单分项合计：¥2,000.00')
    await expect(dialog.getByRole('button', { name: '确认待付款分项 ¥2,000.00' })).toBeDisabled()
    expect(calls.filter(call => call.method === 'commercial.order.create')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'commercial.order.request.get')).toHaveLength(1)
    expect(calls.find(call => call.method === 'commercial.order.request.get').params.idempotency_key).toBe(calls.find(call => call.method === 'commercial.order.create').params.idempotency_key)

    await dialog.getByRole('checkbox', { name: /我已核对当前待付款分项/u }).check()
    await dialog.getByRole('button', { name: '确认待付款分项 ¥2,000.00' }).click()
    await expect(dialog).toContainText('演示收款主体')
    await expect(dialog).toContainText('MOCK-ACCOUNT-001')
    await expect(dialog).toContainText('仅展示本地模拟收款指引；请勿转账。')
    expect(calls.filter(call => call.method === 'commercial.order.payment.create')).toHaveLength(0)

    await dialog.getByRole('button', { name: '查询原订单与权益状态' }).click()
    await expect(dialog).toContainText('已支付')
    await expect.poll(() => subscriptionReads).toBeGreaterThan(1)
    await expect(center.getByRole('tab', { name: '当前套餐' })).toBeVisible()
    await expect(center).toContainText('成长版')
    expect(calls.filter(call => call.method === 'commercial.order.payment.get').map(call => call.params.order_id)).toEqual([pendingOrder.order_id])
    expect(calls.filter(call => call.method === 'commercial.order.create')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'commercial.order.payment.create')).toHaveLength(0)
    expect(unknownRequests).toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    await context.close()
    await browser.close()
  }
})
