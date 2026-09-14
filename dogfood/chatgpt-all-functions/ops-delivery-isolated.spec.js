import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

// This spec is intentionally runner-only. The managed runner supplies an
// isolated PG17/Redis/OIDC stack and refuses shared bearer fixtures.
const baseUrl = process.env.OPS_OIDC_BASE_URL
const workspaceId = process.env.OPS_E2E_WORKSPACE_ID
const outputDir = process.env.OPS_E2E_OUTPUT_DIR
const realDeliveryScan = process.env.OPS_E2E_REAL_DELIVERY_SCAN === 'true'
if (!baseUrl || !workspaceId || !outputDir) throw new Error('Run through scripts/run-ops-oidc-e2e.ts with OPS_OIDC_BASE_URL, OPS_E2E_WORKSPACE_ID and OPS_E2E_OUTPUT_DIR')
const origin = new URL(baseUrl)
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || !origin.port || origin.pathname !== '/') throw new Error('OPS_OIDC_BASE_URL must be an explicit loopback origin')

test.describe.configure({ mode: 'serial', retries: 0 })
test.use({ channel: 'chrome', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, trace: 'off', video: 'off', screenshot: 'off' })
test.setTimeout(realDeliveryScan ? 600_000 : 180_000)

// Self-contained, genuine media fixtures: one 16x16 black frame, no audio.
// These bytes are only sent to the isolated upload endpoint, never to evidence.
const tinyMp4 = Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMUbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAj90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG3bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABYm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAAg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABYoAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALFAAAAAQAAABRzdGNvAAAAAAAAAAEAAANEAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMQAAAAhmcmVlAAACzW1kYXQAAAKtBgX//6ncRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAABBliIQAFf/+98nvwKbr29+B', 'base64')
const tinyWebm = Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAH1EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggHf7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDFXQYxMYXZmNjMuMS4xMDFEiYhAj0AAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIYT3yctz/s1ycgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4Q7msoA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/5zc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAxc3PZY8CLY8WIYT3yctz/s1xnyKRFo4dFTkNPREVSRIeXTGF2YzYzLjEuMTAxIGxpYnZweC12cDlnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1peeBAKOggQAAgIJJg0IAAPAA9gA4JBwYSgAAMGAAABC///1IjAAcU7trkbuPs4EAt4r3gQHxggG18IED', 'base64')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function contractPdf(text = 'Isolated delivery contract fixture') {
  const stream = `BT /F1 12 Tf 36 72 Td (${text}) Tj ET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

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

async function uploadAndWaitForRealScan(page, dialog, deliveryId, purpose, files, evidence) {
  const cleanRefs = new Set()
  const observations = []
  const observationErrors = []
  const observe = response => {
    const payload = rpcPayload(response.request())
    if (payload?.method !== 'ops.customer-delivery.assets.get' || payload.params?.delivery_id !== deliveryId || payload.params?.purpose !== purpose) return
    observations.push((async () => {
      const body = parse(await response.text())
      const asset = body?.result ?? body?.data?.result
      evidence.events.push({ event: 'real_asset_scan', asset_ref: payload.params.asset_ref, scan_status: asset?.scanStatus ?? null, ready: asset?.ready ?? false, status: response.status() })
      expect(response.status()).toBe(200)
      if (asset?.scanStatus === 'clean' && asset.ready === true) cleanRefs.add(asset.assetRef)
    })().catch(error => { observationErrors.push(error) }))
  }
  page.on('response', observe)
  try {
    const uploads = files.map(file => {
      const hash = sha256(file.buffer)
      return page.waitForResponse(response => {
        const payload = rpcPayload(response.request())
        return payload?.method === 'ops.customer-delivery.assets.upload' && payload.params?.delivery_id === deliveryId && payload.params?.purpose === purpose && payload.params?.sha256 === hash
      }, { timeout: 240_000 }).then(async response => {
        const body = parse(await response.text())
        const asset = body?.result ?? body?.data?.result
        evidence.events.push({ event: 'real_asset_upload', sha256: hash, asset_ref: asset?.assetRef ?? null, scan_status: asset?.scanStatus ?? null, ready: asset?.ready ?? false, status: response.status() })
        expect(response.status()).toBe(200)
        expect(asset?.assetRef).toMatch(/^asset[:_]/u)
        expect(asset?.scanStatus).toBe('pending')
        expect(asset?.ready).toBe(false)
        return asset
      })
    })
    const exchanges = await Promise.all([...uploads, dialog.getByLabel(purpose === 'contract' ? '上传合同文件' : '上传交付视频', { exact: true }).setInputFiles(files)])
    const assets = exchanges.slice(0, -1)
    const refs = assets.map(asset => asset.assetRef)
    await expect(dialog.getByLabel(purpose === 'contract' ? '合同文件' : '交付视频（支持多段）', { exact: true })).toHaveValue(purpose === 'contract' ? refs[0] : refs.join('\n'), { timeout: 210_000 })
    await expect(dialog.getByRole('button', { name: '保存当前环节', exact: true })).toBeEnabled()
    await Promise.all(observations)
    if (observationErrors.length) throw observationErrors[0]
    for (const ref of refs) expect(cleanRefs.has(ref), 'the visible usable reference must have a real clean scanner response').toBe(true)
    return assets
  } finally {
    page.off('response', observe)
    await Promise.all(observations)
  }
}

async function registerRealVideoSegments(page, dialog, deliveryId, assets, evidence) {
  const responses = assets.map(asset => page.waitForResponse(response => {
    const payload = rpcPayload(response.request())
    return payload?.method === 'ops.customer-delivery.videos.add' && payload.params?.delivery_id === deliveryId && payload.params?.asset_ref === asset.assetRef
  }, { timeout: 45_000 }).then(async response => {
    const body = parse(await response.text())
    evidence.events.push({ event: 'real_video_registered', asset_ref: asset.assetRef, status: response.status(), error_code: body?.error?.code ?? body?.data?.error?.code ?? null })
    expect(response.status()).toBe(200)
    expect(body?.error ?? body?.data?.error).toBeFalsy()
  }))
  await Promise.all([...responses, dialog.getByRole('button', { name: '保存当前环节', exact: true }).click()])
  await expect(dialog.getByRole('button', { name: '保存当前环节', exact: true })).not.toHaveClass(/ant-btn-loading/u)
  await expect(dialog.getByText('已登记视频（2 段）', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('交付视频（支持多段）')).toHaveValue('')
}

async function verifyCleanContractReuse(page, targetWorkspaceId, file, assetRef, company, evidence) {
  let requestNumber = 0
  const hash = sha256(file.buffer)
  const call = async (method, params) => {
    // The context request shares the current signed OIDC cookie jar. No bearer,
    // copied credentials, or mocked repository is introduced for this PG check.
    let response
    try {
      response = await page.request.post(new URL('/api/mcp', origin).toString(), {
        headers: { 'content-type': 'application/json', 'x-ops-workbench': 'platform' },
        data: { jsonrpc: '2.0', id: `clean-contract-reuse-${++requestNumber}`, method, params },
        timeout: 45_000,
      })
    } catch { throw new Error('CLEAN_CONTRACT_REUSE_API_REQUEST_FAILED') }
    const body = parse(await response.text())
    const result = body?.result ?? body?.data?.result
    const error = body?.error ?? body?.data?.error
    evidence.events.push({ event: 'clean_contract_reuse_rpc', method, delivery_id: params.delivery_id ?? result?.id ?? null, sha256: hash, asset_ref: result?.assetRef ?? null, scan_status: result?.scanStatus ?? null, ready: result?.ready ?? null, status: response.status(), error_code: error?.code ?? null })
    expect(response.status(), `${method} clean reuse status`).toBe(200)
    expect(error?.code, `${method} clean reuse error code`).toBeUndefined()
    return result
  }
  const deliveryIds = []
  for (let index = 1; index <= 3; index++) {
    const created = await call('ops.customer-delivery.create', { target_workspace_id: targetWorkspaceId, company_name: `${company}-clean-reuse-${index}` })
    expect(typeof created?.id).toBe('string')
    deliveryIds.push(created.id)
    const uploaded = await call('ops.customer-delivery.assets.upload', {
      target_workspace_id: targetWorkspaceId, delivery_id: created.id, purpose: 'contract',
      name: file.name, mime_type: file.mimeType, content_base64: file.buffer.toString('base64'), sha256: hash,
    })
    expect(uploaded?.assetRef).toBe(assetRef)
    expect(uploaded?.scanStatus).toBe('clean')
    expect(uploaded?.ready).toBe(true)
  }
  expect(new Set(deliveryIds).size).toBe(3)
  // Re-read all three after the last bind to catch overwritten earlier bindings,
  // not just the historical third-bind revision/outbox collision.
  for (const deliveryId of deliveryIds) {
    const bound = await call('ops.customer-delivery.assets.get', { target_workspace_id: targetWorkspaceId, delivery_id: deliveryId, purpose: 'contract', asset_ref: assetRef })
    expect(bound?.assetRef).toBe(assetRef)
    expect(bound?.scanStatus).toBe('clean')
    expect(bound?.ready).toBe(true)
  }
}

async function verifyClosedUploadCannotFillAnotherCustomer(page, deliveryId, originalRow, originalContractRef, secondCompany, evidence) {
  let releaseResponse
  const heldResponse = new Promise(resolve => { releaseResponse = resolve })
  let scanFinished
  const scanSettled = new Promise(resolve => { scanFinished = resolve })
  let scanFailure
  let intercepted = false
  // Only delay the real GET response to exercise a late network completion.
  // No scanner result is fabricated, and no write is cancelled/rolled back here.
  const holdScan = async route => {
    const payload = rpcPayload(route.request())
    if (intercepted || payload?.method !== 'ops.customer-delivery.assets.get' || payload.params?.delivery_id !== deliveryId || payload.params?.purpose !== 'contract') { await route.continue(); return }
    intercepted = true
    try {
      let response
      await expect.poll(async () => {
        response = await route.fetch({ timeout: 30_000 })
        const body = await response.json()
        const asset = body?.result ?? body?.data?.result
        evidence.events.push({ event: 'cancelled_upload_real_scan', asset_ref: payload.params.asset_ref, scan_status: asset?.scanStatus ?? null, ready: asset?.ready ?? false, status: response.status() })
        return response.status() === 200 && asset?.scanStatus === 'clean' && asset.ready === true
      }, { timeout: 180_000, intervals: [1000, 2000] }).toBe(true)
      await heldResponse
      // Closing the drawer aborts its browser request, so Chromium may already
      // have discarded this response. The server-side asset remains audited.
      await route.fulfill({ response }).catch(() => undefined)
    } catch (error) { scanFailure = error }
    finally { scanFinished() }
  }
  await page.route('**/api/mcp', holdScan)
  try {
    const file = { name: 'cancelled-contract.pdf', mimeType: 'application/pdf', buffer: contractPdf('Cancelled drawer upload fixture') }
    const uploaded = await rpcAfter(page, 'ops.customer-delivery.assets.upload', () => page.getByRole('dialog').getByLabel('上传合同文件', { exact: true }).setInputFiles(file), evidence)
    evidence.events.push({ event: 'cancelled_upload_received_by_server', sha256: sha256(file.buffer), asset_ref: uploaded.result?.assetRef ?? null, scan_status: uploaded.result?.scanStatus ?? null, status: 200 })
    expect(uploaded.result?.scanStatus).toBe('pending')
    await expect(page.getByRole('dialog').getByText('安全检查中', { exact: true })).toBeVisible()
    await expect.poll(() => intercepted, { timeout: 15_000 }).toBe(true)
    await closeDrawer(page)
    await originalRow.locator('td').nth(2).getByRole('button').click()
    await expect(page.getByRole('dialog').getByLabel('合同文件', { exact: true })).toHaveValue(originalContractRef)
    releaseResponse()
    await scanSettled
    if (scanFailure) throw scanFailure
    await expect(page.getByRole('dialog').getByLabel('合同文件', { exact: true })).toHaveValue(originalContractRef)
    await closeDrawer(page)
    await page.getByRole('row').filter({ hasText: secondCompany }).locator('td').nth(2).getByRole('button').click()
    await expect(page.getByRole('dialog').getByLabel('合同文件', { exact: true })).toHaveValue('')
    evidence.events.push({ event: 'pending_upload_closed_and_switched_without_form_pollution', asset_ref: uploaded.result?.assetRef ?? null, server_asset_may_persist: true, delivery_profile_saved: false })
  } finally {
    releaseResponse()
    await page.unroute('**/api/mcp', holdScan)
    if (intercepted) await scanSettled
  }
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
  const videoButtonSelector = 'tbody tr[data-row-key] td:nth-child(7) button'
  await expect(page.locator(videoButtonSelector)).toHaveCount(1)
  const url = new URL('/ops/customer-delivery?workbench=platform', origin).toString()
  const screenshotPath = join(evidenceDir, 'training-confirmed-shot-scraper.png')
  const videoRegistrationPath = join(evidenceDir, 'video-registration-shot-scraper.png')
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
        { click: videoButtonSelector },
        { wait_for: '.ant-drawer-body textarea' },
        { pause: 1 },
        { screenshot: videoRegistrationPath },
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
  await testInfo.attach('video-registration-shot-scraper', { path: videoRegistrationPath, contentType: 'image/png' })
  await testInfo.attach('training-inline-video', { path: videoPath, contentType: 'video/webm' })
}

test('isolated customer delivery end-to-end fields, gates, checklists and scanned assets', async ({ page }, testInfo) => {
  page.setDefaultTimeout(15_000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.name))
  const evidenceDir = join(outputDir, `delivery-${Date.now()}`)
  await mkdir(evidenceDir, { recursive: true })
  const evidence = { schema_version: 1, evidence_kind: 'isolated_live_customer_delivery_ui_rpc', raw_browser_trace_saved: false, real_delivery_scan: realDeliveryScan, viewport: { width: 1440, height: 900 }, timezone: 'Asia/Shanghai', fixture: { workspace_id: workspaceId }, events: [] }
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
    const created = await rpcAfter(page, 'ops.customer-delivery.create', () => page.getByRole('button', { name: /创\s*建/u }).click(), evidence)
    const deliveryId = created.result?.id
    expect(typeof deliveryId).toBe('string')
    const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: company, exact: true }) })
    await expect(row).toBeVisible()
    await screenshot('customer-created')

    // Profile is fillable while unpaid, but controlled delivery steps are not.
    const profile = page.getByRole('dialog')
    await profile.getByLabel('合同编号').fill(`C-${Date.now()}`)
    await profile.getByLabel('合同文件', { exact: true }).fill('asset_ref_missing_contract')
    await profile.getByLabel('项目负责人').fill('隔离项目负责人')
    await profile.getByLabel('售后负责人').fill('隔离售后负责人')
    await profile.getByLabel('要求上线时间').fill('2026-10-01T09:00')
    const rejectedContract = await rpcAfter(page, 'ops.customer-delivery.update', () => profile.getByRole('button', { name: '保存当前环节', exact: true }).click(), evidence, 409)
    expect(rejectedContract.error?.code).toBe('CUSTOMER_DELIVERY_CONTRACT_ASSET_NOT_READY')
    await expect(profile).toBeVisible()
    await expect(row.locator('td').nth(2)).toContainText('未填写')
    await screenshot('missing-contract-rejected')
    let savedContractRef = 'https://example.com/delivery-contract.pdf'
    const savedContractFile = { name: 'delivery-contract.pdf', mimeType: 'application/pdf', buffer: contractPdf() }
    if (realDeliveryScan) {
      await profile.getByLabel('合同文件', { exact: true }).fill('')
      const [contract] = await uploadAndWaitForRealScan(page, profile, deliveryId, 'contract', [savedContractFile], evidence)
      savedContractRef = contract.assetRef
      await screenshot('real-contract-scan-ready')
    } else await profile.getByLabel('合同文件', { exact: true }).fill(savedContractRef)
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
    const refreshedRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: company, exact: true }) })
    await expect(refreshedRow).toBeVisible()
    await refreshedRow.locator('td').nth(2).getByRole('button').click()
    await expect(page.getByRole('dialog').getByLabel('付款日期')).toHaveValue('2026-09-14')
    await expect(page.getByRole('dialog').getByLabel('要求上线时间')).toHaveValue('2026-10-01T09:00')
    await expect(page.getByRole('dialog').getByLabel('合同文件', { exact: true })).toHaveValue(savedContractRef)
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

    // A nonexistent/unscanned reference must remain blocked even when the real
    // scanner is enabled; success must come from uploaded file bytes instead.
    await refreshedRow.getByRole('button', { name: /未上传|\d+ 段/u }).click()
    const videoDialog = page.getByRole('dialog')
    await expect(videoDialog.getByRole('button', { name: '选择视频（需安全上传）', exact: true })).toHaveCount(0)
    await videoDialog.getByLabel('交付视频（支持多段）').fill('asset_ref_not_scanned')
    const rejected = await rpcAfter(page, 'ops.customer-delivery.videos.add', () => videoDialog.getByRole('button', { name: '保存当前环节', exact: true }).click(), evidence, 409)
    expect(rejected.error?.code).toBe('CUSTOMER_DELIVERY_VIDEO_ASSET_NOT_READY')
    await expect(videoDialog.getByText('尚未登记交付视频', { exact: true })).toBeVisible()
    await expect(refreshedRow).not.toContainText('交付已完成')
    await expect(refreshedRow).not.toContainText('已生效')
    await screenshot('customer-delivery-gates')
    if (realDeliveryScan) {
      await expect(videoDialog.getByRole('button', { name: '保存当前环节', exact: true })).not.toHaveClass(/ant-btn-loading/u)
      await videoDialog.getByLabel('交付视频（支持多段）').fill('')
      expect(sha256(tinyMp4)).not.toBe(sha256(tinyWebm))
      const assets = await uploadAndWaitForRealScan(page, videoDialog, deliveryId, 'video', [
        { name: 'delivery-first.mp4', mimeType: 'video/mp4', buffer: tinyMp4 },
        { name: 'delivery-second.webm', mimeType: 'video/webm', buffer: tinyWebm },
      ], evidence)
      expect(new Set(assets.map(asset => asset.assetRef)).size).toBe(2)
      await screenshot('real-videos-scan-ready')
      await registerRealVideoSegments(page, videoDialog, deliveryId, assets, evidence)
      await closeDrawer(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(refreshedRow).toBeVisible({ timeout: 30_000 })
      await expect(refreshedRow).toContainText('交付已完成')
      await refreshedRow.getByRole('button', { name: '2 段', exact: true }).click()
      await expect(page.getByRole('dialog').getByText('已登记视频（2 段）', { exact: true })).toBeVisible()
      for (const asset of assets) await expect(page.getByRole('dialog').getByText(asset.assetRef, { exact: true })).toBeVisible()
      await screenshot('real-video-segments-reloaded')
      evidence.events.push({ event: 'real_contract_and_two_videos_persisted', delivery_id: deliveryId, asset_refs: [savedContractRef, ...assets.map(asset => asset.assetRef)], points_granted: false })
    }
    await captureTrainingInteraction(page, evidenceDir, testInfo)
    await closeDrawer(page)
    await page.getByRole('button', { name: '新建客户', exact: true }).click()
    const secondCompany = `${company}-second`
    await page.getByRole('textbox', { name: /公司名称/u }).fill(secondCompany)
    const secondCreated = await rpcAfter(page, 'ops.customer-delivery.create', () => page.getByRole('button', { name: /创\s*建/u }).click(), evidence)
    const newProfile = page.getByRole('dialog')
    for (const label of ['合同编号', '合同文件', '项目负责人', '售后负责人', '付款日期', '要求上线时间']) {
      await expect(newProfile.getByLabel(label, { exact: true })).toHaveValue('')
    }
    evidence.events.push({ event: 'new_customer_has_no_previous_profile_fields' })
    if (realDeliveryScan) {
      await verifyClosedUploadCannotFillAnotherCustomer(page, secondCreated.result.id, refreshedRow, savedContractRef, secondCompany, evidence)
      await screenshot('cancelled-upload-does-not-populate-new-customer')
      await verifyCleanContractReuse(page, created.payload.params.target_workspace_id, savedContractFile, savedContractRef, company, evidence)
    }
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
