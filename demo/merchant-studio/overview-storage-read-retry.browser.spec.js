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

test('late quota response from the previous workspace cannot replace the active workspace quota', async ({ page }, testInfo) => {
  const workspaceA = 'ws_overview_storage_retry_a'
  const workspaceB = 'ws_overview_storage_retry_b'
  const quotaReads = []
  const blockedWrites = []
  const pageErrors = []
  let releaseAQuota
  let markAStarted
  const delayedAQuota = new Promise(resolve => { releaseAQuota = resolve })
  const aQuotaStarted = new Promise(resolve => { markAStarted = resolve })
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/u, '')
    const method = request.method()
    const workspace = request.headers()['x-workspace-id'] ?? workspaceA
    const rpcMethod = method === 'POST' && path === '/mcp' ? request.postDataJSON()?.method : undefined

    if (method !== 'GET' && !(method === 'POST' && path === '/v1/auth/mcp-token') && !(method === 'POST' && path === '/mcp' && readonlyMcpMethods.has(rpcMethod))) {
      blockedWrites.push({ method, path, ...(rpcMethod ? { rpc_method: rpcMethod } : {}) })
      await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ...envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: 'unexpected write blocked by browser fixture' }), workspace_id: workspace }) })
      return
    }

    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') {
      data = { account: { id: 'overview-storage-switch-account', login: 'qa@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceA, workspaceB] } }
    } else if (path === '/v1/auth/mcp-token') {
      const targetWorkspace = request.postDataJSON()?.workspace_id ?? workspace
      data = { access_token: `fixture-token-${targetWorkspace}`, refresh_token: `fixture-refresh-${targetWorkspace}`, expires_in: 300, workspace_id: targetWorkspace }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: {
        platformOperations: { mode: 'manual', ready: true },
        ai: { costGate: 'blocked', relay: { configured: false } },
        modelReadiness: { text: { ready: false }, image: { ready: false }, image_edit: { ready: false }, ocr: { ready: false }, video: { ready: false } },
      } }
    } else if (path === '/v1/assets' && url.searchParams.get('limit') === '1') {
      const quotaRead = { workspace, status: null }
      quotaReads.push(quotaRead)
      if (workspace === workspaceA && quotaReads.filter(item => item.workspace === workspaceA).length === 1) {
        markAStarted()
        await delayedAQuota
      }
      const usedBytes = workspace === workspaceB ? 2_000_000_000 : 1_000_000_000
      quotaRead.status = 200
      data = { items: [], total: 0, limit: 1, offset: 0, storage_quota: { usedBytes, reservedBytes: 0, limitBytes: 10_000_000_000, availableBytes: 10_000_000_000 - usedBytes, status: 'available' } }
    } else if (path === '/v1/platform-accounts' || path === '/v1/products' || path === '/v1/rules' || path === '/v1/assets') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (path === '/mcp') {
      const { method: rpc, params = {} } = request.postDataJSON()
      if (rpc === 'workspace.metrics') data = { result: { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {}, completedTaskCount: 0, date_from: params.date_from ?? '', date_to: params.date_to ?? '' } }
      else if (rpc === 'creative-points.statement.list') data = { result: { entries: [], next_cursor: null } }
      else if (rpc === 'subscription.get' || rpc === 'commercial.subscription.get') data = { result: { schema_version: 'commercial.subscription.v1', status: 'available', current: null, future: [], packs: [], history: [], orders: [] } }
      else if (rpc === 'creative-points.balance.get') data = { result: { available_points: 0 } }
      else if (rpc === 'billing.transactions') data = { result: { balance_cny: '0.00', transactions: [] } }
      else data = { result: {} }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...envelope(data), workspace_id: workspace }) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    const bootstrap = page.getByRole('combobox', { name: '选择当前商家工作区 ID' })
    await expect(bootstrap).toBeVisible()
    await bootstrap.click()
    await page.getByText(`工作区 ID · ${workspaceA}`, { exact: true }).last().click()
    await aQuotaStarted

    const workspacePicker = page.getByRole('combobox', { name: '按工作区 ID 切换当前商家工作区' })
    await workspacePicker.click()
    await page.getByText(`工作区 ID · ${workspaceB}`, { exact: true }).last().click()
    const storageSummary = page.locator('.today-storage-heading')
    await expect(storageSummary).toContainText('2.0 GB / 10.0 GB')
    mkdirSync(artifactDirectory, { recursive: true })
    const beforeScreenshotPath = resolve(artifactDirectory, 'workspace-b-quota-before-late-a.png')
    const beforeLateResponse = await page.screenshot({ path: beforeScreenshotPath })

    await page.evaluate(() => {
      const target = document.querySelector('.today-storage-heading')
      if (!target) throw new Error('Storage quota heading was not rendered')
      window.__storageQuotaHeadingChanges = []
      new MutationObserver(() => window.__storageQuotaHeadingChanges.push(target.textContent ?? ''))
        .observe(target, { subtree: true, childList: true, characterData: true })
    })
    const lateAResponsePromise = page.waitForResponse(response => {
      const request = response.request()
      const responseUrl = new URL(response.url())
      return request.method() === 'GET'
        && responseUrl.pathname.endsWith('/v1/assets')
        && responseUrl.searchParams.get('limit') === '1'
        && request.headers()['x-workspace-id'] === workspaceA
    })
    releaseAQuota()
    const lateAResponse = await lateAResponsePromise
    expect(lateAResponse.status()).toBe(200)
    await lateAResponse.finished()
    await lateAResponse.json()
    // Let the response continuation and React's next paint complete before
    // checking the unchanged B value; the response itself must have finished.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(resolve, 50)))))
    await expect(storageSummary).toContainText('2.0 GB / 10.0 GB')
    await expect(storageSummary).not.toContainText('1.0 GB')
    expect(quotaReads.map(item => ({ workspace: item.workspace, status: item.status }))).toEqual([
      { workspace: workspaceA, status: 200 },
      { workspace: workspaceB, status: 200 },
    ])
    const staleResponseHeadingChanges = await page.evaluate(() => window.__storageQuotaHeadingChanges)
    expect(staleResponseHeadingChanges).not.toContain('1.0 GB / 10.0 GB')
    expect(blockedWrites).toEqual([])
    expect(pageErrors).toEqual([])
    const afterScreenshotPath = resolve(artifactDirectory, 'workspace-b-quota-after-late-a.png')
    const afterLateResponse = await page.screenshot({ path: afterScreenshotPath })
    await testInfo.attach('workspace-b-before-late-a', { body: beforeLateResponse, contentType: 'image/png' })
    await testInfo.attach('workspace-b-after-late-a', { body: afterLateResponse, contentType: 'image/png' })
    const receiptPath = resolve(artifactDirectory, 'workspace-switch-quota-stale-response-receipt.json')
    writeFileSync(receiptPath, `${JSON.stringify({
      scope: 'isolated Vite merchant overview workspace quota stale-response fixture',
      quota_reads: quotaReads,
      late_workspace_a_response_finished: lateAResponse.status(),
      active_workspace_after_late_response: workspaceB,
      observed_heading_changes_after_release: staleResponseHeadingChanges,
      blocked_or_non_readonly_posts: blockedWrites,
      page_errors: pageErrors,
      screenshots: [beforeScreenshotPath, afterScreenshotPath],
      result: 'late A response completed; active B quota remained 2.0 GB',
      finished_at: new Date().toISOString(),
    }, null, 2)}\n`)
    await testInfo.attach('workspace-switch-receipt', { path: receiptPath, contentType: 'application/json' })
  } finally {
    releaseAQuota?.()
  }
})
