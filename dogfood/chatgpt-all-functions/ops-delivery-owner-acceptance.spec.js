import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { openWorkspaceConsole } from './ops-auth.js'

// Owner-owned acceptance snapshot: browser response evidence uses exact RPC ids.
// This spec is intentionally runner-only. The managed runner supplies an
// isolated PG17/Redis/OIDC stack and refuses shared bearer fixtures.
const baseUrl = process.env.OPS_BASE_URL
const workspaceId = process.env.OPS_E2E_WORKSPACE_ID
const outputDir = process.env.OPS_E2E_OUTPUT_DIR
const realDeliveryScan = process.env.OPS_E2E_REAL_DELIVERY_SCAN === 'true'
if (!baseUrl || !workspaceId || !outputDir) throw new Error('Run through scripts/run-ops-password-e2e.ts with OPS_BASE_URL, OPS_E2E_WORKSPACE_ID and OPS_E2E_OUTPUT_DIR')
const origin = new URL(baseUrl)
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || !origin.port || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) throw new Error('OPS_BASE_URL must be an explicit loopback origin')

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
  const keys = ['target_workspace_id', 'delivery_id', 'purpose', 'checklist_key', 'expected_revision', 'completed', 'company_name', 'payment_status', 'payment_date', 'planned_go_live_at', 'sort_order']
  return Object.fromEntries(keys.filter(key => Object.prototype.hasOwnProperty.call(params, key)).map(key => [key, params[key]]))
}

// Capture the original browser fetch response inside its own document. Chromium
// may discard Network.getResponseBody data before Playwright reads it, especially
// with concurrent scan polling. We never replace a response or persist request
// bodies, headers, cookies, credentials, or uploaded base64 in this ledger.
function installOwnerRpcCapture({ expectedOrigin }) {
  if (location.origin !== expectedOrigin || window.__ownerDeliveryRpcCaptureVersion === 1) return
  window.__ownerDeliveryRpcCaptureVersion = 1
  window.__ownerDeliveryRpcCaptures = []
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (...args) => {
    const [input, init] = args
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
    const httpMethod = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (url.origin !== expectedOrigin || url.pathname !== '/api/mcp' || httpMethod !== 'POST') return originalFetch(...args)
    const requestText = typeof init?.body === 'string' ? init.body
      : input instanceof Request && init?.body === undefined ? await input.clone().text() : null
    if (requestText === null) throw new Error('OWNER_RPC_REQUEST_BODY_UNREADABLE')
    let payload
    try { payload = JSON.parse(requestText) }
    catch { throw new Error('OWNER_RPC_REQUEST_JSON_INVALID') }
    if (typeof payload?.method !== 'string' || !payload.method.startsWith('ops.customer-delivery.')) return originalFetch(...args)
    if (!((typeof payload.id === 'string' && payload.id.length > 0) || (typeof payload.id === 'number' && Number.isFinite(payload.id)))) throw new Error('OWNER_RPC_REQUEST_ID_REQUIRED')
    const captured = { rpcId: payload.id, method: payload.method, status: null, state: 'pending', expectedAbort: false }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    window.__ownerDeliveryRpcCaptures.push(captured)
    let response
    try { response = await originalFetch(...args) }
    catch (error) {
      captured.state = error?.name === 'AbortError' || signal?.aborted ? 'aborted' : 'failed'
      captured.failure = captured.state === 'aborted' ? 'OWNER_RPC_REQUEST_ABORTED' : 'OWNER_RPC_NETWORK_FAILED'
      throw error // Keep the application's real fetch rejection and cancellation.
    }
    captured.status = response.status
    let copy
    try { copy = response.clone() }
    catch {
      captured.state = 'failed'
      captured.failure = 'OWNER_RPC_RESPONSE_CLONE_FAILED'
      return response // The evidence reader fails explicitly; the app keeps its response.
    }
    // Start reading the clone synchronously, but do not delay delivery of the
    // original response to the application. Both failure callbacks record a
    // hard evidence failure; none is converted to an empty/successful result.
    void copy.json().then(body => {
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        captured.state = 'failed'
        captured.failure = 'OWNER_RPC_RESPONSE_JSON_OBJECT_REQUIRED'
        return
      }
      captured.body = body
      captured.state = 'complete'
    }, error => {
      captured.state = error?.name === 'AbortError' || signal?.aborted ? 'aborted' : 'failed'
      captured.failure = captured.state === 'aborted' ? 'OWNER_RPC_RESPONSE_ABORTED' : 'OWNER_RPC_RESPONSE_JSON_UNREADABLE'
    })
    return response
  }
}

async function captureBrowserRpcResponse(page, response) {
  const payload = rpcPayload(response.request())
  if (!payload || typeof payload.method !== 'string' || !((typeof payload.id === 'string' && payload.id.length > 0) || (typeof payload.id === 'number' && Number.isFinite(payload.id)))) throw new Error('OWNER_RPC_BROWSER_REQUEST_ID_REQUIRED')
  const handle = await page.waitForFunction(({ rpcId, method }) => {
    const matches = window.__ownerDeliveryRpcCaptures?.filter(item => item.rpcId === rpcId && item.method === method) ?? []
    if (matches.length > 1) return { failure: 'OWNER_RPC_CAPTURE_DUPLICATE_REQUEST_ID' }
    const captured = matches[0]
    if (!captured || captured.state === 'pending') return false
    if (captured.state !== 'complete') return { failure: captured.failure ?? 'OWNER_RPC_CAPTURE_NOT_COMPLETE' }
    return { captured }
  }, { rpcId: payload.id, method: payload.method }, { timeout: 45_000 })
  let result
  try { result = await handle.jsonValue() }
  finally { await handle.dispose() }
  if (result.failure) throw new Error(result.failure)
  const captured = result.captured
  expect(captured.rpcId, 'captured JSON-RPC id must match the actual browser request').toBe(payload.id)
  expect(captured.method, 'captured method must match the actual browser request').toBe(payload.method)
  expect(captured.status, 'captured HTTP status must match the same browser response').toBe(response.status())
  const envelope = captured.body?.data ?? captured.body
  // Successful custom MCP envelopes echo the JSON-RPC id. Transport-level
  // errors may omit it; they are still bound to the exact original fetch above.
  if (response.status() === 200 || Object.prototype.hasOwnProperty.call(envelope, 'id')) {
    expect(envelope.id, 'server JSON-RPC response id must match the request').toBe(payload.id)
  }
  return captured.body
}

async function assertOwnerCaptureIntegrity(page, evidence) {
  // A navigation creates a fresh document ledger. Finish every original fetch
  // and its clone before checking it, so failed or still-pending evidence can
  // never disappear on reload. An expected abort must also reach a real terminal
  // state; marking a request cancellable does not excuse an unresolved request.
  await page.waitForFunction(() => Array.isArray(window.__ownerDeliveryRpcCaptures)
    && window.__ownerDeliveryRpcCaptures.every(item => item.state !== 'pending'), undefined, { timeout: 45_000 })
  const facts = await page.evaluate(() => {
    const captures = window.__ownerDeliveryRpcCaptures
    if (!Array.isArray(captures)) return { installed: false, failures: 0, unexpectedAborts: 0, pending: 0, completed: 0 }
    return { installed: true, failures: captures.filter(item => item.state === 'failed').length,
      unexpectedAborts: captures.filter(item => item.state === 'aborted' && !item.expectedAbort).length,
      pending: captures.filter(item => item.state === 'pending').length,
      completed: captures.filter(item => item.state === 'complete').length }
  })
  expect(facts.installed, 'current document must have the owner evidence observer').toBe(true)
  expect(facts.failures, 'browser evidence capture failures must not be swallowed').toBe(0)
  expect(facts.unexpectedAborts, 'only the explicitly exercised cancelled request may abort').toBe(0)
  expect(facts.pending, 'every observed response clone must settle before navigation or acceptance').toBe(0)
  evidence.events.push({ event: 'owner_browser_response_capture_integrity', ...facts, correlation: 'jsonrpc_id_and_method', browser_cdp_body_reads: 0 })
}

async function rpcAfter(page, method, action, evidence, expectedStatus = 200) {
  let started = false
  const requestPromise = page.waitForRequest(request => started && rpcPayload(request)?.method === method, { timeout: 45_000 })
  const [request] = await Promise.all([requestPromise, (async () => { started = true; await action() })()])
  // Request.response() is metadata-only and remains correlated to this exact
  // request object. No independent same-method response race or CDP body read.
  let response = await request.response()
  // A slow PostgreSQL evidence transaction can leave the exact Request in
  // flight after waitForRequest resolves. Poll only that same request object;
  // do not race another same-method response or read the body through CDP.
  if (!response) {
    await expect.poll(async () => {
      response = await request.response()
      return response !== null
    }, { timeout: 45_000 }).toBe(true)
  }
  if (!response) throw new Error('OWNER_RPC_BROWSER_RESPONSE_MISSING')
  const body = await captureBrowserRpcResponse(page, response)
  const payload = rpcPayload(request)
  const error = body?.error ?? body?.data?.error
  const result = body?.result ?? body?.data?.result
  evidence.events.push({ event: 'rpc', method, rpc_id: payload.id, status: response.status(), request: safeParams(payload?.params), error_code: error?.code ?? null, response_body_unavailable: false, response_capture: 'original_fetch_clone' })
  expect(response.status(), method + ' status').toBe(expectedStatus)
  if (expectedStatus === 200) expect(error, method + ' RPC error').toBeFalsy()
  return { payload, body, error, result }
}

const uploadFields = {
  contract: { testId: 'customer-delivery-upload-contract', field: '合同文件', kind: 'input' },
  payment: { testId: 'customer-delivery-upload-payment', field: '付款凭证', kind: 'tags' },
  system_integration: { testId: 'customer-delivery-upload-system_integration', field: '已上传凭证', kind: 'tags' },
  functional_acceptance: { testId: 'customer-delivery-upload-functional_acceptance', field: '已上传凭证', kind: 'tags' },
  training: { testId: 'customer-delivery-upload-training', field: '已上传培训凭证', kind: 'tags' },
  video: { testId: 'customer-delivery-upload-video', field: '交付视频（支持多段）', kind: 'input' },
}

// Scope repeated labels to their own Ant form control/card. A Select's search
// input clears after a tag is added, so its value is not the persisted ref.
function evidenceTags(scope, label) {
  return scope.getByLabel(label, { exact: true })
    .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]')
    .locator('.ant-select-selection-item-content')
}

function checklistCard(dialog, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return dialog.locator('.ant-card-head-title').filter({ hasText: new RegExp(`^${escaped}$`, 'u') })
    .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-card ")][1]')
}

async function uploadAndWaitForRealScan(page, scope, deliveryId, purpose, files, evidence, waitForBinding) {
  if (!realDeliveryScan || !uploadFields[purpose]) throw new Error('REAL_DELIVERY_SCAN_REQUIRED')
  const fields = uploadFields[purpose]
  const cleanRefs = new Set()
  const observations = []
  const observationErrors = []
  const observe = response => {
    const payload = rpcPayload(response.request())
    if (payload?.method !== 'ops.customer-delivery.assets.get' || payload.params?.delivery_id !== deliveryId || payload.params?.purpose !== purpose) return
    observations.push((async () => {
      const body = await captureBrowserRpcResponse(page, response)
      const asset = body?.result ?? body?.data?.result
      evidence.events.push({ event: 'real_asset_scan', delivery_id: deliveryId, purpose, asset_ref: payload.params.asset_ref, scan_status: asset?.scanStatus ?? null, ready: asset?.ready ?? false, status: response.status() })
      expect(response.status()).toBe(200)
      expect(asset?.assetRef).toBe(payload.params.asset_ref)
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
        const body = await captureBrowserRpcResponse(page, response)
        const asset = body?.result ?? body?.data?.result
        evidence.events.push({ event: 'real_asset_upload', delivery_id: deliveryId, purpose, sha256: hash, asset_ref: asset?.assetRef ?? null, scan_status: asset?.scanStatus ?? null, ready: asset?.ready ?? false, status: response.status() })
        expect(response.status()).toBe(200)
        expect(asset?.assetRef).toMatch(/^asset[:_]/u)
        expect(asset?.scanStatus).toBe('pending')
        expect(asset?.ready).toBe(false)
        return asset
      })
    })
    const exchanges = await Promise.all([...uploads, scope.getByTestId(fields.testId).setInputFiles(files)])
    const assets = exchanges.slice(0, -1)
    const refs = assets.map(asset => asset.assetRef)
    if (waitForBinding) await waitForBinding(refs)
    else if (fields.kind === 'tags') await expect(evidenceTags(scope, fields.field)).toHaveText(refs, { timeout: 210_000 })
    else if (fields.kind === 'input') await expect(scope.getByLabel(fields.field, { exact: true })).toHaveValue(purpose === 'contract' ? refs[0] : refs.join('\n'), { timeout: 210_000 })
    else throw new Error('REAL_UPLOAD_BINDING_ASSERTION_REQUIRED')
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
    const body = await captureBrowserRpcResponse(page, response)
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
    // The context request shares the current password-session cookie jar. No bearer,
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
  let cancelledRpc
  // Only delay the real GET response to exercise a late network completion.
  // No scanner result is fabricated, and no write is cancelled/rolled back here.
  const holdScan = async route => {
    const payload = rpcPayload(route.request())
    if (intercepted || payload?.method !== 'ops.customer-delivery.assets.get' || payload.params?.delivery_id !== deliveryId || payload.params?.purpose !== 'contract') { await route.continue(); return }
    intercepted = true
    cancelledRpc = { rpcId: payload.id, method: payload.method }
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
      try { await route.fulfill({ response }) }
      catch {
        const wasExpectedAbort = await page.evaluate(({ rpcId, method }) => {
          const matches = window.__ownerDeliveryRpcCaptures?.filter(item => item.rpcId === rpcId && item.method === method) ?? []
          return matches.length === 1 && matches[0].expectedAbort && matches[0].state === 'aborted'
        }, cancelledRpc)
        if (!wasExpectedAbort) throw new Error('OWNER_CANCELLED_ROUTE_FULFILL_FAILED_WITHOUT_CONFIRMED_ABORT')
        evidence.events.push({ event: 'cancelled_upload_response_already_aborted', rpc_id: cancelledRpc.rpcId, method: cancelledRpc.method })
      }
    } catch (error) { scanFailure = error }
    finally { scanFinished() }
  }
  await page.route('**/api/mcp', holdScan)
  try {
    const file = { name: 'cancelled-contract.pdf', mimeType: 'application/pdf', buffer: contractPdf('Cancelled drawer upload fixture') }
    const uploaded = await rpcAfter(page, 'ops.customer-delivery.assets.upload', () => page.getByRole('dialog').getByTestId('customer-delivery-upload-contract').setInputFiles(file), evidence)
    evidence.events.push({ event: 'cancelled_upload_received_by_server', sha256: sha256(file.buffer), asset_ref: uploaded.result?.assetRef ?? null, scan_status: uploaded.result?.scanStatus ?? null, status: 200 })
    expect(uploaded.result?.scanStatus).toBe('pending')
    await expect(page.getByRole('dialog').getByText('安全检查中', { exact: true })).toBeVisible()
    await expect.poll(() => intercepted, { timeout: 15_000 }).toBe(true)
    const expectedCancelled = await page.evaluate(({ rpcId, method }) => {
      const matches = window.__ownerDeliveryRpcCaptures?.filter(item => item.rpcId === rpcId && item.method === method) ?? []
      if (matches.length !== 1) return false
      matches[0].expectedAbort = true
      return true
    }, cancelledRpc)
    expect(expectedCancelled, 'the intentionally cancelled GET must have one exact browser request capture').toBe(true)
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

async function selectTargetWorkspace(page) {
  const workspaceSelector = page.getByRole('combobox', { name: '客户交付目标企业工作区', exact: true })
  await workspaceSelector.click()
  // Ant Select's virtual list keeps a hidden accessibility-only role=option.
  // Select the rendered row from the currently visible popup instead.
  const targetWorkspaceOption = page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: workspaceId })
  await expect(targetWorkspaceOption).toBeVisible({ timeout: 30_000 })
  await targetWorkspaceOption.click()
  await expect(page.getByText('请选择目标企业工作区后开始客户交付', { exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: '新建客户', exact: true })).toBeEnabled()
}

async function login(page) {
  await page.addInitScript(installOwnerRpcCapture, { expectedOrigin: origin.origin })
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
  await page.getByRole('textbox', { name: '运营账号', exact: true }).fill(process.env.OPS_TEST_USERNAME)
  await page.getByLabel('密码', { exact: true }).fill(process.env.OPS_TEST_PASSWORD)
  await page.getByRole('button', { name: '安全登录', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('已由服务端验证', { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: '客户交付', exact: true })).toBeVisible({ timeout: 30_000 })
  await selectTargetWorkspace(page)
}

async function closeDrawer(page) {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: '保存当前环节', exact: true })).not.toHaveClass(/ant-btn-loading/u)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toBeHidden()
}

async function verifyWorkspaceCannotAccessDelivery(browser, deliveryId, assetRef, file, evidence) {
  const workspaceBaseUrl = process.env.OPS_WORKSPACE_BASE_URL
  if (!workspaceBaseUrl) throw new Error('ISOLATED_WORKSPACE_OIDC_REQUIRED')
  const workspaceOrigin = new URL(workspaceBaseUrl)
  if (workspaceOrigin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(workspaceOrigin.hostname) || !workspaceOrigin.port || workspaceOrigin.pathname !== '/' || workspaceOrigin.username || workspaceOrigin.password || workspaceOrigin.search || workspaceOrigin.hash || workspaceOrigin.origin === origin.origin) throw new Error('WORKSPACE_OIDC_MUST_BE_A_SEPARATE_LOOPBACK_ORIGIN')
  // Start with a separate empty cookie jar. The runner's workspace-only OIDC
  // identity has no delivery platform capability and is never promoted here.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' })
  try {
    const memberPage = await context.newPage()
    await openWorkspaceConsole(memberPage, '/ops/customer-delivery?workbench=workspace')
    await expect(memberPage.getByRole('heading', { name: '无权访问“客户交付”', exact: true })).toBeVisible()
    await expect(memberPage.getByRole('alert', { name: '权限拒绝详情', exact: true }).getByText('customer.delivery.read', { exact: true })).toBeVisible()
    await expect(memberPage.getByRole('button', { name: '新建客户', exact: true })).toHaveCount(0)
    await expect(memberPage.getByTestId('customer-delivery-upload-contract')).toHaveCount(0)
    const requests = [
      ['ops.customer-delivery.assets.get', 'customer.delivery.read', { target_workspace_id: workspaceId, delivery_id: deliveryId, purpose: 'contract', asset_ref: assetRef }],
      ['ops.customer-delivery.assets.upload', 'customer.delivery.update', { target_workspace_id: workspaceId, delivery_id: deliveryId, purpose: 'contract', name: file.name, mime_type: file.mimeType, content_base64: file.buffer.toString('base64'), sha256: sha256(file.buffer) }],
    ]
    for (const [method, capability, params] of requests) {
      let response
      try {
        response = await memberPage.request.post(new URL('/api/mcp', workspaceOrigin).toString(), {
          headers: { 'content-type': 'application/json', 'x-ops-workbench': 'workspace', 'x-workspace-id': workspaceId },
          data: { jsonrpc: '2.0', id: `workspace-denied-${method}`, method, params },
          timeout: 45_000,
        })
      } catch { throw new Error('WORKSPACE_DELIVERY_AUTHORIZATION_REQUEST_FAILED') }
      const body = parse(await response.text())
      const error = body?.error ?? body?.data?.error
      evidence.events.push({ event: 'workspace_delivery_authorization_denied', method, delivery_id: deliveryId, status: response.status(), error_code: error?.code ?? null, reason_code: error?.details?.reason_code ?? null, capability: error?.details?.capability ?? null })
      expect(response.status()).toBe(403)
      expect(error?.code).toBe('FORBIDDEN')
      expect(error?.details).toMatchObject({ reason_code: 'AUTHZ_WORKBENCH_MISMATCH', required_scope: 'platform', capability })
      expect(body?.result ?? body?.data?.result).toBeFalsy()
    }
  } finally { await context.close() }
}

async function captureTrainingInteraction(page, evidenceDir, testInfo, deliveryId, company) {
  if (!/^[a-z0-9_-]+$/iu.test(deliveryId)) throw new Error('DELIVERY_SCREENSHOT_SELECTOR_ID_INVALID')
  const rowSelector = `tbody tr[data-row-key="${deliveryId}"]`
  const videoButtonSelector = `${rowSelector} td:nth-child(7) button`
  const trainingCheckbox = `${rowSelector} td:nth-child(6) input[type="checkbox"]`
  const trainingControl = `${rowSelector} td:nth-child(6) .ant-checkbox-wrapper`
  const trainingProofButton = `${rowSelector} td:nth-child(6) button`
  const trainingProof = `section[aria-label=${JSON.stringify(`${company} 培训凭证`)}]`
  const workspaceOption = `.ant-select-dropdown:visible .ant-select-item-option:has-text(${JSON.stringify(workspaceId)})`
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
      wait_for: '[aria-label="客户交付目标企业工作区"]', do: [
        { click: '[aria-label="客户交付目标企业工作区"]' },
        { wait_for: workspaceOption },
        { click: workspaceOption },
        { wait_for: `${trainingCheckbox}:checked:not(:disabled)` },
        { click: trainingControl },
        { wait_for: `${trainingCheckbox}:not(:checked):not(:disabled)` },
        { pause: 1 },
        { click: trainingControl },
        { wait_for: `${trainingCheckbox}:checked:not(:disabled)` },
        { click: trainingProofButton },
        { wait_for: `${trainingProof} .ant-select-selection-item-content` },
        { pause: 1 },
        { screenshot: screenshotPath },
        { click: trainingProofButton },
        { click: videoButtonSelector },
        { wait_for: '.ant-drawer-body .ant-card-head-title:has-text("已登记视频（2 段）")' },
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

test('isolated customer delivery end-to-end fields, gates, checklists and scanned assets', async ({ page, browser }, testInfo) => {
  page.setDefaultTimeout(15_000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.name))
  const evidenceDir = join(outputDir, `delivery-${Date.now()}`)
  await mkdir(evidenceDir, { recursive: true })
  const evidence = { schema_version: 2, evidence_kind: 'isolated_live_customer_delivery_ui_rpc', verification_scope: realDeliveryScan ? 'seven_scanned_attachments_and_full_delivery' : 'profile_and_fail_closed_gates_only', raw_browser_trace_saved: false, browser_response_capture: 'original_fetch_clone', real_delivery_scan: realDeliveryScan, viewport: { width: 1440, height: 900 }, timezone: 'Asia/Shanghai', fixture: { workspace_id: workspaceId }, events: [] }
  const screenshot = async name => {
    const path = join(evidenceDir, `${name}.png`)
    await page.screenshot({ path, fullPage: false, mask: [page.locator('input[type="password"]')] })
    evidence.events.push({ event: 'screenshot', name: `${name}.png` })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  const company = `隔离交付验收-${Date.now()}`
  const pdfFiles = Object.fromEntries([
    ['contract', 'Customer contract and delivery scope'],
    ['payment', 'Payment verification receipt'],
    ['system_integration', 'System integration report for ten checks'],
    ['functional_acceptance', 'Functional acceptance report for eight checks'],
    ['training', 'Customer training attendance and confirmation'],
  ].map(([purpose, title]) => [purpose, { name: `delivery-${purpose}.pdf`, mimeType: 'application/pdf', buffer: contractPdf(title) }]))
  const videoFiles = [
    { name: 'delivery-first.mp4', mimeType: 'video/mp4', buffer: tinyMp4 },
    { name: 'delivery-second.webm', mimeType: 'video/webm', buffer: tinyWebm },
  ]
  expect(new Set([...Object.values(pdfFiles), ...videoFiles].map(file => sha256(file.buffer))).size, 'seven attachments must contain distinct real bytes').toBe(7)
  const scannedByPurpose = {}
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
    const rejectedContract = await rpcAfter(page, 'ops.customer-delivery.update', () => profile.getByRole('button', { name: '保存当前环节', exact: true }).click(), evidence, 404)
    expect(rejectedContract.error?.code).toBe('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND')
    // Verify the binding rejection left the complete server-backed draft intact.
    const unchangedResponse = await page.request.post(new URL('/api/mcp', origin).toString(), {
      headers: { 'x-workspace-id': workspaceId },
      data: { jsonrpc: '2.0', id: 'owner-missing-contract-unchanged', method: 'ops.customer-delivery.get',
        params: { target_workspace_id: workspaceId, delivery_id: deliveryId } },
    })
    expect(unchangedResponse.status()).toBe(200)
    const unchangedBody = await unchangedResponse.json()
    const unchangedEnvelope = unchangedBody.data ?? unchangedBody
    expect(unchangedEnvelope.id).toBe('owner-missing-contract-unchanged')
    expect(unchangedEnvelope.result).toEqual(created.result)
    evidence.events.push({ event: 'missing_contract_rejected_without_any_profile_mutation', status: 404, revision: created.result.revision })
    await expect(profile).toBeVisible()
    await expect(row.locator('td').nth(2)).toContainText('未填写')
    await screenshot('missing-contract-rejected')
    let savedContractRef = ''
    const savedContractFile = pdfFiles.contract
    if (realDeliveryScan) {
      await profile.getByLabel('合同文件', { exact: true }).fill('')
      const [contract] = await uploadAndWaitForRealScan(page, profile, deliveryId, 'contract', [savedContractFile], evidence)
      savedContractRef = contract.assetRef
      scannedByPurpose.contract = [contract.assetRef]
      await screenshot('real-contract-scan-ready')
      await rpcAfter(page, 'ops.customer-delivery.update', () => profile.getByRole('button', { name: '保存当前环节', exact: true }).click(), evidence)
      await expect(profile).toBeVisible()
    } else {
      await profile.getByLabel('合同文件', { exact: true }).fill('https://example.com/delivery-contract.pdf')
      await profile.getByRole('button', { name: '保存当前环节', exact: true }).click()
      await expect(profile.getByText('合同凭据必须上传并通过安全扫描', { exact: true })).toBeVisible()
      evidence.events.push({ event: 'external_contract_url_rejected_in_form' })
    }
    await closeDrawer(page)
    await expect(profile).toBeHidden()
    await expect(row.locator('td').nth(2)).toContainText(realDeliveryScan ? '已完成' : '未填写')
    await row.locator('td').nth(3).getByRole('button').click()
    await expect(page.getByText('用户尚未完成付款', { exact: true })).toBeVisible()

    // Complete payment/profile and assert the persisted DATE/timestamp wire values.
    await row.locator('td').nth(2).getByRole('button').click()
    const paidProfile = page.getByRole('dialog')
    await paidProfile.getByLabel('付款状态').click()
    await page.getByText('已完成付款核验', { exact: true }).click()
    await paidProfile.getByLabel('付款日期').fill('2026-09-14')
    // Missing payment files are a UI gate, not successful payment verification.
    await paidProfile.getByRole('button', { name: '保存当前环节', exact: true }).click()
    await expect(paidProfile.getByText('标记已付款前必须上传付款凭证', { exact: true })).toBeVisible()
    evidence.events.push({ event: 'missing_payment_evidence_blocked_in_form' })
    if (!realDeliveryScan) {
      await closeDrawer(page)
      await row.locator('td').nth(6).getByRole('button').click()
      const blockedVideo = page.getByRole('dialog')
      await blockedVideo.getByLabel('交付视频（支持多段）').fill('asset_ref_not_scanned')
      const rejected = await rpcAfter(page, 'ops.customer-delivery.videos.add', () => blockedVideo.getByRole('button', { name: '保存当前环节', exact: true }).click(), evidence, 404)
      expect(rejected.error?.code).toBe('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND')
      await expect(row).not.toContainText('交付已完成')
      await screenshot('non-real-scan-fail-closed-only')
      await closeDrawer(page)
      await assertOwnerCaptureIntegrity(page, evidence)
      expect(pageErrors).toEqual([])
      evidence.status = 'passed'
      evidence.events.push({ event: 'full_delivery_not_attempted', reason: 'real_scanner_not_enabled', seven_attachment_acceptance: false })
      return
    }
    const [payment] = await uploadAndWaitForRealScan(page, paidProfile, deliveryId, 'payment', [pdfFiles.payment], evidence)
    scannedByPurpose.payment = [payment.assetRef]
    const savedProfile = await rpcAfter(page, 'ops.customer-delivery.update', () => paidProfile.getByRole('button', { name: '保存当前环节', exact: true }).click(), evidence)
    const wire = savedProfile.result
    expect(parse(savedProfile.payload.params.patch_json)?.paymentEvidenceRefs).toEqual([payment.assetRef])
    expect(wire.paymentEvidenceRefs ?? wire.payment_evidence_refs).toEqual([payment.assetRef])
    expect(wire.paymentDate ?? wire.payment_date).toBe('2026-09-14')
    expect(wire.plannedGoLiveAt ?? wire.planned_go_live_at).toBe('2026-10-01T01:00:00.000Z')
    await closeDrawer(page)
    await assertOwnerCaptureIntegrity(page, evidence)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: '客户交付', exact: true })).toBeVisible({ timeout: 30_000 })
    await selectTargetWorkspace(page)
    const refreshedRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: company, exact: true }) })
    await expect(refreshedRow).toBeVisible()
    await refreshedRow.locator('td').nth(2).getByRole('button').click()
    await expect(page.getByRole('dialog').getByLabel('付款日期')).toHaveValue('2026-09-14')
    await expect(page.getByRole('dialog').getByLabel('要求上线时间')).toHaveValue('2026-10-01T09:00')
    await expect(page.getByRole('dialog').getByLabel('合同文件', { exact: true })).toHaveValue(savedContractRef)
    await expect(evidenceTags(page.getByRole('dialog'), '付款凭证')).toHaveText([payment.assetRef])
    await screenshot('profile-fields-reloaded')
    await closeDrawer(page)

    const fillChecklist = async (items, checklistKey) => {
      const cell = refreshedRow.locator('td').nth(checklistKey === 'system_integration' ? 3 : 4)
      await cell.getByRole('button').click()
      const dialog = page.getByRole('dialog')
      const boxes = dialog.getByRole('checkbox')
      await expect(boxes).toHaveCount(items.length)
      await expect(boxes.first()).toBeEnabled({ timeout: 30_000 })
      await expect(dialog.getByRole('button', { name: '保存当前环节', exact: true })).toBeVisible({ timeout: 30_000 })
      const firstCard = checklistCard(dialog, items[0][1])
      const [report] = await uploadAndWaitForRealScan(page, firstCard, deliveryId, checklistKey, [pdfFiles[checklistKey]], evidence)
      scannedByPurpose[checklistKey] = [report.assetRef]
      for (const [index, [, label]] of items.entries()) {
        const checkbox = dialog.getByRole('checkbox', { name: label, exact: true })
        // Ant Design updates the controlled Checkbox.Group value on React's
        // next render. Playwright's check() performs an immediate native-state
        // postcondition and can report a false failure even though the
        // controlled value has already rendered as checked.
        await checkbox.click()
        await expect(checkbox).toBeChecked()
        const card = checklistCard(dialog, label)
        await card.getByLabel('凭证说明', { exact: true }).fill(`${label}核验记录-${index + 1}`)
        if (index > 0) {
          // This is the real report uploaded and scanned above, admitted for
          // this delivery and this purpose; never a fabricated asset reference.
          await card.getByLabel('已上传凭证', { exact: true }).fill(report.assetRef)
          await card.getByLabel('已上传凭证', { exact: true }).press('Enter')
        }
        await expect(evidenceTags(card, '已上传凭证')).toHaveText([report.assetRef])
      }
      const saved = await rpcAfter(page, 'ops.customer-delivery.checklist.update', () => dialog.getByRole('button', { name: '保存当前环节', exact: true }).click(), evidence)
      const expectedItems = items.map(([itemKey, label], index) => ({ itemKey, completed: true, evidence: { note: `${label}核验记录-${index + 1}`, asset_refs: [report.assetRef] } }))
      expect(parse(saved.payload.params.items_json)).toEqual(expectedItems)
      expect(saved.payload.params).not.toHaveProperty('completed')
      await closeDrawer(page)
      await expect(cell).toContainText('已完成')
      const loaded = await rpcAfter(page, 'ops.customer-delivery.checklist-items.list', () => cell.getByRole('button').click(), evidence)
      expect(loaded.result?.items).toHaveLength(items.length)
      for (const expected of expectedItems) {
        const persisted = loaded.result.items.find(item => (item.itemKey ?? item.item_key) === expected.itemKey)
        expect(persisted?.completed).toBe(true)
        expect(persisted?.evidence).toEqual(expected.evidence)
      }
      const reopened = page.getByRole('dialog')
      for (const [index, [, label]] of items.entries()) {
        await expect(reopened.getByRole('checkbox', { name: label, exact: true })).toBeChecked()
        const card = checklistCard(reopened, label)
        await expect(card.getByLabel('凭证说明', { exact: true })).toHaveValue(`${label}核验记录-${index + 1}`)
        await expect(evidenceTags(card, '已上传凭证')).toHaveText([report.assetRef])
      }
      evidence.events.push({ event: 'checklist_notes_and_scanned_evidence_reloaded', delivery_id: deliveryId, purpose: checklistKey, item_count: items.length, asset_refs: [report.assetRef] })
      await closeDrawer(page)
    }
    await fillChecklist([
      ['插件账号', '插件账户'], ['店铺连接', '店铺连接'], ['商品扫描', '商品扫描'], ['知识库', '知识库功能'], ['平台规则', '平台规则'],
      ['创意点数', '创作点'], ['企业信息', '企业信息'], ['品牌资产', '品牌资产'], ['商品资料', '商品资料'], ['客户偏好', '客户偏好'],
    ], 'system_integration')
    await fillChecklist([
      ['文案生成', '文案生成'], ['图片生成', '图片生成'], ['标注编辑', '批注修改'], ['自动检查', '自动检查'],
      ['视频生成', '视频生成'], ['店铺/商品读取', '店铺与商品资料读取'], ['技术验收', '技术验收'], ['内容验收', '内容验收'],
    ], 'functional_acceptance')

    // Training can be completed directly from the overview; it must not open a drawer.
    const trainingCell = refreshedRow.locator('td').nth(5)
    await expect(trainingCell.getByRole('button', { name: '详情', exact: true })).toHaveCount(0)
    const trainingBox = trainingCell.getByRole('checkbox')
    await expect(trainingBox).toBeVisible()
    await expect(trainingBox).not.toBeChecked()
    const beforeDialogs = await page.getByRole('dialog').count()
    await trainingBox.click()
    const trainingEvidence = page.getByRole('region', { name: `${company} 培训凭证`, exact: true })
    await expect(trainingEvidence).toBeVisible()
    await expect(trainingBox).not.toBeChecked()
    expect(await page.getByRole('dialog').count()).toBe(beforeDialogs)
    await trainingEvidence.getByRole('button', { name: '确认培训完成', exact: true }).click()
    await expect(trainingEvidence.getByRole('alert')).toHaveText('完成客户培训前请上传培训凭证')
    await expect(trainingBox).not.toBeChecked()
    const [training] = await uploadAndWaitForRealScan(page, trainingEvidence, deliveryId, 'training', [pdfFiles.training], evidence)
    scannedByPurpose.training = [training.assetRef]
    await expect(trainingBox).not.toBeChecked()
    const trainingSaved = await rpcAfter(page, 'ops.customer-delivery.training.complete', () => trainingEvidence.getByRole('button', { name: '确认培训完成', exact: true }).click(), evidence)
    expect(parse(trainingSaved.payload.params.evidence_refs_json)).toEqual([training.assetRef])
    expect(trainingSaved.result.trainingEvidenceRefs ?? trainingSaved.result.training_evidence_refs).toEqual([training.assetRef])
    expect(await page.getByRole('dialog').count()).toBe(beforeDialogs)
    await expect(trainingEvidence).toBeHidden()
    await expect(trainingBox).toBeChecked()
    await trainingCell.getByRole('button', { name: '凭证', exact: true }).click()
    await expect(evidenceTags(trainingEvidence, '已上传培训凭证')).toHaveText([training.assetRef])
    await screenshot('training-inline-scanned-evidence')
    await trainingEvidence.getByRole('button', { name: /^收\s*起$/u }).click()
    evidence.events.push({ event: 'training_requires_uploaded_evidence_and_explicit_confirmation', delivery_id: deliveryId, asset_refs: [training.assetRef], opened_drawer: false })

    // A nonexistent/unscanned reference must remain blocked even when the real
    // scanner is enabled; success must come from uploaded file bytes instead.
    await refreshedRow.getByRole('button', { name: /未上传|\d+ 段/u }).click()
    const videoDialog = page.getByRole('dialog')
    await expect(videoDialog.getByRole('button', { name: '选择视频（需安全上传）', exact: true })).toHaveCount(0)
    await videoDialog.getByLabel('交付视频（支持多段）').fill('asset_ref_not_scanned')
    const rejected = await rpcAfter(page, 'ops.customer-delivery.videos.add', () => videoDialog.getByRole('button', { name: '保存当前环节', exact: true }).click(), evidence, 404)
    expect(rejected.error?.code).toBe('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND')
    await expect(videoDialog.getByText('尚未登记交付视频', { exact: true })).toBeVisible()
    await expect(refreshedRow).not.toContainText('交付已完成')
    await expect(refreshedRow).not.toContainText('已生效')
    await screenshot('customer-delivery-gates')
    await expect(videoDialog.getByRole('button', { name: '保存当前环节', exact: true })).not.toHaveClass(/ant-btn-loading/u)
    await videoDialog.getByLabel('交付视频（支持多段）').fill('')
    const assets = await uploadAndWaitForRealScan(page, videoDialog, deliveryId, 'video', videoFiles, evidence)
    expect(new Set(assets.map(asset => asset.assetRef)).size).toBe(2)
    scannedByPurpose.video = assets.map(asset => asset.assetRef)
    await screenshot('real-videos-scan-ready')
    await registerRealVideoSegments(page, videoDialog, deliveryId, assets, evidence)
    await closeDrawer(page)
    await assertOwnerCaptureIntegrity(page, evidence)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await selectTargetWorkspace(page)
    await expect(refreshedRow).toBeVisible({ timeout: 30_000 })
    await expect(refreshedRow).toContainText('交付已完成')
    await expect(refreshedRow.locator('td').nth(5).getByRole('checkbox')).toBeChecked()
    await refreshedRow.getByRole('button', { name: '2 段', exact: true }).click()
    await expect(page.getByRole('dialog').getByText('已登记视频（2 段）', { exact: true })).toBeVisible()
    for (const asset of assets) await expect(page.getByRole('dialog').getByText(asset.assetRef, { exact: true })).toBeVisible()
    await screenshot('real-video-segments-reloaded')
    expect(Object.keys(scannedByPurpose).sort()).toEqual(Object.keys(uploadFields).sort())
    expect(new Set(Object.values(scannedByPurpose).flat()).size).toBe(7)
    evidence.events.push({ event: 'real_seven_attachments_persisted', delivery_id: deliveryId, asset_refs: Object.values(scannedByPurpose).flat(), purpose_asset_refs: scannedByPurpose, points_granted: false })
    await captureTrainingInteraction(page, evidenceDir, testInfo, deliveryId, company)
    await closeDrawer(page)
    // shot-scraper used its own authenticated browser to withdraw and restore
    // training; reload this browser to verify the final server-backed state.
    await assertOwnerCaptureIntegrity(page, evidence)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await selectTargetWorkspace(page)
    await expect(refreshedRow).toContainText('交付已完成', { timeout: 30_000 })
    await expect(refreshedRow.locator('td').nth(5).getByRole('checkbox')).toBeChecked()
    await refreshedRow.locator('td').nth(5).getByRole('button', { name: '凭证', exact: true }).click()
    await expect(evidenceTags(trainingEvidence, '已上传培训凭证')).toHaveText([training.assetRef])
    await trainingEvidence.getByRole('button', { name: /^收\s*起$/u }).click()
    evidence.events.push({ event: 'training_inline_withdraw_and_restore_reloaded', delivery_id: deliveryId, asset_refs: [training.assetRef] })
    await page.getByRole('button', { name: '新建客户', exact: true }).click()
    const secondCompany = `${company}-second`
    await page.getByRole('textbox', { name: /公司名称/u }).fill(secondCompany)
    const secondCreated = await rpcAfter(page, 'ops.customer-delivery.create', () => page.getByRole('button', { name: /创\s*建/u }).click(), evidence)
    const newProfile = page.getByRole('dialog')
    for (const label of ['合同编号', '合同文件', '项目负责人', '售后负责人', '付款日期', '要求上线时间']) {
      await expect(newProfile.getByLabel(label, { exact: true })).toHaveValue('')
    }
    await expect(evidenceTags(newProfile, '付款凭证')).toHaveCount(0)
    evidence.events.push({ event: 'new_customer_has_no_previous_profile_fields' })
    await verifyClosedUploadCannotFillAnotherCustomer(page, secondCreated.result.id, refreshedRow, savedContractRef, secondCompany, evidence)
    await screenshot('cancelled-upload-does-not-populate-new-customer')
    await verifyCleanContractReuse(page, created.payload.params.target_workspace_id, savedContractFile, savedContractRef, company, evidence)
    await verifyWorkspaceCannotAccessDelivery(browser, deliveryId, savedContractRef, savedContractFile, evidence)
    await assertOwnerCaptureIntegrity(page, evidence)
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
