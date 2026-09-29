import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type ApiModule = typeof import('./server.js')
let api: ApiModule
let base = ''

async function callMcp(token: string, workspaceId: string, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { workspace_id: workspaceId, ...params } }),
  })
  return { status: response.status, body: await response.json() as { data: { result: any } | null; error: { code: string } | null } }
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'isolated-knowledge-reference-session-secret')
  api = await import('./server.js')
  await new Promise<void>((resolve, reject) => {
    api.server.once('error', reject)
    api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', reject); resolve() })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP 测试服务未启动')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('竞品差异化引用隔离链路', () => {
  it('允许同工作区引用，只追加可追责审计，拒绝跨工作区引用', async () => {
    const suffix = crypto.randomUUID()
    const own = `ws_knowledge_reference_${suffix.replaceAll('-', '')}`
    const foreign = `ws_knowledge_foreign_${suffix.replaceAll('-', '')}`
    const actor = `knowledge-reference-${suffix}`
    const ownToken = `knowledge-reference-own-${suffix}`
    const foreignToken = `knowledge-reference-foreign-${suffix}`
    await api.workspaceMembers.upsert({ workspaceId: own, externalSubject: actor, displayName: actor, role: 'workspace_owner', status: 'active', invitedBy: 'isolated-e2e' })
    await api.workspaceMembers.upsert({ workspaceId: foreign, externalSubject: `${actor}-foreign`, displayName: '其他工作区', role: 'workspace_owner', status: 'active', invitedBy: 'isolated-e2e' })
    await api.grantCreativePointsForTests(own)
    api.grantContinuousFeatureEntitlementForTests(own)
    await api.grantCreativePointsForTests(foreign)
    api.grantContinuousFeatureEntitlementForTests(foreign)
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [ownToken]: { workspaces: [own], actor_id: actor, roles: ['workspace_owner', 'rules_admin', 'knowledge_editor', 'competitor_reviewer'] },
      [foreignToken]: { workspaces: [foreign], actor_id: `${actor}-foreign`, roles: ['workspace_owner', 'competitor_reviewer'] },
    }))

    const created = await callMcp(ownToken, own, 'knowledge.competitor.create', {
      competitor_name: '隔离测试公开竞品',
      source_json: JSON.stringify({ url: 'https://example.test/public-product', title: '公开测试资料', accessedAt: '2026-09-29T00:00:00.000Z' }),
      summary: '测试资料只包含公开页面结构。',
      structure_json: JSON.stringify({ sections: ['场景', '规格'], layout: ['首屏产品'] }),
      selling_points_json: JSON.stringify(['易清洁']),
      expression_json: JSON.stringify({ tone: ['简洁'], formats: ['短句'] }),
    })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const competitor = created.body.data?.result as { id: string; workspaceId: string }
    expect(competitor.workspaceId).toBe(own)

    const before = await callMcp(ownToken, own, 'knowledge.competitor.list')
    expect(before.status).toBe(200)
    const referenced = await callMcp(ownToken, own, 'knowledge.competitor.reference', {
      competitor_id: competitor.id,
      own_brand_name: '测试自有品牌',
      own_selling_points_json: JSON.stringify(['材质可追溯']),
    })
    expect(referenced.status, JSON.stringify(referenced.body)).toBe(200)
    expect(referenced.body.data?.result).toMatchObject({ competitorAnalysisId: competitor.id, referenceMode: 'differentiation_only', compliance: { originalTextCopied: false, competitorBrandReused: false } })
    const after = await callMcp(ownToken, own, 'knowledge.competitor.list')
    expect(after.body.data?.result).toEqual(before.body.data?.result)
    expect((await api.operationAudits.list(own)).filter(item => item.action === 'knowledge.competitor.reference' && item.resourceId === competitor.id)).toHaveLength(1)

    const denied = await callMcp(foreignToken, foreign, 'knowledge.competitor.reference', {
      competitor_id: competitor.id,
      own_brand_name: '其他自有品牌',
      own_selling_points_json: '[]',
    })
    expect(denied.status).toBe(400)
    expect(denied.body.error?.code).toBe('COMPETITOR_NOT_FOUND')
    expect((await api.operationAudits.list(foreign)).filter(item => item.action === 'knowledge.competitor.reference')).toHaveLength(0)

    const rule = await callMcp(ownToken, own, 'knowledge.rule.create', {
      name: '隔离测试草稿规则', content: '必须核对商品事实', scope: 'global', source_kind: 'internal',
      source_reference: `test://${suffix}/rule`, source_checked_at: '2026-09-29T00:00:00.000Z', version: 'qa-1', status: 'draft',
    })
    expect(rule.status, JSON.stringify(rule.body)).toBe(200)
    expect(rule.body.data?.result).toMatchObject({ workspaceId: own, status: 'draft' })

    const asset = await callMcp(ownToken, own, 'knowledge.asset.create', {
      kind: 'brand', name: '隔离测试品牌资料', content_json: JSON.stringify({ tone: '清晰' }),
    })
    expect(asset.status, JSON.stringify(asset.body)).toBe(200)
    const assetId = (asset.body.data?.result as { id: string }).id
    const updatedAsset = await callMcp(ownToken, own, 'knowledge.asset.update', {
      asset_id: assetId, content_json: JSON.stringify({ tone: '准确' }),
    })
    expect(updatedAsset.status, JSON.stringify(updatedAsset.body)).toBe(200)
    expect(updatedAsset.body.data?.result).toMatchObject({ id: assetId, workspaceId: own, content: { tone: '准确' } })

    const preference = await callMcp(ownToken, own, 'knowledge.brand.preference.update', {
      preferences_json: JSON.stringify({ tone: '准确' }), version: 'qa-1', status: 'draft',
    })
    expect(preference.status, JSON.stringify(preference.body)).toBe(200)
    expect(preference.body.data?.result).toMatchObject({ workspaceId: own, version: 'qa-1', status: 'draft' })

    const feedbackOne = await callMcp(ownToken, own, 'knowledge.feedback.record', { kind: 'feedback', reason: '测试反馈甲' })
    const feedbackTwo = await callMcp(ownToken, own, 'knowledge.feedback.record', { kind: 'feedback', reason: '测试反馈乙' })
    expect(feedbackOne.status, JSON.stringify(feedbackOne.body)).toBe(200)
    expect(feedbackTwo.status, JSON.stringify(feedbackTwo.body)).toBe(200)
    const suggestionOne = (feedbackOne.body.data?.result as { suggestions: Array<{ id: string }> }).suggestions[0]?.id
    const suggestionTwo = (feedbackTwo.body.data?.result as { suggestions: Array<{ id: string }> }).suggestions[0]?.id
    expect(suggestionOne).toBeTruthy()
    expect(suggestionTwo).toBeTruthy()

    const confirmed = await callMcp(ownToken, own, 'knowledge.learning.confirm', { suggestion_id: suggestionOne, note: '隔离测试人工确认' })
    const dismissed = await callMcp(ownToken, own, 'knowledge.learning.dismiss', { suggestion_id: suggestionTwo, note: '隔离测试不适用' })
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200)
    expect(confirmed.body.data?.result).toMatchObject({ id: suggestionOne, status: 'confirmed' })
    expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200)
    expect(dismissed.body.data?.result).toMatchObject({ id: suggestionTwo, status: 'dismissed' })

    const expectedActions = ['knowledge.competitor.create', 'knowledge.competitor.reference', 'knowledge.rule.create',
      'knowledge.asset.create', 'knowledge.asset.update', 'knowledge.brand.preference.update',
      'knowledge.feedback.record', 'knowledge.learning.confirm', 'knowledge.learning.dismiss']
    const auditActions = (await api.operationAudits.list(own, 100)).map(item => item.action)
    for (const action of expectedActions) expect(auditActions, action).toContain(action)
    expect(auditActions.filter(action => action === 'knowledge.feedback.record')).toHaveLength(2)

    const forbiddenRule = await callMcp(foreignToken, foreign, 'knowledge.rule.create', {
      name: '其他工作区不应创建', content: '禁止', scope: 'global', source_kind: 'internal',
      source_reference: `test://${suffix}/forbidden`, source_checked_at: '2026-09-29T00:00:00.000Z', version: 'qa-1', status: 'draft',
    })
    expect(forbiddenRule.status).toBe(403)
    expect(forbiddenRule.body.error?.code).toBe('FORBIDDEN')
  }, 20_000)
})
