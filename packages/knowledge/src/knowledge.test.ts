import { describe, expect, it } from 'vitest'
import {
  KnowledgeError,
  KnowledgeModule,
  type CompetitorCreateInput,
  type RuleCreateInput,
} from './index.js'

const source = { kind: 'official' as const, reference: 'platform-doc-1', checkedAt: '2026-08-25T00:00:00.000Z' }

function createModule() {
  let tick = 0
  return new KnowledgeModule({
    clock: () => `2026-08-25T00:00:0${tick++}.000Z`,
    idFactory: (prefix, sequence) => `${prefix}-${sequence}`,
  })
}

describe('knowledge module', () => {
  it('supports scoped, versioned rules and applicable-rule queries', () => {
    const knowledge = createModule()
    const global = knowledge.createRule({ name: '全局禁用绝对化', content: '禁止绝对化表达', scope: 'global', source, version: '1.0.0', status: 'active' })
    const platformInput: RuleCreateInput = { name: '平台标题长度', content: '标题不超过 30 字', scope: 'platform', scopeValue: 'taobao', source, version: '2.0.0', effectiveFrom: '2026-08-01T00:00:00.000Z', status: 'active', tags: ['标题'] }
    const platform = knowledge.createRule(platformInput)
    knowledge.createRule({ ...platformInput, scope: 'campaign', scopeValue: 'double-11', version: '3.0.0', status: 'draft' })

    expect(knowledge.findApplicableRules({ platform: 'taobao' }, '2026-08-25T00:00:00.000Z').map(rule => rule.id)).toEqual([platform.id, global.id])
    expect(knowledge.queryRules({ status: 'draft' })).toHaveLength(1)
    expect(knowledge.updateRule(platform.id, { status: 'inactive' }).revision).toBe(2)
    expect(knowledge.queryRules({ asOf: '2026-08-25T00:00:00.000Z' }).map(rule => rule.id)).toEqual([global.id])
  })

  it('validates effective windows and protects rule CRUD', () => {
    const knowledge = createModule()
    expect(() => knowledge.createRule({ name: 'bad', content: 'bad', scope: 'store', scopeValue: 's1', source, version: '1', status: 'draft', effectiveFrom: '2026-08-26T00:00:00.000Z', effectiveTo: '2026-08-25T00:00:00.000Z' })).toThrowError(new KnowledgeError('RULE_EFFECTIVE_WINDOW_INVALID'))
    const rule = knowledge.createRule({ name: 'ok', content: 'ok', scope: 'global', source, version: '1', status: 'draft' })
    expect(knowledge.getRule(rule.id)).toEqual(rule)
    knowledge.deleteRule(rule.id)
    expect(knowledge.getRule(rule.id)).toBeUndefined()
  })

  it('rejects invalid rule enums at the domain boundary without mutating existing rules', () => {
    const knowledge = createModule()
    expect(() => knowledge.createRule({ name: 'bad', content: 'bad', scope: 'unknown' as never, source, version: '1', status: 'draft' })).toThrowError(new KnowledgeError('RULE_SCOPE_INVALID'))
    const rule = knowledge.createRule({ name: 'ok', content: 'ok', scope: 'global', source, version: '1', status: 'draft' })
    expect(() => knowledge.updateRule(rule.id, { status: 'live' as never })).toThrowError(new KnowledgeError('RULE_STATUS_INVALID'))
    expect(() => knowledge.updateRule(rule.id, { action: 'execute' as never })).toThrowError(new KnowledgeError('RULE_ACTION_INVALID'))
    expect(knowledge.getRule(rule.id)).toEqual(rule)
  })

  it('isolates workspace-scoped knowledge rules', () => {
    const knowledge = createModule()
    const first = knowledge.createRule({ workspaceId: 'ws-a', name: 'A 规则', content: '仅 A 可见', scope: 'global', source, version: '1', status: 'active' })
    const second = knowledge.createRule({ workspaceId: 'ws-b', name: 'B 规则', content: '仅 B 可见', scope: 'global', source, version: '1', status: 'active' })
    expect(knowledge.queryRules({ workspaceId: 'ws-a' })).toEqual([first])
    expect(knowledge.queryRules({ workspaceId: 'ws-b' })).toEqual([second])
    expect(knowledge.queryRules({ workspaceId: 'ws-a', text: 'B' })).toEqual([])
  })

  it('isolates brand and customer assets by workspace across CRUD and queries', () => {
    const knowledge = createModule()
    const brand = knowledge.createAsset({ workspaceId: 'ws-a', kind: 'brand', name: 'brand-guide', content: { tone: '温和' }, tags: ['品牌'] })
    knowledge.createAsset({ workspaceId: 'ws-b', kind: 'brand', name: 'other', content: 'private' })
    knowledge.createAsset({ workspaceId: 'ws-a', kind: 'customer', name: 'campaign-brief', content: '大促素材' })
    expect(knowledge.queryAssets({ workspaceId: 'ws-a' })).toHaveLength(2)
    expect(knowledge.queryAssets({ workspaceId: 'ws-a', kind: 'brand' })).toEqual([brand])
    expect(knowledge.getAsset('ws-b', brand.id)).toBeUndefined()
    expect(() => knowledge.updateAsset('ws-b', brand.id, { name: 'leak' })).toThrowError(new KnowledgeError('ASSET_NOT_FOUND'))
    expect(knowledge.updateAsset('ws-a', brand.id, { tags: ['品牌', '已确认'] }).revision).toBe(2)
  })

  it('rejects invalid asset enum values at the domain boundary', () => {
    const knowledge = createModule()
    expect(() => knowledge.createAsset({ workspaceId: 'ws-a', kind: 'unknown' as never, name: 'bad', content: 'x' })).toThrowError(new KnowledgeError('ASSET_KIND_INVALID'))
    const asset = knowledge.createAsset({ workspaceId: 'ws-a', kind: 'brand', name: 'guide', content: 'x' })
    expect(() => knowledge.updateAsset('ws-a', asset.id, { approvalStatus: 'approved-ish' as never })).toThrowError(new KnowledgeError('ASSET_APPROVAL_STATUS_INVALID'))
    expect(() => knowledge.updateAsset('ws-a', asset.id, { rightsStatus: 'approved' as never })).toThrowError(new KnowledgeError('ASSET_RIGHTS_STATUS_INVALID'))
    expect(knowledge.getAsset('ws-a', asset.id)).toEqual(asset)
  })

  it('turns feedback and platform rejection into non-activating learning suggestions', () => {
    const knowledge = createModule()
    const rejection = knowledge.recordFeedback({ workspaceId: 'ws-a', kind: 'platform_rejection', platform: 'jd', reason: '缺少功效依据', details: '功效词需要提供检测报告' })
    const suggestion = knowledge.listLearningSuggestions('ws-a')[0]!
    expect(rejection.id).toBe(suggestion.feedbackId)
    expect(suggestion.proposedRule.status).toBe('draft')
    expect(knowledge.queryRules()).toHaveLength(0)
    const confirmed = knowledge.confirmLearningSuggestion({ workspaceId: 'ws-a', suggestionId: suggestion.id, confirmedBy: 'reviewer', note: '人工确认后再纳入规则' })
    expect(confirmed.status).toBe('confirmed')
    expect(knowledge.queryRules()).toHaveLength(0)
    expect(() => knowledge.confirmLearningSuggestion({ workspaceId: 'ws-b', suggestionId: suggestion.id, confirmedBy: 'attacker' })).toThrowError(new KnowledgeError('LEARNING_SUGGESTION_NOT_FOUND'))
  })

  it('stores structured public competitor information and only produces differentiation references', () => {
    const knowledge = createModule()
    const input: CompetitorCreateInput = {
      workspaceId: 'ws-a', competitorName: '竞品甲', source: { url: 'https://example.com/page', title: '公开商品页', accessedAt: '2026-08-25T00:00:00.000Z' },
      summary: '公开页面强调便携场景，采用问题-方案-行动号召的结构。',
      structure: { sections: ['场景痛点', '功能说明', '行动号召'], layout: ['首屏突出主体'] },
      sellingPoints: ['便携', '快速清洁'], expression: { tone: ['直接'], formats: ['短句'], callsToAction: ['立即购买'] },
    }
    const analysis = knowledge.createCompetitorAnalysis(input)
    const reference = knowledge.buildDifferentiationReference({ workspaceId: 'ws-a', competitorId: analysis.id, ownBrandName: '自有品牌', ownSellingPoints: ['静音', '快速清洁'] })
    expect(reference.referenceMode).toBe('differentiation_only')
    expect(reference.compliance).toEqual({ originalTextCopied: false, competitorBrandReused: false })
    expect(reference.safeExpressionGuidance.join('')).toContain('不复制原文')
    expect(reference.differentiationAngles).toEqual(['优先使用自有事实突出：静音'])
    expect(() => knowledge.buildDifferentiationReference({ workspaceId: 'ws-a', competitorId: analysis.id, ownBrandName: '竞品甲', ownSellingPoints: ['自有卖点'] })).toThrowError(new KnowledgeError('COMPETITOR_BRAND_REUSE_FORBIDDEN'))
    expect(() => knowledge.createCompetitorAnalysis({ ...input, originalText: '不得录入原文' } as never)).toThrowError(new KnowledgeError('COMPETITOR_COPY_INPUT_FORBIDDEN'))
    expect(() => knowledge.createCompetitorAnalysis({ ...input, source: { ...input.source, originalText: '嵌套原文' } } as never)).toThrowError(new KnowledgeError('COMPETITOR_COPY_INPUT_FORBIDDEN'))
  })

  it('rehydrates rules, assets, feedback suggestions and competitors from append-only events', () => {
    const original = createModule()
    const rule = original.createRule({ name: '平台规则', content: '标题需合规', scope: 'platform', scopeValue: 'jd', source, version: '1', status: 'active' })
    const asset = original.createAsset({ workspaceId: 'ws-a', kind: 'brand', name: '品牌指南', content: { tone: '克制' } })
    const feedback = original.recordFeedback({ workspaceId: 'ws-a', kind: 'feedback', reason: '避免夸大' })
    const updatedAsset = original.updateAsset('ws-a', asset.id, { approvalStatus: 'approved', rightsStatus: 'cleared' })
    const dismissedSuggestion = original.dismissLearningSuggestion('ws-a', original.listLearningSuggestions('ws-a')[0]!.id, '不适用于当前品类')
    const competitor = original.createCompetitorAnalysis({
      workspaceId: 'ws-a', competitorName: '竞品', source: { url: 'https://example.com', title: '公开页', accessedAt: source.checkedAt },
      summary: '结构摘要', structure: { sections: ['首屏'] }, sellingPoints: ['便携'], expression: { tone: ['直接'], formats: ['短句'] },
    })
    const restored = createModule()
    restored.hydrate([
      { eventType: 'knowledge.rule.created', payload: rule as unknown as Record<string, unknown> },
      { eventType: 'knowledge.asset.created', payload: asset as unknown as Record<string, unknown> },
      { eventType: 'knowledge.asset.updated', payload: updatedAsset as unknown as Record<string, unknown> },
      { eventType: 'knowledge.feedback.recorded', payload: feedback as unknown as Record<string, unknown> },
      { eventType: 'knowledge.learning.dismissed', payload: dismissedSuggestion as unknown as Record<string, unknown> },
      { eventType: 'knowledge.competitor.created', payload: competitor as unknown as Record<string, unknown> },
    ])
    expect(restored.getRule(rule.id)).toEqual(rule)
    expect(restored.getAsset('ws-a', asset.id)).toEqual(updatedAsset)
    expect(restored.getFeedback('ws-a', feedback.id)).toEqual(feedback)
    expect(restored.listLearningSuggestions('ws-a', 'dismissed')).toEqual([dismissedSuggestion])
    expect(restored.queryCompetitorAnalyses({ workspaceId: 'ws-a' })).toHaveLength(1)
  })
})
