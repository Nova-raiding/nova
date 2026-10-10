import { expect, test, chromium } from '@playwright/test'

test.setTimeout(60_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_rules_page_fixture'
const ruleRows = [
  { id: 'rule-jd', name: '京东商品事实规则', version: 'jd-1.0', scope: '京东', category: 'platform', status: 'active', updatedAt: '2026-10-01', source: { kind: 'public', reference: '规则目录', checkedAt: '2026-10-01' } },
  { id: 'rule-taobao', name: '淘宝广告表达规则', version: 'tb-2.0', scope: '淘宝', category: 'advertising_publish', status: 'active', updatedAt: '2026-10-02', source: { kind: 'public', reference: '规则目录', checkedAt: '2026-10-02' } },
]
const categories = [
  { code: '1312', name: '防晒外套', fields: ['材质', '尺码'], platforms: ['jd', 'taobao'], status: 'active', updatedAt: '2026-10-01' },
]
const envelope = data => ({ request_id: 'rules-page-fixture', trace_id: 'rules-page-fixture', workspace_id: workspaceId, data, warnings: [], next_actions: [], error: null })

test('rules page supports direct load, filtering, detail close, empty and retry states', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  let failRules = false
  let rulesRequests = 0
  const observedRuleUrls = []

  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const pathname = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (pathname === '/v1/auth/session') {
      data = { account: { id: 'rules-user', login: 'rules@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceId] } }
    } else if (pathname === '/v1/auth/mcp-token') {
      data = { access_token: 'rules-fixture-token', refresh_token: 'rules-fixture-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (pathname === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { mode: 'demo', productionGate: false, platformOperations: { mode: 'manual', ready: true, automatedWritesEnabled: false } } }
    } else if (pathname === '/v1/rules') {
      rulesRequests += 1
      observedRuleUrls.push(url.toString())
      if (failRules) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null)) })
        return
      }
      const items = ruleRows.filter(row => !url.searchParams.has('platform') || (url.searchParams.get('platform') === 'jd' ? row.scope === '京东' : row.scope === '淘宝'))
      data = { items, total: items.length, limit: 50, offset: 0 }
    } else if (pathname === '/v1/catalog/categories') {
      data = categories
    } else if (pathname === '/mcp') {
      const method = route.request().postDataJSON()?.method
      data = method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {}
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    await page.goto(`${studioUrl}/merchant/rules?platform=taobao`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: '规则库与品类库' })).toBeVisible()
    await expect(page.locator('[data-environment-state="demo"]')).toContainText('演示环境 · 不可上线')
    await expect(page.getByText('淘宝广告表达规则')).toBeVisible()
    await expect(page.getByText('京东商品事实规则')).toHaveCount(0)
    await expect.poll(() => new URL(page.url()).searchParams.get('platform')).toBe('taobao')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText('淘宝广告表达规则')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/merchant/rules')

    await page.getByRole('combobox').nth(0).selectOption('jd')
    await expect(page.getByText('京东商品事实规则')).toBeVisible()
    await expect(page.getByText('淘宝广告表达规则')).toHaveCount(0)
    await expect.poll(() => new URL(page.url()).searchParams.get('platform')).toBe('jd')
    await page.goBack()
    await expect(page.getByText('淘宝广告表达规则')).toBeVisible()
    await expect(page.getByText('京东商品事实规则')).toHaveCount(0)
    await page.goForward()
    await expect(page.getByText('京东商品事实规则')).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get('platform')).toBe('jd')
    await page.getByRole('textbox', { name: '搜索规则或品类' }).fill('无匹配关键词')
    await expect(page.getByText('没有匹配规则')).toBeVisible()

    await page.getByRole('textbox', { name: '搜索规则或品类' }).fill('')
    await page.getByRole('tab', { name: /^品类库/u }).click()
    await expect(page.getByRole('heading', { name: '防晒外套' })).toBeVisible()
    await page.getByRole('button', { name: '查看类目字段模板' }).click()
    await expect(page.getByTestId('category-mapping-detail')).toContainText('材质')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.getByTestId('category-mapping-detail')).toHaveCount(0)

    failRules = true
    await page.getByRole('tab', { name: /^规则库/u }).click()
    await page.getByRole('combobox').nth(0).selectOption('taobao')
    await page.getByRole('button', { name: '重新读取' }).click()
    await expect(page.getByText(/规则库读取失败/u)).toBeVisible()
    const requestsAfterFailure = rulesRequests
    failRules = false
    await page.getByRole('button', { name: '重新读取' }).click()
    await expect(page.getByText('淘宝广告表达规则')).toBeVisible()
    expect(rulesRequests).toBeGreaterThan(requestsAfterFailure)
    expect(observedRuleUrls.some(value => new URL(value).searchParams.get('platform') === 'taobao')).toBe(true)
  } finally {
    await context.close()
    await browser.close()
  }
})
