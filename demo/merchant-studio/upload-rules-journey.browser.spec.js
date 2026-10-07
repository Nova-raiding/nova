import { expect, test, chromium } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18084'
// The Vite test bundle defaults to ws_demo when no explicit runtime workspace
// is injected; keep the fixture envelope aligned with that authenticated scope.
const workspaceId = 'ws_demo'
const requestLog = []
test.setTimeout(60_000)

const envelope = (data, error = null) => ({
  request_id: 'upload-rules-fixture',
  trace_id: 'upload-rules-fixture',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error,
})

async function openFixturePage(path) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  requestLog.length = 0
  await page.route('**/api/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname.replace(/^\/api/u, '')
    requestLog.push({ pathname, method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer()?.toString() })
    let data
    if (pathname === '/v1/auth/session') data = { account: {
      id: 'merchant_upload_fixture', login: 'upload-fixture@example.invalid',
      accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId],
    } }
    else if (pathname === '/v1/auth/mcp-token') data = { access_token: 'fixture-only-token', refresh_token: 'fixture-only-refresh', expires_in: 300 }
    else if (pathname === '/healthz') data = { status: 'ok', writesEnabled: true, connectors: {}, persistence: { mode: 'fixture', ready: true } }
    else if (pathname.startsWith('/v1/assets/upload')) {
      data = { id: 'asset_rule_material_fixture', workspaceId, name: 'merchant-rule-notes.md', mimeType: 'text/markdown', sizeBytes: 25, sha256: 'b'.repeat(64), scanStatus: 'unscanned', rightsStatus: 'pending', source: 'merchant_upload', materialCategory: '未分类', createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' }
    }
    else if (pathname === '/v1/assets' || pathname.startsWith('/v1/assets?')) data = { items: [], total: 0, limit: 50, offset: 0, storage_quota: { used_bytes: 0, limit_bytes: 1000000000 } }
    else if (pathname === '/v1/platform-accounts') data = { items: [] }
    else if (pathname === '/v1/products') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (pathname === '/v1/brand-profile') data = { profile: null }
    else if (pathname === '/v1/brand-scopes') data = { settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} }, revision: 0, updated_at: null, series: [], assignments: [] }
    else if (pathname === '/v1/rules') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (pathname === '/v1/catalog/categories') data = []
    else if (pathname === '/mcp') {
      const method = request.postDataJSON()?.method
      data = { result: method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : method === 'creative-points.balance.get' ? { available_points: 100 }
          : method === 'billing.transactions' ? { balance_cny: '0.00', transactions: [] }
            : method === 'subscription.get' ? { schema_version: 'commercial.entitlement.v2', status: 'unknown' }
              : { items: [], total: 0, limit: 50, offset: 0 } }
    }
    else data = { items: [], total: 0, limit: 50, offset: 0 }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })
  await page.goto(new URL(path, studioUrl).href, { waitUntil: 'domcontentloaded' })
  return { browser, context, page }
}

test('merchant knowledge upload is an asset write, not a rule import', async () => {
  const { browser, context, page } = await openFixturePage('/merchant/products?section=knowledge')
  try {
    await expect(page.getByTestId('material-library-workspace')).toBeVisible()
    await page.getByRole('button', { name: '上传素材' }).click()
    await expect(page.getByTestId('material-upload-dialog')).toBeVisible()
    await page.locator('[data-testid="material-upload-dialog"] input[type="file"]').setInputFiles({
      name: 'merchant-rule-notes.md', mimeType: 'text/markdown',
      buffer: Buffer.from('Merchant business constraints for review.'),
    })
    await expect(page.getByText('merchant-rule-notes.md', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '所属系列' }).click()
    await page.getByRole('option', { name: '未分类' }).click()
    await page.getByRole('button', { name: /确认上传/ }).click()
    await expect(page.getByTestId('material-upload-dialog')).toHaveCount(0)
    const assetUpload = requestLog.find(request => request.pathname === '/v1/assets/upload')
    expect(assetUpload).toMatchObject({ method: 'POST' })
    expect(assetUpload.headers['x-asset-name']).toBe('merchant-rule-notes.md')
    expect(assetUpload.body).toContain('Merchant business constraints for review.')
    const uploadedCard = page.locator('article').filter({ hasText: 'merchant-rule-notes.md' })
    await expect(uploadedCard).toContainText('未分类 · 未读取 · MD')
    await expect(uploadedCard).not.toContainText('规则已导入')
    expect(requestLog.some(request => request.pathname.includes('/rules/upload'))).toBe(false)
  } finally {
    await context.close()
    await browser.close()
  }
})
