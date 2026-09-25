import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { KnowledgeError, type KnowledgeModule } from '../../../packages/knowledge/src/index.js'
import type { KnowledgeRepository } from '../../../packages/persistence/src/knowledge.js'
import type { OperationAudit } from '../../../packages/persistence/src/index.js'

export const MCP_KNOWLEDGE_METHODS = new Set([
  'knowledge.rule.create',
  'knowledge.rule.update',
  'knowledge.rule.list',
  'knowledge.asset.create',
  'knowledge.asset.update',
  'knowledge.asset.list',
  'knowledge.brand.preference.get',
  'knowledge.brand.preference.update',
  'knowledge.feedback.record',
  'knowledge.learning.list',
  'knowledge.learning.confirm',
  'knowledge.learning.dismiss',
  'knowledge.competitor.create',
  'knowledge.competitor.list',
  'knowledge.competitor.reference',
])

interface KnowledgeMcpDependencies {
  knowledgeForWorkspace: (workspaceId: string) => KnowledgeModule
  knowledgeRepository?: KnowledgeRepository
  durableKnowledgeRepository?: KnowledgeRepository
  requireOperationsRole: (req: IncomingMessage, allowed: readonly string[]) => string
  required: (params: Record<string, unknown>, key: string) => string
  requiredPositiveInteger: (params: Record<string, unknown>, key: string) => number
  requestActor: (req: IncomingMessage) => string
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<unknown>
  recordOperationAudit: (audit: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
}

export async function handleMcpKnowledgeMethod(
  method: string,
  params: Record<string, unknown>,
  req: IncomingMessage,
  workspaceId: string,
  deps: KnowledgeMcpDependencies,
): Promise<unknown> {
  const { knowledgeForWorkspace, requireOperationsRole, required, requiredPositiveInteger, requestActor, persistEvent, recordOperationAudit } = deps
  const result = (value: unknown) => value
  switch (method) {
    case 'knowledge.rule.create': {
      try {
        // Workspace reviewers have the same rule draft capability exposed by
        // the Ops Console. Keep workspace owners without rule governance
        // capability blocked, while allowing the canonical reviewer role.
        const actorId = requireOperationsRole(req, ['rules_admin', 'reviewer'])
        const status = required(params, 'status') as import('../../../packages/knowledge/src/index.js').RuleStatus
        if (status !== 'draft') throw new DomainError('RULE_ACTIVATION_REQUIRES_UPDATE', '新规则必须先创建为草稿，再通过带版本与审计原因的更新流程启用', 409)
        const target = Object.fromEntries(['platform', 'category', 'brand', 'store', 'campaign'].filter(key => typeof params[key] === 'string' && String(params[key]).trim()).map(key => [key, String(params[key]).trim()]))
        const sourceReference = required(params, 'source_reference')
        const sourceKind = sourceReference.startsWith('manual://') ? 'internal' : required(params, 'source_kind')
        const rule = knowledgeForWorkspace(workspaceId).createRule({
          workspaceId, name: required(params, 'name'), content: required(params, 'content'), scope: required(params, 'scope') as import('../../../packages/knowledge/src/index.js').RuleScope,
          ...(typeof params.scope_value === 'string' ? { scopeValue: params.scope_value } : {}), target,
          source: { kind: sourceKind as import('../../../packages/knowledge/src/index.js').RuleSourceKind, reference: sourceReference, checkedAt: required(params, 'source_checked_at') },
          version: required(params, 'version'), status,
          ...(typeof params.severity === 'string' ? { severity: params.severity as import('../../../packages/knowledge/src/index.js').RuleSeverity } : {}), ...(typeof params.action === 'string' ? { action: params.action as import('../../../packages/knowledge/src/index.js').RuleAction } : {}), ...(typeof params.owner_id === 'string' ? { ownerId: params.owner_id } : {}),
          ...(typeof params.effective_from === 'string' ? { effectiveFrom: params.effective_from } : {}), ...(typeof params.effective_to === 'string' ? { effectiveTo: params.effective_to } : {}),
          ...(typeof params.tags_json === 'string' ? { tags: JSON.parse(params.tags_json) as string[] } : {}),
        })
        await persistEvent(workspaceId, rule.id, 'knowledge.rule.created', rule.revision, rule as unknown as Record<string, unknown>)
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.rule.create', resourceType: 'knowledge_rule', resourceId: rule.id, before: {}, after: rule as unknown as Record<string, unknown>, reason: '运营知识规则创建' })
        return result(rule)
      } catch (error) {
        if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400)
        throw error
      }
    }
    case 'knowledge.rule.update': {
      try {
        const actorId = requireOperationsRole(req, ['rules_admin', 'reviewer'])
        const ruleId = required(params, 'rule_id')
        const current = knowledgeForWorkspace(workspaceId).getRule(ruleId)
        if (!current || current.workspaceId !== workspaceId) throw new DomainError('RULE_NOT_FOUND', '规则不存在', 404)
        const expectedRevision = requiredPositiveInteger(params, 'expected_revision')
        const reason = required(params, 'reason')
        const source = typeof params.source_reference === 'string' || typeof params.source_checked_at === 'string'
          ? { ...current.source, ...(typeof params.source_reference === 'string' ? { reference: params.source_reference } : {}), ...(typeof params.source_checked_at === 'string' ? { checkedAt: params.source_checked_at } : {}) }
          : undefined
        if (params.status === 'active' && (source ?? current.source).reference.startsWith('manual://')) throw new DomainError('RULE_SOURCE_UNVERIFIED', '未验证的人工规则不能激活为商家生成依据', 409)
        const updated = knowledgeForWorkspace(workspaceId).updateRule(ruleId, { expectedRevision, ...(typeof params.name === 'string' ? { name: params.name } : {}), ...(typeof params.content === 'string' ? { content: params.content } : {}), ...(typeof params.version === 'string' ? { version: params.version } : {}), ...(typeof params.status === 'string' ? { status: params.status as import('../../../packages/knowledge/src/index.js').RuleStatus } : {}), ...(typeof params.severity === 'string' ? { severity: params.severity as import('../../../packages/knowledge/src/index.js').RuleSeverity } : {}), ...(typeof params.action === 'string' ? { action: params.action as import('../../../packages/knowledge/src/index.js').RuleAction } : {}), ...(source ? { source } : {}), ...(typeof params.tags_json === 'string' ? { tags: JSON.parse(params.tags_json) as string[] } : {}) })
        await persistEvent(workspaceId, updated.id, 'knowledge.rule.updated', updated.revision, updated as unknown as Record<string, unknown>)
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.rule.update', resourceType: 'knowledge_rule', resourceId: updated.id, before: current as unknown as Record<string, unknown>, after: updated as unknown as Record<string, unknown>, reason })
        return result(updated)
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, error.code === 'VERSION_CONFLICT' ? 409 : 400); throw error }
    }
    case 'knowledge.rule.list': {
      try {
        requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'platform_ops', 'rules_admin'])
        return result(knowledgeForWorkspace(workspaceId).queryRules({
          workspaceId,
          ...(typeof params.scope === 'string' ? { scope: params.scope as import('../../../packages/knowledge/src/index.js').RuleScope } : {}),
          ...(typeof params.scope_value === 'string' ? { scopeValue: params.scope_value } : {}), ...(typeof params.status === 'string' ? { status: params.status as import('../../../packages/knowledge/src/index.js').RuleStatus } : {}),
          ...(typeof params.as_of === 'string' ? { asOf: params.as_of } : {}), ...(typeof params.platform === 'string' ? { platform: params.platform } : {}), ...(typeof params.category === 'string' ? { category: params.category } : {}), ...(typeof params.brand === 'string' ? { brand: params.brand } : {}), ...(typeof params.store === 'string' ? { store: params.store } : {}), ...(typeof params.campaign === 'string' ? { campaign: params.campaign } : {}), ...(typeof params.text === 'string' ? { text: params.text } : {}),
        }))
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.asset.create': {
      try {
        const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops', 'knowledge_editor'])
        const content = JSON.parse(required(params, 'content_json')) as string | Record<string, unknown>
        const asset = knowledgeForWorkspace(workspaceId).createAsset({ workspaceId, kind: required(params, 'kind') as 'brand' | 'customer', name: required(params, 'name'), content, ...(typeof params.source === 'string' ? { source: params.source } : {}), ...(typeof params.tags_json === 'string' ? { tags: JSON.parse(params.tags_json) as string[] } : {}), ...(typeof params.approval_status === 'string' ? { approvalStatus: params.approval_status as import('../../../packages/knowledge/src/index.js').AssetApprovalStatus } : {}), ...(typeof params.rights_status === 'string' ? { rightsStatus: params.rights_status as import('../../../packages/knowledge/src/index.js').AssetRightsStatus } : {}) })
        await persistEvent(workspaceId, asset.id, 'knowledge.asset.created', asset.revision, asset as unknown as Record<string, unknown>)
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.asset.create', resourceType: 'knowledge_asset', resourceId: asset.id, before: {}, after: asset as unknown as Record<string, unknown>, reason: '运营知识资产录入' })
        return result(asset)
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.asset.update': {
      try {
        const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops', 'knowledge_editor'])
        const assetId = required(params, 'asset_id')
        let content: string | Record<string, unknown> | undefined
        if (typeof params.content_json === 'string') content = JSON.parse(params.content_json) as string | Record<string, unknown>
        const durableRepository = deps.knowledgeRepository ?? deps.durableKnowledgeRepository
        const durableAsset = durableRepository ? await durableRepository.getAsset(workspaceId, assetId) : undefined
        const updated = durableAsset
          ? await durableRepository!.updateAsset(workspaceId, assetId, {
              ...(typeof params.name === 'string' ? { name: params.name } : {}),
              ...(content !== undefined ? { content } : {}),
              ...(typeof params.approval_status === 'string' ? { approvalStatus: params.approval_status as import('../../../packages/persistence/src/knowledge.js').KnowledgeApprovalStatus } : {}),
              ...(typeof params.rights_status === 'string' ? { rightsStatus: params.rights_status as import('../../../packages/persistence/src/knowledge.js').KnowledgeRightsStatus } : {}),
            })
          : knowledgeForWorkspace(workspaceId).updateAsset(workspaceId, assetId, {
              ...(typeof params.name === 'string' ? { name: params.name } : {}), ...(content !== undefined ? { content } : {}), ...(typeof params.source === 'string' ? { source: params.source } : {}),
              ...(typeof params.approval_status === 'string' ? { approvalStatus: params.approval_status as import('../../../packages/knowledge/src/index.js').AssetApprovalStatus } : {}), ...(typeof params.rights_status === 'string' ? { rightsStatus: params.rights_status as import('../../../packages/knowledge/src/index.js').AssetRightsStatus } : {}),
              ...(typeof params.tags_json === 'string' ? { tags: JSON.parse(params.tags_json) as string[] } : {}),
            })
        await persistEvent(workspaceId, updated.id, 'knowledge.asset.updated', updated.revision, updated as unknown as Record<string, unknown>)
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.asset.update', resourceType: 'knowledge_asset', resourceId: updated.id, before: {}, after: updated as unknown as Record<string, unknown>, reason: '运营知识资产审批/权益调整' })
        return result(updated)
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.asset.list': {
      try {
        requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'platform_ops', 'knowledge_reader'])
        let tags: string[] | undefined
        if (typeof params.tags_json === 'string') tags = JSON.parse(params.tags_json) as string[]
        return result(knowledgeForWorkspace(workspaceId).queryAssets({ workspaceId, ...(typeof params.kind === 'string' ? { kind: params.kind as 'brand' | 'customer' } : {}), ...(typeof params.text === 'string' ? { text: params.text } : {}), ...(tags ? { tags } : {}) }))
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.brand.preference.get': {
      try {
        requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'platform_ops', 'knowledge_reader'])
        return result(knowledgeForWorkspace(workspaceId).getBrandPreference(workspaceId) ?? null)
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.brand.preference.update': {
      try {
        const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops', 'knowledge_editor'])
        const preferences = JSON.parse(required(params, 'preferences_json')) as Record<string, unknown>
        const current = knowledgeForWorkspace(workspaceId).getBrandPreference(workspaceId)
        const updated = knowledgeForWorkspace(workspaceId).updateBrandPreference({
          workspaceId, preferences, version: required(params, 'version'), updatedBy: actorId,
          ...(typeof params.status === 'string' ? { status: params.status as 'draft' | 'active' | 'archived' } : {}),
          ...(typeof params.source === 'string' ? { source: params.source } : {}),
          ...(typeof params.expected_revision === 'string' && /^\d+$/u.test(params.expected_revision) ? { expectedRevision: Number(params.expected_revision) } : {}),
        })
        await persistEvent(workspaceId, updated.id, 'knowledge.brand.preference.updated', updated.revision, updated as unknown as Record<string, unknown>)
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.brand.preference.update', resourceType: 'brand_preference', resourceId: updated.id, before: current ? current as unknown as Record<string, unknown> : {}, after: updated as unknown as Record<string, unknown>, reason: '商家品牌偏好版本更新' })
        return result(updated)
      } catch (error) { if (error instanceof SyntaxError) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'preferences_json 必须是合法 JSON 对象', 400); if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.feedback.record': {
      try {
        const actorId = requestActor(req)
        const feedback = knowledgeForWorkspace(workspaceId).recordFeedback({ workspaceId, kind: required(params, 'kind') as 'feedback' | 'platform_rejection', ...(typeof params.platform === 'string' ? { platform: params.platform } : {}), ...(typeof params.content_id === 'string' ? { contentId: params.content_id } : {}), reason: required(params, 'reason'), ...(typeof params.details === 'string' ? { details: params.details } : {}), ...(typeof params.metadata_json === 'string' ? { metadata: JSON.parse(params.metadata_json) as Record<string, string> } : {}) })
        await persistEvent(workspaceId, feedback.id, 'knowledge.feedback.recorded', 1, { ...feedback as unknown as Record<string, unknown>, actor_id: actorId })
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.feedback.record', resourceType: 'knowledge_feedback', resourceId: feedback.id, before: {}, after: feedback as unknown as Record<string, unknown>, reason: feedback.reason })
        return result({ feedback, suggestions: knowledgeForWorkspace(workspaceId).listLearningSuggestions(workspaceId).filter(item => item.feedbackId === feedback.id) })
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.learning.list': {
      try { requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'platform_ops', 'knowledge_reader']); return result(knowledgeForWorkspace(workspaceId).listLearningSuggestions(workspaceId, typeof params.status === 'string' ? params.status as 'pending' | 'confirmed' | 'dismissed' : undefined)) }
      catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.learning.confirm': {
      try {
        const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops', 'rules_admin', 'knowledge_editor'])
        const suggestion = knowledgeForWorkspace(workspaceId).confirmLearningSuggestion({ workspaceId, suggestionId: required(params, 'suggestion_id'), confirmedBy: actorId, ...(typeof params.note === 'string' ? { note: params.note } : {}) })
        await persistEvent(workspaceId, suggestion.id, 'knowledge.learning.confirmed', 1, suggestion as unknown as Record<string, unknown>)
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.learning.confirm', resourceType: 'learning_suggestion', resourceId: suggestion.id, before: { status: 'pending' }, after: suggestion as unknown as Record<string, unknown>, reason: typeof params.note === 'string' ? params.note : '运营确认学习建议' })
        return result(suggestion)
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.learning.dismiss': {
      try {
        const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops', 'rules_admin', 'knowledge_editor'])
        const suggestionId = required(params, 'suggestion_id')
        const suggestion = knowledgeForWorkspace(workspaceId).dismissLearningSuggestion(workspaceId, suggestionId, typeof params.note === 'string' ? params.note : undefined)
        await persistEvent(workspaceId, suggestion.id, 'knowledge.learning.dismissed', 1, suggestion as unknown as Record<string, unknown>)
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.learning.dismiss', resourceType: 'learning_suggestion', resourceId: suggestion.id, before: { status: 'pending' }, after: suggestion as unknown as Record<string, unknown>, reason: typeof params.note === 'string' ? params.note : '运营驳回学习建议' })
        return result(suggestion)
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.competitor.create': {
      try {
        const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops', 'competitor_reviewer'])
        const analysis = knowledgeForWorkspace(workspaceId).createCompetitorAnalysis({ workspaceId, competitorName: required(params, 'competitor_name'), source: JSON.parse(required(params, 'source_json')), summary: required(params, 'summary'), structure: JSON.parse(required(params, 'structure_json')), sellingPoints: JSON.parse(required(params, 'selling_points_json')), expression: JSON.parse(required(params, 'expression_json')) })
        await persistEvent(workspaceId, analysis.id, 'knowledge.competitor.created', 1, analysis as unknown as Record<string, unknown>)
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.competitor.create', resourceType: 'competitor_analysis', resourceId: analysis.id, before: {}, after: analysis as unknown as Record<string, unknown>, reason: '运营竞品公开信息录入' })
        return result(analysis)
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.competitor.list': {
      try { requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'platform_ops', 'competitor_reviewer']); return result(knowledgeForWorkspace(workspaceId).queryCompetitorAnalyses({ workspaceId, ...(typeof params.competitor_name === 'string' ? { competitorName: params.competitor_name } : {}), ...(typeof params.text === 'string' ? { text: params.text } : {}) })) }
      catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    case 'knowledge.competitor.reference': {
      try {
        const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops', 'competitor_reviewer'])
        const reference = knowledgeForWorkspace(workspaceId).buildDifferentiationReference({ workspaceId, competitorId: required(params, 'competitor_id'), ownBrandName: required(params, 'own_brand_name'), ownSellingPoints: JSON.parse(required(params, 'own_selling_points_json')) })
        await recordOperationAudit({ workspaceId, actorId, action: 'knowledge.competitor.reference', resourceType: 'competitor_analysis', resourceId: required(params, 'competitor_id'), before: {}, after: reference as unknown as Record<string, unknown>, reason: '运营生成差异化竞品参考' })
        return result(reference)
      } catch (error) { if (error instanceof KnowledgeError) throw new DomainError(error.code, error.message, 400); throw error }
    }
    default: throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知知识方法: ${method}`, 400)
  }
}
