import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_catalog_image_unknown_fixture'
const accountId = 'taobao-image-unknown-store'
const productId = 'product_image_unknown_fixture'
const sourceAssetId = 'asset_image_unknown_fixture'
const jobId = 'image-job-recovered-fixture'
const envelope = (data, error = null) => ({ request_id: 'catalog-image-unknown-fixture', trace_id: 'catalog-image-unknown-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

const product = {
  id: productId, workspaceId, platform: 'taobao', accountId, storeName: '图片任务回读验收店',
  title: '图片任务未知结果验收商品', skuCount: 1, stock: 12, factsConfirmed: true,
  source: 'manual_import', updatedAt: '2026-10-10T00:00:00.000Z', version: 7,
  brandId: 'brand_image_unknown_fixture', sourceAssetIds: [sourceAssetId], images: [], skus: [],
}
const sourceAsset = {
  id: sourceAssetId, workspaceId, name: '已授权来源素材.png', mimeType: 'image/png', sizeBytes: 1024,
  sha256: 'a'.repeat(64), scanStatus: 'clean', rightsStatus: 'approved', rightsScope: 'owned',
  usageScopes: ['commercial', 'ai_generation'], aiModificationAllowed: true, ai_modification_allowed: true,
  scanReceiptId: 'scan-image-unknown-fixture', scanReceiptDigest: 'b'.repeat(64), scanVerdict: 'clean',
  storageKey: `clean/${workspaceId}/${sourceAssetId}.png`, revision: 1, createdAt: '2026-10-10T00:00:00.000Z', references: [],
  parseStatus: 'succeeded', contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true },
}

test('未知图片生成结果锁定创意参数；原请求重放恢复既有任务并读取状态', async () => {
  test.setTimeout(90_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') { await vite.close(); throw new Error('Catalog image recovery fixture failed to bind an ephemeral TCP port') }

  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const generationRequests = []
  const unexpectedRequests = []
  let jobCommitted = false

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== studioUrl) return route.abort('blockedbyclient')
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const request = route.request()
    const path = url.pathname
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/api/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true } } }
    } else if (path === '/api/v1/auth/session') {
      data = { account: { id: 'catalog-image-user', login: 'catalog-image@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/api/v1/platform-accounts') {
      data = { items: [{ platform: 'taobao', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'fixture', accountId, storeName: '图片任务回读验收店', label: '图片任务回读验收店' }] }
    } else if (path === '/api/v1/products' || path === '/api/v1/products/') {
      data = { items: [{ ...product }], total: 1, limit: 50, offset: 0 }
    } else if (path === `/api/v1/products/${productId}`) {
      data = product
    } else if (path === '/api/v1/assets' || path === '/api/v1/assets/') {
      data = { items: [sourceAsset], total: 1, limit: 50, offset: 0 }
    } else if (path === '/api/v1/brand-scopes') {
      data = { settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} }, revision: 1, updated_at: null, series: [], assignments: [] }
    } else if (path === '/api/v1/image-generation-jobs' || path === '/api/v1/image-generation-jobs/') {
      data = { items: jobCommitted ? [{ job_id: jobId, product_id: productId, state: 'queued', archive_state: 'pending', execution_state: 'queued', requested_count: 2, candidate_count: 0, product_title: product.title, platform: 'taobao', store_name: '图片任务回读验收店', created_at: '2026-10-11T00:00:00.000Z', updated_at: '2026-10-11T00:00:00.000Z' }] : [], total: jobCommitted ? 1 : 0, limit: 50, offset: 0 }
    } else if (path === `/api/v1/image-generation-jobs/${jobId}`) {
      data = { job_id: jobId, revision: 1, state: 'queued', archive_state: 'pending', product_id: productId, task_id: null, content_version_id: null, image_mode: 'optimize', direction: '保留商品本体并生成简洁春日主图', requested_count: 2, source_asset_ids: [sourceAssetId], source_product_version: 7, intent_hash: 'c'.repeat(64), execution_state: 'queued', provider_request_id: null, execution_attempt: 0, reconciliation_required: false, error_code: null, error_message: null, updated_at: '2026-10-11T00:00:00.000Z', created_at: '2026-10-11T00:00:00.000Z', outputs: [], images: [], availability_warning: '图片任务尚未形成可交付候选。', next_action: { type: 'refresh_status', label: '刷新任务状态', allowed: true } }
    } else if (path === '/api/mcp' && request.method() === 'POST') {
      const rpc = request.postDataJSON()
      if (rpc?.method === 'catalog.image.generate') {
        generationRequests.push(rpc)
        if (!jobCommitted) {
          jobCommitted = true // server committed the job, but the first response was lost
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', message: '模型请求结果尚未确认', details: { retryable: false, reconciliation_required: true } })) })
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result: { job_id: jobId, product_id: productId, next_action: { type: 'refresh_status', label: '查看任务状态', allowed: true } } })) })
      }
      const method = rpc?.method
      const result = method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: true } }
        : method === 'canonical.product.consistency' ? { freshness: 'fresh' }
          : method === 'creative-points.balance.get' ? { balance_state: 'known', available_points: 100 }
            : method === 'billing.transactions' ? { balance_cny: '0.00', transactions: [] }
              : method === 'workspace.metrics' ? { stores: [], productSummary: { total: 1, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
                : { items: [], total: 0, limit: 50, offset: 0 }
      data = { result }
    } else if (path === '/api/v1/tasks' || path === '/api/v1/publish-jobs' || path === '/api/v1/task-groups') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (request.method() !== 'GET') {
      unexpectedRequests.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_WRITE', message: `Blocked ${request.method()} ${path}` })) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /^淘宝/u }).click()
    await page.locator('.catalog-store-card').filter({ hasText: '图片任务回读验收店' }).getByRole('button', { name: /进入商品库/u }).click()
    await page.getByRole('button', { name: `打开${product.title}商品详情` }).click()
    await page.getByTestId('catalog-generate-image').click()

    const dialog = page.getByTestId('catalog-image-generation-dialog')
    const direction = dialog.getByLabel('生成方向')
    await expect(direction).toBeVisible()

    // Invalid form input must be explained at the form, point back to the
    // field that needs attention, and never reach the generation RPC.
    await direction.fill('')
    await dialog.getByRole('button', { name: '确认生成' }).click()
    const directionError = dialog.getByRole('alert').filter({ hasText: '请填写图片生成方向。' })
    await expect(directionError).toBeVisible()
    await expect(directionError).toBeFocused()
    await expect(direction).toHaveAttribute('aria-invalid', 'true')
    expect(generationRequests).toHaveLength(0)
    await directionError.getByRole('button', { name: '跳转到需要修正的字段' }).click()
    await expect(dialog).toBeVisible()
    await expect(direction).toBeFocused()
    expect(new URL(page.url()).hash).toBe('')

    await direction.fill('保留商品本体并生成简洁春日主图')
    await dialog.getByLabel('候选数量').fill('7')
    await dialog.getByRole('button', { name: '确认生成' }).click()
    const countError = dialog.getByRole('alert').filter({ hasText: '候选数量必须是 1–6。' })
    await expect(countError).toBeVisible()
    await expect(countError).toBeFocused()
    await expect(dialog.getByLabel('候选数量')).toHaveAttribute('aria-invalid', 'true')
    expect(generationRequests).toHaveLength(0)
    await countError.getByRole('button', { name: '跳转到需要修正的字段' }).click()
    await expect(dialog.getByLabel('候选数量')).toBeFocused()
    await expect(dialog).toBeVisible()
    expect(new URL(page.url()).hash).toBe('')

    await dialog.getByLabel('候选数量').fill('2')
    await dialog.getByRole('button', { name: '确认生成' }).click()

    const error = dialog.getByRole('alert').filter({ hasText: '结果尚未确认' })
    await expect(error).toBeVisible()
    await expect(direction).toBeDisabled()
    await expect(dialog.getByLabel('候选数量')).toBeDisabled()
    await expect(dialog.getByLabel('输出用途与画布尺寸')).toBeDisabled()
    await expect(error).toContainText('不要修改参数')
    const recover = dialog.getByRole('button', { name: '使用原请求恢复任务' })
    await expect(recover).toBeEnabled()
    await recover.click()

    await expect(page).toHaveURL(new RegExp(`/merchant/tasks\\?image_job=${jobId}`))
    await expect(page.getByRole('heading', { name: '图片生成任务' })).toBeVisible()
    await expect(page.getByText('排队中', { exact: true })).toBeVisible()
    expect(generationRequests).toHaveLength(2)
    expect(generationRequests[1]?.params).toEqual(generationRequests[0]?.params)
    expect(generationRequests[0]?.params).toMatchObject({ product_id: productId, account_id: accountId, mode: 'optimize', count: '2', direction: '保留商品本体并生成简洁春日主图' })
    expect(generationRequests[0]?.params.idempotency_key).toBe(generationRequests[1]?.params.idempotency_key)
    expect(unexpectedRequests).toEqual([])

    // A later, separately confirmed intent with the same product and parameters
    // must create a fresh idempotency key. The first two requests above are one
    // ambiguous intent and must continue to share their original key.
    await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /^淘宝/u }).click()
    await page.locator('.catalog-store-card').filter({ hasText: '图片任务回读验收店' }).getByRole('button', { name: /进入商品库/u }).click()
    await page.getByRole('button', { name: `打开${product.title}商品详情` }).click()
    await page.getByTestId('catalog-generate-image').click()
    const nextDialog = page.getByTestId('catalog-image-generation-dialog')
    await nextDialog.getByLabel('生成方向').fill('保留商品本体并生成简洁春日主图')
    await nextDialog.getByLabel('候选数量').fill('2')
    await nextDialog.getByRole('button', { name: '确认生成' }).click()
    await expect(page).toHaveURL(new RegExp(`/merchant/tasks\\?image_job=${jobId}`))
    expect(generationRequests).toHaveLength(3)
    const { idempotency_key: recoveredIntentKey, ...recoveredIntentParams } = generationRequests[1].params
    expect(generationRequests[2]?.params).toMatchObject(recoveredIntentParams)
    expect(generationRequests[2]?.params.idempotency_key).not.toBe(recoveredIntentKey)
    expect(unexpectedRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
