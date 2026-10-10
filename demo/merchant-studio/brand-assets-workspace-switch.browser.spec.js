import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceA = 'ws_brand_switch_alpha'
const workspaceB = 'ws_brand_switch_beta'
const storeA = 'store-brand-alpha'
const storeB = 'store-brand-beta'

test.setTimeout(60_000)
test.use({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })

const envelope = (workspaceId, data) => ({
  request_id: 'brand-assets-workspace-switch-fixture',
  trace_id: 'brand-assets-workspace-switch-fixture',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
})

const brandSettings = (persona, storeId) => ({
  settings: {
    schemaVersion: 1,
    global: { enabled: true, values: {} },
    stores: { [storeId]: { enabled: true, values: { persona } } },
    series: {},
    images: {},
  },
  revision: 1,
  updated_at: null,
  series: [],
  assignments: [],
})

async function openRoute(page, pathname) {
  await page.evaluate(path => {
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

test('品牌资产切换到工作区 B 后，迟到的 A 品牌配置不会覆盖 B 表单', async ({ page }) => {
  let releaseAlphaRead
  let alphaBrandReads = 0
  const brandReadScopes = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/u, '')
    const requestWorkspace = request.headers()['x-workspace-id'] ?? null
    let data = { items: [], total: 0, limit: 50, offset: 0 }

    if (path === '/v1/auth/session') {
      data = { account: { id: 'brand-switch-user', login: 'brand-switch@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceA, workspaceB] } }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(null, data)) })
    }
    if (path === '/v1/auth/mcp-token') {
      const workspaceId = request.postDataJSON()?.workspace_id ?? null
      data = { access_token: `token-${workspaceId}`, refresh_token: `refresh-${workspaceId}`, expires_in: 300, workspace_id: workspaceId }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(null, data)) })
    }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(null, data)) })
    }
    if (path === '/v1/platform-accounts') {
      const storeId = requestWorkspace === workspaceA ? storeA : storeB
      const storeName = requestWorkspace === workspaceA ? 'A 品牌店铺' : 'B 品牌店铺'
      data = { items: [{ platform: 'jd', state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'read_only', accountId: storeId, storeName }] }
    } else if (path === '/v1/brand-scopes') {
      brandReadScopes.push(requestWorkspace)
      if (requestWorkspace === workspaceA) {
        alphaBrandReads++
        if (alphaBrandReads === 1) {
          await new Promise(resolve => { releaseAlphaRead = resolve })
          data = brandSettings('A 工作区专属画像', storeA)
        } else data = brandSettings('A 工作区专属画像', storeA)
      } else data = brandSettings('B 工作区专属画像', storeB)
    } else if (path === '/v1/assets') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (path === '/v1/storage/quota') {
      data = { usedBytes: 0, limitBytes: 1024 * 1024 }
    } else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      if (method === 'platform.model.status') data = { result: { state: 'ready', capabilities: { image_generation: false } } }
      else if (method === 'workspace.metrics') data = { result: { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} } }
      else data = { result: {} }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(requestWorkspace, data)) })
  })

  await page.goto(`${studioUrl}/merchant/products?section=assets`, { waitUntil: 'domcontentloaded' })
  await chooseWorkspace(page, '选择当前商家工作区 ID', workspaceA)
  await openRoute(page, '/merchant/products?section=assets')
  await expect.poll(() => alphaBrandReads, { timeout: 10_000 }).toBeGreaterThan(0)

  await chooseWorkspace(page, '按工作区 ID 切换当前商家工作区', workspaceB)
  await expect(page).toHaveURL(/\/merchant\/overview$/u)
  await openRoute(page, '/merchant/products?section=assets')
  const panel = page.getByRole('region', { name: '品牌资产配置' })
  await expect(panel.getByRole('textbox', { name: 'B 品牌店铺用户画像' })).toHaveValue('B 工作区专属画像', { timeout: 10_000 })
  await expect(panel.getByRole('textbox', { name: 'A 品牌店铺用户画像' })).toHaveCount(0)
  expect(brandReadScopes[0]).toBe(workspaceA)
  expect(brandReadScopes).toContain(workspaceB)

  releaseAlphaRead()
  await expect(panel.getByRole('textbox', { name: 'B 品牌店铺用户画像' })).toHaveValue('B 工作区专属画像')
  await expect(panel.getByRole('textbox', { name: 'A 品牌店铺用户画像' })).toHaveCount(0)
  await expect(panel.getByText('A 工作区专属画像')).toHaveCount(0)
  expect(pageErrors).toEqual([])
})
