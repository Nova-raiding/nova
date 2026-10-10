import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_finance_pricing_entry_fixture'
const envelope = (data) => ({ request_id: 'finance-pricing-entry-fixture', trace_id: 'finance-pricing-entry-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('creative point entry opens the server catalog without starting checkout or payment', async () => {
  test.setTimeout(90_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Finance pricing entry fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const externalRequests = []
  const mcpMethods = []
  let checkoutWrites = 0

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
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
      data = { account: { id: 'finance-pricing-user', login: 'finance@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/mcp') {
      const method = route.request().postDataJSON()?.method
      mcpMethods.push(method)
      if (['commercial.checkout.create', 'commercial.order.create', 'commercial.order.payment.create', 'commercial.upgrade.quote.create', 'commercial.upgrade.order.create'].includes(method)) checkoutWrites += 1
      const result = method === 'commercial.catalog.get'
        ? { schema_version: 'commercial.catalog.v2', status: 'available', catalog: [{ id: 'growth-fixture-v1', code: 'growth', kind: 'monthly', visibility: 'public', version: 1, lifecycle: 'approved', executable: true, priceFen: 200000, name: '本地成长版', checksum: 'growth-fixture', effectiveAt: '2026-01-01T00:00:00.000Z', saleState: 'on_sale', cycle: { unit: 'month', count: 1 }, planFamily: 'standard', tierRank: 2, benefits: [{ code: 'monthly_creative_points', quantity: 5000 }], payload: {} }] }
        : method === 'commercial.subscription.get'
          ? { schema_version: 'commercial.subscription.v1', status: 'available', onboarding_qualified: true, current: null, future: [], packs: [], history: [], orders: [] }
          : method === 'commercial.entitlement.get'
            ? { schema_version: 'commercial.entitlement.v2', status: 'unknown' }
            : method === 'creative-points.balance.get' ? { available_points: 2400 }
              : method === 'creative-points.statement.list' ? { entries: [], total: 0, limit: 100, offset: 0 }
                : method === 'storage.quota.get' ? { used_bytes: 0, limit_bytes: 1073741824, available_bytes: 1073741824 }
                  : {}
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/finance`, { waitUntil: 'domcontentloaded' })
    const center = page.getByRole('region', { name: '套餐与权益包' })
    const growthRow = center.locator('tr[data-row-key="growth"]')
    await expect(growthRow).toBeVisible()
    const catalogReadsBeforeEntry = mcpMethods.filter((method) => method === 'commercial.catalog.get').length
    await page.getByRole('button', { name: '充值创意点' }).click()
    const entryDialog = page.getByRole('dialog', { name: '套餐与权益包' })
    await expect(entryDialog).toBeVisible()
    await entryDialog.getByRole('button', { name: '查看当前目录' }).click()

    await expect(entryDialog).toBeHidden()
    await expect(growthRow).toBeVisible()
    await expect.poll(() => center.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return rect.top < window.innerHeight && rect.bottom > 0
    })).toBe(true)
    expect(mcpMethods.filter((method) => method === 'commercial.catalog.get')).toHaveLength(catalogReadsBeforeEntry)
    expect(checkoutWrites).toBe(0)
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
