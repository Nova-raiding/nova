export type ContentReviewReadinessStatus = 'idle' | 'loading' | 'succeeded' | 'failed'

export function contentApprovalBlockerMessage(input: {
  hasContent: boolean
  reviewStatus: ContentReviewReadinessStatus
  blockingFindings: number
  taskState?: string
  alreadyApproved?: boolean
}): string | null {
  if (!input.hasContent) return null
  if (input.reviewStatus !== 'succeeded') return null
  if (input.taskState !== 'review_required' && !input.alreadyApproved) return '当前任务不在待审核阶段，请重新读取任务状态后再确认。'
  if (input.blockingFindings <= 0) return null
  const count = input.blockingFindings
  return `服务端检查发现 ${count} 项阻断，先按建议修复并重新审核；当前不能批准。`
}

export function canApproveReviewedContent(input: {
  hasContent: boolean
  reviewStatus: ContentReviewReadinessStatus
  blockingFindings: number
  operationActive: boolean
  loading: boolean
  alreadyApproved: boolean
  taskState: string | undefined
}): boolean {
  return input.hasContent
    && input.taskState === 'review_required'
    && input.reviewStatus === 'succeeded'
    && input.blockingFindings === 0
    && !input.operationActive
    && !input.loading
    && !input.alreadyApproved
}
