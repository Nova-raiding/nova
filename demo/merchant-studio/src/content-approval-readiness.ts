export type ContentReviewReadinessStatus = 'idle' | 'loading' | 'succeeded' | 'failed'

export function contentApprovalBlockerMessage(input: {
  hasContent: boolean
  reviewStatus: ContentReviewReadinessStatus
  blockingFindings: number
}): string | null {
  if (!input.hasContent) return null
  if (input.reviewStatus !== 'succeeded') return null
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
}): boolean {
  return input.hasContent
    && input.reviewStatus === 'succeeded'
    && input.blockingFindings === 0
    && !input.operationActive
    && !input.loading
    && !input.alreadyApproved
}
