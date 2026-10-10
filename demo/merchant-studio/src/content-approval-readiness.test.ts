import { describe, expect, it } from 'vitest'
import { canApproveReviewedContent, contentApprovalBlockerMessage } from './content-approval-readiness.js'

describe('content approval readiness', () => {
  it('blocks the approval control as soon as review reports blocking findings', () => {
    const review = { hasContent: true, reviewStatus: 'succeeded' as const, blockingFindings: 2 }

    expect(canApproveReviewedContent({ ...review, operationActive: false, loading: false, alreadyApproved: false })).toBe(false)
    expect(contentApprovalBlockerMessage(review)).toBe('服务端检查发现 2 项阻断，先按建议修复并重新审核；当前不能批准。')
  })

  it('allows approval only after a successful, clear review with content loaded', () => {
    const ready = { hasContent: true, reviewStatus: 'succeeded' as const, blockingFindings: 0, operationActive: false, loading: false, alreadyApproved: false }

    expect(canApproveReviewedContent(ready)).toBe(true)
    expect(contentApprovalBlockerMessage(ready)).toBeNull()
    expect(canApproveReviewedContent({ ...ready, reviewStatus: 'failed' })).toBe(false)
    expect(canApproveReviewedContent({ ...ready, hasContent: false })).toBe(false)
  })
})
