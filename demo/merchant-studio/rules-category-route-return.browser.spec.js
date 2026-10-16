import { expect, test, chromium } from '@playwright/test'

test.setTimeout(60_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_rules_category_route_fixture'
const envelope = data => ({ request_id: 'rules-category-route-fixture', trace_id: 'rules-category-route-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('merchant can inspect a category template and return to its category card', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()

  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const pathname = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (pathname === '/v1/auth/session') {
      data = { account: { id: 'rules-user', login: 'rules@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceId] } }
    } else if (pathname === '/v1/auth/mcp-token') {
      data = { access_token: 'rules-fixture-token', refresh_token: 'rules-fixture-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (pathname === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { mode: 'demo', productionGate: false, platformOperations: { mode: 'manual', ready: true, automatedWritesEnabled: false } } }
    } else if (pathname === '/v1/rules') {
      data = { items: [{ id: 'rule-jd-category', name: '京东品类字段规则', version: 'jd-category-1.0', scope: '京东', category: 'category', status: 'active', updatedAt: '2026-10-01', source: { kind: 'public', reference: '规则目录', checkedAt: '2026-10-01' } }], total: 1, limit: 50, offset: 0 }
    } else if (pathname === '/v1/catalog/categories') {
      data = [{ name: '户外防晒外套', code: '1312', fields: ['材质', '防晒指数依据', '尺码'], platforms: ['jd'], status: 'active', updatedAt: '2026-10-01' }]
    } else if (pathname === '/mcp') {
      const method = route.request().postDataJSON()?.method
      data = method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {}
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/rules?platform=jd`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: '规则库与品类库' })).toBeVisible()
    await page.getByRole('tab', { name: /^品类库/u }).click()
    const categoryCard = page.locator('.category-card').filter({ has: page.getByRole('heading', { name: '户外防晒外套' }) })
    const inspectButton = categoryCard.getByRole('button', { name: /查看类目字段模板/u })
    await inspectButton.click()
    const detail = page.getByTestId('category-mapping-detail')
    await expect(detail).toContainText('防晒指数依据')
    await expect(detail).toContainText('1312')

    await detail.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(detail).toHaveCount(0)
    await expect(inspectButton).toBeFocused()

    await page.getByRole('tab', { name: /^规则库/u }).click()
    await expect(page.getByText('京东品类字段规则')).toBeVisible()
    const serviceStatus = page.locator('[data-environment-state="demo"]')
    await expect(serviceStatus).toContainText('服务能力待核验')
    await expect(serviceStatus).not.toContainText(/demo|演示环境/iu)
  } finally {
    await context.close()
    await browser.close()
  }
})
