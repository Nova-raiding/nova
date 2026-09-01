import { describe, expect, it } from 'vitest'
import { taskTransitions, transitionTask, type Task, type TaskState } from './task.js'

const task = (state: TaskState = 'draft', version = 3): Task => ({
  id: 'task_1', workspaceId: 'ws_1', state, version,
})

describe('task state contract', () => {
  it('declares a transition list for every state and never mutates the source task', () => {
    const states: TaskState[] = Object.keys(taskTransitions) as TaskState[]
    expect(states).toHaveLength(17)
    expect(new Set(states).size).toBe(states.length)
    expect(states).toEqual(expect.arrayContaining([
      'draft', 'resolving_context', 'blocked_missing_facts', 'blocked_conflict',
      'ready_for_direction', 'direction_selected', 'plan_confirmed', 'generating',
      'review_required', 'changes_requested', 'approved', 'publish_prepared',
      'publishing', 'delivered', 'failed_recoverable', 'failed_terminal', 'canceled',
    ]))

    const source = task('approved')
    const result = transitionTask(source, 'publish_prepared')
    expect(result).toMatchObject({ ok: true, value: { state: 'publish_prepared', version: 4 } })
    expect(source).toEqual(task('approved'))
  })

  it('requires the expected revision and rejects invalid or terminal transitions', () => {
    expect(transitionTask(task('approved', 7), 'publish_prepared', 6)).toMatchObject({ ok: false, error: { code: 'TASK_VERSION_CONFLICT' } })
    expect(transitionTask(task('draft'), 'approved')).toMatchObject({ ok: false, error: { code: 'INVALID_TASK_TRANSITION' } })
    expect(transitionTask(task('delivered'), 'draft')).toMatchObject({ ok: false, error: { code: 'TASK_TERMINAL' } })
    expect(transitionTask(task('failed_terminal'), 'generating')).toMatchObject({ ok: false, error: { code: 'TASK_TERMINAL' } })
  })

  it('allows content version binding only as part of a valid transition', () => {
    expect(transitionTask(task('approved'), 'publish_prepared', 3, { contentVersionId: 'cv_1' })).toMatchObject({
      ok: true, value: { contentVersionId: 'cv_1', state: 'publish_prepared' },
    })
    expect(transitionTask(task('draft'), 'resolving_context', 3, { contentVersionId: 'cv_1' })).toMatchObject({ ok: true })
  })
})
