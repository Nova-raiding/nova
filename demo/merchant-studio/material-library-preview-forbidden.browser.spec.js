import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_material_preview_forbidden_fixture'
const assetId = 'asset-preview-forbidden-fixture'
test.setTimeout(90_000)

const envelope = (data) => ({
  request_id: 'material-preview-forbidden-fixture',
  trace_id: 'material-preview-forbidden-fixture',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
})

test('keeps an asset card usable when its authenticated preview read is forbidden', async () => {
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
    throw new Error('Local Merchant Studio fixture did not bind an ephemeral TCP port')
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addCookies([{
    name: 'preview-auth-fixture',
    value: 'same-origin-session',
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  }])
  const page = await context.newPage()
  const previewRequests = []
  const apiPaths = []
  const mcpMethods = []
  const pageErrors = []
  const unexpected404Responses = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('response', (response) => {
    if (response.status() === 404) unexpected404Responses.push(response.url())
  })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    apiPaths.push(path)
    if (path === '/api/healthz') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        status: 'ok', writesEnabled: false, connectors: {},
        persistence: { mode: 'fixture', ready: true },
        setup: { objectStorage: { configured: true } },
      })) })
    }
    if (path === '/api/mcp') {
      const rpc = request.postDataJSON()
      mcpMethods.push(rpc.method)
      const result = rpc.method === 'workspace.metrics'
        ? { riskItems: [], stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : rpc.method === 'subscription.get'
          ? { commercial_entitlement: { status: 'unknown' }, legacy_commercial_entitlement: null }
          : { items: [], total: 0, limit: 50, offset: 0 }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
    }
    if (path === '/api/v1/auth/session') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: {
        id: 'material-preview-forbidden-user',
        login: 'preview-fixture@example.invalid',
        accountType: 'merchant',
        status: 'active',
        roles: ['merchant_owner'],
        workspaceIds: [workspaceId],
      } })) })
    }
    if (path === '/api/v1/assets' || path === '/api/v1/assets/') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        items: [{
          id: assetId,
          workspaceId,
          name: '无权限样图.png',
          mimeType: 'image/png',
          sizeBytes: 128,
          sha256: 'c'.repeat(64),
          scanStatus: 'clean',
          rightsStatus: 'approved',
          source: 'merchant_upload',
          createdAt: '2026-10-08T00:00:00.000Z',
          updatedAt: '2026-10-08T00:00:00.000Z',
        }],
        total: 1,
        limit: 50,
        offset: 0,
      })) })
    }
    const download = new RegExp(`^/api/v1/assets/${assetId}/download$`, 'u').test(path)
    if (download) {
      previewRequests.push({
        cookie: request.headers().cookie ?? '',
        accept: request.headers().accept,
      })
      return route.fulfill({ status: 403, contentType: 'text/plain', body: 'forbidden' })
    }
    if (path.startsWith('/api/v1/')) {
      const data = path.includes('brand-scopes')
        ? { settings: {}, revision: 0, series: [], assignments: [] }
        : path.includes('storage') || path.includes('quota')
          ? { usedBytes: 0, reservedBytes: 0, limitBytes: 0, availableBytes: 0, status: 'unavailable' }
          : { items: [], total: 0, limit: 50, offset: 0 }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
    }
    return route.fulfill({ status: 404, body: 'unexpected local fixture request' })
  })

  try {
    await page.goto(`http://127.0.0.1:${address.port}/merchant/products?section=knowledge`, {
      waitUntil: 'domcontentloaded',
    })
    const workspace = page.getByTestId('material-library-workspace')
    await expect(workspace).toBeVisible()

    const card = workspace.locator('article').filter({ hasText: '无权限样图.png' })
    await expect(card, `Merchant API requests: ${JSON.stringify(apiPaths)}`).toBeVisible()
    expect(mcpMethods.length).toBeGreaterThan(0)
    await expect(card.locator('.material-card-open img')).toHaveCount(0)
    await expect(card.locator('.material-card-open svg')).toBeVisible()
    await expect.poll(() => previewRequests.length).toBe(1)
    expect(previewRequests[0]).toEqual({
      cookie: 'preview-auth-fixture=same-origin-session',
      accept: 'application/octet-stream',
    })
    expect(unexpected404Responses, 'Unexpected browser HTTP 404 responses').toEqual([])

    await card.getByRole('button', { name: '查看无权限样图.png详情' }).click()
    const detailPreview = page.locator('.material-detail-preview')
    await expect(detailPreview).toBeVisible()
    await expect(detailPreview.locator('img')).toHaveCount(0)
    await expect(detailPreview.locator('svg')).toBeVisible()
    expect(unexpected404Responses, 'Unexpected browser HTTP 404 responses').toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
