import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openWorkspaceConsole } from './ops-auth.js'

// Runner-only diagnostic: real isolated OIDC/API/PG authorization, no scanner,
// uploads, synthetic clean receipts, payment calls, or creative-point grants.
const workspaceId = process.env.OPS_E2E_WORKSPACE_ID
const outputDir = process.env.OPS_E2E_OUTPUT_DIR
const workspaceBase = process.env.OPS_WORKSPACE_OIDC_BASE_URL
const platformBase = process.env.OPS_OIDC_BASE_URL
if (!workspaceId || !outputDir || !workspaceBase || !platformBase) throw new Error('ISOLATED_OPS_AUTH_BOUNDARY_RUNNER_REQUIRED')
const workspaceOrigin = new URL(workspaceBase)
const platformOrigin = new URL(platformBase)
for (const origin of [workspaceOrigin, platformOrigin]) {
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || !origin.port || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) throw new Error('AUTH_BOUNDARY_REQUIRES_EXPLICIT_LOOPBACK_ORIGINS')
}
if (workspaceOrigin.origin === platformOrigin.origin) throw new Error('AUTH_BOUNDARY_REQUIRES_SEPARATE_WORKSPACE_GATEWAY')

test.use({ channel: 'chrome', viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai', trace: 'off', video: 'off', screenshot: 'off' })
test.describe.configure({ retries: 0 })
test.setTimeout(90_000)

const knownAuthMessages = new Set([
  '当前身份授权决策拒绝 customer.delivery.read',
  'workspace 工作台必须携带 X-Workspace-Id',
  '受控环境请求必须携带 X-Workspace-Id',
])
function projectResponse(transport, status, responseUrl, body) {
  const error = body?.error ?? body?.data?.error
  const finalUrl = new URL(responseUrl)
  return {
    transport, status, response_url: finalUrl.origin + finalUrl.pathname,
    error_code: ['FORBIDDEN', 'WORKSPACE_SCOPE_REQUIRED', 'UNAUTHENTICATED'].includes(error?.code) ? error.code : 'UNEXPECTED_AUTH_ERROR_CODE',
    error_message: knownAuthMessages.has(error?.message) ? error.message : 'UNEXPECTED_AUTH_ERROR_MESSAGE_REDACTED',
    reason_code: error?.details?.reason_code === 'AUTHZ_WORKBENCH_MISMATCH' ? error.details.reason_code : null,
    capability: error?.details?.capability === 'customer.delivery.read' ? error.details.capability : null,
    required_scope: error?.details?.required_scope === 'platform' ? 'platform' : null,
    has_result: Boolean(body?.result ?? body?.data?.result),
  }
}

test('workspace authorization is identical for APIRequestContext and real same-origin fetch', async ({ page }, testInfo) => {
  const evidenceDir = join(outputDir, `delivery-auth-boundary-${Date.now()}`)
  await mkdir(evidenceDir, { recursive: true })
  const evidence = { schema_version: 1, status: 'failed', evidence_kind: 'isolated_live_workspace_auth_boundary', workspace_id: workspaceId,
    scanner_required: false, uploads_performed: false, business_mutations_performed: false, credentials_saved: false, request_bodies_saved: false, observations: [] }
  try {
    await openWorkspaceConsole(page, '/ops/customer-delivery?workbench=workspace')
    await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('已由服务端验证')
    await expect(page.getByRole('heading', { name: '无权访问“客户交付”', exact: true })).toBeVisible()
    expect(new URL(page.url()).origin).toBe(workspaceOrigin.origin)

    const endpoint = new URL('/api/mcp', workspaceOrigin).toString()
    const headers = { 'content-type': 'application/json', 'x-ops-workbench': 'workspace', 'x-workspace-id': workspaceId }
    // The exact same envelope/headers go through both real transports. The
    // nonexistent reference deliberately needs no uploaded/scanned asset: the
    // workspace identity must be refused before delivery or object lookup.
    const payload = { jsonrpc: '2.0', id: `auth-boundary-${randomUUID()}`, method: 'ops.customer-delivery.assets.get',
      params: { target_workspace_id: workspaceId, delivery_id: 'cd_auth_boundary_nonexistent', purpose: 'contract', asset_ref: 'asset_auth_boundary_nonexistent' } }
    const apiResponse = await page.request.post(endpoint, { headers, data: payload, timeout: 30_000 })
    const apiBody = await apiResponse.json()
    const apiObservation = projectResponse('APIRequestContext', apiResponse.status(), apiResponse.url(), apiBody)
    evidence.observations.push(apiObservation)

    const browserResponse = await page.evaluate(async ({ endpoint, headers, payload }) => {
      if (new URL(endpoint).origin !== location.origin) throw new Error('AUTH_BOUNDARY_FETCH_MUST_BE_SAME_ORIGIN')
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) })
      return { status: response.status, url: response.url, body: await response.json() }
    }, { endpoint, headers, payload })
    const browserObservation = projectResponse('browser_fetch', browserResponse.status, browserResponse.url, browserResponse.body)
    evidence.observations.push(browserObservation)

    // Never weaken the assertion to accept authentication failure (401). Both
    // authenticated requests must reach the workspace/platform permission gate.
    for (const observation of evidence.observations) {
      expect(observation, observation.transport + ' authorization boundary').toMatchObject({
        status: 403, response_url: endpoint, error_code: 'FORBIDDEN',
        error_message: '当前身份授权决策拒绝 customer.delivery.read',
        reason_code: 'AUTHZ_WORKBENCH_MISMATCH', capability: 'customer.delivery.read', required_scope: 'platform', has_result: false,
      })
    }
    const { transport: apiTransport, ...apiFacts } = apiObservation
    const { transport: browserTransport, ...browserFacts } = browserObservation
    expect(apiTransport).toBe('APIRequestContext')
    expect(browserTransport).toBe('browser_fetch')
    expect(browserFacts).toEqual(apiFacts)
    const screenshotPath = join(evidenceDir, 'workspace-delivery-denied-shot-scraper.png')
    const storyboard = join(evidenceDir, 'workspace-boundary-storyboard.json')
    // storageState carries cookies/localStorage, not sessionStorage. Configure
    // the same fixture workspace before the scene reopens the real route.
    await writeFile(storyboard, JSON.stringify({
      url: page.url(), output: join(evidenceDir, 'workspace-boundary.webm'), viewport: { width: 1440, height: 900 },
      javascript: `sessionStorage.setItem('ops_connection_config_v1', ${JSON.stringify(JSON.stringify({ apiBase: '/api', workspaceId, workbench: 'workspace' }))}); sessionStorage.setItem('ops_workspace_id', ${JSON.stringify(workspaceId)}); sessionStorage.setItem('ops_workbench', 'workspace');`,
      scenes: [{ name: 'Authenticated workspace permission boundary', open: page.url(),
        wait_for: 'h1:has-text("无权访问“客户交付”")', do: [
          { wait_for: '[aria-label="当前身份与权限范围"]:has-text("已由服务端验证")' },
          { screenshot: screenshotPath },
        ] }],
    }), { mode: 0o600, flag: 'wx' })
    const installed = join(homedir(), '.local/bin/shot-scraper')
    const authState = await page.context().storageState()
    // Pass the generated fixture session through stdin, never save credentials.
    await new Promise((resolve, reject) => {
      const child = spawn(existsSync(installed) ? installed : 'shot-scraper', [
        'video', storyboard, '--auth', '/dev/stdin', '--browser', 'chrome', '--timeout', '30000',
      ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 35_000 })
      child.stdout.resume(); child.stderr.resume()
      child.once('error', () => reject(new Error('SHOT_SCRAPER_UNAVAILABLE')))
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('SHOT_SCRAPER_CAPTURE_FAILED')))
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(authState))
    })
    await testInfo.attach('workspace-delivery-denied', { path: screenshotPath, contentType: 'image/png' })
    evidence.screenshot = 'workspace-delivery-denied-shot-scraper.png'
    evidence.status = 'passed'
  } finally {
    await writeFile(join(evidenceDir, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' })
  }
})
