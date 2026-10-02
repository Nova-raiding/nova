import { expect, test } from '@playwright/test'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openPlatformConsole } from './ops-auth.js'

// Explicitly opt in to a new QA identity. Never use this against a customer
// workspace or infer payment verification from successful account creation.
test.setTimeout(180_000)
test('platform operator provisions an isolated QA merchant and merchant logs in', async ({ page, browser }) => {
  const workspaceId = process.env.OPS_PROVISION_QA_WORKSPACE_ID
  const outputDir = process.env.OPS_PROVISION_OUTPUT_DIR
  expect(process.env.OPS_PROVISION_RUN).toBe('true')
  expect(workspaceId).toMatch(/^ws_[A-Za-z0-9_-]+$/)
  expect(process.env.OPS_PROVISION_QA_WORKSPACE_CONFIRMED).toBe(workspaceId)
  expect(outputDir).toBeTruthy()
  const runId = randomUUID()
  const login = `qa-e2e-${runId}@example.test`
  const password = `Qa${randomBytes(24).toString('hex')}9`
  const evidence = { runId, login, workspaceId, events: [], completed: false }
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  try {
    await openPlatformConsole(page, '/ops/users')
    // This is the supported production workflow. Public registration remains
    // disabled; the legacy application review route is not a prerequisite.
    await page.getByRole('button', { name: /更多/u }).click()
    await page.getByRole('menuitem', { name: '开通商家账号', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '平台开通商家账号' })
    await dialog.getByLabel('商家登录账号', { exact: true }).fill(login)
    await dialog.getByLabel('临时密码', { exact: true }).fill(password)
    await dialog.getByLabel('企业名称', { exact: true }).fill(`QA-DO-NOT-PUBLISH-${runId}`)
    await dialog.getByLabel('联系人', { exact: true }).fill('QA E2E')
    await dialog.getByLabel('绑定工作区 ID', { exact: true }).fill(workspaceId)
    await dialog.getByLabel('开通原因', { exact: true }).fill(`QA isolated account acceptance ${runId}`)
    const responsePromise = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/v1/ops/merchant-accounts'))
    await dialog.getByRole('button', { name: /开通账号/u }).click()
    const response = await responsePromise
    const body = await response.json()
    evidence.events.push({ stage: 'provision', status: response.status(), requestId: body.request_id, errorCode: body.error?.code ?? null })
    expect(response.status()).toBe(201)
    expect(body.error).toBeNull()
    expect(body.data.account).toMatchObject({ login, accountType: 'merchant', status: 'active', workspaceIds: [workspaceId] })
    expect(body.data.vip_access).toBe('pending_billing_verification')
    // Keep the generated QA credential private for subsequent owner-run tests.
    await writeFile(resolve(outputDir, 'qa-identity.private.json'), JSON.stringify({ login, password, workspaceId, accountId: body.data.account.id }), { mode: 0o600 })
    await expect(dialog).toContainText('账号已开通', { timeout: 30_000 })
    await expect(dialog.getByLabel('临时密码', { exact: true })).toHaveValue('')
    const merchantContext = await browser.newContext()
    try {
      const merchant = await merchantContext.newPage()
      await merchant.goto(process.env.MERCHANT_STUDIO_URL ?? 'https://yxsona.com/', { waitUntil: 'domcontentloaded' })
      await merchant.getByLabel('商家账号', { exact: true }).fill(login)
      await merchant.getByLabel('密码', { exact: true }).fill(password)
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
      evidence.completed = true
    } finally { await merchantContext.close() }
  } finally {
    // No raw requests, passwords, cookies or payment assertions in evidence.
    await writeFile(resolve(outputDir, 'merchant-provision-evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  }
})
