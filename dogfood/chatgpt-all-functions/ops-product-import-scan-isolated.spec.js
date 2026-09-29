import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'

const opsBase = process.env.OPS_BASE_URL
const merchantBase = process.env.MERCHANT_STUDIO_URL
const evidenceDir = process.env.OPS_E2E_OUTPUT_DIR
const workspaceId = process.env.OPS_E2E_WORKSPACE_ID
if (!opsBase || !merchantBase || !evidenceDir || !workspaceId || process.env.OPS_E2E_REAL_DELIVERY_SCAN !== 'true'
  || process.env.OPS_E2E_SCAN_PURPOSE !== 'product_import'
  || new URL(opsBase).hostname !== '127.0.0.1' || new URL(merchantBase).hostname !== '127.0.0.1') {
  throw new Error('Product import requires a dedicated isolated real-scanner browser fixture')
}

test.use({ channel: 'chrome', trace: 'on' })
test.setTimeout(210_000)

test('downloads Ops XLSX, imports merchant draft through real scan, and keeps knowledge pending', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openPlatformConsole(page, '/ops/stores?workbench=platform')
  const card = page.locator('.ant-card').filter({ hasText: '运营代商家上传店铺商品' })
  await expect(card).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await card.getByRole('button', { name: '下载模板' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('商品-SKU导入模板.xlsx')
  const workbook = await readFile(await download.path())
  const merchant = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const studio = await merchant.newPage()
    await studio.goto(new URL('/merchant/login', merchantBase).href)
    await studio.getByPlaceholder('例如 merchant@example.com').fill(process.env.OPS_E2E_MERCHANT_USERNAME)
    await studio.getByPlaceholder('请输入商家密码').fill(process.env.OPS_E2E_MERCHANT_PASSWORD)
    const merchantLogin = studio.waitForResponse(response => response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST')
    await studio.getByRole('button', { name: '登录商家工作台' }).click()
    expect((await merchantLogin).status()).toBe(200)
    await expect(studio.getByRole('button', { name: '登录商家工作台' })).toBeHidden({ timeout: 30_000 })
    await studio.goto(new URL('/merchant/products?section=products', merchantBase).href)
    const platformRail = studio.getByRole('complementary', { name: '平台列表' })
    const jdPlatform = platformRail.getByRole('button', { name: /京东/u })
    await expect(jdPlatform).toBeVisible({ timeout: 30_000 })
    await jdPlatform.click()
    await expect(jdPlatform).toHaveAttribute('aria-pressed', 'true')
    const importDisclosure = studio.locator('details.catalog-import-disclosure')
    await expect(importDisclosure.locator('summary')).toHaveText('商品表格导入')
    await importDisclosure.locator('summary').click()
    const form = studio.getByTestId('merchant-product-spreadsheet-import')
    await expect(form).toBeVisible({ timeout: 30_000 })
    await expect(form.getByText('仅草稿')).toBeVisible()
    await form.screenshot({ path: join(evidenceDir, 'merchant-import-before.png') })
    const uploadPromise = studio.waitForResponse(response => response.url().endsWith('/api/v1/assets/upload') && response.request().method() === 'POST')
    await form.locator('input[type="file"]').setInputFiles({ name: '商品-SKU导入模板.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook })
    const upload = await uploadPromise
    expect(upload.status()).toBe(201)
    const uploadBody = await upload.json()
    const assetId = uploadBody.data?.id
    expect(assetId).toMatch(/^asset_/u)
    await expect(form.getByText('预览：1 个商品，1 个 SKU / 商品记录')).toBeVisible({ timeout: 90_000 })
    await expect(form.getByRole('alert')).toHaveCount(0)
    await form.screenshot({ path: join(evidenceDir, 'merchant-import-preview.png') })
    const importPromise = studio.waitForResponse(response => response.url().endsWith('/api/mcp') && response.request().method() === 'POST'
      && response.request().postDataJSON()?.method === 'catalog.import.batch')
    await form.getByRole('button', { name: '确认并创建草稿' }).click()
    const imported = await importPromise
    expect(imported.status()).toBe(200)
    const importBody = await imported.json()
    expect(importBody.error).toBeNull()
    const importedResult = importBody.data?.result
    expect(importedResult).toMatchObject({ draft_only: true, knowledge: { indexState: 'queued', approvalStatus: 'pending' } })
    const productId = importedResult?.products?.[0]?.id ?? importedResult?.products?.[0]?.product_id
    expect(productId).toBe('prod_jd_10137064435110')
    await expect(form.getByText('不可同步或发布')).toBeVisible({ timeout: 30_000 })
    await form.screenshot({ path: join(evidenceDir, 'merchant-import-complete.png') })

    const tokenResponse = await merchant.request.post(new URL('/api/v1/auth/mcp-token', merchantBase).href, { data: { workspace_id: workspaceId } })
    expect(tokenResponse.status()).toBe(200)
    const token = (await tokenResponse.json()).data?.access_token
    expect(typeof token).toBe('string')
    const searchResponse = await merchant.request.post(new URL('/api/mcp', merchantBase).href, {
      headers: { authorization: `Bearer ${token}` },
      data: { jsonrpc: '2.0', id: 'product-import-scan', method: 'catalog.search', params: { scope: 'workspace', include_knowledge: 'true', query: '贵人鸟' } },
    })
    expect(searchResponse.status()).toBe(200)
    const searchBody = await searchResponse.json()
    expect(searchBody.error).toBeNull()
    const result = searchBody.data?.result ?? searchBody.result
    const product = result?.products?.find(item => item.product_id === productId)
    expect(product).toBeTruthy()
    expect(product.knowledge_documents).toEqual([])
    expect(product.knowledge_status).toMatchObject({ state: 'pending_review_or_index', next_action: 'knowledge.asset.update' })
    expect(product.knowledge_status.statuses).toContain('pending/unknown/queued')
    await writeFile(join(evidenceDir, 'product-import-browser-evidence.json'), JSON.stringify({
      workspace_id: workspaceId, asset_id: assetId, product_id: productId,
      catalog_search: { productVisible: true, knowledgeDocuments: 0, knowledgeStatus: product.knowledge_status },
      ui: { opsTemplateDownloaded: true, merchantPreview: true, merchantDraftCreated: true },
    }, null, 2), { mode: 0o600, flag: 'wx' })
  } finally { await merchant.close() }
})
