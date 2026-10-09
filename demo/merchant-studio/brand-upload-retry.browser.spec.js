import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_brand_upload_retry_fixture'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pXcAAAAASUVORK5CYII=', 'base64')
const envelope = (data, error = null) => ({ request_id: 'brand-upload-retry', trace_id: 'brand-upload-retry', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('brand logo upload reports server refusal and allows selecting the same file again', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') { await vite.close(); throw new Error('Brand upload fixture failed to bind an ephemeral port') }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  let uploadAttempts = 0
  let releaseSuccessfulUpload
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/api/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true } } }
    else if (path === '/api/v1/auth/session') data = { account: { id: 'brand-upload-user', login: 'brand-upload@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/api/v1/platform-accounts') data = { items: [{ platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'read_only', accountId: 'brand-store', storeName: '品牌上传验收店' }] }
    else if (path === '/api/v1/brand-scopes') data = { settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} }, revision: 0, updated_at: null, series: [], assignments: [] }
    else if (path === '/api/v1/assets' || path === '/api/v1/assets/') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === '/api/mcp') {
      const method = request.postDataJSON()?.method
      data = { result: method === 'creative-points.balance.get' ? { balance_state: 'known', available_points: 10 } : method === 'billing.transactions' ? { balance_cny: '0.00', transactions: [] } : method === 'workspace.metrics' ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], taskFunnel: {}, riskSummary: { total: 0, returned: 0, truncated: false } } : { items: [], total: 0, limit: 50, offset: 0 } }
    } else if (path === '/api/v1/assets/upload') {
      uploadAttempts += 1
      if (uploadAttempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'STORAGE_UNAVAILABLE', message: '对象存储暂不可用' })) })
      await new Promise(resolve => { releaseSuccessfulUpload = resolve })
      data = { id: 'asset-brand-logo-retry', workspaceId, name: 'brand-logo.png', mimeType: 'image/png', sizeBytes: png.length, sha256: 'c'.repeat(64), scanStatus: 'unscanned', rightsStatus: 'pending', source: 'merchant_upload', createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })
  try {
    await page.goto(`http://127.0.0.1:${address.port}/merchant/products?section=assets`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('region', { name: '品牌资产配置' })).toBeVisible()
    const logoInput = page.locator('.material-brand-logo-field input[type="file"]').first()
    const logoFile = { name: 'brand-logo.png', mimeType: 'image/png', buffer: png }
    await logoInput.setInputFiles(logoFile)
    await expect(page.getByRole('alert')).toContainText('品牌素材上传失败')
    await expect(logoInput).toHaveValue('')
    await logoInput.setInputFiles(logoFile)
    await expect.poll(() => uploadAttempts).toBe(2)
    const personaInput = page.getByRole('textbox', { name: '全局用户画像' })
    await personaInput.fill('上传等待期间新增的用户画像')
    releaseSuccessfulUpload()
    await expect(page.getByRole('status').filter({ hasText: 'brand-logo.png 已上传' })).toBeVisible()
    await expect(page.getByText(/已引用素材 brand-logo\.png/).first()).toBeVisible()
    await expect(personaInput).toHaveValue('上传等待期间新增的用户画像')
    expect(uploadAttempts).toBe(2)
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
