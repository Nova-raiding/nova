import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_merchant_navigation_fixture'
const envelope = (data, error = null) => ({ request_id: 'merchant-navigation-browser', trace_id: 'merchant-navigation-browser', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

async function startStudio() {
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
    throw new Error('Merchant navigation fixture did not bind an ephemeral TCP port')
  }
  return { vite, origin: `http://127.0.0.1:${address.port}` }
}

async function attachReadOnlyApi(page, origin) {
  const writes = []
  const outsideRequests = []
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== origin) {
      outsideRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    if (request.method() !== 'GET' && !(url.pathname === '/api/v1/auth/mcp-token' && request.method() === 'POST') && !(url.pathname === '/api/mcp' && request.method() === 'POST')) {
      writes.push(`${request.method()} ${url.pathname}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: 'Navigation fixture is read-only.' })) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (url.pathname === '/api/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    else if (url.pathname === '/api/v1/auth/session') data = { account: { id: 'merchant-navigation-reader', login: 'navigation@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId], enterpriseName: 'Navigation Fixture' } }
    else if (url.pathname === '/api/v1/auth/mcp-token') data = { access_token: 'local-navigation-fixture', refresh_token: 'local-navigation-fixture', expires_in: 300, workspace_id: workspaceId }
    else if (url.pathname === '/api/v1/catalog/categories') data = []
    else if (url.pathname === '/api/v1/brand-scopes') data = { settings: { schemaVersion: 1, stores: {}, series: {}, images: {} }, revision: 0, updated_at: null, series: [], assignments: [] }
    else if (url.pathname === '/api/mcp') {
      const method = request.postDataJSON()?.method
      if (/(?:\.create|\.update|\.delete|\.approve|\.suspend|\.grant|\.revoke|\.retry|\.pause|\.resume|\.submit|\.report|\.import|\.generate|\.extract|\.set|\.select|\.adjust|\.record)$/iu.test(String(method))) {
        writes.push(`POST /api/mcp ${String(method)}`)
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'FIXTURE_WRITE_BLOCKED', message: 'Navigation fixture is read-only.' })) })
      }
      data = { result: method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : method === 'platform.model.status'
          ? { state: 'ready', capabilities: { image_generation: false } }
          : {} }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })
  return { writes, outsideRequests }
}

test('desktop navigation keeps the knowledge group destinations and legacy publish route understandable', async () => {
  test.setTimeout(60_000)
  const { vite, origin } = await startStudio()
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const { writes, outsideRequests } = await attachReadOnlyApi(page, origin)
  try {
    await page.goto(`${origin}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: '运营概览' })).toBeVisible({ timeout: 30_000 })
    const navigation = page.getByRole('navigation', { name: '主导航' })
    await expect(navigation.getByText('知识库', { exact: true })).toBeVisible()
    await expect(navigation.getByRole('button', { name: '平台&店铺&商品' })).toBeVisible()
    await expect(navigation.getByRole('button', { name: '品牌资产' })).toBeVisible()
    await expect(navigation.getByRole('button', { name: '素材库' })).toBeVisible()
    await expect(navigation.getByRole('button', { name: '回收站' })).toBeVisible()

    await navigation.getByRole('button', { name: '平台&店铺&商品' }).click()
    await expect(page).toHaveURL(/\/merchant\/products\?section=products$/u)
    await expect(page.getByRole('heading', { name: '平台&店铺&商品' })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '规则与类目' }).click()
    await expect(page).toHaveURL(/\/merchant\/rules$/u)
    await expect(page.locator('.topbar h1')).toHaveText('规则与检查', { timeout: 5_000 })

    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '财务概况' }).click()
    await expect(page).toHaveURL(/\/merchant\/finance$/u)
    await expect(page.locator('.topbar h1')).toHaveText('财务概况', { timeout: 20_000 })

    await page.goto(`${origin}/merchant/members`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.topbar h1')).toHaveText('成员与权限', { timeout: 20_000 })
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '成员与权限' })).toHaveCount(0)

    await page.goto(`${origin}/merchant/tasks`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.topbar h1')).toHaveText('营销任务', { timeout: 20_000 })
    await expect(page.getByRole('navigation', { name: '主导航' }).locator('.nav-group-title')).toHaveClass(/active/u)

    await page.goto(`${origin}/merchant/publish`, { waitUntil: 'domcontentloaded' })
    await expect.soft(page).toHaveURL(/\/merchant\/products$/u, { timeout: 5_000 })
    await expect.soft(page.locator('.topbar h1')).toHaveText('素材库', { timeout: 5_000 })
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '素材库' })).toHaveClass(/active/u)
    expect(writes).toEqual([])
    expect(outsideRequests).toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await vite.close()
  }
})

test('mobile drawer traps keyboard focus and restores the menu trigger after Escape or backdrop close', async () => {
  test.setTimeout(60_000)
  const { vite, origin } = await startStudio()
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const { writes, outsideRequests } = await attachReadOnlyApi(page, origin)
  try {
    await page.goto(`${origin}/merchant/overview`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: '运营概览' })).toBeVisible({ timeout: 30_000 })
    const trigger = page.getByRole('button', { name: '打开主菜单' })
    await expect(trigger).toBeVisible()
    await trigger.click()
    const drawer = page.getByRole('dialog', { name: '商家工作区导航' })
    await expect(drawer).toBeVisible()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.app-content')).toHaveAttribute('inert', '')

    const focusable = drawer.locator('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')
    const first = focusable.first()
    const last = focusable.last()
    await expect(first).toBeFocused()
    await last.focus()
    await page.keyboard.press('Tab')
    await expect(first).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(last).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(trigger).toBeFocused()

    await trigger.click()
    await expect(drawer).toBeVisible()
    await page.getByRole('button', { name: '关闭主菜单' }).click({ position: { x: 370, y: 400 } })
    await expect(drawer).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(writes).toEqual([])
    expect(outsideRequests).toEqual([])
  } finally {
    await page.close()
    await browser.close()
    await vite.close()
  }
})
