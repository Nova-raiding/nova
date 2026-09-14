import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

// This spec is intentionally runner-only. The managed runner supplies an
// isolated PG17/Redis/OIDC stack and refuses shared bearer fixtures.
const baseUrl = process.env.OPS_OIDC_BASE_URL
const workspaceId = process.env.OPS_E2E_WORKSPACE_ID
const outputDir = process.env.OPS_E2E_OUTPUT_DIR
if (!baseUrl || !workspaceId || !outputDir) throw new Error('Run through scripts/run-ops-oidc-e2e.ts with OPS_OIDC_BASE_URL, OPS_E2E_WORKSPACE_ID and OPS_E2E_OUTPUT_DIR')
const origin = new URL(baseUrl)
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || !origin.port || origin.pathname !== '/') throw new Error('OPS_OIDC_BASE_URL must be an explicit loopback origin')

test.describe.configure({ mode: 'serial', retries: 0 })
test.use({ channel: 'chrome', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, trace: 'off', video: 'off', screenshot: 'off' })
test.setTimeout(180_000)

const parse = value => { try { return JSON.parse(value) } catch { return null } }
const rpcPayload = request => {
  const url = new URL(request.url())
  if (request.method() !== 'POST' || url.origin !== origin.origin || url.pathname !== '/api/mcp') return null
  return parse(request.postData() || '')
}
const safeParams = params => {
  if (!params || typeof params !== 'object') return {}
  const keys = ['target_workspace_id', 'delivery_id', 'checklist_key', 'expected_revision', 'completed', 'company_name', 'payment_status', 'payment_date', 'planned_go_live_at', 'sort_order']
  return Object.fromEntries(keys.filter(key => Object.prototype.hasOwnProperty.call(params, key)).map(key => [key, params[key]]))
}

async function rpcAfter(page, method, action, evidence, expectedStatus = 200) {
  let started = false
  let requestRef
  const requestPromise = page.waitForRequest(request => {
    const payload = rpcPayload(request)
    if (started && payload?.method === method) { requestRef = request; return true }
    return false
  })
  const responsePromise = page.waitForResponse(response => response.request() === requestRef, { timeout: 45_000 })
    .then(async response => ({ response, body: parse(await response.text()) }))
  const [request, exchange] = await Promise.all([requestPromise, responsePromise, (async () => { started = true; await action() })()])
  const { response, body } = exchange
  const payload = rpcPayload(request)
  const error = body?.error ?? body?.data?.error
  const result = body?.result ?? body?.data?.result
  evidence.events.push({ event: 'rpc', method, status: response.status(), request: safeParams(payload?.params), error_code: error?.code ?? null })
  expect(response.status(), `${method} status`).toBe(expectedStatus)
  if (expectedStatus === 200) expect(error, `${method} RPC error`).toBeFalsy()
  return { payload, body, error, result }
}

async function login(page) {
  await page.addInitScript(({ workspaceId }) => {
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of ['ops_connection_config_v1', 'ops_api_base', 'ops_api_token', 'ops_actor_id', 'ops_workspace_id', 'ops_workbench']) storage.removeItem(key)
    }
    sessionStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId, workbench: 'platform' }))
    sessionStorage.setItem('ops_workspace_id', workspaceId)
    sessionStorage.setItem('ops_workbench', 'platform')
  }, { workspaceId })
  await page.goto(new URL('/ops/customer-delivery?workbench=platform', origin).toString(), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('textbox', { name: '运营账号', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '运营账号', exact: true }).fill(process.env.LOCAL_OIDC_TEST_USERNAME)
  await page.getByLabel('密码', { exact: true }).fill(process.env.LOCAL_OIDC_TEST_PASSWORD)
  await page.getByRole('button', { name: '安全登录', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('已由服务端验证', { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: '客户交付', exact: true })).toBeVisible({ timeout: 30_000 })
}

async function closeDrawer(page) {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: '保存当前环节', exact: true })).not.toHaveClass(/ant-btn-loading/u)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toBeHidden()
}

async function captureTrainingInteraction(page, evidenceDir, testInfo) {
  const url = new URL('/ops/customer-delivery?workbench=platform', origin).toString()
  const screenshotPath = join(evidenceDir, 'training-confirmed-shot-scraper.png')
  const videoPath = join(evidenceDir, 'training-inline.webm')
  const storyboard = join(evidenceDir, 'training-storyboard.json')
  // JSON is valid YAML. Only fixture UI preferences are written to the driver;
  // ephemeral fixture cookies are piped to shot-scraper, never saved in artifacts.
  await writeFile(storyboard, JSON.stringify({
    url, output: videoPath, viewport: { width: 1440, height: 900 },
    javascript: `sessionStorage.setItem('ops_connection_config_v1', ${JSON.stringify(JSON.stringify({ apiBase: '/api', workspaceId, workbench: 'platform' }))}); sessionStorage.setItem('ops_workspace_id', ${JSON.stringify(workspaceId)}); sessionStorage.setItem('ops_workbench', 'platform');`,
    scenes: [{ name: 'Training remains an inline action', open: url,
      wait_for: 'tbody input[type="checkbox"]:checked', do: [
        { click: 'tbody .ant-checkbox-wrapper' },
        { wait_for: 'tbody input[type="checkbox"]:not(:checked)' },
        { pause: 1 },
        { click: 'tbody .ant-checkbox-wrapper' },
        { wait_for: 'tbody input[type="checkbox"]:checked' },
        { pause: 1 },
        { screenshot: screenshotPath },
      ] }],
  }), { mode: 0o600 })
  const localBinary = join(homedir(), '.local/bin/shot-scraper')
  const binary = existsSync(localBinary) ? localBinary : 'shot-scraper'
  const authState = await page.context().storageState()
  await new Promise((resolve, reject) => {
    const child = spawn(binary, ['video', storyboard, '--auth', '/dev/stdin', '--browser', 'chrome', '--timeout', '45000'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 })
    child.stdout.resume(); child.stderr.resume()
    child.once('error', () => reject(new Error('SHOT_SCRAPER_UNAVAILABLE')))
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('SHOT_SCRAPER_CAPTURE_FAILED')))
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(authState))
  })
  await testInfo.attach('training-inline-shot-scraper', { path: screenshotPath, contentType: 'image/png' })
  await testInfo.attach('training-inline-video', { path: videoPath, contentType: 'video/webm' })
}

test('isolated customer delivery end-to-end fields, gates, checklists and clean-video rejection', async ({ page }, testInfo) => {
  page.setDefaultTimeout(15_000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.name))
  const evidenceDir = join(outputDir, `delivery-${Date.now()}`)
  await mkdir(evidenceDir, { recursive: true })
  const evidence = { schema_version: 1, evidence_kind: 'isolated_live_customer_delivery_ui_rpc', raw_browser_trace_saved: false, viewport: { width: 1440, height: 900 }, timezone: 'Asia/Shanghai', fixture: { workspace_id: workspaceId }, events: [] }
  const screenshot = async name => {
    const path = join(evidenceDir, `${name}.png`)
    await page.screenshot({ path, fullPage: false, mask: [page.locator('input[type="password"]')] })
    evidence.events.push({ event: 'screenshot', name: `${name}.png` })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  const company = `隔离交付验收-${Date.now()}`
  try {
    await login(page)
    await page.getByRole('button', { name: '新建客户', exact: true }).click()
    await page.getByRole('textbox', { name: /公司名称/u }).fill(company)
    await rpcAfter(page, 'ops.customer-delivery.create', () => page.getByRole('button', { name: /创\s*建/u }).click(), evidence)
    const row = page.getByRole('row').filter({ hasText: company })
    await expect(row).toBeVisible()
    await screenshot('customer-created')

    // Profile is fillable while unpaid, but controlled delivery steps are not.
    const profile = page.getByRole('dialog')
    await profile.getByLabel('合同编号').fill(`C-${Date.now()}`)
    await profile.getByLabel('合同文件').fill('https://example.com/delivery-contract.pdf')
    await profile.getByLabel('项目负责人').fill('隔离项目负责人')
    await profile.getByLabel('售后负责人').fill('隔离售后负责人')
    await profile.getByLabel('要求上线时间').fill('2026-10-01T09:00')
    await rpcAfter(page, 'ops.customer-delivery.update', () => profile.getByRole('button', { name: '保存当前环节', exact: true }).click(), evidence)
    await expect(profile).toBeVisible()
    await closeDrawer(page)
    await expect(profile).toBeHidden()
    await expect(row.locator('td').nth(2)).toContainText('已完成')
    await row.locator('td').nth(3).getByRole('button').click()
    await expect(page.getByText('用户尚未完成付款', { exact: true })).toBeVisible()

    // Complete payment/profile and assert the persisted DATE/timestamp wire values.
    await row.locator('td').nth(2).getByRole('button').click()
    const paidProfile = page.getByRole('dialog')
    await paidProfile.getByLabel('付款状态').click()
    await page.getByText('已完成付款核验', { exact: true }).click()
    await paidProfile.getByLabel('付款日期').fill('2026-09-14')
    const savedProfile = await rpcAfter(page, 'ops.customer-delivery.update', () => paidProfile.getByRole('button', { name: '保存当前环节', exact: true }).click(), evidence)
    const wire = savedProfile.result
    expect(wire.paymentDate ?? wire.payment_date).toBe('2026-09-14')
    expect(wire.plannedGoLiveAt ?? wire.planned_go_live_at).toBe('2026-10-01T01:00:00.000Z')
    await closeDrawer(page)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: '客户交付', exact: true })).toBeVisible({ timeout: 30_000 })
    const refreshedRow = page.getByRole('row').filter({ hasText: company })
    await expect(refreshedRow).toBeVisible()
    await refreshedRow.locator('td').nth(2).getByRole('button').click()
    await expect(page.getByRole('dialog').getByLabel('付款日期')).toHaveValue('2026-09-14')
    await expect(page.getByRole('dialog').getByLabel('要求上线时间')).toHaveValue('2026-10-01T09:00')
    await screenshot('profile-fields-reloaded')
    await closeDrawer(page)

    const fillChecklist = async (labels, checklistKey) => {
      const cell = refreshedRow.locator('td').nth(checklistKey === 'system_integration' ? 3 : 4)
      await cell.getByRole('button').click()
      const dialog = page.getByRole('dialog')
      const boxes = dialog.getByRole('checkbox')
      await expect(boxes).toHaveCount(labels.length)
      for (let i = 0; i < labels.length; i++) {
        await boxes.nth(i).click()
        await expect(boxes.nth(i)).toBeChecked()
        await dialog.getByLabel(`${labels[i]} · 证据`).fill(`证据-${i + 1}`)
      }
      const saved = await rpcAfter(page, 'ops.customer-delivery.checklist.update', () => dialog.getByRole('button', { name: '保存当前环节', exact: true }).click(), evidence)
      expect(saved.payload.params.items_json).toBeTruthy()
      await closeDrawer(page)
      await expect(cell).toContainText('已完成')
      await cell.getByRole('button').click()
      const reopened = page.getByRole('dialog')
      for (let i = 0; i < labels.length; i++) await expect(reopened.getByLabel(`${labels[i]} · 证据`)).toHaveValue(`证据-${i + 1}`)
      await closeDrawer(page)
    }
    await fillChecklist(['插件账户', '店铺连接', '商品扫描', '知识库功能', '平台规则', '创作点', '企业信息', '品牌资产', '商品资料', '客户偏好'], 'system_integration')
    await fillChecklist(['文案生成', '图片生成', '批注修改', '自动检查', '视频生成', '店铺与商品资料读取', '技术验收', '内容验收'], 'functional_acceptance')

    // Training can be completed directly from the overview; it must not open a drawer.
    const trainingCell = refreshedRow.locator('td').nth(5)
    await expect(trainingCell.getByRole('button', { name: '详情', exact: true })).toHaveCount(0)
    const trainingBox = trainingCell.getByRole('checkbox')
    await expect(trainingBox).toBeVisible()
    await expect(trainingBox).not.toBeChecked()
    const beforeDialogs = await page.getByRole('dialog').count()
    await rpcAfter(page, 'ops.customer-delivery.training.complete', () => trainingBox.click(), evidence)
    expect(await page.getByRole('dialog').count()).toBe(beforeDialogs)
    await expect(trainingBox).toBeChecked()

    // No clean scanned asset exists in the isolated fixture: the API must reject
    // the video reference instead of allowing the repository to claim success.
    await refreshedRow.getByRole('button', { name: /未上传|\d+ 段/u }).click()
    const videoDialog = page.getByRole('dialog')
    await videoDialog.getByLabel('交付视频（支持多段）').fill('asset_ref_not_scanned')
    const rejected = await rpcAfter(page, 'ops.customer-delivery.videos.add', () => videoDialog.getByRole('button', { name: '保存当前环节', exact: true }).click(), evidence, 409)
    expect(rejected.error?.code).toBe('CUSTOMER_DELIVERY_VIDEO_ASSET_NOT_READY')
    await expect(videoDialog.getByText('尚未登记交付视频', { exact: true })).toBeVisible()
    await expect(refreshedRow).not.toContainText('交付已完成')
    await expect(refreshedRow).not.toContainText('已生效')
    await screenshot('customer-delivery-gates')
    await captureTrainingInteraction(page, evidenceDir, testInfo)
    await closeDrawer(page)
    await page.getByRole('button', { name: '新建客户', exact: true }).click()
    await page.getByRole('textbox', { name: /公司名称/u }).fill(`${company}-second`)
    await rpcAfter(page, 'ops.customer-delivery.create', () => page.getByRole('button', { name: /创\s*建/u }).click(), evidence)
    const newProfile = page.getByRole('dialog')
    for (const label of ['合同编号', '合同文件', '项目负责人', '售后负责人', '付款日期', '要求上线时间']) {
      await expect(newProfile.getByLabel(label)).toHaveValue('')
    }
    evidence.events.push({ event: 'new_customer_has_no_previous_profile_fields' })
    expect(pageErrors).toEqual([])
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'
    await screenshot('failure-masked').catch(() => undefined)
    throw error
  } finally {
    await writeFile(join(evidenceDir, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  }
})
