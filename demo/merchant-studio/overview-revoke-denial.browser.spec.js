import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_overview_revoke_fixture'
const accountId = 'jd-store-revoke-fixture'
const envelope = (data, error = null) => ({ request_id: 'overview-revoke-fixture', trace_id: 'overview-revoke-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('overview revoke cancellation sends no request and a server denial preserves the readable connection', async () => {
  test.setTimeout(90_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Overview revoke fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const revokeRequests = []

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'official_api', ready: true } } }
    } else if (path === '/v1/auth/session') {
      data = { account: { id: 'overview-revoke-user', login: 'overview@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/v1/platform-accounts') {
      if (request.method() === 'DELETE') {
        revokeRequests.push({ method: request.method(), accountId: request.headers()['x-account-id'] })
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'PLATFORM_REVOKE_DENIED', message: '本地夹具拒绝撤销，连接状态保持不变。' })) })
      }
      data = { items: [{ platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'official_api', accountId, storeName: '本地授权店铺' }] }
    } else if (path === '/v1/sync-jobs') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      data = { result: method === 'workspace.metrics'
        ? { stores: [{ platform: 'jd', accountId, storeName: '本地授权店铺', connection: { readable: true, state: 'connected', dataMode: 'official_api' } }], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : method === 'platform.model.status' ? { state: 'ready', capabilities: {} } : {} }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    const platformRow = page.locator('.platform-list .platform-row').filter({ hasText: '本地授权店铺' })
    await expect(platformRow).toContainText('可读取')
    await platformRow.getByRole('button', { name: '撤销' }).click()

    const dialog = page.getByTestId('revoke-platform-dialog')
    await expect(dialog).toContainText('将立即停止“本地授权店铺”的同步和发布')
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toHaveCount(0)
    expect(revokeRequests).toEqual([])
    await expect(platformRow).toContainText('可读取')

    await platformRow.getByRole('button', { name: '撤销' }).click()
    await page.getByTestId('revoke-platform-dialog').getByRole('button', { name: '确认撤销连接' }).click()
    await expect(dialog.getByRole('alert')).toContainText('本地夹具拒绝撤销')
    await expect(platformRow).toContainText('可读取')
    await expect(dialog).toBeVisible()
    expect(revokeRequests).toEqual([{ method: 'DELETE', accountId }])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
