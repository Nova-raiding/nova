import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'

const baseUrl = process.env.OPS_BASE_URL
const workspaceId = process.env.OPS_E2E_WORKSPACE_ID
const actorId = process.env.OPS_ACTOR_ID
const username = process.env.OPS_TEST_USERNAME
const password = process.env.OPS_TEST_PASSWORD
const merchantUsername = process.env.OPS_E2E_MERCHANT_USERNAME
const merchantPassword = process.env.OPS_E2E_MERCHANT_PASSWORD
const evidenceDir = process.env.OPS_E2E_OUTPUT_DIR
if (!baseUrl || !workspaceId || !actorId || !username || !password || !merchantUsername || !merchantPassword || !evidenceDir || process.env.OPS_E2E_MANUAL_OPERATIONS !== 'true') {
  throw new Error('Manual import browser acceptance requires an isolated manual-operations fixture')
}
if (new URL(baseUrl).hostname !== '127.0.0.1') throw new Error('Manual import browser acceptance must use loopback')

test.use({ channel: 'chrome', trace: 'off', video: 'off', screenshot: 'off' })
test.setTimeout(180_000)

async function spreadsheet(storeName, itemKey) {
  const headers = ['平台', '商品货号', '商品名称', '店铺名称', '店铺账号', '商品价格', '商品库存']
  const rows = [headers, ['京东', itemKey, `隔离测试商品 ${itemKey}`, storeName, '', '39', '2']]
  const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const cell = (value, index, row) => `<c r="${String.fromCharCode(65 + index)}${row}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="商品" sheetId="1" r:id="rId1"/></sheets></workbook>')
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
  zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((values, index) => `<row r="${index + 1}">${values.map((value, column) => cell(value, column, index + 1)).join('')}</row>`).join('')}</sheetData></worksheet>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function chooseSelect(page, selector, option) {
  await (typeof selector === 'string' ? page.locator(selector) : selector).click()
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option:visible').filter({ hasText: option }).first().click()
}

test('Ops XLSX preview rejects wrong store and imports verified isolated source', async ({ page, browser }) => {
  page.setDefaultTimeout(15_000)
  const accountId = `qa-store-${randomUUID()}`
  const correctName = '隔离测试旗舰店'
  const wrongName = '隔离其他店铺'
  const itemKey = `QA-${randomUUID().slice(0, 8)}`
  const evidence = { isolated: true, workspace_id: workspaceId, account_id: accountId, wrong_xlsx_rejected: false, wrong_csv_rejected: false, correct_xlsx_imported: false, merchant_visible: false }
  await page.goto(`${baseUrl}/ops/stores?workbench=platform`, { waitUntil: 'domcontentloaded' })
  await page.getByLabel('平台运营账号', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录平台运营后台', exact: true }).click()
  await expect(page.getByRole('heading', { name: '平台连接汇总' })).toBeVisible({ timeout: 30_000 })
  const roleResponse = await page.request.post(`${baseUrl}/api/mcp`, {
    headers: { 'x-ops-workbench': 'platform' },
    data: { jsonrpc: '2.0', id: 1, method: 'ops.authorization.role.assign', params: {
      subject_identity_id: actorId, role: 'ops_admin', expected_authorization_revision: '2',
      reason: '隔离浏览器验收人工店铺登记与代导入',
    } },
  })
  expect(roleResponse.status()).toBe(200)
  expect((await roleResponse.json()).error).toBeFalsy()
  await page.reload()
  await expect(page.getByRole('button', { name: '登记人工店铺' })).toBeVisible()

  await page.getByRole('button', { name: '登记人工店铺' }).click()
  await chooseSelect(page, '#manual-store-workspace', new RegExp(workspaceId))
  await chooseSelect(page, '#manual-store-platform', '京东')
  await page.locator('#manual-store-account').fill(accountId)
  await page.locator('#manual-store-alias').fill(correctName)
  await page.locator('#manual-store-reason').fill('隔离浏览器 E2E 合成店铺')
  await page.getByRole('button', { name: '确认登记' }).click()
  await expect(page.getByRole('dialog', { name: '登记人工店铺' })).toBeHidden({ timeout: 30_000 })

  const importCard = page.locator('.ant-card').filter({ hasText: '运营代商家上传店铺商品' })
  await chooseSelect(page, importCard.locator('.ant-select').nth(0), new RegExp(workspaceId))
  await chooseSelect(page, importCard.locator('.ant-select').nth(1), correctName)
  const fileInput = importCard.locator('input[type="file"][accept=".xlsx,.csv"]')
  await fileInput.setInputFiles({ name: 'wrong-store.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await spreadsheet(wrongName, itemKey) })
  await expect(importCard.getByText('预览：1 个商品')).toBeVisible()
  await expect(importCard.getByText(/店铺名称与所选店铺不一致/u)).toBeVisible()
  await expect(importCard.getByRole('button', { name: '确认预览并导入所选商家店铺' })).toBeDisabled()
  evidence.wrong_xlsx_rejected = true

  const csv = `平台,商品货号,商品名称,店铺名称,店铺账号,商品价格,商品库存\n京东,${itemKey},"隔离测试商品, CSV",${wrongName},,39,2\n`
  await fileInput.setInputFiles({ name: 'wrong-store.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') })
  await expect(importCard.getByText('预览：1 个商品')).toBeVisible()
  await expect(importCard.getByText(/店铺名称与所选店铺不一致/u)).toBeVisible()
  await expect(importCard.getByRole('button', { name: '确认预览并导入所选商家店铺' })).toBeDisabled()
  evidence.wrong_csv_rejected = true

  await fileInput.setInputFiles({ name: 'verified-store.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await spreadsheet(correctName, itemKey) })
  await expect(importCard.getByText('预览：1 个商品')).toBeVisible()
  await expect(importCard.getByText(/无法仅凭原表格与已登记店铺自动核实归属/u)).toBeVisible()
  await importCard.getByRole('checkbox', { name: /我已核对原始资料/u }).check()
  await importCard.getByPlaceholder('资料来源，例如商家提供的文件编号或公开链接').fill(`qa://isolated/${itemKey}`)
  await importCard.getByPlaceholder('填写本次代商家上传的原因').fill('隔离验收已核对合成来源与目标店铺')
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/mcp') && response.request().postData()?.includes('ops.platform.product.import.batch'))
  await importCard.getByRole('button', { name: '确认预览并导入所选商家店铺' }).click()
  const response = await responsePromise
  const body = await response.json()
  expect(response.status()).toBe(200)
  expect(body.error).toBeNull()
  await expect(importCard.getByText('已导入 1 个商品到所选商家店铺，商品事实待商家核对。')).toBeVisible()
  evidence.correct_xlsx_imported = true

  const merchant = await browser.newContext()
  try {
    const login = await merchant.request.post(`${baseUrl}/api/v1/auth/login`, { data: { login: merchantUsername, password: merchantPassword, account_type: 'merchant' } })
    expect(login.status()).toBe(200)
    const loginBody = await login.json()
    expect(loginBody.data?.account?.accountType).toBe('merchant')
    const listed = await merchant.request.get(`${baseUrl}/api/v1/products?limit=50&offset=0`)
    expect(listed.status()).toBe(200)
    const products = await listed.json()
    expect(products.data?.items).toEqual(expect.arrayContaining([expect.objectContaining({ accountId, title: `隔离测试商品 ${itemKey}` })]))
    evidence.merchant_visible = true
  } finally { await merchant.close() }

  await mkdir(evidenceDir, { recursive: true })
  await writeFile(join(evidenceDir, 'manual-import-browser-evidence.json'), JSON.stringify(evidence, null, 2))
})
