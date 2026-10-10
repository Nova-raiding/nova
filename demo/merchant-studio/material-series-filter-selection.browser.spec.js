import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_material_series_filter'
const storeId = 'store-material-series-filter'
const assets = [
  { id: 'asset-spring-filter', name: '春季系列主图.png', mimeType: 'image/png', materialCategory: '商品主图', sizeBytes: 512, sha256: 'a'.repeat(64), scanStatus: 'clean', parseStatus: 'succeeded', rightsStatus: 'approved', rightsScope: 'owned', source: 'merchant_upload', references: [], revision: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', workspaceId },
  { id: 'asset-autumn-filter', name: '秋季系列主图.png', mimeType: 'image/png', materialCategory: '商品主图', sizeBytes: 512, sha256: 'b'.repeat(64), scanStatus: 'clean', parseStatus: 'succeeded', rightsStatus: 'approved', rightsScope: 'owned', source: 'merchant_upload', references: [], revision: 1, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', workspaceId },
]
const series = [
  { id: 'series-spring-filter', accountId: storeId, name: '春季系列', revision: 1 },
  { id: 'series-autumn-filter', accountId: storeId, name: '秋季系列', revision: 1 },
]
const envelope = (data, error = null) => ({ request_id: 'material-series-filter', trace_id: 'material-series-filter', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })
const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pXcAAAAASUVORK5CYII=', 'base64')

test('material series filter narrows the selected store and clears stale asset selection', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Material series filter fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const apiWrites = []
  const assetReads = []

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true }, platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/auth/session') {
      data = { account: { id: 'material-series-user', login: 'series@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'local-material-series-token', refresh_token: 'local-material-series-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/v1/platform-accounts') {
      data = { items: [{ platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'fixture', accountId: storeId, storeName: '系列筛选验收店', label: '系列筛选验收店' }] }
    } else if (path === '/v1/brand-scopes') {
      data = { settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} }, revision: 1, updated_at: null, series, assignments: [
        { assetId: assets[0].id, accountId: storeId, seriesId: series[0].id, revision: 1 },
        { assetId: assets[1].id, accountId: storeId, seriesId: series[1].id, revision: 1 },
      ] }
    } else if (path === '/v1/assets' || path === '/v1/assets/') {
      if (request.method() !== 'GET') apiWrites.push(`${request.method()} ${path}`)
      assetReads.push(url.search)
      data = { items: assets, total: assets.length, limit: 50, offset: 0, storage_quota: { usedBytes: 1024, reservedBytes: 0, limitBytes: 100000, availableBytes: 98976, status: 'available' } }
    } else if (/^\/v1\/assets\/[^/]+\/download$/u.test(path)) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: validPng })
    } else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      if (/\.(create|update|delete|publish|activate|sync|submit)$/u.test(String(method))) apiWrites.push(`MCP ${method}`)
      data = { result: method === 'workspace.metrics' ? { stores: [], productSummary: { total: assets.length, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} } : method === 'platform.model.status' ? { state: 'ready', capabilities: {} } : {} }
    } else if (request.method() !== 'GET') {
      apiWrites.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: `Blocked ${request.method()} ${path}` })) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=knowledge`, { waitUntil: 'domcontentloaded' })
    const workspace = page.getByTestId('material-library-workspace')
    const storeMaterials = workspace.locator('.material-store-workspace')
    const summary = storeMaterials.locator('.material-result-summary')
    const springCard = storeMaterials.locator('.material-card-grid article').filter({ hasText: '春季系列主图.png' })
    const autumnCard = storeMaterials.locator('.material-card-grid article').filter({ hasText: '秋季系列主图.png' })
    await expect(springCard).toBeVisible()
    await expect(autumnCard).toBeVisible()
    await expect(summary).toContainText('找到 2 项素材')
    const initialReads = assetReads.length
    expect(initialReads).toBeGreaterThan(0)

    await springCard.getByRole('button', { name: '选择春季系列主图.png' }).click()
    await expect(storeMaterials.locator('.material-toolbar-actions')).toContainText('已选 1 项')
    const seriesFilter = storeMaterials.getByRole('button', { name: '系列筛选' })
    await seriesFilter.click()
    await storeMaterials.getByRole('option', { name: '秋季系列', exact: true }).click()
    await expect(summary).toContainText('找到 1 项素材')
    await expect(springCard).toHaveCount(0)
    await expect(autumnCard).toBeVisible()
    await expect(storeMaterials.locator('.material-toolbar-actions')).toContainText('已选 0 项')

    await seriesFilter.click()
    await storeMaterials.getByRole('option', { name: '全部系列', exact: true }).click()
    await expect(summary).toContainText('找到 2 项素材')
    await expect(springCard).toBeVisible()
    await expect(autumnCard).toBeVisible()
    expect(assetReads).toHaveLength(initialReads)
    expect(apiWrites).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
