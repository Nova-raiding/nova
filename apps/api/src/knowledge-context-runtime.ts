import type { KnowledgeGenerationContext } from '../../../packages/application/src/service.js'
import type { AssetEntry, LearningSuggestion, RuleEntry } from '../../../packages/knowledge/src/index.js'

export const KNOWLEDGE_CONTEXT_LIMITS = {
  softRules: 24,
  approvedAssets: 24,
  confirmedLearningSuggestions: 8,
} as const

type KnowledgeCompetitorReference = NonNullable<KnowledgeGenerationContext['competitorReferences']>[number]

function isHardKnowledgeRule(rule: Pick<RuleEntry, 'severity' | 'action'>) {
  return rule.severity === 'error' || rule.action === 'block'
}

function newestKnowledgeFirst<T extends { id: string; updatedAt: string }>(items: readonly T[]) {
  return items.map((item, index) => ({ item, index })).sort((left, right) =>
    right.item.updatedAt.localeCompare(left.item.updatedAt)
    || left.item.id.localeCompare(right.item.id)
    || left.index - right.index,
  )
}

/**
 * Bound model context without dropping governed hard rules. The returned rule
 * order is deterministic; ranking only determines which non-hard rules and
 * confirmed suggestions survive the budget.
 */
export function buildBoundedKnowledgeGenerationContext(input: {
  rules: readonly RuleEntry[]
  assets?: readonly AssetEntry[]
  learningSuggestions: readonly LearningSuggestion[]
  competitorReference?: KnowledgeCompetitorReference
  brandPreference?: { id: string; preferences: Record<string, unknown>; version: string; revision: number }
}): KnowledgeGenerationContext {
  const softRuleIds = new Set(newestKnowledgeFirst(input.rules.filter(rule => !isHardKnowledgeRule(rule))).slice(0, KNOWLEDGE_CONTEXT_LIMITS.softRules).map(({ item }) => item.id))
  const selectedRules = input.rules.filter(rule => isHardKnowledgeRule(rule) || softRuleIds.has(rule.id)).sort((left, right) => {
    const leftHard = isHardKnowledgeRule(left)
    const rightHard = isHardKnowledgeRule(right)
    if (leftHard !== rightHard) return Number(rightHard) - Number(leftHard)
    if (leftHard && rightHard) return left.id.localeCompare(right.id)
    return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
  })
  const selectedLearningIds = new Set(newestKnowledgeFirst(input.learningSuggestions).slice(0, KNOWLEDGE_CONTEXT_LIMITS.confirmedLearningSuggestions).map(({ item }) => item.id))
  const selectedLearningSuggestions = newestKnowledgeFirst(input.learningSuggestions.filter(item => selectedLearningIds.has(item.id))).map(({ item }) => item)
  const selectedAssets = newestKnowledgeFirst((input.assets ?? []).filter(asset => asset.approvalStatus === 'approved' && asset.rightsStatus === 'cleared')).slice(0, KNOWLEDGE_CONTEXT_LIMITS.approvedAssets).map(({ item }) => item)
  return {
    rules: selectedRules.map(rule => ({ id: rule.id, content: rule.content, version: rule.version, sourceReference: rule.source.reference, ...(rule.effectiveFrom ? { effectiveFrom: rule.effectiveFrom } : {}), ...(rule.effectiveTo ? { effectiveTo: rule.effectiveTo } : {}) })),
    assets: selectedAssets.map(asset => ({ id: asset.id, kind: asset.kind, name: asset.name, content: asset.content, revision: asset.revision, confirmed: false as const })),
    confirmedLearningSuggestions: selectedLearningSuggestions.map(item => ({ id: item.id, summary: item.summary, proposedRule: { content: item.proposedRule.content, scope: item.proposedRule.scope, version: item.proposedRule.version } })),
    ...(input.brandPreference ? { brandPreference: { id: input.brandPreference.id, preferences: structuredClone(input.brandPreference.preferences), version: input.brandPreference.version, revision: input.brandPreference.revision } } : {}),
    ...(input.competitorReference ? { competitorReferences: [input.competitorReference] } : {}),
  }
}
