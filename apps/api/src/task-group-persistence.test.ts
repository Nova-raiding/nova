import { describe, expect, it } from 'vitest'
import { MerchantService } from '../../../packages/application/src/service.js'
import { persistTaskGroupOrRollback } from './task-group-persistence.js'

describe('task group persistence rollback', () => {
  it('clears fresh in-memory tasks and idempotency state so a same-process retry can create them', async () => {
    const service = new MerchantService({ seedFixture: false })
    const taobao = service.importProduct({ workspaceId: 'ws_group_retry', platform: 'taobao', title: '淘宝防晒衣', stock: 5 })
    const jd = service.importProduct({ workspaceId: 'ws_group_retry', platform: 'jd', title: '京东防晒衣', stock: 5 })
    const entries = [{ productId: taobao.id, platform: 'taobao' as const }, { productId: jd.id, platform: 'jd' as const }]
    const first = service.createTaskGroup({ workspaceId: 'ws_group_retry', entries, requestText: '多平台商品图', idempotencyKey: 'retry-after-save-error' })

    await expect(persistTaskGroupOrRollback({
      taskIds: first.taskIds,
      groupId: first.id,
      replayed: first.replayed,
      persist: async () => { throw new Error('database transaction failed') },
      rollback: (taskIds, groupId) => service.rollbackUnpersistedTaskCreation('ws_group_retry', taskIds, groupId),
    })).rejects.toThrow('database transaction failed')

    expect(service.tasks.size).toBe(0)
    const retry = service.createTaskGroup({ workspaceId: 'ws_group_retry', entries, requestText: '多平台商品图', idempotencyKey: 'retry-after-save-error' })
    expect(retry.replayed).toBe(false)
    expect(retry.id).not.toBe(first.id)
    expect(service.tasks.size).toBe(2)
  })

  it('does not roll back a replayed group if a persistence retry fails', async () => {
    const rollbacks: string[] = []
    await expect(persistTaskGroupOrRollback({
      taskIds: ['existing-task-1', 'existing-task-2'],
      groupId: 'existing-group',
      replayed: true,
      persist: async () => { throw new Error('database transaction failed') },
      rollback: (_taskIds, groupId) => rollbacks.push(groupId ?? ''),
    })).rejects.toThrow('database transaction failed')
    expect(rollbacks).toEqual([])
  })
})
