import { describe, expect, it } from 'vitest'
import { imageGenerationExecutionLabel, imageGenerationNeedsReconciliation, imageGenerationProviderCallStarted, imageGenerationRetryAllowed } from './image-generation-state'

describe('image generation execution presentation', () => {
  it('uses explicit desktop-safe labels for provider lifecycle states', () => {
    expect(imageGenerationExecutionLabel('provider_reserved')).toContain('锁定模型请求')
    expect(imageGenerationExecutionLabel('provider_dispatching')).toContain('提交模型请求')
    expect(imageGenerationExecutionLabel('provider_started')).toContain('已受理')
    expect(imageGenerationExecutionLabel('outcome_unknown')).toContain('禁止重复生成')
    expect(imageGenerationExecutionLabel('provider_added_later')).toBe('状态待确认，请刷新或进入对账')
  })

  it('requires reconciliation for unknown outcomes and never permits retry', () => {
    expect(imageGenerationNeedsReconciliation('outcome_unknown')).toBe(true)
    expect(imageGenerationProviderCallStarted('provider_reserved')).toBe(false)
    expect(imageGenerationProviderCallStarted('provider_dispatching')).toBe(true)
    expect(imageGenerationProviderCallStarted('provider_started')).toBe(true)
    expect(imageGenerationRetryAllowed({ state: 'failed', executionState: 'outcome_unknown', nextActionAllowed: true })).toBe(false)
    expect(imageGenerationRetryAllowed({ state: 'failed', executionState: 'provider_reserved', nextActionAllowed: true })).toBe(false)
    expect(imageGenerationRetryAllowed({ state: 'failed', executionState: 'provider_dispatching', nextActionAllowed: true })).toBe(false)
    expect(imageGenerationRetryAllowed({ state: 'failed', executionState: 'provider_started', nextActionAllowed: true })).toBe(false)
    expect(imageGenerationRetryAllowed({ state: 'failed', executionState: 'failed', nextActionAllowed: true })).toBe(true)
  })
})
