import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceA = 'ws_plugin_capability_alpha'
const workspaceB = 'ws_plugin_capability_beta'
const envelope = (workspaceId, data) => ({ request_id: 'plugin-capability-workspace-fixture', trace_id: 'plugin-capability-workspace-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('local plugin capability from workspace A cannot enable connection in workspace B', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Local plugin capability fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()
  const externalRequests = []
  const pageErrors = []
  const capabilityReads = []
  const pendingAReleases = []
  let holdA = true
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
    const workspace = request.headers()['x-workspace-id'] ?? null
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') {
      data = { account: { id: 'plugin-capability-reader', login: 'plugin-reader@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceA, workspaceB] } }
    } else if (path === '/v1/auth/mcp-token') {
      const targetWorkspace = request.postDataJSON()?.workspace_id ?? workspaceA
      data = { access_token: `token-${targetWorkspace}`, refresh_token: `refresh-${targetWorkspace}`, expires_in: 300, workspace_id: targetWorkspace }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/auth/local-plugin/connect-capability') {
      capabilityReads.push(workspace)
      if (workspace === workspaceA && holdA) {
        await new Promise(resolve => pendingAReleases.push(resolve))
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspaceA, { one_click_available: true, supported_platforms: ['macos'] })) })
      }
      data = { one_click_available: false, supported_platforms: ['macos'] }
    } else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      if (method === 'platform.model.status') data = { result: { state: 'ready', capabilities: { image_generation: false } } }
      else if (method === 'workspace.metrics') data = { result: { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} } }
      else data = { result: {} }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspace, data)) })
  })

  async function chooseWorkspace(label, workspaceId) {
    const selector = page.getByRole('combobox', { name: label, exact: true })
    await expect(selector).toBeVisible()
    const selectRoot = selector.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")]')
    const selection = selector.locator('xpath=..')
    await selectRoot.locator('.ant-select-content').click({ force: true })
    await expect(selector).toHaveAttribute('aria-expanded', 'true')
    await page.getByText(`工作区 ID · ${workspaceId}`, { exact: true }).last().click()
    if (label === '选择当前商家工作区 ID') await expect(page.locator('.app-shell')).toBeVisible()
    else await expect(selection).toContainText(workspaceId)
  }

  try {
    await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    await chooseWorkspace('选择当前商家工作区 ID', workspaceA)
    await page.getByRole('button', { name: '打开账号菜单', exact: true }).click()
    await expect(page.getByRole('button', { name: '连接 ChatGPT 本地插件', exact: true })).toBeVisible()
    await expect.poll(() => capabilityReads.filter(workspace => workspace === workspaceA).length).toBe(1)

    await page.keyboard.press('Escape')
    await chooseWorkspace('按工作区 ID 切换当前商家工作区', workspaceB)
    await expect(page).toHaveURL(/\/merchant\/overview$/u)
    await page.getByRole('button', { name: '打开账号菜单', exact: true }).click()
    const connectButton = page.getByRole('button', { name: '连接 ChatGPT 本地插件', exact: true })
    await expect(connectButton).toBeVisible()
    await expect(page.getByText('本地插件一键连接尚未开放，请联系平台管理员核对配置。', { exact: true })).toBeVisible()
    await expect.poll(() => capabilityReads.filter(workspace => workspace === workspaceB).length).toBeGreaterThan(0)
    await expect(connectButton).toBeDisabled()

    holdA = false
    for (const release of pendingAReleases) release()
    await expect(page.getByText('本地插件一键连接尚未开放，请联系平台管理员核对配置。', { exact: true })).toBeVisible()
    await expect(connectButton).toBeDisabled()
    expect(capabilityReads).toContain(workspaceA)
    expect(capabilityReads).toContain(workspaceB)
    expect(pageErrors).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    holdA = false
    for (const release of pendingAReleases) release()
    await context.close()
    await browser.close()
    await vite.close()
  }
})
