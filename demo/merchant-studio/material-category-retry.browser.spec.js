import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_material_category_retry'
const assetId = 'asset_material_category_retry'
const accountId = 'store-material-category-retry'
const name = '分类重试样图.png'
const envelope = (data, error = null) => ({ request_id: 'material-category-retry', trace_id: 'material-category-retry', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('a failed material category update preserves the old value for retry and readback', async () => {
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
    throw new Error('Material category fixture failed to bind an ephemeral port')
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const metadataWrites = []
  let asset = {
    id: assetId, workspaceId, name, mimeType: 'image/png', materialCategory: '未分类', sizeBytes: 512,
    sha256: 'e'.repeat(64), scanStatus: 'clean', rightsStatus: 'approved', source: 'merchant_upload',
    contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true },
    references: [], parseStatus: 'succeeded', revision: 3, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z',
  }

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== `http://127.0.0.1:${address.port}`) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/v1/auth/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: { id: 'material-category-owner', login: 'owner@example.invalid', accountType: 'merchant', displayName: '素材分类验收', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })) })
    if (path === '/api/v1/auth/mcp-token') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ access_token: 'material-category-token', refresh_token: 'material-category-refresh', expires_in: 300, workspace_id: workspaceId })) })
    if (path === '/api/healthz') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true }, platformOperations: { mode: 'manual', ready: true } } })) })
    if (path === '/api/v1/platform-accounts') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [{ platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'read_only', accountId, storeName: '分类验收店铺' }] })) })
    if (path === '/api/v1/brand-scopes') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} }, revision: 3, updated_at: null, series: [], assignments: [{ assetId, accountId, seriesId: null, revision: 1 }] })) })
    if (path === '/api/v1/assets' || path === '/api/v1/assets/') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [asset], total: 1, limit: 50, offset: 0 })) })
    if (path === `/api/v1/assets/${assetId}/metadata` && request.method() === 'PUT') {
      const body = request.postDataJSON()
      metadataWrites.push(body)
      if (metadataWrites.length === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'ASSET_METADATA_TEMPORARY_UNAVAILABLE', message: '本地夹具：素材分类服务暂时不可用。' })) })
      asset = { ...asset, materialCategory: body.material_category, revision: asset.revision + 1, updatedAt: '2026-10-11T00:02:00.000Z' }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(asset)) })
    }
    if (path === '/api/mcp') {
      const method = request.postDataJSON()?.method
      const result = method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } }
        : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {}
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
    }
    if (request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: `Blocked ${request.method()} ${path}` })) })
  })

  try {
    await page.goto(`http://127.0.0.1:${address.port}/merchant/products?section=knowledge`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const workspace = page.getByTestId('material-library-workspace')
    const card = workspace.locator('article').filter({ hasText: name })
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: `查看${name}详情` }).click()
    const category = page.getByRole('button', { name: `修改${name}的素材分类` })
    await expect(category).toHaveAttribute('title', '未分类')

    await category.click()
    await page.getByRole('option', { name: '商品主图' }).click()
    await expect(page.getByRole('alert').filter({ hasText: '素材分类保存失败' })).toBeVisible()
    await expect(category).toHaveAttribute('title', '未分类')
    expect(metadataWrites).toEqual([{ material_category: '商品主图', expected_revision: 3 }])
    expect(asset.materialCategory).toBe('未分类')

    await category.click()
    await page.getByRole('option', { name: '商品主图' }).click()
    await expect(category).toHaveAttribute('title', '商品主图')
    expect(metadataWrites).toEqual([
      { material_category: '商品主图', expected_revision: 3 },
      { material_category: '商品主图', expected_revision: 3 },
    ])
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    const refreshedCard = page.getByTestId('material-library-workspace').locator('article').filter({ hasText: name })
    await refreshedCard.getByRole('button', { name: `查看${name}详情` }).click()
    await expect(page.getByRole('button', { name: `修改${name}的素材分类` })).toHaveAttribute('title', '商品主图')
    expect(metadataWrites).toHaveLength(2)
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
