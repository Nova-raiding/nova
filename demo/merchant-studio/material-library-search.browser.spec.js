import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_material_search_fixture'
const storeId = 'jd-material-search-store'
test.setTimeout(90_000)

const envelope = (data) => ({
  request_id: 'material-search-fixture',
  trace_id: 'material-search-fixture',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
})

const contentTrust = {
  classification: 'untrusted',
  mode: 'data_only',
  canOverrideInstructions: false,
  canTriggerTools: false,
  requiresMerchantConfirmation: true,
}
const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pXcAAAAASUVORK5CYII=', 'base64')

const assets = [
  {
    id: 'asset-search-spring-image', name: '春日主图-01.png', mimeType: 'image/png', materialCategory: '商品主图', sizeBytes: 1200,
    scanStatus: 'clean', parseStatus: 'succeeded', rightsStatus: 'pending', rightsScope: 'internal_only',
    readiness: { status: 'draft', reasons: ['等待商用权益确认'] },
    display: { primaryStatus: 'awaiting_rights', label: '等待确认使用权', sourceState: 'draft', reasons: ['等待商用权益确认'], nextAction: { method: 'asset.rights.update', label: '确认权益范围', allowed: true } },
  },
  {
    id: 'asset-search-summer-sheet', name: '夏日直播清单.csv', mimeType: 'text/csv', materialCategory: '品牌资料', sizeBytes: 2400,
    scanStatus: 'clean', parseStatus: 'failed', parseError: 'fixture parse failure', rightsStatus: 'pending', rightsScope: 'limited_use',
  },
  {
    id: 'asset-search-autumn-detail', name: '秋季SKU详情.mp4', mimeType: 'video/mp4', materialCategory: '商品视频', sizeBytes: 3600,
    scanStatus: 'clean', parseStatus: 'processing', rightsStatus: 'rejected', rightsScope: 'unknown',
  },
  {
    id: 'asset-search-winter-guide', name: '冬季品牌手册.pdf', mimeType: 'application/pdf', materialCategory: '品牌资料', sizeBytes: 4800,
    scanStatus: 'clean', parseStatus: 'pending', rightsStatus: 'approved', rightsScope: 'owned',
  },
].map((asset, index) => ({
  ...asset,
  workspaceId,
  sha256: String(index + 1).repeat(64),
  references: [],
  revision: 1,
  createdAt: `2026-10-0${index + 1}T00:00:00.000Z`,
  updatedAt: `2026-10-0${index + 1}T00:00:00.000Z`,
  contentTrust,
}))

test('material library search, category filtering and clearing update the loaded workspace rows', async () => {
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react()],
    optimizeDeps: { include: ['react', 'react-dom/client', 'antd', 'lucide-react'] },
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
  const externalRequests = []
  const unknownApiRequests = []
  const writeAttempts = []
  const rightsUpdates = []
  let rejectNextRightsUpdate = false
  const pageErrors = []
  const consoleErrors = []
  const assetReads = []
  const readOnlyMcpMethods = new Set([
    'billing.transactions',
    'canonical.product.consistency',
    'commercial.catalog.get',
    'commercial.subscription.get',
    'creative-points.balance.get',
    'creative-points.statement.list',
    'knowledge.asset.list',
    'ops.members.list',
    'ops.session',
    'platform.model.status',
    'subscription.get',
    'workspace.metrics',
  ])

  page.on('request', (request) => {
    if (new URL(request.url()).origin !== studioUrl) externalRequests.push(request.url())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  // The catch-all is registered first; the API handler below intercepts every
  // API call. External traffic is blocked and recorded by this local fixture.
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== studioUrl) {
      externalRequests.push(route.request().url())
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === '/api/mcp') {
      let method = ''
      try { method = request.postDataJSON()?.method ?? '' } catch { /* rejected below */ }
      if (request.method() !== 'POST' || !readOnlyMcpMethods.has(method)) {
        writeAttempts.push(`${request.method()} ${path}${method ? ` method=${method}` : ''}`)
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({
          request_id: 'material-search-fixture-forbidden',
          error: { code: 'FIXTURE_WRITE_BLOCKED', message: 'Only allowlisted read-only MCP methods are allowed.' },
        }) })
      }
      const result = method === 'canonical.product.consistency'
        ? { freshness: 'fresh' }
        : method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : method === 'subscription.get' || method === 'commercial.subscription.get'
          ? { commercial_entitlement: { schema_version: 'commercial.entitlement.v2', status: 'unknown' }, legacy_commercial_entitlement: null }
          : method === 'creative-points.balance.get'
            ? { available_points: 0 }
            : method === 'billing.transactions'
              ? { balance_cny: '0.00', transactions: [] }
              : { items: [], total: 0, limit: 50, offset: 0 }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
    }
    const rightsUpdate = /^\/api\/v1\/assets\/([^/]+)\/rights$/u.exec(path)
    if (request.method() === 'PUT' && rightsUpdate) {
      const assetId = decodeURIComponent(rightsUpdate[1])
      const body = request.postDataJSON()
      rightsUpdates.push({ assetId, body })
      if (rejectNextRightsUpdate) {
        rejectNextRightsUpdate = false
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
          request_id: 'material-rights-fixture-conflict', trace_id: 'material-rights-fixture-conflict', workspace_id: workspaceId,
          data: null, warnings: [], next_actions: [], error: { code: 'ASSET_RIGHTS_SCOPE_CONFLICT', message: '服务端拒绝了冲突的权益范围。' },
        }) })
      }
      const asset = assets.find((item) => item.id === assetId)
      if (!asset) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ASSET_NOT_FOUND' } }) })
      Object.assign(asset, {
        rightsStatus: body.rights_status,
        rightsScope: body.rights_scope,
        revision: asset.revision + 1,
        readiness: { status: 'draft', reasons: ['权益范围受限'] },
        display: { primaryStatus: 'rights_blocked', label: '仅限内部使用', sourceState: 'blocked', reasons: ['权益范围受限'], nextAction: { method: 'asset.rights.update', label: '调整权益范围', allowed: true } },
      })
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(asset)) })
    }
    if (request.method() !== 'GET') {
      writeAttempts.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({
        request_id: 'material-search-fixture-forbidden',
        error: { code: 'FIXTURE_WRITE_BLOCKED', message: 'Only GET API requests are allowed.' },
      }) })
    }
    if (path === '/api/healthz') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true },
        setup: { objectStorage: { configured: false } },
      })) })
    }
    if (path === '/api/v1/auth/session') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: {
        id: 'material-search-user', login: 'material-search@example.invalid', accountType: 'merchant',
        status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId],
      } })) })
    }
    if (path === '/api/v1/auth/mcp-token') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        access_token: 'material-search-fixture-token', refresh_token: 'material-search-fixture-refresh', expires_in: 300,
      })) })
    }
    if (path === '/api/v1/platform-accounts') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [{
        platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'fixture',
        accountId: storeId, storeName: '素材搜索验收店', label: '素材搜索验收店',
      }] })) })
    }
    if (path === '/api/v1/products' || path === '/api/v1/products/') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    }
    if (path === '/api/v1/brand-scopes') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} },
        revision: 1, updated_at: null, series: [],
        assignments: assets.map((asset) => ({ assetId: asset.id, accountId: storeId, seriesId: null, revision: 1 })),
      })) })
    }
    if (path === '/api/v1/assets' || path === '/api/v1/assets/') {
      assetReads.push(url.search)
      const limit = Number(url.searchParams.get('limit') ?? '50')
      const offset = Number(url.searchParams.get('offset') ?? '0')
      const items = assets.slice(offset, offset + limit)
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        items, total: assets.length, limit, offset,
        storage_quota: { usedBytes: 12000, reservedBytes: 0, limitBytes: 100000, availableBytes: 88000, status: 'available' },
      })) })
    }
    const assetDownload = /^\/api\/v1\/assets\/([^/]+)\/download$/u.exec(path)
    if (assetDownload) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: validPng })
    }
    if (path === '/api/v1/brand-profile') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ profile: null })) })
    }
    unknownApiRequests.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({
      request_id: 'material-search-fixture-unknown-api',
      error: { code: 'FIXTURE_UNKNOWN_API', message: 'Unknown local API call.' },
    }) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=knowledge`, { waitUntil: 'domcontentloaded' })
    const workspace = page.getByTestId('material-library-workspace')
    await expect(workspace).toBeVisible()
    const storeMaterials = workspace.locator('.material-store-workspace')
    const searchbox = storeMaterials.getByRole('textbox', { name: '搜索素材名称、分类或格式' })
    await expect(searchbox).toHaveAccessibleName('搜索素材名称、分类或格式')
    const resultSummary = storeMaterials.locator('.material-result-summary')
    const materialCard = (name) => storeMaterials.locator('.material-card-grid article').filter({ hasText: name })
    await expect(storeMaterials.getByRole('heading', { name: '素材库' })).toBeVisible()
    await expect(resultSummary).toContainText('找到 4 项素材')
    await expect(resultSummary).toContainText('上传目标：素材搜索验收店')
    await expect(materialCard('春日主图-01.png')).toBeVisible()
    await expect(materialCard('夏日直播清单.csv')).toBeVisible()
    await expect(materialCard('秋季SKU详情.mp4')).toBeVisible()
    await expect(materialCard('冬季品牌手册.pdf')).toBeVisible()
    const initialAssetReads = assetReads.length

    // Search matches the rendered material fields: name, series, category and
    // MIME-derived format. It is a client-side filter over the loaded rows.
    await searchbox.fill(' PNG ')
    await expect(resultSummary).toContainText('找到 1 项素材')
    await expect(materialCard('春日主图-01.png')).toBeVisible()
    await expect(materialCard('夏日直播清单.csv')).toHaveCount(0)

    // A no-match query can be cleared by emptying the field. Filtering stays
    // local and category filtering combines with search.
    await searchbox.fill('没有这份素材')
    await expect(resultSummary).toContainText('找到 0 项素材')
    await expect(storeMaterials.getByText('当前条件下没有素材', { exact: true })).toBeVisible()
    await storeMaterials.getByRole('button', { name: '清空素材搜索' }).click()
    await expect(searchbox).toHaveValue('')
    await expect(resultSummary).toContainText('找到 4 项素材')
    await storeMaterials.getByRole('button', { name: '素材分类筛选' }).click()
    await storeMaterials.getByRole('option', { name: '商品视频', exact: true }).click()
    await expect(resultSummary).toContainText('找到 1 项素材')
    await expect(materialCard('秋季SKU详情.mp4')).toBeVisible()
    await expect(materialCard('春日主图-01.png')).toHaveCount(0)
    await searchbox.fill('秋季')
    await expect(resultSummary).toContainText('找到 1 项素材')
    await expect(materialCard('秋季SKU详情.mp4')).toBeVisible()
    await searchbox.fill('春日')
    await expect(resultSummary).toContainText('找到 0 项素材')
    await searchbox.fill('')
    await expect(resultSummary).toContainText('找到 1 项素材')
    await expect(materialCard('秋季SKU详情.mp4')).toBeVisible()
    await storeMaterials.getByRole('button', { name: '素材分类筛选' }).click()
    await storeMaterials.getByRole('option', { name: '全部', exact: true }).click()
    await expect(resultSummary).toContainText('找到 4 项素材')
    for (const name of ['春日主图-01.png', '夏日直播清单.csv', '秋季SKU详情.mp4', '冬季品牌手册.pdf']) {
      await expect(materialCard(name)).toBeVisible()
    }
    const internalAsset = materialCard('春日主图-01.png')
    await expect(internalAsset.getByText('权益待确认')).toBeVisible()
    const scopeWithoutServerApproval = materialCard('夏日直播清单.csv').getByRole('button', { name: '确认权益范围：夏日直播清单.csv' })
    await expect(scopeWithoutServerApproval).toBeDisabled()
    await internalAsset.getByRole('button', { name: '确认权益范围：春日主图-01.png' }).click()
    const rightsDialog = page.getByRole('dialog', { name: '确认权益范围：“春日主图-01.png”' })
    await rightsDialog.getByLabel('选择权益范围').click()
    await expect(page.getByRole('option')).toHaveCount(1)
    await expect(page.getByRole('option', { name: '仅内部使用' })).toHaveCount(1)
    await expect(page.getByRole('option', { name: '已获商用授权' })).toHaveCount(0)
    await expect(page.getByRole('option', { name: '自有素材' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await rightsDialog.getByRole('checkbox', { name: '我已核对授权证明，并确认所选权益范围准确' }).check()
    rejectNextRightsUpdate = true
    await rightsDialog.getByRole('button', { name: '保存权益范围' }).click()
    await expect(rightsDialog.getByRole('alert')).toContainText('服务端拒绝了冲突的权益范围')
    await expect(internalAsset.getByText('权益待确认')).toBeVisible()
    await rightsDialog.getByRole('button', { name: '保存权益范围' }).click()
    await expect(internalAsset.getByText('仅内部使用，不可用于生成')).toBeVisible()
    await expect(internalAsset.getByRole('button', { name: '调整权益范围：春日主图-01.png' })).toBeVisible()
    const readsAfterWrite = assetReads.length
    await page.reload({ waitUntil: 'domcontentloaded' })
    const reloadedInternalAsset = page.getByTestId('material-library-workspace').locator('.material-card-grid article').filter({ hasText: '春日主图-01.png' })
    await expect(reloadedInternalAsset.getByText('仅内部使用，不可用于生成')).toBeVisible()
    expect(assetReads.length).toBeGreaterThan(readsAfterWrite)
    expect(rightsUpdates).toEqual([
      { assetId: 'asset-search-spring-image', body: { rights_status: 'approved', rights_scope: 'internal_only', usage_scopes: ['internal_only'], ai_modification_allowed: false } },
      { assetId: 'asset-search-spring-image', body: { rights_status: 'approved', rights_scope: 'internal_only', usage_scopes: ['internal_only'], ai_modification_allowed: false } },
    ])
    expect(assetReads.length).toBeGreaterThan(initialAssetReads)
    expect(externalRequests).toEqual([])
    expect(unknownApiRequests).toEqual([])
    expect(writeAttempts).toEqual([])
    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual(['Failed to load resource: the server responded with a status of 409 (Conflict)'])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
