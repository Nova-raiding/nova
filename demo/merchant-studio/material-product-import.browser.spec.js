import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_material_product_import_fixture'
const assetId = 'asset_uploaded_material_fixture'
const productId = 'product_spreadsheet_material_fixture'
const extractedFacts = {
  format: 'csv',
  rows: [
    { platform: '平台', title: '商品名称', asset_ids: '素材ID' },
    { platform: '淘宝', title: '表格绑定素材商品', asset_ids: assetId },
  ],
}

const envelope = (data) => ({
  request_id: 'material-product-import-fixture',
  trace_id: 'material-product-import-fixture',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
})

test('spreadsheet import uploads a product table and carries its material ID through batch import', async () => {
  // Give this spec its own ephemeral loopback server. Never inherit local port
  // forwarding or a configured API proxy; every API request is fixture-backed.
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
  const page = await context.newPage()
  const requests = []
  const pageErrors = []
  const consoleErrors = []
  const unexpectedRequests = []
  let trustedScanReceiptAvailable = false
  let parseCompleted = false
  const uploadedAsset = {
    id: assetId, workspaceId, name: 'merchant-products.csv', mimeType: 'text/csv', sizeBytes: 86,
    sha256: 'a'.repeat(64), scanStatus: 'clean', rightsStatus: 'approved', source: 'merchant_upload',
    parseStatus: 'pending', revision: 1,
    createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z',
  }
  const assetProjection = () => ({
    ...uploadedAsset,
    ...(trustedScanReceiptAvailable ? {
      scanVerdict: 'clean', scanReceiptId: 'fixture-material-import-scan', scanReceiptDigest: 'c'.repeat(64),
      storageKey: `clean/${workspaceId}/${assetId}/merchant-products.csv`,
    } : {}),
    ...(parseCompleted ? { parseStatus: 'succeeded', extractedFacts } : {}),
  })
  page.on('pageerror', error => pageErrors.push(error.stack || error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== studioUrl) {
      unexpectedRequests.push(`blocked external request ${url.origin}${url.pathname}`)
      return route.abort('blockedbyclient')
    }
    if (url.pathname.startsWith('/api/')) {
      unexpectedRequests.push(`unmocked API ${url.pathname}`)
      return route.fulfill({ status: 599, body: 'Unmocked API blocked by fixture' })
    }
    return route.fallback()
  })
  await page.route('**/v1/auth/session', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ account: {
      id: 'material-product-import-user', login: 'material-product-import@example.invalid',
      accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId],
    } })),
  }))
  await page.route('**/healthz', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true } })),
  }))
  await page.route('**/v1/platform-accounts*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [{
      platform: 'taobao', state: 'connected', readEnabled: true, writeEnabled: true,
      accountId: 'taobao-material-fixture', storeName: '素材绑定测试店', label: '素材绑定测试店',
    }] })),
  }))
  await page.route('**/v1/products*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })),
  }))
  await page.route('**/v1/assets/upload', route => {
    requests.push({ path: '/api/v1/assets/upload', method: route.request().method(), contentType: route.request().headers()['content-type'], name: route.request().headers()['x-asset-name'] })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(assetProjection())) })
  })
  await page.route('**/v1/assets?*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [assetProjection()], total: 1, limit: 50, offset: 0 })),
  }))
  await page.route(`**/v1/assets/${assetId}/parse`, route => {
    requests.push({ path: `/api/v1/assets/${assetId}/parse`, method: route.request().method() })
    parseCompleted = true
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(assetProjection())) })
  })
  await page.route(`**/v1/assets/${assetId}/facts`, route => {
    requests.push({ path: `/api/v1/assets/${assetId}/facts`, method: route.request().method(), body: route.request().postDataJSON() })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(assetProjection())) })
  })
  await page.route('**/v1/auth/mcp-token', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ access_token: 'local-material-fixture', refresh_token: 'local-material-fixture', token_type: 'Bearer', expires_in: 3600, workspace_id: workspaceId })),
  }))
  await page.route('**/mcp', route => {
    const rpc = route.request().postDataJSON()
    let result
    if (rpc?.method === 'workspace.metrics') result = { riskItems: [], stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
    else if (rpc?.method === 'catalog.import.batch') {
      requests.push({ path: '/api/mcp', method: rpc.method, params: rpc.params })
      result = { batchId: 'batch_material_import_fixture', count: 1, products: [{ id: productId }], factsConfirmationRequired: true }
    } else if (rpc?.method === 'catalog.facts.confirm') {
      requests.push({ path: '/api/mcp', method: rpc.method, params: rpc.params })
      result = { id: productId, workspaceId, platform: 'taobao', title: '表格绑定素材商品', skuCount: 0, stock: 0, factsConfirmed: true, sourceAssetIds: [assetId], updatedAt: '2026-10-07T00:00:00.000Z' }
    } else result = { state: 'ready', capabilities: {} }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /^淘宝/ }).click()
    await page.getByText('商品表格导入', { exact: true }).click()
    const importer = page.getByTestId('merchant-product-spreadsheet-import')
    await importer.locator('input[type="file"]').setInputFiles({
      name: 'merchant-products.csv', mimeType: 'text/csv',
      buffer: Buffer.from('平台,商品名称,素材ID\n淘宝,表格绑定素材商品,asset_uploaded_material_fixture'),
    })
    await expect(importer.getByRole('alert')).toContainText('安全扫描凭据缺失或无效')
    expect(requests.filter(request => request.path.endsWith('/parse'))).toHaveLength(0)

    trustedScanReceiptAvailable = true
    await importer.getByRole('button', { name: '继续检查' }).click()
    await expect(importer.getByText('表格绑定素材商品', { exact: true })).toBeVisible()
    expect(requests.filter(request => request.path.endsWith('/parse'))).toHaveLength(1)

    // Every row in store mode must identify its destination. Keep the preview
    // available so the merchant can recover in draft mode without reuploading.
    await importer.getByLabel('绑定真实店铺').check()
    await importer.getByRole('button', { name: '确认并导入真实店铺' }).click()
    const importError = importer.getByRole('alert')
    await expect(importError).toContainText('第 1 个商品未填写店铺账号')
    await expect(importError).toBeFocused()
    expect(requests.map(request => request.path)).toEqual(['/api/v1/assets/upload', `/api/v1/assets/${assetId}/parse`])

    await importer.getByLabel('仅草稿').check()
    await importer.getByRole('button', { name: '确认并创建草稿' }).click()
    await expect(importer.getByText('已创建 1 个草稿商品；不可同步或发布。', { exact: true })).toBeVisible()

    expect(requests.map(request => request.path)).toEqual([
      '/api/v1/assets/upload', `/api/v1/assets/${assetId}/parse`, `/api/v1/assets/${assetId}/facts`, '/api/mcp', '/api/mcp',
    ])
    expect(requests[0]).toMatchObject({ method: 'POST', contentType: 'text/csv', name: 'merchant-products.csv' })
    expect(requests[2].body).toMatchObject({ facts: extractedFacts })
    expect(requests[3]).toMatchObject({ method: 'catalog.import.batch', params: {
      source_asset_id: assetId, draft_only: 'true',
      products_json: JSON.stringify([{ platform: 'taobao', title: '表格绑定素材商品', asset_ids: [assetId] }]),
    } })
    expect(requests[4]).toMatchObject({ method: 'catalog.facts.confirm', params: { product_id: productId } })
    expect(unexpectedRequests).toEqual([])
    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
}, 60_000)

test('a partial product-fact confirmation failure can be retried without importing products again', async () => {
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
    throw new Error('Local Merchant Studio fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const requests = []
  const pageErrors = []
  const consoleErrors = []
  const unexpectedRequests = []
  const productIds = ['product_confirm_ok_fixture', 'product_confirm_retry_fixture']
  let batchImports = 0
  let retryProductConfirmations = 0
  page.on('pageerror', error => pageErrors.push(error.stack || error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== studioUrl) {
      unexpectedRequests.push(`blocked external request ${url.origin}${url.pathname}`)
      return route.abort('blockedbyclient')
    }
    if (url.pathname.startsWith('/api/')) {
      unexpectedRequests.push(`unmocked API ${url.pathname}`)
      return route.fulfill({ status: 599, body: 'Unmocked API blocked by fixture' })
    }
    return route.fallback()
  })
  await page.route('**/v1/auth/session', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ account: {
      id: 'material-product-import-retry-user', login: 'retry@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId],
    } })),
  }))
  await page.route('**/healthz', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true } })),
  }))
  await page.route('**/v1/platform-accounts*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [{ platform: 'taobao', state: 'connected', readEnabled: true, writeEnabled: true, accountId: 'taobao-material-fixture', storeName: '事实重试店' }] })),
  }))
  await page.route('**/v1/products*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })),
  }))
  const retryAsset = {
    id: 'asset_import_confirm_retry_fixture', workspaceId, name: 'merchant-products.csv', mimeType: 'text/csv', sizeBytes: 86,
    sha256: 'b'.repeat(64), scanStatus: 'clean', scanVerdict: 'clean', scanReceiptId: 'fixture-material-import-retry-scan', scanReceiptDigest: 'd'.repeat(64), storageKey: `clean/${workspaceId}/asset_import_confirm_retry_fixture/merchant-products.csv`, rightsStatus: 'approved', source: 'merchant_upload',
    parseStatus: 'succeeded', extractedFacts, revision: 1,
    createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z',
  }
  await page.route('**/v1/assets/upload', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(retryAsset)) }))
  await page.route('**/v1/assets?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [retryAsset], total: 1, limit: 50, offset: 0 })) }))
  await page.route(`**/v1/assets/${retryAsset.id}/facts`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(retryAsset)) }))
  await page.route('**/v1/auth/mcp-token', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ access_token: 'local-material-confirm-retry-fixture', refresh_token: 'local-material-confirm-retry-fixture', token_type: 'Bearer', expires_in: 3600, workspace_id: workspaceId })),
  }))
  await page.route('**/mcp', route => {
    const rpc = route.request().postDataJSON()
    if (rpc?.method === 'workspace.metrics') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { riskItems: [], stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} } })) })
    if (rpc?.method === 'catalog.import.batch') {
      batchImports += 1
      requests.push({ method: rpc.method, params: rpc.params })
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { batchId: 'batch_confirm_retry_fixture', count: 2, products: productIds.map(id => ({ id })), factsConfirmationRequired: true } })) })
    }
    if (rpc?.method === 'catalog.facts.confirm') {
      const productId = rpc.params?.product_id
      requests.push({ method: rpc.method, productId })
      if (productId === productIds[1] && retryProductConfirmations++ === 0) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ...envelope({ result: null }), error: { code: 'TEMPORARY_UNAVAILABLE', message: '商品事实暂时无法确认' } }) })
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { id: productId, workspaceId, factsConfirmed: true } })) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { state: 'ready', capabilities: {} } })) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /^淘宝/ }).click()
    await page.getByText('商品表格导入', { exact: true }).click()
    const importer = page.getByTestId('merchant-product-spreadsheet-import')
    await importer.locator('input[type="file"]').setInputFiles({
      name: 'merchant-products.csv', mimeType: 'text/csv',
      buffer: Buffer.from('平台,商品名称,素材ID\n淘宝,事实确认重试商品,asset_import_confirm_retry_fixture'),
    })
    await expect(importer.getByRole('button', { name: '确认并创建草稿' })).toBeVisible()
    await importer.getByRole('button', { name: '确认并创建草稿' }).click()
    await expect(importer.getByRole('status')).toContainText('已创建 2 个商品；1 个商品事实尚未确认')
    const retry = importer.getByRole('button', { name: '重试确认 1 个商品事实' })
    await expect(retry).toBeEnabled()
    await retry.click()
    await expect(importer.getByRole('status')).toContainText('所有商品事实均已确认')
    await expect(importer.getByRole('button', { name: /重试确认/u })).toHaveCount(0)
    expect(batchImports).toBe(1)
    expect(requests).toEqual([
      { method: 'catalog.import.batch', params: expect.objectContaining({ source_asset_id: retryAsset.id, draft_only: 'true' }) },
      { method: 'catalog.facts.confirm', productId: productIds[0] },
      { method: 'catalog.facts.confirm', productId: productIds[1] },
      { method: 'catalog.facts.confirm', productId: productIds[1] },
    ])
    expect(unexpectedRequests).toEqual([])
    expect(pageErrors).toEqual([])
    expect(consoleErrors).toHaveLength(1)
    expect(consoleErrors[0]).toMatch(/503/u)
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
}, 60_000)
