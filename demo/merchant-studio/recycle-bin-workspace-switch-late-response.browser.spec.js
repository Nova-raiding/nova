import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceA = 'ws_recycle_switch_alpha'
const workspaceB = 'ws_recycle_switch_beta'
const envelope = (workspaceId, data) => ({ request_id: 'recycle-workspace-switch-fixture', trace_id: 'recycle-workspace-switch-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

const trashedAsset = (workspaceId, suffix) => ({
  asset: {
    id: `asset-trash-${suffix}`,
    workspaceId,
    name: `${suffix} 工作区专属回收素材.png`,
    mimeType: 'image/png',
    sizeBytes: 4096,
    sha256: suffix === 'A' ? 'a'.repeat(64) : 'b'.repeat(64),
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
})

test('recycle bin shows B assets after a late A trashed-assets response', async () => {
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
    throw new Error('Recycle bin workspace fixture did not bind an ephemeral TCP port')
  }

  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  const externalRequests = []
  const pageErrors = []
  const trashReads = []
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
      data = { account: { id: 'recycle-switch-reader', login: 'recycle-switch@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceA, workspaceB] } }
    } else if (path === '/v1/auth/mcp-token') {
      const targetWorkspace = request.postDataJSON()?.workspace_id ?? workspaceA
      data = { access_token: `token-${targetWorkspace}`, refresh_token: `refresh-${targetWorkspace}`, expires_in: 300, workspace_id: targetWorkspace }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/assets/trash' && request.method() === 'GET') {
      trashReads.push({ workspace, query: url.search })
      if (workspace === workspaceA && holdA) {
        await new Promise(resolve => pendingAReleases.push(resolve))
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspaceA, { items: [trashedAsset(workspaceA, 'A')], total: 1, limit: 50, offset: 0 })) })
      }
      const suffix = workspace === workspaceB ? 'B' : 'A'
      data = { items: [trashedAsset(workspace, suffix)], total: 1, limit: 50, offset: Number(url.searchParams.get('offset') ?? 0) }
    } else if (path === '/v1/platform-accounts') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === '/v1/assets' && url.searchParams.get('limit') === '1') data = { items: [], total: 0, limit: 1, offset: 0, storage_quota: { usedBytes: 0, reservedBytes: 0, limitBytes: 1_000_000, availableBytes: 1_000_000, status: 'available' } }
    else if (path === '/v1/brand-scopes') data = { settings: { schemaVersion: 1, global: { enabled: false, values: {} }, stores: {}, series: {}, images: {} }, revision: 0, updated_at: null, series: [], assignments: [] }
    else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      if (method === 'workspace.metrics') data = { result: { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} } }
      else if (method === 'platform.model.status') data = { result: { state: 'ready', capabilities: { image_generation: false } } }
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

  async function openRoute(pathname) {
    await page.evaluate(path => {
      window.history.pushState(null, '', path)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, pathname)
  }

  try {
    await page.goto(`${studioUrl}/merchant/products?section=trash`, { waitUntil: 'domcontentloaded' })
    await chooseWorkspace('选择当前商家工作区 ID', workspaceA)
    await openRoute('/merchant/products?section=trash')
    const recycleBin = page.getByTestId('material-recycle-bin')
    await expect.poll(() => trashReads.filter(read => read.workspace === workspaceA).length).toBeGreaterThan(0)

    await chooseWorkspace('按工作区 ID 切换当前商家工作区', workspaceB)
    await expect(page).toHaveURL(/\/merchant\/overview$/u)
    await openRoute('/merchant/products?section=trash')
    await expect(recycleBin.getByText('B 工作区专属回收素材.png')).toBeVisible({ timeout: 10_000 })
    await expect(recycleBin.getByText('A 工作区专属回收素材.png')).toHaveCount(0)
    expect(trashReads.some(read => read.workspace === workspaceA)).toBe(true)
    expect(trashReads.some(read => read.workspace === workspaceB)).toBe(true)

    holdA = false
    for (const release of pendingAReleases) release()
    await expect(recycleBin.getByText('B 工作区专属回收素材.png')).toBeVisible()
    await expect(recycleBin.getByText('A 工作区专属回收素材.png')).toHaveCount(0)
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
