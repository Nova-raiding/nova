import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { Pool } from 'pg'
import { PostgresMembersRepository } from '../packages/persistence/src/members-repository.js'
import { PostgresPasswordAuthRepository } from '../packages/persistence/src/password-auth-repository.js'
import { runOpsE2e, type OpsE2eContext } from './run-ops-password-e2e.js'

async function verify(context: OpsE2eContext) {
  const { fixture, evidenceDir } = context
  const output = resolve(evidenceDir, 'merchant-members')
  await mkdir(output, { recursive: true, mode: 0o700 })
  const login = `member-admin-${fixture.runId}@fixture.invalid`
  const password = `A1${randomBytes(24).toString('hex')}`
  // Fixture seeding is performed by the disposable container's admin role;
  // the browser API itself still runs under the restricted app/ops roles.
  const pool = new Pool({ connectionString: fixture.adminDatabaseUrl, max: 2 })
  const authPool = new Pool({ connectionString: fixture.opsDatabaseUrl, max: 1 })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const account = await new PostgresPasswordAuthRepository(authPool).createMerchantAccount({
      login, password, enterpriseName: '隔离成员验收企业', contactName: '隔离成员管理员',
      workspaceIds: [fixture.workspaceId], actorId: 'isolated-browser-fixture', reason: 'isolated member management browser verification',
    })
    const members = new PostgresMembersRepository(pool)
    await members.upsert({ workspaceId: fixture.workspaceId, externalSubject: login, displayName: '隔离成员管理员', role: 'merchant_admin', status: 'active', invitedBy: 'isolated-browser-fixture' })
    if (account.identityId) await members.bindIdentity({ workspaceId: fixture.workspaceId, externalSubject: login, identityId: account.identityId })

    // Use the gateway owned by runOpsE2e: its origin is the API's fixed
    // local-stdio issuer and is disposed by the same outer fixture lifecycle.
    const merchantUrl = context.environment.MERCHANT_STUDIO_URL
    if (!merchantUrl) throw new Error('MERCHANT_MEMBERS_RUNNER_UI_REQUIRED')
    const endpoint = new URL(merchantUrl)
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/') throw new Error('MERCHANT_MEMBERS_RUNNER_UI_INVALID')
    const origin = endpoint.origin
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' })
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    const observedApiRequests: string[] = []
    const observedApiResponses: string[] = []
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin === origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/'))) {
        observedApiRequests.push(`${request.method()} ${url.pathname}`)
      }
    })
    const failedRequests: string[] = []
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.origin === origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/'))) {
        observedApiResponses.push(`${response.request().method()} ${url.pathname} ${response.status()}`)
      }
      if (url.origin === origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) && response.status() >= 400) void response.json().then((body: { error?: { code?: string } }) => failedRequests.push(`${response.request().method()} ${url.pathname} ${response.status()} ${body.error?.code ?? ''}`)).catch(() => undefined)
    })
    const loginResponses: Array<{ status: number; code: string | null }> = []
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.origin !== origin || !url.pathname.endsWith('/v1/auth/login')) return
      void response.json().then((body: { error?: { code?: string } }) => loginResponses.push({ status: response.status(), code: body.error?.code ?? null })).catch(() => loginResponses.push({ status: response.status(), code: null }))
    })
    page.on('requestfailed', request => {
      const url = new URL(request.url())
      if (url.origin === origin && url.pathname.endsWith('/v1/auth/login')) failedRequests.push(`POST /v1/auth/login network ${request.failure()?.errorText ?? 'unknown'}`)
    })
    await page.goto(`${origin}/merchant/members`, { waitUntil: 'domcontentloaded' })
    const loginName = page.locator('#merchant-login-account')
    const loginPassword = page.locator('#merchant-login-password')
    const loginForm = page.getByRole('form', { name: '商家账号登录' })
    await expect(loginForm).toBeVisible()
    const loginButton = page.getByRole('button', { name: '登录商家工作台', exact: true })
    await loginName.fill(login)
    await loginPassword.fill(password)
    await expect.poll(async () => {
      if (await page.locator('.app-shell').isVisible().catch(() => false)) return 'authenticated'
      if (await loginButton.isVisible().catch(() => false)) return await loginButton.isEnabled() ? 'ready' : 'loading'
      return 'loading'
    }, { timeout: 30_000, message: 'merchant login button must become ready after filling the account fields' }).toMatch(/authenticated|ready/)
    const appShell = page.locator('.app-shell')
    if (!await appShell.isVisible().catch(() => false)) await loginButton.click()
    try {
      await expect.poll(() => loginResponses.length, { timeout: 15_000, message: 'merchant login form must submit an API request' }).toBeGreaterThan(0)
    } catch (error) {
      const debug = {
        url: page.url(),
        headings: await page.getByRole('heading').allTextContents(),
        alerts: await page.getByRole('alert').allTextContents(),
        loginFormCount: await loginForm.count(),
        loginNamePresent: Boolean(await loginName.inputValue().catch(() => '')),
        passwordLength: (await loginPassword.inputValue().catch(() => '')).length,
        submitDisabled: await loginButton.isDisabled().catch(() => true),
        observedApiRequests,
        observedApiResponses,
        failedRequests,
        pageErrors,
      }
      await page.screenshot({ path: resolve(output, 'merchant-login-submit-failure.png'), fullPage: true }).catch(() => undefined)
      await writeFile(resolve(output, 'merchant-login-submit-failure.json'), JSON.stringify(debug, null, 2), { mode: 0o600 })
      throw error
    }
    expect(loginResponses[0]?.status, `merchant login API response code: ${loginResponses[0]?.code ?? 'unknown'}`).toBe(200)
    await expect(page.getByLabel('工作区成员管理').getByRole('heading', { name: '成员与权限' })).toBeVisible({ timeout: 30_000 })
    console.log(JSON.stringify({ memberBrowserUrl: page.url(), headings: await page.getByRole('heading').allTextContents(), alerts: await page.getByRole('alert').allTextContents(), failedRequests, pageErrors, loginResponses }))
    await expect(page.getByRole('table', { name: '工作区成员列表' })).toContainText('隔离成员管理员', { timeout: 30_000 })
    await expect(page.getByRole('form', { name: '邀请工作区成员' })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    // Exercise the shared HttpOnly password session directly so browser-side
    // issuance serialization cannot conceal a server token-row deadlock.
    const concurrentIssuance = await page.evaluate(async (workspaceId) => Promise.all(Array.from({ length: 4 }, async () => {
      const response = await fetch('/api/v1/auth/mcp-token', {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId }),
      })
      const payload = await response.json() as { error?: { code?: string } }
      return { status: response.status, code: payload.error?.code ?? null }
    })), fixture.workspaceId)
    expect(concurrentIssuance).toEqual(Array.from({ length: 4 }, () => ({ status: 200, code: null })))
    await page.screenshot({ path: resolve(output, 'merchant-members-read.png'), fullPage: true })

    const invited = `invited-${randomUUID()}@fixture.invalid`
    const inviteePassword = `A1${randomBytes(24).toString('hex')}`
    await new PostgresPasswordAuthRepository(authPool).createMerchantAccount({
      login: invited, password: inviteePassword, enterpriseName: '隔离成员验收企业', contactName: '隔离邀请成员',
      workspaceIds: [fixture.workspaceId], actorId: 'isolated-browser-fixture', reason: 'owned account for invitation acceptance verification',
    })
    const form = page.getByRole('form', { name: '邀请工作区成员' })
    const inviteAccount = form.getByLabel('成员登录账号')
    await expect(inviteAccount).toHaveAttribute('placeholder', '例如：member@example.com 或平台账号')
    await expect(inviteAccount).toHaveAttribute('aria-describedby', 'merchant-member-invite-account-help')
    await expect(page.locator('#merchant-member-invite-account-help')).toContainText('系统会按此账号关联成员记录')
    await inviteAccount.fill(invited)
    await form.getByLabel('显示名').fill('隔离邀请成员')
    await form.getByLabel('邀请原因').fill('隔离浏览器验收邀请')
    await form.getByRole('button', { name: '邀请成员' }).click()
    await expect(page.getByRole('table', { name: '工作区成员列表' })).toContainText('隔离邀请成员', { timeout: 30_000 })
    const persisted = (await members.list(fixture.workspaceId)).find(member => member.externalSubject === invited)
    expect(persisted?.status).toBe('invited')
    expect(persisted?.role).toBe('operator')
    const inviteeContext = await browser.newContext()
    let invitationProbe: Record<string, unknown>
    try {
      const loginResult = await inviteeContext.request.post(`${origin}/api/v1/auth/login`, {
        headers: { origin }, data: { login: invited, password: inviteePassword, account_type: 'merchant' },
      })
      expect(loginResult.status()).toBe(200)
      const tokenResult = await inviteeContext.request.post(`${origin}/api/v1/auth/mcp-token`, {
        headers: { origin }, data: { workspace_id: fixture.workspaceId },
      })
      const tokenBody = await tokenResult.json()
      expect(tokenResult.status()).toBe(409)
      expect(tokenBody.error?.code).toBe('MCP_OAUTH_WORKSPACE_AMBIGUOUS')
      // Capture only response status/code. Generated session cookies and any
      // access/refresh material remain inside this owned request context.
      const invitationResult = await inviteeContext.request.post(`${origin}/api/mcp`, {
        headers: { origin, 'x-workspace-id': fixture.workspaceId, 'x-ops-workbench': 'workspace' },
        data: { jsonrpc: '2.0', id: 'owned-invitation-probe', method: 'workspace.invitations.list', params: {} },
      })
      const invitationBody = await invitationResult.json()
      expect(invitationResult.status()).toBe(200)
      expect(invitationBody.data?.result?.invitations).toEqual(expect.arrayContaining([expect.objectContaining({ workspace_id: fixture.workspaceId, status: 'invited' })]))
      invitationProbe = { loginStatus: loginResult.status(), memberStatus: persisted?.status,
        tokenStatus: tokenResult.status(), tokenCode: tokenBody.error?.code ?? null,
        cookieMcpStatus: invitationResult.status(), cookieMcpCode: invitationBody.error?.code ?? null,
        invitations: invitationBody.data?.result?.invitations ?? null }
      await writeFile(resolve(output, 'invitation-entry-probe.json'), JSON.stringify(invitationProbe, null, 2), { mode: 0o600 })
      const inviteePage = await inviteeContext.newPage()
      await inviteePage.goto(`${origin}/merchant/members`, { waitUntil: 'domcontentloaded' })
      await expect(inviteePage.getByRole('button', { name: '接受工作区邀请', exact: true })).toBeVisible({ timeout: 15_000 })
      await inviteePage.screenshot({ path: resolve(output, 'invitation-before-accept.png'), fullPage: true })
      const pendingRow = page.getByRole('row').filter({ hasText: '隔离邀请成员' })
      await pendingRow.getByRole('button', { name: '调整 隔离邀请成员 的角色', exact: true }).click()
      const pendingRoleForm = page.getByRole('form', { name: '成员变更' })
      await pendingRoleForm.getByLabel('新角色').selectOption('finance')
      await pendingRoleForm.getByLabel('操作原因').fill('验收邀请变更后的版本冲突保护')
      await pendingRoleForm.getByRole('button', { name: '确认改角色', exact: true }).click()
      await expect(pendingRow).toContainText('财务')
      const staleResponse = inviteePage.waitForResponse(response => response.url().endsWith('/api/mcp') && response.request().postDataJSON()?.method === 'workspace.invitation.accept')
      await inviteePage.getByRole('button', { name: '接受工作区邀请', exact: true }).click()
      expect((await staleResponse).status()).toBe(409)
      await expect(inviteePage.getByRole('alert')).toContainText('接受邀请失败')
      await expect(inviteePage.getByRole('button', { name: '接受工作区邀请', exact: true })).toHaveCount(0)
      await inviteePage.getByRole('button', { name: '刷新成员列表', exact: true }).click()
      await expect(inviteePage.getByRole('region', { name: '待接受的工作区邀请' })).toContainText('邀请角色：财务')
      await inviteePage.getByRole('button', { name: '接受工作区邀请', exact: true }).click()
      await expect(inviteePage.getByText('已接受工作区邀请。', { exact: true })).toBeVisible()
      expect((await members.list(fixture.workspaceId)).find(member => member.externalSubject === invited)?.status).toBe('active')
      await expect(inviteePage.getByRole('button', { name: '接受工作区邀请', exact: true })).toHaveCount(0)
      await expect(inviteePage.getByRole('button', { name: '刷新成员列表', exact: true })).toBeEnabled({ timeout: 15_000 })
      await expect(inviteePage.getByRole('status').filter({ hasText: '正在切换工作区' })).toHaveCount(0)
      await expect(inviteePage.getByRole('form', { name: '邀请工作区成员' })).toHaveCount(0)
      await inviteePage.screenshot({ path: resolve(output, 'invitation-accepted.png'), fullPage: true })
      const repeated = await inviteeContext.request.post(`${origin}/api/mcp`, {
        headers: { origin, 'x-workspace-id': fixture.workspaceId, 'x-ops-workbench': 'workspace' },
        data: { jsonrpc: '2.0', id: 'owned-repeat-invitation', method: 'workspace.invitation.accept', params: { expected_revision: '2', reason: 'owned duplicate acceptance verification' } },
      })
      // Once active, this finance member no longer has the pending-invite
      // exception. The authorization gate rejects repetition before dispatch.
      expect(repeated.status()).toBe(403)
      expect((await repeated.json()).error?.code).toBe('FORBIDDEN')
      const acceptAudits = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM workspace_operation_audit WHERE workspace_id=$1 AND resource_id=$2 AND action='workspace.invitation.accept'", [fixture.workspaceId, invited])
      expect(acceptAudits.rows).toEqual([{ count: 1 }])
      invitationProbe.acceptedViaBrowser = true
      invitationProbe.staleAcceptanceStatus = 409
      invitationProbe.refreshedRole = 'finance'
      invitationProbe.repeatAcceptanceStatus = repeated.status()
      invitationProbe.acceptAuditCount = 1
    } finally { await inviteeContext.close() }
    await page.getByRole('button', { name: '刷新成员列表', exact: true }).click()
    await expect(page.getByRole('row').filter({ hasText: '隔离邀请成员' })).toContainText('已激活')
    const invitedRow = page.getByRole('row').filter({ hasText: '隔离邀请成员' })
    await invitedRow.getByRole('button', { name: '调整 隔离邀请成员 的角色', exact: true }).click()
    const roleForm = page.getByRole('form', { name: '成员变更' })
    await roleForm.getByLabel('新角色').selectOption('support')
    await roleForm.getByLabel('操作原因').fill('隔离浏览器验收角色调整')
    await roleForm.getByRole('button', { name: '确认改角色' }).click()
    await expect(invitedRow).toContainText('支持', { timeout: 30_000 })
    expect((await members.list(fixture.workspaceId)).find(member => member.externalSubject === invited)?.role).toBe('support')
    const freshContext = await browser.newContext()
    const freshLogin = await freshContext.request.post(`${origin}/api/v1/auth/login`, { headers: { origin }, data: { login: invited, password: inviteePassword, account_type: 'merchant' } })
    expect(freshLogin.status()).toBe(200)
    const freshToken = await freshContext.request.post(`${origin}/api/v1/auth/mcp-token`, { headers: { origin }, data: { workspace_id: fixture.workspaceId } })
    expect(freshToken.status()).toBe(200)
    const ownedAccessToken = (await freshToken.json()).data?.access_token as string
    expect(typeof ownedAccessToken).toBe('string')
    const ownCall = async (method: string, params = {}) => {
      const response = await freshContext.request.post(`${origin}/api/mcp`, { headers: { origin, authorization: `Bearer ${ownedAccessToken}`, 'x-workspace-id': fixture.workspaceId }, data: { jsonrpc: '2.0', id: 'owned-member-lifecycle', method, params } })
      const body = await response.json()
      return { status: response.status(), code: body.error?.code ?? null, result: body.data?.result }
    }
    const freshSession = await ownCall('ops.session')
    expect(freshSession.status).toBe(200)
    expect(freshSession.result.capabilities.includes('workspace.member.manage')).toBe(false)
    const escalation = await ownCall('ops.member.upsert', { external_subject: invited, role: 'merchant_admin', expected_revision: String((await members.list(fixture.workspaceId)).find(member => member.externalSubject === invited)!.revision), reason: 'owned negative privilege escalation verification' })
    expect(escalation.status).toBe(403)
    expect((await members.list(fixture.workspaceId)).find(member => member.externalSubject === invited)?.role).toBe('support')
    await invitedRow.getByRole('button', { name: '停用 隔离邀请成员', exact: true }).click()
    const suspendForm = page.getByRole('form', { name: '成员变更' })
    await suspendForm.getByLabel('操作原因').fill('隔离浏览器验收停用')
    await suspendForm.getByRole('button', { name: '确认停用' }).click()
    await expect(invitedRow).toContainText('已停用', { timeout: 30_000 })
    expect((await members.list(fixture.workspaceId)).find(member => member.externalSubject === invited)?.status).toBe('suspended')
    const revoked = await ownCall('ops.session')
    expect([401, 403]).toContain(revoked.status)
    const refusedToken = await freshContext.request.post(`${origin}/api/v1/auth/mcp-token`, { headers: { origin }, data: { workspace_id: fixture.workspaceId } })
    expect(refusedToken.status()).toBe(409)
    const memberLifecycle = { freshLoginStatus: freshLogin.status(), activeTokenStatus: freshToken.status(), manageCapability: false, escalationStatus: escalation.status, revokedBearerStatus: revoked.status, suspendedTokenStatus: refusedToken.status() }
    await freshContext.close()
    expect(pageErrors).toEqual([])
    await page.screenshot({ path: resolve(output, 'merchant-members-invited.png'), fullPage: true })
    await writeFile(resolve(output, 'result.json'), JSON.stringify({ status: 'passed', auth: 'real-isolated-merchant-password-and-scoped-mcp-bearer', workspaceId: fixture.workspaceId, readVisible: true, concurrentIssuance, invitationProbe, memberLifecycle, invitePersisted: true, roleChangePersisted: true, suspendPersisted: true, browserErrors: pageErrors, productionBrowser: false }, null, 2), { mode: 0o600 })
  } finally {
    await browser?.close().catch(() => undefined)
    await pool.end()
    await authPool.end()
  }
}

runOpsE2e(['dogfood/chatgpt-all-functions/ops-members-global-isolated.spec.js'], { ...process.env, OPS_E2E_MERCHANT_UI: 'true' }, verify)
  .then(code => { process.exitCode = code }, error => { console.error(error instanceof Error ? error.message : 'MERCHANT_MEMBERS_ISOLATED_FAILED'); process.exitCode = 1 })
