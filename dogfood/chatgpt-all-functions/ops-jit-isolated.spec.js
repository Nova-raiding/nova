import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

// Run only through the isolated PostgreSQL/Redis/OIDC harness. This spec never
// provisions services, uses bearer fixtures, mocks MCP, or calls API directly.
function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value || !value.trim()) throw new Error(`Isolated live JIT acceptance requires ${name}`)
  return value
}

const config = {
  baseUrl: requiredEnvironment('OPS_OIDC_BASE_URL').trim(),
  username: requiredEnvironment('LOCAL_OIDC_TEST_USERNAME'),
  password: requiredEnvironment('LOCAL_OIDC_TEST_PASSWORD'),
  actorId: requiredEnvironment('LOCAL_OIDC_SUBJECT').trim(),
  workspaceId: requiredEnvironment('OPS_E2E_WORKSPACE_ID').trim(),
  subjectIdentityId: requiredEnvironment('OPS_E2E_SUBJECT_IDENTITY_ID').trim(),
  approverId: requiredEnvironment('OPS_E2E_APPROVER_ID').trim(),
  outputDir: requiredEnvironment('OPS_E2E_OUTPUT_DIR').trim(),
}
const gatewayUrl = new URL(config.baseUrl)
if (gatewayUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(gatewayUrl.hostname)
  || !gatewayUrl.port || gatewayUrl.username || gatewayUrl.password || gatewayUrl.search || gatewayUrl.hash
  || gatewayUrl.pathname !== '/') {
  throw new Error('OPS_OIDC_BASE_URL must be an explicit loopback HTTP gateway origin with a port')
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(config.subjectIdentityId)) {
  throw new Error('OPS_E2E_SUBJECT_IDENTITY_ID must be a persistent fixture UUID')
}
if (config.approverId === config.actorId) throw new Error('OPS_E2E_APPROVER_ID must differ from LOCAL_OIDC_SUBJECT')
if (!isAbsolute(config.outputDir) || config.outputDir === '/') throw new Error('OPS_E2E_OUTPUT_DIR must be an explicit absolute evidence directory')
for (const key of ['actorId', 'workspaceId', 'approverId']) {
  if (/[\u0000-\u001f\u007f]/u.test(config[key])) throw new Error(`Invalid isolated fixture identifier: ${key}`)
}

test.describe.configure({ mode: 'serial', retries: 0 })
test.setTimeout(180_000)
// Raw traces/HAR/video can retain login bodies or session cookies. The evidence
// below is an explicit allowlist of RPC facts and masked desktop screenshots.
test.use({ channel: 'chrome', trace: 'off', video: 'off', screenshot: 'off' })

const reference = value => typeof value === 'string'
  ? `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`
  : null
const parseJson = value => {
  try { return JSON.parse(value) } catch { return null }
}
const mcpPayload = request => {
  const url = new URL(request.url())
  if (request.method() !== 'POST' || url.origin !== gatewayUrl.origin || url.pathname !== '/api/mcp') return null
  return parseJson(request.postData() ?? '')
}
const grantEvidence = grant => ({
  grant_ref: reference(grant?.id),
  subject_ref: reference(grant?.subjectIdentityId),
  workspace_id: grant?.workspaceId,
  access_mode: grant?.accessMode,
  capabilities: grant?.capabilities,
  resource_scope: grant?.resourceScope,
  use_count: grant?.useCount,
  max_uses: grant?.maxUses,
  revision: grant?.revision,
  authorization_revision: grant?.authorizationRevision,
  issued_at: grant?.issuedAt,
  expires_at: grant?.expiresAt,
  revoked_at: grant?.revokedAt ?? null,
})

function resultEvidence(method, result) {
  if (!result || typeof result !== 'object') return null
  if (method === 'ops.session') return {
    actor_ref: reference(result.actor_id),
    workbench: result.workbench,
    authorization_revision: result.authorization_revision,
    capabilities: result.capabilities,
  }
  if (method === 'ops.authorization.grants.list') return {
    subject_ref: reference(result.subject_identity_id),
    workspace_id: result.workspace_id,
    authorization_revision: result.authorization_revision,
    grants: Array.isArray(result.grants) ? result.grants.map(grantEvidence) : null,
  }
  return grantEvidence(result)
}

function requestEvidence(payload) {
  const params = payload?.params ?? {}
  return {
    method: payload?.method,
    subject_ref: reference(params.subject_identity_id),
    grant_ref: reference(params.grant_id),
    target_workspace_id: params.target_workspace_id,
    resource_scope: parseJson(params.resource_scope_json),
    capabilities: parseJson(params.capabilities_json),
    access_mode: params.access_mode,
    grant_kind: params.grant_kind,
    max_uses: params.max_uses,
    expected_revision: params.expected_revision,
    expected_authorization_revision: params.expected_authorization_revision,
    approver_ref: reference(params.approved_by),
    approved_at: params.approved_at,
    expires_at: params.expires_at,
    reason_present: typeof params.reason === 'string' && params.reason.trim().length >= 3,
    ticket_present: typeof params.ticket_ref === 'string' && params.ticket_ref.trim().length > 0,
  }
}

async function rpcThroughUi(page, methods, action, evidence) {
  // Every waiter is installed before the click. Bind responses to requests
  // emitted after this action starts; the console refreshes the same RPCs in
  // the background, and matching by method alone can select an older response
  // whose body Chrome has already released.
  const actionRequests = new Set()
  let actionStarted = false
  const onRequest = request => {
    const payload = mcpPayload(request)
    if (actionStarted && payload && methods.includes(payload.method)) actionRequests.add(request)
  }
  page.on('request', onRequest)
  const waiting = methods.map(method => page.waitForResponse(response => {
    const request = response.request()
    return actionRequests.has(request) && mcpPayload(request)?.method === method
  }, { timeout: 30_000 }).then(async response => {
    const payload = mcpPayload(response.request())
    const envelope = parseJson(await response.text())
    if (!envelope || typeof envelope !== 'object') {
      evidence.events.push({ at: new Date().toISOString(), event: 'rpc', request: requestEvidence(payload), response: { status: response.status(), error_code: 'INVALID_JSON_RESPONSE' } })
      throw new Error(`${method} returned a non-JSON response`)
    }
    const error = envelope.error ?? envelope.data?.error
    const result = envelope.result ?? envelope.data?.result
    evidence.events.push({
      at: new Date().toISOString(),
      event: 'rpc',
      request: requestEvidence(payload),
      response: {
        status: response.status(),
        error_code: typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : null,
        result: resultEvidence(method, result),
      },
    })
    expect(response.status(), `${method} HTTP status`).toBe(200)
    expect(Boolean(error), `${method} must succeed through the real API`).toBe(false)
    expect(result, `${method} must return a result`).toBeDefined()
    return { payload, result }
  }))
  try {
    const actionPromise = (async () => { actionStarted = true; return action() })()
    return (await Promise.all([...waiting, actionPromise])).slice(0, methods.length)
  } finally {
    page.off('request', onRequest)
  }
}

async function login(page, evidence) {
  await page.addInitScript(({ workspaceId }) => {
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of ['ops_connection_config_v1', 'ops_api_base', 'ops_api_token', 'ops_actor_id', 'ops_workspace_id', 'ops_workbench']) storage.removeItem(key)
    }
    sessionStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId, workbench: 'platform' }))
    sessionStorage.setItem('ops_workspace_id', workspaceId)
    sessionStorage.setItem('ops_workbench', 'platform')
  }, { workspaceId: config.workspaceId })
  await page.goto(new URL('/ops/users?workbench=platform', gatewayUrl).toString(), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('textbox', { name: '运营账号', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '运营账号', exact: true }).fill(config.username)
  await page.getByLabel('密码', { exact: true }).fill(config.password)
  const [{ result: session }] = await rpcThroughUi(page, ['ops.session'], () => page.getByRole('button', { name: '安全登录', exact: true }).click(), evidence)
  expect(session.actor_id).toBe(config.actorId)
  expect(session.actor_id).not.toBe(config.approverId)
  expect(session.workbench).toBe('platform')
  expect(session.capabilities).toEqual(expect.arrayContaining(['authorization.grant.read', 'authorization.grant.manage']))
  await expect(page.getByRole('region', { name: '当前身份与权限范围' })).toContainText('已由服务端验证', { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: '用户中心', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '权限与角色', exact: true }).click()
  await page.getByRole('tab', { name: 'JIT 授权', exact: true }).click()
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
  test(`isolated live JIT issue, refresh and revoke at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    const caseId = `jit-${viewport.width}x${viewport.height}-${randomUUID()}`
    const evidenceDir = join(config.outputDir, caseId)
    await mkdir(evidenceDir, { recursive: true })
    const evidence = {
      schema_version: 1,
      evidence_kind: 'isolated_live_oidc_ui_rpc',
      raw_browser_trace_saved: false,
      viewport,
      fixture: { workspace_id: config.workspaceId, subject_ref: reference(config.subjectIdentityId), actor_ref: reference(config.actorId), approver_ref: reference(config.approverId) },
      status: 'running',
      events: [],
    }
    const step = name => evidence.events.push({ at: new Date().toISOString(), event: 'step', name })
    const screenshot = async name => {
      const path = join(evidenceDir, `${name}.png`)
      await page.screenshot({ path, fullPage: false, mask: [page.locator('input, textarea'), page.getByRole('region', { name: '当前身份与权限范围' })] })
      evidence.events.push({ at: new Date().toISOString(), event: 'screenshot', name: `${name}.png` })
      await testInfo.attach(name, { path, contentType: 'image/png' })
    }
    await page.setViewportSize(viewport)
    try {
      step('signed_oidc_login_and_grant_capabilities')
      await login(page, evidence)
      await page.getByRole('textbox', { name: 'JIT 目标身份 ID', exact: true }).fill(config.subjectIdentityId)
      await page.getByRole('textbox', { name: 'JIT 目标工作区 ID', exact: true }).fill(config.workspaceId)
      // Ant Design prefixes the accessible name with "loading" while the
      // request is in flight. Match the stable merchant action label while
      // keeping the explicit loading assertion below.
      const readGrants = page.getByRole('button', { name: /读取有效 JIT/u })
      const [{ result: initial }] = await rpcThroughUi(page, ['ops.authorization.grants.list'], () => readGrants.click(), evidence)
      expect(initial.subject_identity_id).toBe(config.subjectIdentityId)
      expect(initial.workspace_id).toBe(config.workspaceId)
      expect(initial.grants, 'the isolated target fixture must start without active grants').toEqual([])
      expect(Number.isSafeInteger(initial.authorization_revision)).toBe(true)

      step('issue_exact_workspace_read_grant_from_form')
      const form = page.getByRole('form', { name: '签发 JIT 授权', exact: true })
      await expect(form).toBeVisible()
      await form.getByLabel('能力（逗号分隔）', { exact: true }).fill('customer.content.read')
      await form.getByLabel('工单/事故', { exact: true }).fill(caseId)
      await form.getByLabel('最大使用次数', { exact: true }).fill('2')
      await form.getByLabel('审批人', { exact: true }).fill(config.approverId)
      const approvedAt = new Date().toISOString()
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
      await form.getByLabel('审批时间（ISO UTC）', { exact: true }).fill(approvedAt)
      await form.getByLabel('到期时间（读≤15m / 写≤5m）', { exact: true }).fill(expiresAt)
      await form.getByLabel('授权原因', { exact: true }).fill(`隔离桌面授权验收 ${caseId}`)
      const [issuedExchange, automaticRefresh] = await rpcThroughUi(page, ['ops.authorization.grant.issue', 'ops.authorization.grants.list'], () => form.getByRole('button', { name: '签发 JIT', exact: true }).click(), evidence)
      const issued = issuedExchange.result
      const params = issuedExchange.payload.params
      expect(JSON.parse(params.resource_scope_json)).toEqual({ workspace_ids: [config.workspaceId] })
      expect(params.target_workspace_id).toBe(config.workspaceId)
      expect(params.subject_identity_id).toBe(config.subjectIdentityId)
      expect(params.expected_authorization_revision).toBe(String(initial.authorization_revision))
      expect(JSON.parse(params.capabilities_json)).toEqual(['customer.content.read'])
      expect(params.access_mode).toBe('read')
      expect(params.max_uses).toBe('2')
      expect(params.approved_by).toBe(config.approverId)
      expect(params.approved_at).toBe(approvedAt)
      expect(params.expires_at).toBe(expiresAt)
      expect(typeof issued.id).toBe('string')
      expect(issued.id.length).toBeGreaterThan(0)
      expect(issued.resourceScope).toEqual({ workspace_ids: [config.workspaceId] })
      expect(issued.workspaceId).toBe(config.workspaceId)
      expect(issued.subjectIdentityId).toBe(config.subjectIdentityId)
      expect(issued.useCount).toBe(0)
      expect(issued.maxUses).toBe(2)
      expect(issued.authorizationRevision).toBe(initial.authorization_revision + 1)
      expect(automaticRefresh.result.grants.map(grant => grant.id)).toContain(issued.id)

      step('explicit_refresh_preserves_persisted_grant_and_revision')
      await expect(readGrants).not.toHaveClass(/ant-btn-loading/u)
      const [{ result: refreshed }] = await rpcThroughUi(page, ['ops.authorization.grants.list'], () => readGrants.click(), evidence)
      const persisted = refreshed.grants.find(grant => grant.id === issued.id)
      expect(persisted).toBeDefined()
      expect(persisted.resourceScope).toEqual({ workspace_ids: [config.workspaceId] })
      expect(refreshed.authorization_revision).toBe(issued.authorizationRevision)
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: caseId, exact: true }) })
      await expect(row).toBeVisible()
      await expect(row).toContainText('customer.content.read')
      await expect(row).toContainText('0/2')
      await row.scrollIntoViewIfNeeded()
      await screenshot('issued-and-refreshed')

      step('confirm_revoke_with_current_revisions_and_reason')
      await row.getByRole('button', { name: '立即撤销', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: `立即撤销 ${issued.id}`, exact: true })
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText(`workspace:${config.workspaceId}`)
      const confirm = dialog.getByRole('button', { name: '确认撤销', exact: true })
      await expect(confirm).toBeDisabled()
      const revokeReason = `隔离桌面验收完成撤销 ${caseId}`
      await dialog.getByLabel('撤销原因', { exact: true }).fill(revokeReason)
      await expect(confirm).toBeEnabled()
      await screenshot('revoke-confirmation')
      const [revokedExchange, revokedRefresh] = await rpcThroughUi(page, ['ops.authorization.grant.revoke', 'ops.authorization.grants.list'], () => confirm.click(), evidence)
      expect(revokedExchange.payload.params.grant_id).toBe(issued.id)
      expect(revokedExchange.payload.params.reason).toBe(revokeReason)
      expect(revokedExchange.payload.params.expected_revision).toBe(String(persisted.revision))
      expect(revokedExchange.payload.params.expected_authorization_revision).toBe(String(refreshed.authorization_revision))
      expect(revokedExchange.result.id).toBe(issued.id)
      expect(revokedExchange.result.revokedAt).toBeTruthy()
      expect(revokedExchange.result.authorizationRevision).toBe(refreshed.authorization_revision + 1)
      expect(revokedRefresh.result.grants.map(grant => grant.id)).not.toContain(issued.id)
      await expect(dialog).toBeHidden({ timeout: 30_000 })
      await expect(row).toHaveCount(0)
      await expect(page.getByText('最近一次 JIT 已撤销', { exact: true })).toBeVisible()
      await screenshot('revoked-and-removed')
      evidence.status = 'passed'
    } catch (error) {
      evidence.status = 'failed'
      evidence.events.push({ at: new Date().toISOString(), event: 'failure', name: error instanceof Error ? error.name : 'UnknownError' })
      // The screenshot also masks login inputs if authentication itself failed.
      await screenshot('failure-masked').catch(() => undefined)
      throw error
    } finally {
      evidence.finished_at = new Date().toISOString()
      const path = join(evidenceDir, 'trace.redacted.json')
      await writeFile(path, JSON.stringify(evidence, null, 2), { mode: 0o600 })
      await testInfo.attach('redacted-rpc-step-trace', { path, contentType: 'application/json' })
    }
  })
}
