import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_brand_global_toggle_readback'
const envelope = data => ({ request_id: 'brand-global-toggle', trace_id: 'brand-global-toggle', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })
const initialSettings = () => ({
  schemaVersion: 1,
  global: { enabled: true, values: {} },
  stores: { 'store-a': { enabled: true, values: { persona: '店铺画像' } } },
  series: {}, images: {},
})

test('global brand enable state is saved and restored from the workspace profile', async () => {
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
    throw new Error('Brand global toggle fixture failed to bind an ephemeral port')
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  let storedSettings = initialSettings()
  let saveCount = 0
  const respond = data => ({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/api/v1/auth/session') {
      data = { account: { id: 'brand-global-owner', login: 'owner@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/api/v1/platform-accounts') {
      data = { items: [{ platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'read_only', accountId: 'store-a', storeName: '店铺 A' }] }
    } else if (path === '/api/v1/brand-scopes' && request.method() === 'PUT') {
      saveCount += 1
      storedSettings = request.postDataJSON()?.settings ?? storedSettings
      data = { settings: storedSettings, revision: saveCount + 1, updated_at: '2026-10-11T00:01:00.000Z', series: [], assignments: [] }
    } else if (path === '/api/v1/brand-scopes') {
      data = { settings: storedSettings, revision: saveCount + 1, updated_at: saveCount ? '2026-10-11T00:01:00.000Z' : null, series: [], assignments: [] }
    } else if (path === '/api/v1/assets' || path === '/api/v1/assets/') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (path === '/api/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true } } }
    } else if (path === '/api/mcp') {
      const method = request.postDataJSON()?.method
      data = { result: method === 'creative-points.balance.get' ? { balance_state: 'known', available_points: 5 } : method === 'billing.transactions' ? { balance_cny: '0.00', transactions: [] } : method === 'workspace.metrics' ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} } : { items: [], total: 0, limit: 50, offset: 0 } }
    }
    return route.fulfill(respond(data))
  })

  try {
    await page.goto(`http://127.0.0.1:${address.port}/merchant/products?section=assets`, { waitUntil: 'domcontentloaded' })
    const panel = page.getByRole('region', { name: '品牌资产配置' })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('button', { name: '停用全局配置' })).toBeVisible()
    await panel.getByRole('button', { name: '停用全局配置' }).click()
    await page.getByRole('button', { name: '保存品牌配置' }).click()
    await expect.poll(() => saveCount).toBe(1)
    expect(storedSettings.global.enabled).toBe(false)
    expect(storedSettings.stores['store-a'].enabled).toBe(true)

    await page.reload({ waitUntil: 'domcontentloaded' })
    const restoredPanel = page.getByRole('region', { name: '品牌资产配置' })
    await expect(restoredPanel.getByRole('button', { name: '启用全局配置' })).toBeVisible()
    await expect(restoredPanel.getByRole('button', { name: '停用店铺配置' })).toBeVisible()
    expect(saveCount).toBe(1)
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
