import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const videoRelay = vi.hoisted(() => ({
  generate: vi.fn(async () => ({ status: 'queued' as const, providerJobId: 'video-job-http-e2e' })),
  getStatus: vi.fn(async (providerJobId: string) => ({ status: 'completed' as const, providerJobId, videoUrl: 'https://cdn.example.test/video-job-http-e2e.mp4' })),
}))

vi.mock('../../../packages/ai/src/video-generator.js', () => ({
  createVideoGeneratorFromEnv: () => videoRelay,
}))

type Envelope<T = unknown> = {
  workspace_id: string
  data: { jsonrpc: '2.0'; id: string; result: T } | null
  error: { code: string; message?: string; details?: Record<string, unknown> } | null
}

type McpResponse<T = unknown> = { status: number; body: Envelope<T> }
type ApiModule = typeof import('./server.js')

let api: ApiModule
let base = ''

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
  return `http://127.0.0.1:${address.port}`
}

async function callMcp<T = unknown>(
  token: string,
  workspaceId: string,
  method: string,
  params: Record<string, unknown> = {},
  paramsWorkspaceId = workspaceId,
): Promise<McpResponse<T>> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-workspace-id': workspaceId,
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
  expect(response.status).toBe(200)
  expect(response.body.error).toBeNull()
  expect(response.body.data).not.toBeNull()
  return response.body.data!.result
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'mcp-content-knowledge-http-session-secret')
  vi.stubEnv('MODEL_RELAY_BASE_URL', 'https://relay.example.test')
  vi.stubEnv('VIDEO_MODEL_RELAY_API_KEY', 'video-relay-test-key')
  vi.stubEnv('VIDEO_MODEL', 'video-e2e-v1')
  api = await import('./server.js')
})

afterAll(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('content and knowledge MCP methods over real HTTP', () => {
  it('covers all 16 methods plus shared validation, authorization, tenant, and idempotency negatives', async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    const workspaceId = `ws_mcp_content_knowledge_${suffix}`
    const foreignWorkspaceId = `ws_mcp_content_knowledge_foreign_${suffix}`
    const actors = {
      rules: `rules-owner-${suffix}`,
      owner: `owner-only-${suffix}`,
      operator: `operator-${suffix}`,
    }
    const tokens = {
      rules: `rules-token-${suffix}`,
      owner: `owner-token-${suffix}`,
      operator: `operator-token-${suffix}`,
    }

    await Promise.all([
      api.workspaceMembers.upsert({ workspaceId, externalSubject: actors.rules, displayName: actors.rules, role: 'workspace_owner', status: 'active', invitedBy: 'mcp-http-e2e' }),
      api.workspaceMembers.upsert({ workspaceId, externalSubject: actors.owner, displayName: actors.owner, role: 'workspace_owner', status: 'active', invitedBy: 'mcp-http-e2e' }),
      api.workspaceMembers.upsert({ workspaceId, externalSubject: actors.operator, displayName: actors.operator, role: 'operator', status: 'active', invitedBy: 'mcp-http-e2e' }),
    ])
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [tokens.rules]: { workspaces: [workspaceId], actor_id: actors.rules, roles: ['workspace_owner', 'rules_admin'] },
      [tokens.owner]: { workspaces: [workspaceId], actor_id: actors.owner, roles: ['workspace_owner'] },
      [tokens.operator]: { workspaces: [workspaceId], actor_id: actors.operator, roles: ['operator'] },
    }))

    const account = api.service.registerPlatformAccount({
      workspaceId,
      platform: 'taobao',
      remoteAccountId: `taobao-${suffix}`,
      credentialRef: `fixture://${workspaceId}/taobao`,
    })
    const product = api.service.importProduct({
      workspaceId,
      platform: 'taobao',
      accountId: account.id,
      localProductKey: `product-${suffix}`,
      title: 'HTTP E2E 春季外套',
      category: '女装外套',
      stock: 12,
    })
    api.service.confirmProductFacts(workspaceId, product.id)

    const creativeTask = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
    const contentTask = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
    api.service.selectDirection(contentTask.id, 'A')
    api.service.confirmProductionPlan(workspaceId, contentTask.id, actors.rules)
    const sourceVersion = api.service.createDraft(contentTask.id)
    const restoreExpectedVersion = api.service.getTask(contentTask.id).version
    const generationTask = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
    api.service.selectDirection(generationTask.id, 'A')
    api.service.confirmProductionPlan(workspaceId, generationTask.id, actors.rules)
    const generationJob = api.service.enqueueGeneration({ workspaceId, taskId: generationTask.id, idempotencyKey: `generation-${suffix}` })

    base = await start()

    const directions = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'creative.directions.update', {
      task_id: creativeTask.id,
      action: 'regenerate',
      feedback: '强化真实通勤场景',
      expected_version: String(creativeTask.version),
    }))
    expect(directions).toMatchObject({ task: { id: creativeTask.id }, directions: expect.arrayContaining([expect.objectContaining({ id: expect.stringContaining('-v1') })]) })

    const generation = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'generation.get', { job_id: generationJob.id }))
    expect(generation).toMatchObject({ id: generationJob.id, workspaceId, taskId: generationTask.id, state: 'queued' })

    const restored = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'content.restore', {
      content_version_id: sourceVersion.id,
      expected_version: String(restoreExpectedVersion),
    }))
    expect(restored).toMatchObject({ source: { id: sourceVersion.id }, version: { parentId: sourceVersion.id, state: 'review_required' } })

    const rule = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'knowledge.rule.create', {
      name: 'HTTP E2E 平台规则',
      content: '标题必须基于已确认商品事实',
      scope: 'global',
      source_kind: 'internal',
      source_reference: `test://${suffix}/rule`,
      source_checked_at: '2026-08-28T00:00:00.000Z',
      version: '1.0.0',
      status: 'draft',
      severity: 'warning',
      action: 'warn',
      tags_json: JSON.stringify(['http-e2e']),
    }))
    expect(rule).toMatchObject({ workspaceId, name: 'HTTP E2E 平台规则', scope: 'global', status: 'draft' })

    const rules = resultOf<any[]>(await callMcp(tokens.rules, workspaceId, 'knowledge.rule.list', { status: 'draft', text: 'HTTP E2E' }))
    expect(rules).toContainEqual(expect.objectContaining({ id: rule.id, workspaceId }))

    const asset = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'knowledge.asset.create', {
      kind: 'brand',
      name: 'HTTP E2E 品牌指南',
      content_json: JSON.stringify({ tone: '克制清晰', forbidden: ['绝对化承诺'] }),
      source: `test://${suffix}/asset`,
      tags_json: JSON.stringify(['brand', 'http-e2e']),
      approval_status: 'pending',
      rights_status: 'unknown',
    }))
    expect(asset).toMatchObject({ workspaceId, kind: 'brand', approvalStatus: 'pending', rightsStatus: 'unknown' })

    const updatedAsset = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'knowledge.asset.update', {
      asset_id: asset.id,
      approval_status: 'approved',
      rights_status: 'cleared',
      tags_json: JSON.stringify(['brand', 'approved', 'http-e2e']),
    }))
    expect(updatedAsset).toMatchObject({ id: asset.id, approvalStatus: 'approved', rightsStatus: 'cleared', revision: asset.revision + 1 })

    const assets = resultOf<any[]>(await callMcp(tokens.rules, workspaceId, 'knowledge.asset.list', { kind: 'brand', tags_json: JSON.stringify(['http-e2e']) }))
    expect(assets).toContainEqual(expect.objectContaining({ id: asset.id, workspaceId }))

    const feedbackOne = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'knowledge.feedback.record', {
      kind: 'platform_rejection',
      platform: 'taobao',
      content_id: sourceVersion.id,
      reason: '缺少材质依据',
      details: '材质描述需要引用已确认资料',
      metadata_json: JSON.stringify({ source: 'http-e2e' }),
    }))
    expect(feedbackOne).toMatchObject({ feedback: { workspaceId, kind: 'platform_rejection' }, suggestions: [expect.objectContaining({ status: 'pending' })] })

    const feedbackTwo = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'knowledge.feedback.record', {
      kind: 'feedback',
      reason: '语气过度营销',
      details: '保持克制并删除绝对化措辞',
    }))
    expect(feedbackTwo.suggestions).toHaveLength(1)

    const pending = resultOf<any[]>(await callMcp(tokens.rules, workspaceId, 'knowledge.learning.list', { status: 'pending' }))
    expect(pending.map(item => item.id)).toEqual(expect.arrayContaining([feedbackOne.suggestions[0].id, feedbackTwo.suggestions[0].id]))

    const confirmed = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'knowledge.learning.confirm', {
      suggestion_id: feedbackOne.suggestions[0].id,
      note: '已核对平台回执，仅保留为人工确认建议',
    }))
    expect(confirmed).toMatchObject({ id: feedbackOne.suggestions[0].id, status: 'confirmed', confirmedBy: actors.rules })

    const dismissed = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'knowledge.learning.dismiss', {
      suggestion_id: feedbackTwo.suggestions[0].id,
      note: '该反馈不适用于当前品类',
    }))
    expect(dismissed).toMatchObject({ id: feedbackTwo.suggestions[0].id, status: 'dismissed' })

    const competitor = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'knowledge.competitor.create', {
      competitor_name: '公开竞品甲',
      source_json: JSON.stringify({ url: 'https://example.test/public-product', title: '公开商品页', accessedAt: '2026-08-28T00:00:00.000Z' }),
      summary: '公开页面采用场景、功能和行动号召结构。',
      structure_json: JSON.stringify({ sections: ['场景', '功能', '行动号召'], layout: ['首屏突出主体'] }),
      selling_points_json: JSON.stringify(['便携', '易清洁']),
      expression_json: JSON.stringify({ tone: ['直接'], formats: ['短句'], callsToAction: ['查看详情'] }),
    }))
    expect(competitor).toMatchObject({ workspaceId, competitorName: '公开竞品甲' })

    const competitors = resultOf<any[]>(await callMcp(tokens.rules, workspaceId, 'knowledge.competitor.list', { competitor_name: '公开竞品甲' }))
    expect(competitors).toContainEqual(expect.objectContaining({ id: competitor.id, workspaceId }))

    const reference = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'knowledge.competitor.reference', {
      competitor_id: competitor.id,
      own_brand_name: '自有品牌乙',
      own_selling_points_json: JSON.stringify(['静音', '可追溯材质']),
    }))
    expect(reference).toMatchObject({ referenceMode: 'differentiation_only', compliance: { originalTextCopied: false, competitorBrandReused: false } })

    const recharge = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'billing.recharge.create', {
      channel: 'alipay',
      amount_cny: '10.00',
      idempotency_key: `video-wallet-${suffix}`,
    }))
    resultOf(await callMcp(tokens.rules, workspaceId, 'billing.recharge.get', { order_id: recharge.id, confirm_test_payment: 'true' }))
    const videoRequest = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'multimodal.video.request', {
      prompt: '生成基于已确认商品事实的通勤场景短视频',
      output: 'rendering',
      context_json: JSON.stringify({
        brand: { id: 'brand-http-e2e', version: '1' },
        product: { id: product.id, version: String(product.version) },
        rules: [{ id: rule.id, version: rule.version }],
      }),
    }))
    expect(videoRequest).toMatchObject({ rendering: { status: 'queued', providerJobId: 'video-job-http-e2e' } })

    const video = resultOf<any>(await callMcp(tokens.rules, workspaceId, 'multimodal.video.get', { provider_job_id: 'video-job-http-e2e' }))
    expect(video).toMatchObject({ provider_job_id: 'video-job-http-e2e', status: 'completed', videoUrl: 'https://cdn.example.test/video-job-http-e2e.mp4', execution: { providerExecuted: true } })
    expect(videoRelay.getStatus).toHaveBeenCalledWith('video-job-http-e2e')

    const missingRequired = await callMcp(tokens.rules, workspaceId, 'generation.get')
    expect(missingRequired.status).toBe(400)
    expect(missingRequired.body.error?.code).toBe('INVALID_REQUEST')
    expect(missingRequired.body.error?.message).toContain('params.job_id is required')

    const extraField = await callMcp(tokens.rules, workspaceId, 'knowledge.rule.list', { unexpected: 'not-allowed' })
    expect(extraField.status).toBe(400)
    expect(extraField.body.error?.code).toBe('INVALID_REQUEST')
    expect(extraField.body.error?.message).toContain('params.unexpected is not accepted')

    const invalidEnum = await callMcp(tokens.rules, workspaceId, 'creative.directions.update', { task_id: creativeTask.id, action: 'explode' })
    expect(invalidEnum.status).toBe(400)
    expect(invalidEnum.body.error?.code).toBe('INVALID_REQUEST')
    expect(invalidEnum.body.error?.message).toContain('params.action has an unsupported value')

    const forbiddenRole = await callMcp(tokens.owner, workspaceId, 'knowledge.rule.create', {
      name: '无 rules_admin 的规则', content: '不应创建', scope: 'global', source_kind: 'internal',
      source_reference: `test://${suffix}/forbidden`, source_checked_at: '2026-08-28T00:00:00.000Z', version: '1', status: 'draft',
    })
    expect(forbiddenRole.status).toBe(403)
    expect(forbiddenRole.body.error?.code).toBe('FORBIDDEN')

    const tenantMismatch = await callMcp(tokens.rules, workspaceId, 'knowledge.asset.list', {}, foreignWorkspaceId)
    expect(tenantMismatch.status).toBe(403)
    expect(tenantMismatch.body.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')

    const restoreReplay = await callMcp(tokens.rules, workspaceId, 'content.restore', {
      content_version_id: sourceVersion.id,
      expected_version: String(restoreExpectedVersion),
    })
    expect(restoreReplay.status).toBe(409)
    expect(restoreReplay.body.error?.code).toBe('VERSION_CONFLICT')

    const adHocIdempotency = await callMcp(tokens.operator, workspaceId, 'knowledge.feedback.record', {
      kind: 'feedback',
      reason: '不接受未声明的幂等参数',
      idempotency_key: `unsupported-${suffix}`,
    })
    expect(adHocIdempotency.status).toBe(400)
    expect(adHocIdempotency.body.error?.code).toBe('INVALID_REQUEST')
    expect(adHocIdempotency.body.error?.message).toContain('params.idempotency_key is not accepted')
  }, 30_000)
})
