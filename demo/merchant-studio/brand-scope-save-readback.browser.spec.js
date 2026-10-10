import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_brand_scope_save_readback'
const envelope = data => ({ request_id: 'brand-scope-save-readback', trace_id: 'brand-scope-save-readback', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })
const settings = persona => ({
  schemaVersion: 1,
  global: { enabled: true, values: {} },
  stores: { 'store-a': { enabled: true, values: { persona } } },
  series: {}, images: {},
})

test('merchant brand scope save survives reload and reads back the persisted store draft', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Brand scope fixture failed to bind an ephemeral port')
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  let storedSettings = settings('服务端旧画像')
  let saveCount = 0
  const respond = data => ({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/api/v1/auth/session') {
      data = { account: { id: 'brand-scope-owner', login: 'owner@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/api/v1/platform-accounts') {
      data = { items: [{ platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'read_only', accountId: 'store-a', storeName: '店铺 A' }] }
    } else if (path === '/api/v1/brand-scopes' && request.method() === 'PUT') {
      saveCount += 1
      storedSettings = request.postDataJSON()?.settings ?? storedSettings
      data = { settings: storedSettings, revision: saveCount + 1, updated_at: '2026-10-10T00:01:00.000Z', series: [], assignments: [] }
    } else if (path === '/api/v1/brand-scopes') {
      data = { settings: storedSettings, revision: saveCount + 1, updated_at: saveCount ? '2026-10-10T00:01:00.000Z' : null, series: [], assignments: [] }
    } else if (path === '/api/v1/assets' || path === '/api/v1/assets/') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (path === '/api/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true } } }
    } else if (path === '/api/mcp') {
      const method = request.postDataJSON()?.method
      data = { result: method === 'creative-points.balance.get' ? { balance_state: 'known', available_points: 5 } : method === 'billing.transactions' ? { balance_cny: '0.00', transactions: [] } : method === 'workspace.metrics' ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } } : { items: [], total: 0, limit: 50, offset: 0 } }
    }
    return route.fulfill(respond(data))
  })

  try {
    const url = `http://127.0.0.1:${address.port}/merchant/products?section=assets`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const panel = page.getByRole('region', { name: '品牌资产配置' })
    const persona = page.getByRole('textbox', { name: '店铺 A用户画像' })
    await expect(panel).toBeVisible()
    await expect(persona).toHaveValue('服务端旧画像')
    await persona.fill('新确认的山野品牌画像')
    await page.getByRole('button', { name: '保存品牌配置' }).click()
    await expect.poll(() => saveCount).toBe(1)
    expect(saveCount).toBe(1)
    expect(storedSettings.stores['store-a'].values.persona).toBe('新确认的山野品牌画像')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('region', { name: '品牌资产配置' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '店铺 A用户画像' })).toHaveValue('新确认的山野品牌画像')
    expect(saveCount).toBe(1)
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
