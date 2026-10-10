import { expect, test, chromium } from '@playwright/test'

test.setTimeout(60_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceId = 'ws_delivery_readiness_recovery_fixture'
const envelope = (data, error = null) => ({
  request_id: 'delivery-readiness-recovery-fixture',
  trace_id: 'delivery-readiness-recovery-fixture',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error,
})

test('delivery evidence retry preserves deep link and restores keyboard focus after recovery', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const pageErrors = []
  const consoleErrors = []
  const unmockedApiRequests = []
  let readinessRequests = 0

  page.on('pageerror', error => pageErrors.push(error.stack || error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const pathname = url.pathname.replace(/^\/api/u, '')
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (pathname === '/v1/auth/session') {
      data = { account: { id: 'delivery-readiness-user', login: 'delivery@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceId] } }
    } else if (pathname === '/v1/auth/mcp-token') {
      data = { access_token: 'delivery-readiness-token', refresh_token: 'delivery-readiness-refresh', expires_in: 300, workspace_id: workspaceId }
    } else if (pathname === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (pathname === '/v1/rules') {
      data = { items: [{ id: 'rule-jd', name: '京东商品事实规则', version: 'jd-1', scope: '京东', category: 'platform', status: 'active', updatedAt: '2026-10-10' }], total: 1, limit: 50, offset: 0 }
    } else if (pathname === '/v1/products/product-42') {
      data = { id: 'product-42', workspaceId, platform: 'jd', accountId: 'store-42', storeName: '交付准备验收店', title: '验收商品', skuCount: 1, stock: 10, factsConfirmed: true, source: 'manual_import', version: 1 }
    } else if (pathname === '/v1/catalog/categories') {
      data = [{ code: '1312', name: '防晒外套', fields: ['材质'], platforms: ['jd'], status: 'active', updatedAt: '2026-10-10' }]
    } else if (pathname === '/v1/delivery-readiness') {
      readinessRequests += 1
      if (readinessRequests === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(envelope(null, { code: 'TEMPORARY_UNAVAILABLE', message: '交付证据暂时不可用' })) })
        return
      }
      await new Promise(resolve => setTimeout(resolve, 400))
      data = {
        mappingPreflights: [{ id: 'mapping-jd', platform: 'jd', status: 'blocked', findings: [{ code: 'MISSING_FIELD', field: 'title', message: '商品标题缺失', nextAction: '补充商品标题' }] }],
        bundles: [],
        authenticity: [],
      }
    } else if (pathname === '/mcp') {
      const method = route.request().postDataJSON()?.method
      data = { result: method === 'platform.model.status' ? { state: 'ready', capabilities: { image_generation: false } } : {} }
    } else {
      unmockedApiRequests.push(`${route.request().method()} ${pathname}`)
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(data)) })
  })

  try {
    const startUrl = `${studioUrl}/merchant/rules?platform=jd&product_id=product-42&account_id=store-42&rules_platform=jd`
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' })
    const readiness = page.locator('.delivery-readiness')
    await expect(readiness).toBeVisible()
    await expect(page.getByRole('alert')).toContainText('交付证据读取失败')
    const errorDescription = readiness.locator('#delivery-readiness-error-description')
    await expect(errorDescription).toContainText('缺失项不会显示为通过')
    await expect(errorDescription).not.toContainText('。。')
    await expect(readiness).toHaveAttribute('aria-busy', 'false')
    await page.screenshot({ path: '/tmp/merchant-delivery-readiness-error.png', fullPage: true })

    const retry = readiness.getByRole('button', { name: '重试' })
    await retry.focus()
    await page.keyboard.press('Enter')
    await expect(readiness).toHaveAttribute('aria-busy', 'true')
    await expect(readiness.getByRole('button', { name: '重试' })).toHaveCount(0)
    await expect(readiness.getByText('京东 · 商品未绑定')).toBeVisible()
    await expect(readiness).toHaveAttribute('aria-busy', 'false')
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('delivery-readiness'))).toBe(true)
    await page.screenshot({ path: '/tmp/merchant-delivery-readiness-recovered.png', fullPage: true })

    expect(readinessRequests).toBe(2)
    const currentUrl = new URL(page.url())
    expect(Object.fromEntries(currentUrl.searchParams)).toEqual({ platform: 'jd', product_id: 'product-42', account_id: 'store-42', rules_platform: 'jd' })
    expect(await readiness.getByRole('status').first().innerText()).toContain('已读取')
    expect(unmockedApiRequests).toEqual([])
    expect(pageErrors).toEqual([])
    expect(consoleErrors).toHaveLength(1)
    expect(consoleErrors[0]).toMatch(/503 \(Service Unavailable\)/u)
  } finally {
    await context.close()
    await browser.close()
  }
})
