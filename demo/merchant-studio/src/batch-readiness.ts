export type BatchReadiness = {
  canCreateGroup: boolean
  selectionLabel: string
  nextStep: string
}

export type BatchResultState = 'empty' | 'blocked' | 'partial' | 'ready'

export function resolveBatchResultState(result: {
  state?: string
  taskIds?: string[]
  items?: Array<{ state?: string }>
  delivery_manifest?: { state?: string; validation?: { valid?: boolean } }
  readiness?: string
}): BatchResultState {
  const taskIds = result.taskIds ?? []
  const items = result.items ?? []
  if (result.state === 'blocked' || result.readiness === 'blocked' || result.delivery_manifest?.state === 'blocked' || result.delivery_manifest?.validation?.valid === false) return 'blocked'
  if (!taskIds.length && !items.length) return 'empty'
  if (result.state === 'partial' || items.some(item => ['failed', 'blocked', 'partial'].includes(item.state ?? ''))) return 'partial'
  return 'ready'
}

/** Describes what the UI can honestly promise at the batch entry point. */
export function resolveBatchReadiness(apiConfigured: boolean, selectedCount: number): BatchReadiness {
  if (!apiConfigured) return { canCreateGroup: false, selectionLabel: '未连接服务', nextStep: '配置 API 后才能创建真实任务组' }
  if (selectedCount < 2) return { canCreateGroup: false, selectionLabel: `已选择 ${selectedCount} 个目标`, nextStep: '至少选择 2 个商品 + 平台 + 店铺目标' }
  return { canCreateGroup: true, selectionLabel: `已选择 ${selectedCount} 个目标`, nextStep: '创建任务组后，逐个子任务完成生成、审核和发布确认' }
}

export function batchCompletionMessage(_groupId: string, taskCount: number): string {
  return `已创建任务组，包含 ${taskCount} 个独立子任务；生成、审核和发布仍需在营销任务中逐个完成。`
}
