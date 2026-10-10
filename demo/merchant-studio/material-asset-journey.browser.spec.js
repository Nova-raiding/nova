import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_asset_journey_fixture'
const imageAssetId = 'asset_journey_png_fixture'
const tableAssetId = 'asset_journey_csv_fixture'
const productId = 'product_journey_fixture'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pXcAAAAASUVORK5CYII=', 'base64')

const envelope = data => ({ request_id: 'asset-journey-fixture', trace_id: 'asset-journey-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('one workspace can upload and preview an image, then import a product table linked to its asset ID', async () => {
  test.setTimeout(45_000)
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
    throw new Error('Merchant Studio fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const apiCalls = []
  const browserErrors = []
  const unexpectedRequests = []
  const assets = []
  let releaseImageUpload
  const imageAsset = {
    id: imageAssetId, workspaceId, name: 'journey-product.png', mimeType: 'image/png', sizeBytes: png.length,
    sha256: 'a'.repeat(64), scanStatus: 'clean', rightsStatus: 'approved', source: 'merchant_upload',
    createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
  }
  const tableAsset = {
    id: tableAssetId, workspaceId, name: 'journey-products.csv', mimeType: 'text/csv', sizeBytes: 84,
    sha256: 'b'.repeat(64), scanStatus: 'clean', rightsStatus: 'approved', source: 'merchant_upload',
    parseStatus: 'succeeded', extractedFacts: { format: 'csv', rows: [
      { platform: '平台', title: '商品名称', account_id: '店铺账号', asset_ids: '素材ID' },
      { platform: '淘宝', title: '旅程关联商品', account_id: 'taobao-journey', asset_ids: imageAssetId },
    ] },
    revision: 1, createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
  }
  page.on('pageerror', error => { browserErrors.push(`pageerror: ${error.message}`); console.error(`JOURNEY_PAGE_ERROR ${error.message}`) })
  page.on('console', message => { if (message.type() === 'error') { browserErrors.push(`console: ${message.text()}`); console.error(`JOURNEY_CONSOLE ${message.text()}`) } })
  page.on('requestfailed', request => browserErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`))

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== studioUrl) {
      unexpectedRequests.push(`blocked external ${url.origin}${url.pathname}`)
      return route.abort('blockedbyclient')
    }
    if (url.pathname.startsWith('/api/')) {
      unexpectedRequests.push(`unmocked API ${url.pathname}`)
      console.error(`JOURNEY_UNMOCKED_API ${url.pathname}`)
      return route.fulfill({ status: 599, body: 'Unmocked API blocked by journey fixture' })
    }
    return route.fallback()
  })
  await page.route('**/v1/auth/session', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: {
    id: 'asset-journey-user', login: 'asset-journey@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId],
  } })) }))
  await page.route('**/healthz', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true } } })) }))
  await page.route('**/v1/auth/mcp-token', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ access_token: 'fixture-only', refresh_token: 'fixture-only', token_type: 'Bearer', expires_in: 3600, workspace_id: workspaceId })) }))
  await page.route('**/v1/platform-accounts*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [{ platform: 'taobao', state: 'connected', readEnabled: true, writeEnabled: true, accountId: 'taobao-journey', storeName: '旅程测试店', label: '旅程测试店' }] })) }))
  await page.route('**/v1/brand-scopes', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} }, revision: 0, updated_at: null, series: [], assignments: [] })) }))
  await page.route('**/v1/brand-scopes/assets/*/assignment', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ assetId: imageAssetId, accountId: 'taobao-journey', seriesId: null, revision: 1 })) }))
  await page.route('**/v1/products*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) }))
  await page.route('**/v1/assets/upload', async route => {
    const request = route.request()
    const name = request.headers()['x-asset-name']
    const asset = name === imageAsset.name ? imageAsset : tableAsset
    apiCalls.push({ path: '/api/v1/assets/upload', method: request.method(), name, mimeType: request.headers()['content-type'] })
    if (asset === imageAsset) await new Promise(resolve => { releaseImageUpload = resolve })
    assets.push(asset)
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(asset)) })
  })
  await page.route('**/v1/assets?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: assets, total: assets.length, limit: 50, offset: 0 })) }))
  await page.route('**/v1/assets', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: assets, total: assets.length, limit: 50, offset: 0 })) }))
  await page.route(`**/v1/assets/${imageAssetId}/download`, route => {
    apiCalls.push({ path: `/api/v1/assets/${imageAssetId}/download`, method: route.request().method() })
    return route.fulfill({ status: 200, contentType: 'image/png', body: png })
  })
  await page.route(`**/v1/assets/${tableAssetId}/facts`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(tableAsset)) }))
  await page.route('**/mcp', async route => {
    const rpc = route.request().postDataJSON()
    let result
    if (rpc?.method === 'workspace.metrics') result = { riskItems: [], stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
    else if (rpc?.method === 'creative-points.balance.get') result = { balance_state: 'known', available_points: 100 }
    else if (rpc?.method === 'billing.transactions') result = { balance_cny: '0.00', transactions: [] }
    else if (rpc?.method === 'catalog.import.batch') {
      apiCalls.push({ path: '/api/mcp', method: rpc.method, params: rpc.params })
      result = { batchId: 'batch_asset_journey_fixture', count: 1, products: [{ id: productId }], factsConfirmationRequired: true }
    } else if (rpc?.method === 'catalog.facts.confirm') {
      apiCalls.push({ path: '/api/mcp', method: rpc.method, params: rpc.params })
      result = { id: productId, workspaceId, platform: 'taobao', title: '旅程关联商品', skuCount: 0, stock: 0, factsConfirmed: true, sourceAssetIds: [imageAssetId, tableAssetId], updatedAt: '2026-10-08T00:00:00.000Z' }
    } else result = { state: 'ready', capabilities: {} }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=knowledge`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    if (!(await page.getByTestId('material-library-workspace').count())) console.error(`JOURNEY_INITIAL_TEXT ${(await page.locator('body').innerText()).slice(0, 1200)}`)
    await expect(page.getByTestId('material-library-workspace')).toBeVisible()
    await page.getByRole('button', { name: '上传素材' }).click()
    const uploadDialog = page.getByTestId('material-upload-dialog')
    await uploadDialog.locator('input[type="file"]').setInputFiles({ name: imageAsset.name, mimeType: 'image/png', buffer: png })
    await uploadDialog.getByRole('button', { name: `选择${imageAsset.name}` }).click()
    await uploadDialog.getByRole('button', { name: '所属系列' }).click()
    await uploadDialog.getByRole('option', { name: '未分类' }).click()
    await page.getByRole('button', { name: /确认上传/ }).click()
    const uploadProgress = uploadDialog.getByTestId('material-upload-progress')
    await expect(uploadProgress).toContainText('上传进度：0/1，已成功 0，失败 0')
    expect(typeof releaseImageUpload).toBe('function')
    releaseImageUpload()
    const imageCard = page.locator('article').filter({ hasText: imageAsset.name })
    const thumbnail = imageCard.locator('.material-card-open img')
    await expect(thumbnail).toBeVisible()
    await expect.poll(() => thumbnail.evaluate(image => image.naturalWidth)).toBe(1)
    await imageCard.getByRole('button', { name: `查看${imageAsset.name}详情` }).click()
    const detailImage = page.locator('.material-detail-preview img')
    await expect(detailImage).toBeVisible()
    await expect.poll(() => detailImage.evaluate(image => image.naturalWidth)).toBe(1)

    await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /^淘宝/ }).click()
    await page.getByText('商品表格导入', { exact: true }).click()
    const importer = page.getByTestId('merchant-product-spreadsheet-import')
    await importer.locator('input[type="file"]').setInputFiles({
      name: tableAsset.name, mimeType: 'text/csv',
      buffer: Buffer.from(`平台,商品名称,店铺账号,素材ID\n淘宝,旅程关联商品,taobao-journey,${imageAssetId}`),
    })
    await expect(importer.getByText('旅程关联商品', { exact: true })).toBeVisible()
    await importer.getByRole('button', { name: '确认并创建草稿' }).click()
    await expect(importer.getByText('已创建 1 个草稿商品；不可同步或发布。', { exact: true })).toBeVisible()

    expect(apiCalls.filter(call => call.path === '/api/v1/assets/upload').map(call => call.name)).toEqual([imageAsset.name, tableAsset.name])
    expect(apiCalls.find(call => call.method === 'catalog.import.batch')?.params).toMatchObject({ source_asset_id: tableAssetId, draft_only: 'true', products_json: JSON.stringify([{ platform: 'taobao', title: '旅程关联商品', asset_ids: [imageAssetId] }]) })
    expect(apiCalls.find(call => call.method === 'catalog.facts.confirm')?.params).toMatchObject({ product_id: productId })
    expect(apiCalls.some(call => call.path === `/api/v1/assets/${imageAssetId}/download`)).toBe(true)
    expect(unexpectedRequests).toEqual([])
    expect(browserErrors).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
