import { expect, test, chromium } from '@playwright/test'

test.setTimeout(30_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18081'

const envelope = (data, error = null) => ({
  request_id: 'visual-qa-request',
  trace_id: 'visual-qa-trace',
  workspace_id: 'ws_visual_qa',
  data,
  warnings: [],
  next_actions: [],
  error,
})

const product = {
  id: 'product_visual_qa',
  workspaceId: 'ws_visual_qa',
  platform: 'taobao',
  accountId: 'store_visual_qa',
  storeName: '视觉 QA 店',
  remoteId: 'remote_visual_qa',
  title: '视觉 QA 商品',
  skuCount: 1,
  stock: 12,
  factsConfirmed: true,
  source: 'official_api',
  updatedAt: '2026-10-06T00:00:00.000Z',
  version: 3,
  brandId: 'brand_visual_qa',
  sourceAssetIds: ['asset_source_1'],
  canonical_scope: {
    verification_status: 'verified',
    read_mode: 'canonical_read',
    canonical_product_id: 'canonical_visual_qa',
    listing_id: 'listing_visual_qa',
    listing_count: 1,
  },
}

async function openVisualPage() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(5_000)
  const page = await context.newPage()
  const generated = []
  // Keep the fixture self-contained: every uninteresting read returns a valid
  // envelope, so a background panel cannot turn this visual assertion into an
  // authentication or transport test.
  await page.route('**/v1/**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [], total: 0, limit: 20, offset: 0 })),
  }))
  await page.route('**/mcp', async route => {
    const body = route.request().postDataJSON?.() ?? {}
    const result = body.method === 'platform.model.status'
      ? { state: 'ready', capabilities: { image_generation: true, image_editing: true }, next_actions: [] }
      : body.method === 'workspace.metrics'
        ? { riskItems: [], productSummary: { total: 1, lowStock: 0, missingImages: 0 } }
        : body.method === 'catalog.image.generate'
          ? (() => {
              generated.push(body.params ?? {})
              return { job_id: 'job_visual_qa', product_id: product.id, next_action: { type: 'review', label: '查看任务', allowed: true } }
            })()
          : { state: 'ready' }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
  })
  await page.route('**/v1/auth/session', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ account: {
      id: 'merchant_visual_qa',
      login: 'visual-qa@example.test',
      accountType: 'merchant',
      status: 'active',
      roles: ['merchant_admin'],
      workspaceIds: ['ws_visual_qa'],
    } })),
  }))
  await page.route('**/v1/auth/mcp-token', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ access_token: 'visual-qa-mcp-token', refresh_token: 'visual-qa-refresh-token', expires_in: 3600 })),
  }))
  await page.route('**/healthz', route => route.fulfill({
    contentType: 'application/json',
    // This spec intercepts image generation and does not prove relay, cost, persistence, or worker behavior.
    body: JSON.stringify(envelope({ status: 'ok', writesEnabled: true, persistence: { mode: 'fixture', ready: true }, setup: { ai: { costGate: 'ready' }, modelReadiness: { image: { ready: true }, image_edit: { ready: true }, ocr: { ready: true }, video: { ready: true } } } })),
  }))
  await page.route('**/v1/platform-accounts', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [{ platform: 'taobao', accountId: 'store_visual_qa', storeName: '视觉 QA 店', state: 'connected', readEnabled: true, writeEnabled: false }] })),
  }))
  await page.route('**/v1/products?*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [product], total: 1, limit: 20, offset: 0 })),
  }))
  await page.route('**/v1/products', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(envelope({ items: [product], total: 1, limit: 20, offset: 0 })),
  }))
  await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /淘宝 1 家店铺/ }).click()
  await expect(page.getByText('视觉 QA 店', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '进入商品库' }).click()
  await page.getByRole('button', { name: /打开视觉 QA 商品商品详情/ }).click()
  await expect(page.getByText('视觉 QA 商品', { exact: true })).toBeVisible()
  return { browser, context, page, generated }
}

test('audits image purpose/size choices, validation error focus, and the generation payload', async () => {
  const { browser, context, page, generated } = await openVisualPage()
  try {
    await page.getByRole('button', { name: /生成图片/ }).click({ timeout: 5000 })
    const dialog = page.getByRole('dialog', { name: /为「视觉 QA 商品」生成图片/ })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('输出用途与画布尺寸')).toHaveValue('1024x1024')
    await expect(dialog.getByLabel('输出用途与画布尺寸').locator('option')).toHaveCount(5)

    await dialog.getByLabel('输出用途与画布尺寸').selectOption('1536x1024')
    await expect(dialog.getByLabel('输出用途与画布尺寸')).toHaveValue('1536x1024')
    await expect(dialog.getByText('将进入真实图片任务队列；生成完成后仍需安全扫描、人工审核和候选选择，不会直接发布。')).toBeVisible()
    await page.screenshot({ path: 'artifacts/visual-qa-image-dialog-banner.png', fullPage: true })

    await dialog.getByLabel('候选数量').fill('0')
    await dialog.getByRole('button', { name: '确认生成' }).click()
    const error = dialog.locator('#catalog-image-generation-error')
    await expect(error).toContainText('候选数量必须是 1–6')
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('catalog-image-generation-error')
    await expect(dialog.getByLabel('候选数量')).toHaveAttribute('aria-invalid', 'true')
    await page.screenshot({ path: 'artifacts/visual-qa-image-dialog-error.png', fullPage: true })

    await dialog.getByLabel('输出用途与画布尺寸').selectOption('1024x4096')
    await dialog.getByLabel('候选数量').fill('1')
    await dialog.getByRole('button', { name: '确认生成' }).click()
    await expect.poll(() => generated.length).toBe(1)
    expect(generated[0]).toMatchObject({
      product_id: product.id,
      platform: product.platform,
      mode: 'optimize',
      size: '1024x4096',
      count: '1',
    })
    expect(generated[0].idempotency_key).toContain('1024x4096')
  } finally {
    await context.close()
    await browser.close()
  }
})

test('canceling the image generation confirmation closes it without creating a task', async () => {
  test.setTimeout(120_000)
  const { browser, context, page, generated } = await openVisualPage()
  try {
    await page.getByRole('button', { name: /生成图片/ }).click({ timeout: 5000 })
    const dialog = page.getByRole('dialog', { name: /为「视觉 QA 商品」生成图片/ })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toHaveCount(0)
    expect(generated).toHaveLength(0)
  } finally {
    await context.close()
    await browser.close()
  }
})
