import { expect, test } from '@playwright/test'
import { ensureMerchantSession } from './merchant-auth.js'

test('merchant reveals brand save only for edits and persists settings after reload', async ({ page }) => {
  const base = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:18081/'
  const persona = `隔离浏览器验收 ${Date.now()}：关注日常运动的用户`
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await ensureMerchantSession(page)
  await page.getByRole('button', { name: '品牌资产', exact: true }).click()
  const hero = page.locator('.material-library-hero.brand-only')
  const save = hero.getByRole('button', { name: '保存品牌配置', exact: true })
  await expect(hero.locator('.material-library-brand-save')).toHaveCount(0)
  await expect(page.locator('.material-brand-actions-row')).toHaveCount(0)
  await expect(page.getByText('上传品牌资料', { exact: true })).toHaveCount(0)
  await expect(page.locator('.material-brand-single-banner')).toBeVisible()
  const seriesAndSingleGap = await page.evaluate(() => {
    const series = document.querySelectorAll('.material-brand-stack > .material-brand-row')[2]
    const single = document.querySelector('.material-brand-stack > .material-brand-single-row')
    if (!series || !single) return null
    return single.getBoundingClientRect().top - series.getBoundingClientRect().bottom
  })
  expect(seriesAndSingleGap).toBeCloseTo(14, 0)
  const personaInput = page.getByRole('textbox', { name: '全局用户画像' })
  const originalPersona = await personaInput.inputValue()
  await personaInput.fill(persona)
  await expect(save).toBeVisible()
  await expect(save).toBeEnabled()
  const response = page.waitForResponse(item => item.url().includes('/v1/brand-scopes') && item.request().method() === 'PUT')
  await save.click()
  expect((await response).status()).toBe(200)
  await expect(hero.getByRole('status').filter({ hasText: /已保存第 \d+ 版/ })).toBeVisible()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await ensureMerchantSession(page)
  await page.getByRole('button', { name: '品牌资产', exact: true }).click()
  const reloadedPersona = page.getByRole('textbox', { name: '全局用户画像' })
  await expect(reloadedPersona).toHaveValue(persona)
  await expect(hero.locator('.material-library-brand-save')).toHaveCount(0)

  // Leave the shared local demo workspace's configured value as it was before
  // this browser check. The PUT/GET round trip above still verifies persistence.
  await reloadedPersona.fill(originalPersona)
  await expect(save).toBeVisible()
  const restore = page.waitForResponse(item => item.url().includes('/v1/brand-scopes') && item.request().method() === 'PUT')
  await save.click()
  expect((await restore).status()).toBe(200)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await ensureMerchantSession(page)
  await page.getByRole('button', { name: '品牌资产', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '全局用户画像' })).toHaveValue(originalPersona)
})
