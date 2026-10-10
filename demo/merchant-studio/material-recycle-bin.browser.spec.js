import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_recycle_bin_browser_fixture'
const assetId = 'asset-recycle-retry-fixture'
test.setTimeout(90_000)

const envelope = (data) => ({
  request_id: 'recycle-bin-browser-fixture',
  trace_id: 'recycle-bin-browser-fixture',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
})

test('recycle bin retries failed reads and restores the selected server asset in its workspace scope', async () => {
  // Self-contained Vite fixture on an OS-assigned loopback port. All API calls
  // are intercepted below; this test cannot reach Demo or an external service.
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
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addCookies([{ name: 'recycle-auth-fixture', value: 'same-origin-session', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }])
  const page = await context.newPage()
  let trashReads = 0
  let failTrashRefresh = false
  const restoreRequests = []
  let trashRows = [{
    asset: {
      id: assetId,
      workspaceId,
      name: '待恢复春季主图.png',
      mimeType: 'image/png',
      sizeBytes: 4096,
      sha256: 'd'.repeat(64),
      scanStatus: 'clean',
      rightsStatus: 'approved',
      source: 'merchant_upload',
      createdAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
    },
    deleted_at: '2026-10-08T00:00:00.000Z',
    expires_at: '2026-11-07T00:00:00.000Z',
    deleted_by: 'fixture-owner',
    revision: 7,
  }]

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === '/api/healthz') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true },
        setup: { objectStorage: { configured: true } },
      })) })
    }
    if (path === '/api/v1/auth/session') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: {
        id: 'recycle-bin-browser-user', login: 'recycle-fixture@example.invalid', accountType: 'merchant',
        status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId],
      } })) })
    }
    if (path === '/api/v1/assets/trash' && request.method() === 'GET') {
      trashReads += 1
      // React StrictMode runs the mount effect twice in this dev fixture.
      // Keep both initial reads unavailable so the user-facing retry state is
      // observable, then let the explicit retry return the list.
      if (trashReads <= 2) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
          request_id: 'recycle-bin-first-read-failure',
          error: { code: 'FIXTURE_UNAVAILABLE', message: 'fixture read unavailable' },
        }) })
      }
      if (failTrashRefresh && trashReads === 4) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
          request_id: 'recycle-bin-refresh-failure',
          error: { code: 'FIXTURE_UNAVAILABLE', message: 'fixture refresh unavailable' },
        }) })
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        items: trashRows, total: trashRows.length, limit: 50, offset: 0,
      })) })
    }
    const restore = /^\/api\/v1\/assets\/([^/]+)\/restore$/u.exec(path)
    if (restore && request.method() === 'POST') {
      restoreRequests.push({
        assetId: decodeURIComponent(restore[1]),
        workspaceId: request.headers()['x-workspace-id'] ?? '',
        method: request.method(),
      })
      trashRows = trashRows.filter((row) => row.asset.id !== decodeURIComponent(restore[1]))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ id: assetId })) })
    }
    // Fail closed: no fixture request is ever allowed to fall through to a real API.
    if (path.startsWith('/api/v1/')) {
      const empty = path.includes('brand-scopes')
        ? { settings: {}, revision: 0, series: [], assignments: [] }
        : path.includes('storage') || path.includes('quota')
          ? { usedBytes: 0, reservedBytes: 0, limitBytes: 0, availableBytes: 0, status: 'unavailable' }
          : { items: [], total: 0, limit: 50, offset: 0 }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(empty)) })
    }
    return route.fulfill({ status: 404, body: 'unexpected local fixture request' })
  })

  try {
    page.on('console', (message) => console.log(`BROWSER_CONSOLE ${message.type()} ${message.text()}`))
    page.on('pageerror', (error) => console.log(`BROWSER_PAGE_ERROR ${error.message}`))
    page.on('requestfailed', (request) => console.log(`BROWSER_REQUEST_FAILED ${request.url()} ${request.failure()?.errorText}`))
    await page.goto(`${studioUrl}/merchant/products?section=trash`, { waitUntil: 'domcontentloaded' })
    const recycleBin = page.getByTestId('material-recycle-bin')
    await expect(recycleBin).toBeVisible({ timeout: 15_000 })
    await expect(recycleBin.getByRole('alert')).toContainText('服务端回收站读取失败')
    expect(trashReads).toBe(2)

    await recycleBin.getByRole('button', { name: '重试' }).click()
    const row = recycleBin.locator('article').filter({ hasText: '待恢复春季主图.png' })
    await expect(row).toBeVisible()
    await expect(row).toContainText('未分类 · 未读取 · PNG')
    await expect(row).toContainText('服务端素材')
    await expect(row).toContainText('保留至 2026/11/7（剩余 28 天）')
    await expect(row).toContainText('2026/10/8 删除')
    expect(trashReads).toBe(3)

    failTrashRefresh = true
    await recycleBin.getByRole('button', { name: '刷新回收站' }).click()
    await expect(recycleBin.getByRole('alert')).toContainText('回收站刷新失败')
    await expect(row).toBeVisible()
    expect(trashReads).toBe(4)

    failTrashRefresh = false
    await recycleBin.getByRole('button', { name: '刷新回收站' }).click()
    await expect(recycleBin.getByRole('alert')).toHaveCount(0)
    await expect(row).toBeVisible()
    expect(trashReads).toBe(5)

    const restoreButton = recycleBin.getByRole('button', { name: '恢复', exact: true })
    await expect(restoreButton).toBeDisabled()
    await row.getByRole('button', { name: '选择待恢复春季主图.png' }).click()
    await expect(restoreButton).toBeEnabled()
    await expect(recycleBin.getByText('已选 1 项')).toBeVisible()
    await restoreButton.click()

    await expect.poll(() => restoreRequests.length).toBe(1)
    expect(restoreRequests).toEqual([{ assetId, workspaceId, method: 'POST' }])
    await expect.poll(() => trashReads).toBe(6)
    await expect(row).toHaveCount(0)
    await expect(recycleBin.getByText('回收站为空')).toBeVisible()
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
