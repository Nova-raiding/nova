import { expect, test, chromium } from '@playwright/test'

/**
 * Browser-level regression for the real knowledge/material surface. The fixture
 * deliberately contains one clean image and one quarantined image: only the
 * clean row is allowed to request authenticated bytes and become an <img>.
 */
test.setTimeout(60_000)
const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4179'
const workspaceId = 'ws_image_preview_browser'
const cleanId = 'asset-browser-clean'
const quarantinedId = 'asset-browser-quarantined'
const envelope = (data, error = null) => ({ request_id: 'image-preview-browser', trace_id: 'image-preview-browser', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })
// A valid 1x1 PNG lets the production Image probe settle onload in Chromium.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

async function openKnowledge() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const downloadRequests = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname.replace(/^\/api/u, '')
    if (pathname === `/v1/assets/${cleanId}/download` || pathname === `/v1/assets/${quarantinedId}/download`) {
      downloadRequests.push(pathname)
      return route.fulfill({ status: 200, contentType: 'image/png', body: png })
    }
    let data
    if (pathname === '/v1/auth/session') data = { account: { id: 'merchant-image-browser', accountType: 'merchant', displayName: '图片预览测试商家', enterpriseName: '图片预览测试工作区', status: 'active', workspaceIds: [workspaceId] } }
    else if (pathname === '/v1/auth/mcp-token') data = { access_token: 'browser-image-token', refresh_token: 'browser-image-refresh', expires_in: 300 }
    else if (pathname === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'postgres', ready: true } }
    else if (pathname === '/v1/platform-accounts') data = { items: [{ platform: 'taobao', state: 'connected', readEnabled: true, writeEnabled: false, accountId: 'store-image-browser', storeName: '图片预览测试店' }] }
    else if (pathname === '/v1/assets') data = { items: [
      { id: cleanId, workspaceId, name: 'clean-preview.png', mimeType: 'image/png', sizeBytes: png.length, sha256: 'c'.repeat(64), scanStatus: 'clean', rightsStatus: 'approved', materialCategory: '商品主图', createdAt: '2026-10-01T00:00:00Z', sourceRevision: 1 },
      { id: quarantinedId, workspaceId, name: 'quarantined-preview.png', mimeType: 'image/png', sizeBytes: png.length, sha256: 'q'.repeat(64), scanStatus: 'quarantined', rightsStatus: 'pending', materialCategory: '商品主图', createdAt: '2026-10-01T00:00:00Z', sourceRevision: 1 },
    ], total: 2, limit: 50, offset: 0 }
    else if (pathname === '/v1/brand-scopes') data = { settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} }, revision: 0, updated_at: null, series: [], assignments: [
      { assetId: cleanId, accountId: 'store-image-browser', seriesId: null },
      { assetId: quarantinedId, accountId: 'store-image-browser', seriesId: null },
    ] }
    else if (pathname === '/v1/storage/quota') data = { usedBytes: 0, quotaBytes: 1000000 }
    else if (pathname === '/mcp') data = { result: { state: 'ready', capabilities: {} } }
    else data = { items: [], total: 0, limit: 50, offset: 0 }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })
  await page.goto(`${studioUrl}/merchant/products?section=knowledge`, { waitUntil: 'domcontentloaded' })
  return { browser, context, page, downloadRequests }
}

test('previews clean knowledge images and fails closed for quarantined images', async () => {
  const { browser, context, page, downloadRequests } = await openKnowledge()
  try {
    const cards = page.locator('.material-card-grid article')
    await expect(cards).toHaveCount(2)
    const cleanCard = cards.filter({ hasText: 'clean-preview.png' })
    const quarantinedCard = cards.filter({ hasText: 'quarantined-preview.png' })
    await expect(cleanCard.locator('img')).toHaveCount(1)
    await expect(quarantinedCard.locator('img')).toHaveCount(0)
    await expect(cleanCard.locator('.material-card-preview')).toContainText('商品主图')
    await expect(quarantinedCard.locator('.material-card-preview')).toContainText('商品主图')
    await expect.poll(() => downloadRequests).toEqual([`/v1/assets/${cleanId}/download`])
  } finally {
    await context.close(); await browser.close()
  }
})
