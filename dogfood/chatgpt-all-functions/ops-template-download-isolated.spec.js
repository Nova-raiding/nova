import { expect, test } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { openPlatformConsole } from './ops-auth.js'

const baseUrl = process.env.OPS_BASE_URL
const evidenceDir = process.env.OPS_E2E_OUTPUT_DIR
if (!baseUrl || !evidenceDir || new URL(baseUrl).hostname !== '127.0.0.1') {
  throw new Error('Template download acceptance requires an isolated loopback Ops fixture')
}

test.use({ channel: 'chrome', trace: 'on' })
test.setTimeout(120_000)

test('downloads the 30-column JD SKU template and field guide from Ops', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openPlatformConsole(page, '/ops/stores?workbench=platform')
  const card = page.locator('.ant-card').filter({ hasText: '运营代商家上传店铺商品' })
  await expect(card).toBeVisible()
  await mkdir(evidenceDir, { recursive: true })
  await card.screenshot({ path: join(evidenceDir, 'ops-template-download.png') })

  const downloadPromise = page.waitForEvent('download')
  await card.getByRole('button', { name: '下载模板' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('商品-SKU导入模板.xlsx')
  const bytes = await readFile(await download.path())
  const zip = await JSZip.loadAsync(bytes)
  const sheet = await zip.file('xl/worksheets/sheet1.xml')?.async('text')
  const guide = await zip.file('xl/worksheets/sheet2.xml')?.async('text')
  expect(sheet).toBeTruthy()
  expect(guide).toBeTruthy()
  const rows = [...sheet.matchAll(/<row r="(\d+)">([\s\S]*?)<\/row>/gu)]
  expect(rows).toHaveLength(2)
  expect([...rows[0][2].matchAll(/<c r="[A-Z]+1"/gu)]).toHaveLength(30)
  expect([...rows[1][2].matchAll(/<c r="[A-Z]+2"/gu)]).toHaveLength(30)
  for (const value of ['贵人鸟', '10137064435110', '399.2', '99']) expect(rows[1][2]).toContain(value)
  for (const value of ['填写说明', '必填', '选填', '知识草稿', '未从京东页面独立核验']) expect(guide).toContain(value)
})
