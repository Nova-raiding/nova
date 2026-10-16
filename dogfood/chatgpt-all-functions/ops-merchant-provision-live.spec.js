import { expect, test } from '@playwright/test'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'
import { assertLoopbackHttpOrigin } from './loopback-origin.js'

const opsBase = process.env.OPS_BASE_URL
const merchantBase = process.env.MERCHANT_STUDIO_URL
if (!opsBase || !merchantBase) throw new Error('ISOLATED_OPS_RUNNER_REQUIRED')
assertLoopbackHttpOrigin(opsBase)
assertLoopbackHttpOrigin(merchantBase)

// Explicitly opt in to a new QA identity. Never use this against a customer
// workspace or infer payment verification from successful account creation.
test.setTimeout(180_000)
test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test('platform operator invites an isolated QA merchant who activates and logs in', async ({ page, browser }) => {
  page.setDefaultTimeout(30_000)
  const workspaceId = process.env.OPS_PROVISION_QA_WORKSPACE_ID
  const outputDir = process.env.OPS_PROVISION_OUTPUT_DIR
  expect(process.env.OPS_PROVISION_RUN).toBe('true')
  expect(workspaceId).toMatch(/^ws_[A-Za-z0-9_-]+$/)
  expect(process.env.OPS_PROVISION_QA_WORKSPACE_CONFIRMED).toBe(workspaceId)
  expect(outputDir).toBeTruthy()
  const runId = randomUUID()
  const login = `qa-e2e-${runId}@example.test`
  const password = `Qa${randomBytes(24).toString('hex')}9`
  const fillPrivatePassword = async locator => {
    try { await locator.fill(password) }
    catch { throw new Error('OWNED_MERCHANT_PASSWORD_FIELD_UNAVAILABLE_VALUE_REDACTED') }
  }
  const evidence = { runId, login, workspaceId, events: [], completed: false }
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  try {
    await openPlatformConsole(page, '/ops/users')
    // This is the supported production workflow. Public registration remains
    // disabled; the legacy application review route is not a prerequisite.
    await page.getByRole('button', { name: /更多/u }).click()
    await page.getByRole('menuitem', { name: '开通商家账号', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '邀请客户激活登录账号' })
    await dialog.getByLabel('商家登录邮箱', { exact: true }).fill(login)
    await dialog.getByLabel('企业名称', { exact: true }).fill(`QA-DO-NOT-PUBLISH-${runId}`)
    await dialog.getByLabel('联系人', { exact: true }).fill('QA E2E')
    await dialog.getByLabel('企业工作区', { exact: true }).click()
    // Ant Design's accessible option mirror is intentionally hidden; use
    // the actual combobox keyboard interaction instead of clicking it.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await dialog.getByLabel('搜索要绑定的企业工作区', { exact: true }).fill(workspaceId)
    await dialog.getByRole('button', { name: '查询企业工作区', exact: true }).click()
    await dialog.getByLabel('目标企业', { exact: true }).click()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await dialog.getByLabel('开户或邀请原因', { exact: true }).fill(`QA isolated account acceptance ${runId}`)
    const responsePromise = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/v1/ops/merchant-accounts'))
    await dialog.getByRole('button', { name: '创建账号与安全邀请', exact: true }).click()
    const response = await responsePromise
    const body = await response.json()
    evidence.events.push({ stage: 'invite', status: response.status(), requestId: body.request_id, errorCode: body.error?.code ?? null })
    expect(response.status()).toBe(201)
    expect(body.error).toBeNull()
    expect(body.data.account).toMatchObject({ login, accountType: 'merchant', status: 'merchant_pending', workspaceIds: [workspaceId] })
    expect(body.data.invitation.status).toBe('pending_activation')
    expect(body.data.commercial_qualification_granted).toBe(false)
    expect(body.data.capabilities_granted).toEqual([])
    expect(body.data.invitation.delivery_status).toBe('not_sent')
    await expect(dialog).toContainText('账号与邀请已登记，等待客户激活', { timeout: 30_000 })
    // The secret remains only in this process. Never rewrite an incorrectly
    // configured invitation URL or persist its fragment in evidence.
    const activationLink = body.data.invitation.activation_link
    let activationUrl
    try { activationUrl = new URL(activationLink) }
    catch { throw new Error('OWNED_MERCHANT_ACTIVATION_URL_INVALID_VALUE_REDACTED') }
    expect(activationUrl.origin === new URL(merchantBase).origin, 'invitation must target the explicitly configured merchant gateway').toBe(true)
    expect(activationUrl.pathname === '/api/v1/auth/merchant-activation', 'invitation must use the real merchant API proxy path').toBe(true)
    expect(/^#token=[A-Za-z0-9_-]{32,128}$/u.test(activationUrl.hash), 'one-time activation fragment is required').toBe(true)
    const merchantContext = await browser.newContext()
    try {
      const merchant = await merchantContext.newPage()
      try { await merchant.goto(activationLink, { waitUntil: 'domcontentloaded' }) }
      catch { throw new Error('OWNED_MERCHANT_ACTIVATION_NAVIGATION_FAILED_SECRET_URL_REDACTED') }
      await expect(merchant.getByRole('heading', { name: '激活商家登录账号', exact: true })).toBeVisible()
      expect(new URL(merchant.url()).hash === '', 'activation page must remove the invitation fragment').toBe(true)
      await fillPrivatePassword(merchant.getByLabel('设置密码（8–256位，包含字母和数字）', { exact: true }))
      await fillPrivatePassword(merchant.getByLabel('再次输入密码', { exact: true }))
      await merchant.getByRole('checkbox').check()
      const activationPromise = merchant.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/auth/merchant-activation')
      await merchant.getByRole('button', { name: '确认设密并激活登录', exact: true }).click()
      const activated = await activationPromise
      const activationBody = await activated.json()
      expect(activated.status()).toBe(200)
      expect(activationBody.data).toMatchObject({ activated: true, login_required: true, commercial_qualification_granted: false })
      await expect(merchant.getByRole('status')).toContainText('登录账号已激活')
      evidence.events.push({ stage: 'customer_activation', status: activated.status(), requestId: activationBody.request_id, commercialQualificationGranted: false })
      await merchant.goto(merchantBase, { waitUntil: 'domcontentloaded' })
      await merchant.getByLabel('商家账号', { exact: true }).fill(login)
      await fillPrivatePassword(merchant.getByLabel('密码', { exact: true }))
      const loggedPromise = merchant.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/v1/auth/login'))
      await merchant.getByRole('button', { name: '登录商家工作台', exact: true }).click()
      const logged = await loggedPromise
      evidence.events.push({ stage: 'merchant_login', status: logged.status() })
      expect(logged.status()).toBe(200)
      const session = await merchant.request.get(new URL('/api/v1/auth/session', merchant.url()).toString())
      const sessionBody = await session.json()
      expect(session.status()).toBe(200)
      expect(sessionBody.data.account).toMatchObject({ login, accountType: 'merchant', workspaceIds: [workspaceId] })
      evidence.events.push({ stage: 'merchant_session', status: session.status(), requestId: sessionBody.request_id })
      expect(sessionBody.data.account.status).toBe('active')
      const origin = new URL(merchantBase).origin
      const tokenResponse = await merchant.request.post(`${origin}/api/v1/auth/mcp-token`, { headers: { origin }, data: { workspace_id: workspaceId } })
      expect(tokenResponse.status()).toBe(200)
      const accessToken = (await tokenResponse.json()).data?.access_token
      expect(typeof accessToken === 'string', 'activated fixture merchant must obtain its own workspace credential').toBe(true)
      const authority = await merchant.request.post(`${origin}/api/mcp`, {
        headers: { origin, authorization: `Bearer ${accessToken}`, 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' },
        data: { jsonrpc: '2.0', id: 'owned-merchant-invite-session', method: 'ops.session', params: {} },
      })
      const authorityBody = await authority.json()
      expect(authority.status()).toBe(200)
      const permission = authorityBody.data?.result
      expect(permission.workbench).toBe('workspace')
      expect(permission.roles.some(role => ['platform_ops', 'platform_admin', 'ops_admin'].includes(role))).toBe(false)
      evidence.events.push({ stage: 'merchant_authorization', status: authority.status(), requestId: authorityBody.request_id, workbench: permission.workbench, platformRoleGranted: false })
      evidence.completed = true
    } finally { await merchantContext.close() }
  } finally {
    // No raw requests, passwords, cookies or payment assertions in evidence.
    await writeFile(resolve(outputDir, 'merchant-provision-evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  }
})
