import { moduleDecisionPresentation, type DecisionDisposition, type DecisionEvidenceStatus } from './detail-decision-contract'

export const DETAIL_SOP_STEPS = [
  { key: 'hero', label: '购买理由', question: '为什么值得继续看？' },
  { key: 'material', label: '材料安全', question: '材料是否让我安心？' },
  { key: 'result', label: '功能结果', question: '卖点能否被画面证明？' },
  { key: 'experience', label: '使用体验', question: '拿在手里是否轻巧顺手？' },
  { key: 'compatibility', label: '炉具适配', question: '我家的炉具能不能用？' },
  { key: 'specification', label: '规格选择', question: '我应该选择哪个尺寸？' },
  { key: 'scene', label: '使用场景', question: '买回家会不会经常用？' },
  { key: 'summary', label: '信任收束', question: '关键信息是否足够确认？' },
] as const

export type DetailSopStep = {
  key: string
  label: string
  question: string
  position: number
  disposition: DecisionDisposition | 'pending'
  evidenceStatus: DecisionEvidenceStatus | 'pending' | null
  statusLabel: string
  statusDetail: string
}

type SopModule = { key?: unknown; title?: unknown; contentKind?: unknown; body?: unknown; decisionContract?: unknown }

const cookwareCategoryPattern = /(?:锅具|炒锅|煎锅|汤锅|奶锅|蒸锅|炖锅|cookware|frying\s*pan|saucepan|stockpot)/iu

export function resolveDetailSopSteps(modules: readonly SopModule[] | undefined, category?: string): DetailSopStep[] {
  // The fixed eight buyer questions describe cookware. For other categories,
  // show only modules the current content version actually contains; a missing
  // review, FAQ or warranty must never appear as a completed page section.
  const steps = category && cookwareCategoryPattern.test(category.normalize('NFKC').trim())
    ? DETAIL_SOP_STEPS
    : (modules ?? []).filter((module, index, all) => typeof module.key === 'string' && module.key.trim() && all.findIndex(candidate => candidate.key === module.key) === index).map(module => {
        const presentation = moduleDecisionPresentation(module)
        const key = (module.key as string).trim()
        return { key, label: typeof module.title === 'string' && module.title.trim() ? module.title.trim() : key, question: presentation.contract?.buyerQuestion ?? '买家问题待补录' }
      })
  return steps.map((step, index) => {
    const module = modules?.find(candidate => candidate.key === step.key)
    const presentation = module ? moduleDecisionPresentation(module) : null
    return { ...step, position: index + 1, disposition: presentation?.disposition ?? 'pending', evidenceStatus: presentation?.evidenceStatus ?? 'pending', statusLabel: presentation?.label ?? '待生成', statusDetail: presentation?.detail ?? '当前内容版本尚未提供这一屏的决策合同。' }
  })
}
