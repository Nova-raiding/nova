import { describe, expect, it } from 'vitest'
import { countVerifiedCompletedTasks } from './workspace-completed-task-metrics.js'

const receipt = (taskId: string, overrides: Record<string, unknown> = {}) => ({
  taskId,
  state: 'published',
  remoteState: 'published',
  remoteObservedAt: '2026-09-28T03:00:00.000Z',
  remoteSimulated: false,
  remoteId: `remote-${taskId}`,
  requestId: `request-${taskId}`,
  ...overrides,
})

describe('verified completed task metrics', () => {
  const inYesterday = (timestamp: string | undefined) => Boolean(timestamp && timestamp >= '2026-09-28T00:00:00.000Z' && timestamp <= '2026-09-28T23:59:59.999Z')

  it('counts distinct tasks by observed receipt time, not task or job creation time', () => {
    expect(countVerifiedCompletedTasks([
      receipt('task-a'),
      receipt('task-a', { remoteId: 'remote-a-on-another-platform' }),
      receipt('task-b', { remoteObservedAt: '2026-09-27T23:59:59.999Z' }),
      receipt('task-c', { remoteObservedAt: '2026-09-29T00:00:00.000Z' }),
    ], inYesterday)).toBe(1)
  })

  it('excludes simulated, unverified, rejected, and drifted delivery evidence', () => {
    expect(countVerifiedCompletedTasks([
      receipt('simulated', { remoteSimulated: true }),
      receipt('missing-observed-at', { remoteObservedAt: undefined }),
      receipt('missing-receipt-id', { remoteId: undefined, requestId: undefined }),
      receipt('rejected', { remoteState: 'rejected' }),
      receipt('task-drift', { deliveryReconciliation: { code: 'PUBLISH_DELIVERY_TASK_DRIFT' } }),
    ], inYesterday)).toBe(0)
  })
})
