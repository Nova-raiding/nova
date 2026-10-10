import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceId = 'ws_rules_keyboard_tabs'
const ruleRows = [
  { id: 'rule-platform', name: '平台事实规则', version: 'platform-1.0', scope: '京东', category: 'platform', status: 'active', updatedAt: '2026-10-01', source: { kind: 'public', reference: '本地目录', checkedAt: '2026-10-01' } },
  { id: 'rule-advertising', name: '广告发布规则', version: 'ads-2.0', scope: '京东', category: 'advertising_publish', status: 'active', updatedAt: '2026-10-02', source: { kind: 'public', reference: '本地目录', checkedAt: '2026-10-02' } },
]
const envelope = data => ({ request_id: 'rules-keyboard-tabs', trace_id: 'rules-keyboard-tabs', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('merchant rules tabs support arrow and Home/End keyboard navigation', async () => {
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
  const categoryReads = []
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
      data = { account: { id: 'rules-tabs-user', login: 'rules-tabs@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceId] } }
    } else if (path === '/v1/auth/mcp-token') {
      data = { access_token: 'local-rules-tabs-token', refresh_token: 'local-rules-tabs-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (path === '/v1/rules') {
      ruleReads.push(url.toString())
      data = { items: ruleRows, total: ruleRows.length, limit: 50, offset: 0 }
    } else if (path === '/v1/catalog/categories') {
      categoryReads.push(url.toString())
      data = [{ code: '1312', name: '防晒外套', fields: ['材质', '尺码'], platforms: ['jd'], status: 'active', updatedAt: '2026-10-01' }]
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
    await page.goto(`${studioUrl}/merchant/rules`, { waitUntil: 'domcontentloaded' })
    const rulesTab = page.getByRole('tab', { name: /规则库/u })
    const categoriesTab = page.getByRole('tab', { name: /品类库/u })
    await expect(rulesTab).toHaveAttribute('aria-selected', 'true')
    await rulesTab.focus()
    await expect(rulesTab).toBeFocused()
    await expect(page.getByRole('tabpanel', { name: '规则库' })).toContainText('平台事实规则')
    const initialRuleReadCount = ruleReads.length
    const initialCategoryReadCount = categoryReads.length
    expect(initialRuleReadCount).toBeGreaterThan(0)
    expect(initialCategoryReadCount).toBeGreaterThan(0)

    await rulesTab.press('ArrowRight')
    await expect(categoriesTab).toHaveAttribute('aria-selected', 'true')
    await expect(categoriesTab).toBeFocused()
    await expect(page.getByRole('tabpanel', { name: '品类库' })).toContainText('防晒外套')

    await categoriesTab.press('ArrowRight')
    await expect(rulesTab).toHaveAttribute('aria-selected', 'true')
    await expect(rulesTab).toBeFocused()
    await expect(page.getByRole('tabpanel', { name: '规则库' })).toContainText('广告发布规则')

    await rulesTab.press('End')
    await expect(categoriesTab).toHaveAttribute('aria-selected', 'true')
    await expect(categoriesTab).toBeFocused()
    await categoriesTab.press('Home')
    await expect(rulesTab).toHaveAttribute('aria-selected', 'true')
    await expect(rulesTab).toBeFocused()
    expect(ruleReads).toHaveLength(initialRuleReadCount)
    expect(categoryReads).toHaveLength(initialCategoryReadCount)
    expect(mutations).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
