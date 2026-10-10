import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceA = 'ws_catalog_switch_alpha'
const workspaceB = 'ws_catalog_switch_beta'
const accountA = 'store-catalog-alpha'
const accountB = 'store-catalog-beta'
const envelope = (workspaceId, data, error = null) => ({ request_id: 'catalog-workspace-switch-fixture', trace_id: 'catalog-workspace-switch-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })
const product = (id, workspaceId, accountId, title) => ({
  id, workspaceId, platform: 'taobao', accountId, storeName: `${workspaceId}测试店`, remoteId: `remote-${id}`, title,
  skuCount: 1, stock: 12, factsConfirmed: true, source: 'manual_import',
  createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', version: 1,
})

async function openRoute(page, pathname) {
  await page.evaluate((path) => {
    window.history.pushState(null, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, pathname)
}

async function chooseWorkspace(page, label, workspaceId) {
  const selector = page.getByRole('combobox', { name: label, exact: true })
  await expect(selector).toBeVisible()
  const selectRoot = selector.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")]')
  const selection = selector.locator('xpath=..')
  const current = label === '选择当前商家工作区 ID' ? '' : ((await selection.textContent().catch(() => ''))?.trim() ?? '')
  await selectRoot.locator('.ant-select-content').click({ force: true })
  await expect(selector).toHaveAttribute('aria-expanded', 'true')
  if (!current) await selector.press('Home')
  else if (!current.includes(workspaceId)) await selector.press(workspaceId === workspaceA ? 'ArrowUp' : 'ArrowDown')
  await selector.press('Enter')
  if (label === '选择当前商家工作区 ID') await expect(page.locator('.app-shell')).toBeVisible()
  else await expect(selection).toContainText(workspaceId)
}

test('catalog discards a delayed A response after switching to B and reads back only B products', async () => {
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
    throw new Error('Catalog workspace fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  const productReadScopes = []
  const pageErrors = []
  let releaseAlphaResponse
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== studioUrl) return route.abort('blockedbyclient')
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const request = route.request()
    const path = url.pathname.replace(/^\/api/u, '')
    const scope = request.headers()['x-workspace-id'] ?? null
    let data = { items: [], total: 0, limit: 50, offset: 0 }

    if (path === '/v1/auth/session') {
      data = { account: { id: 'catalog-switch-user', login: 'catalog-switch@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceA, workspaceB] } }
    } else if (path === '/v1/auth/mcp-token') {
      const targetWorkspace = request.postDataJSON()?.workspace_id ?? null
      data = { access_token: `fixture-token-${targetWorkspace}`, refresh_token: `fixture-refresh-${targetWorkspace}`, expires_in: 300, workspace_id: targetWorkspace }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/platform-accounts') {
      const id = scope === workspaceB ? accountB : accountA
      data = { items: [{ platform: 'taobao', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'fixture', accountId: id, storeName: scope === workspaceB ? 'B 工作区商品店' : 'A 工作区商品店', label: scope === workspaceB ? 'B 工作区商品店' : 'A 工作区商品店' }] }
    } else if (path === '/v1/products') {
      productReadScopes.push(scope)
      if (scope === workspaceA) {
        await new Promise(resolve => { releaseAlphaResponse = resolve })
        data = { items: [product('product-alpha-only', workspaceA, accountA, 'A 工作区专属目录商品')], total: 1, limit: 50, offset: 0 }
      } else if (scope === workspaceB) {
        data = { items: [product('product-beta-only', workspaceB, accountB, 'B 工作区专属目录商品')], total: 1, limit: 50, offset: 0 }
      }
    } else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      data = { result: method === 'workspace.metrics'
        ? { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} }
        : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(scope, data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/products?section=products`, { waitUntil: 'domcontentloaded' })
    await chooseWorkspace(page, '选择当前商家工作区 ID', workspaceA)
    await openRoute(page, '/merchant/products?section=products')
    await page.getByRole('button', { name: /^淘宝/u }).click()
    await page.locator('.catalog-store-card').filter({ hasText: 'A 工作区商品店' }).getByRole('button', { name: /进入商品库/u }).click()
    await expect.poll(() => productReadScopes.filter(scope => scope === workspaceA).length).toBeGreaterThan(0)
    expect(typeof releaseAlphaResponse).toBe('function')

    await chooseWorkspace(page, '按工作区 ID 切换当前商家工作区', workspaceB)
    await expect(page).toHaveURL(/\/merchant\/overview$/u)
    await openRoute(page, '/merchant/products?section=products')
    await page.getByRole('button', { name: /^淘宝/u }).click()
    await page.locator('.catalog-store-card').filter({ hasText: 'B 工作区商品店' }).getByRole('button', { name: /进入商品库/u }).click()
    const catalog = page.locator('.catalog-product-card')
    await expect(catalog).toContainText('B 工作区专属目录商品')
    await expect(catalog).not.toContainText('A 工作区专属目录商品')
    expect(productReadScopes).toContain(workspaceB)

    releaseAlphaResponse()
    await expect(catalog).toContainText('B 工作区专属目录商品')
    await expect(catalog).not.toContainText('A 工作区专属目录商品')
    expect(pageErrors).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
