import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'

// Runner-only: no shared session, browser routes, simulated scanner or receipt.
const baseUrl = process.env.OPS_OIDC_BASE_URL
const workspaceId = process.env.OPS_E2E_WORKSPACE_ID
const outputDir = process.env.OPS_E2E_OUTPUT_DIR
if (!baseUrl || !workspaceId || !outputDir || process.env.OPS_E2E_REAL_DELIVERY_SCAN !== 'true') throw new Error('CONTRACT_LINK_REAL_ISOLATED_RUNNER_REQUIRED')
const origin = new URL(baseUrl)
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) throw new Error('CONTRACT_LINK_LOOPBACK_ORIGIN_REQUIRED')
const publicPdf = { url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', sha256: '3df79d34abbca99308e79cb94461c1893582604d68329a41fd4bec1885e6adb4', sizeBytes: 13264 }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const checklistKeys = {
  system_integration: ['插件账号', '店铺连接', '商品扫描', '知识库', '平台规则', '创意点数', '企业信息', '品牌资产', '商品资料', '客户偏好'],
  functional_acceptance: ['文案生成', '图片生成', '标注编辑', '自动检查', '视频生成', '店铺/商品读取', '技术验收', '内容验收'],
}
test.describe.configure({ mode: 'serial', retries: 0 })
test.use({ channel: 'chrome', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, trace: 'off', video: 'off', screenshot: 'off' })
test.setTimeout(600_000)

// Existing genuine fixture media: one black 16x16 frame, no audio.
const tinyMp4 = Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMUbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAj90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG3bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABYm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAAg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABYoAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALFAAAAAQAAABRzdGNvAAAAAAAAAAEAAANEAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMQAAAAhmcmVlAAACzW1kYXQAAAKtBgX//6ncRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAABBliIQAFf/+98nvwKbr29+B', 'base64')
const tinyWebm = Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAH1EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggHf7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDFXQYxMYXZmNjMuMS4xMDFEiYhAj0AAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIYT3yctz/s1ycgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4Q7msoA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/5zc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAxc3PZY8CLY8WIYT3yctz/s1xnyKRFo4dFTkNPREVSRIeXTGF2YzYzLjEuMTAxIGxpYnZweC12cDlnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1peeBAKOggQAAgIJJg0IAAPAA9gA4JBwYSgAAMGAAABC///1IjAAcU7trkbuPs4EAt4r3gQHxggG18IED', 'base64')
function syntheticPaymentPdf(text = 'ISOLATED FIXTURE ONLY - NOT A PROVIDER PAYMENT') {
  const stream = `BT /F1 12 Tf 20 72 Td (${text}) Tj ET\n`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let pdf = '%PDF-1.4\n'; const offsets = []
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(pdf)
  return Buffer.from(`${pdf}xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}

async function captureImport(page, directory, testInfo, deliveryId) {
  if (!/^[a-z0-9_-]+$/iu.test(deliveryId)) throw new Error('CONTRACT_LINK_SELECTOR_ID_INVALID')
  const profileButton = `tbody tr[data-row-key="${deliveryId}"] td:nth-child(3) button`
  const workspaceOption = `.ant-select-dropdown:visible .ant-select-item-option:has-text(${JSON.stringify(workspaceId)})`
  const url = new URL('/ops/customer-delivery?workbench=platform', origin).toString()
  const files = ['contract-pending.png', 'contract-clean.png', 'contract-saved.png', 'contract-reread.png', 'contract-import.webm']
  const storyboard = join(directory, 'contract-storyboard.json')
  const saveButton = '.ant-drawer-body form button[type="submit"]:not(:disabled):not(.ant-btn-loading)'
  // Only UI preferences enter the storyboard. Auth cookies are ephemeral stdin,
  // never persisted; shot-scraper makes real clicks with unmodified networking.
  await writeFile(storyboard, JSON.stringify({ url, output: join(directory, files[4]), viewport: { width: 1440, height: 900 },
    javascript: `sessionStorage.setItem('ops_connection_config_v1', ${JSON.stringify(JSON.stringify({ apiBase: '/api', workspaceId, workbench: 'platform' }))}); sessionStorage.setItem('ops_workspace_id', ${JSON.stringify(workspaceId)}); sessionStorage.setItem('ops_workbench', 'platform');`,
    scenes: [{ name: 'Public contract URL to genuine scanned and persisted asset', open: url, wait_for: '[aria-label="客户交付目标企业工作区"]', do: [
      { click: '[aria-label="客户交付目标企业工作区"]' }, { wait_for: workspaceOption }, { click: workspaceOption },
      { wait_for: profileButton }, { click: profileButton }, { wait_for: '#contractNo:not(:disabled)' }, { pause: 0.4 },
      { fill: { into: '#contractNo', text: 'FIXTURE-PUBLIC-CONTRACT' } }, { fill: { into: '#owner', text: '隔离项目负责人' } },
      { fill: { into: '#afterSalesOwner', text: '隔离售后负责人' } }, { fill: { into: '#requiredLaunchAt', text: '2026-10-01T09:00' } },
      { click: '.ant-radio-button-wrapper:has-text("链接导入")' }, { fill: { into: '.ant-drawer-body input[type="url"]', text: publicPdf.url } },
      { click: '.ant-drawer-body button:has-text("导入并检查")' },
      { wait_for: '.ant-drawer-body [role="status"]:has-text("安全检查中")' }, { screenshot: join(directory, files[0]) },
      { wait_for: '.ant-drawer-body [role="status"] .ant-tag-success:has-text("可使用")' }, { screenshot: join(directory, files[1]) },
      { click: saveButton }, { wait_for: '.ant-message-success:has-text("已保存")' }, { screenshot: join(directory, files[2]) },
      { wait_for: saveButton }, { click: '.ant-drawer-close' }, { wait_for: profileButton }, { click: profileButton },
      { wait_for: '#contractFile[value^="asset"]:not(:disabled)' }, { scroll: { to: '#contractFile', duration: 0.3 } }, { pause: 0.4 }, { screenshot: join(directory, files[3]) },
    ] }],
  }), { mode: 0o600, flag: 'wx' })
  const local = join(homedir(), '.local/bin/shot-scraper')
  const authState = await page.context().storageState()
  await new Promise((resolve, reject) => {
    const child = spawn(existsSync(local) ? local : 'shot-scraper', ['video', storyboard, '--auth', '/dev/stdin', '--browser', 'chrome', '--timeout', '210000'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 270_000 })
    child.stdout.resume(); child.stderr.resume()
    child.once('error', () => reject(new Error('CONTRACT_LINK_SHOT_SCRAPER_UNAVAILABLE')))
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('CONTRACT_LINK_SHOT_SCRAPER_FAILED')))
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(authState))
  })
  for (const file of files) { expect((await stat(join(directory, file))).size).toBeGreaterThan(0); await testInfo.attach(file, { path: join(directory, file), contentType: file.endsWith('.png') ? 'image/png' : 'video/webm' }) }
  return files
}

test('public HTTPS contract import persists only a genuinely scanned asset', async ({ page }, testInfo) => {
  const directory = join(outputDir, 'contract-link'); await mkdir(directory, { mode: 0o700 })
  const report = { status: 'failed', startedAt: new Date().toISOString(), workspaceId, publicPdf, events: [], scope: 'contract URL UI/API/real ClamAV/PG binding; seven synthetic fixture attachments satisfy collector only', syntheticPaymentIsNotProviderEvidence: true, syntheticChecklistsAreNotLiveIntegrationEvidence: true, realCustomerAccountOrCommercialSuccessClaimed: false, modelOrPaymentProviderCalls: false, browserMocks: false }
  let stage = 'real-login-and-create'
  const rpc = async (method, params, expectedStatus = 200, expectedCode) => {
    const id = `contract-link-${report.events.length}-${Date.now()}`
    const response = await page.request.post(new URL('/api/mcp', origin).toString(), { headers: { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'platform' }, data: { jsonrpc: '2.0', id, method, params }, timeout: 120_000 })
    const body = await response.json(), envelope = body.data ?? body
    const code = envelope.error?.code ?? null
    report.events.push({ method, id, status: response.status(), code })
    expect(response.status(), method).toBe(expectedStatus)
    // Legacy HTTP failure envelopes do not carry a JSON-RPC id. This response
    // is already bound to this exact page.request; never invent a response id.
    if (expectedStatus === 200 || envelope.id !== undefined) expect(envelope.id).toBe(id)
    if (expectedCode) expect(code).toBe(expectedCode)
    else expect(envelope.error).toBeUndefined()
    return envelope.result
  }
  const upload = async (deliveryId, purpose, name, mimeType, bytes) => {
    const params = { target_workspace_id: workspaceId, delivery_id: deliveryId, purpose }
    let asset = await rpc('ops.customer-delivery.assets.upload', { ...params, name, mime_type: mimeType, content_base64: bytes.toString('base64'), sha256: sha(bytes) })
    expect(asset.scanStatus).toBe('pending'); expect(asset.ready).toBe(false)
    const assetRef = asset.assetRef, deadline = Date.now() + 180_000
    while (!asset.ready && Date.now() < deadline) { await new Promise(done => setTimeout(done, 2000)); asset = await rpc('ops.customer-delivery.assets.get', { ...params, asset_ref: assetRef }); expect(['pending', 'clean']).toContain(asset.scanStatus) }
    expect(asset.ready).toBe(true); expect(asset.scanStatus).toBe('clean'); expect(asset.assetRef).toBe(assetRef)
    return { purpose, assetRef, sha256: sha(bytes), sizeBytes: bytes.length, mimeType, observedPending: true, observedClean: true }
  }
  try {
    await openPlatformConsole(page, '/ops/customer-delivery?workbench=platform')
    await page.getByRole('combobox', { name: '客户交付目标企业工作区' }).click()
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: workspaceId }).click()
    const company = `隔离合同链接验收-${Date.now()}`
    await page.getByRole('button', { name: '新建客户', exact: true }).click()
    await page.getByRole('textbox', { name: /公司名称/u }).fill(company)
    await page.getByRole('button', { name: /创\s*建/u }).click()
    await expect(page.getByRole('dialog', { name: `${company} · 客户档案` })).toBeVisible()
    const records = await rpc('ops.customer-delivery.list', { target_workspace_id: workspaceId })
    const matches = records.items.filter(record => record.companyName === company); expect(matches).toHaveLength(1)
    const deliveryId = matches[0].id; report.deliveryId = deliveryId
    await page.locator('.ant-drawer-close').click()
    stage = 'shot-scraper-real-import-scan-save-reread'
    report.visualEvidence = await captureImport(page, directory, testInfo, deliveryId)
    stage = 'same-session-api-reread-and-adversarial-probes'
    const scope = { target_workspace_id: workspaceId, delivery_id: deliveryId }
    let record = await rpc('ops.customer-delivery.get', scope)
    expect(record.contractRef).toMatch(/^asset[:_]/u); expect(record.customerProfileStatus).toBe('complete')
    expect(record.contractNumber).toBe('FIXTURE-PUBLIC-CONTRACT'); expect(record.projectOwner).toBe('隔离项目负责人')
    const contract = await rpc('ops.customer-delivery.assets.get', { ...scope, purpose: 'contract', asset_ref: record.contractRef })
    expect(contract.ready).toBe(true); expect(contract.scanStatus).toBe('clean'); expect(contract.sizeBytes).toBe(publicPdf.sizeBytes)
    // The public API view deliberately omits SHA256; the owner collector must
    // compare persisted downloaded bytes against the independently pinned hash.
    report.contract = { assetRef: record.contractRef, expectedSha256: publicPdf.sha256, sizeBytes: contract.sizeBytes, mimeType: contract.mimeType }
    await rpc('ops.customer-delivery.update', { ...scope, expected_revision: String(record.revision), patch_json: JSON.stringify({ contractRef: publicPdf.url }) }, 400, 'INVALID_REQUEST')
    expect(await rpc('ops.customer-delivery.get', scope)).toEqual(record)
    await rpc('ops.customer-delivery.assets.upload', { ...scope, purpose: 'contract', source_url: 'https://127.0.0.1/blocked.pdf' }, 400, 'CUSTOMER_DELIVERY_CONTRACT_URL_BLOCKED')
    expect(await rpc('ops.customer-delivery.get', scope)).toEqual(record)
    report.rejectedRawUrlWithoutMutation = true; report.blockedLoopbackWithoutMutation = true
    stage = 'real-synthetic-payment-and-two-video-prerequisites'
    report.payment = await upload(deliveryId, 'payment', 'synthetic-not-provider-payment.pdf', 'application/pdf', syntheticPaymentPdf())
    record = await rpc('ops.customer-delivery.update', { ...scope, expected_revision: String(record.revision), patch_json: JSON.stringify({ paymentStatus: 'paid', paymentDate: '2026-09-15', paymentEvidenceRefs: [report.payment.assetRef] }) })
    report.videos = []
    for (const [index, file] of [{ name: 'fixture-first.mp4', mime: 'video/mp4', bytes: tinyMp4 }, { name: 'fixture-second.webm', mime: 'video/webm', bytes: tinyWebm }].entries()) {
      const asset = await upload(deliveryId, 'video', file.name, file.mime, file.bytes)
      await rpc('ops.customer-delivery.videos.add', { ...scope, title: `隔离样例视频 ${index + 1}`, asset_ref: asset.assetRef, sort_order: String(index + 1) }); report.videos.push(asset)
    }
    const videos = await rpc('ops.customer-delivery.videos.list', scope); expect(videos.items).toHaveLength(2)
    stage = 'synthetic-seven-attachment-collector-prerequisites'
    report.checklists = []
    // These are explicit isolated form-state fixtures, NOT claims that real
    // accounts, shop connections, points or model generation were exercised.
    for (const purpose of ['system_integration', 'functional_acceptance']) {
      const proof = await upload(deliveryId, purpose, `synthetic-${purpose}.pdf`, 'application/pdf', syntheticPaymentPdf(`ISOLATED ${purpose.toUpperCase()} FORM FIXTURE ONLY`))
      const initial = await rpc('ops.customer-delivery.checklist-items.list', { ...scope, checklist_key: purpose })
      // New deliveries do not seed checklist rows; the authorized batch below
      // must create every required item, not merely toggle pre-existing rows.
      expect(initial.items).toEqual([])
      const items = checklistKeys[purpose].map(itemKey => ({ itemKey, completed: true,
        evidence: { asset_refs: [proof.assetRef], note: 'SYNTHETIC FIXTURE ONLY: no real account, shop, points or model execution verified' } }))
      record = await rpc('ops.customer-delivery.get', scope)
      await rpc('ops.customer-delivery.checklist.update', { ...scope, checklist_key: purpose, expected_revision: String(record.revision), items_json: JSON.stringify(items) })
      const reread = await rpc('ops.customer-delivery.checklist-items.list', { ...scope, checklist_key: purpose })
      expect(reread.items).toHaveLength(items.length)
      for (const item of items) expect(reread.items.find(saved => saved.itemKey === item.itemKey)).toMatchObject(item)
      report.checklists.push({ ...proof, itemKeys: checklistKeys[purpose], itemCount: items.length, allPersisted: true, syntheticOnly: true })
    }
    report.training = await upload(deliveryId, 'training', 'synthetic-training.pdf', 'application/pdf', syntheticPaymentPdf('ISOLATED TRAINING FORM FIXTURE - NO REAL CUSTOMER TRAINING'))
    record = await rpc('ops.customer-delivery.get', scope)
    await rpc('ops.customer-delivery.training.complete', { ...scope, expected_revision: String(record.revision), completed: 'true', evidence_refs_json: JSON.stringify([report.training.assetRef]) })
    record = await rpc('ops.customer-delivery.get', scope)
    expect(record.contractRef).toBe(report.contract.assetRef); expect(record.systemIntegrationStatus).toBe('complete'); expect(record.functionalAcceptanceStatus).toBe('complete')
    expect(record.trainingCompleted).toBe(true); expect(record.trainingEvidenceRefs).toEqual([report.training.assetRef])
    expect(typeof record.effectiveAt).toBe('string'); expect(Number.isFinite(Date.parse(record.effectiveAt))).toBe(true)
    expect(new Set([publicPdf.sha256, report.payment.sha256, report.training.sha256, ...[...report.videos, ...report.checklists].map(asset => asset.sha256)]).size).toBe(7)
    stage = 'complete'; Object.assign(report, { status: 'passed', finalRevision: record.revision, fixtureEffectiveAt: record.effectiveAt })
  } finally { await writeFile(join(directory, 'browser-result.json'), JSON.stringify({ ...report, stage, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600, flag: 'wx' }) }
})
