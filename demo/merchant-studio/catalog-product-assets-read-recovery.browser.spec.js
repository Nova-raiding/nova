import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_catalog_product_assets_fixture'
const productId = 'product_catalog_assets_fixture'
const accountId = 'taobao-catalog-assets-store'
const envelope = (data, error = null) => ({ request_id: 'catalog-product-assets', trace_id: 'catalog-product-assets', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

const product = {
  id: productId, workspaceId, platform: 'taobao', accountId, storeName: '商品素材管理验收店',
  title: '商品素材管理验收商品', skuCount: 1, stock: 12, factsConfirmed: true,
  source: 'manual_import', updatedAt: '2026-10-09T00:00:00.000Z', version: 7,
  brandId: 'brand_catalog_assets_fixture', sourceAssetIds: ['asset-bound-ready'],
  images: [], skus: [],
}
const assets = [
  { id: 'asset-bound-ready', name: '已绑定可用素材.png', mimeType: 'image/png', sizeBytes: 1024, scanStatus: 'clean', rightsStatus: 'approved', rightsScope: 'owned', usageScopes: ['commercial', 'ai_generation'], aiModificationAllowed: true, ai_modification_allowed: true, references: [], revision: 1, createdAt: '2026-10-09T00:00:00.000Z' },
  { id: 'asset-candidate-ready', name: '待绑定可用素材.png', mimeType: 'image/png', sizeBytes: 2048, scanStatus: 'clean', rightsStatus: 'approved', rightsScope: 'commercial_authorized', usageScopes: ['commercial', 'ai_generation'], aiModificationAllowed: true, ai_modification_allowed: true, applicablePlatforms: ['taobao'], references: [], revision: 1, createdAt: '2026-10-09T00:00:00.000Z' },
  { id: 'asset-candidate-no-receipt', name: '缺扫描凭据素材.png', mimeType: 'image/png', sizeBytes: 768, scanStatus: 'clean', rightsStatus: 'approved', rightsScope: 'commercial_authorized', usageScopes: ['commercial', 'ai_generation'], aiModificationAllowed: true, applicablePlatforms: ['taobao'], references: [], revision: 1, createdAt: '2026-10-09T00:00:00.000Z' },
  { id: 'asset-candidate-quarantined', name: '隔离素材.png', mimeType: 'image/png', sizeBytes: 512, scanStatus: 'quarantined', rightsStatus: 'approved', references: [], revision: 1, createdAt: '2026-10-09T00:00:00.000Z' },
].map(asset => ({
  ...asset,
  workspaceId,
  sha256: 'a'.repeat(64),
  storageKey: asset.scanStatus === 'clean' ? `clean/${workspaceId}/${asset.id}.png` : `quarantine/${workspaceId}/${asset.id}.png`,
  ...(asset.scanStatus === 'clean' && asset.id !== 'asset-candidate-no-receipt' ? { scanReceiptId: `fixture-${asset.id}`, scanReceiptDigest: 'b'.repeat(64), scanVerdict: 'clean' } : {}),
  parseStatus: 'succeeded',
  contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true },
}))

test('product asset relation read failure can be retried without offering a write', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') { await vite.close(); throw new Error('Catalog product asset fixture failed to bind an ephemeral port') }

  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const unexpected = []
  const reads = []
  const writes = []
  const generationRequests = []
  let rejectNextWrite = true
  let failFirstRelationRead = true
  let boundIds = ['asset-bound-ready']
  const bindings = () => boundIds.map((assetId, index) => ({ assetId, status: 'active', ordinal: index + 1 }))

  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== studioUrl) { unexpected.push(url.href); return route.abort('blockedbyclient') }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/api/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true } } }
    else if (path === '/api/v1/auth/session') data = { account: { id: 'catalog-assets-user', login: 'catalog-assets@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/api/v1/auth/mcp-token') data = { access_token: 'catalog-assets-token', refresh_token: 'catalog-assets-refresh', expires_in: 3600, workspace_id: workspaceId }
    else if (path === '/api/v1/platform-accounts') data = { items: [{ platform: 'taobao', state: 'manually_registered', readEnabled: true, writeEnabled: false, dataMode: 'manual_upload', accountId, storeName: '商品素材管理验收店', label: '商品素材管理验收店' }] }
    else if (path === '/api/v1/products' || path === '/api/v1/products/') data = { items: [{ ...product, sourceAssetIds: boundIds }], total: 1, limit: 50, offset: 0 }
    else if (path === `/api/v1/products/${productId}`) data = { ...product, sourceAssetIds: boundIds }
    else if (path === `/api/v1/products/${productId}/assets` && request.method() === 'GET') { reads.push('GET'); if (failFirstRelationRead) { failFirstRelationRead = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'RELATION_READ_UNAVAILABLE', message: '商品素材关系暂时不可读取，请重试。' })) }) }; data = { items: bindings(), source: 'product_api' } }
    else if (path === `/api/v1/products/${productId}/assets` && ['POST', 'DELETE'].includes(request.method())) {
      const body = request.postDataJSON()
      writes.push({ method: request.method(), body })
      if (rejectNextWrite) {
        rejectNextWrite = false
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'REVISION_CONFLICT', message: '商品版本已变化，请刷新后重试。' })) })
      }
      if (request.method() === 'POST') boundIds = [...boundIds, body.asset_id]
      else boundIds = boundIds.filter(id => id !== body.asset_id)
      data = { binding: { assetId: body.asset_id, status: request.method() === 'POST' ? 'active' : 'removed', ordinal: boundIds.length }, audited: true }
    }
    else if (path === '/api/v1/assets' || path === '/api/v1/assets/') data = { items: assets, total: assets.length, limit: 50, offset: 0 }
    else if (path === '/api/v1/brand-scopes') data = { settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} }, revision: 1, updated_at: null, series: [], assignments: [] }
    else if (path === '/api/mcp' && request.method() === 'POST') {
      const method = request.postDataJSON()?.method
      if (method === 'catalog.image.generate') generationRequests.push(request.postDataJSON())
      data = { result: method === 'workspace.metrics' ? { stores: [], productSummary: { total: 1, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} } : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : { items: [], total: 0, limit: 50, offset: 0 } }
    }
    else if (request.method() !== 'GET') {
      unexpected.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_WRITE' })) })
    }
    else if (!path.startsWith('/api/v1/')) unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /^淘宝/u }).click()
    await page.getByRole('button', { name: '进入商品库' }).click()
    await page.getByRole('button', { name: `打开${product.title}商品详情` }).click()
    await page.getByTestId('catalog-manage-product-assets').click()

    const dialog = page.getByTestId('product-asset-relation-dialog')
    await expect(dialog.getByRole('alert')).toContainText('关系读取失败')
    await expect(dialog.getByRole('alert')).toContainText('读取暂不可用，请稍后重试')
    await expect(dialog.getByRole('alert')).not.toContainText('模型中转和插件连接')
    await expect(dialog.getByLabel('选择素材')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: '使用已绑定素材继续生成' })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '重新读取' })).toBeVisible()
    expect(reads).toHaveLength(1)
    expect(writes).toEqual([])

    await dialog.getByRole('button', { name: '重新读取' }).click()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(dialog.getByText('已绑定 1 份素材')).toBeVisible()
    await expect(dialog.getByLabel('选择素材')).toBeVisible()
    await expect(dialog.getByRole('option', { name: '待绑定可用素材.png' })).toHaveCount(1)
    await expect(dialog.getByRole('button', { name: '使用已绑定素材继续生成' })).toBeEnabled()
    expect(reads).toHaveLength(2)
    expect(writes).toEqual([])
    expect(generationRequests).toEqual([])
    expect(unexpected).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
