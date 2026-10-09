import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_material_preview_fixture'
const validAssetId = 'asset-real-decode-fixture'
const invalidAssetId = 'asset-undecodable-fixture'
test.setTimeout(90_000)

// Chromium—not a mocked Image implementation—must decode these bytes after
// the authenticated download and object-URL handoff.
const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pXcAAAAASUVORK5CYII=',
  'base64',
)

const envelope = (data) => ({
  request_id: 'material-preview-browser-fixture',
  trace_id: 'material-preview-browser-fixture',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
})

test('downloads, decodes, and renders server-backed material previews in the real browser UI', async () => {
  // Own an ephemeral local app server. Never attach this browser fixture to a
  // developer's fixed-port service or SSH tunnel.
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
    throw new Error('Local Merchant Studio fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addCookies([{ name: 'preview-auth-fixture', value: 'same-origin-session', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }])
  const page = await context.newPage()
  const downloads = []
  const revokedObjectUrls = []
  await page.addInitScript(() => {
    const revoke = URL.revokeObjectURL.bind(URL)
    window.__revokedMaterialPreviewUrls = []
    URL.revokeObjectURL = (url) => {
      window.__revokedMaterialPreviewUrls.push(url)
      return revoke(url)
    }
  })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === '/api/healthz') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true },
        setup: { objectStorage: { configured: true } },
      })) })
    }
    if (path === '/api/v1/auth/session') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: {
        id: 'material-preview-browser-user', login: 'preview-fixture@example.invalid', accountType: 'merchant',
        status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId],
      } })) })
    }
    if (path === '/api/v1/assets' || path === '/api/v1/assets/') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        items: [
          { id: validAssetId, workspaceId, name: '真实解码样图.png', mimeType: 'image/png', sizeBytes: validPng.byteLength,
            sha256: 'a'.repeat(64), scanStatus: 'clean', rightsStatus: 'approved', source: 'merchant_upload',
            createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' },
          { id: invalidAssetId, workspaceId, name: '损坏图片.png', mimeType: 'image/png', sizeBytes: 8,
            sha256: 'b'.repeat(64), scanStatus: 'clean', rightsStatus: 'approved', source: 'merchant_upload',
            createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' },
        ], total: 2, limit: 50, offset: 0,
      })) })
    }
    const download = /^\/api\/v1\/assets\/([^/]+)\/download$/u.exec(path)
    if (download) {
      const assetId = decodeURIComponent(download[1])
      downloads.push({ assetId, cookie: request.headers().cookie ?? '', accept: request.headers().accept })
      if (assetId === validAssetId) {
        return route.fulfill({ status: 200, contentType: 'image/png', body: validPng })
      }
      if (assetId === invalidAssetId) {
        return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('not-an-image') })
      }
    }
    // Fail closed for accidental service calls; nonessential workspace reads
    // receive an explicit empty fixture result, never a real request.
    if (path.startsWith('/api/v1/')) {
      const empty = path.includes('brand-scopes')
        ? { settings: {}, revision: 0, series: [], assignments: [] }
        : path.includes('storage') || path.includes('quota')
          ? { usedBytes: 0, reservedBytes: 0, limitBytes: 0, availableBytes: 0, status: 'unavailable' }
          : { items: [], total: 0, limit: 50, offset: 0 }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(empty)) })
    }
    return route.fulfill({ status: 404, body: 'unexpected local fixture request' })
  })

  try {
    page.on('console', (message) => console.log(`BROWSER_CONSOLE ${message.type()} ${message.text()}`))
    page.on('pageerror', (error) => console.log(`BROWSER_PAGE_ERROR ${error.message}`))
    page.on('requestfailed', (request) => console.log(`BROWSER_REQUEST_FAILED ${request.url()} ${request.failure()?.errorText}`))
    await page.goto(`${studioUrl}/merchant/products?section=knowledge`, { waitUntil: 'domcontentloaded' })
    const workspace = page.getByTestId('material-library-workspace')
    await expect(workspace).toBeVisible()

    const validCard = workspace.locator('article').filter({ hasText: '真实解码样图.png' })
    const renderedThumbnail = validCard.locator('.material-card-open img')
    await expect(renderedThumbnail).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => renderedThumbnail.evaluate((image) => image.naturalWidth)).toBe(1)
    const thumbnailUrl = await renderedThumbnail.getAttribute('src')
    expect(thumbnailUrl).toMatch(/^blob:/u)

    const invalidCard = workspace.locator('article').filter({ hasText: '损坏图片.png' })
    await expect(invalidCard.locator('.material-card-open img')).toHaveCount(0)
    await expect(invalidCard.locator('.material-card-open svg')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__revokedMaterialPreviewUrls.length)).toBeGreaterThan(0)

    await validCard.getByRole('button', { name: '查看真实解码样图.png详情' }).click()
    const detailImage = page.locator('.material-detail-preview img')
    await expect(detailImage).toBeVisible()
    await expect.poll(() => detailImage.evaluate((image) => image.naturalWidth)).toBe(1)
    await page.getByRole('button', { name: '放大真实解码样图.png' }).click()
    const lightboxImage = page.locator('.material-upload-lightbox img')
    await expect(lightboxImage).toBeVisible()
    await expect.poll(() => lightboxImage.evaluate((image) => image.naturalWidth)).toBe(1)
    await page.getByRole('button', { name: '关闭素材图片预览' }).click()
    await expect(page.getByRole('button', { name: `放大${'真实解码样图.png'}` })).toBeFocused()

    // The nested upload preview is dismissible from the keyboard, and the
    // containing dialog keeps its focus rather than dropping it to the page.
    await page.getByRole('button', { name: '返回素材库' }).click()
    await expect(workspace).toBeVisible()
    await page.getByRole('button', { name: '上传素材' }).click()
    const uploadDialog = page.getByTestId('material-upload-dialog')
    await uploadDialog.locator('input[type="file"]').setInputFiles([
      { name: '待上传预览.png', mimeType: 'image/png', buffer: validPng },
      { name: '第二张待上传预览.png', mimeType: 'image/png', buffer: validPng },
    ])
    await uploadDialog.getByRole('button', { name: '预览待上传预览.png' }).click()
    await expect(page.getByRole('button', { name: '关闭素材预览' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '关闭素材预览' })).toHaveCount(0)
    await expect(uploadDialog).toBeVisible()
    await expect(uploadDialog.getByRole('button', { name: '预览待上传预览.png' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(uploadDialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '上传素材' })).toBeFocused()

    expect(downloads.map(({ assetId }) => assetId).sort()).toEqual([invalidAssetId, validAssetId].sort())
    expect(downloads.every(({ accept }) => accept === 'application/octet-stream')).toBe(true)
    expect(downloads.every(({ cookie }) => cookie.includes('preview-auth-fixture=same-origin-session'))).toBe(true)
    revokedObjectUrls.push(...await page.evaluate(() => window.__revokedMaterialPreviewUrls))
    expect(revokedObjectUrls.length).toBeGreaterThan(0)
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
