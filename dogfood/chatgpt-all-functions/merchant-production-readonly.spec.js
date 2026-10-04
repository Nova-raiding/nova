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
  await expect(page.getByRole('heading', { name: /^已连接店铺/u }).first()).toBeVisible()

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
  await expect(page.getByRole('region', { name: '财务概况' })).toBeVisible()
  await expect(page.getByRole('button', { name: '充值创意点', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '人工发布状态' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '财务概况' }).getByRole('button', { name: /提交人工发布任务|确认人工发布/u })).toHaveCount(0)
  expect(pageErrors).toEqual([])
  await context.close()
  await browser.close()
})
