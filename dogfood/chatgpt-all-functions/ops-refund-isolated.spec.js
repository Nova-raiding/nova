import { expect, test } from '@playwright/test'
import { openPlatformConsole, openWorkspaceConsole } from './ops-auth.js'

test.use({ channel: 'chrome', trace: 'off', video: 'off' })
test.setTimeout(120_000)

const workspaceId = process.env.OPS_E2E_WORKSPACE_ID
if (!workspaceId) throw new Error('OPS_E2E_WORKSPACE_ID is required; use the isolated OIDC runner')

function refundListRequests(page) {
  const requests = []
  page.on('request', request => {
    if (request.method() !== 'POST' || !new URL(request.url()).pathname.endsWith('/api/mcp')) return
    try {
      const body = JSON.parse(request.postData() ?? '{}')
      if (body.method === 'ops.commercial.order.refund.list') requests.push(body)
    } catch { /* Malformed requests are handled by the browser and API. */ }
  })
  return requests
}

test('platform role reaches the real refund read and cannot approve an absent request', async ({ page }) => {
  const calls = refundListRequests(page)
  await openPlatformConsole(page, `/ops/finance?workbench=platform&workspace=${encodeURIComponent(workspaceId)}`)
  const panel = page.getByRole('region', { name: '商业订单退款' })
  await expect(panel).toBeVisible()
  await expect(panel.getByText('服务端退款请求与状态')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => calls.length).toBeGreaterThan(0)
  expect(calls.every(call => call.params?.target_workspace_id === workspaceId)).toBe(true)
  await expect(panel.getByRole('button', { name: '双人审批' })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '登记退款并回滚点数' })).toBeDisabled()
})

test('workspace role cannot see platform refund controls or issue a refund-list request', async ({ page }) => {
  const calls = refundListRequests(page)
  await openWorkspaceConsole(page, '/ops/finance?workbench=workspace')
  await expect(page.getByRole('heading', { name: '账务与商业配置' })).toBeVisible()
  await expect(page.getByRole('region', { name: '商业订单退款' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '双人审批' })).toHaveCount(0)
  await page.waitForTimeout(1_000)
  expect(calls).toEqual([])
})

test('platform role without an explicit target workspace does not read refunds', async ({ page }) => {
  const calls = refundListRequests(page)
  await openPlatformConsole(page, '/ops/finance?workbench=platform')
  const panel = page.getByRole('region', { name: '商业订单退款' })
  await expect(panel.getByText('请先指定目标企业主体 Workspace')).toBeVisible()
  await expect(panel.getByRole('button', { name: '双人审批' })).toBeDisabled()
  await page.waitForTimeout(1_000)
  expect(calls).toEqual([])
})

test('platform refund writes pass authorization then reject missing isolated records without mutation', async ({ page }) => {
  await openPlatformConsole(page, `/ops/finance?workbench=platform&workspace=${encodeURIComponent(workspaceId)}`)
  const results = await page.evaluate(async targetWorkspaceId => {
    const requestId = `refund-missing-${crypto.randomUUID()}`
    const attempts = [
      ['request', 'ops.commercial.order.refund.request', { target_workspace_id: targetWorkspaceId, order_id: 'order-does-not-exist', request_id: requestId, refund_kind: 'onboarding_pre_deployment', amount_fen: '100', points_to_revoke: '0', reason: 'isolated missing-order denial probe', evidence_json: '{"deployment_status":"not_started"}' }],
      ['approve', 'ops.commercial.order.refund.approve', { target_workspace_id: targetWorkspaceId, request_id: requestId, reason: 'isolated missing-request denial probe', policy_approval_json: '{"legal_review_ref":"LAW-ISOLATED"}' }],
      ['complete', 'ops.commercial.order.refund.complete', { target_workspace_id: targetWorkspaceId, request_id: requestId, external_refund_id: 'external-not-sent', reason: 'isolated missing-approval denial probe', evidence_json: '{"source":"isolated_denial_probe"}' }],
    ]
    const observed = []
    for (const [action, method, params] of attempts) {
      const response = await fetch('/api/mcp', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-ops-workbench': 'platform', 'idempotency-key': `commercial.refund.${action}:${requestId}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
      })
      const envelope = await response.json()
      observed.push({ action, status: response.status, code: envelope.error?.code ?? envelope.data?.error?.code ?? null })
    }
    return observed
  }, workspaceId)
  expect(results).toEqual([
    { action: 'request', status: 409, code: 'COMMERCIAL_REFUND_ORDER_NOT_FOUND' },
    { action: 'approve', status: 409, code: 'COMMERCIAL_REFUND_STATE_INVALID' },
    { action: 'complete', status: 409, code: 'COMMERCIAL_REFUND_STATE_INVALID' },
  ])
})
