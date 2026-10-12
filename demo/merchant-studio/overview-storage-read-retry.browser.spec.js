import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4190'
const workspaceId = 'ws_overview_storage_retry'
const artifactDirectory = resolve('artifacts/owner-release/storage-quota-retry-ux')
const readonlyMcpMethods = new Set([
  'creative-points.balance.get',
  'billing.transactions',
  'creative-points.statement.list',
  'subscription.get',
  'commercial.subscription.get',
  'workspace.metrics',
])
const authFixturePostPaths = new Set(['/v1/auth/mcp-token'])

const envelope = (data, error = null) => ({
  request_id: 'overview-storage-read-retry',
  trace_id: 'overview-storage-read-retry',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error,
})

test.setTimeout(60_000)
test.use({ viewport: { width: 1440, height: 900 } })

test('overview explains a failed storage quota read and recovers after same GET retry', async ({ page }, testInfo) => {
  const requests = []
  const pageErrors = []
  let quotaReads = 0
  let allowQuotaRecovery = false
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/u, '')
    const method = request.method()
    const workspace = request.headers()['x-workspace-id'] ?? workspaceId
    const rpcMethod = method === 'POST' && path === '/mcp' ? request.postDataJSON()?.method : undefined
    requests.push({ method, path, ...(rpcMethod ? { rpc_method: rpcMethod } : {}), search: url.search, status: null })

    if (method !== 'GET' && !(method === 'POST' && path === '/mcp' && readonlyMcpMethods.has(rpcMethod)) && !(method === 'POST' && authFixturePostPaths.has(path))) {
      console.error(`FIXTURE_BLOCKED_POST method=${method} path=${path} rpc_method=${rpcMethod ?? ''}`)
      requests.at(-1).status = 403
      await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: 'unexpected write blocked by browser fixture' })) })
      return
    }

    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') {
      data = { account: { id: 'overview-storage-retry-account', login: 'qa@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: {
        platformOperations: { mode: 'manual', ready: true },
        ai: { costGate: 'blocked', relay: { configured: false } },
        modelReadiness: { text: { ready: false }, image: { ready: false }, image_edit: { ready: false }, ocr: { ready: false }, video: { ready: false } },
      } }
    } else if (path === '/v1/assets' && url.searchParams.get('limit') === '1') {
      quotaReads += 1
      if (!allowQuotaRecovery) {
        const status = 402
        requests.at(-1).status = status
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'ENTITLEMENT_REQUIRED', message: 'fixture quota denied' })) })
        return
      }
      data = { items: [], total: 0, limit: 1, offset: 0, storage_quota: { usedBytes: 1_500_000_000, reservedBytes: 0, limitBytes: 10_000_000_000, availableBytes: 8_500_000_000, status: 'available' } }
    } else if (path === '/v1/platform-accounts' || path === '/v1/products' || path === '/v1/rules' || path === '/v1/assets') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (path === '/mcp') {
      const { method: rpcMethod, params = {} } = request.postDataJSON()
      if (['creative-points.balance.get', 'billing.transactions', 'creative-points.statement.list', 'subscription.get', 'commercial.subscription.get'].includes(rpcMethod)) {
        data = { result: rpcMethod === 'creative-points.balance.get'
          ? { available_points: 0 }
          : rpcMethod === 'billing.transactions'
            ? { balance_cny: '0.00', transactions: [] }
            : rpcMethod === 'creative-points.statement.list'
              ? { entries: [], next_cursor: null }
              : { schema_version: 'commercial.subscription.v1', status: 'available', current: null, future: [], packs: [], history: [], orders: [] } }
      } else if (rpcMethod === 'workspace.metrics') {
        data = { result: { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {}, completedTaskCount: 0, date_from: params.date_from ?? '', date_to: params.date_to ?? '' } }
      } else {
        // Unknown POST methods are blocked above. This branch is a fail-safe
        // for any unexpected GET to the MCP endpoint.
        data = { result: {} }
      }
    }

    requests.at(-1).status = 200
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
  const storageMessage = page.locator('.today-storage-meta')
  await expect(storageMessage).toContainText('储存配额读取失败')
  await expect(storageMessage).toContainText('核对储存权益')
  await expect(storageMessage).toContainText('联系管理员确认当前工作区权限')
  await expect(storageMessage).not.toContainText('402')
  await expect(storageMessage).not.toContainText('ENTITLEMENT_REQUIRED')
  const retry = storageMessage.getByRole('button', { name: '重新读取' })
  await expect(retry).toBeEnabled()

  const failedScreenshotPath = resolve(artifactDirectory, 'overview-storage-quota-failed.png')
  await page.screenshot({ path: failedScreenshotPath, fullPage: true })
  expect(quotaReads).toBeGreaterThan(0)
  const quotaRequestsBeforeRetry = requests.filter(item => item.path === '/v1/assets' && item.search.includes('limit=1') && item.method === 'GET')
  expect(quotaRequestsBeforeRetry.every(item => item.status === 402)).toBe(true)
  const readsBeforeRetry = quotaReads
  allowQuotaRecovery = true
  await retry.click()

  await expect.poll(() => quotaReads).toBeGreaterThan(readsBeforeRetry)
  await expect(page.locator('.today-storage-heading')).toContainText('1.5 GB / 10.0 GB')
  await expect(storageMessage).toContainText('已用 1.5 GB')
  await expect(storageMessage).toContainText('剩余 8.5 GB')
  await expect(storageMessage.getByRole('button', { name: '重新读取' })).toHaveCount(0)
  expect(pageErrors).toEqual([])

  const recoveredScreenshotPath = resolve(artifactDirectory, 'overview-storage-quota-recovered.png')
  await page.screenshot({ path: recoveredScreenshotPath, fullPage: true })
  const quotaRequests = requests.filter(item => item.path === '/v1/assets' && item.search.includes('limit=1') && item.method === 'GET')
  expect(quotaRequests[0]?.status).toBe(402)
  expect(quotaRequests.at(-1)?.status).toBe(200)
  const authFixturePosts = requests.filter(item => item.method === 'POST' && authFixturePostPaths.has(item.path))
  const readonlyMcpCalls = requests.filter(item => item.method === 'POST' && item.path === '/mcp').map(item => item.rpc_method)
  const nonReadonlyPosts = requests.filter(item => item.method !== 'GET' && !(item.method === 'POST' && authFixturePostPaths.has(item.path)) && !(item.method === 'POST' && item.path === '/mcp' && readonlyMcpMethods.has(item.rpc_method)))
  const modelRpcCalls = readonlyMcpCalls.filter(name => /generate|image|video|ocr|vision|transcri/iu.test(name ?? ''))
  expect(nonReadonlyPosts).toEqual([])
  expect(modelRpcCalls).toEqual([])

  const receiptPath = resolve(artifactDirectory, 'overview-storage-quota-retry-receipt.json')
  mkdirSync(dirname(receiptPath), { recursive: true })
  writeFileSync(receiptPath, `${JSON.stringify({
    scope: 'isolated Vite merchant overview quota read retry fixture',
    workspace_id: workspaceId,
    quota_reads: quotaRequests,
    auth_fixture_posts: authFixturePosts.map(({ method, path, status }) => ({ method, path, status })),
    readonly_mcp_methods: readonlyMcpCalls,
    blocked_or_non_readonly_posts: nonReadonlyPosts,
    model_rpc_calls: modelRpcCalls,
    page_errors: pageErrors,
    screenshots: [failedScreenshotPath, recoveredScreenshotPath],
    browser_closed_by_playwright: true,
    result: 'first GET 402 showed actionable generic recovery copy; clicking retry repeated GET and rendered returned quota',
    finished_at: new Date().toISOString(),
  }, null, 2)}\n`)
  await testInfo.attach('quota-retry-receipt', { path: receiptPath, contentType: 'application/json' })
})
