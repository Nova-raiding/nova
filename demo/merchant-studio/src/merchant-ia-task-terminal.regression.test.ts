import { describe, expect, it } from 'vitest'
import { taskTransitions } from '../../../packages/domain/src/task.js'
import { groupTasksForRecovery } from './merchant-ia.js'
import type { Task } from './api.js'

const task = (state: string): Task => ({
  id: `task-${state}`,
  workspaceId: 'workspace-1',
  productId: 'product-1',
  platform: 'taobao',
  state,
  version: 1,
  createdAt: '2026-10-09T10:00:00.000Z',
})

describe('merchant task recovery terminal states', () => {
  it('treats canceled and failed_terminal as ended, view-only tasks', () => {
    const items = groupTasksForRecovery([
      task('canceled'),
      task('failed_terminal'),
    ])

    expect(items.map(({ group, groupLabel, actionLabel }) => ({ group, groupLabel, actionLabel }))).toEqual([
      { group: 'ended', groupLabel: '已结束', actionLabel: '仅查看' },
      { group: 'ended', groupLabel: '已结束', actionLabel: '仅查看' },
    ])
    expect(items.every(({ actionLabel }) => actionLabel !== '恢复任务')).toBe(true)
  })

  it('keeps failed_recoverable resumable and derives terminal classification from domain transitions', () => {
    const [recoverable] = groupTasksForRecovery([task('failed_recoverable')])
    expect(recoverable).toMatchObject({ group: 'needs-attention', groupLabel: '需要我处理', actionLabel: '恢复任务' })

    const terminalStates = Object.entries(taskTransitions)
      .filter(([, nextStates]) => nextStates.length === 0)
      .map(([state]) => state)
    expect(terminalStates).toEqual(expect.arrayContaining(['delivered', 'failed_terminal', 'canceled']))
    expect(groupTasksForRecovery(terminalStates.map(task)).every(({ group }) => group === 'ended')).toBe(true)
  })
})
