import { expect, test } from '@playwright/test'
import { ensureMerchantSession } from './merchant-auth.js'

test('merchant saves global brand settings and reads them back after reload', async ({ page }) => {
  const base = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18081/'
  const persona = `隔离浏览器验收 ${Date.now()}：关注日常运动的用户`
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await ensureMerchantSession(page)
  await page.getByRole('button', { name: '品牌资产', exact: true }).click()
  const save = page.getByRole('button', { name: '保存品牌配置', exact: true }).first()
  await expect(save).toBeEnabled()
  await page.getByRole('textbox', { name: '全局用户画像' }).fill(persona)
  const response = page.waitForResponse(item => item.url().includes('/v1/brand-scopes') && item.request().method() === 'PUT')
  await save.click()
  expect((await response).status()).toBe(200)
  await expect(page.getByRole('status').filter({ hasText: /已保存第 \d+ 版/ })).toBeVisible()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await ensureMerchantSession(page)
  await page.getByRole('button', { name: '品牌资产', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '全局用户画像' })).toHaveValue(persona)
})
