import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_brand_scope_save_retry'
const envelope = (data, error = null) => ({ request_id: 'brand-scope-save-retry', trace_id: 'brand-scope-save-retry', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })
const revokedStoreEntry = { enabled: true, values: { persona: '撤权店铺仍需保留的画像' } }
const revokedSeriesEntry = { enabled: true, values: { sellingPoints: '撤权系列仍需保留的卖点' } }
const settings = persona => ({ schemaVersion: 1, global: { enabled: true, values: {} }, stores: { 'store-retry': { enabled: true, values: { persona } }, 'store-revoked': revokedStoreEntry }, series: { 'store-revoked': { 'series-revoked': revokedSeriesEntry } }, images: {} })

test('a rejected brand profile save retains the draft for explicit retry and server readback', async () => {
  test.setTimeout(90_000)
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
    throw new Error('Brand profile save retry fixture failed to bind an ephemeral port')
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  let persisted = settings('服务端旧画像')
  let revision = 4
  let saveAttempts = 0

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== `http://127.0.0.1:${address.port}`) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/v1/auth/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: { id: 'brand-profile-owner', login: 'owner@example.invalid', accountType: 'merchant', displayName: '品牌配置验收', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })) })
    if (path === '/api/v1/auth/mcp-token') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ access_token: 'brand-profile-token', refresh_token: 'brand-profile-refresh', expires_in: 300, workspace_id: workspaceId })) })
    if (path === '/api/healthz') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true }, platformOperations: { mode: 'manual', ready: true } } })) })
    if (path === '/api/v1/platform-accounts') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [{ platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'read_only', accountId: 'store-retry', storeName: '品牌重试店铺' }, { platform: 'jd', state: 'reauth_required', readEnabled: false, writeEnabled: false, dataMode: 'read_only', accountId: 'store-revoked', storeName: '已撤权旧店铺' }] })) })
    if (path === '/api/v1/assets' || path === '/api/v1/assets/') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    if (path === '/api/v1/brand-scopes' && request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ settings: persisted, revision, updated_at: revision > 4 ? '2026-10-11T00:01:00.000Z' : null, series: [{ id: 'series-revoked', accountId: 'store-revoked', name: '旧系列' }], assignments: [] })) })
    if (path === '/api/v1/brand-scopes' && request.method() === 'PUT') {
      saveAttempts += 1
      if (saveAttempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'BRAND_SETTINGS_UNAVAILABLE', message: '本地夹具：品牌配置服务暂时不可用。' })) })
      persisted = request.postDataJSON()?.settings ?? persisted
      revision += 1
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ settings: persisted, revision, updated_at: '2026-10-11T00:02:00.000Z', series: [{ id: 'series-revoked', accountId: 'store-revoked', name: '旧系列' }], assignments: [] })) })
    }
    if (path === '/api/mcp') {
      const method = request.postDataJSON()?.method
      const result = method === 'creative-points.balance.get'
        ? { balance_state: 'known', available_points: 5 }
        : method === 'billing.transactions'
          ? { balance_cny: '0.00', transactions: [] }
          : method === 'workspace.metrics'
            ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } }
            : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : { items: [], total: 0, limit: 50, offset: 0 }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
    }
    if (request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: `Blocked ${request.method()} ${path}` })) })
  })

  try {
    await page.goto(`http://127.0.0.1:${address.port}/merchant/products?section=assets`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const panel = page.getByRole('region', { name: '品牌资产配置' })
    const persona = page.getByRole('textbox', { name: '品牌重试店铺用户画像' })
    const save = page.getByRole('button', { name: '保存品牌配置' })
    await expect(panel).toBeVisible({ timeout: 15_000 })
    await expect(persona).toHaveValue('服务端旧画像')
    await persona.fill('显式重试后确认的新画像')
    await save.click()
    await expect(page.getByRole('status').filter({ hasText: '品牌配置保存失败' })).toBeVisible()
    await expect(persona).toHaveValue('显式重试后确认的新画像')
    expect(saveAttempts).toBe(1)
    expect(persisted.stores['store-retry'].values.persona).toBe('服务端旧画像')

    await save.click()
    await expect(page.getByRole('status').filter({ hasText: '已保存第 5 版' })).toBeVisible()
    expect(saveAttempts).toBe(2)
    expect(persisted.stores['store-retry'].values.persona).toBe('显式重试后确认的新画像')
    expect(persisted.stores['store-revoked']).toEqual(revokedStoreEntry)
    expect(persisted.series['store-revoked']).toEqual({ 'series-revoked': revokedSeriesEntry })
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    await expect(page.getByRole('region', { name: '品牌资产配置' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '品牌重试店铺用户画像' })).toHaveValue('显式重试后确认的新画像')
    expect(saveAttempts).toBe(2)
    expect(externalRequests).toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
