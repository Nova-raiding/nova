import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

test.setTimeout(120_000)

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_brand_series_recovery'
const envelope = (data, error = null) => ({
  request_id: 'brand-series-recovery',
  trace_id: 'brand-series-recovery',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error,
})

test('brand series create failure preserves the draft and retry selects the persisted series', async () => {
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
    throw new Error('Brand series fixture failed to bind an ephemeral port')
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  let createAttempts = 0
  const series = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    let status = 200
    let error = null
    if (path === '/api/v1/auth/session') {
      data = { account: { id: 'brand-series-owner', login: 'owner@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/api/v1/auth/mcp-token') {
      data = { access_token: 'brand-series-token', refresh_token: 'brand-series-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/api/v1/platform-accounts') {
      data = { items: [{ platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'read_only', accountId: 'store-series', storeName: '系列测试店' }] }
    } else if (path === '/api/v1/brand-scopes/series' && request.method() === 'POST') {
      createAttempts += 1
      if (createAttempts === 1) {
        status = 503
        error = { code: 'SERVICE_UNAVAILABLE', message: '暂时无法创建系列' }
      } else {
        const body = request.postDataJSON()
        const created = { id: 'series-autumn-2026', accountId: body.account_id, name: body.name, revision: 2 }
        series.push(created)
        data = created
      }
    } else if (path === '/api/v1/brand-scopes') {
      data = {
        settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: { 'store-series': { enabled: true, values: {} } }, series: {}, images: {} },
        revision: 1,
        updated_at: null,
        series: [...series],
        assignments: [],
      }
    } else if (path === '/api/v1/assets' || path === '/api/v1/assets/') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (path === '/api/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true } } }
    } else if (path === '/api/mcp') {
      const method = request.postDataJSON()?.method
      data = { result: method === 'creative-points.balance.get' ? { balance_state: 'known', available_points: 5 } : method === 'workspace.metrics' ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } } : {} }
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(envelope(data, error)) })
  })

  try {
    await page.goto(`http://127.0.0.1:${address.port}/merchant/products?section=assets`, { waitUntil: 'domcontentloaded' })
    const panel = page.getByRole('region', { name: '品牌资产配置' })
    await expect(panel).toBeVisible()
    await page.getByRole('button', { name: '管理系列' }).click()
    const dialog = page.getByRole('dialog', { name: '管理系列' })
    const nameInput = dialog.getByRole('textbox', { name: '新系列名称' })
    await nameInput.fill('秋冬新品')
    await dialog.getByRole('button', { name: '创建' }).click()

    await expect.poll(() => createAttempts).toBe(1)
    await expect(dialog).toBeVisible()
    await expect(nameInput).toHaveValue('秋冬新品')
    await expect(page.getByText(/创建系列失败/u)).toBeVisible()
    expect(series).toEqual([])

    await dialog.getByRole('button', { name: '创建' }).click()
    await expect.poll(() => createAttempts).toBe(2)
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '选择品牌配置系列' })).toContainText('秋冬新品')
    expect(series).toEqual([{ id: 'series-autumn-2026', accountId: 'store-series', name: '秋冬新品', revision: 2 }])
    expect(createAttempts).toBe(2)
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
