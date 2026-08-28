import { err, ok, type Result } from './result.js'

export type TaskState =
  | 'draft'
  | 'resolving_context'
  | 'blocked_missing_facts'
  | 'blocked_conflict'
  | 'ready_for_direction'
  | 'direction_selected'
  | 'plan_confirmed'
  | 'generating'
  | 'review_required'
  | 'changes_requested'
  | 'approved'
  | 'publish_prepared'
  | 'publishing'
  | 'delivered'
  | 'failed_recoverable'
  | 'failed_terminal'
  | 'canceled'

export interface Task {
  readonly id: string
  readonly workspaceId: string
  readonly state: TaskState
  readonly version: number
  readonly contentVersionId?: string
}

export const taskTransitions: Readonly<Record<TaskState, readonly TaskState[]>> = {
  draft: ['resolving_context', 'canceled', 'failed_terminal'],
  resolving_context: ['blocked_missing_facts', 'blocked_conflict', 'ready_for_direction', 'failed_recoverable', 'canceled'],
  blocked_missing_facts: ['resolving_context', 'canceled'],
  blocked_conflict: ['resolving_context', 'canceled'],
  ready_for_direction: ['direction_selected', 'canceled'],
  direction_selected: ['plan_confirmed', 'canceled'],
  plan_confirmed: ['generating', 'canceled'],
  generating: ['review_required', 'failed_recoverable', 'failed_terminal', 'canceled'],
  review_required: ['changes_requested', 'approved', 'canceled'],
  changes_requested: ['generating', 'review_required', 'canceled'],
  approved: ['publish_prepared', 'canceled'],
  publish_prepared: ['publishing', 'canceled'],
  publishing: ['delivered', 'failed_recoverable', 'failed_terminal'],
  delivered: [],
  failed_recoverable: ['resolving_context', 'generating', 'publishing', 'canceled'],
  failed_terminal: [],
  canceled: [],
}

export const transitionTask = (
  task: Task,
  next: TaskState,
  expectedVersion = task.version,
  patch: Pick<Task, 'contentVersionId'> | undefined = undefined,
): Result<Task> => {
  if (expectedVersion !== task.version) return err('TASK_VERSION_CONFLICT', 'task was changed by another command', { expected: String(expectedVersion), actual: String(task.version) })
  if (task.state === 'delivered' || task.state === 'failed_terminal' || task.state === 'canceled') {
    return err('TASK_TERMINAL', `task ${task.state} is terminal`)
  }
  if (!taskTransitions[task.state].includes(next)) {
    return err('INVALID_TASK_TRANSITION', `task ${task.state} cannot transition to ${next}`, { from: task.state, to: next })
  }
  return ok(Object.freeze({ ...task, ...patch, state: next, version: task.version + 1 }))
}
