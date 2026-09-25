import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type MerchantService, type Platform } from '../../../packages/application/src/service.js'
import { ERROR_CODES, type ApiEnvelope } from '../../../packages/contracts/src/index.js'
import type { PersistedRuleAudit, PersistedRuleVersion, PostgresRuleRepository } from '../../../packages/persistence/src/rule-repository.js'

type JsonObject = Record<string, unknown>
type Send = <T>(res: ServerResponse, status: number, workspaceId: string, data: T | null, error?: ApiEnvelope<T>['error'], req?: IncomingMessage) => void
type RuleRepository = Pick<PostgresRuleRepository, 'list' | 'listAudit' | 'insertVersion' | 'appendAudit' | 'updateStatus'> & Partial<Pick<PostgresRuleRepository, 'insertVersionWithAudit' | 'transitionStatusWithAudit'>>
type Category = { code: string; name: string; fields: readonly string[] }
type RuleApproval = { approvalRef: string; approvedAt: string; approvedBy: string }
type RulePublic = { status: string; scope?: string; targetId?: string; scopeValue?: string; source?: { reference?: string } }

export async function handleHttpRulesRoute(req: IncomingMessage, res: ServerResponse, path: string, url: URL, deps: {
  service: Pick<MerchantService, 'listRulePacks'>
  supportedPlatforms: readonly Platform[]
  catalogCategories: readonly Category[]
  resolveWorkspace: (req: IncomingMessage, candidate?: unknown) => string
  requireRuleAdmin: (req: IncomingMessage) => { actorId: string }
  ruleRepository: () => RuleRepository | undefined
  persistedRules: (workspaceId: string) => Promise<RulePublic[] | undefined>
  isProduction: () => boolean
  paginatedResult: <T>(url: URL, items: T[]) => unknown
  body: (req: IncomingMessage) => Promise<JsonObject>
  required: (input: JsonObject, key: string) => string
  assertManualRuleSource: (sourceKind: string, category: unknown) => void
  assertRuleActivationSource: (version: PersistedRuleVersion) => void
  publicRule: (version: PersistedRuleVersion) => RulePublic
  objectField: (input: JsonObject, key: string) => Record<string, unknown>
  canonicalJson: (value: unknown) => string
  parseApprovalGrant: (req: IncomingMessage, workspaceId: string, actorId: string, input: JsonObject) => RuleApproval
  ensureWorkspace?: (workspaceId: string) => Promise<unknown>
  send: Send
}) {
  if (req.method === 'GET' && path === '/v1/rules') {
    const workspaceId = deps.resolveWorkspace(req)
    const requestedPlatform = url.searchParams.get('platform')?.trim()
    if (requestedPlatform && !deps.supportedPlatforms.includes(requestedPlatform as Platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
    const appliesToPlatform = (rule: { status: string; scope?: string; targetId?: string; scopeValue?: string; source?: { reference?: string } }) => rule.status === 'active'
      && !rule.source?.reference?.startsWith('manual://')
      && (!requestedPlatform || rule.scope === 'global' || (rule.scope === 'platform' && (rule.targetId ?? rule.scopeValue) === requestedPlatform))
    const respond = <T>(rules: T[]) => url.searchParams.has('limit') || url.searchParams.has('offset') ? deps.paginatedResult(url, rules) : rules
    const repository = deps.ruleRepository()
    if (repository) {
      const packId = url.searchParams.get('pack_id')?.trim() || undefined
      const rows = await repository.list(workspaceId, packId)
      if (rows.length || packId) return deps.send(res, 200, workspaceId, respond(rows.map(deps.publicRule).filter(appliesToPlatform)), null, req)
      return deps.send(res, 200, workspaceId, respond((await deps.persistedRules(workspaceId) ?? []).filter(appliesToPlatform)), null, req)
    }
    if (deps.isProduction()) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '生产规则仓储未配置', 503)
    return deps.send(res, 200, workspaceId, respond(deps.service.listRulePacks().filter(appliesToPlatform)), null, req)
  }
  if (req.method === 'GET' && path === '/v1/catalog/categories') {
    const workspaceId = deps.resolveWorkspace(req)
    const query = url.searchParams.get('query')?.trim().toLocaleLowerCase()
    const items = query ? deps.catalogCategories.filter(item => `${item.code}${item.name}${item.fields.join('')}`.toLocaleLowerCase().includes(query)) : deps.catalogCategories
    // Keep the REST read model aligned with MCP `catalog.categories`. The
    // legacy code/fields names remain for existing clients, while canonical
    // aliases make transport parity explicit and machine-checkable.
    return deps.send(res, 200, workspaceId, items.map(item => ({ ...item, category_code: item.code, required_fields: item.fields })), null, req)
  }
  if (req.method === 'GET' && path === '/v1/rules/audit') {
    const workspaceId = deps.resolveWorkspace(req)
    deps.requireRuleAdmin(req)
    const repository = deps.ruleRepository()
    if (!repository) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '规则审计仅在持久化仓储可用时开放', 503)
    const rawPackId = url.searchParams.get('pack_id')
    if (rawPackId !== null && (rawPackId.length < 1 || rawPackId.length > 256 || /[\u0000-\u001f\u007f]/u.test(rawPackId))) {
      throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'pack_id 必须是 1 到 256 个可打印字符', 400)
    }
    const packId = rawPackId?.trim() || undefined
    return deps.send(res, 200, workspaceId, await repository.listAudit(workspaceId, packId), null, req)
  }
  const createRuleVersionMatch = path.match(/^\/v1\/rules\/([^/]+)\/versions$/)
  if (req.method === 'POST' && createRuleVersionMatch) {
    const input = await deps.body(req)
    const workspaceId = deps.resolveWorkspace(req, input.workspace_id)
    const principal = deps.requireRuleAdmin(req)
    const repository = deps.ruleRepository()
    if (!repository) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '规则写入仅允许使用持久化仓储', 503)
    const packId = decodeURIComponent(createRuleVersionMatch[1]!)
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(packId)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则包 ID 格式无效', 400)
    if (input.pack_id !== undefined && String(input.pack_id) !== packId) throw new DomainError(ERROR_CODES.WORKSPACE_SCOPE_MISMATCH, '路径规则包与请求体不一致', 403)
    const name = deps.required(input, 'name')
    const versionValue = deps.required(input, 'version')
    const scope = deps.required(input, 'scope')
    const sourceKind = deps.required(input, 'source_kind')
    deps.assertManualRuleSource(sourceKind, input.category)
    const sourceReference = deps.required(input, 'source_reference')
    const sourceCheckedAt = deps.required(input, 'source_checked_at')
    const reason = deps.required(input, 'reason')
    const status = typeof input.status === 'string' ? input.status : 'draft'
    if (!['global', 'platform', 'category', 'brand', 'store', 'campaign'].includes(scope)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则 scope 无效', 400)
    if (!['official', 'internal', 'legal_review'].includes(sourceKind)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则 source_kind 无效', 400)
    if (!['draft', 'active'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '新规则状态仅支持 draft 或 active', 400)
    if (!Number.isFinite(Date.parse(sourceCheckedAt))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'source_checked_at 必须是合法时间', 400)
    const checks = deps.objectField(input, 'checks')
    const effectiveFromRaw = typeof input.effective_from === 'string' && input.effective_from.trim() ? input.effective_from.trim() : undefined
    const effectiveToRaw = typeof input.effective_to === 'string' && input.effective_to.trim() ? input.effective_to.trim() : undefined
    if ((effectiveFromRaw && Number.isNaN(Date.parse(effectiveFromRaw))) || (effectiveToRaw && Number.isNaN(Date.parse(effectiveToRaw))) || (effectiveFromRaw && effectiveToRaw && Date.parse(effectiveFromRaw) >= Date.parse(effectiveToRaw))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则有效期必须是合法时间，且 effective_from 早于 effective_to', 400)
    const effectiveFrom = effectiveFromRaw ? new Date(effectiveFromRaw).toISOString() : undefined
    const effectiveTo = effectiveToRaw ? new Date(effectiveToRaw).toISOString() : undefined
    const severity = input.severity === 'warning' ? 'warning' : input.severity === 'error' || input.severity === undefined ? 'error' : undefined
    const action = ['block', 'warn', 'review', 'allow'].includes(String(input.action)) ? String(input.action) : input.action === undefined ? 'block' : undefined
    if (!severity || !action) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则 severity/action 无效', 400)
    const checksum = createHash('sha256').update(deps.canonicalJson(checks)).digest('hex')
    if (typeof input.checksum === 'string' && input.checksum.toLowerCase() !== checksum) throw new DomainError('RULE_CHECKSUM_MISMATCH', '规则校验和与 checks 内容不一致', 409)
    const approval = status === 'active' ? deps.parseApprovalGrant(req, workspaceId, principal.actorId, input) : undefined
    const now = new Date().toISOString()
    await deps.ensureWorkspace?.(workspaceId)
    const versionInput = {
      id: `rule_${randomBytes(12).toString('hex')}`, workspaceId, packId, name, version: versionValue, scope, status,
      sourceKind, sourceReference, sourceCheckedAt: new Date(sourceCheckedAt).toISOString(), checksum, checks,
      createdBy: principal.actorId, revision: 1, createdAt: now, updatedAt: now, severity, action,
      ...(effectiveFrom ? { effectiveFrom } : {}), ...(effectiveTo ? { effectiveTo } : {}),
      ...(typeof input.target_id === 'string' && input.target_id.trim() ? { targetId: input.target_id.trim() } : {}), ...(typeof input.scope_value === 'string' && input.scope_value.trim() ? { scopeValue: input.scope_value.trim() } : {}),
      ...(status === 'active' ? { activatedAt: now } : {}),
    }
    if (repository.insertVersionWithAudit) {
      try {
        const result = await repository.insertVersionWithAudit({ version: versionInput, audit: { id: `rule_audit_${randomBytes(12).toString('hex')}`, workspaceId, rulePackId: packId, ruleVersionId: versionInput.id, version: versionValue, action: status === 'active' ? 'activated' : 'created', actorId: principal.actorId, reason, occurredAt: now, data: { source_kind: sourceKind, source_reference: sourceReference, checksum, ...(approval ? { approval } : {}) } } })
        return deps.send(res, 201, workspaceId, result, null, req)
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new DomainError('RULE_VERSION_CONFLICT', '规则版本已存在，或该规则包已有激活版本', 409)
        throw error
      }
    }
    let created: PersistedRuleVersion
    try {
      created = await repository.insertVersion(versionInput)
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new DomainError('RULE_VERSION_CONFLICT', '规则版本已存在，或该规则包已有激活版本', 409)
      throw error
    }
    let audit: PersistedRuleAudit
    try {
      audit = await repository.appendAudit({
        id: `rule_audit_${randomBytes(12).toString('hex')}`, workspaceId, rulePackId: packId, ruleVersionId: created.id,
        version: created.version, action: status === 'active' ? 'activated' : 'created', actorId: principal.actorId,
        reason, occurredAt: now, data: { source_kind: sourceKind, source_reference: sourceReference, checksum, ...(approval ? { approval } : {}) },
      })
    } catch {
      // The current repository contract exposes separate transactions. Surface
      // the partial write explicitly so operators can repair it; never report
      // success for an unaudited administrative mutation.
      throw new DomainError('RULE_AUDIT_WRITE_FAILED', '规则版本已写入，但审计追加失败；需暂停该工作区规则变更并人工核对', 503)
    }
    return deps.send(res, 201, workspaceId, { version: deps.publicRule(created), audit }, null, req)
  }
  const ruleStatusMatch = path.match(/^\/v1\/rules\/([^/]+)\/versions\/([^/]+)\/status$/)
  if (req.method === 'POST' && ruleStatusMatch) {
    const input = await deps.body(req)
    const workspaceId = deps.resolveWorkspace(req, input.workspace_id)
    const principal = deps.requireRuleAdmin(req)
    const repository = deps.ruleRepository()
    if (!repository) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '规则写入仅允许使用持久化仓储', 503)
    const packId = decodeURIComponent(ruleStatusMatch[1]!)
    const versionName = decodeURIComponent(ruleStatusMatch[2]!)
    const status = deps.required(input, 'status')
    const reason = deps.required(input, 'reason')
    if (!['active', 'inactive', 'expired'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则状态无效', 400)
    const rows = await repository.list(workspaceId, packId)
    const target = rows.find(row => row.version === versionName)
    if (!target) throw new DomainError('RULE_VERSION_NOT_FOUND', '规则版本不存在', 404)
    if (status === 'active') deps.assertRuleActivationSource(target)
    const approval = status === 'active' ? deps.parseApprovalGrant(req, workspaceId, principal.actorId, input) : undefined
    const at = new Date().toISOString()
    const current = rows.find(row => row.status === 'active' && row.id !== target.id)
    if (status === 'active' && current && !repository.transitionStatusWithAudit) throw new DomainError('RULE_ACTIVE_VERSION_EXISTS', '该规则包已有激活版本，请先显式停用后再激活新版本', 409)
    if (repository.transitionStatusWithAudit) {
      try {
        const result = await repository.transitionStatusWithAudit({ workspaceId, packId, targetId: target.id, status, actorId: principal.actorId, reason, occurredAt: at, targetAuditId: `rule_audit_${randomBytes(12).toString('hex')}`, ...(current ? { currentAuditId: `rule_audit_${randomBytes(12).toString('hex')}` } : {}), auditData: approval ? { approval_ref: approval.approvalRef, approved_by: approval.approvedBy, approved_at: approval.approvedAt } : {} })
        return deps.send(res, 200, workspaceId, deps.publicRule(result.version), null, req)
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new DomainError('RULE_ACTIVE_VERSION_EXISTS', '该规则包已有激活版本', 409)
        throw error
      }
    }
    let updated: PersistedRuleVersion
    try {
      updated = await repository.updateStatus({ workspaceId, id: target.id, status, revision: target.revision + 1, updatedAt: at, activatedAt: status === 'active' ? at : null, deactivatedAt: status === 'active' ? null : at })
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new DomainError('RULE_ACTIVE_VERSION_EXISTS', '该规则包已有激活版本', 409)
      throw error
    }
    try {
      await repository.appendAudit({ id: `rule_audit_${randomBytes(12).toString('hex')}`, workspaceId, rulePackId: packId, ruleVersionId: updated.id, version: updated.version, action: status === 'active' ? 'activated' : status === 'expired' ? 'expired' : 'deactivated', actorId: principal.actorId, reason, occurredAt: at, data: approval ? { approval_ref: approval.approvalRef, approved_by: approval.approvedBy, approved_at: approval.approvedAt } : {} })
    } catch {
      throw new DomainError('RULE_AUDIT_WRITE_FAILED', '规则状态已变更，但审计追加失败；需暂停该工作区规则变更并人工核对', 503)
    }
    return deps.send(res, 200, workspaceId, deps.publicRule(updated), null, req)
  }
}
