import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openPlatformConsole } from './ops-auth.js'

if (!process.env.OPS_E2E_OUTPUT_DIR || !process.env.MERCHANT_STUDIO_URL || !process.env.OPS_E2E_WORKSPACE_ID) throw new Error('ISOLATED_MERCHANT_OPS_RUNNER_REQUIRED')
test.use({ channel: 'chrome', viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai', actionTimeout: 30000 })
test.setTimeout(180000)

// Real same-origin cookie sessions, API handlers and isolated PostgreSQL.
// Operations replies go through the real platform GUI and explicit authorized
// enterprise selector; no tenant workbench or permission bypass is used.
test('merchant without an order submits durable support and reads only own customer-visible replies', async ({ page, browser }) => {
  const output = join(process.env.OPS_E2E_OUTPUT_DIR, 'commercial-support')
  await mkdir(output, { recursive: true })
  await openPlatformConsole(page, '/ops/overview')
  const opsRpc = (method, params) => page.evaluate(async ({ method, params }) => {
    const response = await fetch('/api/mcp', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-ops-workbench': 'platform' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) })
    const envelope = await response.json()
    return { status: response.status, body: envelope.data ?? envelope }
  }, { method, params: { ...params, target_workspace_id: process.env.OPS_E2E_WORKSPACE_ID } })
  const merchant = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' })
  try {
    const studio = await merchant.newPage()
    const writes = []
    studio.on('request', request => { if (request.url().endsWith('/api/mcp') && request.method() === 'POST') writes.push(request.postDataJSON()?.method) })
    await studio.goto(new URL('/merchant/login', process.env.MERCHANT_STUDIO_URL).href)
    await studio.getByPlaceholder('例如 merchant@example.com').fill(process.env.OPS_E2E_MERCHANT_USERNAME)
    await studio.getByPlaceholder('请输入商家密码').fill(process.env.OPS_E2E_MERCHANT_PASSWORD)
    const loginResponse = studio.waitForResponse(response => response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST')
    await studio.getByRole('button', { name: '登录商家工作台', exact: true }).click()
    expect((await loginResponse).status()).toBe(200)
    await expect(studio.getByRole('button', { name: '登录商家工作台', exact: true })).toBeHidden({ timeout: 30000 })
    await studio.goto(new URL('/merchant/finance', process.env.MERCHANT_STUDIO_URL).href)
    await studio.getByRole('button', { name: /^(首单前需要人工支持|提交人工支持)$/u }).first().click()
    const support = studio.getByRole('region', { name: '首单前人工支持', exact: true })
    await expect(support).toBeVisible()
    const subject = `无订单开户支持 ${randomUUID().slice(0, 8)}`
    await support.getByLabel('问题标题', { exact: true }).fill(subject)
    await support.getByLabel('问题说明', { exact: true }).fill('还没有订单，希望运营说明首购开通费与首期费如何核对。')
    const submitted = studio.waitForResponse(response => response.url().endsWith('/api/v1/support/requests') && response.request().method() === 'POST')
    await support.getByRole('button', { name: '提交人工支持', exact: true }).click()
    const response = await submitted
    expect(response.status()).toBe(201)
    const envelope = await response.json()
    const receipt = envelope.data ?? envelope
    expect(receipt).toMatchObject({ submitted: true, replayed: false, status: 'open' })
    expect(receipt.ticket_id).toMatch(/^[0-9a-f-]{36}$/u)
    await expect(support).toContainText(receipt.ticket_number)
    await studio.screenshot({ path: join(output, '01-real-no-order-receipt.png'), fullPage: true })
    const detail = await opsRpc('ops.support.platform.ticket.get', { ticket_id: receipt.ticket_id })
    expect(detail.status, JSON.stringify(detail.body)).toBe(200)
    expect(detail.body.error).toBeUndefined()
    const ticket = detail.body.result.ticket
    expect(ticket.relatedOrderId ?? null).toBeNull()
    expect(ticket.relatedTaskId ?? null).toBeNull()
    const internal = 'QA仅内部调查不可对客户公开'
    const publicReply = 'QA运营已核对首购资料，请以独立开通费和首期订单明细为准。'
    await page.goto(new URL('/ops/support', process.env.OPS_BASE_URL).href)
    await page.getByRole('button', { name: '读取授权企业目录', exact: true }).click()
    await page.getByRole('combobox', { name: '选择支持目标企业', exact: true }).click()
    // Ant Select renders a hidden virtual ARIA option plus a separate visible
    // row. Click that real visible row rather than its screen-reader mirror.
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: process.env.OPS_E2E_WORKSPACE_ID }).click()
    await page.getByRole('button', { name: '读取企业工单', exact: true }).click()
    await page.getByRole('button', { name: `查看 ${receipt.ticket_number}`, exact: true }).click()
    await expect(page.getByText('无订单 / 无任务', { exact: true })).toBeVisible()
    for (const [body, visibility] of [[internal, 'internal'], [publicReply, 'customer']]) {
      await page.getByRole('combobox', { name: '平台回复可见范围', exact: true }).click()
      await page.locator('.ant-select-dropdown:visible').getByText(visibility === 'customer' ? '客户可见回复' : '仅内部备注', { exact: true }).click()
      await page.getByRole('textbox', { name: '平台支持回复正文', exact: true }).fill(body)
      await page.getByRole('button', { name: '预览真实工单回复', exact: true }).click()
      const replied = page.waitForResponse(response => response.url().endsWith('/api/mcp') && response.request().postDataJSON()?.method === 'ops.support.platform.ticket.comment')
      await page.getByRole('button', { name: visibility === 'customer' ? '确认记录客户可见回复' : '确认记录内部备注', exact: true }).click()
      const result = await replied
      expect(result.status()).toBe(200)
      const envelope = await result.json()
      expect((envelope.data ?? envelope).error).toBeUndefined()
      await expect(page.getByRole('textbox', { name: '平台支持回复正文', exact: true })).toHaveValue('')
    }
    await page.screenshot({ path: join(output, '02-real-platform-support-reply.png'), fullPage: true })
    await support.getByRole('button', { name: '查询本人客户可见回复', exact: true }).click()
    await expect(support).toContainText(publicReply)
    await expect(support).not.toContainText(internal)
    await studio.screenshot({ path: join(output, '02-customer-visible-reply-only.png'), fullPage: true })
    // Provision a second real merchant in the SAME existing enterprise through
    // the authorized invitation API, then activate/login and create its ticket.
    // No paid qualification, financial facts or synthetic grant is introduced.
    const otherLogin = `qa-other-${randomUUID()}@example.test`
    const invitation = await page.evaluate(async input => {
      const response = await fetch('/api/v1/ops/merchant-accounts', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-ops-workbench': 'platform' }, body: JSON.stringify(input) })
      return { status: response.status, envelope: await response.json() }
    }, { login: otherLogin, enterprise_name: '同企业隔离验收', contact_name: '另一个真实测试成员', workspace_ids: [process.env.OPS_E2E_WORKSPACE_ID], create_workspace: false, reason: '隔离fixture本人支持权限验收', idempotency_key: `qa-invite-${randomUUID()}` })
    expect(invitation.status, JSON.stringify(invitation.envelope.error ?? { code: invitation.envelope.code })).toBe(201)
    const invitationData = invitation.envelope.data ?? invitation.envelope
    expect(invitationData).toMatchObject({ commercial_qualification_granted: false, capabilities_granted: [] })
    const token = new URLSearchParams(new URL(invitationData.invitation.activation_link).hash.slice(1)).get('token')
    expect(token).toBeTruthy()
    const other = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    let foreignId
    try {
      const otherPage = await other.newPage()
      await otherPage.goto(new URL('/merchant/login', process.env.MERCHANT_STUDIO_URL).href)
      const password = `OwnedQa-${randomUUID()}-9`
      const activated = await otherPage.evaluate(async input => {
        const response = await fetch('/api/v1/auth/merchant-activation', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
        return { status: response.status }
      }, { token, password, terms_agreed: true })
      expect(activated.status).toBe(200)
      await otherPage.getByPlaceholder('例如 merchant@example.com').fill(otherLogin)
      await otherPage.getByPlaceholder('请输入商家密码').fill(password)
      const otherLoginResponse = otherPage.waitForResponse(response => response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST')
      await otherPage.getByRole('button', { name: '登录商家工作台', exact: true }).click()
      expect((await otherLoginResponse).status()).toBe(200)
      await expect(otherPage.getByRole('button', { name: '登录商家工作台', exact: true })).toBeHidden({ timeout: 30000 })
      const foreign = await otherPage.evaluate(async id => {
        const response = await fetch('/api/v1/support/requests', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: '其他客户同企业支持工单', message: '另一个真实同企业登录成员提交自己的支持问题', idempotency_key: `qa-other-${id}` }) })
        return { status: response.status, envelope: await response.json() }
      }, randomUUID())
      expect(foreign.status).toBe(201)
      foreignId = (foreign.envelope.data ?? foreign.envelope).ticket_id
    } finally { await other.close() }
    const denied = await studio.evaluate(async id => { const response = await fetch(`/api/v1/support/requests/${id}`, { credentials: 'include' }); return { status: response.status, body: await response.json() } }, foreignId)
    expect(denied.status).toBe(404)
    expect(JSON.stringify(denied.body)).not.toContain('其他客户同企业支持工单')
    expect(writes.filter(method => /(?:order\.create|checkout\.create|payment\.create|receipt\.)/u.test(method ?? ''))).toEqual([])
  } finally { await merchant.close() }
})
