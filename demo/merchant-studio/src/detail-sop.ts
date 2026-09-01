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

export type DetailSopStep = (typeof DETAIL_SOP_STEPS)[number] & {
  position: number
  disposition: DecisionDisposition | 'pending'
  evidenceStatus: DecisionEvidenceStatus | 'pending' | null
  statusLabel: string
  statusDetail: string
}

type SopModule = { key?: unknown; contentKind?: unknown; body?: unknown; decisionContract?: unknown }

export function resolveDetailSopSteps(modules: readonly SopModule[] | undefined): DetailSopStep[] {
  return DETAIL_SOP_STEPS.map((step, index) => {
    const module = modules?.find(candidate => candidate.key === step.key)
    const presentation = module ? moduleDecisionPresentation(module) : null
    return { ...step, position: index + 1, disposition: presentation?.disposition ?? 'pending', evidenceStatus: presentation?.evidenceStatus ?? 'pending', statusLabel: presentation?.label ?? '待生成', statusDetail: presentation?.detail ?? '当前内容版本尚未提供这一屏的决策合同。' }
  })
}
