import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_rules_category_filter'
const ruleRows = [
  { id: 'rule-platform', name: '平台事实规则', version: 'platform-1.0', scope: '京东', category: 'platform', status: 'active', updatedAt: '2026-10-01', source: { kind: 'public', reference: '本地目录', checkedAt: '2026-10-01' } },
  { id: 'rule-advertising', name: '广告发布规则', version: 'ads-2.0', scope: '京东', category: 'advertising_publish', status: 'active', updatedAt: '2026-10-02', source: { kind: 'public', reference: '本地目录', checkedAt: '2026-10-02' } },
]
const envelope = data => ({ request_id: 'rules-category-filter', trace_id: 'rules-category-filter', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('merchant rules category filter narrows and restores rule rows without refetching', async () => {
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
    throw new Error('Rules category fixture did not bind an ephemeral TCP port')
  }
  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const externalRequests = []
  const ruleReads = []
  const mutations = []

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const request = route.request()
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.fallback()
    const path = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { mode: 'demo', productionGate: false, platformOperations: { mode: 'manual', ready: true, automatedWritesEnabled: false } } }
    } else if (path === '/v1/auth/session') {
      data = { account: { id: 'rules-filter-user', login: 'rules-filter@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'local-rules-filter-token', refresh_token: 'local-rules-filter-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/v1/rules') {
      ruleReads.push(url.toString())
      data = { items: ruleRows, total: ruleRows.length, limit: 50, offset: 0 }
    } else if (path === '/v1/catalog/categories') {
      data = []
    } else if (path === '/mcp') {
      const body = request.postDataJSON() ?? {}
      if (/\.(create|update|delete|publish|activate|sync|submit)$/u.test(String(body.method))) mutations.push(body.method)
      const method = body.method
      data = { result: method === 'workspace.metrics'
        ? { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} }
        : method === 'platform.model.status' ? { state: 'ready', capabilities: {} } : {} }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/rules?platform=jd`, { waitUntil: 'domcontentloaded' })
    const panel = page.getByRole('tabpanel', { name: '规则库' })
    await expect(panel).toContainText('平台事实规则')
    await expect(panel).toContainText('广告发布规则')
    const initialRuleReadCount = ruleReads.length
    expect(initialRuleReadCount).toBeGreaterThan(0)
    const categoryFilter = page.getByLabel('规则分类')
    await categoryFilter.selectOption('advertising_publish')
    await expect(panel).toContainText('广告发布规则')
    await expect(panel).not.toContainText('平台事实规则')
    await expect(panel.getByText('1 个结果', { exact: true })).toBeVisible()

    await categoryFilter.selectOption('platform')
    await expect(panel).toContainText('平台事实规则')
    await expect(panel).not.toContainText('广告发布规则')
    await expect(panel.getByText('1 个结果', { exact: true })).toBeVisible()

    await categoryFilter.selectOption('all')
    await expect(panel).toContainText('平台事实规则')
    await expect(panel).toContainText('广告发布规则')

    await categoryFilter.selectOption('category')
    await expect(panel.getByText('没有匹配规则', { exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: '搜索规则或品类' }).fill('本地不存在的规则')
    await expect(panel.getByText('没有匹配规则', { exact: true })).toBeVisible()
    const resetFilters = page.getByRole('button', { name: '清除关键词和类目筛选' })
    await expect(resetFilters).toBeVisible()
    await resetFilters.click()
    await expect(categoryFilter).toHaveValue('all')
    await expect(page.getByRole('textbox', { name: '搜索规则或品类' })).toHaveValue('')
    await expect(page.getByRole('textbox', { name: '搜索规则或品类' })).toBeFocused()
    await expect(panel).toContainText('平台事实规则')
    await expect(panel).toContainText('广告发布规则')
    await expect(page).toHaveURL(`${studioUrl}/merchant/rules?platform=jd`)

    // Verify the real tab path separately from native popup selection.
    // Playwright supports selectOption for the OS-owned select popup; raw
    // Home/End did not change even a plain HTML select in macOS Chrome.
    const searchInput = page.getByRole('textbox', { name: '搜索规则或品类' })
    await expect(searchInput).toBeFocused()
    await searchInput.press('Shift+Tab')
    await expect(categoryFilter).toBeFocused()
    await categoryFilter.selectOption('advertising_publish')
    await expect(categoryFilter).toHaveValue('advertising_publish')
    await expect(panel).toContainText('广告发布规则')
    await expect(panel).not.toContainText('平台事实规则')
    await expect(categoryFilter).toBeFocused()
    await categoryFilter.selectOption('all')
    await expect(categoryFilter).toHaveValue('all')
    await expect(panel).toContainText('平台事实规则')
    await expect(panel).toContainText('广告发布规则')
    await expect(page).toHaveURL(`${studioUrl}/merchant/rules?platform=jd`)

    await categoryFilter.press('Tab')
    await expect(searchInput).toBeFocused()
    expect(ruleReads).toHaveLength(initialRuleReadCount)
    expect(mutations).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
