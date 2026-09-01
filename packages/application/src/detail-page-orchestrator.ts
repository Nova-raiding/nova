import type { ContentModule, DetailPageEvidenceStatus } from '../../../packages/ai/src/generator.js'

export type DetailPageOrchestrationEvidenceStatus = DetailPageEvidenceStatus | 'pending'
export type MissingEvidencePolicy = 'omit_optional' | 'retain_all'

export type DetailPageEvidenceStatusByModule = Readonly<Record<string, DetailPageOrchestrationEvidenceStatus>>

export interface DetailPageOrchestrationOptions {
  /** Missing optional modules are omitted by default; retained modules remain blocked. */
  missingEvidencePolicy?: MissingEvidencePolicy
}

export interface DetailPageModuleDecision {
  key: string
  module: ContentModule
  evidenceStatus: DetailPageOrchestrationEvidenceStatus
  action: 'retain' | 'omit'
  readiness: 'ready' | 'blocked'
  reason: string
  originalIndex: number
}

export interface DetailPageOrchestrationResult {
  /** Retained modules in their final, stable display order. */
  modules: ContentModule[]
  /** Alias that makes the ordering guarantee explicit to callers. */
  orderedModules: ContentModule[]
  omittedModules: ContentModule[]
  /** Retained for review, but unsafe to treat as verified or publishable. */
  blockedModules: ContentModule[]
  decisions: DetailPageModuleDecision[]
  explanations: string[]
  hasBlockingEvidence: boolean
  rhythm: 'cookware_default_8_step' | 'dynamic_priority'
}

const blockingSeverity: Record<DetailPageOrchestrationEvidenceStatus, number> = {
  verified: 0,
  missing: 1,
  pending: 2,
  expired: 3,
  conflict: 4,
}

const cookwareCategoryPattern = /(?:锅具|炒锅|煎锅|汤锅|奶锅|蒸锅|炖锅|cookware|frying\s*pan|saucepan|stockpot)/iu

const cookwareRhythm: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['hero']),
  new Set(['material', 'materials', 'details_craft']),
  new Set(['function', 'functions', 'result', 'results', 'solution', 'selling_points']),
  new Set(['experience', 'handling', 'hand_feel', 'weight']),
  new Set(['compatibility', 'cooktop_compatibility', 'stove_compatibility']),
  new Set(['spec', 'specs', 'specification', 'specifications', 'size_guide', 'sku']),
  new Set(['scene', 'scenes', 'scenario', 'scenarios', 'usage_scenarios']),
  new Set(['summary', 'confirmation', 'brand', 'package', 'after_sales', 'cta']),
]

function normalizedKey(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/[\s-]+/gu, '_')
}

function isCookware(category: string): boolean {
  return cookwareCategoryPattern.test(category.normalize('NFKC').trim())
}

function cookwareRank(module: ContentModule): number {
  const key = normalizedKey(module.key)
  const index = cookwareRhythm.findIndex(group => group.has(key))
  return index < 0 ? cookwareRhythm.length : index
}

function declaredStatus(module: ContentModule): DetailPageOrchestrationEvidenceStatus {
  if (module.contentKind === 'pending' || module.body.trimStart().startsWith('[待确认]')) return 'pending'
  return module.decisionContract?.evidence.status ?? 'missing'
}

/**
 * External evidence may make an unknown module safer, but it may never downgrade
 * a pending, conflicting, or expired status already frozen into the module.
 */
function effectiveStatus(
  module: ContentModule,
  evidenceStatus: DetailPageEvidenceStatusByModule,
): DetailPageOrchestrationEvidenceStatus {
  const declared = declaredStatus(module)
  const supplied = evidenceStatus[module.key]
  if (!supplied) return declared
  if (declared === 'missing' && supplied === 'verified') return supplied
  return blockingSeverity[supplied] > blockingSeverity[declared] ? supplied : declared
}

function decisionFor(
  module: ContentModule,
  originalIndex: number,
  evidenceStatus: DetailPageEvidenceStatusByModule,
  missingEvidencePolicy: MissingEvidencePolicy,
): DetailPageModuleDecision {
  const status = effectiveStatus(module, evidenceStatus)
  const optional = module.decisionContract?.optional ?? false
  const omitMissingOptional = status === 'missing' && optional && missingEvidencePolicy === 'omit_optional'
  if (omitMissingOptional) {
    return {
      key: module.key,
      module,
      evidenceStatus: status,
      action: 'omit',
      readiness: 'blocked',
      reason: `模块 ${module.key} 缺少证据且为可选模块，按策略省略；省略不代表证据已验证。`,
      originalIndex,
    }
  }
  if (status !== 'verified') {
    const statusReason: Record<Exclude<DetailPageOrchestrationEvidenceStatus, 'verified'>, string> = {
      missing: '缺少证据',
      pending: '证据仍待确认',
      expired: '证据已过期',
      conflict: '证据存在冲突',
    }
    return {
      key: module.key,
      module,
      evidenceStatus: status,
      action: 'retain',
      readiness: 'blocked',
      reason: `模块 ${module.key}${statusReason[status]}，保留用于人工处理，不得作为已验证内容继续。`,
      originalIndex,
    }
  }
  return {
    key: module.key,
    module,
    evidenceStatus: status,
    action: 'retain',
    readiness: 'ready',
    reason: `模块 ${module.key} 的证据已验证，可进入详情页编排。`,
    originalIndex,
  }
}

/**
 * Produces a deterministic detail-page sequence without converting evidence
 * failures into success. The cookware eight-step rhythm is a category default,
 * while every other category follows explicit decision priority.
 */
export function orchestrateDetailPageModules(
  modules: readonly ContentModule[],
  category: string,
  evidenceStatus: DetailPageEvidenceStatusByModule = {},
  options: DetailPageOrchestrationOptions = {},
): DetailPageOrchestrationResult {
  const missingEvidencePolicy = options.missingEvidencePolicy ?? 'omit_optional'
  const cookware = isCookware(category)
  const allDecisions = modules.map((module, originalIndex) =>
    decisionFor(module, originalIndex, evidenceStatus, missingEvidencePolicy))
  const retained = allDecisions.filter(decision => decision.action === 'retain')
    .sort((left, right) => {
      if (cookware) {
        const rhythmDifference = cookwareRank(left.module) - cookwareRank(right.module)
        if (rhythmDifference !== 0) return rhythmDifference
      }
      const priorityDifference = (left.module.decisionContract?.priority ?? 50)
        - (right.module.decisionContract?.priority ?? 50)
      return priorityDifference || left.originalIndex - right.originalIndex
    })
  const omitted = allDecisions.filter(decision => decision.action === 'omit')
  const orderedModules = retained.map(decision => decision.module)

  return {
    modules: orderedModules,
    orderedModules,
    omittedModules: omitted.map(decision => decision.module),
    blockedModules: retained.filter(decision => decision.readiness === 'blocked').map(decision => decision.module),
    decisions: [...retained, ...omitted],
    explanations: [...retained, ...omitted].map(decision => decision.reason),
    hasBlockingEvidence: allDecisions.some(decision => decision.readiness === 'blocked'),
    rhythm: cookware ? 'cookware_default_8_step' : 'dynamic_priority',
  }
}
