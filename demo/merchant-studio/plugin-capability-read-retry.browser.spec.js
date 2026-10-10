import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_plugin_capability_retry_fixture'
const envelope = (data, error = null) => ({ request_id: 'plugin-capability-retry-fixture', trace_id: 'plugin-capability-retry-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('plugin capability read failure has an explicit safe retry path', async () => {
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
    throw new Error('Plugin capability retry fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()
  const externalRequests = []
  const writeAttempts = []
  const capabilityReads = []

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    let method = ''
    if (path === '/mcp') {
      try { method = request.postDataJSON()?.method ?? '' } catch { /* blocked below */ }
    }
    const readOnlyMcp = path === '/mcp' && request.method() === 'POST' && ['billing.transactions', 'canonical.product.consistency', 'commercial.catalog.get', 'commercial.notifications.list', 'commercial.subscription.get', 'creative-points.balance.get', 'creative-points.statement.list', 'knowledge.asset.list', 'ops.members.list', 'platform.model.status', 'subscription.get', 'workspace.metrics'].includes(method)
    if (request.method() !== 'GET' && !(path === '/v1/auth/mcp-token' && request.method() === 'POST') && !readOnlyMcp) {
      writeAttempts.push(`${request.method()} ${path}${method ? ` method=${method}` : ''}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: '能力检查 fixture 只允许读取' })) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/auth/session') {
      data = { account: { id: 'plugin-capability-retry-user', login: 'plugin-retry@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/v1/auth/local-plugin/connect-capability') {
      capabilityReads.push(request.headers()['x-workspace-id'] ?? '')
      if (capabilityReads.length === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '连接能力暂时无法读取' })) })
      data = { one_click_available: true, supported_platforms: ['macos'] }
    } else if (path === '/mcp') {
      data = { result: method === 'platform.model.status'
        ? { state: 'ready', capabilities: { image_generation: false } }
        : method === 'workspace.metrics'
          ? { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} }
          : {} }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '打开账号菜单', exact: true }).click()
    const connectButton = page.getByRole('button', { name: '连接 ChatGPT 本地插件', exact: true })
    await expect(connectButton).toBeVisible()
    await expect(page.getByText('暂时无法确认一键连接状态，请打开安装与故障帮助。', { exact: true })).toBeVisible()
    await expect(connectButton).toBeDisabled()
    await expect.poll(() => capabilityReads.length).toBe(1)
    expect(capabilityReads).toEqual([workspaceId])

    await page.getByRole('button', { name: '重新检查一键连接', exact: true }).click()
    await expect(connectButton).toBeEnabled()
    await expect(page.getByText('暂时无法确认一键连接状态，请打开安装与故障帮助。', { exact: true })).toHaveCount(0)
    await expect.poll(() => capabilityReads.length).toBe(2)
    expect(capabilityReads).toEqual([workspaceId, workspaceId])
    expect(writeAttempts).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
