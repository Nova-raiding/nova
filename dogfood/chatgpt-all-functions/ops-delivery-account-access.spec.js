import { expect, test, request } from '@playwright/test'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'
// Reuse the actual, independently passed seven-file UI/API/ClamAV setup test.
// No copied media, fake scan, modification of its source, or fixture bypass.
// Serial registration is intentional: exactly this setup and the test below.
import './ops-delivery-contract-link.fixture.js'

const workspaceId = process.env.OPS_E2E_WORKSPACE_ID
const base = process.env.OPS_OIDC_BASE_URL
const output = process.env.OPS_E2E_OUTPUT_DIR
const secret = process.env.LOCAL_OIDC_TEST_PASSWORD
if (!workspaceId || !base || !output || !secret) throw new Error('ACCOUNT_ACCESS_ISOLATED_RUNNER_REQUIRED')
const digest = text => createHash('sha256').update(text).digest('hex')
const credentials = label => ({ label, login: `delivery-${label.toLowerCase()}-${digest(workspaceId).slice(0, 16)}@fixture.invalid`, password: `Fixture-${digest(`${secret}\0${workspaceId}\0${label}`)}` })
const scope = deliveryId => ({ target_workspace_id: workspaceId, delivery_id: deliveryId })

async function recordBinding(page, directory, deliveryId, login, testInfo) {
  if (!/^[a-z0-9_-]+$/iu.test(deliveryId)) throw new Error('ACCOUNT_ACCESS_SELECTOR_INVALID')
  const button = `tbody tr[data-row-key="${deliveryId}"] td:nth-child(3) button`
  const option = `.ant-select-dropdown:visible .ant-select-item-option:has-text(${JSON.stringify(login)})`
  const region = 'section[aria-label="生效账号"]'
  const files = ['account-selected.png', 'account-bound.png', 'account-reread.png', 'account-binding.webm']
  const url = new URL('/ops/customer-delivery?workbench=platform', base).toString()
  const storyboard = join(directory, 'account-binding-storyboard.json')
  await writeFile(storyboard, JSON.stringify({ url, output: join(directory, files[3]), viewport: { width: 1440, height: 900 },
    javascript: `sessionStorage.setItem('ops_connection_config_v1', ${JSON.stringify(JSON.stringify({ apiBase: '/api', workspaceId, workbench: 'platform' }))}); sessionStorage.setItem('ops_workspace_id', ${JSON.stringify(workspaceId)}); sessionStorage.setItem('ops_workbench','platform');`,
    scenes: [{ name: 'Explicitly choose the login account before immutable binding', open: url, wait_for: '[aria-label="客户交付目标企业工作区"]', do: [
      { click: '[aria-label="客户交付目标企业工作区"]' }, { click: `.ant-select-dropdown:visible .ant-select-item-option:has-text(${JSON.stringify(workspaceId)})` },
      { wait_for: button }, { click: button }, { wait_for: '#delivery-account-search:not(:disabled)' }, { pause: 0.4 },
      { fill: { into: '#delivery-account-search', text: login } }, { click: `${region} button:has-text("查询账号")` },
      { wait_for: '#delivery-account-select:not(:disabled)' }, { click: '#delivery-account-select' }, { wait_for: option }, { click: option },
      { fill: { into: '#delivery-account-reason', text: '隔离验收：核对登录账号后仅关联账号 A' } },
      { click: `${region} .ant-checkbox-wrapper` }, { scroll: { to: '#delivery-account-reason', duration: 0.3 } }, { pause: 0.4 }, { screenshot: join(directory, files[0]) },
      { click: `${region} button:has-text("确认关联账号")` }, { wait_for: `${region}:has-text("已关联，仅此账号受")` }, { pause: 0.4 }, { screenshot: join(directory, files[1]) },
      { click: '.ant-drawer-close' }, { wait_for: button }, { click: button }, { wait_for: `${region}:has-text(${JSON.stringify(login)})` },
      { scroll: { to: region, duration: 0.3 } }, { pause: 0.4 }, { screenshot: join(directory, files[2]) },
    ] }],
  }), { mode: 0o600, flag: 'wx' })
  const local = join(homedir(), '.local/bin/shot-scraper'), auth = await page.context().storageState()
  await new Promise((resolve, reject) => {
    const child = spawn(existsSync(local) ? local : 'shot-scraper', ['video', storyboard, '--auth', '/dev/stdin', '--browser', 'chrome', '--timeout', '45000'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 90_000 })
    child.stdout.resume(); child.stderr.resume()
    child.once('error', () => reject(new Error('ACCOUNT_ACCESS_CAPTURE_UNAVAILABLE')))
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('ACCOUNT_ACCESS_CAPTURE_FAILED')))
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(auth))
  })
  for (const file of files) { expect((await stat(join(directory, file))).size).toBeGreaterThan(0); await testInfo.attach(file, { path: join(directory, file), contentType: file.endsWith('.png') ? 'image/png' : 'video/webm' }) }
  return files
}

test('one explicitly bound account is pending until delivery completion; its colleague remains unchanged', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const directory = join(output, 'account-access'); await mkdir(directory, { mode: 0o700 })
  const fixture = JSON.parse(await readFile(join(output, 'contract-link/browser-result.json'), 'utf8'))
  const runtime = JSON.parse(await readFile(join(output, 'runtime.json'), 'utf8'))
  expect(fixture.status).toBe('passed'); expect(runtime.runId).toBeTruthy(); expect(runtime.evidenceDir).toBe(output)
  expect(Number.isInteger(runtime.apiPort) && runtime.apiPort > 0 && runtime.apiPort < 65536).toBe(true)
  const apiBase = `http://127.0.0.1:${runtime.apiPort}`
  const report = { status: 'failed', startedAt: new Date().toISOString(), workspaceId, fixtureRunId: runtime.runId, deliveryId: fixture.deliveryId,
    observations: [], actors: [], providerCalls: false, browserMocks: false, credentialsSaved: false, fixtureOnly: true }
  const contexts = []
  let stage = 'platform-provisioning'
  const ops = async (method, params) => {
    const response = await page.request.post(new URL('/api/mcp', base).toString(), { data: { jsonrpc: '2.0', id: `account-${Date.now()}`, method, params }, headers: { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'platform' } })
    const body = await response.json(), value = body.data ?? body
    expect(response.status(), method).toBe(200); expect(value.error).toBeUndefined(); return value.result
  }
  const observe = async (actor, phase, method) => {
    const response = method === 'http.products' ? await actor.client.get('/v1/products?scope=workspace', { headers: { 'x-workspace-id': workspaceId } })
      : await actor.client.post('/mcp', { headers: { 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' }, data: { jsonrpc: '2.0', id: `merchant-${Date.now()}`, method, params: method === 'catalog.search' ? { scope: 'workspace' } : {} } })
    const body = await response.json(), envelope = body.data ?? body, error = body.error ?? envelope.error
    const observation = { actor: actor.label, phase, method, status: response.status(), code: error?.code ?? null, dataPresent: Boolean(method === 'http.products' ? body.data : envelope.result) }
    report.observations.push(observation); return observation
  }
  try {
    await openPlatformConsole(page, '/ops/customer-delivery?workbench=platform')
    const actors = []
    for (const label of ['A', 'B']) {
      const actor = credentials(label)
      const response = await page.request.post(new URL('/api/v1/ops/merchant-accounts', base).toString(), { data: { login: actor.login, password: actor.password,
        workspace_ids: [workspaceId], enterprise_name: '隔离账号绑定验收', contact_name: `合成账号 ${label}`, reason: '隔离验收创建同工作区双账号，无真实商业开通' } })
      const created = await response.json(); expect(response.status()).toBe(201)
      const account = created.data.account
      expect(account.accountType).toBe('merchant'); expect(account.status).toBe('active'); expect(account.workspaceIds).toEqual([workspaceId])
      actor.accountId = account.id; actor.identityId = account.identityId
      actor.client = await request.newContext({ baseURL: apiBase }); contexts.push(actor.client)
      const login = await actor.client.post('/v1/auth/login', { data: { login: actor.login, password: actor.password, account_type: 'merchant' } }); expect(login.status()).toBe(200)
      const session = await actor.client.get('/v1/auth/session', { headers: { 'x-workspace-id': workspaceId } }); expect(session.status()).toBe(200)
      const sessionData = (await session.json()).data
      expect(sessionData.account.identityId).toBe(actor.identityId)
      report.actors.push({ label, login: actor.login, accountId: actor.accountId, identityId: actor.identityId })
      actors.push(actor)
    }
    expect(new Set(actors.map(actor => actor.identityId)).size).toBe(2)
    const [a, b] = actors
    for (const actor of actors) for (const method of ['http.products', 'catalog.search']) {
      const baseline = await observe(actor, 'unbound-baseline', method)
      expect([200, 402, 403, 409, 428, 503]).toContain(baseline.status); expect(baseline.code).not.toBe('CUSTOMER_DELIVERY_REQUIRED')
      expect([null, 'STORE_ONBOARDING_REQUIRED', 'COMMERCIAL_ENTITLEMENT_REQUIRED', 'CREATIVE_POINTS_UNAVAILABLE', 'AUTHZ_CAPABILITY_MISSING']).toContain(baseline.code)
      if (baseline.code === null) expect(baseline.status).toBe(200)
    }
    const recoveryBaseline = new Map()
    const recoveryState = row => [row.status, row.code, row.dataPresent]
    const checkRecovery = async phase => {
      for (const actor of actors) for (const method of ['workspace.health', 'commercial.access.get', 'platform.store.list']) {
        const row = await observe(actor, phase, method), state = recoveryState(row), key = `${actor.label}:${method}`
        // Delivery recovery does not override the separate commercial policy.
        // Store-list remains POINT_REQUIRED_NO_CHARGE; an unknown fixture
        // balance may produce this exact error, never an arbitrary 503.
        if (method === 'platform.store.list' && row.code === 'CREATIVE_POINTS_UNAVAILABLE') expect(state).toEqual([503, 'CREATIVE_POINTS_UNAVAILABLE', false])
        else expect(state, `${actor.label}:${method}`).toEqual([200, null, true])
        const previous = recoveryBaseline.get(key)
        if (previous) expect(state, `${phase}:${key}`).toEqual(previous)
        else recoveryBaseline.set(key, state)
        if (actor.label === 'B') expect(state, `${phase}:colleague:${method}`).toEqual(recoveryBaseline.get(`A:${method}`))
      }
    }
    await checkRecovery('unbound-recovery-baseline')
    let delivery = await ops('ops.customer-delivery.get', scope(fixture.deliveryId))
    expect(delivery.effectiveAt).toBeTruthy()
    // A normal, audited form update removes completion, not the genuine scan.
    await ops('ops.customer-delivery.training.complete', { ...scope(fixture.deliveryId), expected_revision: String(delivery.revision), completed: 'false', evidence_refs_json: '[]' })
    stage = 'real-desktop-login-selection-and-binding'
    report.visualEvidence = await recordBinding(page, directory, fixture.deliveryId, a.login, testInfo)
    delivery = await ops('ops.customer-delivery.get', scope(fixture.deliveryId))
    expect(delivery).toMatchObject({ targetAccountId: a.accountId, targetIdentityId: a.identityId, targetAccountLogin: a.login, effectiveAt: null })
    stage = 'pending-account-versus-colleague'
    for (const method of ['http.products', 'catalog.search']) {
      const denied = await observe(a, 'pending', method)
      expect(denied).toMatchObject({ status: 403, code: 'CUSTOMER_DELIVERY_REQUIRED', dataPresent: false })
      const unchanged = await observe(b, 'colleague-pending', method), baseline = report.observations.find(item => item.actor === 'B' && item.phase === 'unbound-baseline' && item.method === method)
      expect([unchanged.status, unchanged.code]).toEqual([baseline.status, baseline.code])
    }
    await checkRecovery('pending-recovery')
    stage = 'genuine-evidence-reconfirmation'
    await ops('ops.customer-delivery.training.complete', { ...scope(fixture.deliveryId), expected_revision: String(delivery.revision), completed: 'true', evidence_refs_json: JSON.stringify([fixture.training.assetRef]) })
    delivery = await ops('ops.customer-delivery.get', scope(fixture.deliveryId)); expect(delivery.effectiveAt).toBeTruthy()
    for (const method of ['http.products', 'catalog.search']) {
      const ready = await observe(a, 'ready', method), other = await observe(b, 'colleague-ready', method)
      expect([ready.status, ready.code]).toEqual([other.status, other.code]); expect(ready.code).not.toBe('CUSTOMER_DELIVERY_REQUIRED')
    }
    await checkRecovery('ready-recovery')
    Object.assign(report, { status: 'passed', finalRevision: delivery.revision, effectiveAt: delivery.effectiveAt, boundIdentityId: delivery.targetIdentityId })
    stage = 'complete'
  } finally {
    await Promise.all(contexts.map(context => context.dispose()))
    await writeFile(join(directory, 'browser-result.json'), JSON.stringify({ ...report, stage, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600, flag: 'wx' })
  }
})
