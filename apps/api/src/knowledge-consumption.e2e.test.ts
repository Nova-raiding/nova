import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
type Envelope<T = unknown> = {
  workspace_id: string
  data: { result: T } | null
  error: { code: string; message?: string } | null
}
type RestEnvelope<T = unknown> = { workspace_id: string; data: T | null; error: { code: string; message?: string } | null }

let base = ''
let api: typeof import('./server.js')

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    api.server.once('error', onError)
    api.server.listen(0, '127.0.0.1', () => {
      api.server.removeListener('error', onError)
      resolve()
    })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  base = `http://127.0.0.1:${address.port}`
}

async function call<T>(workspaceId: string, token: string, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { workspace_id: workspaceId, ...params } }),
  })
  return { status: response.status, body: await response.json() as Envelope<T> }
}

describe('merchant knowledge consumption over the real API boundary', () => {
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'knowledge-consumption-session-secret')
    vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
    vi.stubEnv('MERCHANT_TEST_APPROVED_RATES', 'true')
    const workspaceId = `ws_knowledge_consumption_${Date.now()}`
    const token = `knowledge-consumption-token-${workspaceId}`
    vi.stubEnv('KNOWLEDGE_CONSUMPTION_WORKSPACE', workspaceId)
    vi.stubEnv('KNOWLEDGE_CONSUMPTION_TOKEN', token)
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: 'rules_admin_consumer', roles: ['workspace_owner', 'rules_admin'] } }))
    api = await import('./server.js')
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: 'rules_admin_consumer', displayName: '知识规则管理员', role: 'workspace_owner', status: 'active', invitedBy: 'knowledge-consumption-e2e' })
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    await start()
  })

  afterAll(async () => {
    if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it('returns the exact frozen workspace rule and approved asset that merchant generation consumed', async () => {
    const workspaceId = process.env.KNOWLEDGE_CONSUMPTION_WORKSPACE!
    const token = process.env.KNOWLEDGE_CONSUMPTION_TOKEN!
    const suffix = crypto.randomUUID().slice(0, 8)
    const ruleResponse = await call(workspaceId, token, 'knowledge.rule.create', {
      name: `商家消费规则 ${suffix}`,
      content: '标题必须引用已确认商品事实，不得做绝对化承诺',
      scope: 'global',
      source_kind: 'internal',
      source_reference: `ops://knowledge-consumption/${suffix}`,
      source_checked_at: '2026-09-09T00:00:00.000Z',
      version: '7.2.0',
      status: 'draft',
      severity: 'warning',
      action: 'warn',
    })
    expect(ruleResponse.status, JSON.stringify(ruleResponse.body)).toBe(200)
    expect(ruleResponse.body.error).toBeNull()
    const rule = ruleResponse.body.data!.result as { id: string; version: string }
    const activated = await call(workspaceId, token, 'knowledge.rule.update', {
      rule_id: rule.id,
      status: 'active',
      expected_revision: '1',
      reason: '运营审核通过，供商家生成消费',
    })
    expect(activated.body.error).toBeNull()

    const assetResponse = await call(workspaceId, token, 'knowledge.asset.create', {
      kind: 'brand',
      name: `商家消费品牌资料 ${suffix}`,
      content_json: JSON.stringify({ tone: '克制清晰' }),
      source: `ops://knowledge-asset/${suffix}`,
      approval_status: 'approved',
      rights_status: 'cleared',
    })
    expect(assetResponse.status, JSON.stringify(assetResponse.body)).toBe(200)
    expect(assetResponse.body.error).toBeNull()
    const asset = assetResponse.body.data!.result as { id: string }

    const account = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `consumer-store-${suffix}`, credentialRef: `fixture://${workspaceId}/taobao` })
    const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: `消费证据商品 ${suffix}`, category: '女装外套', stock: 8 })
    api.service.confirmProductFacts(workspaceId, product.id)
    const task = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
    api.service.selectDirection(task.id, 'A')
    api.service.confirmProductionPlan(workspaceId, task.id, 'rules_admin_consumer')

    const generated = await call<{ knowledgeContext?: { rules: Array<{ id: string; version: string; sourceReference: string }>; assets: Array<{ id: string; name: string; revision: number }> } }>(workspaceId, token, 'content.generate', { task_id: task.id })
    expect(generated.status, JSON.stringify(generated.body)).toBe(200)
    expect(generated.body.error).toBeNull()
    const result = generated.body.data!.result
    expect(result.knowledgeContext?.rules ?? []).toContainEqual(expect.objectContaining({ id: rule.id, version: '7.2.0', sourceReference: `ops://knowledge-consumption/${suffix}` }))
    expect(result.knowledgeContext?.assets ?? []).toContainEqual(expect.objectContaining({ id: asset.id, name: `商家消费品牌资料 ${suffix}`, revision: 1 }))

    const versionsResponse = await fetch(`${base}/v1/tasks/${encodeURIComponent(task.id)}/content-versions`, { headers: { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId } })
    const versions = await versionsResponse.json() as RestEnvelope<Array<{ knowledgeContext?: { rules: Array<{ id: string }>; assets: Array<{ id: string }> } }>>
    expect(versionsResponse.status).toBe(200)
    expect(versions.data?.[0]?.knowledgeContext?.rules.map(item => item.id)).toContain(rule.id)
    expect(versions.data?.[0]?.knowledgeContext?.assets.map(item => item.id)).toContain(asset.id)
  })
})
