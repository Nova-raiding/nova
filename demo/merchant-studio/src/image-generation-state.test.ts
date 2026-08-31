import { describe, expect, it } from 'vitest'
import { imageGenerationExecutionLabel, imageGenerationNeedsReconciliation, imageGenerationRetryAllowed } from './image-generation-state'

describe('image generation execution presentation', () => {
  it('uses explicit desktop-safe labels for provider lifecycle states', () => {
    expect(imageGenerationExecutionLabel('dispatching')).toContain('已提交模型请求')
    expect(imageGenerationExecutionLabel('provider_started')).toContain('已受理')
    expect(imageGenerationExecutionLabel('outcome_unknown')).toContain('禁止重复生成')
  })

  it('requires reconciliation for unknown outcomes and never permits retry', () => {
    expect(imageGenerationNeedsReconciliation('outcome_unknown')).toBe(true)
    expect(imageGenerationRetryAllowed({ state: 'failed', executionState: 'outcome_unknown', nextActionAllowed: true })).toBe(false)
    expect(imageGenerationRetryAllowed({ state: 'failed', executionState: 'failed', nextActionAllowed: true })).toBe(true)
  })
})
