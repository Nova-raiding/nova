import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_material_read_recovery_fixture'
const envelope = (data, error = null) => ({ request_id: 'material-read-recovery-fixture', trace_id: 'material-read-recovery-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('material library distinguishes a failed initial read from empty and recovers on explicit retry', async () => {
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
    throw new Error('Material read recovery fixture did not bind an ephemeral TCP port')
  }

  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const assetReads = []
  let userRetried = false
  const asset = {
    id: 'asset_material_read_recovery_fixture', workspaceId, name: 'recovered-library-file.pdf', mimeType: 'application/pdf', sizeBytes: 1200,
    sha256: 'f'.repeat(64), scanStatus: 'clean', rightsStatus: 'approved', source: 'merchant_upload',
    createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
  }

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== studioUrl) return route.abort('blockedbyclient')
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const request = route.request()
    const path = url.pathname
    if (path === '/api/healthz') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true } } })) })
    }
    if (path === '/api/v1/auth/session') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: { id: 'material-read-user', login: 'material-read@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } })) })
    }
    if (path === '/api/v1/platform-accounts') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [] })) })
    }
    if (path === '/api/v1/assets' || path === '/api/v1/assets/') {
      assetReads.push({ method: request.method(), workspaceId: request.headers()['x-workspace-id'] ?? '' })
      if (!userRetried) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '素材服务暂不可用，请重试。' })) })
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [asset], total: 1, limit: 50, offset: 0 })) })
    }
    if (path === '/api/v1/brand-scopes') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ settings: {}, revision: 0, series: [], assignments: [] })) })
    }
    if (path.includes('/storage') || path.includes('/quota')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ usedBytes: 0, reservedBytes: 0, limitBytes: 1_000_000, availableBytes: 1_000_000, status: 'available' })) })
    }
    if (path === '/api/mcp') {
      const method = request.postDataJSON()?.method
      const result = method === 'workspace.metrics'
        ? { riskItems: [], stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : method === 'creative-points.balance.get' ? { balance_state: 'known', available_points: 0 }
          : method === 'billing.transactions' ? { balance_cny: '0.00', transactions: [] }
            : { items: [], total: 0, limit: 50, offset: 0 }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNMOCKED_FIXTURE_REQUEST', message: `Blocked fixture route ${path}` })) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=knowledge`, { waitUntil: 'domcontentloaded' })
    const workspace = page.getByTestId('material-library-workspace')
    await expect(workspace).toBeVisible()
    await expect(workspace.getByRole('alert')).toContainText('素材读取失败')
    await expect(workspace.getByText('本页不会用本地演示数据替代服务端素材。')).toBeVisible()
    await expect(workspace.locator('article')).toHaveCount(0)
    expect(assetReads.length).toBeGreaterThan(0)
    expect(assetReads.every((read) => read.method === 'GET' && read.workspaceId === workspaceId)).toBe(true)

    const readsBeforeRetry = assetReads.length
    userRetried = true
    await workspace.getByRole('button', { name: '重新读取素材' }).click()
    await expect(workspace.locator('article').filter({ hasText: asset.name })).toBeVisible()
    await expect(workspace.getByRole('alert')).toHaveCount(0)
    expect(assetReads.length).toBeGreaterThan(readsBeforeRetry)
    expect(assetReads.every((read) => read.method === 'GET' && read.workspaceId === workspaceId)).toBe(true)
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
