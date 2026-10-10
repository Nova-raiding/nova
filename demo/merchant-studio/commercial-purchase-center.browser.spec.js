import { expect, test, chromium } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_commercial_checkout_browser'
const apiEnvelope = (data) => ({ request_id: 'commercial-checkout-browser', trace_id: 'commercial-checkout-browser', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })
test.setTimeout(60_000)

const catalog = [
  {
    id: 'onboarding-once-v1', code: 'onboarding_once', kind: 'onboarding', visibility: 'public', version: 1,
    lifecycle: 'approved', executable: true, priceFen: 50000, name: '系统接入服务', checksum: 'onboarding-v1',
    effectiveAt: '2026-01-01T00:00:00.000Z', saleState: 'on_sale', cycle: { unit: 'once' },
    benefits: [{ code: 'first_response_business_hours', quantity: 8 }], payload: {},
  },
  {
    id: 'growth-v1', code: 'growth', kind: 'monthly', visibility: 'public', version: 1,
    lifecycle: 'approved', executable: true, priceFen: 200000, name: '成长版', checksum: 'growth-v1',
    effectiveAt: '2026-01-01T00:00:00.000Z', saleState: 'on_sale', cycle: { unit: 'month', count: 1 },
    planFamily: 'standard', tierRank: 2, benefits: [{ code: 'monthly_creative_points', quantity: 5000 }], payload: {},
  },
]

const pendingOrder = (id, skuCode, skuVersionId, amountFen, name, cycle, benefits) => ({
  order_id: id, sku_code: skuCode, sku_version_id: skuVersionId, status: 'pending', amount_fen: amountFen,
  currency: 'CNY', payment_mode: 'manual_transfer', expires_at: '2099-01-01T00:00:00.000Z',
  snapshot: { name, cycle, quantity: 1, benefits },
})

test('首购先核对独立开通费与套餐快照，明确确认前不发起付款', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const mcpCalls = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname.replace(/^\/api/u, '')
    let data = {}
    if (pathname === '/v1/auth/session') data = { account: { id: 'merchant_browser', login: 'demo@example.invalid', accountType: 'merchant', displayName: '本地验收商家', enterpriseName: '本地验收企业', status: 'active', workspaceIds: [workspaceId] } }
    else if (pathname === '/v1/auth/mcp-token') data = { access_token: 'browser-fixture-access', refresh_token: 'browser-fixture-refresh', expires_in: 300 }
    else if (pathname === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (pathname === '/mcp') {
      const body = request.postDataJSON()
      mcpCalls.push({ method: body.method, params: body.params })
      if (body.method === 'commercial.catalog.get') data = { schema_version: 'commercial.catalog.v2', status: 'available', catalog }
      else if (body.method === 'commercial.subscription.get') data = { schema_version: 'commercial.subscription.v1', status: 'available', onboarding_qualified: false, current: null, future: [], packs: [], history: [], orders: [] }
      else if (body.method === 'commercial.checkout.create') data = {
        checkout_id: 'checkout-browser-1', orders: [
          pendingOrder('opening-order-1', 'onboarding_once', 'onboarding-v1', 50000, '系统接入服务', { unit: 'once' }, [{ code: 'first_response_business_hours', quantity: 8 }]),
          pendingOrder('growth-order-1', 'growth', 'growth-v1', 200000, '成长版', { unit: 'month', count: 1 }, [{ code: 'monthly_creative_points', quantity: 5000 }]),
        ],
      }
      else data = null
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(apiEnvelope({ result: data })) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(apiEnvelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/finance`, { waitUntil: 'domcontentloaded' })
    console.log('commercial checkout browser: finance page loaded')
    const center = page.getByRole('region', { name: '套餐与权益包' })
    await expect(center).toContainText('待开通；开通费与首期套餐分别计费')
    console.log('commercial checkout browser: catalog and subscription loaded')
    const growthRow = center.getByRole('row').filter({ hasText: '成长版' })
    await growthRow.getByRole('button', { name: '购买套餐' }).click()
    console.log('commercial checkout browser: growth plan selected')
    await expect(page.getByRole('dialog', { name: '确认服务端订单与付款明细' })).toBeVisible()
    await page.getByRole('button', { name: '生成订单明细，暂不付款' }).click()
    console.log('commercial checkout browser: first checkout prepared')

    const dialog = page.getByRole('dialog', { name: '确认服务端订单与付款明细' })
    await expect(dialog).toContainText('系统接入服务')
    await expect(dialog).toContainText('成长版')
    await expect(dialog).toContainText('原订单分项合计：¥2,500.00')
    await expect(dialog).toContainText('开通与套餐分别计费、分别到账')
    await expect(dialog.getByRole('button', { name: /确认待付款分项/u })).toBeDisabled()
    expect(mcpCalls.filter(call => call.method === 'commercial.checkout.create')).toHaveLength(1)
    expect(mcpCalls.filter(call => call.method === 'commercial.order.payment.create')).toHaveLength(0)
    expect(pageErrors).toEqual([])
  } finally {
    await context.close()
    await browser.close()
  }
})
