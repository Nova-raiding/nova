import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'

if (!process.env.OPS_E2E_OUTPUT_DIR || !process.env.OPS_BASE_URL) throw new Error('ISOLATED_OPS_RUNNER_REQUIRED')
test.use({ channel: 'chrome', viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' })
test.setTimeout(360_000)

const bundleMethod = 'ops.commercial.benefit-bundles.mutate'
const catalogMethod = 'ops.commercial.catalog-v2.mutate'

function waitForRpc(page, method, action) {
  return page.waitForResponse(response => {
    if (!response.url().endsWith('/api/mcp')) return false
    try {
      const body = response.request().postDataJSON()
      return body?.method === method && (action === undefined || body?.params?.action === action)
    } catch { return false }
  }, { timeout: 20_000 })
}

function bundleRow(manager, code, version) {
  return manager.locator('.ant-table-tbody tr')
    .filter({ hasText: code })
    .filter({ hasText: `v${version}` })
}

async function saveBundle(page, manager, { code, name, usage, points, version, edit = false }) {
  const row = version === undefined ? undefined : bundleRow(manager, code, version)
  if (edit) await row.getByRole('button', { name: '编辑新版本', exact: true }).click()
  else await manager.getByRole('button', { name: '新增权益组合草稿', exact: true }).click()

  const editor = page.getByRole('dialog', { name: '权益包新版本草稿', exact: true })
  await expect(editor).toBeVisible({ timeout: 20_000 })
  if (!edit) {
    await editor.getByLabel('权益包编码（创建后固定）', { exact: true }).fill(code)
    const usageField = editor.getByLabel('用途（创建后固定）', { exact: true })
    if (usage === 'standalone') {
      await usageField.click({ timeout: 20_000 })
      await usageField.press('ArrowDown')
      await usageField.press('Enter')
    }
    await expect(editor.getByText(usage === 'included' ? '套餐内含' : '独立销售', { exact: true })).toBeVisible({ timeout: 20_000 })
  }
  await editor.getByLabel('权益包名称', { exact: true }).fill(name)
  if (!edit) await editor.getByRole('button', { name: '添加已注册权益', exact: true }).click()
  const benefitIndex = edit ? 1 : 1
  const benefitSelector = editor.getByLabel(`权益 ${benefitIndex}`, { exact: true })
  if (!edit) {
    await benefitSelector.click({ timeout: 20_000 })
    for (let step = 0; step < 4; step += 1) await benefitSelector.press('ArrowDown')
    await benefitSelector.press('Enter')
    await expect(editor.locator('.commercial-catalog-benefit-row .ant-select')).toContainText('创意点', { timeout: 20_000 })
  }
  await editor.getByLabel('数量或功能授权', { exact: true }).fill(String(points))
  await editor.getByLabel('批准政策引用', { exact: true }).fill('owned-test:benefit-bundle-v1')
  await editor.getByLabel('变更原因', { exact: true }).fill('隔离套餐权益包生命周期验收')
  const responsePromise = waitForRpc(page, bundleMethod, 'create')
  await editor.getByRole('button', { name: '保存草稿', exact: true }).click()
  const response = await responsePromise
  expect(response.status()).toBe(200)
  await expect(editor).not.toBeVisible()
  return editor
}

async function runBundleAction(page, manager, { code, version, button, action }) {
  const row = bundleRow(manager, code, version)
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: button, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '确认权益包状态变更', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.locator('#bundle-action-reason').fill('隔离套餐权益包生命周期验收')
  const responsePromise = waitForRpc(page, bundleMethod, action)
  await dialog.getByRole('button', { name: '确认变更', exact: true }).click()
  const response = await responsePromise
  expect(response.status()).toBe(200)
  await expect(dialog).not.toBeVisible()
}

// Exercises only disposable Ops credentials, API, PostgreSQL and Redis created
// by run-ops-password-e2e.ts. No production product, receipt or merchant data.
test('Ops can version, review, reference and retire reusable benefit bundles without changing prior references', async ({ page }) => {
  const output = join(process.env.OPS_E2E_OUTPUT_DIR, 'commercial-benefit-bundles')
  await mkdir(output, { recursive: true })
  const errors = []
  const bundleMutations = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (!request.url().endsWith('/api/mcp')) return
    try {
      const body = request.postDataJSON()
      if (body?.method === bundleMethod) bundleMutations.push({ action: body.params?.action, usage: body.params?.usage })
    } catch { /* unrelated non-JSON requests are ignored */ }
  })

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const code = `qa-bundle-${suffix}`
  const skuCode = `qa-bundle-ref-${suffix}`
  const name = `隔离创意权益-${suffix}`
  const v2Name = `隔离创意权益新版本-${suffix}`
  const rejectCode = `qa-bundle-reject-${suffix}`
  const rejectName = `隔离拒绝权益-${suffix}`

  await openPlatformConsole(page, '/ops/finance')
  const catalog = page.getByRole('region', { name: '商品目录', exact: true })
  await expect(catalog).toBeVisible({ timeout: 30_000 })
  await catalog.getByRole('tab', { name: '权益包管理', exact: true }).click()
  const manager = page.getByRole('region', { name: '可复用权益包', exact: true })
  await expect(manager.getByRole('heading', { name: '可复用权益包', exact: true })).toBeVisible()
  await expect(manager.getByRole('button', { name: '新增权益组合草稿', exact: true })).toBeEnabled({ timeout: 30_000 })
  await expect(manager.getByText(/共 \d+ 个版本/)).toBeVisible()
  await page.screenshot({ path: join(output, '01-bundle-manager-loaded.png'), fullPage: true })

  await saveBundle(page, manager, { code, name, usage: 'included', points: 500 })
  await expect(bundleRow(manager, code, 1)).toContainText('草稿')

  // Each lifecycle operation appends a new immutable version. Approval is
  // required before a SKU can reference this bundle version.
  await runBundleAction(page, manager, { code, version: 1, button: '提交审批', action: 'submit' })
  await expect(bundleRow(manager, code, 2)).toContainText('待审批')
  await runBundleAction(page, manager, { code, version: 2, button: '审批通过', action: 'approve' })
  await expect(bundleRow(manager, code, 3)).toContainText('已批准')

  // Create a real catalog draft bound to the approved bundle version. This
  // creates a durable SKU-version reference without publishing a real product.
  await catalog.getByRole('tab', { name: '套餐管理', exact: true }).click()
  await catalog.getByRole('button', { name: '新增套餐草稿', exact: true }).click()
  const skuEditor = page.getByRole('dialog', { name: '新增商品草稿', exact: true })
  await expect(skuEditor).toBeVisible()
  await skuEditor.getByLabel('商品编码（创建后固定）', { exact: true }).fill(skuCode)
  await skuEditor.getByLabel('商品名称', { exact: true }).fill(`绑定历史包版本-${suffix}`)
  await skuEditor.getByLabel('人民币价格（元）', { exact: true }).fill('10')
  await skuEditor.getByLabel('已核实政策版本引用', { exact: true }).fill('owned-test:bundle-reference-v1')
  await skuEditor.getByLabel('成功到账窗口（秒）', { exact: true }).fill('3600')
  const bundlePicker = skuEditor.getByLabel('绑定已批准权益包版本（旧版本不自动升级）', { exact: true })
  await bundlePicker.click({ timeout: 20_000 })
  await bundlePicker.press('ArrowDown')
  await bundlePicker.press('Enter')
  await expect(skuEditor.locator('.ant-select').filter({ hasText: `${name} v3 · 套餐内含` })).toBeVisible({ timeout: 20_000 })
  await skuEditor.getByLabel('变更原因', { exact: true }).fill('隔离权益包旧版本引用验收')
  const skuResponsePromise = waitForRpc(page, catalogMethod, 'create')
  await skuEditor.getByRole('button', { name: '保存草稿', exact: true }).click()
  const skuResponse = await skuResponsePromise
  expect(skuResponse.status()).toBe(200)
  await expect(skuEditor).not.toBeVisible()

  await catalog.getByRole('tab', { name: '权益包管理', exact: true }).click()
  await expect(bundleRow(manager, code, 3)).toBeVisible()
  await saveBundle(page, manager, { code, name: v2Name, usage: 'included', points: 800, version: 3, edit: true })
  await expect(bundleRow(manager, code, 4)).toContainText('草稿')

  // The previous approved version and its SKU reference must stay readable
  // after a newer draft exists; no latest-version substitution is allowed.
  const oldVersionRow = bundleRow(manager, code, 3)
  await oldVersionRow.getByRole('button', { name: '详情与引用', exact: true }).click()
  const details = page.getByRole('dialog', { name: '权益包详情与引用', exact: true })
  await expect(details).toBeVisible()
  await expect(details).toContainText(`${name} v3`)
  await expect(details).toContainText('creative_points：500 point')
  await expect(details).toContainText(skuCode, { timeout: 30_000 })
  await page.screenshot({ path: join(output, '02-approved-old-version-reference.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect(details).not.toBeVisible()

  await runBundleAction(page, manager, { code, version: 4, button: '提交审批', action: 'submit' })
  await expect(bundleRow(manager, code, 5)).toContainText('待审批')
  await runBundleAction(page, manager, { code, version: 5, button: '审批通过', action: 'approve' })
  await expect(bundleRow(manager, code, 6)).toContainText('已批准')
  await runBundleAction(page, manager, { code, version: 6, button: '停用新绑定', action: 'retire' })
  await expect(bundleRow(manager, code, 7)).toContainText('禁止新绑定')
  await runBundleAction(page, manager, { code, version: 7, button: '归 档', action: 'archive' })
  await expect(bundleRow(manager, code, 8)).toContainText('已归档')

  // Verify the reference still targets v3 after later bundle lifecycle writes.
  await bundleRow(manager, code, 3).getByRole('button', { name: '详情与引用', exact: true }).click()
  const archivedDetails = page.getByRole('dialog', { name: '权益包详情与引用', exact: true })
  await expect(archivedDetails).toContainText(`${name} v3`)
  await expect(archivedDetails).toContainText(skuCode)
  await page.keyboard.press('Escape')

  // A separate standalone bundle covers rejection and safe draft deletion.
  await saveBundle(page, manager, { code: rejectCode, name: rejectName, usage: 'standalone', points: 100 })
  await runBundleAction(page, manager, { code: rejectCode, version: 1, button: '提交审批', action: 'submit' })
  await expect(bundleRow(manager, rejectCode, 2)).toContainText('待审批')
  await runBundleAction(page, manager, { code: rejectCode, version: 2, button: '拒 绝', action: 'reject' })
  await expect(bundleRow(manager, rejectCode, 3)).toContainText('已拒绝')
  await saveBundle(page, manager, { code: rejectCode, name: `${rejectName}-修订`, usage: 'standalone', points: 100, version: 3, edit: true })
  await expect(bundleRow(manager, rejectCode, 4)).toContainText('草稿')
  await runBundleAction(page, manager, { code: rejectCode, version: 4, button: '删除草稿', action: 'delete_draft' })
  await expect(bundleRow(manager, rejectCode, 5)).toContainText('已删除')

  expect(bundleMutations.map(({ action }) => action)).toEqual(expect.arrayContaining(['create', 'submit', 'approve', 'reject', 'retire', 'archive', 'delete_draft']))
  expect(bundleMutations.filter(({ action }) => action === 'create').map(({ usage }) => usage)).toEqual(expect.arrayContaining(['included', 'standalone']))
  expect(errors).toEqual([])
  await page.screenshot({ path: join(output, '03-complete-bundle-lifecycle.png'), fullPage: true })
})


test('Ops can select creative points and save the isolated benefit bundle draft', async ({ page }) => {
  test.setTimeout(90_000)
  page.setDefaultTimeout(20_000)
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const code = `qa-points-${suffix}`
  const name = `隔离创意点权益-${suffix}`
  const creates = []
  page.on('request', request => {
    if (!request.url().endsWith('/api/mcp')) return
    try {
      const body = request.postDataJSON()
      if (body?.method === bundleMethod && body.params?.action === 'create') creates.push(body.params)
    } catch { /* unrelated non-JSON requests are ignored */ }
  })

  await openPlatformConsole(page, '/ops/finance')
  const catalog = page.getByRole('region', { name: '商品目录', exact: true })
  await expect(catalog).toBeVisible({ timeout: 20_000 })
  await catalog.getByRole('tab', { name: '权益包管理', exact: true }).click()
  const manager = page.getByRole('region', { name: '可复用权益包', exact: true })
  await expect(manager.getByRole('button', { name: '新增权益组合草稿', exact: true })).toBeEnabled({ timeout: 20_000 })

  await saveBundle(page, manager, { code, name, usage: 'included', points: 500 })
  expect(creates).toHaveLength(1)
  expect(creates[0]).toMatchObject({ code, usage: 'included' })
  expect(JSON.parse(creates[0].benefits_json)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'creative_points', quantity: 500 })]))
  const savedDraftRow = manager.locator('.ant-table-tbody tr').filter({ hasText: code })
  await expect(savedDraftRow).toContainText('草稿')
})
