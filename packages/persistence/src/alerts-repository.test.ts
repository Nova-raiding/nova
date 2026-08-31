import { describe, expect, it } from 'vitest'
import { MemoryOperationalAlertsRepository } from './alerts-repository.js'

describe('operational alert notification evidence', () => {
  it('exposes only the workspace-scoped notification summary with the alert', async () => {
    const repository = new MemoryOperationalAlertsRepository()
    const alert = await repository.upsert({ workspaceId: 'ws_a', alertKey: 'alert:1', code: 'TEST', severity: 'medium', entityType: 'task', entityId: 'task_1', title: '测试告警', observedAt: '2026-08-31T00:00:00.000Z', evidence: {}, nextAction: '处理', })
    await repository.recordNotification({ workspaceId: 'ws_a', alertId: alert.id, delivery: 'failed', attempts: 3, requestId: 'notify_1', reason: 'timeout' })

    await expect(repository.list('ws_b')).resolves.toEqual([])
    await expect(repository.list('ws_a')).resolves.toMatchObject([{ notification: { delivery: 'failed', attempts: 3, requestId: 'notify_1', reason: 'timeout' } }])
  })
})
