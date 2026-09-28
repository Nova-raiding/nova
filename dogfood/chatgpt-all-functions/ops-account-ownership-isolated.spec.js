import { expect, test } from '@playwright/test'
import { openPlatformConsole } from './ops-auth.js'

test.use({ channel: 'chrome' })
test.setTimeout(120_000)

test('separates platform operators from merchant members', async ({ page }) => {
  const operator = process.env.OPS_TEST_USERNAME
  if (!operator) throw new Error('OPS_TEST_USERNAME is required')
  await page.setViewportSize({ width: 1440, height: 900 })
  await openPlatformConsole(page)
  await page.locator('#ops-primary-navigation').getByRole('button', { name: '用户中心', exact: true }).click()
  const filters = page.getByRole('form', { name: '用户目录筛选' })
  await expect(filters).toBeVisible()
  await expect(page.getByText('商户用户', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('table', { name: '用户目录数据表' })).not.toContainText(operator)

  await filters.getByRole('combobox', { name: '按账号归属筛选用户目录' }).click()
  await page.locator('.ant-select-dropdown:visible').getByText('运营平台用户', { exact: true }).click()
  const table = page.getByRole('table', { name: '用户目录数据表' })
  await expect(table).toContainText(operator)
  await expect(page.getByText(/当前筛选：\d+ 条运营平台账号/u)).toBeVisible()
  const row = table.getByRole('row').filter({ hasText: operator })
  await expect(row).toContainText('运营平台')
  await row.getByRole('button', { name: /用户详情/u }).click()
  const detail = page.getByRole('dialog', { name: '运营平台账号详情' })
  await expect(detail).toContainText('此账号属于运营平台')
  await expect(detail.getByRole('heading', { name: '旧版套餐与任务额度快照' })).toHaveCount(0)
})
