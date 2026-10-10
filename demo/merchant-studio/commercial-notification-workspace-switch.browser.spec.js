import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceA = 'ws_commercial_notice_alpha'
const workspaceB = 'ws_commercial_notice_beta'
const envelope = (workspace, data) => ({ request_id: 'commercial-notice-workspace-fixture', trace_id: 'commercial-notice-workspace-fixture', workspace_id: workspace, data, warnings: [], next_actions: [], error: null })

test('commercial notifications discard late A list/read results and keep read intents workspace-bound', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Commercial notification workspace fixture did not bind an ephemeral TCP port')
  }

  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const pageErrors = []
  const listReads = []
  const readWrites = []
  let delayLateAList = false
  let releaseLateAList
  const lateAList = new Promise(resolve => { releaseLateAList = resolve })
  let releaseARead
  const delayedARead = new Promise(resolve => { releaseARead = resolve })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).origin !== studioUrl) externalRequests.push(request.url())
  })

  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()

    const path = url.pathname.replace(/^\/api/u, '')
    const requestWorkspace = request.headers()['x-workspace-id'] ?? null
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') {
      data = { account: { id: 'commercial-notice-workspace-user', login: 'notice-workspace@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceA, workspaceB] } }
    } else if (path === '/v1/auth/mcp-token') {
      const targetWorkspace = request.postDataJSON()?.workspace_id ?? workspaceA
      data = { access_token: `token-${targetWorkspace}`, refresh_token: `refresh-${targetWorkspace}`, expires_in: 300, workspace_id: targetWorkspace }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/mcp') {
      const body = request.postDataJSON()
      if (body?.method === 'commercial.notifications.list') {
        listReads.push({ workspace: requestWorkspace, cursor: body.params?.cursor ?? null })
        if (requestWorkspace === workspaceA && delayLateAList) {
          await lateAList
        }
        const suffix = requestWorkspace === workspaceB ? 'B' : 'A'
        data = { result: { items: [{ id: `notice-${suffix}`, event_id: `event-${suffix}`, sku_code: `plan-${suffix}`, version: 1, title: `Workspace ${suffix} purchase message`, body: `Synthetic notification for ${requestWorkspace}`, published_at: '2026-10-10T02:00:00.000Z', notification_kind: 'purchase_result', order_id: `order-${suffix}`, result_state: 'active', read_at: null }], next_cursor: null } }
      } else if (body?.method === 'workspace.metrics') {
        data = { result: { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} } }
      } else if (body?.method === 'platform.model.status') data = { result: { state: 'ready', capabilities: {} } }
      else data = { result: {} }
    } else if (/^\/v1\/commercial\/notifications\/notice-[AB]\/read$/u.test(path) && request.method() === 'POST') {
      const notificationId = path.match(/notifications\/(notice-[AB])\/read/u)?.[1]
      const write = { workspace: requestWorkspace, notificationId, idempotencyKey: request.postDataJSON()?.idempotency_key }
      readWrites.push(write)
      if (notificationId === 'notice-A') await delayedARead
      data = { notification_id: notificationId, read_at: '2026-10-11T03:00:00.000Z', replayed: false }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(requestWorkspace, data)) })
  })

  async function chooseWorkspace(label, target) {
    const selector = page.getByRole('combobox', { name: label, exact: true })
    await expect(selector).toBeVisible()
    const selection = selector.locator('xpath=..')
    const selectRoot = selector.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")]')
    const current = label === '选择当前商家工作区 ID' ? '' : ((await selection.textContent().catch(() => ''))?.trim() ?? '')
    await selectRoot.locator('.ant-select-content').click({ force: true, timeout: 5_000 })
    await expect(selector).toHaveAttribute('aria-expanded', 'true')
    if (!current) await selector.press('Home')
    else if (!current.includes(target)) await selector.press(target === workspaceA ? 'ArrowUp' : 'ArrowDown')
    await selector.press('Enter')
    if (label === '选择当前商家工作区 ID') {
      await expect(page.locator('.app-shell')).toBeVisible()
      await expect(page.getByRole('combobox', { name: '按工作区 ID 切换当前商家工作区', exact: true }).locator('xpath=..')).toContainText(target)
    } else await expect(selection).toContainText(target)
  }

  try {
    await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    await chooseWorkspace('选择当前商家工作区 ID', workspaceA)
    const bell = page.getByRole('button', { name: /工作区待处理问题/u })
    await expect(bell).toBeVisible()
    await bell.click()
    const notificationPanel = page.getByRole('region', { name: '套餐与权益包通知' })
    const aItem = notificationPanel.locator('li').filter({ hasText: 'Workspace A purchase message' })
    await expect(aItem).toBeVisible()

    await aItem.getByRole('button', { name: '标记已读' }).click()
    await expect.poll(() => readWrites.filter(write => write.notificationId === 'notice-A').length).toBe(1)
    delayLateAList = true
    const aReadsBeforeRefresh = listReads.filter(read => read.workspace === workspaceA).length
    await notificationPanel.getByRole('button', { name: /刷\s*新/u }).click()
    await expect.poll(() => listReads.filter(read => read.workspace === workspaceA).length).toBeGreaterThan(aReadsBeforeRefresh)

    await chooseWorkspace('按工作区 ID 切换当前商家工作区', workspaceB)
    if (!(await notificationPanel.isVisible().catch(() => false))) await bell.click()
    const bItem = notificationPanel.locator('li').filter({ hasText: 'Workspace B purchase message' })
    await expect(bItem).toBeVisible()
    await expect(notificationPanel).not.toContainText('Workspace A purchase message')

    await bItem.getByRole('button', { name: '标记已读' }).click()
    await expect.poll(() => readWrites.filter(write => write.notificationId === 'notice-B').length).toBe(1)
    releaseARead()
    releaseLateAList()

    await expect(bItem.getByRole('button', { name: '标记已读' })).toHaveCount(0)
    await expect(notificationPanel).toContainText('Workspace B purchase message')
    await expect(notificationPanel).not.toContainText('Workspace A purchase message')
    expect(listReads.some(read => read.workspace === workspaceA)).toBe(true)
    expect(listReads.some(read => read.workspace === workspaceB)).toBe(true)
    const aWrite = readWrites.find(write => write.notificationId === 'notice-A')
    const bWrite = readWrites.find(write => write.notificationId === 'notice-B')
    expect(aWrite?.workspace).toBe(workspaceA)
    expect(bWrite?.workspace).toBe(workspaceB)
    expect(aWrite?.idempotencyKey).toBeTruthy()
    expect(bWrite?.idempotencyKey).toBeTruthy()
    expect(bWrite?.idempotencyKey).not.toBe(aWrite?.idempotencyKey)
    expect(readWrites).toHaveLength(2)
    expect(externalRequests).toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    releaseARead?.()
    releaseLateAList?.()
    await context.close()
    await browser.close()
    await vite.close()
  }
})
