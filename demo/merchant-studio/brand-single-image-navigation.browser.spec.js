import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_brand_single_image_navigation_fixture'
const accountId = 'jd-brand-nav-store'
const storeName = '品牌单图配置导航店铺'
const envelope = data => ({ request_id: 'brand-single-image-nav', trace_id: 'brand-single-image-nav', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('brand single-image configuration link opens this store material library and preserves route context', async ({ page }) => {
  test.setTimeout(60_000)
  const origin = new URL(studioUrl).origin
  const externalRequests = []
  const writes = []
  const requests = []

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== origin) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    const method = request.method()
    let rpc = ''
    if (path === '/mcp' && method === 'POST') rpc = request.postDataJSON()?.method ?? ''
    requests.push({ method, path, rpc, workspace: request.headers()['x-workspace-id'] ?? '' })
    if (method !== 'GET' && !(path === '/v1/auth/mcp-token' && method === 'POST') && !(path === '/mcp' && method === 'POST')) {
      writes.push(`${method} ${path}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(envelope(null)) })
    }
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { objectStorage: { configured: true }, platformOperations: { mode: 'manual', ready: true } } }
    else if (path === '/v1/auth/session') data = { account: { id: 'brand-nav-reader', login: 'brand-nav@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    else if (path === '/v1/auth/mcp-token') data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    else if (path === '/v1/platform-accounts') data = { items: [{ platform: 'jd', accountId, storeName, label: storeName, state: 'connected', readEnabled: true, writeEnabled: false, dataMode: 'read_only' }] }
    else if (path === '/v1/brand-scopes') data = { settings: { schemaVersion: 1, global: { enabled: true, values: {} }, stores: { [accountId]: { enabled: true, values: { persona: '本地合成品牌画像' } } }, series: {}, images: {} }, revision: 3, updated_at: '2026-10-10T00:00:00.000Z', series: [], assignments: [] }
    else if (path === '/v1/assets') data = { items: [], total: 0, limit: 50, offset: 0, storage_quota: { usedBytes: 0, reservedBytes: 0, limitBytes: 1_073_741_824, availableBytes: 1_073_741_824, status: 'available' } }
    else if (path === '/mcp') {
      const result = rpc === 'workspace.metrics'
        ? { stores: [{ platform: 'jd', accountId, storeName, connection: { readable: true, state: 'connected', dataMode: 'read_only' } }], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : rpc === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {}
      data = { result }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  await page.goto(`${studioUrl}/merchant/products?section=assets&platform=jd&account_id=${accountId}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('region', { name: '品牌资产配置' })).toBeVisible({ timeout: 20_000 })
  const singleImageLink = page.getByRole('link', { name: /单图配置请前往素材库进行配置/u })
  await expect(singleImageLink).toBeVisible()
  await singleImageLink.click()

  await expect.poll(() => {
    const url = new URL(page.url())
    return { section: url.searchParams.get('section'), platform: url.searchParams.get('platform'), accountId: url.searchParams.get('account_id') }
  }).toEqual({ section: 'knowledge', platform: 'jd', accountId })
  await expect(page.getByTestId('material-library-workspace').getByRole('heading', { name: '素材库' })).toBeVisible()
  await expect(page.getByText(storeName, { exact: true }).first()).toBeVisible()
  expect(writes).toEqual([])
  expect(requests.some(item => item.workspace === workspaceId)).toBe(true)
  expect(externalRequests).toEqual([])
})
