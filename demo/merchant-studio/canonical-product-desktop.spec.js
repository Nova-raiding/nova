import { expect, test, chromium } from '@playwright/test'

test.setTimeout(60_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18081'
const workspaceId = 'ws_canonical_desktop'
const productId = 'product_canonical_001'
const accountId = 'taobao_store_001'

const envelope = (data, error = null) => ({
  request_id: 'canonical-desktop-request',
  trace_id: 'canonical-desktop-trace',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error,
})

const product = {
  id: productId,
  workspaceId,
  platform: 'taobao',
  accountId,
  storeName: '规范商品测试店',
  remoteId: 'remote-canonical-001',
  title: '规范商品桌面验收样品',
  skuCount: 1,
  stock: 18,
  factsConfirmed: true,
  source: 'official_api',
  updatedAt: '2026-09-01T08:00:00.000Z',
  version: 4,
  brandId: 'brand_canonical_001',
  sourceAssetIds: ['asset-canonical-001'],
  canonical_scope: {
    verification_status: 'verified',
    read_mode: 'canonical_read',
    canonical_product_id: 'canonical-001',
    listing_id: 'listing-taobao-001',
    listing_count: 1,
  },
}

const assets = {
  items: [{
    id: 'asset-canonical-001',
    workspaceId,
    name: '规范商品主图',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    scanStatus: 'clean',
    rightsStatus: 'approved',
    source: 'merchant_upload',
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-01T08:00:00.000Z',
  }],
  total: 1,
  limit: 50,
  offset: 0,
}

async function installRoutes(page, { canonicalStatus = 'verified' } = {}) {

  // This synthetic account exists only inside the browser route fixture. It
  // lets the desktop flow enter its authenticated state without credentials,
  // cookies, or requests to a real authentication service.
  await page.route('**/v1/auth/session', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ account: {
      id: 'account_canonical_desktop_fixture',
      login: 'canonical-desktop-fixture@example.invalid',
      accountType: 'merchant',
      status: 'active',
      roles: ['merchant_owner'],
      workspaceIds: [workspaceId],
    } })),
  }))
  await page.route('**/healthz', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({
      status: 'ok',
      writesEnabled: true,
      connectors: {},
      persistence: { mode: 'postgres', ready: true },
    })),
  }))
  await page.route('**/v1/platform-accounts*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [{
      platform: 'taobao',
      state: 'connected',
      readEnabled: true,
      writeEnabled: true,
      accountId,
      storeName: product.storeName,
      label: product.storeName,
    }] })),
  }))
  await page.route('**/v1/products*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [{ ...product, canonical_scope: { ...product.canonical_scope, verification_status: canonicalStatus } }], total: 1, limit: 10, offset: 0 })),
  }))
  await page.route(`**/v1/products/${productId}/assets`, route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(envelope({
        items: [{ assetId: 'asset-canonical-001', status: 'active', ordinal: 1 }],
        source: 'product_api',
      })),
  }))
  await page.route('**/v1/assets?*', route => {
    const offset = new URL(route.request().url()).searchParams.get('offset')
    const pageData = offset === '0' ? assets : { ...assets, items: [], offset: Number(offset ?? 0) }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(envelope(pageData)),
    })
  })
  await page.route('**/v1/tasks?*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [], total: 0, limit: 12, offset: 0 })),
  }))
  await page.route('**/v1/task-groups*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })),
  }))
  await page.route('**/v1/workspaces/*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [] })),
  }))
  await page.route('**/v1/auth/mcp-token', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({
      access_token: 'local-canonical-desktop-fixture-token',
      refresh_token: 'local-canonical-desktop-fixture-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      workspace_id: workspaceId,
      account_login: 'canonical-desktop-fixture@example.invalid',
    })),
  }))
  await page.route('**/mcp', route => {
    const method = route.request().postDataJSON()?.method
    const result = method === 'workspace.metrics'
      ? {
          source: 'process_local',
          dataCompleteness: 'complete',
          stores: [],
          productSummary: { total: 0, lowStock: 0, missingImages: 0 },
          riskSummary: { total: 0, returned: 0, truncated: false },
          riskItems: [],
          taskFunnel: {},
        }
      : { state: 'ready', capabilities: {} }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(envelope({ result })),
    })
  })
}

async function openPage(path, options) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  await installRoutes(page, options)
  await page.goto(`${studioUrl}${path}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^淘宝/ }).click()
  await page.getByRole('button', { name: '进入商品库' }).click()
  await page.locator('.catalog-product-card').filter({ hasText: product.title }).click()
  return { browser, context, page }
}

test('drills into the canonical product relation with authoritative evidence', async () => {
  const { browser, context, page } = await openPage('/merchant/products?section=products&q=规范商品')
  try {
    await expect(page.getByRole('heading', { name: product.title })).toBeVisible()
    await expect(page.getByTitle('canonical 与 listing 关系已确认')).toBeVisible()
    await expect(page.getByText('规范商品：canonical-001', { exact: true })).toBeVisible()
    await expect(page.getByText('店铺刊登：listing-taobao-001', { exact: true })).toBeVisible()

    await expect(page.getByLabel('规范商品与店铺刊登关系')).toContainText('刊登数量：1')
  } finally {
    await context.close(); await browser.close()
  }
})

test('surfaces a canonical conflict without presenting it as verified', async () => {
  const { browser, context, page } = await openPage('/merchant/products?section=products&q=规范商品', { canonicalStatus: 'conflict' })
  try {
    await expect(page.getByText('标准链冲突', { exact: true })).toBeVisible()
    await expect(page.getByLabel('规范商品与店铺刊登关系')).toContainText('canonical-001')
    await expect(page.getByTitle('商品、品牌、平台或店铺关系不一致')).toBeVisible()
  } finally {
    await context.close(); await browser.close()
  }
})

test('returns from product details to the same selected store catalog', async () => {
  const { browser, context, page } = await openPage('/merchant/products?section=products&q=规范商品')
  try {
    await page.getByRole('button', { name: '返回商品列表' }).click()
    await expect(page.getByRole('heading', { name: product.storeName })).toBeVisible()
    await expect(page.getByText(product.title, { exact: true })).toBeVisible()
  } finally {
    await context.close(); await browser.close()
  }
})

test('deep-links into the scoped product workspace without dropping its query or store identity', async () => {
  const path = `/merchant/products?section=products&q=${encodeURIComponent('规范商品')}`
  const { browser, context, page } = await openPage(path)
  try {
    await expect(page).toHaveURL(/q=%E8%A7%84%E8%8C%83%E5%95%86%E5%93%81/)
    await expect(page.getByRole('heading', { name: product.title })).toBeVisible()
    await expect(page.getByText(product.storeName, { exact: true })).toBeVisible()
    await expect(page.getByTitle('canonical 与 listing 关系已确认')).toBeVisible()
    await expect(page.getByLabel('规范商品与店铺刊登关系')).toContainText('listing-taobao-001')
  } finally {
    await context.close(); await browser.close()
  }
})
