import { expect, test } from '@playwright/test'

const studioUrl = process.env.MERCHANT_STUDIO_URL ?? 'http://127.0.0.1:4188'
const workspaceA = 'ws_support_replies_a'
const workspaceB = 'ws_support_replies_b'
const ticketA = 'ticket-for-workspace-a'
const ticketB = 'ticket-for-workspace-b'
const envelope = (workspace, data) => ({ request_id: 'support-replies-workspace-switch', trace_id: 'support-replies-workspace-switch', workspace_id: workspace, data, warnings: [], next_actions: [], error: null })

test.setTimeout(60_000)
test.use({ viewport: { width: 1440, height: 1000 } })

test('support reply panel keeps B reply when an A reply request resolves after workspace switch', async ({ page }) => {
  let releaseAReply
  let aReplyStartedResolve
  const aReplyStarted = new Promise(resolve => { aReplyStartedResolve = resolve })
  const delayedAReply = new Promise(resolve => { releaseAReply = resolve })
  const replyRequests = []
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/u, '')
    const workspace = request.headers()['x-workspace-id'] ?? null
    let data = { items: [], total: 0, limit: 50, offset: 0 }
    if (path === '/v1/auth/session') {
      data = { account: { id: 'support-replies-race-account', login: 'support-race@example.invalid', accountType: 'merchant', status: 'active', workspaceIds: [workspaceA, workspaceB] } }
    } else if (path === '/v1/auth/mcp-token') {
      const target = request.postDataJSON()?.workspace_id ?? workspaceA
      data = { access_token: `token-${target}`, refresh_token: `refresh-${target}`, expires_in: 300, workspace_id: target }
    } else if (path === '/healthz') {
      data = { status: 'ok', writesEnabled: false, connectors: {}, persistence: { mode: 'fixture', ready: true }, setup: { platformOperations: { mode: 'manual', ready: true } } }
    } else if (path === '/mcp') {
      const { method, params = {} } = request.postDataJSON()
      if (method === 'support.customer.replies.list') {
        replyRequests.push({ workspace, ticketId: params.ticket_id })
        const isA = workspace === workspaceA
        if (isA) {
          aReplyStartedResolve()
          await delayedAReply
        }
        const ticketId = isA ? ticketA : ticketB
        const suffix = isA ? 'A' : 'B'
        data = { result: { ticket: { ticket_number: `SN-${suffix}-100`, subject: `工作区${suffix}专属支持问题`, status: 'open' }, replies: [{ id: `reply-${suffix}`, body: `仅工作区${suffix}可见的客户回复`, created_at: '2026-10-11T00:00:00.000Z' }], tickets: [], next_cursor: null, ticket_id: ticketId } }
      } else if (method === 'workspace.metrics') data = { result: { stores: [], productSummary: { total: 0, lowStock: 0, missingImages: 0 }, riskItems: [], riskSummary: { total: 0, returned: 0, truncated: false }, taskFunnel: {} } }
      else data = { result: {} }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(workspace, data)) })
  })

  await page.goto(`${studioUrl}/merchant/overview`, { waitUntil: 'domcontentloaded' })
  const bootstrap = page.getByRole('combobox', { name: '选择当前商家工作区 ID' })
  await expect(bootstrap).toBeVisible()
  await bootstrap.click()
  await page.getByText(`工作区 ID · ${workspaceA}`, { exact: true }).last().click()
  await page.getByRole('button', { name: '联系客服经理' }).click()
  let panel = page.getByRole('dialog', { name: '支持消息' })
  await expect(panel).toBeVisible()
  await panel.getByLabel('客服工单 ID').fill(ticketA)
  await panel.getByRole('button', { name: '读取客户回复' }).click()
  await aReplyStarted

  await panel.getByRole('button', { name: '关闭支持消息' }).click()
  const workspacePicker = page.getByRole('combobox', { name: '按工作区 ID 切换当前商家工作区' })
  await workspacePicker.click()
  await page.getByText(`工作区 ID · ${workspaceB}`, { exact: true }).last().click()
  await page.getByRole('button', { name: '联系客服经理' }).click()
  panel = page.getByRole('dialog', { name: '支持消息' })
  await panel.getByLabel('客服工单 ID').fill(ticketB)
  await panel.getByRole('button', { name: '读取客户回复' }).click()
  await expect(panel).toContainText('SN-B-100 · 工作区B专属支持问题 · open')
  await expect(panel).toContainText('仅工作区B可见的客户回复')
  await expect(panel).not.toContainText('工作区A')

  releaseAReply()
  await expect(panel).toContainText('仅工作区B可见的客户回复')
  await expect(panel).not.toContainText('工作区A')
  expect(replyRequests).toEqual([{ workspace: workspaceA, ticketId: ticketA }, { workspace: workspaceB, ticketId: ticketB }])
  expect(pageErrors).toEqual([])
})
