import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_asset_unbind_forbidden_fixture'
const productId = 'product_asset_unbind_forbidden_fixture'
const accountId = 'taobao-asset-unbind-forbidden-store'
const assetId = 'asset-protected-source'
const envelope = (data, error = null) => ({ request_id: 'asset-unbind-forbidden-fixture', trace_id: 'asset-unbind-forbidden-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })
const product = {
  id: productId, workspaceId, platform: 'taobao', accountId, storeName: '权限拒绝验证店',
  title: '不可解除素材关系商品', skuCount: 1, stock: 6, factsConfirmed: true, source: 'manual_import',
  updatedAt: '2026-10-10T00:00:00.000Z', version: 8, brandId: 'brand_unbind_forbidden_fixture', images: [], skus: [],
}
const asset = {
  id: assetId, workspaceId, name: '不可解除默认素材.png', mimeType: 'image/png', sizeBytes: 2048,
  sha256: 'c'.repeat(64), scanStatus: 'clean', rightsStatus: 'approved', rightsScope: 'owned',
  usageScopes: ['commercial', 'ai_generation'], aiModificationAllowed: true, ai_modification_allowed: true,
  scanReceiptId: 'scan-protected-source', scanReceiptDigest: 'd'.repeat(64), scanVerdict: 'clean',
  storageKey: `clean/${workspaceId}/${assetId}.png`, revision: 3, createdAt: '2026-10-10T00:00:00.000Z', references: [],
}

test('forbidden product asset unbind preserves the relation and readback state', async () => {
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
    throw new Error('Product asset permission fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const bindingReads = []
  const unbindRequests = []
  const boundIds = [assetId]

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
      data = { account: { id: 'asset-unbind-forbidden-user', login: 'asset-unbind-forbidden@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/api/v1/auth/mcp-token') {
      data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/api/v1/platform-accounts') {
      data = { items: [{ platform: 'taobao', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'fixture', accountId, storeName: '权限拒绝验证店', label: '权限拒绝验证店' }] }
    } else if (path === '/api/v1/products' || path === '/api/v1/products/') {
      data = { items: [{ ...product, sourceAssetIds: boundIds }], total: 1, limit: 50, offset: 0 }
    } else if (path === `/api/v1/products/${productId}`) {
      data = { ...product, sourceAssetIds: boundIds }
    } else if (path === `/api/v1/products/${productId}/assets` && request.method() === 'GET') {
      bindingReads.push({ workspaceId: request.headers()['x-workspace-id'] ?? '', assetIds: [...boundIds] })
      data = { items: boundIds.map((id, index) => ({ assetId: id, status: 'active', ordinal: index + 1 })), source: 'product_api' }
    } else if (path === `/api/v1/products/${productId}/assets` && request.method() === 'DELETE') {
      unbindRequests.push({ workspaceId: request.headers()['x-workspace-id'] ?? '', body: request.postDataJSON() })
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'ASSET_RELATION_FORBIDDEN', message: '当前账号无权解除该商品素材关系。请联系工作区管理员。' })) })
    } else if (path === '/api/v1/assets' || path === '/api/v1/assets/') {
      data = { items: [asset], total: 1, limit: 50, offset: 0 }
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
    await page.locator('.catalog-store-card').filter({ hasText: '权限拒绝验证店' }).getByRole('button', { name: /进入商品库/u }).click()
    await page.getByRole('button', { name: `打开${product.title}商品详情` }).click()
    await page.getByTestId('catalog-manage-product-assets').click()
    const dialog = page.getByTestId('product-asset-relation-dialog')
    const protectedRow = dialog.locator('.relation-row').filter({ hasText: asset.name })
    await expect(protectedRow).toBeVisible()
    await protectedRow.getByRole('button', { name: '解除绑定' }).click()

    const permissionError = dialog.getByTestId('product-asset-relation-write-error')
    await expect(permissionError).toContainText('当前账号无权解除该商品素材关系')
    const deniedDialog = page.getByRole('dialog', { name: '当前账号没有此操作权限' })
    await expect(deniedDialog).toContainText('服务端提示：当前账号无权解除该商品素材关系')
    await deniedDialog.getByRole('button', { name: '知道了' }).click()
    await expect(dialog.getByText('已绑定 1 份素材')).toBeVisible()
    expect(unbindRequests).toHaveLength(1)
    expect(unbindRequests[0]).toMatchObject({ workspaceId, body: { asset_id: assetId, expected_version: product.version, reason: 'Merchant Studio 解除商品素材绑定' } })

    await permissionError.getByRole('button', { name: '重新读取关系' }).click()
    await expect(permissionError).toHaveCount(0)
    await expect(dialog.getByText('已绑定 1 份素材')).toBeVisible()
    await expect(dialog.locator('.relation-row').filter({ hasText: asset.name })).toBeVisible()
    expect(bindingReads.at(-1)).toEqual({ workspaceId, assetIds: [assetId] })
    expect(unbindRequests).toHaveLength(1)
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
