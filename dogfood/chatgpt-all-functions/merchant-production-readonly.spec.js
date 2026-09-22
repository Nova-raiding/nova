import { expect, test, chromium } from '@playwright/test'
import { ensureMerchantSession } from './merchant-auth.js'

test.setTimeout(90_000)

const studioUrl = process.env.MERCHANT_STUDIO_URL

test('production merchant workflow is available and remains fail-closed for external writes', async () => {
  expect(studioUrl, 'production smoke requires an explicit MERCHANT_STUDIO_URL').toBeTruthy()
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto(studioUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2_000)
  await ensureMerchantSession(page)

  await expect(page.getByRole('heading', { name: '运营概览' })).toBeVisible()
  for (const heading of ['今日看板', '账号看板', '事务看板']) {
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
  }
  await expect(page.getByText('平台运营模式未确认，已停止自动发现店铺和读取同步任务；不会用默认模式绕过服务端权限。')).toBeVisible()

  await page.goto(new URL('merchant/tasks/new', studioUrl).toString(), { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1_500)
  await expect(page.getByLabel('搜索商品')).toBeVisible()
  const catalogState = page.getByTestId('products-unavailable')
      .or(page.getByText('商品列表尚未读取', { exact: true }))
      .or(page.getByText('正在读取商品列表…', { exact: true }))
      .or(page.getByText('没有匹配商品', { exact: true }))
      .or(page.locator('tbody tr').first())
  await expect(catalogState.first()).toBeVisible()

  await page.getByRole('button', { name: '财务概况', exact: true }).click()
  await expect(page.getByRole('region', { name: '人工发布状态' })).toContainText('六平台由人工执行发布')
  await expect(page.getByRole('region', { name: '人工发布状态' }).getByRole('button', { name: /发布/u })).toHaveCount(0)
  expect(pageErrors).toEqual([])
  await context.close()
  await browser.close()
})
