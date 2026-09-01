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

async function installRoutes(page, { relationFailureOnce = false } = {}) {
  let bindingAttempts = 0

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
    body: JSON.stringify(envelope(route.request().url().includes('?')
      ? { items: [product], total: 1, limit: 10, offset: 0 }
      : product)),
  }))
  await page.route(`**/v1/products/${productId}/assets`, route => {
    bindingAttempts += 1
    if (relationFailureOnce && bindingAttempts === 1) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify(envelope(null, { code: 'DEPENDENCY_UNAVAILABLE', message: '关系服务暂不可用' })),
      })
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(envelope({
        items: [{ assetId: 'asset-canonical-001', status: 'active', ordinal: 1 }],
        source: 'product_api',
      })),
    })
  })
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
  await page.route('**/mcp', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ result: { state: 'ready', capabilities: {} } })),
  }))
}

async function openPage(path, options) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  await installRoutes(page, options)
  await page.goto(`${studioUrl}${path}`, { waitUntil: 'domcontentloaded' })
  return { browser, context, page }
}

test('drills into the canonical product relation with authoritative evidence', async () => {
  const { browser, context, page } = await openPage('/merchant/products?section=products&q=规范商品')
  try {
    await expect(page.getByRole('heading', { name: '一处管理商品事实与来源' })).toBeVisible()
    await expect(page.getByTitle('canonical 与 listing 关系已确认')).toBeVisible()
    await expect(page.getByText('规范商品：canonical-001', { exact: true })).toBeVisible()
    await expect(page.getByText('店铺刊登：listing-taobao-001', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: '查看关系' }).click()
    const dialog = page.getByTestId('product-asset-relation-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: '商品与素材关系' })).toBeVisible()
    await expect(dialog.getByText('规范商品主图', { exact: true })).toBeVisible()
    await expect(dialog.getByText('可作为生成来源', { exact: true })).toBeVisible()
  } finally {
    await context.close(); await browser.close()
  }
})

test('recovers a canonical relation read failure without losing workspace scope', async () => {
  const { browser, context, page } = await openPage('/merchant/products?section=products&q=规范商品', { relationFailureOnce: true })
  try {
    await expect(page.getByTitle('canonical 与 listing 关系已确认')).toBeVisible()
    await page.getByRole('button', { name: '查看关系' }).click()
    const dialog = page.getByTestId('product-asset-relation-dialog')
    await expect(dialog.getByRole('alert')).toContainText('关系读取失败')
    const retry = dialog.getByRole('button', { name: '重新读取' })
    await expect(retry).toBeVisible()
    await retry.focus()
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('heading', { name: '商品与素材关系' })).toBeVisible()
    await expect(page).toHaveURL(/\/merchant\/products\?q=%E8%A7%84%E8%8C%83%E5%95%86%E5%93%81&section=products/)
  } finally {
    await context.close(); await browser.close()
  }
})

test('returns from canonical relation drill-down to the same product workspace', async () => {
  const { browser, context, page } = await openPage('/merchant/products?section=products&q=规范商品')
  try {
    await page.getByRole('button', { name: '查看关系' }).click()
    const dialog = page.getByTestId('product-asset-relation-dialog')
    await expect(dialog.getByRole('heading', { name: '商品与素材关系' })).toBeVisible()
    await dialog.getByRole('button', { name: '完成' }).click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/merchant\/products\?q=%E8%A7%84%E8%8C%83%E5%95%86%E5%93%81&section=products/)
    await expect(page.locator('input[placeholder="搜索商品或平台"]')).toHaveValue('规范商品')
    await expect(page.getByTitle('canonical 与 listing 关系已确认')).toBeVisible()
  } finally {
    await context.close(); await browser.close()
  }
})

test('deep-links into the scoped product workspace without dropping its query or store identity', async () => {
  const path = `/merchant/products?section=products&q=${encodeURIComponent('规范商品')}`
  const { browser, context, page } = await openPage(path)
  try {
    await expect(page.locator('input[placeholder="搜索商品或平台"]')).toHaveValue('规范商品')
    await expect(page.getByText(product.storeName, { exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: '淘宝' })).toBeVisible()
    await expect(page.getByTitle('canonical 与 listing 关系已确认')).toBeVisible()
    await expect(page.locator('.scope-summary')).toContainText('全部平台')
  } finally {
    await context.close(); await browser.close()
  }
})
