import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
    await expect(workspace.getByText('请点击“重新读取素材”重试。')).toBeVisible()
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

test('material storage card explains a successful missing quota separately from a failed read', async () => {
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
    throw new Error('Material quota fixture did not bind an ephemeral TCP port')
  }

  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const screenshotDirectory = resolve('artifacts/plugin-recovery-next/material-library-quota-fixture')
  mkdirSync(screenshotDirectory, { recursive: true, mode: 0o700 })
  const requests = []
  const blockedWrites = []
  const unknownApiRequests = []
  const pageErrors = []
  const mcpMethods = []
  let quotaMode = 'missing'
  let quotaReads = 0
  const readonlyMcpMethods = new Set([
    'workspace.metrics',
    'canonical.product.consistency',
    'creative-points.balance.get',
    'creative-points.statement.list',
    'billing.transactions',
    'subscription.get',
  ])

  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (url.origin !== studioUrl) {
      unknownApiRequests.push({ method, path: url.pathname, reason: 'outside-fixture-origin' })
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()

    const path = url.pathname
    const rpcMethod = method === 'POST' && path === '/api/mcp' ? request.postDataJSON()?.method : undefined
    requests.push({ method, path, ...(rpcMethod ? { rpc_method: rpcMethod } : {}), search: url.search, status: null })
    const isAuthFixturePost = method === 'POST' && path === '/api/v1/auth/mcp-token'
    const isReadonlyMcpPost = method === 'POST' && path === '/api/mcp' && readonlyMcpMethods.has(rpcMethod)
    if (method !== 'GET' && !isAuthFixturePost && !isReadonlyMcpPost) {
      blockedWrites.push({ method, path, ...(rpcMethod ? { rpc_method: rpcMethod } : {}) })
      requests.at(-1).status = 403
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: 'unexpected write blocked by local fixture' })) })
    }

    let data = { items: [], total: 0, limit: 50, offset: 0 }
    let status = 200
    let error = null
    if (path === '/api/healthz') {
      data = {
        status: 'ok', writesEnabled: false, connectors: {},
        persistence: { mode: 'fixture', ready: true },
        setup: {
          ai: { costGate: 'blocked', relay: { configured: false } },
          modelReadiness: {
            text: { ready: false }, image: { ready: false }, image_edit: { ready: false },
            ocr: { ready: false }, video: { ready: false },
          },
        },
      }
    } else if (path === '/api/v1/auth/session') {
      data = { account: { id: 'material-storage-fixture-reader', login: 'fixture@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/api/v1/auth/mcp-token') {
      data = { access_token: 'local-fixture-token', refresh_token: 'local-fixture-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/api/v1/platform-accounts') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (path === '/api/v1/products' || path === '/api/v1/rules' || path === '/api/v1/catalog/categories') {
      data = path === '/api/v1/catalog/categories' ? [] : { items: [], total: 0, limit: 50, offset: 0 }
    } else if (path === '/api/v1/brand-scopes') {
      data = { settings: { schemaVersion: 1, stores: {}, series: {}, images: {} }, revision: 0, series: [], assignments: [] }
    } else if (path === '/api/v1/assets') {
      if (url.searchParams.get('limit') === '1') {
        quotaReads += 1
        if (request.headers()['x-workspace-id'] !== workspaceId) {
          status = 403
          error = { code: 'WORKSPACE_SCOPE_MISMATCH', message: 'fixture workspace mismatch' }
          data = null
        } else if (quotaMode === 'failure') {
          status = 402
          error = { code: 'ENTITLEMENT_REQUIRED_INTERNAL', message: 'internal fixture entitlement detail' }
          data = null
        } else {
          // A successful API page without the optional storage_quota projection.
          data = { items: [], total: 0, limit: 1, offset: 0 }
        }
      } else {
        data = { items: [], total: 0, limit: 50, offset: 0 }
      }
    } else if (path === '/api/mcp') {
      mcpMethods.push(rpcMethod)
      if (rpcMethod === 'workspace.metrics') data = { result: { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} } }
      else if (rpcMethod === 'canonical.product.consistency') data = { result: { readOnly: true, findings: [], orphanFindings: [], unified_link_audit: { persisted: false, count: 0, items: [] } } }
      else if (rpcMethod === 'creative-points.balance.get') data = { result: { available_points: 0 } }
      else if (rpcMethod === 'creative-points.statement.list') data = { result: { entries: [], next_cursor: null } }
      else if (rpcMethod === 'billing.transactions') data = { result: { balance_cny: '0.00', transactions: [] } }
      else if (rpcMethod === 'subscription.get') data = { result: { status: 'available', current: null, future: [], packs: [], history: [], orders: [] } }
      else data = { result: {} }
    } else {
      unknownApiRequests.push({ method, path, reason: 'unmocked-api-request' })
      requests.at(-1).status = 404
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'UNMOCKED_FIXTURE_REQUEST', message: 'unmocked API request' })) })
    }

    requests.at(-1).status = status
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(envelope(data, error)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=knowledge`, { waitUntil: 'domcontentloaded' })
    const storageCard = page.getByLabel('共享储存空间')
    await expect(page.getByTestId('material-library-workspace').getByRole('heading', { name: '素材库' })).toBeVisible()
    await expect(storageCard).toContainText('服务端未提供储存配额，当前不显示用量。')
    await expect(storageCard).toContainText('请到财务概况核对储存权益，或联系管理员确认配置。')
    await expect(storageCard).not.toContainText('配额读取失败')
    await expect(storageCard.getByRole('button')).toHaveCount(0)
    const missingQuotaCopy = storageCard.locator('span').filter({ hasText: '服务端未提供储存配额' })
    expect(await missingQuotaCopy.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await expect.poll(() => quotaReads).toBeGreaterThan(0)
    const missingScreenshot = resolve(screenshotDirectory, 'quota-missing.png')
    await page.screenshot({ path: missingScreenshot, fullPage: true })

    quotaMode = 'failure'
    await page.reload({ waitUntil: 'domcontentloaded' })
    const failedStorageCard = page.getByLabel('共享储存空间')
    await expect(failedStorageCard).toContainText('储存配额读取失败。')
    await expect(failedStorageCard).toContainText('核对储存权益')
    await expect(failedStorageCard).toContainText('联系管理员确认当前工作区权限')
    await expect(failedStorageCard).not.toContainText('服务端未提供储存配额')
    await expect(failedStorageCard).not.toContainText('402')
    await expect(failedStorageCard).not.toContainText('ENTITLEMENT_REQUIRED_INTERNAL')
    await expect(failedStorageCard.getByRole('button')).toHaveCount(0)
    const failedQuotaCopy = failedStorageCard.locator('span').filter({ hasText: '储存配额读取失败' })
    expect(await failedQuotaCopy.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    const failedScreenshot = resolve(screenshotDirectory, 'quota-read-failed.png')
    await page.screenshot({ path: failedScreenshot, fullPage: true })

    expect(quotaReads).toBeGreaterThanOrEqual(2)
    const quotaRequests = requests.filter(item => item.path === '/api/v1/assets' && item.search.includes('limit=1'))
    expect(quotaRequests.some(item => item.status === 200)).toBe(true)
    expect(quotaRequests.at(-1)?.status).toBe(402)
    expect(quotaRequests.every(item => item.method === 'GET')).toBe(true)
    expect(blockedWrites).toEqual([])
    expect(unknownApiRequests).toEqual([])
    expect(mcpMethods.every(method => readonlyMcpMethods.has(method))).toBe(true)
    expect(mcpMethods.some(method => /generate|image|video|ocr|vision|transcri/iu.test(method ?? ''))).toBe(false)
    expect(pageErrors).toEqual([])

    const receiptPath = resolve(screenshotDirectory, 'quota-state-receipt.json')
    writeFileSync(receiptPath, `${JSON.stringify({
      scope: 'local Vite materials workspace quota state fixture; no canonical API calls',
      quota_reads: quotaRequests,
      blocked_writes: blockedWrites,
      unknown_requests: unknownApiRequests,
      mocked_readonly_mcp_methods: mcpMethods,
      model_calls: [],
      page_errors: pageErrors,
      screenshots: [missingScreenshot, failedScreenshot],
      vite_closed_by_test: true,
      browser_closed_by_test: true,
      result: '200 missing quota explains service response; failed GET shows generic rights/admin guidance without internal code or retry',
      finished_at: new Date().toISOString(),
    }, null, 2)}\n`)
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
