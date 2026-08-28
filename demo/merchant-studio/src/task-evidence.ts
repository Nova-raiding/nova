export interface TaskDirectionEvidence {
  id: string
  name: string
  coreIdea: string
  structure: string
  copyDirection: string
  visualDirection: string
  sellingPoints: string[]
  fitReason: string
  risk: string
}

export type TaskDirectionMode = 'offline_demo' | 'loading' | 'api_error' | 'api_empty' | 'api_ready'

const demoDirections: TaskDirectionEvidence[] = [
  { id: 'DEMO-A', name: '演示 · 展示真实外观', coreIdea: '基于演示商品外观和配色组织内容。', structure: '演示结构', copyDirection: '演示文案方向', visualDirection: '演示视觉方向', sellingPoints: ['演示卖点'], fitReason: '离线演示数据', risk: '不可用于真实发布' },
  { id: 'DEMO-B', name: '演示 · 规格信息清晰', coreIdea: '以演示 SKU、价格和库存说明信息结构。', structure: '演示结构', copyDirection: '演示文案方向', visualDirection: '演示视觉方向', sellingPoints: ['演示卖点'], fitReason: '离线演示数据', risk: '不可用于真实发布' },
  { id: 'DEMO-C', name: '演示 · 守住事实边界', coreIdea: '展示待确认事实应如何保持克制。', structure: '演示结构', copyDirection: '演示文案方向', visualDirection: '演示视觉方向', sellingPoints: ['演示卖点'], fitReason: '离线演示数据', risk: '不可用于真实发布' },
]

export function resolveTaskDirections({ baseUrl, remote, error }: { baseUrl?: string; remote: TaskDirectionEvidence[] | null; error: string }): { mode: TaskDirectionMode; items: TaskDirectionEvidence[] } {
  if (!baseUrl) return { mode: 'offline_demo', items: demoDirections }
  if (error) return { mode: 'api_error', items: [] }
  if (remote === null) return { mode: 'loading', items: [] }
  if (remote.length === 0) return { mode: 'api_empty', items: [] }
  return { mode: 'api_ready', items: remote }
}

export type WorkflowStepStatus = 'complete' | 'current' | 'pending'

const workflowLabels = ['事实确认', '方向选择', '内容审核', '确认发布'] as const

export function resolveTaskWorkflow(state?: string, offlineDemo = false): Array<{ label: typeof workflowLabels[number]; status: WorkflowStepStatus }> {
  if (offlineDemo) return workflowLabels.map((label, index) => ({ label, status: index < 2 ? 'complete' : index === 2 ? 'current' : 'pending' }))
  const stageByState: Record<string, number> = {
    draft: 0,
    ready_for_direction: 1,
    direction_selected: 2,
    plan_confirmed: 2,
    generating: 2,
    review_required: 2,
    changes_requested: 2,
    approved: 3,
    publish_prepared: 3,
    publishing: 3,
    delivered: 4,
  }
  const stage = state ? stageByState[state] : undefined
  if (stage === undefined) return workflowLabels.map(label => ({ label, status: 'pending' }))
  return workflowLabels.map((label, index) => ({ label, status: index < stage ? 'complete' : index === stage ? 'current' : 'pending' }))
}
