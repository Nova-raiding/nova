import { TASK_STATES } from '../../../packages/contracts/src/domain.js'
import { describe, expect, it } from 'vitest'
import { clampTaskPage, isKnownMerchantTaskState, merchantTaskStateLabel, resolveTaskWorkflow } from './task-evidence.js'

describe('merchant task state evidence', () => {
  it('accepts every shared task state, including context and fact blockers', () => {
    for (const state of TASK_STATES) expect(isKnownMerchantTaskState(state)).toBe(true)
    expect(isKnownMerchantTaskState('content_generated')).toBe(true)
    expect(isKnownMerchantTaskState('future_unknown_state')).toBe(false)
  })

  it.each(['resolving_context', 'blocked_missing_facts', 'blocked_conflict'])('%s keeps fact confirmation as the current step', (state) => {
    expect(resolveTaskWorkflow(state).map((step) => step.status)).toEqual(['current', 'pending', 'pending', 'pending'])
  })

  it.each([
    ['resolving_context', '正在核对任务上下文'],
    ['blocked_missing_facts', '待补充商品信息'],
    ['blocked_conflict', '商品信息待核对'],
  ])('labels %s consistently with its fact-confirmation step', (state, label) => {
    expect(merchantTaskStateLabel(state)).toBe(label)
  })

  it('clamps task queue pages when the returned total shrinks', () => {
    expect(clampTaskPage(5, 101, 20)).toBe(5)
    expect(clampTaskPage(5, 41, 20)).toBe(2)
    expect(clampTaskPage(1, 0, 20)).toBe(0)
  })
})
