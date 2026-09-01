import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { creativePointsForTests, server, service, workspaceMembers } from './server.js'

type WorkspaceRole = 'workspace_owner' | 'merchant_admin' | 'operator' | 'support' | 'finance' | 'platform_ops'
type Envelope<T = unknown> = {
  workspace_id: string
  data: { jsonrpc: '2.0'; id: string; result: T } | null
  error: { code: string; message?: string; details?: Record<string, unknown> } | null
}
type McpResponse<T = unknown> = { status: number; body: Envelope<T> }

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function configureBearerMembers(entries: Array<{
  token: string
  workspaceId: string
  actorId: string
  role: WorkspaceRole
  grantWorkspaces?: string[]
  gatewayRoles?: string[]
  workbenches?: Array<'workspace' | 'platform'>
}>) {
  const grants: Record<string, { workspaces: string[]; actor_id: string; roles: string[]; workbenches?: Array<'workspace' | 'platform'> }> = {}
  for (const entry of entries) {
    grants[entry.token] = {
      workspaces: entry.grantWorkspaces ?? [entry.workspaceId],
      actor_id: entry.actorId,
      roles: entry.gatewayRoles ?? [entry.role],
      ...(entry.workbenches ? { workbenches: entry.workbenches } : {}),
    }
    await workspaceMembers.upsert({
      workspaceId: entry.workspaceId,
      externalSubject: entry.actorId,
      displayName: entry.actorId,
      role: entry.role,
      status: 'active',
      invitedBy: 'mcp-completion-ops-e2e',
    })
  }
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify(grants))
}

async function callMcp<T = unknown>(
  base: string,
  token: string,
  headerWorkspaceId: string,
  method: string,
  params: Record<string, unknown> = {},
  paramsWorkspaceId = headerWorkspaceId,
): Promise<McpResponse<T>> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-workspace-id': headerWorkspaceId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params: { workspace_id: paramsWorkspaceId, ...params },
    }),
  })
  return { status: response.status, body: await response.json() as Envelope<T> }
}

function resultOf<T>(response: McpResponse<T>): T {
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  expect(response.body.error).toBeNull()
  expect(response.body.data).not.toBeNull()
  return response.body.data!.result
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'mcp-completion-session-hash-secret')
  vi.stubEnv('DELETION_REQUEST_GRACE_DAYS', '7')
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('MCP completion operations per-method HTTP evidence', () => {
  it('executes enabled completion methods and proves disabled commercial methods, contracts, authorization, tenant isolation, and idempotency', async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    const workspaceA = `ws_mcp_completion_a_${suffix}`
    const workspaceB = `ws_mcp_completion_b_${suffix}`
    const tokens = {
      ownerA: `owner-a-${suffix}`,
      adminA: `admin-a-${suffix}`,
      secondAdminA: `admin-second-a-${suffix}`,
      operatorA: `operator-a-${suffix}`,
      supportA: `support-a-${suffix}`,
      financeA: `finance-a-${suffix}`,
      platformA: `platform-a-${suffix}`,
      commercialFinance: `commercial-finance-${suffix}`,
      commercialOps: `commercial-ops-${suffix}`,
      ownerB: `owner-b-${suffix}`,
      adminB: `admin-b-${suffix}`,
    }
    await configureBearerMembers([
      { token: tokens.ownerA, workspaceId: workspaceA, actorId: `owner-a-${suffix}`, role: 'workspace_owner' },
      { token: tokens.adminA, workspaceId: workspaceA, actorId: `admin-a-${suffix}`, role: 'merchant_admin' },
      { token: tokens.secondAdminA, workspaceId: workspaceA, actorId: `admin-second-a-${suffix}`, role: 'merchant_admin' },
      { token: tokens.operatorA, workspaceId: workspaceA, actorId: `operator-a-${suffix}`, role: 'operator' },
      { token: tokens.supportA, workspaceId: workspaceA, actorId: `support-a-${suffix}`, role: 'support' },
      { token: tokens.financeA, workspaceId: workspaceA, actorId: `finance-a-${suffix}`, role: 'finance' },
      { token: tokens.platformA, workspaceId: workspaceA, actorId: `platform-a-${suffix}`, role: 'platform_ops' },
      { token: tokens.commercialFinance, workspaceId: workspaceA, actorId: `commercial-finance-${suffix}`, role: 'finance', gatewayRoles: ['finance_ops'], workbenches: ['platform'] },
      { token: tokens.commercialOps, workspaceId: workspaceA, actorId: `commercial-ops-${suffix}`, role: 'platform_ops', gatewayRoles: ['platform_ops'], workbenches: ['platform'] },
      { token: tokens.ownerB, workspaceId: workspaceB, actorId: `owner-b-${suffix}`, role: 'workspace_owner' },
      { token: tokens.adminB, workspaceId: workspaceB, actorId: `admin-b-${suffix}`, role: 'merchant_admin' },
    ])

    service.registerPlatformAccount({
      workspaceId: workspaceA,
      platform: 'taobao',
      remoteAccountId: `connected-a-${suffix}`,
      credentialRef: `vault://mcp-completion/${workspaceA}/connected`,
    })
    service.registerPlatformAccount({
      workspaceId: workspaceB,
      platform: 'taobao',
      remoteAccountId: `connected-b-${suffix}`,
      credentialRef: `vault://mcp-completion/${workspaceB}/connected`,
    })
    const revokedAccount = service.registerPlatformAccount({
      workspaceId: workspaceA,
      platform: 'jd',
      remoteAccountId: `revoked-a-${suffix}`,
      credentialRef: `vault://mcp-completion/${workspaceA}/revoked`,
    })
    service.revokePlatformAccount(workspaceA, revokedAccount.id, 'jd')

    const base = await start()

    for (const [method, params, token] of [
      ['workspace.commercial.get', {}, tokens.ownerA],
      ['workspace.commercial.update', { plan_code: 'legacy-plan', plan_name: 'Legacy Plan' }, tokens.ownerA],
      ['workspace.usage.get', {}, tokens.ownerA],
      ['billing.usage.consume', { task_id: 'legacy-task', idempotency_key: 'legacy-consume' }, tokens.ownerA],
      ['billing.usage.refund', { task_id: 'legacy-task', idempotency_key: 'legacy-consume', reason: 'legacy refund' }, tokens.financeA],
      ['billing.refund', { order_id: 'legacy-order', reason: 'legacy refund' }, tokens.financeA],
      ['ops.commercial.offers.list', {}, tokens.commercialFinance],
      ['ops.commercial.addons.list', {}, tokens.commercialFinance],
      ['ops.commercial.coupons.list', {}, tokens.commercialFinance],
      ['ops.commercial.rollouts.list', {}, tokens.commercialOps],
    ] as const) {
      const disabled = await callMcp(base, token, workspaceA, method, params)
      expect(disabled.status, method).toBe(503)
      expect(disabled.body.error, method).toMatchObject({
        code: 'COMMERCIAL_OPERATION_DISABLED',
        details: { next_actions: ['commercial.access.get', 'creative-points.balance.get'] },
      })
    }

    await Promise.all([workspaceA, workspaceB].map(workspaceId => creativePointsForTests.grant({
      workspaceId,
      idempotencyKey: `mcp-completion-grant-${workspaceId}`,
      sourceType: 'paid_order',
      sourceId: `mcp-completion-order-${workspaceId}`,
      points: 10_000,
    })))

    const orders = resultOf<any[]>(await callMcp(base, tokens.ownerA, workspaceA, 'subscription.orders.list', { limit: '10' }))
    expect(orders).toEqual([])
    const members = resultOf<any[]>(await callMcp(base, tokens.operatorA, workspaceA, 'ops.members.list'))
    expect(members).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalSubject: `owner-a-${suffix}`, role: 'workspace_owner', status: 'active' }),
      expect.objectContaining({ externalSubject: `finance-a-${suffix}`, role: 'finance', status: 'active' }),
    ]))

    expect(resultOf<any>(await callMcp(base, tokens.financeA, workspaceA, 'billing.export', { format: 'json', limit: '20' }))).toMatchObject({
      filename: `billing-${workspaceA}.json`,
      contentType: 'application/json',
      content: '[]',
    })
    expect(resultOf<any>(await callMcp(base, tokens.operatorA, workspaceA, 'billing.export', { format: 'json', limit: '20' }))).toMatchObject({
      scope: 'mine',
      filename: 'my-billing.json',
      contentType: 'application/json',
    })
    expect(resultOf<any>(await callMcp(base, tokens.financeA, workspaceA, 'billing.model-usage.reconciliation.run', { limit: '10' }))).toMatchObject({
      state: 'completed', checked: 0, settled: [], pending: [], actor_id: `finance-a-${suffix}`,
    })

    const alerts = resultOf<any[]>(await callMcp(base, tokens.commercialOps, workspaceA, 'ops.alerts.list', {
      status: 'open',
      code: 'OAUTH_REAUTH_REQUIRED',
      entity_id: revokedAccount.id,
    }))
    expect(alerts).toHaveLength(1)
    const acknowledged = resultOf<any>(await callMcp(base, tokens.commercialOps, workspaceA, 'ops.alert.ack', {
      alert_id: alerts[0].id,
      reason: '已联系商家重新授权',
    }))
    expect(acknowledged).toMatchObject({ id: alerts[0].id, workspaceId: workspaceA, status: 'acknowledged', acknowledgedBy: `commercial-ops-${suffix}` })
    const acknowledgedList = resultOf<any[]>(await callMcp(base, tokens.commercialOps, workspaceA, 'ops.alerts.list', {
      status: 'acknowledged', entity_id: revokedAccount.id,
    }))
    expect(acknowledgedList).toEqual([expect.objectContaining({ id: alerts[0].id, acknowledgementReason: '已联系商家重新授权' })])

    const cancelKey = `delete-cancel-${suffix}`
    const vagueDeletionReason = await callMcp(base, tokens.ownerA, workspaceA, 'workspace.data.delete.request', {
      scope: 'assets', reason: '删', idempotency_key: `delete-vague-${suffix}`,
    })
    expect(vagueDeletionReason.body.error?.code).toBe('INVALID_REQUEST')
    const cancelRequest = resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'workspace.data.delete.request', {
      scope: 'assets', reason: '清理测试素材', idempotency_key: cancelKey,
    }))
    const cancelReplay = resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'workspace.data.delete.request', {
      scope: 'assets', reason: '清理测试素材', idempotency_key: cancelKey,
    }))
    expect(cancelReplay).toMatchObject({ id: cancelRequest.id, status: 'pending', execution: 'pending_external_approval' })
    const deletionConflict = await callMcp(base, tokens.ownerA, workspaceA, 'workspace.data.delete.request', {
      scope: 'business', reason: '改变同一幂等键意图', idempotency_key: cancelKey,
    })
    expect(deletionConflict.body.error?.code).toBe('DATA_DELETION_IDEMPOTENCY_CONFLICT')
    const cancelled = resultOf<any>(await callMcp(base, tokens.adminA, workspaceA, 'ops.data.delete.cancel', {
      request_id: cancelRequest.id, reason: '商家撤回删除申请',
    }))
    expect(cancelled).toMatchObject({ id: cancelRequest.id, workspaceId: workspaceA, status: 'cancelled', cancelledBy: `admin-a-${suffix}` })

    const approveRequest = resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'workspace.data.delete.request', {
      scope: 'business', reason: '业务数据删除演练', idempotency_key: `delete-approve-${suffix}`,
    }))
    const firstApproval = resultOf<any>(await callMcp(base, tokens.adminA, workspaceA, 'ops.data.delete.approve', {
      request_id: approveRequest.id, reason: '管理员复核通过',
    }))
    expect(firstApproval).toMatchObject({ status: 'pending', approvals: [expect.objectContaining({ actorId: `admin-a-${suffix}` })] })
    const secondApproval = resultOf<any>(await callMcp(base, tokens.secondAdminA, workspaceA, 'ops.data.delete.approve', {
      request_id: approveRequest.id, reason: '平台运营二次复核通过',
    }))
    expect(secondApproval).toMatchObject({ status: 'approved' })
    expect(secondApproval.approvals).toHaveLength(2)

    const foreignRequest = resultOf<any>(await callMcp(base, tokens.ownerB, workspaceB, 'workspace.data.delete.request', {
      scope: 'workspace', reason: 'B 租户删除演练', idempotency_key: `delete-foreign-${suffix}`,
    }))
    const foreignCancelAttempt = await callMcp(base, tokens.ownerA, workspaceA, 'ops.data.delete.cancel', {
      request_id: foreignRequest.id, reason: '跨租户撤销尝试',
    })
    expect(foreignCancelAttempt.body.data).toBeNull()
    expect(foreignCancelAttempt.body.error).not.toBeNull()
    const listedA = resultOf<any[]>(await callMcp(base, tokens.supportA, workspaceA, 'ops.data.delete.list', { limit: '20' }))
    const listedB = resultOf<any[]>(await callMcp(base, tokens.ownerB, workspaceB, 'ops.data.delete.list', { limit: '20' }))
    expect(listedA.map(item => item.id)).not.toContain(foreignRequest.id)
    expect(listedA).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: cancelRequest.id, status: 'cancelled' }),
      expect.objectContaining({ id: approveRequest.id, status: 'approved' }),
    ]))
    expect(listedB).toEqual([expect.objectContaining({ id: foreignRequest.id, workspaceId: workspaceB, status: 'pending' })])

    const extraParameter = await callMcp(base, tokens.ownerA, workspaceA, 'subscription.orders.list', { unexpected: 'rejected' })
    const invalidEnum = await callMcp(base, tokens.financeA, workspaceA, 'billing.export', { format: 'xml' })
    const invalidAlertStatus = await callMcp(base, tokens.operatorA, workspaceA, 'ops.alerts.list', { status: 'closed' })
    expect(extraParameter.body.error?.code).toBe('INVALID_REQUEST')
    expect(invalidEnum.body.error?.code).toBe('INVALID_REQUEST')
    expect(invalidAlertStatus.body.error?.code).toBe('INVALID_REQUEST')

    const lowPrivilegeCases: Array<{ token: string; method: string; params?: Record<string, unknown> }> = [
      { token: tokens.supportA, method: 'ops.data.delete.cancel', params: { request_id: foreignRequest.id, reason: '低权限撤销' } },
      { token: tokens.supportA, method: 'ops.data.delete.approve', params: { request_id: foreignRequest.id, reason: '低权限审批' } },
      { token: tokens.financeA, method: 'ops.members.list' },
      { token: tokens.financeA, method: 'ops.alert.ack', params: { alert_id: alerts[0].id, reason: '低权限确认' } },
      { token: tokens.operatorA, method: 'billing.model-usage.reconciliation.run', params: { limit: '1' } },
      { token: tokens.operatorA, method: 'workspace.data.delete.request', params: { scope: 'assets', reason: '低权限删除', idempotency_key: `denied-${suffix}` } },
    ]
    for (const testCase of lowPrivilegeCases) {
      const denied = await callMcp(base, testCase.token, workspaceA, testCase.method, testCase.params)
      expect(denied.body.error?.code, testCase.method).toBe('FORBIDDEN')
    }

    const bodyWorkspaceMismatch = await callMcp(base, tokens.ownerA, workspaceA, 'subscription.orders.list', {}, workspaceB)
    expect(bodyWorkspaceMismatch.status).toBe(403)
    expect(bodyWorkspaceMismatch.body.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
    const identityWorkspaceMismatch = await callMcp(base, tokens.ownerA, workspaceB, 'subscription.orders.list')
    expect(identityWorkspaceMismatch.status).toBe(403)
    expect(identityWorkspaceMismatch.body.error?.code).toBe('FORBIDDEN')
  }, 30_000)
})
