import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_merchant_session_retry_fixture'
test.setTimeout(90_000)

const envelope = (data, error = null) => ({
  request_id: 'merchant-session-retry-fixture',
  trace_id: 'merchant-session-retry-fixture',
  workspace_id: '',
  data,
  warnings: [],
  next_actions: [],
  error,
})

test('merchant session probe shows a retryable 503 and recovers after rechecking the session', async () => {
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react()],
    optimizeDeps: { include: ['react', 'react-dom/client', 'antd', 'lucide-react'] },
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
  const page = await context.newPage()
  const externalRequests = []
  const unknownApiRequests = []
  const writeAttempts = []
  const pageErrors = []
  const consoleErrors = []
  const sessionReads = []
  const readOnlyMcpMethods = new Set([
    'billing.transactions',
    'canonical.product.consistency',
    'commercial.catalog.get',
    'commercial.notifications.list',
    'commercial.subscription.get',
    'creative-points.balance.get',
    'creative-points.statement.list',
    'platform.model.status',
    'subscription.get',
    'workspace.metrics',
  ])

  page.on('request', (request) => {
    if (new URL(request.url()).origin !== studioUrl) externalRequests.push(request.url())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== studioUrl) {
      externalRequests.push(route.request().url())
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname

    if (path === '/api/v1/auth/session') {
      sessionReads.push(request.method())
      if (request.method() !== 'GET') {
        writeAttempts.push(`${request.method()} ${path}`)
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, {
          code: 'FIXTURE_WRITE_BLOCKED', message: 'Session fixture allows GET only.',
        })) })
      }
      if (sessionReads.length === 1) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, {
          code: 'UPSTREAM_BUSY', message: 'Fixture session service temporarily unavailable.',
        })) })
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ account: {
        id: 'merchant-session-retry-user',
        login: 'session-retry@example.invalid',
        accountType: 'merchant',
        displayName: '会话恢复验收商家',
        enterpriseName: '会话恢复验收工作区',
        status: 'active',
        roles: ['merchant_owner'],
        workspaceIds: [workspaceId],
      } })) })
    }

    if (path === '/api/mcp') {
      let method = ''
      try { method = request.postDataJSON()?.method ?? '' } catch { /* rejected below */ }
      if (request.method() !== 'POST' || !readOnlyMcpMethods.has(method)) {
        writeAttempts.push(`${request.method()} ${path}${method ? ` method=${method}` : ''}`)
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, {
          code: 'FIXTURE_WRITE_BLOCKED', message: 'Only allowlisted read-only MCP methods are permitted.',
        })) })
      }
      const result = method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : method === 'platform.model.status'
          ? { state: 'ready', capabilities: { image_generation: false } }
          : method === 'creative-points.balance.get'
            ? { available_points: 0, balance_state: 'known' }
            : method === 'billing.transactions'
              ? { balance_cny: '0.00', transactions: [] }
              : method === 'subscription.get' || method === 'commercial.subscription.get'
                ? { commercial_entitlement: { schema_version: 'commercial.entitlement.v2', status: 'unknown' }, legacy_commercial_entitlement: null }
                : { items: [], total: 0, limit: 50, offset: 0 }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ result })) })
    }

    if (request.method() === 'POST' && path === '/api/v1/auth/mcp-token') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        access_token: 'merchant-session-retry-fixture-token',
        refresh_token: 'merchant-session-retry-fixture-refresh',
        expires_in: 300,
        workspace_id: workspaceId,
      })) })
    }
    if (request.method() !== 'GET') {
      writeAttempts.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, {
        code: 'FIXTURE_WRITE_BLOCKED', message: 'Only explicitly stubbed auth and read-only operations are allowed.',
      })) })
    }
    if (path === '/api/healthz') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({
        status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true },
        setup: { mode: 'demo', platformOperations: { mode: 'manual', ready: true } },
      })) })
    }
    if (path === '/api/v1/platform-accounts') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [] })) })
    }
    if (path === '/api/v1/products') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    }
    if (path === '/api/v1/assets' || path === '/api/v1/rules') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope({ items: [], total: 0, limit: 50, offset: 0 })) })
    }

    unknownApiRequests.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify(envelope(null, {
      code: 'FIXTURE_UNKNOWN_API', message: 'Unknown local API request is blocked.',
    })) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('alert')).toContainText('无法验证登录状态：服务暂不可用')
    await expect(page.getByRole('button', { name: '重新检查登录状态' })).toBeVisible()
    expect(sessionReads).toEqual(['GET'])

    await page.getByRole('button', { name: '重新检查登录状态' }).click()
    await expect(page.getByRole('heading', { name: '事务看板' })).toBeVisible()
    await expect(page.getByRole('button', { name: '打开账号菜单' })).toBeVisible()
    await expect.poll(() => sessionReads).toEqual(['GET', 'GET'])
    await page.waitForLoadState('networkidle')

    expect(externalRequests).toEqual([])
    expect(unknownApiRequests).toEqual([])
    expect(writeAttempts).toEqual([])
    expect(pageErrors).toEqual([])
    expect(consoleErrors.filter((message) => message.includes('status of 503 (Service Unavailable)'))).toHaveLength(1)
    expect(consoleErrors.filter((message) => !message.includes('status of 503 (Service Unavailable)'))).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
