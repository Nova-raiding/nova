import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  server,
  service,
  setRuleRepositoryForTests,
  workspaceMembers,
  type RuleRepositoryPort,
} from './server.js'
import type { PersistedRuleAudit, PersistedRuleVersion } from '../../../packages/persistence/src/index.js'

type MemberRole = 'workspace_owner' | 'merchant_admin' | 'operator' | 'support' | 'finance' | 'platform_ops'
type Envelope<T = unknown> = {
  workspace_id: string
  data: { jsonrpc: '2.0'; id: string; result: T } | null
  error: { code: string; message?: string; details?: Record<string, unknown> } | null
}
type McpResponse<T = unknown> = { status: number; body: Envelope<T> }

class MemoryRuleRepository implements RuleRepositoryPort {
  readonly versions: PersistedRuleVersion[] = []
  readonly audits: PersistedRuleAudit[] = []

  async list(workspaceId: string, packId?: string) {
    return this.versions.filter(item => item.workspaceId === workspaceId && (!packId || item.packId === packId))
  }

  async insertVersion(input: Omit<PersistedRuleVersion, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }) {
    const row = {
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    } as PersistedRuleVersion
    this.versions.push(row)
    return row
  }

  async appendAudit(input: PersistedRuleAudit) {
    this.audits.push(input)
    return input
  }

  async updateStatus(input: { workspaceId: string; id: string; status: string; revision: number; updatedAt?: string; activatedAt?: string | null; deactivatedAt?: string | null }) {
    const row = this.versions.find(item => item.workspaceId === input.workspaceId && item.id === input.id)
    if (!row) throw new Error('RULE_VERSION_NOT_FOUND')
    row.status = input.status
    row.revision = input.revision
    row.updatedAt = input.updatedAt ?? new Date().toISOString()
    row.activatedAt = input.activatedAt
    row.deactivatedAt = input.deactivatedAt
    return row
  }

  async listAudit(workspaceId: string, packId?: string) {
    return this.audits.filter(item => item.workspaceId === workspaceId && (!packId || item.rulePackId === packId))
  }
}

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
  memberRole: MemberRole
  gatewayRoles: string[]
  workbenches?: ('platform' | 'workspace')[]
}>) {
  const grants: Record<string, { workspaces: string[]; actor_id: string; roles: string[]; workbenches?: ('platform' | 'workspace')[] }> = {}
  for (const entry of entries) {
    grants[entry.token] = { workspaces: [entry.workspaceId], actor_id: entry.actorId, roles: entry.gatewayRoles, ...(entry.workbenches ? { workbenches: entry.workbenches } : {}) }
    await workspaceMembers.upsert({
      workspaceId: entry.workspaceId,
      externalSubject: entry.actorId,
      displayName: entry.actorId,
      role: entry.memberRole,
      status: 'active',
      invitedBy: 'mcp-completion-content-e2e',
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
  workbench: 'platform' | 'workspace' = 'workspace',
): Promise<McpResponse<T>> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-workspace-id': headerWorkspaceId,
      'x-ops-workbench': workbench,
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

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'staging')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'mcp-completion-content-session-secret')
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setRuleRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('MCP content and workflow completion per-method HTTP evidence', () => {
  it('executes all 16 methods with shared contract, role, tenant, and idempotency negatives', async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    const workspaceA = `ws_mcp_content_a_${suffix}`
    const workspaceB = `ws_mcp_content_b_${suffix}`
    const tokens = {
      ownerA: `content-owner-a-${suffix}`,
      operatorA: `content-operator-a-${suffix}`,
      platformRulesA: `content-platform-rules-a-${suffix}`,
      ownerB: `content-owner-b-${suffix}`,
    }
    await configureBearerMembers([
      { token: tokens.ownerA, workspaceId: workspaceA, actorId: `content-owner-a-${suffix}`, memberRole: 'workspace_owner', gatewayRoles: ['workspace_owner'] },
      { token: tokens.operatorA, workspaceId: workspaceA, actorId: `content-operator-a-${suffix}`, memberRole: 'operator', gatewayRoles: ['operator'] },
      { token: tokens.platformRulesA, workspaceId: workspaceA, actorId: `content-platform-rules-a-${suffix}`, memberRole: 'workspace_owner', gatewayRoles: ['platform_ops', 'rules_admin', 'workspace_owner'], workbenches: ['platform', 'workspace'] },
      { token: tokens.ownerB, workspaceId: workspaceB, actorId: `content-owner-b-${suffix}`, memberRole: 'workspace_owner', gatewayRoles: ['workspace_owner'] },
    ])

    const account = service.registerPlatformAccount({
      workspaceId: workspaceA,
      platform: 'taobao',
      remoteAccountId: `content-store-${suffix}`,
      credentialRef: `vault://mcp-content/${workspaceA}/taobao`,
    })
    const productTitle = `逐方法双 SKU 外套 ${suffix}`
    const product = service.importProduct({
      workspaceId: workspaceA,
      platform: 'taobao',
      accountId: account.id,
      localProductKey: `content-product-${suffix}`,
      title: productTitle,
      stock: 12,
      price: 199,
      skus: [
        { id: `sku-blue-${suffix}`, name: '蓝色/M', price: 199, stock: 5 },
        { id: `sku-black-${suffix}`, name: '黑色/L', price: 209, stock: 7 },
      ],
    })
    service.confirmProductFacts(workspaceA, product.id)
    const sourceTask = service.createTask({ workspaceId: workspaceA, productId: product.id, platform: 'taobao', accountId: account.id, requestText: '历史任务复制证据' })
    const splitSourceTask = service.createTask({ workspaceId: workspaceA, productId: product.id, platform: 'taobao', accountId: account.id, requestText: '逐 SKU 拆分证据' })
    const syncJob = service.createSyncJob({ workspaceId: workspaceA, platform: 'taobao', accountId: account.id, cursor: `cursor-${suffix}` })
    service.upsertBrandProfile({ workspaceId: workspaceA, name: `证据品牌-${suffix}`, positioning: '可信、克制', tone: ['清晰', '具体'] })

    const ruleRepository = new MemoryRuleRepository()
    setRuleRepositoryForTests(ruleRepository)
    const now = new Date().toISOString()
    const rulePackId = `content-pack-${suffix}`
    const ruleVersion = await ruleRepository.insertVersion({
      id: `rule-${suffix}`,
      workspaceId: workspaceA,
      packId: rulePackId,
      name: '内容测试规则',
      version: '1.0.0',
      scope: 'global',
      status: 'active',
      sourceKind: 'official',
      sourceReference: `official://rules/${suffix}`,
      sourceCheckedAt: now,
      checksum: 'a'.repeat(64),
      checks: { forbidden_terms: ['虚假承诺'] },
      createdBy: `content-platform-rules-a-${suffix}`,
      revision: 1,
    })
    await ruleRepository.appendAudit({
      id: `rule-audit-${suffix}`,
      workspaceId: workspaceA,
      rulePackId,
      ruleVersionId: ruleVersion.id,
      version: ruleVersion.version,
      action: 'activated',
      actorId: `content-platform-rules-a-${suffix}`,
      reason: '逐方法审计 fixture',
      occurredAt: now,
      data: { evidence: 'mcp-http' },
    })

    const base = await start()

    expect(resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'workspace.interactive.confirm', {
      confirmation: 'I_CONFIRM_INTERACTIVE_WRITES',
    }))).toMatchObject({ enabled: true, scope: 'current_interactive_session', automation: 'read_only', ticket: { nonce_hash: expect.stringMatching(/^[a-f0-9]{64}$/u), intent_hash: expect.stringMatching(/^[a-f0-9]{64}$/u), expires_at: expect.any(String) } })

    const usersExport = resultOf<any>(await callMcp(base, tokens.platformRulesA, workspaceA, 'ops.users.export', {
      query: `content-owner-a-${suffix}`,
      status: 'active',
      format: 'json',
      limit: '10',
    }, workspaceA, 'platform'))
    expect(usersExport).toMatchObject({ filename: expect.stringMatching(/^ops-users-\d{4}-\d{2}-\d{2}\.json$/), count: 1, truncated: false })
    expect(JSON.parse(usersExport.content)).toEqual([expect.objectContaining({ external_subject: `content-owner-a-${suffix}`, workspace_id: workspaceA })])

    const commercialExport = resultOf<any>(await callMcp(base, tokens.platformRulesA, workspaceA, 'ops.commercial.export', { format: 'json' }, workspaceA, 'platform'))
    expect(commercialExport).toMatchObject({ filename: expect.stringMatching(/^ops-commercial-\d{4}-\d{2}-\d{2}\.json$/), counts: { offers: expect.any(Number), addons: expect.any(Number), coupons: expect.any(Number), rollouts: expect.any(Number) } })
    expect(JSON.parse(commercialExport.content)).toEqual(expect.objectContaining({ offers: expect.any(Array), addons: expect.any(Array), coupons: expect.any(Array), rollouts: expect.any(Array), modelMarkup: expect.objectContaining({ multiplier: expect.any(Number) }) }))

    const disabled = resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'catalog.product.disable', {
      product_id: product.id,
      reason: '验证保留历史后停用',
    }))
    expect(disabled).toMatchObject({ id: product.id, workspaceId: workspaceA, disabledReason: '验证保留历史后停用', disabledAt: expect.any(String) })
    const enabled = resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'catalog.product.enable', { product_id: product.id }))
    expect(enabled).toMatchObject({ id: product.id, workspaceId: workspaceA })
    expect(enabled.disabledAt).toBeUndefined()

    const syncStatus = resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'rule.sync.status', { interval_hours: '24' }))
    expect(syncStatus).toEqual(expect.any(Object))
    const history = resultOf<any[]>(await callMcp(base, tokens.ownerA, workspaceA, 'rule.history', { pack_id: rulePackId }))
    expect(history).toEqual([expect.objectContaining({ id: ruleVersion.id, workspaceId: workspaceA, status: 'active' })])
    const audit = resultOf<any[]>(await callMcp(base, tokens.platformRulesA, workspaceA, 'rule.audit', { pack_id: rulePackId }, workspaceA, 'platform'))
    expect(audit).toEqual([expect.objectContaining({ id: `rule-audit-${suffix}`, workspaceId: workspaceA, action: 'activated' })])
    const inactiveRule = resultOf<any>(await callMcp(base, tokens.platformRulesA, workspaceA, 'rule.status', {
      pack_id: rulePackId,
      version: '1.0.0',
      status: 'inactive',
      reason: '完成状态变更运行证据',
    }, workspaceA, 'platform'))
    expect(inactiveRule).toMatchObject({ id: ruleVersion.id, workspaceId: workspaceA, status: 'inactive', revision: 2 })

    const brand = resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'brand.get'))
    expect(brand).toMatchObject({ id: `brand_${workspaceA}`, name: `证据品牌-${suffix}`, positioning: '可信、克制' })
    const tonePreview = resultOf<any[]>(await callMcp(base, tokens.ownerA, workspaceA, 'brand.tone.preview', {
      topic: '秋季上新', product_id: product.id,
    }))
    expect(tonePreview).toHaveLength(3)
    expect(tonePreview.map(item => item.id)).toEqual(['tone_a', 'tone_b', 'tone_c'])

    const firstAssetText = `品牌事实 ${suffix}`
    const secondAssetText = `商品说明 ${suffix}`
    const uploaded = resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'asset.upload.batch', {
      assets_json: JSON.stringify([
        { name: `brand-${suffix}.txt`, mime_type: 'text/plain', content_base64: Buffer.from(firstAssetText).toString('base64'), rights_scope: 'owned' },
        { name: `product-${suffix}.txt`, mime_type: 'text/plain', content_base64: Buffer.from(secondAssetText).toString('base64'), rights_scope: 'commercial_authorized' },
      ]),
    }))
    expect(uploaded).toMatchObject({ count: 2, assets: [expect.objectContaining({ workspaceId: workspaceA }), expect.objectContaining({ workspaceId: workspaceA })] })
    expect(uploaded.totalBytes).toBe(Buffer.byteLength(firstAssetText) + Buffer.byteLength(secondAssetText))

    expect(resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'catalog.sync.get', { job_id: syncJob.id }))).toMatchObject({
      id: syncJob.id, workspaceId: workspaceA, accountId: account.id, state: 'queued', resumeCursor: `cursor-${suffix}`,
    })

    const cloned = resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'task.clone', {
      task_id: sourceTask.id,
      request_text: '重新制作无历史促销的内容',
    }))
    expect(cloned).toMatchObject({ sourceTaskId: sourceTask.id, copyMode: 'same_platform_fresh_task', staleContentCopied: false, stalePromotionCopied: false })
    expect(cloned.task).toMatchObject({ workspaceId: workspaceA, productId: product.id, platform: 'taobao' })
    expect(cloned.task.id).not.toBe(sourceTask.id)

    const taskRequestText = `请为${productTitle}在淘宝制作详情页`
    const taskRequestKey = `task-request-${suffix}`
    const requestedTask = resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'task.request.create', {
      request_text: taskRequestText,
      idempotency_key: taskRequestKey,
    }))
    const requestedTaskReplay = resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'task.request.create', {
      request_text: taskRequestText,
      idempotency_key: taskRequestKey,
    }))
    expect(requestedTask).toMatchObject({ mode: 'single_task', replayed: false })
    expect(requestedTaskReplay).toMatchObject({ mode: 'single_task', replayed: true, taskIds: requestedTask.taskIds })
    const taskRequestConflict = await callMcp(base, tokens.ownerA, workspaceA, 'task.request.create', {
      request_text: `请为${productTitle}在淘宝制作主图文案`,
      idempotency_key: taskRequestKey,
    })
    expect(taskRequestConflict.body.error?.code).toBe('IDEMPOTENCY_KEY_REUSED')

    const splitKey = `task-split-${suffix}`
    const split = resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'task.sku.split', {
      task_id: splitSourceTask.id,
      idempotency_key: splitKey,
    }))
    const splitReplay = resultOf<any>(await callMcp(base, tokens.ownerA, workspaceA, 'task.sku.split', {
      task_id: splitSourceTask.id,
      idempotency_key: splitKey,
    }))
    expect(split).toMatchObject({ sourceTaskId: splitSourceTask.id, replayed: false })
    expect(split.skuIds).toHaveLength(2)
    expect(splitReplay).toMatchObject({ sourceTaskId: splitSourceTask.id, taskGroupId: split.taskGroupId, taskIds: split.taskIds, replayed: true })

    const directions = resultOf<any[]>(await callMcp(base, tokens.ownerA, workspaceA, 'creative.directions', { task_id: sourceTask.id }))
    expect(directions).toHaveLength(3)
    expect(directions.map(item => item.id)).toEqual(['A', 'B', 'C'])

    const missingRequired = await callMcp(base, tokens.ownerA, workspaceA, 'catalog.product.disable', { product_id: product.id })
    const extraParameter = await callMcp(base, tokens.ownerA, workspaceA, 'brand.get', { unexpected: 'rejected' })
    const invalidEnum = await callMcp(base, tokens.ownerA, workspaceA, 'workspace.interactive.confirm', { confirmation: 'YES' })
    expect(missingRequired.body.error?.code).toBe('INVALID_REQUEST')
    expect(extraParameter.body.error?.code).toBe('INVALID_REQUEST')
    expect(invalidEnum.body.error?.code).toBe('INVALID_REQUEST')

    const deniedUsersExport = await callMcp(base, tokens.operatorA, workspaceA, 'ops.users.export', { format: 'csv' })
    const deniedRuleAudit = await callMcp(base, tokens.operatorA, workspaceA, 'rule.audit', { pack_id: rulePackId })
    const deniedRuleStatus = await callMcp(base, tokens.operatorA, workspaceA, 'rule.status', {
      pack_id: rulePackId, version: '1.0.0', status: 'expired', reason: '低权限状态变更',
    })
    expect(deniedUsersExport.body.error?.code).toBe('FORBIDDEN')
    expect(deniedRuleAudit.body.error?.code).toBe('FORBIDDEN')
    expect(deniedRuleStatus.body.error?.code).toBe('FORBIDDEN')

    const bodyWorkspaceMismatch = await callMcp(base, tokens.ownerA, workspaceA, 'brand.get', {}, workspaceB)
    expect(bodyWorkspaceMismatch.status).toBe(403)
    expect(bodyWorkspaceMismatch.body.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
    const identityWorkspaceMismatch = await callMcp(base, tokens.ownerA, workspaceB, 'brand.get')
    expect(identityWorkspaceMismatch.status).toBe(403)
    expect(identityWorkspaceMismatch.body.error?.code).toBe('FORBIDDEN')
    const foreignSync = await callMcp(base, tokens.ownerB, workspaceB, 'catalog.sync.get', { job_id: syncJob.id })
    const foreignClone = await callMcp(base, tokens.ownerB, workspaceB, 'task.clone', { task_id: sourceTask.id })
    expect(foreignSync.body.error?.code).toBe('SYNC_JOB_NOT_FOUND')
    expect(foreignClone.body.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
  }, 30_000)
})
