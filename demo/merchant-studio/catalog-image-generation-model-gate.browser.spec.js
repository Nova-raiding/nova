import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_catalog_model_gate_fixture'
const accountId = 'taobao-model-gate-store'
const productId = 'product_model_gate_fixture'
const envelope = (data, error = null) => ({ request_id: 'catalog-model-gate-fixture', trace_id: 'catalog-model-gate-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

const product = {
  id: productId, workspaceId, platform: 'taobao', accountId, storeName: '模型门禁验收店',
  title: '模型门禁验收商品', skuCount: 1, stock: 8, factsConfirmed: true,
  source: 'manual_import', updatedAt: '2026-10-11T00:00:00.000Z', version: 3,
  brandId: 'brand_model_gate_fixture', sourceAssetIds: [], images: [], skus: [],
}

const scenarios = [
  {
    name: '模型状态读取返回 503',
    statusResponse: { httpStatus: 503, body: envelope(null, { code: 'MODEL_STATUS_UNAVAILABLE', message: '模型中转状态暂时不可用' }) },
    blocker: '模型中转状态读取失败，系统不会生成或扣费。请重新检查。',
  },
  {
    name: '模型状态非就绪',
    statusResponse: { httpStatus: 200, body: envelope({ state: 'not_configured', capabilities: { image_generation: true } }) },
    blocker: '模型中转尚未就绪，系统不会生成、扣费或发布。',
  },
  {
    name: '模型未开放图片生成能力',
    statusResponse: { httpStatus: 200, body: envelope({ state: 'ready', capabilities: { image_generation: false } }) },
    blocker: '当前模型中转未开放图片生成能力，系统不会生成或扣费。',
  },
]

for (const scenario of scenarios) {
  test(`商品详情在${scenario.name}时禁用图片生成且不发送生成请求`, async () => {
    test.setTimeout(60_000)
    const vite = await createServer({
      configFile: false, envDir: false, root: studioRoot, plugins: [react()],
      define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    if (!address || typeof address === 'string') { await vite.close(); throw new Error('Catalog model gate fixture failed to bind an ephemeral TCP port') }

    const studioUrl = `http://127.0.0.1:${address.port}`
    const browser = await chromium.launch({ channel: 'chrome', headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    const generationRequests = []
    const unexpectedExternalRequests = []

    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== studioUrl) {
        unexpectedExternalRequests.push(url.href)
        return route.abort('blockedbyclient')
      }
      if (!url.pathname.startsWith('/api/')) return route.fallback()

      const request = route.request()
      const path = url.pathname
      let data = { items: [], total: 0, limit: 50, offset: 0 }
      if (path === '/api/healthz') {
        data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true } } }
      } else if (path === '/api/v1/auth/session') {
        data = { account: { id: 'catalog-model-gate-user', login: 'model-gate@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
      } else if (path === '/api/v1/platform-accounts') {
        data = { items: [{ platform: 'taobao', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'fixture', accountId, storeName: '模型门禁验收店', label: '模型门禁验收店' }] }
      } else if (path === '/api/v1/products' || path === '/api/v1/products/') {
        data = { items: [product], total: 1, limit: 50, offset: 0 }
      } else if (path === `/api/v1/products/${productId}`) {
        data = product
      } else if (path === '/api/v1/assets' || path === '/api/v1/assets/') {
        data = { items: [], total: 0, limit: 50, offset: 0 }
      } else if (path === '/api/v1/brand-scopes') {
        data = { settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: {}, series: {}, images: {} }, revision: 1, updated_at: null, series: [], assignments: [] }
      } else if (path === '/api/mcp' && request.method() === 'POST') {
        const rpc = request.postDataJSON()
        if (rpc?.method === 'catalog.image.generate') generationRequests.push(rpc)
        if (rpc?.method === 'platform.model.status' && scenario.statusResponse.httpStatus !== 200) {
          return route.fulfill({ status: scenario.statusResponse.httpStatus, contentType: 'application/json', body: JSON.stringify(scenario.statusResponse.body) })
        }
        const result = rpc?.method === 'platform.model.status'
          ? scenario.statusResponse.body.data
          : rpc?.method === 'workspace.metrics'
            ? { stores: [], productSummary: { total: 1, lowStock: 0, missingImages: 1 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
            : {}
        data = { result }
      } else if (request.method() !== 'GET') {
        return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNEXPECTED_WRITE', message: `Blocked ${request.method()} ${path}` })) })
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
    })

    try {
      await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^淘宝/u }).click()
      await page.locator('.catalog-store-card').filter({ hasText: '模型门禁验收店' }).getByRole('button', { name: /进入商品库/u }).click()
      await page.getByRole('button', { name: `打开${product.title}商品详情` }).click()

      const generateButton = page.getByTestId('catalog-generate-image')
      await expect(generateButton).toBeDisabled()
      await expect(page.locator('.catalog-detail-action-note')).toContainText(scenario.blocker)
      expect(generationRequests).toEqual([])
      expect(unexpectedExternalRequests).toEqual([])
    } finally {
      await context.close()
      await browser.close()
      await vite.close()
    }
  })
}
