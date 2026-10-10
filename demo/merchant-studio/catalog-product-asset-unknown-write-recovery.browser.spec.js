import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_product_asset_unknown_fixture'
const productId = 'product_asset_unknown_fixture'
const accountId = 'taobao-asset-unknown-store'
const existingAssetId = 'asset-existing-source'
const candidateAssetId = 'asset-reconcile-after-503'
const envelope = (data, error = null) => ({ request_id: 'product-asset-unknown-fixture', trace_id: 'product-asset-unknown-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

const product = {
  id: productId, workspaceId, platform: 'taobao', accountId, storeName: '素材回读测试店',
  title: '关系未知结果测试商品', skuCount: 1, stock: 7, factsConfirmed: true,
  source: 'manual_import', updatedAt: '2026-10-10T00:00:00.000Z', version: 5,
  brandId: 'brand_asset_unknown_fixture', images: [], skus: [],
}
const assets = [existingAssetId, candidateAssetId].map((id) => ({
  id, workspaceId, name: `${id}.png`, mimeType: 'image/png', sizeBytes: 1024,
  sha256: 'a'.repeat(64), scanStatus: 'clean', rightsStatus: 'approved', rightsScope: 'owned',
  usageScopes: ['commercial', 'ai_generation'], aiModificationAllowed: true, ai_modification_allowed: true,
  scanReceiptId: `scan-${id}`, scanReceiptDigest: 'b'.repeat(64), scanVerdict: 'clean', storageKey: `clean/${workspaceId}/${id}.png`,
  revision: 1, createdAt: '2026-10-10T00:00:00.000Z', references: [],
}))

test('unknown product asset binding result is reconciled by readback before another write', async () => {
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
    throw new Error('Product asset recovery fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  let boundIds = [existingAssetId]
  let bindingAcceptedButResponseLost = true
  const bindingReads = []
  const bindingWrites = []

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== studioUrl) return route.abort('blockedbyclient')
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/api/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true } } }
    } else if (path === '/api/v1/auth/session') {
      data = { account: { id: 'product-asset-unknown-user', login: 'asset-unknown@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/api/v1/auth/mcp-token') {
      data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/api/v1/platform-accounts') {
      data = { items: [{ platform: 'taobao', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'fixture', accountId, storeName: '素材回读测试店', label: '素材回读测试店' }] }
    } else if (path === '/api/v1/products' || path === '/api/v1/products/') {
      data = { items: [{ ...product, sourceAssetIds: boundIds }], total: 1, limit: 50, offset: 0 }
    } else if (path === `/api/v1/products/${productId}`) {
      data = { ...product, sourceAssetIds: boundIds }
    } else if (path === `/api/v1/products/${productId}/assets` && request.method() === 'GET') {
      bindingReads.push({ workspaceId: request.headers()['x-workspace-id'] ?? '', assetIds: [...boundIds] })
      data = { items: boundIds.map((assetId, index) => ({ assetId, status: 'active', ordinal: index + 1 })), source: 'product_api' }
    } else if (path === `/api/v1/products/${productId}/assets` && request.method() === 'POST') {
      const body = request.postDataJSON()
      bindingWrites.push({ workspaceId: request.headers()['x-workspace-id'] ?? '', body })
      if (!boundIds.includes(body.asset_id)) boundIds = [...boundIds, body.asset_id]
      if (bindingAcceptedButResponseLost) {
        bindingAcceptedButResponseLost = false
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '响应暂不可用' })) })
      }
      data = { binding: { assetId: body.asset_id, status: 'active', ordinal: boundIds.length }, audited: true }
    } else if (path === '/api/v1/assets' || path === '/api/v1/assets/') {
      data = { items: assets, total: assets.length, limit: 50, offset: 0 }
    } else if (path === '/api/v1/brand-scopes') {
      data = { settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} }, revision: 1, updated_at: null, series: [], assignments: [] }
    } else if (path === '/api/mcp') {
      const method = request.postDataJSON()?.method
      data = { result: method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 1, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    } else if (request.method() !== 'GET') {
      return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_WRITE', message: `Blocked ${request.method()} ${path}` })) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /^淘宝/u }).click()
    await page.locator('.catalog-store-card').filter({ hasText: '素材回读测试店' }).getByRole('button', { name: /进入商品库/u }).click()
    await page.getByRole('button', { name: `打开${product.title}商品详情` }).click()
    await page.getByTestId('catalog-manage-product-assets').click()
    const dialog = page.getByTestId('product-asset-relation-dialog')
    await expect(dialog.getByText('已绑定 1 份素材')).toBeVisible()
    await dialog.getByLabel('选择素材').selectOption(candidateAssetId)
    await dialog.getByRole('button', { name: '绑定素材', exact: true }).click()

    const writeError = dialog.getByTestId('product-asset-relation-write-error')
    await expect(writeError).toContainText('服务暂不可用')
    await expect(writeError).toContainText('可能未包含这次变更')
    await expect(dialog.getByText('已绑定 1 份素材')).toBeVisible()
    expect(bindingWrites).toHaveLength(1)

    await writeError.getByRole('button', { name: '重新读取关系' }).click()
    await expect(writeError).toHaveCount(0)
    await expect(dialog.getByText('已绑定 2 份素材')).toBeVisible()
    await expect(dialog.locator('.relation-row').filter({ hasText: `${candidateAssetId}.png` })).toBeVisible()
    await expect(dialog.getByRole('option', { name: `${candidateAssetId}.png` })).toHaveCount(0)
    expect(bindingReads.at(-1)).toEqual({ workspaceId, assetIds: [existingAssetId, candidateAssetId] })
    expect(bindingWrites[0]?.workspaceId).toBe(workspaceId)
    expect(bindingWrites).toHaveLength(1)
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
