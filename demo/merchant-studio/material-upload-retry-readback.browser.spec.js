import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_material_upload_retry_fixture'
const assetId = 'asset_material_upload_retry_fixture'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pXcAAAAASUVORK5CYII=', 'base64')
const envelope = (data, error = null) => ({ request_id: 'material-upload-retry-fixture', trace_id: 'material-upload-retry-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('material upload keeps a rejected file available for retry and reads the accepted asset back', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react()],
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'),
      'import.meta.env.MODE': JSON.stringify('test'),
    },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Material upload fixture did not bind an ephemeral TCP port')
  }

  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const uploadAttempts = []
  const assetReadbacks = []
  const asset = {
    id: assetId, workspaceId, name: 'recoverable-product-image.png', mimeType: 'image/png', sizeBytes: png.length,
    sha256: 'd'.repeat(64), scanStatus: 'unscanned', rightsStatus: 'pending', source: 'merchant_upload',
    createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
  }
  let persistedAssets = []

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== studioUrl) return route.abort('blockedbyclient')
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const request = route.request()
    const path = url.pathname
    if (path === '/api/healthz') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true } } })) })
    }
    if (path === '/api/v1/auth/session') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: { id: 'material-upload-user', login: 'material-upload@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })) })
    }
    if (path === '/api/v1/platform-accounts') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [] })) })
    }
    if (path === '/api/v1/assets/upload' && request.method() === 'POST') {
      uploadAttempts.push({
        method: request.method(),
        name: request.headers()['x-asset-name'],
        workspaceId: request.headers()['x-workspace-id'] ?? '',
      })
      if (uploadAttempts.length === 1) {
        return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'RATE_LIMITED', message: '上传请求过于频繁，请稍后重试。' })) })
      }
      persistedAssets = [asset]
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(asset)) })
    }
    if (path === '/api/v1/assets' || path === '/api/v1/assets/') {
      assetReadbacks.push(persistedAssets.map((row) => row.id))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: persistedAssets, total: persistedAssets.length, limit: 50, offset: 0 })) })
    }
    if (path === '/api/v1/brand-scopes') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ settings: {}, revision: 0, series: [], assignments: [] })) })
    }
    if (path.includes('/storage') || path.includes('/quota')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ usedBytes: 0, reservedBytes: 0, limitBytes: 1_000_000, availableBytes: 1_000_000, status: 'available' })) })
    }
    if (path === '/api/mcp') {
      const method = request.postDataJSON()?.method
      const result = method === 'workspace.metrics'
        ? { riskItems: [], stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : method === 'creative-points.balance.get' ? { balance_state: 'known', available_points: 0 }
          : method === 'billing.transactions' ? { balance_cny: '0.00', transactions: [] }
            : { items: [], total: 0, limit: 50, offset: 0 }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNMOCKED_FIXTURE_REQUEST', message: `Blocked fixture route ${path}` })) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=knowledge`, { waitUntil: 'domcontentloaded' })
    const workspace = page.getByTestId('material-library-workspace')
    await expect(workspace).toBeVisible()
    await page.getByRole('button', { name: '上传素材' }).click()
    const dialog = page.getByTestId('material-upload-dialog')
    const fileInput = dialog.locator('input[type="file"]')
    const uploadFile = { name: asset.name, mimeType: asset.mimeType, buffer: png }
    await fileInput.setInputFiles(uploadFile)
    await dialog.getByRole('button', { name: '所属系列' }).click()
    await dialog.getByRole('option', { name: '未分类' }).click()
    const confirmUpload = dialog.getByRole('button', { name: /确认上传/ })

    await confirmUpload.click()
    await expect(dialog.getByTestId('material-upload-error')).toContainText('上传请求过于频繁，请稍后重试')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(asset.name, { exact: true })).toBeVisible()
    expect(uploadAttempts).toEqual([{ method: 'POST', name: asset.name, workspaceId }])

    await confirmUpload.click()
    await expect(dialog).toHaveCount(0)
    const assetCard = workspace.locator('article').filter({ hasText: asset.name })
    await expect(assetCard).toBeVisible()
    await expect.poll(() => uploadAttempts.length).toBe(2)
    await expect.poll(() => assetReadbacks.at(-1)).toEqual([assetId])
    expect(uploadAttempts).toEqual([
      { method: 'POST', name: asset.name, workspaceId },
      { method: 'POST', name: asset.name, workspaceId },
    ])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
