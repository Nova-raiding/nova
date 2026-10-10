import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceA = 'ws_material_switch_alpha'
const workspaceB = 'ws_material_switch_beta'

test.setTimeout(60_000)
test.use({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' })

const envelope = (workspaceId, data) => ({
  request_id: 'material-workspace-switch-fixture',
  trace_id: 'material-workspace-switch-fixture',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
})

const asset = (workspaceId, id, name) => ({
  id,
  workspaceId,
  name,
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  sha256: 'a'.repeat(64),
  scanStatus: 'clean',
  parseStatus: 'succeeded',
  rightsStatus: 'pending',
  rightsScope: 'internal_only',
  materialCategory: '品牌资料',
  references: [],
  revision: 1,
  createdAt: '2026-10-10T02:00:00.000Z',
  updatedAt: '2026-10-10T02:00:00.000Z',
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

test('素材库切换到工作区 B 后，迟到的 A 资产列表不会污染页面', async ({ page }) => {
  let releaseAlphaResponse
  let alphaAssetReads = 0
  const assetReadScopes = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/u, '')
    const requestWorkspace = request.headers()['x-workspace-id'] ?? null
    let data = { items: [], total: 0, limit: 50, offset: 0 }

    if (path === '/v1/auth/session') {
      data = { account: { id: 'material-switch-user', login: 'material-switch@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceA, workspaceB] } }
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
    if (path === '/v1/assets') {
      assetReadScopes.push(requestWorkspace)
      if (requestWorkspace === workspaceA) {
        alphaAssetReads++
        if (alphaAssetReads === 1) {
          await new Promise(resolve => { releaseAlphaResponse = resolve })
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspaceA, { items: [asset(workspaceA, 'asset-alpha-private', 'A 私有品牌手册.pdf')], total: 1, limit: 50, offset: 0 })) })
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspaceA, { items: [asset(workspaceA, 'asset-alpha-private', 'A 私有品牌手册.pdf')], total: 1, limit: 50, offset: 0 })) })
      }
      if (requestWorkspace === workspaceB) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspaceB, { items: [asset(workspaceB, 'asset-beta-only', 'B 专属品牌手册.pdf')], total: 1, limit: 50, offset: 0 })) })
      }
    }
    if (path === '/v1/platform-accounts') data = { items: [], total: 0, limit: 50, offset: 0 }
    else if (path === '/v1/storage/quota') data = { usedBytes: 0, limitBytes: 1024 * 1024 }
    else if (path === '/v1/brand-scopes') data = { settings: {}, revision: 1, updated_at: null, series: [], assignments: [] }
    else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      if (method === 'platform.model.status') data = { result: { state: 'ready', capabilities: { image_generation: false } } }
      else if (method === 'workspace.metrics') data = { result: { source: 'fixture', stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskSummary: { total: 0, returned: 0, truncated: false }, riskItems: [], taskFunnel: {} } }
      else data = { result: {} }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(requestWorkspace, data)) })
  })

  await page.goto(`${studioUrl}/merchant/products?section=images`, { waitUntil: 'domcontentloaded' })
  await chooseWorkspace(page, '选择当前商家工作区 ID', workspaceA)
  await openRoute(page, '/merchant/products?section=images')
  await expect.poll(() => alphaAssetReads, { timeout: 10_000 }).toBeGreaterThan(0)

  await chooseWorkspace(page, '按工作区 ID 切换当前商家工作区', workspaceB)
  await expect(page).toHaveURL(/\/merchant\/overview$/u)
  await openRoute(page, '/merchant/products?section=images')
  const library = page.getByTestId('material-library-workspace')
  await expect(library.getByText('B 专属品牌手册.pdf')).toBeVisible({ timeout: 10_000 })
  await expect(library.getByText('A 私有品牌手册.pdf')).toHaveCount(0)
  expect(assetReadScopes[0]).toBe(workspaceA)
  expect(assetReadScopes).toContain(workspaceB)

  releaseAlphaResponse()
  await expect(library.getByText('B 专属品牌手册.pdf')).toBeVisible()
  await expect(library.getByText('A 私有品牌手册.pdf')).toHaveCount(0)
  expect(pageErrors).toEqual([])
})
