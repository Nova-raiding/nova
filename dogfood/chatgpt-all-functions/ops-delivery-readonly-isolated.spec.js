import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'

// This test changes only its disposable fixture identity and one unpaid draft.
// No direct DB writes, payment, scanner, model calls, or shared credentials.
const workspaceId = process.env.OPS_E2E_WORKSPACE_ID
const outputDir = process.env.OPS_E2E_OUTPUT_DIR
const baseUrl = process.env.OPS_OIDC_BASE_URL
if (!workspaceId || !outputDir || !baseUrl) throw new Error('ISOLATED_DELIVERY_READONLY_RUNNER_REQUIRED')
const origin = new URL(baseUrl)
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) throw new Error('DELIVERY_READONLY_REQUIRES_LOOPBACK_FIXTURE')

test.use({ channel: 'chrome', viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai', actionTimeout: 15_000, trace: 'off', video: 'off', screenshot: 'off' })
test.describe.configure({ retries: 0 })
test.setTimeout(120_000)

test('read-only platform operator can inspect every delivery section without mutation authority', async ({ page }, testInfo) => {
  const evidenceDir = join(outputDir, 'delivery-readonly')
  await mkdir(evidenceDir, { recursive: true })
  const evidence = { status: 'failed', kind: 'real_oidc_durable_readonly_delivery', events: [], sharedDataTouched: false, credentialsSaved: false, scannerStarted: false }
  const rpc = async (method, params = {}, expectedStatus = 200) => {
    const response = await page.request.post(new URL('/api/mcp', origin).toString(), {
      headers: { 'x-ops-workbench': 'platform', 'x-workspace-id': workspaceId },
      data: { jsonrpc: '2.0', id: randomUUID(), method, params },
    })
    const body = await response.json()
    const error = body?.error ?? body?.data?.error
    evidence.events.push({ method, status: response.status(), errorCode: error?.code ?? null, capability: error?.details?.capability ?? null })
    expect(response.status(), method).toBe(expectedStatus)
    if (expectedStatus === 200) expect(error, method).toBeFalsy()
    else expect(error).toMatchObject({ code: 'FORBIDDEN', details: { capability: 'customer.delivery.update' } })
    return body?.result ?? body?.data?.result
  }
  try {
    await openPlatformConsole(page, '/ops/customer-delivery?workbench=platform')
    const session = await rpc('ops.session')
    const companyName = `只读验收企业-${randomUUID().slice(0, 8)}`
    const draft = await rpc('ops.customer-delivery.create', { target_workspace_id: workspaceId, company_name: companyName })
    expect(draft.paymentStatus).toBe('unpaid')
    const roles = await rpc('ops.authorization.roles.list', { subject_identity_id: session.identity_id })
    const admin = roles.assignments.find(item => item.role === 'platform_admin')
    expect(admin).toBeTruthy()
    const support = await rpc('ops.authorization.role.assign', { subject_identity_id: session.identity_id, role: 'support_agent', reason: 'isolated read-only delivery acceptance', expected_authorization_revision: String(roles.authorization_revision) })
    await rpc('ops.authorization.role.revoke', { subject_identity_id: session.identity_id, assignment_id: admin.id, reason: 'isolated read-only delivery acceptance', expected_revision: String(admin.revision), expected_authorization_revision: String(support.authorizationRevision) })
    const reader = await rpc('ops.session')
    expect(reader.capabilities).toContain('customer.delivery.read')
    expect(reader.capabilities).not.toContain('customer.delivery.update')
    expect(reader.canonical_roles).toContain('support_agent')
    const scope = { target_workspace_id: workspaceId, delivery_id: draft.id }
    const before = await rpc('ops.customer-delivery.get', scope)
    for (const checklistKey of ['system_integration', 'functional_acceptance']) {
      const checklist = await rpc('ops.customer-delivery.checklist-items.list', { ...scope, checklist_key: checklistKey })
      // A newly-created unpaid draft has no saved checklist rows. The page
      // must still render all 18 defined controls below without creating rows.
      expect(checklist.items).toEqual([])
    }

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText('当前会话仅可查看客户交付', { exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: '客户交付目标企业工作区' }).click()
    await page.locator('.ant-select-item-option').filter({ hasText: workspaceId }).click()
    const row = page.getByRole('row').filter({ hasText: companyName })
    await expect(row).toBeVisible()
    await expect(page.getByRole('button', { name: '新建客户', exact: true })).toBeDisabled()
    await expect(row.getByRole('checkbox')).toBeDisabled()
    const uiWrites = []
    page.on('request', request => {
      if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/mcp') return
      try {
        const method = JSON.parse(request.postData() || '{}').method
        if (/^ops\.customer-delivery\./u.test(method) && !/\.(?:list|get)$/u.test(method)) uiWrites.push(method)
      } catch { /* Ignore non-JSON, never alter requests. */ }
    })
    for (const [index, label, checkboxes] of [[0, '客户档案', 0], [1, '系统接入', 10], [2, '功能测试及验收', 8]]) {
      await row.getByRole('button', { name: '未填写', exact: true }).nth(index).click()
      const drawer = page.getByRole('dialog').filter({ hasText: `${companyName} · ${label}` })
      await expect(drawer).toBeVisible()
      await expect(drawer.locator('form')).toHaveAttribute('aria-busy', 'false')
      await expect(drawer.locator('input[type=file]')).toHaveCount(0)
      await expect(drawer.getByRole('button', { name: '保存当前环节' })).toHaveCount(0)
      if (checkboxes) {
        await expect(drawer.getByRole('checkbox')).toHaveCount(checkboxes)
        for (const checkbox of await drawer.getByRole('checkbox').all()) await expect(checkbox).toBeDisabled()
      } else {
        // Ant Design includes its required marker in the accessible label.
        const companyInput = drawer.getByRole('textbox', { name: /^(?:\*\s*)?公司名称$/u })
        await expect(companyInput).toHaveValue(companyName)
        await expect(companyInput).toBeDisabled()
      }
      await drawer.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(drawer).not.toBeVisible()
    }
    await row.getByRole('button', { name: '凭证', exact: true }).click()
    await expect(page.getByText('培训凭证', { exact: true })).toBeVisible()
    await expect(page.locator('input[type=file]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '确认培训完成', exact: true })).toHaveCount(0)
    await row.getByRole('button', { name: '凭证', exact: true }).click()
    await row.getByRole('button', { name: '未上传', exact: true }).click()
    const videoDrawer = page.getByRole('dialog').filter({ hasText: `${companyName} · 交付视频` })
    await expect(videoDrawer.getByText('尚未登记交付视频', { exact: true })).toBeVisible()
    await expect(videoDrawer.locator('input[type=file]')).toHaveCount(0)
    await expect(videoDrawer.getByRole('button', { name: '保存当前环节' })).toHaveCount(0)
    await videoDrawer.getByRole('button', { name: '关闭', exact: true }).click()
    expect(uiWrites).toEqual([])

    // Direct requests must also fail at capability authorization, not merely
    // because a control is hidden or a missing asset happens to reject later.
    const bytes = Buffer.from('%PDF-1.4\nread-only negative probe\n%%EOF')
    for (const [method, params] of [
      ['ops.customer-delivery.create', { target_workspace_id: workspaceId, company_name: 'must not create' }],
      ['ops.customer-delivery.update', { ...scope, expected_revision: String(draft.revision), patch_json: JSON.stringify({ companyName: 'must not change' }) }],
      ['ops.customer-delivery.checklist-item.update', { ...scope, checklist_key: 'system_integration', item_key: 'plugin_account', completed: 'false', expected_revision: String(draft.revision) }],
      ['ops.customer-delivery.training.complete', { ...scope, completed: 'false', evidence_refs_json: '[]', expected_revision: String(draft.revision) }],
      ['ops.customer-delivery.videos.add', { ...scope, title: 'must not add', asset_ref: 'asset:read-only-negative' }],
      ['ops.customer-delivery.assets.upload', { ...scope, purpose: 'contract', name: 'negative.pdf', mime_type: 'application/pdf', content_base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }],
    ]) await rpc(method, params, 403)
    expect(await rpc('ops.customer-delivery.get', scope)).toEqual(before)

    const screenshot = join(evidenceDir, 'readonly-profile-shot-scraper.png')
    const storyboard = join(evidenceDir, 'readonly-storyboard.json')
    const rowSelector = `tr.ant-table-row:has-text(${JSON.stringify(companyName)})`
    await writeFile(storyboard, JSON.stringify({
      url: page.url(), output: join(evidenceDir, 'readonly-inspection.webm'), viewport: { width: 1440, height: 900 },
      javascript: `sessionStorage.setItem('ops_connection_config_v1', ${JSON.stringify(JSON.stringify({ apiBase: '/api', workspaceId, workbench: 'platform' }))}); sessionStorage.setItem('ops_workspace_id', ${JSON.stringify(workspaceId)}); sessionStorage.setItem('ops_workbench', 'platform');`,
      scenes: [{ name: 'Read-only operator opens the actual customer profile', open: page.url(), wait_for: '[aria-label="客户交付目标企业工作区"]', do: [
        { click: '[aria-label="客户交付目标企业工作区"]' },
        { wait_for: `.ant-select-item-option:has-text(${JSON.stringify(workspaceId)})` },
        { click: `.ant-select-item-option:has-text(${JSON.stringify(workspaceId)})` },
        { wait_for: rowSelector },
        { click: `:nth-match(${rowSelector} button:has-text("未填写"), 1)` },
        { wait_for: ':nth-match(.ant-drawer-body form[aria-busy="false"] input[disabled], 1)' },
        { pause: 0.5 },
        { screenshot },
      ] }],
    }), { mode: 0o600, flag: 'wx' })
    const installed = join(homedir(), '.local/bin/shot-scraper')
    const authState = await page.context().storageState()
    await new Promise((resolve, reject) => {
      const child = spawn(existsSync(installed) ? installed : 'shot-scraper', ['video', storyboard, '--auth', '/dev/stdin', '--browser', 'chrome', '--timeout', '30000'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 35_000 })
      let captureError = ''
      let diagnosticsOmitted = false
      child.stdout.resume()
      child.stderr.on('data', chunk => {
        if (diagnosticsOmitted) return
        captureError += String(chunk)
        // Never truncate a secret before redaction: discard oversized output
        // entirely so an incomplete cookie cannot survive the buffer boundary.
        if (captureError.length > 64_000) { captureError = ''; diagnosticsOmitted = true }
      })
      child.once('error', () => reject(new Error('DELIVERY_READONLY_CAPTURE_UNAVAILABLE')))
      child.once('exit', code => {
        if (code === 0) return resolve()
        // Diagnostics may include selector errors, but never persist the
        // authenticated browser state or cookie values supplied via stdin.
        for (const cookie of authState.cookies) {
          if (cookie.value) captureError = captureError.replaceAll(cookie.value, '[REDACTED]').replaceAll(encodeURIComponent(cookie.value), '[REDACTED]')
        }
        reject(new Error(`DELIVERY_READONLY_CAPTURE_FAILED: ${diagnosticsOmitted ? 'diagnostics exceeded safe limit' : captureError.slice(-8000)}`))
      })
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(authState))
    })
    await testInfo.attach('readonly-profile', { path: screenshot, contentType: 'image/png' })
    evidence.status = 'passed'
    evidence.detailsOpened = ['profile', 'system_integration', 'functional_acceptance', 'training', 'video']
    evidence.checklistControlsInspected = 18
    evidence.savedChecklistItems = 0
    evidence.mutationsDenied = 6
    evidence.uiMutations = 0
    evidence.draftUnchanged = true
  } finally {
    await writeFile(join(evidenceDir, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' })
  }
})
