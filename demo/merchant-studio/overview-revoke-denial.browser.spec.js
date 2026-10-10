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
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'),
      'import.meta.env.VITE_WORKSPACE_ID': JSON.stringify(workspaceId),
      'import.meta.env.MODE': JSON.stringify('test'),
    },
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
  page.setDefaultTimeout(8_000)
  page.setDefaultNavigationTimeout(10_000)
  const expectUi = expect.configure({ timeout: 8_000 })
  const externalRequests = []
  const apiRequests = []
  const accountReads = []
  const syncRequests = []
  const syncResponses = []
  const revokeRequests = []
  const pageErrors = []
  const failedRequests = []
  const consoleErrors = []
  const browserRequests = []
  let stage = 'install-api-fixture'

  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('request', (request) => browserRequests.push({ method: request.method(), url: request.url() }))

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    apiRequests.push({ method: request.method(), path })
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'official_api', ready: true } } }
    } else if (path === '/v1/auth/session') {
      data = { account: { id: 'overview-revoke-user', login: 'overview@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/v1/platform-accounts/jd/sync' && request.method() === 'POST') {
      syncRequests.push({ method: request.method(), accountId: request.headers()['x-account-id'] })
      if (syncRequests.length === 1) {
        syncResponses.push({ status: 503, code: 'SYNC_TEMPORARILY_UNAVAILABLE' })
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'SYNC_TEMPORARILY_UNAVAILABLE', message: '本地夹具同步暂不可用。' })) })
      }
      syncResponses.push({ status: 200 })
      data = { platform: 'jd', source: 'fixture', simulated: true, items: [] }
    } else if (path === '/v1/platform-accounts' || /^\/v1\/platform-accounts\/(?:jd|taobao|tmall|pdd|xiaohongshu|douyin)$/u.test(path)) {
      if (request.method() === 'DELETE' && path !== '/v1/platform-accounts') {
        revokeRequests.push({ method: request.method(), path, accountId: request.headers()['x-account-id'] })
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'PLATFORM_REVOKE_DENIED', message: '本地夹具拒绝撤销，连接状态保持不变。' })) })
      }
      if (request.method() === 'GET' && path === '/v1/platform-accounts') accountReads.push(path)
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
    stage = 'navigate-to-merchant-overview'
    await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'commit' })
    const platformRow = page.locator('.platform-list .platform-row').filter({ hasText: '本地授权店铺' })
    stage = 'wait-for-platform-account-read'
    await expect.poll(() => accountReads, {
      timeout: 30_000,
      message: `expected fixture GET /v1/platform-accounts; received ${JSON.stringify(apiRequests)}`,
    }).toContain('/v1/platform-accounts')
    stage = 'wait-for-readable-platform-row'
    await expectUi(platformRow).toContainText('可读取')
    stage = 'verify-sync-failure-retry-is-scoped'
    await platformRow.getByRole('button', { name: '同步' }).click()
    // `describeApiError` deliberately maps all HTTP 503 responses to stable,
    // safe user-facing recovery copy instead of echoing provider details.
    const syncFailure = page.getByRole('alert').filter({ hasText: '服务暂不可用。当前操作未确认完成' }).first()
    await expectUi(syncFailure).toBeVisible()
    expect(await syncFailure.innerText()).not.toContain('本地夹具同步暂不可用')
    expect(syncResponses).toEqual([{ status: 503, code: 'SYNC_TEMPORARILY_UNAVAILABLE' }])
    await page.getByRole('button', { name: '重试当前操作' }).click()
    await expect.poll(() => syncRequests.length).toBe(2)
    await expectUi(page.getByRole('alert').filter({ hasText: '服务暂不可用。当前操作未确认完成' })).toHaveCount(0)
    expect(syncRequests).toEqual([
      { method: 'POST', accountId },
      { method: 'POST', accountId },
    ])
    expect(syncResponses).toEqual([
      { status: 503, code: 'SYNC_TEMPORARILY_UNAVAILABLE' },
      { status: 200 },
    ])
    stage = 'open-revoke-confirmation'
    const revokeButton = platformRow.locator('button.text-button.danger')
    expect(await revokeButton.count(), `revoke action missing; row=${await platformRow.innerHTML()}`).toBe(1)
    const rowBox = await platformRow.boundingBox()
    const buttonBox = await revokeButton.boundingBox()
    expect(await revokeButton.isVisible(), `revoke action is not visible; row=${JSON.stringify(rowBox)} button=${JSON.stringify(buttonBox)} rowHTML=${await platformRow.innerHTML()}`).toBe(true)
    expect(buttonBox && rowBox && buttonBox.x >= rowBox.x && buttonBox.x + buttonBox.width <= rowBox.x + rowBox.width,
      `revoke action is clipped outside its platform row; row=${JSON.stringify(rowBox)} button=${JSON.stringify(buttonBox)}`).toBe(true)
    await revokeButton.click()

    const dialog = page.getByTestId('revoke-platform-dialog')
    stage = 'verify-confirmation-and-cancel'
    await expectUi(dialog).toContainText('将立即停止“本地授权店铺”的同步和发布')
    await dialog.getByRole('button', { name: '取消' }).click()
    await expectUi(dialog).toHaveCount(0)
    expect(revokeRequests).toEqual([])
    await expectUi(platformRow).toContainText('可读取')

    stage = 'confirm-revoke-and-observe-denial'
    await platformRow.locator('button.text-button.danger').click()
    await page.getByTestId('revoke-platform-dialog').getByRole('button', { name: '确认撤销连接' }).click()
    await expectUi(dialog.getByRole('alert')).toContainText('本地夹具拒绝撤销')
    expect(await page.getByRole('button', { name: '重试当前操作' }).count()).toBe(0)
    await expectUi(platformRow).toContainText('可读取')
    await expectUi(dialog).toBeVisible()
    expect(revokeRequests).toEqual([{ method: 'DELETE', path: '/v1/platform-accounts/jd', accountId }])
    expect(externalRequests).toEqual([])

    stage = 'reload-and-confirm-server-read-state'
    await page.reload({ waitUntil: 'commit' })
    await expect.poll(() => accountReads.length, {
      timeout: 30_000,
      message: `expected a fresh platform-account read after denial; received ${JSON.stringify(apiRequests)}`,
    }).toBeGreaterThan(1)
    await expectUi(platformRow).toContainText('可读取')
    expect(revokeRequests).toHaveLength(1)
    expect(externalRequests).toEqual([])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\nFixture checkpoint: ${JSON.stringify({ stage, url: page.url(), title: await page.title(), bodyText: (await page.locator('body').innerText()).slice(0, 1_000), browserRequests: browserRequests.slice(-30), pageErrors, consoleErrors, failedRequests, apiRequests, accountReads, syncRequests, syncResponses, revokeRequests, externalRequests })}`, { cause: error })
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
