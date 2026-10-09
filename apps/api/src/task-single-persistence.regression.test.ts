import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MerchantService } from '../../../packages/application/src/service.js'
import { persistTaskGroupOrRollback } from './task-group-persistence.js'

const httpSource = readFileSync(new URL('./http-task-routes.ts', import.meta.url), 'utf8')
const mcpSource = readFileSync(new URL('./mcp-task-write-handlers.ts', import.meta.url), 'utf8')

describe('single task persistence failure recovery', () => {
  it('keeps a task after an ambiguous fallback write and repairs its missing created event on replay', async () => {
    const service = new MerchantService({ seedFixture: false })
    const product = service.importProduct({ workspaceId: 'ws_task_persist', platform: 'taobao', title: '单任务测试商品', stock: 5 })
    const task = service.createTask({ workspaceId: 'ws_task_persist', productId: product.id, platform: 'taobao', taskId: 'task_request_retry' })
    const durableSnapshots = new Map<string, typeof task>()
    const durableEvents = new Map<string, unknown>()

    await expect(persistTaskGroupOrRollback({
      taskIds: [task.id],
      rollbackOnFailure: () => false, // A fallback write may have committed despite throwing.
      rollback: taskIds => service.rollbackUnpersistedTaskCreation('ws_task_persist', taskIds),
      persist: async () => {
        durableSnapshots.set(task.id, structuredClone(task))
        throw new Error('event append failed after snapshot commit')
      },
    })).rejects.toThrow('event append failed after snapshot commit')

    expect(service.tasks.get(task.id)).toBe(task)
    expect(durableSnapshots.has(task.id)).toBe(true)

    await persistTaskGroupOrRollback({
      taskIds: [task.id],
      replayed: true,
      rollback: taskIds => service.rollbackUnpersistedTaskCreation('ws_task_persist', taskIds),
      persist: async () => {
        durableSnapshots.set(task.id, structuredClone(task))
        durableEvents.set(`${task.id}:task.created:${task.version}`, structuredClone(task))
      },
    })
    expect(durableEvents.has(`${task.id}:task.created:${task.version}`)).toBe(true)
    expect(service.tasks.get(task.id)).toBe(task)
  })

  it('routes HTTP deterministic replay and MCP single-task creation through grouped persistence', () => {
    const replayBranch = httpSource.slice(httpSource.indexOf('const replayedTask ='), httpSource.indexOf('const canonicalScope ='))
    expect(replayBranch).toContain('await persistGroup(')
    expect(replayBranch).toContain('replayed: true')

    const draftBranch = mcpSource.slice(mcpSource.indexOf("case 'task.create.draft':"), mcpSource.indexOf("case 'task.create':"))
    const createBranch = mcpSource.slice(mcpSource.indexOf("case 'task.create':"), mcpSource.indexOf("case 'task.answer':"))
    expect(draftBranch).toContain('await persistGroup(')
    expect(createBranch).toContain('await persistGroup(')
    expect(httpSource).toContain('rollbackOnFailure: () => Boolean(persistTaskGroup) || !fallbackWriteStarted')
    expect(mcpSource).toContain('rollbackOnFailure: () => Boolean(persistTaskGroup) || !fallbackWriteStarted')
  })
})
