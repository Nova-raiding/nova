import { chromium, expect, test } from 'playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_catalog_import_readback_fixture'
const accountId = 'taobao-catalog-import-fixture'
const assetId = 'asset_catalog_import_readback_fixture'
const productId = 'product_catalog_import_readback_fixture'
const productTitle = '目录导入回读验收商品'
const extractedFacts = { format: 'csv', rows: [
  { platform: '平台', title: '商品名称', account_id: '店铺账号', price: '价格', stock: '库存' },
  { platform: '淘宝', title: productTitle, account_id: accountId, price: '199', stock: '12' },
] }
const envelope = (data, error = null) => ({ request_id: 'catalog-import-readback-fixture', trace_id: 'catalog-import-readback-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('商品目录内搜索、表格导入和重新读取同一店铺商品闭环', async () => {
  test.setTimeout(120_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') { await vite.close(); throw new Error('Merchant Studio fixture did not bind a loopback port') }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const requests = []
  const unexpectedRequests = []
  const pageErrors = []
  const products = [{ id: 'product_catalog_existing_fixture', workspaceId, platform: 'taobao', accountId, storeName: '目录导入回读验收店', title: '预先存在的搜索商品', price: 99, stock: 5, skuCount: 1, factsConfirmed: true, source: 'manual_import', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', version: 1 }]
  const uploadedAsset = {
    id: assetId, workspaceId, name: 'catalog-import.csv', mimeType: 'text/csv', sizeBytes: 90,
    sha256: 'a'.repeat(64), scanStatus: 'clean', scanVerdict: 'clean', scanReceiptId: 'fixture-clean-receipt',
    scanReceiptDigest: 'b'.repeat(64), storageKey: `clean/${workspaceId}/${assetId}/catalog-import.csv`,
    rightsStatus: 'approved', source: 'merchant_upload', revision: 1,
    createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
  }
  let parseCompleted = false
  let factsConfirmed = false
  let importCount = 0
  let productsReadbacks = 0
  const productProjection = () => ({ ...uploadedAsset, parseStatus: parseCompleted ? 'succeeded' : 'pending', ...(parseCompleted ? { extractedFacts } : {}) })

  page.on('pageerror', error => pageErrors.push(error.stack || error.message))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== studioUrl) {
      unexpectedRequests.push(`blocked external request ${url.origin}${url.pathname}`)
      return route.abort('blockedbyclient')
    }
    if (url.pathname.startsWith('/api/')) {
      unexpectedRequests.push(`unmocked API ${route.request().method()} ${url.pathname}`)
      return route.fulfill({ status: 599, body: 'Unmocked API blocked by isolated journey' })
    }
    return route.fallback()
  })
  await page.route('**/v1/auth/session', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: { id: 'catalog-import-reader', login: 'catalog-import@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })) }))
  await page.route('**/v1/auth/mcp-token', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 300, workspace_id: workspaceId })) }))
  await page.route('**/healthz', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true } })) }))
  await page.route('**/v1/platform-accounts*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [{ platform: 'taobao', state: 'connected', readEnabled: true, writeEnabled: true, dataMode: 'fixture', accountId, storeName: '目录导入回读验收店', label: '目录导入回读验收店' }] })) }))
  await page.route('**/v1/products*', route => {
    productsReadbacks += 1
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: products.map(product => ({ ...product })), total: products.length, limit: 50, offset: 0 })) })
  })
  await page.route('**/v1/assets/upload', route => {
    requests.push({ method: route.request().method(), path: '/v1/assets/upload', file: route.request().headers()['x-asset-name'] })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(productProjection())) })
  })
  await page.route('**/v1/assets?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [productProjection()], total: 1, limit: 50, offset: 0 })) }))
  await page.route(`**/v1/assets/${assetId}/parse`, route => {
    requests.push({ method: route.request().method(), path: `/v1/assets/${assetId}/parse` })
    parseCompleted = true
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(productProjection())) })
  })
  await page.route(`**/v1/assets/${assetId}/facts`, route => {
    requests.push({ method: route.request().method(), path: `/v1/assets/${assetId}/facts` })
    factsConfirmed = true
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(productProjection())) })
  })
  await page.route('**/mcp', route => {
    const rpc = route.request().postDataJSON()
    if (rpc?.method === 'workspace.metrics') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { stores: [], productSummary: { total: products.length, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} } })) })
    if (rpc?.method === 'platform.model.status') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { state: 'ready', capabilities: {} } })) })
    if (rpc?.method === 'catalog.import.batch') {
      requests.push({ method: rpc.method, params: rpc.params })
      importCount += 1
      const imported = { id: productId, workspaceId, platform: 'taobao', accountId, storeName: '目录导入回读验收店', title: productTitle, price: 199, stock: 12, skuCount: 0, factsConfirmed: false, source: 'spreadsheet_import', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', version: 1 }
      products.push(imported)
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(envelope({ result: { batchId: 'catalog-import-readback-batch', count: 1, products: [{ id: productId }], factsConfirmationRequired: true } })) })
    }
    if (rpc?.method === 'catalog.facts.confirm') {
      requests.push({ method: rpc.method, params: rpc.params })
      const imported = products.find(product => product.id === rpc.params.product_id)
      if (imported) imported.factsConfirmed = true
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { id: productId, workspaceId, platform: 'taobao', accountId, title: productTitle, factsConfirmed: Boolean(imported?.factsConfirmed) } })) })
    }
    unexpectedRequests.push(`unmocked MCP ${rpc?.method ?? 'unknown'}`)
    return route.fulfill({ status: 599, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNMOCKED_MCP_METHOD' })) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /^淘宝/u }).click()
    const store = page.locator('.catalog-store-card').filter({ hasText: '目录导入回读验收店' })
    await expect(store).toBeVisible()
    await store.getByRole('button', { name: /进入商品库/u }).click()
    const search = page.getByRole('textbox', { name: '搜索商品名称或关键词' })
    await expect(search).toBeVisible()
    await search.fill('预先存在')
    await expect(page.locator('.catalog-product-card')).toHaveCount(1)
    await expect(page.locator('.catalog-product-card')).toContainText('预先存在的搜索商品')
    await page.getByRole('button', { name: '返回店铺选择' }).click()
    await expect(page.getByRole('heading', { name: '选择平台与店铺' })).toBeVisible()
    await page.getByText('商品表格导入', { exact: true }).click()
    const importer = page.getByTestId('merchant-product-spreadsheet-import')
    await importer.locator('input[type="file"]').setInputFiles({ name: 'catalog-import.csv', mimeType: 'text/csv', buffer: Buffer.from('平台,商品名称,店铺账号,价格,库存\n淘宝,目录导入回读验收商品,taobao-catalog-import-fixture,199,12') })
    await expect(importer.getByText(productTitle, { exact: true })).toBeVisible()
    await expect(importer.getByRole('button', { name: '确认并导入真实店铺' })).toBeVisible()
    await importer.getByRole('button', { name: '确认并导入真实店铺' }).click()
    await expect(importer.getByText('已导入并确认 1 个真实店铺商品。', { exact: true })).toBeVisible()
    await expect(importer.getByText(`商品编号：${productId}`, { exact: false })).toBeVisible()
    expect(importCount).toBe(1)
    expect(factsConfirmed).toBe(true)

    // The import result itself is not treated as the catalog readback. Reload
    // the same deep link and select the same store, then find the persisted
    // product through the customer-facing catalog search.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /^淘宝/u }).click()
    const returnedStore = page.locator('.catalog-store-card').filter({ hasText: '目录导入回读验收店' })
    await returnedStore.getByRole('button', { name: /进入商品库/u }).click()
    const returnedSearch = page.getByRole('textbox', { name: '搜索商品名称或关键词' })
    await returnedSearch.fill(productTitle)
    const importedCard = page.locator('.catalog-product-card')
    await expect(importedCard).toHaveCount(1)
    await expect(importedCard).toContainText(productTitle)
    await importedCard.getByRole('button', { name: `打开${productTitle}商品详情` }).click()
    await expect(page.getByRole('heading', { name: productTitle, exact: true })).toBeVisible()
    expect(products.filter(product => product.id === productId)).toHaveLength(1)
    expect(products.find(product => product.id === productId)?.factsConfirmed).toBe(true)
    expect(productsReadbacks).toBeGreaterThanOrEqual(2)
    expect(requests.map(request => request.method ?? request.path)).toContain('catalog.import.batch')
    expect(unexpectedRequests).toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    await context.unrouteAll({ behavior: 'ignoreErrors' })
    await context.close()
    await browser.close()
    await vite.close()
  }
})
