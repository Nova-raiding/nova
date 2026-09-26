import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { DomainError, type MerchantService, type Platform, type SyncJob } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { PersistedRuleVersion } from '../../../packages/persistence/src/index.js'
import type { RulePack } from '../../../packages/review/src/rule-center.js'
import type { WorkerAuthorizationSnapshot } from '../../../packages/workers/src/execution-authorization.js'
import type { RuleRepositoryPort } from './server.js'

type JsonObject = Record<string, unknown>
type SyncAuthorizationSnapshot = WorkerAuthorizationSnapshot & { capability: 'catalog.sync.execute' }
type RuleApproval = { approvalRef: string; approvedAt: string; approvedBy: string }

export const MCP_SYNC_RULE_METHODS = new Set([
  'sync.retry_failed', 'rule.list', 'rule.sync.status', 'rule.sync.now', 'rule.history',
  'rule.audit', 'ops.rules.workspace.audit', 'rule.publish', 'rule.status',
])

export interface SyncRuleMcpDependencies {
  service: MerchantService
  result: (value: unknown) => unknown
  required: (params: JsonObject, key: string) => string
  getAutomationPolicy: (workspaceId: string, platform: Platform, accountId: string) => { retryLimit: number } | undefined
  workerAuthorizationSnapshot: (request: IncomingMessage, workspaceId: string, resourceId: string, capability: 'catalog.sync.execute', binding: Record<string, unknown>) => SyncAuthorizationSnapshot | undefined
  serializedWorkerAuthorizationSnapshot: (snapshot: SyncAuthorizationSnapshot) => Record<string, unknown>
  requiresStrictAuth: () => boolean
  persistSnapshot: (workspaceId: string, entityType: 'sync_job', entity: SyncJob, value: Record<string, unknown>) => Promise<unknown>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<unknown>
  ruleRepository: () => RuleRepositoryPort | undefined
  canViewRuleLifecycle: (request: IncomingMessage) => boolean
  supportedPlatforms: readonly Platform[]
  rulePacksForWorkspace: (workspaceId: string) => Promise<RulePack[]>
  trustedPlatformRuleSyncStatuses: (workspaceId: string, intervalHours?: number) => Promise<unknown>
  syncSignedPlatformRules: (workspaceId: string, options: { force: true }) => Promise<unknown>
  isProduction: () => boolean
  requireRuleAdmin: (request: IncomingMessage) => { actorId: string }
  requirePlatformRuleReviewer: (request: IncomingMessage) => { actorId: string; workbench: string }
  publicRule: (version: PersistedRuleVersion) => unknown
  assertManualRuleSource: (sourceKind: string, category: unknown, publicScope?: unknown) => void
  assertRuleActivationSource: (version: PersistedRuleVersion) => void
  isAllowedManualPublicRule: (version: PersistedRuleVersion) => boolean
  parseJsonObjectParameter: (params: JsonObject, key: string) => Record<string, unknown>
  parseApprovalGrant: (request: IncomingMessage, workspaceId: string, actorId: string, input: JsonObject) => RuleApproval
  canonicalJson: (value: unknown) => string
  ensureWorkspace?: (workspaceId: string) => Promise<unknown>
}

export async function handleSyncRuleMcpMethod(method: string, req: IncomingMessage, workspaceId: string, params: JsonObject, dependencies: SyncRuleMcpDependencies) {
  const { service, result, required, getAutomationPolicy, workerAuthorizationSnapshot, serializedWorkerAuthorizationSnapshot, requiresStrictAuth, persistSnapshot, persistEvent, ruleRepository, canViewRuleLifecycle, supportedPlatforms: SUPPORTED_PLATFORMS, rulePacksForWorkspace, trustedPlatformRuleSyncStatuses, syncSignedPlatformRules, isProduction, requireRuleAdmin, requirePlatformRuleReviewer, publicRule, assertManualRuleSource, assertRuleActivationSource, isAllowedManualPublicRule, parseJsonObjectParameter, parseApprovalGrant, canonicalJson, ensureWorkspace } = dependencies
  switch (method) {
    case 'sync.retry_failed': {
      let failureIds: string[] | undefined
      if (typeof params.failure_ids_json === 'string' && params.failure_ids_json.trim()) {
        try {
          const parsed = JSON.parse(params.failure_ids_json)
          if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('failure_ids_json must be an array')
          failureIds = parsed
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'failure_ids_json 必须是字符串数组 JSON', 400) }
      }
      const sourceJobId = required(params, 'job_id')
      const sourceJob = service.getSyncJob(workspaceId, sourceJobId)
      const policy = getAutomationPolicy(workspaceId, sourceJob.platform, sourceJob.accountId)
      if (policy && (sourceJob.retryCount ?? 0) >= policy.retryLimit) throw new DomainError('AUTOMATION_RETRY_LIMIT_REACHED', `该店铺同步失败重试次数已达到自动化策略上限（${policy.retryLimit} 次）`, 409, { platform: sourceJob.platform, account_id: sourceJob.accountId, retry_count: sourceJob.retryCount ?? 0, retry_limit: policy.retryLimit, next_step: '调整自动化策略 retry_limit 或由运营人员确认后重新发起同步' })
      const jobs = service.retrySyncFailures(workspaceId, sourceJobId, failureIds)
      const authorizationSnapshots = new Map(jobs.map(job => [job.id, workerAuthorizationSnapshot(req, workspaceId, job.id, 'catalog.sync.execute', { method: 'sync.retry_failed', source_job_id: sourceJobId, platform: job.platform, account_id: job.accountId, mode: job.mode, ...(job.resumeCursor ? { cursor: job.resumeCursor } : {}) })]))
      if (requiresStrictAuth() && [...authorizationSnapshots.values()].some(snapshot => !snapshot)) {
        for (const job of jobs) service.removeSyncJob(workspaceId, job.id)
        throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_REQUIRED', '同步重试缺少持久身份授权快照，已拒绝入队', 503)
      }
      for (const job of jobs) {
        const authorizationSnapshot = authorizationSnapshots.get(job.id)
        await persistSnapshot(workspaceId, 'sync_job', job, job as unknown as Record<string, unknown>)
        await persistEvent(workspaceId, job.id, 'sync.requested', job.revision, { job_id: job.id, platform: job.platform, account_id: job.accountId, mode: job.mode, ...(job.resumeCursor ? { cursor: job.resumeCursor } : {}), retry_of: sourceJobId, ...(authorizationSnapshot ? { authorization_snapshot: serializedWorkerAuthorizationSnapshot(authorizationSnapshot) } : {}) })
      }
      return result({ jobs })
    }
    case 'rule.list': {
      const repository = ruleRepository()
      // Merchant generation/review callers must continue to see only rules
      // that can affect execution. The Ops rule center uses the same method,
      // but needs the complete lifecycle to refresh a newly created draft and
      // submit it for approval without falling through an invisible state.
      const includeLifecycleStates = canViewRuleLifecycle(req)
      const requestedPlatform = typeof params.platform === 'string' && params.platform.trim() ? params.platform.trim() : undefined
      const requestedCategory = typeof params.category === 'string' && params.category.trim() ? params.category.trim() : undefined
      const requestedBrand = typeof params.brand === 'string' && params.brand.trim() ? params.brand.trim() : undefined
      const requestedStore = typeof params.store === 'string' && params.store.trim() ? params.store.trim() : undefined
      const requestedCampaign = typeof params.campaign === 'string' && params.campaign.trim() ? params.campaign.trim() : undefined
      if (requestedPlatform && !SUPPORTED_PLATFORMS.includes(requestedPlatform as Platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform 无效', 400)
      const requestedContext: Record<string, string | undefined> = { platform: requestedPlatform, category: requestedCategory, brand: requestedBrand, store: requestedStore, campaign: requestedCampaign }
      const hasContext = Object.values(requestedContext).some(Boolean)
      const matchesContext = (rule: { scope: string; targetId?: string; scopeValue?: string }) => {
        if (!hasContext) return true
        if (rule.scope === 'global') return true
        const expected = requestedContext[rule.scope]
        const target = rule.targetId ?? rule.scopeValue
        return Boolean(expected && target === expected)
      }
      const filterRules = <T extends { status: string; scope: string; targetId?: string; scopeValue?: string; source?: { reference?: string } }>(rules: T[]) => rules.filter(rule => {
        if (!matchesContext(rule)) return false
        if (includeLifecycleStates) return true
        // manual:// rows are fixtures or human drafts. They may remain visible
        // in the Ops lifecycle view, but must never become merchant/plugin
        // knowledge merely because their lifecycle status says "active".
        return rule.status === 'active' && !rule.source?.reference?.startsWith('manual://')
      })
      if (repository) return result(filterRules(await rulePacksForWorkspace(workspaceId)))
      if (isProduction()) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '生产规则仓储未配置', 503)
      return result(filterRules(service.ruleCenter.list({ includeInactive: includeLifecycleStates })))
    }
    case 'rule.sync.status': {
      const intervalHours = typeof params.interval_hours === 'string' && Number.isFinite(Number(params.interval_hours)) ? Number(params.interval_hours) : Number(process.env.PLATFORM_RULE_SYNC_INTERVAL_HOURS ?? 168)
      return result(await trustedPlatformRuleSyncStatuses(workspaceId, intervalHours))
    }
    case 'rule.sync.now': {
      const sync = await syncSignedPlatformRules(workspaceId, { force: true })
      return result({ sync, statuses: await trustedPlatformRuleSyncStatuses(workspaceId) })
    }
    case 'rule.history': {
      const packId = required(params, 'pack_id')
      const repository = ruleRepository()
      if (repository) return result(await repository.list(workspaceId, packId).then(rows => rows.map(publicRule)))
      if (isProduction()) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '生产规则仓储未配置', 503)
      return result(service.listRuleHistory(packId))
    }
    case 'rule.audit': {
      const packId = typeof params.pack_id === 'string' && params.pack_id.trim() ? params.pack_id.trim() : undefined
      requireRuleAdmin(req)
      const repository = ruleRepository()
      if (repository) return result(await repository.listAudit(workspaceId, packId))
      if (isProduction()) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '生产规则仓储未配置', 503)
      return result(service.listRuleAudit(packId))
    }
    case 'ops.rules.workspace.audit': {
      const packId = typeof params.pack_id === 'string' && params.pack_id.trim() ? params.pack_id.trim() : undefined
      if (!canViewRuleLifecycle(req)) throw new DomainError(ERROR_CODES.FORBIDDEN, '读取工作区规则审计需要当前认证工作台中的规则管理员权限', 403)
      const repository = ruleRepository()
      if (repository) return result(await repository.listAudit(workspaceId, packId))
      if (isProduction()) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '生产规则仓储未配置', 503)
      return result(service.listRuleAudit(packId))
    }
    case 'rule.publish': {
      const principal = requireRuleAdmin(req)
      const packId = required(params, 'pack_id')
      const name = required(params, 'name')
      const versionValue = required(params, 'version')
      const scope = required(params, 'scope')
      const sourceReference = required(params, 'source_reference')
      const sourceKind = sourceReference.startsWith('manual://') ? 'internal' : required(params, 'source_kind')
      const sourceCheckedAt = required(params, 'source_checked_at')
      const reason = required(params, 'reason')
      const status = typeof params.status === 'string' ? params.status : 'draft'
      const governanceCategory = typeof params.category === 'string' && params.category.trim() ? params.category.trim() : undefined
      assertManualRuleSource(sourceKind, params.category, params.public_scope)
      if ((governanceCategory && !['platform', 'category', 'advertising_publish', 'big_promotion'].includes(governanceCategory)) || !['global', 'platform', 'category', 'brand', 'store', 'campaign'].includes(scope) || !['official', 'internal', 'legal_review'].includes(sourceKind) || !['draft', 'active'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则发布参数无效', 400)
      if (!Number.isFinite(Date.parse(sourceCheckedAt))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'source_checked_at 必须是合法时间', 400)
      let checks: Record<string, unknown>
      try { const parsed = JSON.parse(required(params, 'checks_json')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('checks_json'); checks = parsed as Record<string, unknown> } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'checks_json 必须是 JSON 对象', 400) }
      if (Object.hasOwn(checks, '__public_scope')) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'checks_json 不允许设置保留字段 __public_scope', 400)
      const effectiveFromRaw = typeof params.effective_from === 'string' && params.effective_from.trim() ? params.effective_from.trim() : undefined
      const effectiveToRaw = typeof params.effective_to === 'string' && params.effective_to.trim() ? params.effective_to.trim() : undefined
      if ((effectiveFromRaw && Number.isNaN(Date.parse(effectiveFromRaw))) || (effectiveToRaw && Number.isNaN(Date.parse(effectiveToRaw))) || (effectiveFromRaw && effectiveToRaw && Date.parse(effectiveFromRaw) >= Date.parse(effectiveToRaw))) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则有效期必须是合法时间，且 effective_from 早于 effective_to', 400)
      const effectiveFrom = effectiveFromRaw ? new Date(effectiveFromRaw).toISOString() : undefined
      const effectiveTo = effectiveToRaw ? new Date(effectiveToRaw).toISOString() : undefined
      const severity = params.severity === 'warning' ? 'warning' : params.severity === 'error' || params.severity === undefined ? 'error' : undefined
      const action = ['block', 'warn', 'review', 'allow'].includes(String(params.action)) ? String(params.action) : params.action === undefined ? 'block' : undefined
      if (!severity || !action) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则 severity/action 无效', 400)
      const input: JsonObject = { approval: typeof params.approval_json === 'string' ? parseJsonObjectParameter(params, 'approval_json') : undefined }
      const approval = status === 'active' ? parseApprovalGrant(req, workspaceId, principal.actorId, input) : undefined
      const at = new Date().toISOString()
      const checksum = createHash('sha256').update(canonicalJson(checks)).digest('hex')
      const repository = ruleRepository()
      if (repository) {
        if (params.public_scope === 'platform') {
          // Write authority must equal read authority: public drafts are only readable from the platform workbench.
          requirePlatformRuleReviewer(req)
          if (scope !== 'platform' || !repository.insertPublicVersionWithAudit || typeof params.target_id !== 'string' || !SUPPORTED_PLATFORMS.includes(params.target_id as Platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '公共平台规则必须指定受支持的平台和公共规则仓储', 400)
          if (sourceKind !== 'internal' || !sourceReference.startsWith('manual://') || governanceCategory !== 'platform') throw new DomainError('OFFICIAL_RULE_IMPORT_REQUIRED', '人工公共平台规则必须使用平台类别和人工来源标记', 409)
          if (status === 'active') throw new DomainError('RULE_ACTIVATION_REQUIRES_APPROVAL', '公共平台规则必须先创建草稿，再通过独立审批激活', 409)
          const publicId = `public_rule_${randomBytes(12).toString('hex')}`
          const publicVersion = await repository.insertPublicVersionWithAudit({
            version: { id: publicId, packId, name, version: versionValue, scope, category: 'platform', status: 'draft', sourceKind, sourceReference, sourceCheckedAt: new Date(sourceCheckedAt).toISOString(), checksum, checks: { ...checks, __public_scope: 'platform' }, createdBy: principal.actorId, revision: 1, scopeValue: params.target_id, severity, action, ...(effectiveFrom ? { effectiveFrom } : {}), ...(effectiveTo ? { effectiveTo } : {}) },
            audit: { id: `public_rule_audit_${randomBytes(12).toString('hex')}`, rulePackId: packId, ruleVersionId: publicId, version: versionValue, action: 'created', actorId: principal.actorId, reason, occurredAt: at, data: { checksum } },
          })
          return result(publicVersion.version)
        }
        await ensureWorkspace?.(workspaceId)
        const versionInput = { id: `rule_${randomBytes(12).toString('hex')}`, workspaceId, packId, name, version: versionValue, scope, ...(governanceCategory ? { category: governanceCategory } : {}), status, sourceKind, sourceReference, sourceCheckedAt: new Date(sourceCheckedAt).toISOString(), checksum, checks, severity, action, ...(effectiveFrom ? { effectiveFrom } : {}), ...(effectiveTo ? { effectiveTo } : {}), ...(typeof params.target_id === 'string' && params.target_id.trim() ? { targetId: params.target_id.trim() } : {}), ...(typeof params.scope_value === 'string' && params.scope_value.trim() ? { scopeValue: params.scope_value.trim() } : {}), createdBy: principal.actorId, revision: 1, createdAt: at, updatedAt: at, ...(status === 'active' ? { activatedAt: at } : {}) }
        const audit = { id: `rule_audit_${randomBytes(12).toString('hex')}`, workspaceId, rulePackId: packId, ruleVersionId: versionInput.id, version: versionValue, action: status === 'active' ? 'activated' : 'created', actorId: principal.actorId, reason, occurredAt: at, data: { checksum, ...(approval ? { approval } : {}) } }
        if (repository.insertVersionWithAudit) return result((await repository.insertVersionWithAudit({ version: versionInput, audit })).version)
        const created = await repository.insertVersion(versionInput)
        return result({ version: created, audit: await repository.appendAudit({ ...audit, ruleVersionId: created.id, version: created.version }) })
      }
      if (isProduction()) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '生产规则仓储未配置', 503)
      const published = service.publishRuleVersion({ packId, name, version: versionValue, scope: scope as 'global' | 'platform' | 'category' | 'brand' | 'store' | 'campaign', ...(governanceCategory ? { category: governanceCategory as 'platform' | 'category' | 'advertising_publish' } : {}), source: { kind: sourceKind as 'official' | 'internal' | 'legal_review', reference: sourceReference, checkedAt: new Date(sourceCheckedAt).toISOString() }, checks: checks as { forbiddenTerms?: string[]; requiredFields?: string[] }, actorId: principal.actorId, reason })
      if (status === 'active') return result(service.setRuleStatus({ packId, version: versionValue, status: 'active', actorId: principal.actorId, reason }))
      return result(published)
    }
    case 'rule.status': {
      const principal = requireRuleAdmin(req)
      const packId = required(params, 'pack_id'); const versionValue = required(params, 'version'); const status = required(params, 'status'); const reason = required(params, 'reason')
      if (!['active', 'inactive', 'expired'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '规则状态无效', 400)
      const approval = status === 'active' ? parseApprovalGrant(req, workspaceId, principal.actorId, { approval: typeof params.approval_json === 'string' ? parseJsonObjectParameter(params, 'approval_json') : undefined }) : undefined
      const repository = ruleRepository()
      if (repository) {
        if (params.public_scope === 'platform') {
          // Deactivation is a platform-wide write too; tenant rules_admin must not reach it.
          requirePlatformRuleReviewer(req)
          if (!repository.transitionPublicStatus || typeof params.platform !== 'string' || !SUPPORTED_PLATFORMS.includes(params.platform as Platform)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '公共平台规则状态变更缺少平台或公共规则仓储', 400)
          const expectedRevision = typeof params.expected_revision === 'string' && /^[1-9][0-9]*$/u.test(params.expected_revision) && Number.isSafeInteger(Number(params.expected_revision))
            ? Number(params.expected_revision)
            : undefined
          if (expectedRevision === undefined) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '公共平台规则状态变更必须提供有效的 expected_revision', 400)
          if (status === 'active' && !approval) throw new DomainError('RULE_ACTIVATION_REQUIRES_APPROVAL', '公共平台规则激活需要独立审批凭证', 409)
          if (status === 'active') {
            if (!repository.getPublicVersion) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '公共平台规则无法读取待审批版本', 503)
            const target = await repository.getPublicVersion(params.platform, packId, versionValue)
            if (!target) throw new DomainError('RULE_VERSION_NOT_FOUND', '公共平台规则版本不存在', 404)
            const verifiedOfficial = target.sourceKind === 'official' && target.createdBy === 'signed-rule-sync' && !target.sourceReference.startsWith('manual://')
            if (!verifiedOfficial && !isAllowedManualPublicRule(target)) {
              throw new DomainError('OFFICIAL_RULE_IMPORT_REQUIRED', '人工或未验证的公共规则草稿不能激活；请使用受信签名清单同步或走已审阅的平台草稿流程', 409)
            }
            if (approval?.approvedBy === target.createdBy) throw new DomainError('RULE_SEPARATION_OF_DUTIES_REQUIRED', '公共规则创建人与审批人必须分离', 409)
          }
          try {
            return result(await repository.transitionPublicStatus({
              platform: params.platform,
              packId,
              version: versionValue,
              expectedRevision,
              status,
              actorId: principal.actorId,
              reason,
              occurredAt: new Date().toISOString(),
              ...(approval ? { auditData: { approval_ref: approval.approvalRef, approved_by: approval.approvedBy, approved_at: approval.approvedAt } } : {}),
            }))
          } catch (error) {
            const code = (error as { code?: string }).code
            if (code === 'PUBLIC_RULE_REVISION_CONFLICT') throw new DomainError('RULE_REVISION_CONFLICT', '公共规则版本已被其他审阅操作更新，请刷新后重试', 409)
            if (code === 'PUBLIC_RULE_VERSION_NOT_FOUND') throw new DomainError('RULE_VERSION_NOT_FOUND', '公共平台规则版本不存在', 404)
            throw error
          }
        }
        const rows = await repository.list(workspaceId, packId); const target = rows.find(row => row.version === versionValue)
        if (!target) throw new DomainError('RULE_VERSION_NOT_FOUND', '规则版本不存在', 404)
        if (status === 'active') assertRuleActivationSource(target)
        const current = rows.find(row => row.status === 'active' && row.id !== target.id); const at = new Date().toISOString()
        if (repository.transitionStatusWithAudit) return result(publicRule((await repository.transitionStatusWithAudit({ workspaceId, packId, targetId: target.id, status, actorId: principal.actorId, reason, occurredAt: at, targetAuditId: `rule_audit_${randomBytes(12).toString('hex')}`, ...(current ? { currentAuditId: `rule_audit_${randomBytes(12).toString('hex')}` } : {}), auditData: approval ? { approval_ref: approval.approvalRef, approved_by: approval.approvedBy, approved_at: approval.approvedAt } : {} })).version))
        return result(publicRule(await repository.updateStatus({ workspaceId, id: target.id, status, revision: target.revision + 1, updatedAt: at, activatedAt: status === 'active' ? at : null, deactivatedAt: status === 'active' ? null : at })))
      }
      if (isProduction()) throw new DomainError('RULE_REPOSITORY_NOT_CONFIGURED', '生产规则仓储未配置', 503)
      return result(service.setRuleStatus({ packId, version: versionValue, status: status as 'active' | 'inactive' | 'expired', actorId: principal.actorId, reason }))
    }
    default: throw new DomainError(ERROR_CODES.MCP_METHOD_NOT_FOUND, `不支持的 MCP 方法: ${method}`, 404)
  }
}
