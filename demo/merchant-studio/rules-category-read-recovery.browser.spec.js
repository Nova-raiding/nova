import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_rules_category_recovery_fixture'
const category = { code: 'fixture-4821', name: '本地恢复类目', fields: ['材质', '保养方式', '适用场景'], platforms: ['jd'], status: 'active', updatedAt: '2026-10-11' }
const envelope = (data, error = null) => ({ request_id: 'rules-category-recovery-fixture', trace_id: 'rules-category-recovery-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error })

test('category library keeps API failure separate from demo data and recovers on explicit retry', async () => {
  test.setTimeout(90_000)
  const vite = await createServer({
    configFile: false, envDir: false, root: studioRoot, plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'), 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Rules category recovery fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const categoryResponses = []
  let allowCategoryRead = false

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== studioUrl) return route.abort('blockedbyclient')
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/v1/auth/session') {
      data = { account: { id: 'rules-category-user', login: 'rules-category@example.invalid', accountType: 'merchant', status: 'active', roles: ['merchant_owner'], workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'local-fixture', refresh_token: 'local-fixture', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/v1/rules') {
      data = { items: [], total: 0, limit: 50, offset: 0 }
    } else if (path === '/v1/catalog/categories') {
      if (!allowCategoryRead) {
        categoryResponses.push('503')
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '品类库暂时无法读取' })) })
      }
      categoryResponses.push('200')
      data = [category]
    } else if (path === '/mcp') {
      const method = request.postDataJSON()?.method
      data = { result: method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/rules`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('tab', { name: /^品类库/u }).click()
    const categoryPanel = page.getByRole('tabpanel', { name: '品类库' })
    await expect(categoryPanel.getByText(/品类库读取失败/u)).toBeVisible()
    await expect(categoryPanel.getByText('防晒外套')).toHaveCount(0)
    await expect(categoryPanel.getByText(category.name)).toHaveCount(0)
    const retry = categoryPanel.getByRole('button', { name: '重新读取' })
    await expect(retry).toBeEnabled()

    allowCategoryRead = true
    await retry.click()
    await expect(categoryPanel.getByRole('heading', { name: category.name })).toBeVisible()
    await expect(categoryPanel.getByText(category.fields.join('、'))).toBeVisible()
    await expect(categoryPanel.getByText(/品类库读取失败/u)).toHaveCount(0)
    expect(categoryResponses).toContain('503')
    expect(categoryResponses.filter((status) => status === '200')).toHaveLength(1)

    await categoryPanel.getByRole('button', { name: '查看类目字段模板' }).click()
    const detail = page.getByTestId('category-mapping-detail')
    await expect(detail).toContainText(category.code)
    await expect(detail).toContainText('适用场景')
    expect(new URL(page.url()).pathname).toBe('/merchant/rules')
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
