import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'

if (!process.env.OPS_E2E_OUTPUT_DIR || !process.env.OPS_BASE_URL) throw new Error('ISOLATED_OPS_RUNNER_REQUIRED')
test.use({ channel: 'chrome', viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' })
test.setTimeout(180000)

// Real password session/API/PG fixture provided by run-ops-password-e2e.ts.
// No page.route mocks and no manufacturing published business products.
test('desktop commercial catalog separates approval/sale and preserves an invalid draft through keyboard/zoom states', async ({ page }) => {
  const output = join(process.env.OPS_E2E_OUTPUT_DIR, 'commercial-packages')
  await mkdir(output, { recursive: true })
  const consoleErrors = [], mutations = []
  page.on('pageerror', error => consoleErrors.push(error.message))
  page.on('request', request => { if (request.url().endsWith('/api/mcp')) { const body = request.postDataJSON(); if (body?.method === 'ops.commercial.catalog-v2.mutate') mutations.push(body.params) } })
  await openPlatformConsole(page, '/ops/finance')
  const catalog = page.getByRole('region', { name: '商品目录', exact: true })
  // section has an accessible name via aria-labelledby, so it is a region.
  await expect(catalog).toBeVisible({ timeout: 30000 })
  await expect(catalog.getByRole('tab', { name: '套餐管理', exact: true })).toBeVisible()
  await expect(catalog.getByRole('tab', { name: '权益包管理', exact: true })).toBeVisible()
  await expect(catalog.getByRole('tab', { name: '开通费', exact: true })).toBeVisible()
  await expect(catalog.getByRole('columnheader', { name: '当前在售价格 / 周期', exact: true })).toBeVisible()
  await expect(catalog.getByRole('columnheader', { name: '销售状态', exact: true })).toBeVisible()
  await expect(catalog.getByRole('button', { name: '新增套餐草稿', exact: true })).toBeEnabled()
  await page.screenshot({ path: join(output, '01-catalog-desktop.png'), fullPage: true })
  await catalog.getByRole('button', { name: '新增套餐草稿', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '新增商品草稿', exact: true })
  await expect(editor).toBeVisible()
  await expect(editor.getByLabel('人民币价格（元）', { exact: true })).toBeVisible()
  expect(await editor.getByLabel('商品名称', { exact: true }).evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16)
  // Ant modal enters with a scale transform; measure the settled real target
  // instead of its first visible animation frame (44px appears as 8.8px).
  await expect.poll(async () => (await editor.getByRole('button', { name: '保存草稿', exact: true }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await editor.getByLabel('商品名称', { exact: true }).fill('QA保留输入的未完成草稿')
  const initialCount = mutations.length
  await editor.getByRole('button', { name: '保存草稿', exact: true }).click()
  await expect(editor.getByLabel('商品名称', { exact: true })).toHaveValue('QA保留输入的未完成草稿')
  await expect(editor.locator('.ant-form-item-explain-error').first()).toBeVisible()
  expect(mutations).toHaveLength(initialCount)
  await expect(editor.getByLabel('升级政策版本引用', { exact: true })).toBeAttached()
  await expect(editor.getByLabel('退款恢复政策版本引用', { exact: true })).toBeAttached()
  await page.screenshot({ path: join(output, '02-invalid-draft-retained.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect(editor).not.toBeVisible()
  await expect(catalog.getByRole('button', { name: '新增套餐草稿', exact: true })).toBeFocused()
  await catalog.getByRole('tab', { name: '开通费', exact: true }).click()
  await catalog.getByRole('button', { name: '新增开通费草稿', exact: true }).click()
  await expect(editor.getByLabel('赠点发放期数', { exact: true })).toHaveValue('6')
  await expect(editor.getByLabel('每期赠送创意点', { exact: true })).toHaveValue('500')
  await expect(editor).toContainText('开通费不含首期费')
  await page.keyboard.press('Escape')
  await catalog.getByRole('tab', { name: '权益包管理', exact: true }).click()
  await expect(catalog).toContainText('独立销售商品（价格与周期）')
  await page.screenshot({ path: join(output, '03-benefit-bundles.png'), fullPage: true })
  // Chromium page zoom via device/page CSS gives the desktop layout a 720px
  // effective canvas without adding a mobile/tablet requirement.
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  await expect(catalog.getByRole('tab', { name: '套餐管理', exact: true })).toBeVisible()
  await page.screenshot({ path: join(output, '04-desktop-200-percent.png'), fullPage: true })
  const fontSize = await catalog.getByRole('heading', { name: '商品目录', exact: true }).evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))
  expect(fontSize).toBeGreaterThanOrEqual(16)
  await page.evaluate(() => { document.documentElement.style.zoom = '1' })
  await page.addStyleTag({ content: '* { box-shadow: none !important; }' })
  await expect(catalog.getByRole('heading', { name: '商品目录', exact: true })).toBeVisible()
  await page.screenshot({ path: join(output, '05-desktop-no-shadows.png'), fullPage: true })
  expect(consoleErrors).toEqual([])
})
