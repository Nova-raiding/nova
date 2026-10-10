import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_material_preview_fixture'
const validAssetId = 'asset-real-decode-fixture'
const invalidAssetId = 'asset-undecodable-fixture'
const trashedAssetId = 'asset-recycle-preview-fixture'
const restoreFailureAssetId = 'asset-recycle-restore-failure'
const purgeAssetId = 'asset-recycle-purge-fixture'
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
  const restoreRequests = []
  const purgeRequests = []
  const cancelPurgeRequests = []
  let assetListReadCount = 0
  const trashRecord = (id, name, state = {}) => ({
    asset: { id, workspaceId, name, mimeType: 'image/png', sizeBytes: validPng.byteLength,
      sha256: 'c'.repeat(64), scanStatus: 'clean', rightsStatus: 'approved', source: 'merchant_upload',
      createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' },
    deleted_at: '2026-10-08T00:00:00.000Z', expires_at: '2026-11-07T00:00:00.000Z',
    deleted_by: 'fixture-user', revision: 1, ...state,
  })
  const trashRows = [
    trashRecord(trashedAssetId, '已删除样图.png'),
    trashRecord(restoreFailureAssetId, '恢复失败样图.png'),
    trashRecord(purgeAssetId, '清理请求样图.png'),
  ]
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
      assetListReadCount += 1
      if (assetListReadCount === 1) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
          request_id: 'material-preview-list-unavailable',
          error: { code: 'TEMPORARY_UNAVAILABLE', message: '素材列表暂时不可用' },
        }) })
      }
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
    if (path === '/api/v1/assets/trash') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        items: trashRows,
        total: trashRows.length, limit: 50, offset: 0,
      })) })
    }
    const trashAction = /^\/api\/v1\/assets\/([^/]+)\/(restore|purge|purge\/cancel)$/u.exec(path)
    if (trashAction && request.method() === 'POST') {
      const assetId = decodeURIComponent(trashAction[1])
      const action = trashAction[2]
      if (action === 'restore') {
        restoreRequests.push(assetId)
        if (assetId === restoreFailureAssetId) {
          return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
            data: null, error: { code: 'REVISION_CONFLICT', message: '素材版本已变化，请重新读取后重试。' },
          }) })
        }
        const index = trashRows.findIndex((row) => row.asset.id === assetId)
        if (index >= 0) trashRows.splice(index, 1)
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ id: assetId })) })
      }
      if (action === 'purge') {
        const body = request.postDataJSON()
        purgeRequests.push({ assetId, body })
        if (assetId === restoreFailureAssetId) {
          return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
            data: null, error: { code: 'REVISION_CONFLICT', message: '素材版本已变化，请重新读取后重试。' },
          }) })
        }
        const row = trashRows.find((item) => item.asset.id === assetId)
        if (row) { row.purge_requested_at = '2026-10-09T00:00:00.000Z'; row.revision += 1 }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ asset_id: assetId, status: 'purge_queued' })) })
      }
      cancelPurgeRequests.push(assetId)
      const row = trashRows.find((item) => item.asset.id === assetId)
      if (row) { delete row.purge_requested_at; row.revision += 1 }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ asset_id: assetId, status: 'purge_cancelled' })) })
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
    page.on('response', (response) => {
      if (response.status() >= 400) console.log(`BROWSER_HTTP_ERROR ${response.status()} ${response.request().method()} ${response.url()}`)
    })
    await page.goto(`${studioUrl}/merchant/products?section=knowledge`, { waitUntil: 'domcontentloaded' })
    const workspace = page.getByTestId('material-library-workspace')
    await expect(workspace).toBeVisible()
    await expect(workspace.locator('.material-empty[role="alert"]')).toContainText('素材读取失败')
    const retryAssetRead = workspace.getByRole('button', { name: '重新读取素材' })
    await retryAssetRead.click()
    await expect(workspace.locator('.material-empty[role="alert"]')).toHaveCount(0)
    await expect.poll(() => assetListReadCount).toBe(2)

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
    revokedObjectUrls.push(...await page.evaluate(() => window.__revokedMaterialPreviewUrls))
    expect(revokedObjectUrls.length).toBeGreaterThan(0)

    await page.goto(`${studioUrl}/merchant/products?section=trash`, { waitUntil: 'domcontentloaded' })
    const recycleBin = page.getByTestId('material-recycle-bin')
    await expect(recycleBin).toBeVisible()
    const recyclePreviewTrigger = recycleBin.getByRole('button', { name: '放大已删除样图.png' })
    await recyclePreviewTrigger.click()
    const recyclePreviewDialog = page.getByRole('dialog', { name: '素材预览：已删除样图.png' })
    await expect(recyclePreviewDialog).toBeVisible()
    await expect(recyclePreviewDialog).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(recyclePreviewDialog).toHaveCount(0)
    await expect(recyclePreviewTrigger).toBeFocused()

    await recycleBin.getByRole('button', { name: '选择已删除样图.png' }).click()
    await recycleBin.getByRole('button', { name: '选择恢复失败样图.png' }).click()
    await recycleBin.getByRole('button', { name: '恢复', exact: true }).click()
    await expect(recycleBin.locator('article').filter({ hasText: '已删除样图.png' })).toHaveCount(0)
    await expect(recycleBin.locator('article').filter({ hasText: '恢复失败样图.png' })).toBeVisible()
    await expect(recycleBin.getByRole('alert')).toContainText('版本已变化')
    expect(restoreRequests.sort()).toEqual([restoreFailureAssetId, trashedAssetId].sort())

    await recycleBin.getByRole('button', { name: '选择清理请求样图.png' }).click()
    const purgeTrigger = recycleBin.getByRole('button', { name: '彻底删除' })
    await purgeTrigger.click()
    const purgeDialog = page.getByRole('alertdialog', { name: '提前彻底删除素材' })
    const submitPurge = purgeDialog.getByRole('button', { name: '提交清理请求' })
    const reasonField = purgeDialog.getByLabel('删除原因')
    const confirmationField = purgeDialog.getByLabel('输入“彻底删除”确认')
    const cancelPurge = purgeDialog.getByRole('button', { name: '取消' })
    await expect(reasonField).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(cancelPurge).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(reasonField).toBeFocused()
    await reasonField.fill('商家请求提前清理，隔离浏览器验收')
    await page.keyboard.press('Tab')
    await expect(confirmationField).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(cancelPurge).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(purgeDialog).toHaveCount(0)
    await expect(purgeTrigger).toBeFocused()
    await purgeTrigger.click()
    await expect(reasonField).toBeFocused()
    await expect(submitPurge).toBeDisabled()
    await reasonField.fill('商家请求提前清理，隔离浏览器验收')
    await expect(submitPurge).toBeDisabled()
    await confirmationField.fill('确认')
    await expect(submitPurge).toBeDisabled()
    await confirmationField.fill('彻底删除')
    await expect(submitPurge).toBeEnabled()
    await submitPurge.click()
    await expect(purgeDialog).toBeVisible()
    await expect(recycleBin.getByRole('alert')).toContainText('版本已变化')
    await expect(recycleBin.locator('article').filter({ hasText: '对象存储清理处理中' })).toBeVisible()
    await expect(recycleBin.getByRole('button', { name: '选择恢复失败样图.png' })).toHaveAttribute('aria-pressed', 'true')
    expect(purgeRequests).toHaveLength(2)
    expect(purgeRequests.find(({ assetId }) => assetId === purgeAssetId)).toMatchObject({ body: {
      confirm_asset_name: '清理请求样图.png', reason: '商家请求提前清理，隔离浏览器验收', expected_revision: 1,
    } })

    await cancelPurge.click()
    await expect(purgeDialog).toHaveCount(0)
    await expect(purgeTrigger).toBeFocused()
    const purgeArticle = recycleBin.locator('article').filter({ hasText: '清理请求样图.png' })
    await purgeArticle.getByRole('button', { name: '撤销请求' }).click()
    await expect(purgeArticle.getByText('对象存储清理处理中')).toHaveCount(0)
    expect(cancelPurgeRequests).toEqual([purgeAssetId])

    expect(downloads.map(({ assetId }) => assetId).sort()).toEqual([invalidAssetId, validAssetId].sort())
    expect(downloads.every(({ accept }) => accept === 'application/octet-stream')).toBe(true)
    expect(downloads.every(({ cookie }) => cookie.includes('preview-auth-fixture=same-origin-session'))).toBe(true)
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
