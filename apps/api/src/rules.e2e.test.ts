import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server, service, setRuleRepositoryForTests, workspaceMembers, type RuleRepositoryPort } from './server.js'
import type { PersistedRuleAudit, PersistedRuleVersion } from '../../../packages/persistence/src/index.js'

type Envelope<T = unknown> = { workspace_id: string; data: T | null; error: { code: string; message: string } | null }

class MemoryRuleRepository implements RuleRepositoryPort {
  readonly versions: PersistedRuleVersion[] = []
  readonly audits: PersistedRuleAudit[] = []

  async list(workspaceId: string, packId?: string) {
    return this.versions.filter(item => item.workspaceId === workspaceId && (!packId || item.packId === packId))
  }

  async insertVersion(input: Omit<PersistedRuleVersion, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }) {
    const created = { ...input, createdAt: input.createdAt ?? new Date().toISOString(), updatedAt: input.updatedAt ?? new Date().toISOString() } as PersistedRuleVersion
    this.versions.push(created)
    return created
  }

  async appendAudit(input: PersistedRuleAudit) { this.audits.push(input); return input }

  async updateStatus(input: { workspaceId: string; id: string; status: string; revision: number; updatedAt?: string; activatedAt?: string | null; deactivatedAt?: string | null }) {
    const row = this.versions.find(item => item.workspaceId === input.workspaceId && item.id === input.id)
    if (!row) throw new Error('RULE_VERSION_NOT_FOUND')
    row.status = input.status
    row.revision = input.revision
    row.updatedAt = input.updatedAt ?? new Date().toISOString()
    row.activatedAt = input.activatedAt ?? undefined
    row.deactivatedAt = input.deactivatedAt ?? undefined
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
    server.listen(0, () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function json(response: Response) { return await response.json() as Envelope<any> }

describe('durable rule-center HTTP boundary', () => {
  beforeEach(() => vi.stubEnv('SESSION_ID_HASH_SECRET', 'test-session-hash-secret'))
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    setRuleRepositoryForTests(undefined)
    vi.unstubAllEnvs()
  })

  it('enforces token-bound tenant/admin/approver identities and appends readable audit', async () => {
    const repository = new MemoryRuleRepository()
    setRuleRepositoryForTests(repository)
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'reader-token': { workspaces: ['ws_rules'], roles: [], actor_id: 'reader_1' },
      'admin-token': { workspaces: ['ws_rules'], roles: ['rules_admin'], actor_id: 'admin_1' },
    }))
    vi.stubEnv('RULE_APPROVAL_TOKENS', JSON.stringify({
      'approval-token': { workspaces: ['ws_rules'], actor_id: 'reviewer_2' },
    }))
    await workspaceMembers.upsert({ workspaceId: 'ws_rules', externalSubject: 'reader_1', displayName: '规则读者', role: 'operator', status: 'active', invitedBy: 'test' })
    await workspaceMembers.upsert({ workspaceId: 'ws_rules', externalSubject: 'admin_1', displayName: '规则管理员', role: 'merchant_admin', status: 'active', invitedBy: 'test' })
    const base = await start()
    const body = {
      name: '商品合规规则', version: '2.0.0', scope: 'global', status: 'active', source_kind: 'legal_review',
      source_reference: 'legal://review/2026-08-23', source_checked_at: '2026-08-23T01:00:00.000Z',
      checks: { forbidden_terms: ['绝对第一'], max_title_length: 60 }, reason: '法务与业务双人审批发布',
      approval: { approval_ref: 'approval://ticket/42', approved_at: '2026-08-23T02:00:00.000Z', approved_by: 'reviewer_2' },
    }
    const readerHeaders = { authorization: 'Bearer reader-token', 'x-workspace-id': 'ws_rules', 'content-type': 'application/json' }
    const deniedRole = await fetch(`${base}/v1/rules/catalog/versions`, { method: 'POST', headers: readerHeaders, body: JSON.stringify(body) }).then(json)
    expect(deniedRole.error?.code).toBe('FORBIDDEN')

    const adminHeaders = { authorization: 'Bearer admin-token', 'x-workspace-id': 'ws_rules', 'content-type': 'application/json' }
    const missingApprovalToken = await fetch(`${base}/v1/rules/catalog/versions`, { method: 'POST', headers: adminHeaders, body: JSON.stringify(body) }).then(json)
    expect(missingApprovalToken.error?.code).toBe('RULE_APPROVAL_REQUIRED')
    expect(repository.versions).toHaveLength(0)

    const created = await fetch(`${base}/v1/rules/catalog/versions`, { method: 'POST', headers: { ...adminHeaders, 'x-rule-approval-token': 'approval-token' }, body: JSON.stringify(body) }).then(json)
    expect(created.error).toBeNull()
    expect((created.data as { version: PersistedRuleVersion & { lifecycleStatus?: string } }).version).toMatchObject({ workspaceId: 'ws_rules', packId: 'catalog', status: 'active', lifecycleStatus: 'published', createdBy: 'admin_1' })
    expect((created.data as { version: PersistedRuleVersion }).version.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(repository.audits[0]).toMatchObject({ workspaceId: 'ws_rules', rulePackId: 'catalog', action: 'activated', actorId: 'admin_1' })
    expect(repository.audits[0]?.data).toMatchObject({ approval: { approvedBy: 'reviewer_2', approvalRef: 'approval://ticket/42' } })

    const listed = await fetch(`${base}/v1/rules?pack_id=catalog`, { headers: readerHeaders }).then(json)
    expect(listed.error).toBeNull()
    expect(listed.data).toHaveLength(1)
    const listedPage = await fetch(`${base}/v1/rules?pack_id=catalog&limit=1&offset=0`, { headers: readerHeaders }).then(json)
    expect(listedPage.data).toMatchObject({ items: [expect.objectContaining({ id: (listed.data as Array<{ id: string }>)[0]?.id })], total: 1, limit: 1, offset: 0 })
    const audit = await fetch(`${base}/v1/rules/audit?pack_id=catalog`, { headers: adminHeaders }).then(json)
    expect(audit.error).toBeNull()
    expect(audit.data).toHaveLength(1)

    const crossWorkspace = await fetch(`${base}/v1/rules`, { headers: { authorization: 'Bearer admin-token', 'x-workspace-id': 'ws_other' } }).then(json)
    expect(crossWorkspace.error?.code).toBe('FORBIDDEN')
    expect(repository.versions.every(item => item.workspaceId === 'ws_rules')).toBe(true)
  })

  it('requires separation of duties and never persists a rejected activation', async () => {
    const repository = new MemoryRuleRepository()
    setRuleRepositoryForTests(repository)
    const base = await start()
    const response = await fetch(`${base}/v1/rules/catalog/versions`, {
      method: 'POST',
      headers: { 'x-workspace-id': 'ws_rules_local', 'x-actor-id': 'same_actor', 'x-role': 'rules_admin', 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '规则', version: '1.0.0', scope: 'global', status: 'active', source_kind: 'internal',
        source_reference: 'internal://rules/1', source_checked_at: '2026-08-23T01:00:00.000Z', checks: {}, reason: '测试',
        approval: { approval_ref: 'ticket-1', approved_at: '2026-08-23T02:00:00.000Z', approved_by: 'same_actor' },
      }),
    }).then(json)
    expect(response.error?.code).toBe('RULE_SEPARATION_OF_DUTIES_REQUIRED')
    expect(repository.versions).toHaveLength(0)
    expect(repository.audits).toHaveLength(0)
  })

  it('persists and audits an explicit draft-to-active lifecycle', async () => {
    const repository = new MemoryRuleRepository()
    setRuleRepositoryForTests(repository)
    const base = await start()
    const headers = { 'x-workspace-id': 'ws_lifecycle', 'x-actor-id': 'rules_admin_1', 'x-role': 'rules_admin', 'content-type': 'application/json' }
    const draft = await fetch(`${base}/v1/rules/catalog/versions`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: '商品规则', version: '3.0.0', scope: 'global', status: 'draft', source_kind: 'official', source_reference: 'official://rules/3', source_checked_at: '2026-08-23T01:00:00.000Z', checks: { max_title_length: 60 }, reason: '登记待审批版本' }),
    }).then(json)
    expect(draft.error).toBeNull()
    expect(repository.versions[0]?.status).toBe('draft')
    expect(repository.audits.map(item => item.action)).toEqual(['created'])

    const refreshedDraft = await fetch(`${base}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'rule.list', params: { workspace_id: 'ws_lifecycle' } }),
    }).then(json)
    expect(refreshedDraft.error).toBeNull()
    expect((refreshedDraft.data as { result: Array<{ version: string; status: string }> }).result).toContainEqual(expect.objectContaining({ version: '3.0.0', status: 'draft' }))

    const activated = await fetch(`${base}/v1/rules/catalog/versions/3.0.0/status`, {
      method: 'POST', headers,
      body: JSON.stringify({ status: 'active', reason: '审批通过', approval: { approval_ref: 'ticket-3', approved_at: '2026-08-23T02:00:00.000Z', approved_by: 'reviewer_2' } }),
    }).then(json)
    expect(activated.error).toBeNull()
    expect((activated.data as { status: string; revision: number })).toMatchObject({ status: 'active', revision: 2 })
    expect(repository.audits.map(item => item.action)).toEqual(['created', 'activated'])
    expect(repository.audits[1]).toMatchObject({ actorId: 'rules_admin_1', data: { approved_by: 'reviewer_2', approval_ref: 'ticket-3' } })

    const refreshedActive = await fetch(`${base}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'rule.list', params: { workspace_id: 'ws_lifecycle' } }),
    }).then(json)
    expect((refreshedActive.data as { result: Array<{ version: string; status: string }> }).result).toContainEqual(expect.objectContaining({ version: '3.0.0', status: 'active' }))

    const inactive = await fetch(`${base}/v1/rules/catalog/versions/3.0.0/status`, {
      method: 'POST', headers,
      body: JSON.stringify({ status: 'inactive', reason: '替换前保留历史版本' }),
    }).then(json)
    expect(inactive.error).toBeNull()
    const refreshedInactive = await fetch(`${base}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'rule.list', params: { workspace_id: 'ws_lifecycle' } }),
    }).then(json)
    expect((refreshedInactive.data as { result: Array<{ version: string; status: string }> }).result).toContainEqual(expect.objectContaining({ version: '3.0.0', status: 'inactive' }))
  })

  it('filters rule.list by the requested platform and keeps global rules visible', async () => {
    const repository = new MemoryRuleRepository()
    setRuleRepositoryForTests(repository)
    const workspaceId = `ws_rule_list_filter_${Date.now()}`
    const now = new Date().toISOString()
    await repository.insertVersion({ id: 'global-rule', workspaceId, packId: 'global', name: '全局规则', version: '1', scope: 'global', status: 'active', sourceKind: 'official', sourceReference: 'official://global', sourceCheckedAt: now, checksum: 'a'.repeat(64), checks: {}, createdBy: 'rules_admin', revision: 1 })
    await repository.insertVersion({ id: 'jd-rule', workspaceId, packId: 'jd', name: '京东规则', version: '1', scope: 'platform', targetId: 'jd', status: 'active', sourceKind: 'official', sourceReference: 'official://jd', sourceCheckedAt: now, checksum: 'b'.repeat(64), checks: {}, createdBy: 'rules_admin', revision: 1 })
    await repository.insertVersion({ id: 'taobao-rule', workspaceId, packId: 'taobao', name: '淘宝规则', version: '1', scope: 'platform', targetId: 'taobao', status: 'active', sourceKind: 'official', sourceReference: 'official://taobao', sourceCheckedAt: now, checksum: 'c'.repeat(64), checks: {}, createdBy: 'rules_admin', revision: 1 })
    await repository.insertVersion({ id: 'draft-rule', workspaceId, packId: 'draft', name: '待审批规则', version: '1', scope: 'global', status: 'draft', sourceKind: 'internal', sourceReference: 'internal://draft', sourceCheckedAt: now, checksum: 'd'.repeat(64), checks: {}, createdBy: 'rules_admin', revision: 1 })
    await repository.insertVersion({ id: 'inactive-rule', workspaceId, packId: 'inactive', name: '已停用规则', version: '1', scope: 'global', status: 'inactive', sourceKind: 'internal', sourceReference: 'internal://inactive', sourceCheckedAt: now, checksum: 'e'.repeat(64), checks: {}, createdBy: 'rules_admin', revision: 2 })
    const base = await start()
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'rule.list', params: { workspace_id: workspaceId, platform: 'jd' } }) }).then(json)
    expect(response.error).toBeNull()
    expect((response.data as { result: Array<{ id: string }> }).result.map(item => item.id)).toEqual(['global-rule', 'jd-rule'])
    const unfiltered = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'rule.list', params: { workspace_id: workspaceId } }) }).then(json)
    expect((unfiltered.data as { result: Array<{ id: string }> }).result.map(item => item.id)).toEqual(['global-rule', 'jd-rule', 'taobao-rule'])
    const operationsView = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'platform_ops_1', 'x-role': 'platform_ops' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'rule.list', params: { workspace_id: workspaceId } }) }).then(json)
    expect(operationsView.error).toBeNull()
    expect((operationsView.data as { result: Array<{ id: string }> }).result.map(item => item.id)).toEqual(['global-rule', 'jd-rule', 'taobao-rule', 'draft-rule', 'inactive-rule'])
  })

  it('uses workspace-persisted rules when automation decides whether to pause', async () => {
    const repository = new MemoryRuleRepository()
    setRuleRepositoryForTests(repository)
    const workspaceId = `ws_persisted_automation_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `persisted-rule-store-${workspaceId}`, credentialRef: `vault://persisted-rule/${workspaceId}` })
    service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, category: '女装外套', title: '持久化规则自动暂停商品', stock: 4 })
    await repository.insertVersion({ id: `persisted-expired-${workspaceId}`, workspaceId, packId: 'persisted-automation', name: '持久化过期规则', version: '1.0.0', scope: 'category', scopeValue: '女装外套', status: 'active', sourceKind: 'official', sourceReference: 'official://persisted-expired', sourceCheckedAt: '2026-01-01T00:00:00.000Z', checksum: 'a'.repeat(64), checks: {}, createdBy: 'rules_admin', revision: 1, effectiveTo: '2026-01-01T00:00:00.000Z' })
    const base = await start()
    const enabled = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'automation.policy.update', params: { workspace_id: workspaceId, platform: 'taobao', account_id: account.id, enabled: 'true', sync_enabled: 'true', reason: '验证持久化规则暂停' } }) }).then(json)
    expect(enabled.error).toBeNull()
    const tick = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'automation.tick', params: { workspace_id: workspaceId } }) }).then(json)
    expect(tick.error).toBeNull()
    expect((tick.data as { result: { executed: Array<{ paused?: boolean; syncSkipped?: boolean }> } }).result.executed).toContainEqual(expect.objectContaining({ paused: true, syncSkipped: true }))
  })

  it('includes workspace-persisted platform rules in multimodal generation preflight after restart', async () => {
    const repository = new MemoryRuleRepository()
    setRuleRepositoryForTests(repository)
    const workspaceId = `ws_persisted_generation_rules_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `persisted-generation-store-${workspaceId}`, credentialRef: `vault://persisted-generation/${workspaceId}` })
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, category: '女装外套', title: '持久化规则生成商品', stock: 4 })
    service.confirmProductFacts(workspaceId, product.id)
    await repository.insertVersion({ id: `persisted-platform-${workspaceId}`, workspaceId, packId: 'persisted-platform', name: '持久化淘宝规则', version: '2.0.0', scope: 'platform', targetId: 'taobao', status: 'active', sourceKind: 'official', sourceReference: 'official://taobao/2', sourceCheckedAt: new Date().toISOString(), checksum: 'b'.repeat(64), checks: { forbidden_terms: ['全网最低'] }, createdBy: 'rules_admin', revision: 1 })
    const base = await start()
    const generated = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'multimodal.generate', params: { workspace_id: workspaceId, modality: 'text', prompt: '生成商品标题', context_json: JSON.stringify({ brand: { id: 'brand-1', version: '1' }, product: { id: product.id, version: String(product.version) }, rules: [{ id: 'client-rule', version: '1' }] }) } }) }).then(json)
    expect(generated.error).toBeNull()
    expect((generated.data as { result: { rule_preflight: { blocking: boolean; rule_hits: Array<{ ruleVersionId: string; version: string }> } } }).result.rule_preflight).toMatchObject({ blocking: false, rule_hits: expect.arrayContaining([expect.objectContaining({ ruleVersionId: `persisted-platform-${workspaceId}`, version: '2.0.0' })]) })
  })

  it('freezes workspace-persisted rule versions into the confirmed task snapshot', async () => {
    const repository = new MemoryRuleRepository()
    setRuleRepositoryForTests(repository)
    const workspaceId = `ws_persisted_snapshot_rules_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `persisted-snapshot-store-${workspaceId}`, credentialRef: `vault://persisted-snapshot/${workspaceId}` })
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, category: '女装外套', title: '持久化规则快照商品', stock: 4 })
    service.confirmProductFacts(workspaceId, product.id)
    const task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
    service.selectDirection(task.id, 'A')
    await repository.insertVersion({ id: `persisted-snapshot-${workspaceId}`, workspaceId, packId: 'persisted-snapshot', name: '持久化淘宝快照规则', version: '5.0.0', scope: 'platform', targetId: 'taobao', status: 'active', sourceKind: 'official', sourceReference: 'official://taobao/snapshot', sourceCheckedAt: new Date().toISOString(), checksum: 'e'.repeat(64), checks: { forbidden_terms: ['全网最低'], required_fields: ['material'] }, createdBy: 'rules_admin', revision: 1 })
    const base = await start()
    const confirmed = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'task.plan.confirm', params: { workspace_id: workspaceId, task_id: task.id } }) }).then(json)
    expect(confirmed.error).toBeNull()
    const snapshot = (confirmed.data as { result: { inputSnapshot?: { ruleVersionIds: string[]; ruleChecks: { forbiddenTerms?: string[]; requiredFields?: string[] } } } }).result.inputSnapshot
    expect(snapshot?.ruleVersionIds).toContain('5.0.0')
    expect(snapshot?.ruleChecks.forbiddenTerms).toContain('全网最低')
    expect(snapshot?.ruleChecks.requiredFields).toContain('material')
  })

  it('shows workspace-persisted rule hits in the content review report after restart', async () => {
    const repository = new MemoryRuleRepository()
    setRuleRepositoryForTests(repository)
    const workspaceId = `ws_persisted_review_rules_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `persisted-review-store-${workspaceId}`, credentialRef: `vault://persisted-review/${workspaceId}` })
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, category: '女装外套', title: '持久化规则审核商品', stock: 4 })
    service.confirmProductFacts(workspaceId, product.id)
    await repository.insertVersion({ id: `persisted-review-${workspaceId}`, workspaceId, packId: 'persisted-review', name: '持久化淘宝审核规则', version: '3.0.0', scope: 'platform', targetId: 'taobao', status: 'active', sourceKind: 'official', sourceReference: 'official://taobao/3', sourceCheckedAt: new Date().toISOString(), checksum: 'c'.repeat(64), checks: { forbidden_terms: ['全网最低'] }, createdBy: 'rules_admin', revision: 1 })
    const task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    const base = await start()
    const reviewed = await fetch(`${base}/v1/content-versions/${draft.id}/review`, { headers: { 'x-workspace-id': workspaceId } }).then(json)
    expect(reviewed.error).toBeNull()
    expect((reviewed.data as { ruleHits: Array<{ ruleVersionId: string; version: string }> }).ruleHits).toContainEqual(expect.objectContaining({ ruleVersionId: `persisted-review-${workspaceId}`, version: '3.0.0' }))
  })

  it('fills missing immutable default rule packs before reviewing a partially bootstrapped workspace', async () => {
    const repository = new MemoryRuleRepository()
    setRuleRepositoryForTests(repository)
    const workspaceId = `ws_partial_default_rules_${Date.now()}`
    await repository.insertVersion({ id: `custom-${workspaceId}`, workspaceId, packId: 'custom', name: '已有自定义规则', version: '1.0.0', scope: 'global', status: 'active', sourceKind: 'internal', sourceReference: 'internal://custom', sourceCheckedAt: new Date().toISOString(), checksum: 'f'.repeat(64), checks: {}, createdBy: 'rules_admin', revision: 1 })
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `partial-default-store-${workspaceId}`, credentialRef: `vault://partial-default/${workspaceId}` })
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: '默认规则补齐商品', stock: 3 })
    service.confirmProductFacts(workspaceId, product.id)
    const task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    const base = await start()

    const reviewed = await fetch(`${base}/v1/content-versions/${draft.id}/review`, { headers: { 'x-workspace-id': workspaceId } }).then(json)

    expect(reviewed.error).toBeNull()
    const persisted = await repository.list(workspaceId)
    expect(persisted.map(row => row.id)).toEqual(expect.arrayContaining(['cn-commerce@cn-commerce-1.0.0', 'taobao-mapping@taobao-apparel-1.0.0', 'apparel-facts@apparel-1.0.0']))
    expect((reviewed.data as { findings: Array<{ code: string }> }).findings).not.toContainEqual(expect.objectContaining({ code: 'MISSING_RULE_VERSION' }))
  })

  it('blocks ordinary text generation before wallet usage when a persisted platform rule is expired', async () => {
    const repository = new MemoryRuleRepository()
    setRuleRepositoryForTests(repository)
    const workspaceId = `ws_persisted_generation_gate_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `persisted-gate-store-${workspaceId}`, credentialRef: `vault://persisted-gate/${workspaceId}` })
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, category: '女装外套', title: '过期规则生成商品', stock: 4 })
    service.confirmProductFacts(workspaceId, product.id)
    const task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
    service.selectDirection(task.id, 'A')
    await repository.insertVersion({ id: `persisted-gate-${workspaceId}`, workspaceId, packId: 'persisted-gate', name: '过期淘宝规则', version: '4.0.0', scope: 'platform', targetId: 'taobao', status: 'active', sourceKind: 'official', sourceReference: 'official://taobao/4', sourceCheckedAt: new Date().toISOString(), checksum: 'd'.repeat(64), checks: {}, createdBy: 'rules_admin', revision: 1, effectiveTo: '2026-01-01T00:00:00.000Z' })
    const base = await start()
    const generated = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'content.generate', params: { task_id: task.id } }) }).then(json)
    expect(generated.error).toMatchObject({ code: 'PLATFORM_RULE_PREFLIGHT_BLOCKED' })
    expect((generated.error as { details?: { rule_preflight?: { findings?: Array<{ code: string }> } } }).details?.rule_preflight?.findings).toContainEqual(expect.objectContaining({ code: 'RULE_EXPIRED' }))
    expect([...service.generationJobs.values()].some(job => job.workspaceId === workspaceId)).toBe(false)

    const restSync = await fetch(`${base}/v1/tasks/${task.id}/content`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: '{}' }).then(json)
    expect(restSync.error?.code).toBe('PLATFORM_RULE_PREFLIGHT_BLOCKED')
    const restAsync = await fetch(`${base}/v1/tasks/${task.id}/content-jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'idempotency-key': `expired-rule-job-${workspaceId}` }, body: '{}' }).then(json)
    expect(restAsync.error?.code).toBe('PLATFORM_RULE_PREFLIGHT_BLOCKED')
    expect([...service.generationJobs.values()].some(job => job.workspaceId === workspaceId)).toBe(false)
  })

  it('applies persisted expiration policy and only reports exact normalized conflict keys', async () => {
    const repository = new MemoryRuleRepository()
    setRuleRepositoryForTests(repository)
    const now = new Date().toISOString()
    const request = (base: string, workspaceId: string, productId: string, id: number) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'multimodal.generate', params: { workspace_id: workspaceId, modality: 'text', prompt: `生成克制商品标题 ${id}`, context_json: JSON.stringify({ brand: { id: 'brand-1', version: '1' }, product: { id: productId, version: '1' }, rules: [{ id: 'client-rule', version: '1' }] }) } }) }).then(json)

    const advisoryWorkspace = `ws_persisted_advisory_${Date.now()}`
    const advisoryProduct = service.importProduct({ workspaceId: advisoryWorkspace, platform: 'taobao', category: '女装外套', title: '建议规则商品', stock: 4 })
    service.confirmProductFacts(advisoryWorkspace, advisoryProduct.id)
    await repository.insertVersion({ id: `category-advisory-${advisoryWorkspace}`, workspaceId: advisoryWorkspace, packId: 'category-advisory', name: '品类建议规则', version: '1', scope: 'category', scopeValue: '女装外套', status: 'active', severity: 'warning', action: 'warn', effectiveTo: '2026-01-01T00:00:00.000Z', sourceKind: 'internal', sourceReference: 'internal://category-advisory', sourceCheckedAt: now, checksum: 'a'.repeat(64), checks: {}, createdBy: 'rules_admin', revision: 1 })
    const base = await start()
    const advisory = await request(base, advisoryWorkspace, advisoryProduct.id, 1)
    expect(advisory.error).toBeNull()
    expect((advisory.data as { result: { rule_preflight: { findings: unknown[] } } }).result.rule_preflight.findings).toContainEqual(expect.objectContaining({ code: 'RULE_EXPIRED', severity: 'warning', action: 'warn' }))

    await repository.insertVersion({ id: `platform-expired-${advisoryWorkspace}`, workspaceId: advisoryWorkspace, packId: 'platform-expired', name: '平台过期规则', version: '1', scope: 'platform', targetId: 'taobao', status: 'expired', severity: 'warning', action: 'allow', sourceKind: 'official', sourceReference: 'official://platform-expired', sourceCheckedAt: now, checksum: 'b'.repeat(64), checks: {}, createdBy: 'rules_admin', revision: 1 })
    const platformExpired = await request(base, advisoryWorkspace, advisoryProduct.id, 2)
    expect(platformExpired.error?.code).toBe('PLATFORM_RULE_PREFLIGHT_BLOCKED')
    expect((platformExpired.error as unknown as { details: { rule_preflight: { findings: unknown[] } } }).details.rule_preflight.findings).toContainEqual(expect.objectContaining({ code: 'RULE_EXPIRED', severity: 'error', action: 'block' }))

    const conflictWorkspace = `ws_persisted_conflicts_${Date.now()}`
    const conflictProduct = service.importProduct({ workspaceId: conflictWorkspace, platform: 'taobao', category: '女装外套', title: '精确冲突商品', stock: 4 })
    service.confirmProductFacts(conflictWorkspace, conflictProduct.id)
    await repository.insertVersion({ id: `global-hard-${conflictWorkspace}`, workspaceId: conflictWorkspace, packId: 'global-hard', name: '全局硬规则', version: '1', scope: 'global', status: 'active', severity: 'error', action: 'block', sourceKind: 'legal_review', sourceReference: 'legal://global-hard', sourceCheckedAt: now, checksum: 'c'.repeat(64), checks: { required_fields: [' Product.Title '], conflict_keys: ['PRICE\u3000CLAIM'] }, createdBy: 'rules_admin', revision: 1 })
    await repository.insertVersion({ id: `category-unrelated-${conflictWorkspace}`, workspaceId: conflictWorkspace, packId: 'category-unrelated', name: '无关品类例外', version: '1', scope: 'category', scopeValue: '女装外套', status: 'active', severity: 'warning', action: 'allow', sourceKind: 'internal', sourceReference: 'internal://unrelated', sourceCheckedAt: now, checksum: 'd'.repeat(64), checks: { required_fields: ['product.description'], conflict_keys: ['stock-display'] }, createdBy: 'rules_admin', revision: 1 })
    const unrelated = await request(base, conflictWorkspace, conflictProduct.id, 3)
    expect(unrelated.error).toBeNull()
    expect((unrelated.data as { result: { rule_preflight: { findings: Array<{ code: string }>; rule_hits: Array<{ ruleVersionId: string; matchedChecks: string[] }> } } }).result.rule_preflight.findings.filter(item => item.code === 'RULE_PRIORITY_CONFLICT')).toEqual([])
    expect((unrelated.data as { result: { rule_preflight: { rule_hits: Array<{ ruleVersionId: string; matchedChecks: string[] }> } } }).result.rule_preflight.rule_hits).toContainEqual(expect.objectContaining({ ruleVersionId: `global-hard-${conflictWorkspace}`, matchedChecks: expect.arrayContaining(['requiredFields', 'conflictKeys']) }))

    await repository.insertVersion({ id: `category-conflict-${conflictWorkspace}`, workspaceId: conflictWorkspace, packId: 'category-conflict', name: '同字段品类例外', version: '1', scope: 'category', scopeValue: '女装外套', status: 'active', severity: 'warning', action: 'allow', sourceKind: 'internal', sourceReference: 'internal://conflict', sourceCheckedAt: now, checksum: 'e'.repeat(64), checks: { required_fields: ['product.title'] }, createdBy: 'rules_admin', revision: 1 })
    const exactConflict = await request(base, conflictWorkspace, conflictProduct.id, 4)
    expect(exactConflict.error?.code).toBe('PLATFORM_RULE_PREFLIGHT_BLOCKED')
    const conflictFinding = (exactConflict.error as unknown as { details: { rule_preflight: { findings: Array<{ code: string; message: string }> } } }).details.rule_preflight.findings.find(item => item.code === 'RULE_PRIORITY_CONFLICT')
    expect(conflictFinding?.message).toContain('field:product.title')
  })
})
