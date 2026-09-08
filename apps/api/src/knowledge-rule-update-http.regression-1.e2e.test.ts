import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type ApiModule = typeof import('./server.js')
type Envelope = { data: { result: Record<string, unknown> } | null; error: { code: string; message?: string } | null }

let api: ApiModule
let base = ''

async function call(token: string, workspaceId: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { workspace_id: workspaceId, ...params } }),
  })
  return { status: response.status, body: await response.json() as Envelope }
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'knowledge-rule-update-regression-secret')
  api = await import('./server.js')
  await new Promise<void>((resolve, reject) => {
    api.server.once('error', reject)
    api.server.listen(0, '127.0.0.1', resolve)
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (api?.server.listening) {
    api.server.closeAllConnections()
    await new Promise<void>(resolve => api.server.close(() => resolve()))
  }
  vi.unstubAllEnvs()
})

describe('knowledge rule update over authenticated HTTP', () => {
  // Regression: ISSUE-001 — Ops buttons called a rule update method without a safe executable contract
  // Found by /qa on 2026-09-08
  // Report: .gstack/qa-reports/qa-report-127-0-0-1-2026-09-08.md
  it('enforces role, revision, audit reason, and unverified-source activation boundaries', async () => {
    const suffix = crypto.randomUUID().slice(0, 8)
    const workspaceId = `ws_rule_update_${suffix}`
    const rulesActor = `rules-admin-${suffix}`
    const ownerActor = `owner-${suffix}`
    const rulesToken = `rules-token-${suffix}`
    const ownerToken = `owner-token-${suffix}`
    await Promise.all([
      api.workspaceMembers.upsert({ workspaceId, externalSubject: rulesActor, displayName: rulesActor, role: 'support', status: 'active', invitedBy: 'qa-regression' }),
      api.workspaceMembers.upsert({ workspaceId, externalSubject: ownerActor, displayName: ownerActor, role: 'workspace_owner', status: 'active', invitedBy: 'qa-regression' }),
    ])
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [rulesToken]: { workspaces: [workspaceId], actor_id: rulesActor, roles: ['rules_admin'] },
      [ownerToken]: { workspaces: [workspaceId], actor_id: ownerActor, roles: ['workspace_owner'] },
    }))

    const session = await call(rulesToken, workspaceId, 'ops.session', {})
    expect(session.body.data!.result).toMatchObject({ capabilities: expect.arrayContaining(['rule.update']) })
    expect((session.body.data!.result.capabilities as string[])).not.toContain('customer.content.update')

    const create = await call(rulesToken, workspaceId, 'knowledge.rule.create', {
      name: '可信平台规则', content: '不得使用绝对化承诺', scope: 'global', source_kind: 'official',
      source_reference: 'https://rules.example.test/current', source_checked_at: '2026-09-08T00:00:00.000Z',
      version: '1', status: 'draft',
    })
    expect(create.status, JSON.stringify(create.body)).toBe(200)
    const created = create.body.data!.result as { id: string; revision: number }

    const denied = await call(ownerToken, workspaceId, 'knowledge.rule.update', { rule_id: created.id, status: 'active', expected_revision: '1', reason: '尝试越权激活规则' })
    expect(denied).toMatchObject({ status: 403, body: { error: { code: 'FORBIDDEN' } } })

    const activated = await call(rulesToken, workspaceId, 'knowledge.rule.update', { rule_id: created.id, status: 'active', expected_revision: '1', reason: '规则来源已复核，批准激活' })
    expect(activated.status, JSON.stringify(activated.body)).toBe(200)
    expect(activated.body.data!.result).toMatchObject({ id: created.id, status: 'active', revision: 2 })

    const stale = await call(rulesToken, workspaceId, 'knowledge.rule.update', { rule_id: created.id, status: 'inactive', expected_revision: '1', reason: '使用过期页面尝试停用' })
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'VERSION_CONFLICT' } } })

    const manual = await call(rulesToken, workspaceId, 'knowledge.rule.create', {
      name: '未验证人工规则', content: '尚未取得官方依据', scope: 'global', source_kind: 'internal',
      source_reference: 'manual://pending-source', source_checked_at: '2026-09-08T00:00:00.000Z',
      version: '1', status: 'draft',
    })
    const manualRule = manual.body.data!.result as { id: string }
    const blocked = await call(rulesToken, workspaceId, 'knowledge.rule.update', { rule_id: manualRule.id, status: 'active', expected_revision: '1', reason: '尝试激活未验证规则' })
    expect(blocked).toMatchObject({ status: 409, body: { error: { code: 'RULE_SOURCE_UNVERIFIED' } } })
  })
})
